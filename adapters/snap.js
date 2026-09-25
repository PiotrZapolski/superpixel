// Snapchat Ads Library adapter (spec 4.6). Public API, no OAuth:
// POST https://adsapi.snapchat.com/v1/ads_library/ads/search with
// {paying_advertiser_name, countries:[lowercase iso2], start_date, end_date}.
// Response (developers.snap.com Ads-Gallery-Api): {request_status, paging:{next_link},
// ad_previews:[{sub_request_status, ad_preview:{id, name, ad_type, paying_advertiser_name,
// ad_account_name, profile_name, brand_name, headline, status, start_date, ...}}]}.
// Best effort: the endpoint rate-limits aggressively.

import { hostMatches, unwrapRedirect } from '../lib/domain.js';
import { walkJson, toIsoDate, sleep } from '../lib/util.js';
import { makeAd, makeResult, aggregateAdvertisers, promoteAdvertiserMatches, dedupeAds } from '../lib/model.js';

export const meta = { id: 'snap', label: 'Snapchat', coverage: 'EU only' };

const SEARCH_URL = 'https://adsapi.snapchat.com/v1/ads_library/ads/search';
const GALLERY = 'https://adsgallery.snap.com/';
// EU27 as listed in the Snap docs (Greece is "el").
export const EU_COUNTRIES = ['at', 'be', 'bg', 'hr', 'cy', 'cz', 'dk', 'ee', 'fi', 'fr', 'de', 'el', 'hu', 'ie', 'it', 'lv', 'lt', 'lu', 'mt', 'nl', 'pl', 'pt', 'ro', 'sk', 'si', 'es', 'se'];
const NAME_KEYS = ['paying_advertiser_name', 'profile_name', 'brand_name'];
const SNAP_HOST_RE = /(^|\.)(snapchat\.com|snap\.com|sc-cdn\.net|sc-static\.net|snapads\.com|snapkit\.com)$/i;
const MEDIA_EXT_RE = /\.(jpe?g|png|gif|webp|mp4|mov|webm|m3u8)(\?|#|$)/i;
const RETRY_MS = [5000, 15000];

// ---------------------------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------------------------

/** Request body for the last 365 days. `now`: ms number or Date. */
export function buildSnapBody(brand, now = Date.now()) {
  const end = now instanceof Date ? now.getTime() : Number(now) || Date.now();
  const start = end - 365 * 86400000;
  return {
    paying_advertiser_name: String(brand || ''),
    countries: EU_COUNTRIES.slice(),
    start_date: new Date(start).toISOString(),
    end_date: new Date(end).toISOString(),
  };
}

function isObj(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function hostOfUrl(u) {
  try { return new URL(u).hostname.toLowerCase(); } catch { return ''; }
}

/** http(s) URLs among the object's own string fields, excluding Snap infra and media files. */
function externalUrls(o) {
  const out = [];
  for (const [k, v] of Object.entries(o)) {
    if (typeof v !== 'string' || !/^https?:\/\//i.test(v)) continue;
    if (/download|logo|media|thumbnail|icon|image|video/i.test(k)) continue;
    const u = unwrapRedirect(v);
    const host = hostOfUrl(u);
    if (!host || SNAP_HOST_RE.test(host) || MEDIA_EXT_RE.test(u)) continue;
    out.push(u);
  }
  return out;
}

/**
 * Defensive parse: every object with an `id` and one of paying_advertiser_name / profile_name /
 * brand_name becomes an Ad.
 * @returns {{ads: object[], ok: boolean, nextLink: string}} ok = recognisable response.
 */
export function parseSnapAds(json, domain) {
  let j = json;
  if (typeof j === 'string') {
    try { j = JSON.parse(j); } catch { return { ads: [], ok: false, nextLink: '' }; }
  }
  if (!j || typeof j !== 'object') return { ads: [], ok: false, nextLink: '' };
  const ads = [];
  const seen = new Set();
  walkJson(j, (node) => {
    if (!isObj(node)) return undefined;
    const id = node.id;
    if ((typeof id !== 'string' && typeof id !== 'number') || String(id) === '') return undefined;
    if (!NAME_KEYS.some((k) => typeof node[k] === 'string' && node[k])) return undefined;
    const sid = String(id);
    if (seen.has(sid)) return false;
    seen.add(sid);
    const name = String(node.paying_advertiser_name || node.brand_name || node.profile_name || '');
    // Look for landing URLs on the ad object and one level of nested objects.
    let urls = externalUrls(node);
    for (const v of Object.values(node)) if (isObj(v)) urls = urls.concat(externalUrls(v));
    const landingUrl = urls.find((u) => domain && hostMatches(u, domain)) || urls[0] || '';
    const confirmed = Boolean(domain && urls.some((u) => hostMatches(u, domain)));
    const mediaType = String(node.top_snap_media_type || '').toLowerCase();
    const media = String(node.top_snap_media_download_link || node.media_url || '');
    const previewUrl = media && (mediaType === 'image' || /\.(jpe?g|png|gif|webp)(\?|$)/i.test(media)) ? media : String(node.profile_logo_url || '');
    const status = String(node.status || '').toUpperCase();
    ads.push(makeAd({
      platform: 'snap',
      id: sid,
      advertiserId: name,
      advertiserName: name,
      format: mediaType || 'video',
      title: String(node.headline || ''),
      text: String(node.name || ''),
      landingUrl,
      displayUrl: '',
      firstShown: toIsoDate(node.start_date || node.created_at || null),
      lastShown: toIsoDate(node.end_date || null),
      isActive: status === 'ACTIVE' ? true : status ? false : null,
      previewUrl,
      detailUrl: GALLERY,
      placements: ['snapchat'],
      match: confirmed ? 'confirmed' : 'name',
      source: 'native',
    }));
    return false;
  });
  const ok = ads.length > 0 || Array.isArray(j.ad_previews) || String(j.request_status || '').toUpperCase() === 'SUCCESS';
  const nextLink = (j.paging && typeof j.paging.next_link === 'string') ? j.paging.next_link : '';
  return { ads, ok, nextLink };
}

export function deepLinks() {
  return [{ label: 'Snapchat Ads Gallery', url: GALLERY }];
}

// ---------------------------------------------------------------------------------------------
// I/O
// ---------------------------------------------------------------------------------------------

async function postSearch(ctx, url, body) {
  for (let attempt = 0; ; attempt += 1) {
    if (ctx.throttle) await ctx.throttle();
    const res = await ctx.fetch(url, {
      method: 'POST',
      credentials: 'omit',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.status === 429) {
      if (attempt >= RETRY_MS.length) return { rateLimited: true };
      await sleep(RETRY_MS[attempt], ctx.signal);
      continue;
    }
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { json = null; }
    return { status: res.status, json };
  }
}

export async function search(seeds, ctx) {
  const domain = (seeds && seeds.domain) || '';
  const brand = (seeds && seeds.brand) || '';
  const links = deepLinks(seeds);
  let collected = [];
  const progress = (t) => { try { ctx.progress && ctx.progress(t); } catch { /* ignore */ } };

  const finish = (status, message) => {
    let ads = dedupeAds(collected);
    ads = promoteAdvertiserMatches(ads) || ads;
    const advertisers = aggregateAdvertisers(ads, { platform: 'snap', urlFor: () => GALLERY });
    return makeResult(meta, { status, message, ads, advertisers, deepLinks: links });
  };

  try {
    if (!brand) return finish('skipped', 'No brand name to search on Snapchat');
    const body = buildSnapBody(brand, Date.now());
    let url = SEARCH_URL;
    let ok = false;
    for (let page = 0; page < 3 && url; page += 1) {
      progress(`Searching paying advertiser "${brand}"${page ? ` (page ${page + 1})` : ''}`);
      const r = await postSearch(ctx, url, body);
      if (r.rateLimited) {
        return finish('rate_limited', collected.length ? `Snapchat rate limit hit, showing partial results (${collected.length} ads)` : 'Snapchat Ads Library is rate limiting requests, try again later');
      }
      if (r.status < 200 || r.status >= 300) {
        if (collected.length) break;
        return finish('error', `Snapchat Ads Library returned HTTP ${r.status}`);
      }
      const parsed = parseSnapAds(r.json, domain);
      if (!parsed.ok) {
        if (collected.length) break;
        return finish('changed', 'Snapchat changed its response format');
      }
      ok = true;
      collected = collected.concat(parsed.ads);
      url = parsed.nextLink && /^https:\/\/adsapi\.snapchat\.com\//i.test(parsed.nextLink) && parsed.nextLink !== url ? parsed.nextLink : '';
    }
    if (collected.length) return finish('ok', `${collected.length} ads paid by advertisers named "${brand}"`);
    return finish(ok ? 'empty' : 'error', ok ? 'No Snapchat ads found for this advertiser name in the EU' : 'No response from Snapchat');
  } catch (err) {
    if (ctx && ctx.signal && ctx.signal.aborted) return finish('error', 'Stopped');
    return finish('error', `Snapchat search failed: ${(err && err.message) || err}`);
  }
}
