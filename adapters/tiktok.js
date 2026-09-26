// TikTok Ad Library adapter (spec 4.3).
// The library API is signed by the web app, so we never call it directly: a capture tab loads the
// public search page and content/hook-main.js records the app's own /api/v1/ responses.
// Response JSON shapes are not documented, so every parser here is defensive.

import { hostMatches, domainLabel, unwrapRedirect } from '../lib/domain.js';
import { walkJson, toIsoDate, sleep, uniq } from '../lib/util.js';
import { makeAd, makeResult, aggregateAdvertisers, promoteAdvertiserMatches, dedupeAds, keepConfirmedAdvertisers } from '../lib/model.js';

export const meta = { id: 'tiktok', label: 'TikTok', coverage: 'EU/EEA, UK, CH only' };

const BASE = 'https://library.tiktok.com';
const DAY_MS = 86400000;
const RATE_LIMIT_STATUS = new Set([403, 421, 429]);
const RATE_LIMIT_TEXT = /system busy|limit exceed/i;
const ID_KEYS = ['id', 'ad_id', 'item_id'];
const AD_HINT_KEYS = [
  'name', 'advertiser_name', 'adv_name', 'advertiser', 'adv_biz_id', 'biz_id', 'advertiser_id',
  'first_shown_date', 'first_shown', 'start_time', 'last_shown_date', 'last_shown', 'end_time',
  'videos', 'image_urls', 'cover_image', 'estimated_audience', 'audience', 'reach',
];
// Hosts that belong to TikTok / ByteDance infrastructure, never an advertiser landing page.
const TIKTOK_HOST_RE = /(^|\.)(tiktok[\w-]*|tiktokv|tiktokcdn[\w-]*|byteoversea|ibyteimg|ibytedtos|byteimg|bytedance|bytefcdn|bytecdn|muscdn|musical)\.[a-z.]+$/i;
const MEDIA_EXT_RE = /\.(jpe?g|png|gif|webp|mp4|m3u8|webm|svg|ico)(\?|#|$)/i;

// ---------------------------------------------------------------------------------------------
// Pure helpers (no chrome.*)
// ---------------------------------------------------------------------------------------------

/** Search page URL. `now` in ms; window is the last 365 days. */
export function buildSearchUrl({ region = 'all', q = '', now = Date.now(), queryType = 1, bizIds = '' } = {}) {
  const end = Number(now) || Date.now();
  const start = end - 365 * DAY_MS;
  const p = new URLSearchParams();
  p.set('region', region || 'all');
  p.set('start_time', String(start));
  p.set('end_time', String(end));
  p.set('adv_name', q || '');
  p.set('adv_biz_ids', bizIds || '');
  p.set('query_type', String(queryType));
  p.set('sort_type', 'last_shown_date,desc');
  return `${BASE}/ads?${p.toString()}`;
}

/** Max search-page captures (including DOM fallbacks) before the detail phase. */
export const MAX_SEARCH_CAPTURES = 4;

/**
 * Ordered search plan (region=all): keyword search for the brand (query_type 1), advertiser-name
 * searches (query_type 2) for up to 2 advertiser names from Google/Meta, then for the brand, then
 * the domain label as keyword when it differs. Deduped, capped at MAX_SEARCH_CAPTURES.
 * @returns {{q:string, queryType:1|2}[]}
 */
export function searchPlan(brand, label, advertiserNames) {
  const plan = [];
  const seen = new Set();
  const add = (q, queryType) => {
    const s = String(q || '').trim();
    const k = `${queryType}|${s.toLowerCase()}`;
    if (!s || seen.has(k)) return;
    seen.add(k);
    plan.push({ q: s, queryType });
  };
  const b = String(brand || '').trim().toLowerCase();
  const names = (Array.isArray(advertiserNames) ? advertiserNames : [])
    .map((n) => String(n || '').trim())
    .filter((n) => n && n.toLowerCase() !== b);
  add(brand, 1);
  for (const n of uniq(names).slice(0, 2)) add(n, 2);
  add(brand, 2);
  add(label, 1);
  return plan.slice(0, MAX_SEARCH_CAPTURES);
}

export function detailUrlFor(id) {
  return `${BASE}/ads/detail/?ad_id=${encodeURIComponent(String(id))}`;
}

/** Advertiser library link: by business id when known, else a name search. */
export function advertiserUrl(bizId, name = '') {
  if (bizId && /^\d+$/.test(String(bizId))) {
    const p = new URLSearchParams({ region: 'all', adv_biz_ids: String(bizId), query_type: '2' });
    if (name) p.set('adv_name', name);
    return `${BASE}/ads?${p.toString()}`;
  }
  const p = new URLSearchParams({ region: 'all', adv_name: name || '', query_type: '1' });
  return `${BASE}/ads?${p.toString()}`;
}

function isObj(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function getPath(obj, path) {
  let cur = obj;
  for (const part of path.split('.')) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[/^\d+$/.test(part) && Array.isArray(cur) ? Number(part) : part];
  }
  return cur;
}

/** First non-empty value among dotted paths. */
function firstOf(obj, paths) {
  for (const p of paths) {
    const v = getPath(obj, p);
    if (v === undefined || v === null || v === '') continue;
    if (typeof v === 'object') continue;
    return v;
  }
  return undefined;
}

function str(v) {
  return v === undefined || v === null ? '' : String(v);
}

/** Parse a captured body (string or already-parsed object). Returns {json, text}. */
function parseBody(body) {
  if (body !== null && typeof body === 'object') return { json: body, text: '' };
  const text = typeof body === 'string' ? body : '';
  const trimmed = text.replace(/^\s*for\s*\(\s*;\s*;\s*\)\s*;/, '').trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return { json: JSON.parse(trimmed), text };
    } catch {
      return { json: null, text };
    }
  }
  return { json: null, text };
}

/** True when a JSON response carries a rate-limit style message or code. */
function jsonRateLimited(json) {
  if (!isObj(json)) return false;
  const msg = [json.msg, json.message, json.status_msg, json.error, getPath(json, 'error.message')]
    .filter((v) => typeof v === 'string').join(' ');
  if (RATE_LIMIT_TEXT.test(msg)) return true;
  const code = Number(json.code ?? json.status_code);
  return code === 421 || code === 429;
}

function idOf(o) {
  for (const k of ID_KEYS) {
    const v = o[k];
    if ((typeof v === 'string' && /^\d{5,}$/.test(v)) || (typeof v === 'number' && Number.isFinite(v) && v > 9999)) {
      return String(v);
    }
  }
  return '';
}

function looksLikeAd(o) {
  return isObj(o) && idOf(o) !== '' && AD_HINT_KEYS.some((k) => o[k] !== undefined);
}

function toDate(v) {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v === 'string' && /^\d+$/.test(v)) return toIsoDate(Number(v));
  return toIsoDate(v);
}

/** Raw-normalise one ad-like object from the search response. */
export function normalizeTiktokItem(o) {
  const advertiser = o.advertiser;
  const advertiserName = str(firstOf(o, ['advertiser_name', 'adv_name', 'advertiser.name', 'advertiser.advertiser_name', 'name'])
    ?? (typeof advertiser === 'string' ? advertiser : ''));
  const bizId = str(firstOf(o, ['adv_biz_id', 'biz_id', 'advertiser_id', 'advertiser.biz_id', 'advertiser.adv_biz_id', 'advertiser.id']));
  const previewUrl = str(firstOf(o, ['videos.0.cover_img', 'videos.0.cover_image', 'video.cover_img', 'cover_image', 'cover_img', 'image_urls.0', 'images.0.url', 'images.0']));
  const hasVideo = Array.isArray(o.videos) ? o.videos.length > 0 : Boolean(o.video || o.video_link);
  const format = str(o.format) || (hasVideo ? 'video' : (Array.isArray(o.image_urls) && o.image_urls.length ? 'image' : 'video'));
  const landing = str(firstOf(o, ['external_url', 'landing_page_url', 'landing_url']));
  return {
    id: idOf(o),
    advertiserName,
    bizId,
    firstShown: toDate(firstOf(o, ['first_shown_date', 'first_shown', 'start_time'])),
    lastShown: toDate(firstOf(o, ['last_shown_date', 'last_shown', 'end_time'])),
    reach: str(firstOf(o, ['estimated_audience', 'audience', 'reach'])),
    previewUrl,
    format: format.toLowerCase(),
    title: str(firstOf(o, ['title', 'ad_title'])),
    text: str(firstOf(o, ['caption', 'ad_text', 'text', 'description'])),
    landingUrl: /^https?:\/\//i.test(landing) ? landing : '',
    paidBy: str(firstOf(o, ['paid_by', 'payer', 'paid_for_by'])),
  };
}

/**
 * Parse a captured /api/v1/search body.
 * @returns {{ads:object[], rateLimited:boolean, ok:boolean}}
 *   ok = the body was JSON and not a rate-limit answer (an empty list is still ok).
 */
export function parseTiktokSearch(body) {
  const { json, text } = parseBody(body);
  if (json === null) {
    return { ads: [], rateLimited: RATE_LIMIT_TEXT.test(text), ok: false };
  }
  if (jsonRateLimited(json)) return { ads: [], rateLimited: true, ok: false };

  const byId = new Map();
  walkJson(json, (node) => {
    if (Array.isArray(node) && node.length && node.some(looksLikeAd)) {
      for (const item of node) {
        if (!looksLikeAd(item)) continue;
        const ad = normalizeTiktokItem(item);
        if (ad.id && !byId.has(ad.id)) byId.set(ad.id, ad);
      }
      return false;
    }
    return undefined;
  });
  // A bare single ad object at the root (unlikely for search, but cheap to support).
  if (!byId.size && looksLikeAd(json)) {
    const ad = normalizeTiktokItem(json);
    byId.set(ad.id, ad);
  }
  return { ads: [...byId.values()], rateLimited: false, ok: true };
}

export function isTiktokHost(host) {
  return TIKTOK_HOST_RE.test(String(host || ''));
}

function hostOfUrl(u) {
  try {
    return new URL(u).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/** A plausible advertiser landing URL (http(s), not TikTok infra, not a media file). */
export function isExternalLanding(u) {
  if (typeof u !== 'string' || !/^https?:\/\//i.test(u)) return false;
  const host = hostOfUrl(u);
  if (!host || isTiktokHost(host)) return false;
  return !MEDIA_EXT_RE.test(u);
}

/**
 * Parse a captured /api/v1/items/{id}/details body.
 * @returns {{landingUrl:string, advertiserName:string, bizId:string, paidBy:string, rateLimited:boolean, ok:boolean}}
 */
export function parseTiktokDetail(body) {
  const out = { landingUrl: '', advertiserName: '', bizId: '', paidBy: '', rateLimited: false, ok: false };
  const { json, text } = parseBody(body);
  if (json === null) {
    out.rateLimited = RATE_LIMIT_TEXT.test(text);
    return out;
  }
  if (jsonRateLimited(json)) {
    out.rateLimited = true;
    return out;
  }
  out.ok = true;
  // Candidates ranked: explicit landing keys first, then website, then any *url* key.
  const ranked = [[], [], []];
  const visitObj = (o) => {
    for (const [k, v] of Object.entries(o)) {
      if (typeof v !== 'string' || !isExternalLanding(v)) continue;
      if (/external_url|landing/i.test(k)) ranked[0].push(v);
      else if (/website/i.test(k)) ranked[1].push(v);
      else if (/url|link/i.test(k)) ranked[2].push(v);
    }
    if (!out.advertiserName) {
      const n = firstOf(o, ['advertiser_name', 'adv_name', 'advertiser.name']);
      if (n) out.advertiserName = String(n);
    }
    if (!out.bizId) {
      const b = firstOf(o, ['adv_biz_id', 'biz_id', 'advertiser_id', 'advertiser.biz_id']);
      if (b) out.bizId = String(b);
    }
    if (!out.paidBy) {
      const p = firstOf(o, ['paid_by', 'paid_for_by', 'payer', 'payer_name', 'sponsor']);
      if (p) out.paidBy = String(p);
    }
  };
  walkJson(json, (node) => {
    if (isObj(node)) visitObj(node);
    return undefined;
  });
  const best = ranked[0][0] || ranked[1][0] || ranked[2][0] || '';
  out.landingUrl = best ? unwrapRedirect(best) : '';
  return out;
}

/** Collect ad ids from DOM hrefs (fallback when no search JSON was captured). */
export function adIdsFromHrefs(hrefs) {
  const ids = [];
  for (const h of hrefs || []) {
    const m = /\/ads\/detail\/?\?(?:[^#]*&)?ad_id=(\d+)/.exec(String(h));
    if (m) ids.push(m[1]);
  }
  return uniq(ids);
}

/** External landing from DOM hrefs of a detail page. */
export function landingFromHrefs(hrefs) {
  for (const h of hrefs || []) {
    const u = unwrapRedirect(String(h));
    if (isExternalLanding(u)) return u;
  }
  return '';
}

/** Map a raw-normalised TikTok item to an Ad. */
export function mapTiktokAd(raw, domain) {
  const landingUrl = raw.landingUrl ? unwrapRedirect(raw.landingUrl) : '';
  const confirmed = Boolean(landingUrl && domain && hostMatches(landingUrl, domain));
  const name = raw.advertiserName || raw.paidBy || '';
  return makeAd({
    platform: 'tiktok',
    id: String(raw.id),
    advertiserId: raw.bizId ? String(raw.bizId) : name,
    advertiserName: name,
    format: raw.format || 'video',
    title: raw.title || '',
    text: raw.text || (raw.reach ? `Reach: ${raw.reach}` : ''),
    landingUrl,
    displayUrl: '',
    firstShown: raw.firstShown || null,
    lastShown: raw.lastShown || null,
    isActive: null,
    previewUrl: raw.previewUrl || '',
    detailUrl: detailUrlFor(raw.id),
    placements: ['tiktok'],
    // viaName: found only by an advertiser-name search (query_type 2).
    match: confirmed ? 'confirmed' : raw.viaName ? 'name' : 'keyword',
    source: 'native',
  });
}

export function deepLinks(seeds) {
  const q = (seeds && (seeds.brand || domainLabel(seeds.domain || ''))) || '';
  return [{ label: 'TikTok Ad Library', url: buildSearchUrl({ region: 'all', q }) }];
}

// ---------------------------------------------------------------------------------------------
// I/O (only through ctx)
// ---------------------------------------------------------------------------------------------

export async function search(seeds, ctx) {
  const domain = (seeds && seeds.domain) || '';
  const settings = (ctx && ctx.settings) || {};
  const links = deepLinks(seeds);
  const state = {
    raw: new Map(), sawSearchPayload: false, anyOk: false, rateLimited: false, details: 0,
  };
  const progress = (t) => { try { ctx.progress && ctx.progress(t); } catch { /* ignore */ } };

  const addRaw = (ad) => {
    if (!ad || !ad.id) return;
    const prev = state.raw.get(ad.id);
    if (!prev) { state.raw.set(ad.id, ad); return; }
    const viaName = Boolean(prev.viaName && ad.viaName);
    for (const [k, v] of Object.entries(ad)) if (v && !prev[k]) prev[k] = v;
    if (prev.fromDom && !ad.fromDom) prev.fromDom = false;
    prev.viaName = viaName;
  };

  // Ads of advertisers with at least one ad pointing to the domain: a same-name advertiser without
  // one is a different company (name search alone is noise, as on LinkedIn and Bing).
  const buildAds = () => {
    let ads = dedupeAds([...state.raw.values()].map((r) => mapTiktokAd(r, domain)));
    ads = keepConfirmedAdvertisers(ads);
    return promoteAdvertiserMatches(ads) || ads;
  };

  const result = (status, message, ads) => {
    const advertisers = aggregateAdvertisers(ads, {
      platform: 'tiktok',
      urlFor: (id, name) => advertiserUrl(id, name),
    });
    return makeResult(meta, { status, message, ads, advertisers, deepLinks: links });
  };
  const finish = (status, message) => result(status, message, buildAds());

  try {
    if (!ctx || typeof ctx.capture !== 'function') {
      return finish('error', 'Capture tabs are not available');
    }
    const brand = (seeds && seeds.brand) || domainLabel(domain);
    const label = domainLabel(domain);
    const regions = Array.isArray(settings.tiktokRegions) ? settings.tiktokRegions : [];
    const plan = searchPlan(brand, label, seeds && seeds.advertiserNames);
    let budget = MAX_SEARCH_CAPTURES;

    // One capture of the search page; returns number of ads it contributed (-1 if no JSON,
    // -2 when the search-capture budget is used up).
    const searchOnce = async (region, q, queryType = 1) => {
      if (budget <= 0) return -2;
      budget -= 1;
      const viaName = queryType === 2;
      const url = buildSearchUrl({ region, q, now: Date.now(), queryType });
      if (ctx.throttle) await ctx.throttle();
      progress(`Searching ${viaName ? 'advertiser ' : ''}"${q}" (region ${region})`);
      const cap = (await ctx.capture(url, { platform: 'tiktok', waitMs: 8000 })) || {};
      let parsedAny = false;
      let count = 0;
      for (const p of cap.payloads || []) {
        if (!p || !String(p.url || '').includes('/api/v1/search')) continue;
        state.sawSearchPayload = true;
        if (RATE_LIMIT_STATUS.has(Number(p.status))) { state.rateLimited = true; continue; }
        const r = parseTiktokSearch(p.body);
        if (r.rateLimited) { state.rateLimited = true; continue; }
        if (!r.ok) continue;
        parsedAny = true;
        state.anyOk = true;
        for (const ad of r.ads) { if (!state.raw.has(ad.id)) count += 1; addRaw({ ...ad, viaName }); }
      }
      if (!parsedAny && !state.rateLimited && budget > 0 && typeof ctx.captureDom === 'function') {
        budget -= 1;
        progress('Reading TikTok results from the page');
        const dom = (await ctx.captureDom(url, { waitMs: 8000 })) || {};
        const ids = adIdsFromHrefs(dom.hrefs);
        if (ids.length) {
          state.anyOk = true;
          parsedAny = true;
          for (const id of ids) { if (!state.raw.has(id)) count += 1; addRaw({ id, advertiserName: '', fromDom: true, viaName }); }
        }
      }
      return parsedAny ? count : -1;
    };

    // Planned searches with region=all first (keyword + advertiser-name searches).
    for (const step of plan) {
      await searchOnce('all', step.q, step.queryType);
      if (state.rateLimited || budget <= 0) break;
    }
    // Nothing at all with region=all: retry the brand keyword search per region with what is left
    // of the budget (stop after 3 empty regions in a row).
    if (!state.rateLimited && !state.raw.size && plan.length) {
      let zeroStreak = 0;
      for (const region of regions) {
        const c = await searchOnce(region, plan[0].q, plan[0].queryType);
        if (c === -2 || state.rateLimited) break;
        zeroStreak = c > 0 ? 0 : zeroStreak + 1;
        if (zeroStreak >= 3) break;
      }
    }

    // Details: landing URL, advertiser, paid-by. Ads without a landing first.
    const maxDetails = Number.isFinite(Number(settings.tiktokDetails)) ? Number(settings.tiktokDetails) : 8;
    const todo = [...state.raw.values()].filter((r) => !r.landingUrl).slice(0, Math.max(0, maxDetails));
    for (let i = 0; i < todo.length && !state.rateLimited; i += 1) {
      const raw = todo[i];
      if (i > 0) await sleep(3000, ctx.signal);
      progress(`Checking ad details ${i + 1}/${todo.length}`);
      const url = detailUrlFor(raw.id);
      const cap = (await ctx.capture(url, { platform: 'tiktok', waitMs: 6000 })) || {};
      let got = false;
      for (const p of cap.payloads || []) {
        if (!p || !String(p.url || '').includes('/api/v1/items/')) continue;
        if (RATE_LIMIT_STATUS.has(Number(p.status))) { state.rateLimited = true; break; }
        const d = parseTiktokDetail(p.body);
        if (d.rateLimited) { state.rateLimited = true; break; }
        if (!d.ok) continue;
        got = true;
        if (d.landingUrl && !raw.landingUrl) raw.landingUrl = d.landingUrl;
        if (d.advertiserName && (!raw.advertiserName || raw.fromDom)) raw.advertiserName = d.advertiserName;
        if (d.bizId && !raw.bizId) raw.bizId = d.bizId;
        if (d.paidBy && !raw.paidBy) raw.paidBy = d.paidBy;
      }
      if (state.rateLimited) break;
      state.details += 1;
      if ((!got || !raw.landingUrl) && typeof ctx.captureDom === 'function') {
        const dom = (await ctx.captureDom(url, { waitMs: 6000 })) || {};
        const landing = landingFromHrefs(dom.hrefs);
        if (landing && !raw.landingUrl) raw.landingUrl = landing;
      }
    }

    const total = state.raw.size;
    const ads = buildAds();
    const confirmed = ads.filter((a) => a.match === 'confirmed').length;
    if (state.rateLimited) {
      return result('rate_limited', ads.length
        ? `TikTok rate limit hit, showing partial results (${ads.length} ads)`
        : 'TikTok is rate limiting this browser, try again later', ads);
    }
    if (confirmed) {
      return result('ok', `${ads.length} ads, ${confirmed} pointing to ${domain} (landing pages checked for ${state.details} of ${total})`, ads);
    }
    if (state.anyOk) {
      const searched = uniq(plan.map((s) => s.q)).join(', ');
      return result('empty', `No TikTok ads point to ${domain} (searched: ${searched})`, []);
    }
    if (state.sawSearchPayload) return result('changed', 'TikTok changed its response format', []);
    return result('error', 'TikTok search data was not captured (page did not load)', []);
  } catch (err) {
    if (ctx && ctx.signal && ctx.signal.aborted) return finish('error', 'Stopped');
    return finish('error', `TikTok search failed: ${(err && err.message) || err}`);
  }
}
