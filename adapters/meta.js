// Meta Ad Library adapter (spec 4.2, verified facts in section 2).
// Data comes from capture tabs: SSR <script type="application/json"> blobs (url 'ssr')
// and /api/graphql/ pagination responses.

import { hostMatches, normalizeDomain, domainLabel, unwrapRedirect } from '../lib/domain.js';
import { walkJson, parseJsonLines, toIsoDate } from '../lib/util.js';
import { makeAd, makeResult, aggregateAdvertisers, promoteAdvertiserMatches } from '../lib/model.js';

export const meta = {
  id: 'meta',
  label: 'Meta (Facebook, Instagram, Messenger)',
  coverage: 'Global (active ads); inactive only EU/political',
};

const LIB = 'https://www.facebook.com/ads/library/';
const RATE_LIMIT_CODE = 1675004;
const RATE_LIMIT_RE = /"(?:code|error|error_code|errorCode)"\s*:\s*"?1675004\b/;

export function buildSearchUrl({ q, pageId } = {}) {
  const base = 'active_status=active&ad_type=all&country=ALL&is_targeted_country=false&media_type=all';
  if (pageId) {
    return `${LIB}?${base}&search_type=page&view_all_page_id=${encodeURIComponent(String(pageId))}`;
  }
  return `${LIB}?${base}&search_type=keyword_unordered&q=${encodeURIComponent(String(q || ''))}`;
}

export function pageLibraryUrl(pageId) {
  return `${LIB}?active_status=active&ad_type=all&country=ALL&view_all_page_id=${encodeURIComponent(String(pageId))}&search_type=page`;
}

export function deepLinks(seeds) {
  const links = [];
  const domain = (seeds && seeds.domain) || '';
  if (domain) links.push({ label: 'Meta Ad Library (domain)', url: buildSearchUrl({ q: domain }) });
  const brand = seeds && seeds.brand;
  if (brand && String(brand).toLowerCase() !== String(domain).toLowerCase()) {
    links.push({ label: `Meta Ad Library ("${brand}")`, url: buildSearchUrl({ q: brand }) });
  }
  return links;
}

// ------------------------------------------------------------ pure parsers

function valuesOf(body) {
  if (typeof body !== 'string' || !body) return [];
  let vals;
  try {
    vals = parseJsonLines(body);
  } catch {
    vals = null;
  }
  if (vals == null) return [];
  return Array.isArray(vals) ? vals : [vals];
}

function isRateLimitNode(node) {
  if (!node || typeof node !== 'object') return false;
  for (const k of ['code', 'error', 'error_code', 'errorCode']) {
    if (Number(node[k]) === RATE_LIMIT_CODE) return true;
  }
  return false;
}

/**
 * @param {{url:string, status?:number, body:string}[]} payloads
 * @returns {{results:object[], rateLimited:boolean, found:number}}
 *   found = number of collated_results arrays seen (0 means nothing recognisable was captured).
 */
export function parseMetaPayloads(payloads) {
  const results = [];
  const seen = new Set();
  let rateLimited = false;
  let found = 0;
  for (const p of Array.isArray(payloads) ? payloads : []) {
    const body = p && typeof p.body === 'string' ? p.body : '';
    if (!body) continue;
    if (RATE_LIMIT_RE.test(body)) rateLimited = true;
    for (const root of valuesOf(body)) {
      if (!root || typeof root !== 'object') continue;
      try {
        walkJson(root, (node) => {
          if (!node || typeof node !== 'object') return undefined;
          if (isRateLimitNode(node)) rateLimited = true;
          if (Array.isArray(node.collated_results)) {
            found++;
            for (const r of node.collated_results) {
              if (!r || typeof r !== 'object' || r.ad_archive_id == null) continue;
              const id = String(r.ad_archive_id);
              if (seen.has(id)) continue;
              seen.add(id);
              results.push(r);
            }
            return false;
          }
          return undefined;
        });
      } catch {
        /* malformed payload, skip */
      }
    }
  }
  return { results, rateLimited, found };
}

function textOf(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'object' && typeof v.text === 'string') return v.text;
  return '';
}

function firstStr(...vals) {
  for (const v of vals) if (typeof v === 'string' && v.trim()) return v.trim();
  return '';
}

function arr(v) {
  return Array.isArray(v) ? v : [];
}

function safeUnwrap(u) {
  if (!u) return '';
  try {
    return unwrapRedirect(u) || u;
  } catch {
    return u;
  }
}

function urlMatches(u, domain) {
  if (!u || !domain) return false;
  let v = String(u).trim().toLowerCase();
  if (!v) return false;
  if (!/^https?:\/\//.test(v)) v = 'https://' + v.replace(/^\/+/, '');
  try {
    return !!hostMatches(v, domain);
  } catch {
    return false;
  }
}

function formatOf(s, cards, images, videos) {
  if (videos.length || cards.some((c) => c && c.video_preview_image_url)) return 'video';
  if (cards.length > 1) return 'carousel';
  if (images.length || cards.some((c) => c && c.original_image_url)) return 'image';
  if (typeof s.display_format === 'string' && s.display_format) return s.display_format.toLowerCase();
  return 'text';
}

/** Map one collated result to an Ad. */
export function mapMetaResult(raw, domain) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const s = r.snapshot && typeof r.snapshot === 'object' ? r.snapshot : {};
  const cards = arr(s.cards).filter((c) => c && typeof c === 'object');
  const c0 = cards[0] || {};
  const images = arr(s.images).filter((x) => x && typeof x === 'object');
  const videos = arr(s.videos).filter((x) => x && typeof x === 'object');
  const id = r.ad_archive_id != null ? String(r.ad_archive_id) : '';

  const landingUrl = safeUnwrap(firstStr(s.link_url, c0.link_url));
  const displayUrl = firstStr(s.caption, c0.caption);
  const cardLinks = cards.map((c) => safeUnwrap(firstStr(c.link_url))).filter(Boolean);

  const confirmed =
    urlMatches(landingUrl, domain) ||
    urlMatches(displayUrl, domain) ||
    cardLinks.some((u) => urlMatches(u, domain));

  const previewUrl = firstStr(
    images[0] && images[0].original_image_url,
    images[0] && images[0].resized_image_url,
    videos[0] && videos[0].video_preview_image_url,
    c0.original_image_url,
    c0.resized_image_url,
    c0.video_preview_image_url
  );

  return makeAd({
    platform: 'meta',
    id,
    advertiserId: r.page_id != null ? String(r.page_id) : s.page_id != null ? String(s.page_id) : '',
    advertiserName: firstStr(r.page_name, s.page_name),
    format: formatOf(s, cards, images, videos),
    title: firstStr(textOf(s.title), textOf(c0.title)),
    text: firstStr(textOf(s.body), textOf(c0.body)),
    landingUrl,
    displayUrl,
    firstShown: r.start_date ? toIsoDate(Number(r.start_date)) : null,
    lastShown: r.end_date ? toIsoDate(Number(r.end_date)) : null,
    isActive: typeof r.is_active === 'boolean' ? r.is_active : null,
    previewUrl,
    detailUrl: id ? `${LIB}?id=${encodeURIComponent(id)}` : '',
    placements: arr(r.publisher_platform)
      .filter((x) => typeof x === 'string')
      .map((x) => x.toLowerCase()),
    match: confirmed ? 'confirmed' : 'keyword',
    source: 'native',
  });
}

// ------------------------------------------------------------------ search

function isLoginUrl(u) {
  return typeof u === 'string' && (u.includes('/login') || u.includes('/checkpoint'));
}

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
  const scrolls = Math.max(0, Number(settings.metaScrolls ?? 2) || 0);
  const expandPages = Math.max(0, Number(settings.metaExpandPages ?? 3) || 0);
  const byId = new Map();
  const notes = [];
  let rateLimited = false;

  const addAd = (ad) => {
    if (!ad || !ad.id) return;
    const prev = byId.get(ad.id);
    if (!prev) byId.set(ad.id, ad);
    else if (ad.match === 'confirmed' && prev.match !== 'confirmed') byId.set(ad.id, ad);
  };

  const finish = (status, message) => {
    stats.ms = Date.now() - t0;
    let ads = [...byId.values()];
    try {
      ads = promoteAdvertiserMatches(ads) || ads;
    } catch {
      /* keep ads */
    }
    let advertisers = [];
    try {
      advertisers =
        aggregateAdvertisers(ads, { platform: 'meta', urlFor: (id) => `https://www.facebook.com/${id}` }) || [];
    } catch {
      advertisers = [];
    }
    return makeResult(meta, {
      status,
      message: [message, ...notes].filter(Boolean).join('. '),
      advertisers,
      ads,
      deepLinks: links,
      stats,
    });
  };

  const capture = async (url, opts) => {
    stats.requests++;
    try {
      const r = await ctx.capture(url, { platform: 'meta', ...opts });
      return r || { payloads: [], tabUrl: '', error: 'no response' };
    } catch (e) {
      return { payloads: [], tabUrl: '', error: (e && e.message) || String(e) };
    }
  };

  try {
    // 1. keyword search with the domain
    ctx.progress && ctx.progress(`Meta: searching "${domain}"`);
    const first = await capture(buildSearchUrl({ q: domain }), { scrolls });
    if (isLoginUrl(first.tabUrl)) {
      return finish('needs_user', 'Log in to Facebook in this browser to search the Meta Ad Library');
    }
    const p1 = parseMetaPayloads(first.payloads);
    for (const raw of p1.results) addAd(mapMetaResult(raw, domain));
    if (p1.rateLimited) rateLimited = true;
    if (p1.found === 0 && !p1.results.length) {
      if (rateLimited) return finish('rate_limited', 'Meta is rate-limiting the Ad Library, try again later');
      if (first.error && !(first.payloads && first.payloads.length)) {
        return finish('error', `Meta Ad Library did not load (${first.error})`);
      }
      return finish('changed', 'Meta changed its response format');
    }

    // 2. brand pass: keep only confirmed ads
    let label = '';
    try {
      label = domainLabel(domain) || '';
    } catch {
      label = '';
    }
    const brand = seeds && typeof seeds.brand === 'string' ? seeds.brand.trim() : '';
    if (!rateLimited && brand && brand.toLowerCase() !== label.toLowerCase() && brand.toLowerCase() !== domain) {
      ctx.progress && ctx.progress(`Meta: searching "${brand}"`);
      const cap = await capture(buildSearchUrl({ q: brand }), { scrolls: Math.min(scrolls, 1) });
      if (isLoginUrl(cap.tabUrl)) {
        notes.push('Brand search needs a Facebook login');
      } else {
        const p = parseMetaPayloads(cap.payloads);
        if (p.rateLimited) rateLimited = true;
        for (const raw of p.results) {
          const ad = mapMetaResult(raw, domain);
          if (ad.match === 'confirmed') addAd(ad);
        }
      }
    }

    // 3. expansion over pages with confirmed ads
    if (!rateLimited && expandPages > 0) {
      const counts = new Map();
      for (const ad of byId.values()) {
        if (ad.match === 'confirmed' && ad.advertiserId) {
          counts.set(ad.advertiserId, (counts.get(ad.advertiserId) || 0) + 1);
        }
      }
      const pageIds = [...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, expandPages)
        .map(([id]) => id);
      for (const pid of pageIds) {
        if (rateLimited || (ctx.signal && ctx.signal.aborted)) break;
        ctx.progress && ctx.progress(`Meta: loading all ads of page ${pid}`);
        const cap = await capture(buildSearchUrl({ pageId: pid }), { scrolls: Math.min(scrolls, 1) });
        if (isLoginUrl(cap.tabUrl)) break;
        const p = parseMetaPayloads(cap.payloads);
        if (p.rateLimited) rateLimited = true;
        for (const raw of p.results) {
          const ad = mapMetaResult(raw, domain);
          if (ad.advertiserId && ad.advertiserId !== pid) continue;
          if (ad.match !== 'confirmed') ad.match = 'advertiser';
          addAd(ad);
        }
      }
    }

    if (rateLimited) {
      if (!byId.size) return finish('rate_limited', 'Meta is rate-limiting the Ad Library, try again later');
      notes.push('Meta rate-limited further requests, results are partial');
    }
    return finish(byId.size ? 'ok' : 'empty', byId.size ? '' : 'No Meta ads found for this domain');
  } catch (e) {
    const aborted = e && (e.name === 'AbortError' || (ctx.signal && ctx.signal.aborted));
    return finish(byId.size ? 'ok' : 'error', aborted ? 'Stopped' : `Meta search failed: ${(e && e.message) || e}`);
  }
}
