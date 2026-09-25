// Microsoft Advertising (Bing) Ad Library adapter (spec 4.5). Public JSON API, no auth.

import { hostMatches, unwrapRedirect } from '../lib/domain.js';
import { sleep, toIsoDate } from '../lib/util.js';
import { makeAd, makeResult, aggregateAdvertisers, promoteAdvertiserMatches, dedupeAds } from '../lib/model.js';
import { backoff } from '../background/queue.js';

export const meta = { id: 'bing', label: 'Microsoft Advertising (Bing)', coverage: 'EU/EEA-served ads' };

const API = 'https://adlibrary.api.bingads.microsoft.com/api/v1';
const UI = 'https://adlibrary.ads.microsoft.com';

// ---------------------------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------------------------

export function advertisersUrl(brand, top = 20) {
  return `${API}/Advertisers?searchText=${encodeURIComponent(brand)}&top=${top}&skip=0`;
}

export function adsByAdvertiserUrl(id, top = 50) {
  return `${API}/Ads?advertiserId=${encodeURIComponent(String(id))}&top=${top}&skip=0`;
}

export function adsBySearchUrl(text, top = 50) {
  return `${API}/Ads?searchText=${encodeURIComponent(text)}&top=${top}&skip=0`;
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

/** GET JSON with 429 backoff -> {json, status} | {rateLimited:true} | {status, error} */
async function getJson(ctx, url) {
  for (let attempt = 0; ; attempt += 1) {
    if (ctx.throttle) await ctx.throttle();
    const res = await ctx.fetch(url, { credentials: 'omit', headers: { Accept: 'application/json' } });
    if (res.status === 429) {
      if (attempt >= 3) return { rateLimited: true };
      await sleep(retryDelay(attempt), ctx.signal);
      continue;
    }
    if (res.status < 200 || res.status >= 300) return { status: res.status, error: `HTTP ${res.status}` };
    const text = await res.text();
    try {
      return { status: res.status, json: JSON.parse(text) };
    } catch {
      return { status: res.status, json: null };
    }
  }
}

export async function search(seeds, ctx) {
  const domain = (seeds && seeds.domain) || '';
  const brand = (seeds && seeds.brand) || '';
  const settings = (ctx && ctx.settings) || {};
  const links = deepLinks(seeds);
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
    if (brand) {
      progress(`Searching advertisers "${brand}"`);
      const r = await getJson(ctx, advertisersUrl(brand, 20));
      if (r.rateLimited) rateLimited = true;
      else if (r.error) error = r.error;
      else {
        const parsed = parseBingAdvertisers(r.json);
        if (parsed === null) changed = true;
        else advList = parsed.slice(0, Math.max(0, Number(settings.bingAdvertisers) || 6));
      }
    }
    for (let i = 0; i < advList.length && !rateLimited; i += 1) {
      progress(`Loading ads of ${advList[i].name || advList[i].id} (${i + 1}/${advList.length})`);
      const r = await getJson(ctx, adsByAdvertiserUrl(advList[i].id, 50));
      if (r.rateLimited) { rateLimited = true; break; }
      if (r.error) { error = r.error; continue; }
      const parsed = parseBingAds(r.json, domain);
      if (parsed === null) { changed = true; continue; }
      collected = collected.concat(parsed.ads);
    }
    if (!rateLimited && domain) {
      progress(`Searching ads mentioning ${domain}`);
      const r = await getJson(ctx, adsBySearchUrl(domain, 50));
      if (r.rateLimited) rateLimited = true;
      else if (r.error) error = error || r.error;
      else {
        const parsed = parseBingAds(r.json, domain);
        if (parsed === null) changed = true;
        else collected = collected.concat(parsed.ads);
      }
    }

    const kept = filterBingAds(collected, advList.map((a) => a.id));
    if (rateLimited) return finish('rate_limited', kept.length ? `Microsoft Ad Library rate limit hit, showing partial results (${kept.length} ads)` : 'Microsoft Ad Library is rate limiting requests, try again later');
    if (kept.length) {
      const confirmed = kept.filter((a) => a.match === 'confirmed').length;
      return finish('ok', confirmed ? `${kept.length} ads, ${confirmed} pointing to ${domain}` : `No ad points to ${domain}; showing top advertisers named "${brand}"`);
    }
    if (changed) return finish('changed', 'Microsoft Ad Library changed its response format');
    if (error) return finish('error', `Microsoft Ad Library returned ${error}`);
    return finish('empty', 'No EU/EEA-served Microsoft ads found');
  } catch (err) {
    if (ctx && ctx.signal && ctx.signal.aborted) return finish('error', 'Stopped');
    return finish('error', `Microsoft Ad Library search failed: ${(err && err.message) || err}`);
  }
}
