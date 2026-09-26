// Google Ads Transparency Center adapter (spec 4.1, verified facts in section 2).

import { hostMatches, normalizeDomain } from '../lib/domain.js';
import { sleep, toIsoDate } from '../lib/util.js';
import { decodeEntities } from '../lib/html.js';
import { makeAd, makeResult, aggregateAdvertisers, dedupeAds } from '../lib/model.js';

export const meta = {
  id: 'google',
  label: 'Google Ads (Search, YouTube, Display)',
  coverage: 'Global',
};

const BASE = 'https://adstransparency.google.com';
const HOME_URL = BASE + '/?region=anywhere';
const SEARCH_URL = BASE + '/anji/_/rpc/SearchService/SearchCreatives?authuser=0';
const BACKOFF_MS = [3000, 10000, 30000];
const FORMATS = { 1: 'text', 2: 'image', 3: 'video' };

export function advertiserUrl(id) {
  return `${BASE}/advertiser/${encodeURIComponent(id)}?region=anywhere`;
}

export function creativeUrl(advertiserId, creativeId) {
  return `${BASE}/advertiser/${encodeURIComponent(advertiserId)}/creative/${encodeURIComponent(creativeId)}?region=anywhere`;
}

export function deepLinks(seeds) {
  const d = encodeURIComponent((seeds && seeds.domain) || '');
  return [
    { label: 'Google Ads Transparency', url: `${BASE}/?region=anywhere&domain=${d}` },
    { label: 'YouTube ads', url: `${BASE}/?region=anywhere&domain=${d}&platform=YOUTUBE` },
  ];
}

// ------------------------------------------------------------ pure parsers

/** xsrfToken: '...' from the homepage html (present only when signed in to Google). */
export function parseXsrf(html) {
  if (typeof html !== 'string') return null;
  const m = /xsrfToken\s*:\s*'([^']+)'/.exec(html) || /"xsrfToken"\s*:\s*"([^"]+)"/.exec(html);
  return m ? m[1] : null;
}

/** Urlencoded form body 'f.req=<json>' exactly as verified in section 2. */
export function buildSearchBody(domain, { cursor, youtube } = {}) {
  const filter = { 12: { 1: String(domain || ''), 2: true } };
  if (youtube) filter[14] = [5];
  const req = { 2: 40, 3: filter, 7: { 1: 1, 2: 24, 3: 2616 } };
  if (cursor) req[4] = String(cursor);
  return 'f.req=' + encodeURIComponent(JSON.stringify(req));
}

function parseBody(json) {
  if (typeof json !== 'string') return json;
  const t = json.replace(/^\)\]\}'\s*/, '').trim();
  if (!t) return null;
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
}

function epochToIso(v) {
  if (!v || typeof v !== 'object') return null;
  const secs = Number(v[1]);
  if (!Number.isFinite(secs) || secs <= 0) return null;
  return toIsoDate(secs);
}

function previewOf(p) {
  if (!p || typeof p !== 'object') return '';
  const html = p[3] && p[3][2];
  if (typeof html === 'string') {
    const m = /<img\b[^>]*\bsrc\s*=\s*(?:"([^"]+)"|'([^']+)')/i.exec(html);
    if (m) return decodeEntities(m[1] || m[2] || '');
  }
  const js = p[1] && p[1][4];
  if (typeof js === 'string') return js;
  return '';
}

function matchesDomain(rowDomain, domain) {
  if (!rowDomain || !domain) return false;
  try {
    return !!hostMatches(String(rowDomain), domain);
  } catch {
    return false;
  }
}

/**
 * @param {object|string} json SearchCreatives response
 * @param {string} domain target domain
 * @returns {{ads:object[], cursor:string|null, totalRange:string|null, ok:boolean, empty:boolean}}
 *   ok = response has the rows array; empty = body is exactly {}.
 */
export function parseCreatives(json, domain) {
  const data = parseBody(json);
  const res = { ads: [], cursor: null, totalRange: null, ok: false, empty: false };
  if (!data || typeof data !== 'object' || Array.isArray(data)) return res;
  res.empty = Object.keys(data).length === 0;
  const rows = data[1];
  res.ok = Array.isArray(rows);
  if (typeof data[2] === 'string' && data[2]) res.cursor = data[2];
  const lo = data[4] != null && data[4] !== '' ? String(data[4]) : '';
  const hi = data[5] != null && data[5] !== '' ? String(data[5]) : '';
  if (lo && hi && lo !== hi) res.totalRange = `${lo}-${hi}`;
  else if (lo || hi) res.totalRange = lo || hi;
  if (!res.ok) return res;

  for (const r of rows) {
    if (!r || typeof r !== 'object') continue;
    const advertiserId = typeof r[1] === 'string' ? r[1] : '';
    const id = typeof r[2] === 'string' ? r[2] : '';
    if (!id) continue;
    const rowDomain = typeof r[14] === 'string' ? r[14] : '';
    res.ads.push(
      makeAd({
        platform: 'google',
        id,
        advertiserId,
        advertiserName: typeof r[12] === 'string' ? r[12] : '',
        format: FORMATS[Number(r[4])] || 'unknown',
        title: '',
        text: '',
        landingUrl: '',
        displayUrl: rowDomain,
        firstShown: epochToIso(r[6]),
        lastShown: epochToIso(r[7]),
        isActive: null,
        previewUrl: previewOf(r[3]),
        detailUrl: advertiserId ? creativeUrl(advertiserId, id) : '',
        placements: [],
        match: matchesDomain(rowDomain, domain) ? 'confirmed' : 'keyword',
        source: 'native',
      })
    );
  }
  return res;
}

// ------------------------------------------------------------------ search

export async function search(seeds, ctx) {
  const t0 = Date.now();
  const stats = { requests: 0, ms: 0 };
  let domain = '';
  try {
    domain = normalizeDomain(seeds && seeds.domain) || '';
  } catch {
    domain = '';
  }
  if (!domain) domain = String((seeds && seeds.domain) || '');
  const links = deepLinks({ ...(seeds || {}), domain });
  const settings = (ctx && ctx.settings) || {};
  const maxPages = Math.max(1, Number(settings.maxPagesGoogle) || 5);
  const byId = new Map();
  let totalRange = null;
  const notes = [];

  const finish = (status, message) => {
    stats.ms = Date.now() - t0;
    let ads = [...byId.values()];
    try {
      ads = dedupeAds(ads) || ads;
    } catch {
      /* keep ads */
    }
    let advertisers = [];
    try {
      // Roles via lib/model.js assignRoles: the owner is 'primary'; accounts with a handful of
      // ads to the same domain (affiliates, resellers, brand bidders) are 'other'.
      advertisers = aggregateAdvertisers(ads, { platform: 'google', urlFor: (id) => advertiserUrl(id) }) || [];
    } catch {
      advertisers = [];
    }
    const msgParts = [];
    if (message) msgParts.push(message);
    if (totalRange) msgParts.push(`~${totalRange} ads on this domain`);
    msgParts.push(...notes);
    return makeResult(meta, {
      status,
      message: msgParts.join('. '),
      advertisers,
      ads,
      deepLinks: links,
      stats,
    });
  };

  const captchaMsg = 'Google shows a captcha, open the link and solve it';

  // POST with 429 backoff. Returns {res, text} or {fail:{status,message}}.
  const post = async (body, token) => {
    for (let attempt = 0; ; attempt++) {
      await ctx.throttle();
      stats.requests++;
      const res = await ctx.fetch(SEARCH_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
          'X-Same-Domain': '1',
          'X-Framework-Xsrf-Token': token,
        },
        body,
      });
      if (res.url && res.url.includes('/sorry/')) return { fail: { status: 'needs_user', message: captchaMsg } };
      if (res.status === 429) {
        if (attempt < BACKOFF_MS.length) {
          ctx.progress && ctx.progress(`Google rate limit, retrying in ${BACKOFF_MS[attempt] / 1000}s`);
          await sleep(BACKOFF_MS[attempt], ctx.signal);
          continue;
        }
        return { fail: { status: 'rate_limited', message: 'Google rate-limited the requests, try again later' } };
      }
      if (res.status === 400) return { fail: { status: 'changed', message: 'Google changed its response format' } };
      if (!res.ok) return { fail: { status: 'error', message: `Google returned HTTP ${res.status}` } };
      return { res, text: await res.text() };
    }
  };

  try {
    // 1. xsrf token
    ctx.progress && ctx.progress('Opening Google Ads Transparency Center');
    await ctx.throttle();
    stats.requests++;
    const home = await ctx.fetch(HOME_URL);
    if (home.url && home.url.includes('/sorry/')) return finish('needs_user', captchaMsg);
    const token = parseXsrf(await home.text());
    if (!token) {
      return finish(
        'needs_user',
        'Sign in to Google in this browser (any Google account) to enable Google Ads Transparency search'
      );
    }

    // 2. main pages
    let cursor = null;
    for (let page = 1; page <= maxPages; page++) {
      ctx.progress && ctx.progress(`Google: page ${page}`);
      const r = await post(buildSearchBody(domain, { cursor }), token);
      if (r.fail) {
        if (page === 1) return finish(r.fail.status, r.fail.message);
        notes.push(`Stopped after page ${page - 1}: ${r.fail.message}`);
        break;
      }
      const parsed = parseCreatives(r.text, domain);
      if (!parsed.ok) {
        if (page === 1) {
          if (parsed.empty) return finish('empty', 'No Google ads found for this domain');
          return finish('changed', 'Google changed its response format');
        }
        break;
      }
      if (parsed.totalRange && !totalRange) totalRange = parsed.totalRange;
      for (const ad of parsed.ads) if (!byId.has(ad.id)) byId.set(ad.id, ad);
      cursor = parsed.cursor;
      if (!cursor || !parsed.ads.length) break;
    }

    // 3. YouTube pass
    const ytPages = Math.min(2, maxPages);
    let ytCursor = null;
    let ytCount = 0;
    for (let page = 1; page <= ytPages; page++) {
      ctx.progress && ctx.progress(`Google: YouTube page ${page}`);
      const r = await post(buildSearchBody(domain, { cursor: ytCursor, youtube: true }), token);
      if (r.fail) {
        notes.push(`YouTube pass incomplete: ${r.fail.message}`);
        break;
      }
      const parsed = parseCreatives(r.text, domain);
      if (!parsed.ok) break;
      for (const ad of parsed.ads) {
        ytCount++;
        const existing = byId.get(ad.id);
        if (existing) {
          const pl = Array.isArray(existing.placements) ? existing.placements : [];
          if (!pl.includes('youtube')) existing.placements = [...pl, 'youtube'];
        } else {
          ad.placements = ['youtube'];
          byId.set(ad.id, ad);
        }
      }
      ytCursor = parsed.cursor;
      if (!ytCursor || !parsed.ads.length) break;
    }
    if (ytCount) notes.push(`${ytCount} YouTube ads`);

    return finish(byId.size ? 'ok' : 'empty', byId.size ? '' : 'No Google ads found for this domain');
  } catch (e) {
    const aborted = e && (e.name === 'AbortError' || (ctx.signal && ctx.signal.aborted));
    return finish(byId.size ? 'ok' : 'error', aborted ? 'Stopped' : `Google search failed: ${(e && e.message) || e}`);
  }
}
