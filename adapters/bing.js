// Microsoft Advertising (Bing) Ad Library adapter (spec 4.5). Public JSON API, no auth.

import { hostMatches, unwrapRedirect } from '../lib/domain.js';
import { sleep, toIsoDate } from '../lib/util.js';
import { makeAd, makeResult, aggregateAdvertisers, promoteAdvertiserMatches, dedupeAds, nameQueries } from '../lib/model.js';
import { backoff } from '../background/queue.js';

export const meta = { id: 'bing', label: 'Microsoft Advertising (Bing)', coverage: 'EU/EEA-served ads' };

const API = 'https://adlibrary.api.bingads.microsoft.com/api/v1';
const UI = 'https://adlibrary.ads.microsoft.com';
/** The Ads endpoint answers 400 "The limit of '24' for Top query has been exceeded" above 24. */
export const ADS_TOP = 24;
export const ADS_PAGES = 2;
export const ADVERTISERS_TOP = 20;
/** Retries after a 429 before giving up with rate_limited. */
export const MAX_429_RETRIES = 2;

// ---------------------------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------------------------

export function advertisersUrl(brand, top = ADVERTISERS_TOP) {
  return `${API}/Advertisers?searchText=${encodeURIComponent(brand)}&top=${top}&skip=0`;
}

export function adsByAdvertiserUrl(id, top = ADS_TOP, skip = 0) {
  return `${API}/Ads?advertiserId=${encodeURIComponent(String(id))}&top=${Math.min(top, ADS_TOP)}&skip=${skip}`;
}

export function adsBySearchUrl(text, top = ADS_TOP, skip = 0) {
  return `${API}/Ads?searchText=${encodeURIComponent(text)}&top=${Math.min(top, ADS_TOP)}&skip=${skip}`;
}

/**
 * Merge advertiser lists from several searches round-robin (so every query gets a slot), dedupe
 * by id, cap at `max`.
 * @param {{id:string}[][]} lists
 * @param {number} max
 */
export function mergeAdvertiserLists(lists, max) {
  const out = [];
  const seen = new Set();
  const queues = (lists || []).map((l) => (Array.isArray(l) ? l.slice() : []));
  while (out.length < max && queues.some((q) => q.length)) {
    for (const q of queues) {
      if (out.length >= max) break;
      while (q.length) {
        const a = q.shift();
        if (!a || seen.has(String(a.id))) continue;
        seen.add(String(a.id));
        out.push(a);
        break;
      }
    }
  }
  return out;
}

export function advertiserUrl(id) {
  return `${UI}/?advertiserId=${encodeURIComponent(String(id))}`;
}

function parseMaybe(json) {
  if (typeof json === 'string') {
    try { return JSON.parse(json); } catch { return null; }
  }
  return json;
}

/**
 * `{value:[{AdvertiserId, AdvertiserName, AdvertiserCountry, IsVerified}]}` ->
 * [{id, name, country, verified}] or null when the shape is unexpected.
 */
export function parseBingAdvertisers(json) {
  const j = parseMaybe(json);
  if (!j || typeof j !== 'object' || !Array.isArray(j.value)) return null;
  return j.value
    .filter((a) => a && a.AdvertiserId !== undefined && a.AdvertiserId !== null)
    .map((a) => ({
      id: String(a.AdvertiserId),
      name: String(a.AdvertiserName || ''),
      country: String(a.AdvertiserCountry || ''),
      verified: Boolean(a.IsVerified),
    }));
}

function withScheme(u) {
  const s = String(u || '').trim();
  if (!s) return '';
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s.replace(/^\/+/, '')}`;
}

function assetInfo(assetJson) {
  let assets = assetJson;
  if (typeof assets === 'string') {
    const t = assets.trim();
    if (!t) return { format: 'text', previewUrl: '' };
    try { assets = JSON.parse(t); } catch { assets = t; }
  }
  if (assets === null || assets === undefined || assets === '') return { format: 'text', previewUrl: '' };
  const flat = typeof assets === 'string' ? assets : JSON.stringify(assets);
  const img = /https?:\/\/[^"'\s\\]+?\.(?:jpe?g|png|gif|webp)(?:\?[^"'\s\\]*)?/i.exec(flat);
  let format = 'text';
  if (/video/i.test(flat)) format = 'video';
  else if (img || /image/i.test(flat)) format = 'image';
  return { format, previewUrl: img ? img[0] : '' };
}

/**
 * `{"@odata.count":N, value:[{AdId, AdvertiserName, AdvertiserId, Title, Description, DisplayUrl,
 * DestinationUrl, AssetJson}]}` -> {ads: Ad[], total: number|null} or null on unexpected shape.
 */
export function parseBingAds(json, domain) {
  const j = parseMaybe(json);
  if (!j || typeof j !== 'object' || !Array.isArray(j.value)) return null;
  const ads = [];
  for (const a of j.value) {
    if (!a || a.AdId === undefined || a.AdId === null) continue;
    const landingUrl = a.DestinationUrl ? unwrapRedirect(withScheme(a.DestinationUrl)) : '';
    const displayUrl = String(a.DisplayUrl || '');
    const confirmed = Boolean(domain) && (
      (landingUrl && hostMatches(landingUrl, domain)) || (displayUrl && hostMatches(withScheme(displayUrl), domain))
    );
    const { format, previewUrl } = assetInfo(a.AssetJson);
    const id = String(a.AdId);
    ads.push(makeAd({
      platform: 'bing',
      id,
      advertiserId: a.AdvertiserId !== undefined && a.AdvertiserId !== null ? String(a.AdvertiserId) : String(a.AdvertiserName || ''),
      advertiserName: String(a.AdvertiserName || ''),
      format,
      title: String(a.Title || ''),
      text: String(a.Description || ''),
      landingUrl,
      displayUrl,
      firstShown: toIsoDate(a.FirstShownDate || a.StartDate || null),
      lastShown: toIsoDate(a.LastShownDate || a.EndDate || null),
      isActive: null,
      previewUrl,
      detailUrl: `${UI}/ad-details?adId=${encodeURIComponent(id)}`,
      placements: ['bing'],
      match: confirmed ? 'confirmed' : 'keyword',
      source: 'native',
    }));
  }
  const count = Number(j['@odata.count']);
  return { ads, total: Number.isFinite(count) ? count : null };
}

/**
 * Spec 4.5 step 4: keep only advertisers with a confirmed ad; if none has one, keep the top 2
 * advertisers (search order) with match 'name'.
 */
export function filterBingAds(ads, advertiserOrder) {
  const confirmedIds = new Set(ads.filter((a) => a.match === 'confirmed').map((a) => a.advertiserId));
  if (confirmedIds.size) return ads.filter((a) => confirmedIds.has(a.advertiserId));
  const top = new Set((advertiserOrder || []).slice(0, 2).map(String));
  return ads.filter((a) => top.has(a.advertiserId)).map((a) => ({ ...a, match: 'name' }));
}

export function deepLinks(seeds) {
  const brand = (seeds && seeds.brand) || (seeds && seeds.domain) || '';
  return [{ label: 'Microsoft Ad Library', url: brand ? `${UI}/?searchText=${encodeURIComponent(brand)}` : `${UI}/` }];
}

// ---------------------------------------------------------------------------------------------
// I/O
// ---------------------------------------------------------------------------------------------

function retryDelay(attempt) {
  const v = Number(backoff(attempt));
  return v > 0 ? v : [3000, 10000, 30000][Math.min(attempt, 2)];
}

/**
 * GET JSON with 429 backoff (2 retries) -> {json, status} | {rateLimited:true} | {status, error}.
 * A 429 is checked before any parsing: its HTML body is never read as a format change.
 */
async function getJson(ctx, url) {
  for (let attempt = 0; ; attempt += 1) {
    if (ctx.throttle) await ctx.throttle();
    const res = await ctx.fetch(url, { credentials: 'omit', headers: { Accept: 'application/json' } });
    if (res.status === 429) {
      if (attempt >= MAX_429_RETRIES) return { rateLimited: true };
      // ctx.retryDelay: optional override (tests); default queue.js backoff 3s, 10s.
      await sleep(typeof ctx.retryDelay === 'function' ? ctx.retryDelay(attempt) : retryDelay(attempt), ctx.signal);
      continue;
    }
    if (res.status < 200 || res.status >= 300) return { status: res.status, error: `HTTP ${res.status}` };
    const text = await res.text();
    try {
      return { status: res.status, json: JSON.parse(text) };
    } catch {
      // An HTML throttling page served with 200 is a rate limit, not a format change.
      if (/too many requests|rate limit/i.test(text)) return { rateLimited: true };
      return { status: res.status, json: null };
    }
  }
}

export async function search(seeds, ctx) {
  const domain = (seeds && seeds.domain) || '';
  const brand = (seeds && seeds.brand) || '';
  const settings = (ctx && ctx.settings) || {};
  const links = deepLinks(seeds);
  const queries = nameQueries(brand, seeds && seeds.advertiserNames, 5);
  let collected = [];
  let advList = [];
  let rateLimited = false;
  let changed = false;
  let error = '';
  const progress = (t) => { try { ctx.progress && ctx.progress(t); } catch { /* ignore */ } };

  const finish = (status, message) => {
    let ads = dedupeAds(filterBingAds(collected, advList.map((a) => a.id)));
    ads = promoteAdvertiserMatches(ads) || ads;
    let advertisers = aggregateAdvertisers(ads, { platform: 'bing', urlFor: (id) => advertiserUrl(id) }) || [];
    advertisers = advertisers.map((adv) => {
      const src = advList.find((a) => a.id === String(adv.id));
      return src && src.country && !adv.country ? { ...adv, country: src.country } : adv;
    });
    return makeResult(meta, { status, message, ads, advertisers, deepLinks: links });
  };

  try {
    // Advertiser search for the brand and for each advertiser name found on Google/Meta
    // (the legal name, e.g. "BLG", often differs from the domain label).
    const lists = [];
    for (const q of queries) {
      if (rateLimited) break;
      progress(`Searching advertisers "${q}"`);
      const r = await getJson(ctx, advertisersUrl(q, ADVERTISERS_TOP));
      if (r.rateLimited) rateLimited = true;
      else if (r.error) error = error || r.error;
      else {
        const parsed = parseBingAdvertisers(r.json);
        if (parsed === null) changed = true;
        else lists.push(parsed);
      }
    }
    advList = mergeAdvertiserLists(lists, Math.max(0, Number(settings.bingAdvertisers) || 6));
    for (let i = 0; i < advList.length && !rateLimited; i += 1) {
      for (let page = 0; page < ADS_PAGES && !rateLimited; page += 1) {
        progress(`Loading ads of ${advList[i].name || advList[i].id} (${i + 1}/${advList.length})${page ? `, page ${page + 1}` : ''}`);
        const r = await getJson(ctx, adsByAdvertiserUrl(advList[i].id, ADS_TOP, page * ADS_TOP));
        if (r.rateLimited) { rateLimited = true; break; }
        if (r.error) { error = r.error; break; }
        const parsed = parseBingAds(r.json, domain);
        if (parsed === null) { changed = true; break; }
        collected = collected.concat(parsed.ads);
        const seenSoFar = (page + 1) * ADS_TOP;
        const more = parsed.ads.length >= ADS_TOP && (parsed.total === null || parsed.total > seenSoFar);
        if (!more) break;
      }
    }
    if (!rateLimited && domain) {
      progress(`Searching ads mentioning ${domain}`);
      const r = await getJson(ctx, adsBySearchUrl(domain, ADS_TOP));
      if (r.rateLimited) rateLimited = true;
      else if (r.error) error = error || r.error;
      else {
        const parsed = parseBingAds(r.json, domain);
        if (parsed === null) changed = true;
        else collected = collected.concat(parsed.ads);
      }
    }

    // Name search alone is noise (live 2026-09-26: "BLG" matched "BLG srl" and a car dealer):
    // without an ad pointing to the domain, show nothing rather than unrelated advertisers.
    const confirmed = collected.filter((a) => a.match === 'confirmed').length;
    const noMatch = () => {
      collected = [];
      advList = [];
    };
    if (rateLimited) {
      if (!confirmed) noMatch();
      const kept = filterBingAds(collected, advList.map((a) => a.id));
      return finish('rate_limited', kept.length ? `Microsoft Ad Library rate limit hit, showing partial results (${kept.length} ads)` : 'Microsoft Ad Library is rate limiting requests, try again later');
    }
    if (confirmed) {
      const kept = filterBingAds(collected, advList.map((a) => a.id));
      return finish('ok', `${kept.length} ads, ${confirmed} pointing to ${domain}`);
    }
    if (changed) return finish('changed', 'Microsoft Ad Library changed its response format');
    if (error && !collected.length) return finish('error', `Microsoft Ad Library returned ${error}`);
    noMatch();
    return finish('empty', `No Bing ads point to ${domain} (searched: ${queries.join(', ')})`);
  } catch (err) {
    if (ctx && ctx.signal && ctx.signal.aborted) return finish('error', 'Stopped');
    return finish('error', `Microsoft Ad Library search failed: ${(err && err.message) || err}`);
  }
}
