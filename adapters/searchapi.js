// Optional SearchAPI.io fallback (spec 4.7). Only used when a native adapter ends in
// changed / error / rate_limited and the user saved a key. The key travels in the
// Authorization header (supported by SearchAPI, see docs) so it never appears in URLs, and it
// is never logged or copied into messages.
//
// Engines and params confirmed on searchapi.io/docs (2026-09-25):
//   google_ads_transparency_center: domain, region, num (max 100), next_page_token
//     -> ad_creatives[] {id, target_domain, advertiser{id,name}, first_shown_datetime,
//        last_shown_datetime, format, details_link, image?}, search_information.total_results
//   meta_ad_library: q, country (ALL), active_status, next_page_token
//     -> ads[] {ad_archive_id, page_id, page_name, is_active, start_date, end_date (ISO),
//        publisher_platform[], snapshot{link_url, caption, title, body.text, cards[], images[], videos[]}}
//   tiktok_ads_library: q, country, time_period, advertiser_token
//     -> ads[] {id, advertiser, advertiser_id, title, format, first_shown_datetime,
//        last_shown_datetime, cover_image, estimated_audience}
//   linkedin_ad_library: advertiser | q, country, time_period
//     -> ads[] {id, advertiser{name,thumbnail}, ad_type, content{headline,title,image,items[],pages[]}, link}

import { hostMatches, unwrapRedirect } from '../lib/domain.js';
import { toIsoDate } from '../lib/util.js';
import { makeAd, aggregateAdvertisers, promoteAdvertiserMatches, dedupeAds } from '../lib/model.js';

const ENDPOINT = 'https://www.searchapi.io/api/v1/search';

export const ENGINES = {
  google: 'google_ads_transparency_center',
  meta: 'meta_ad_library',
  tiktok: 'tiktok_ads_library',
  linkedin: 'linkedin_ad_library',
};

export function supports(platformId) {
  return Object.prototype.hasOwnProperty.call(ENGINES, platformId);
}

/** Query params (without the key) for a platform. */
export function buildParams(platformId, seeds) {
  const domain = (seeds && seeds.domain) || '';
  const brand = (seeds && seeds.brand) || domain;
  switch (platformId) {
    case 'google': return { engine: ENGINES.google, domain, region: 'anywhere', num: '100' };
    case 'meta': return { engine: ENGINES.meta, q: domain, country: 'ALL', active_status: 'active' };
    case 'tiktok': return { engine: ENGINES.tiktok, q: brand };
    case 'linkedin': return { engine: ENGINES.linkedin, advertiser: brand };
    default: return null;
  }
}

export function buildUrl(params) {
  return `${ENDPOINT}?${new URLSearchParams(params).toString()}`;
}

function s(v) {
  return v === undefined || v === null ? '' : String(v);
}

function matches(url, domain) {
  if (!url || !domain) return false;
  const u = /^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `https://${url}`;
  try { return Boolean(hostMatches(u, domain)); } catch { return false; }
}

function list(json, key) {
  return json && Array.isArray(json[key]) ? json[key] : null;
}

// ---------------------------------------------------------------------------------------------
// Pure mappers (one per engine). Each returns Ad[] or null when the shape is unexpected.
// ---------------------------------------------------------------------------------------------

export function mapGoogle(json, domain) {
  const rows = list(json, 'ad_creatives');
  if (!rows) return null;
  return rows.filter((r) => r && r.id).map((r) => {
    const adv = r.advertiser || {};
    const target = s(r.target_domain);
    return makeAd({
      platform: 'google',
      id: s(r.id),
      advertiserId: s(adv.id),
      advertiserName: s(adv.name),
      format: s(r.format) || 'text',
      title: '',
      text: '',
      landingUrl: '',
      displayUrl: target,
      firstShown: toIsoDate(r.first_shown_datetime || null),
      lastShown: toIsoDate(r.last_shown_datetime || null),
      isActive: null,
      previewUrl: s(r.image || (r.images && r.images[0]) || ''),
      detailUrl: s(r.details_link) || (adv.id ? `https://adstransparency.google.com/advertiser/${adv.id}/creative/${r.id}?region=anywhere` : ''),
      placements: [],
      match: matches(target, domain) ? 'confirmed' : 'keyword',
      source: 'searchapi',
    });
  });
}

export function mapMeta(json, domain) {
  const rows = list(json, 'ads');
  if (!rows) return null;
  return rows.filter((r) => r && r.ad_archive_id).map((r) => {
    const snap = r.snapshot || {};
    const card = (Array.isArray(snap.cards) && snap.cards[0]) || {};
    const landing = s(snap.link_url || card.link_url);
    const landingUrl = landing ? unwrapRedirect(landing) : '';
    const displayUrl = s(snap.caption || card.caption);
    const bodyText = snap.body && typeof snap.body === 'object' ? s(snap.body.text) : s(snap.body);
    const title = s(snap.title || card.title);
    const previewUrl = s(
      (Array.isArray(snap.images) && snap.images[0] && snap.images[0].original_image_url)
      || (Array.isArray(snap.videos) && snap.videos[0] && snap.videos[0].video_preview_image_url)
      || card.original_image_url || card.resized_image_url || '',
    );
    const confirmed = matches(landingUrl, domain) || matches(displayUrl, domain);
    const id = s(r.ad_archive_id);
    return makeAd({
      platform: 'meta',
      id,
      advertiserId: s(r.page_id || snap.page_id),
      advertiserName: s(r.page_name || snap.page_name),
      format: snap.videos && snap.videos.length ? 'video' : 'image',
      title: /^\{\{.*\}\}$/.test(title) ? '' : title,
      text: bodyText || s(card.body),
      landingUrl,
      displayUrl,
      firstShown: toIsoDate(r.start_date || null),
      lastShown: toIsoDate(r.end_date || null),
      isActive: typeof r.is_active === 'boolean' ? r.is_active : null,
      previewUrl,
      detailUrl: `https://www.facebook.com/ads/library/?id=${encodeURIComponent(id)}`,
      placements: Array.isArray(r.publisher_platform) ? r.publisher_platform.map((p) => s(p).toLowerCase()) : [],
      match: confirmed ? 'confirmed' : 'keyword',
      source: 'searchapi',
    });
  });
}

export function mapTiktok(json) {
  const rows = list(json, 'ads');
  if (!rows) return null;
  return rows.filter((r) => r && r.id).map((r) => {
    const name = typeof r.advertiser === 'string' ? r.advertiser : s(r.advertiser && r.advertiser.name);
    const id = s(r.id);
    return makeAd({
      platform: 'tiktok',
      id,
      advertiserId: s(r.advertiser_id) || name,
      advertiserName: name,
      format: s(r.format) || 'video',
      title: s(r.title),
      text: r.estimated_audience ? `Reach: ${r.estimated_audience}` : '',
      landingUrl: '',
      displayUrl: '',
      firstShown: toIsoDate(r.first_shown_datetime || null),
      lastShown: toIsoDate(r.last_shown_datetime || null),
      isActive: null,
      previewUrl: s(r.cover_image || (Array.isArray(r.image_urls) && r.image_urls[0]) || (Array.isArray(r.images) && r.images[0]) || ''),
      detailUrl: `https://library.tiktok.com/ads/detail/?ad_id=${encodeURIComponent(id)}`,
      placements: ['tiktok'],
      match: 'keyword',
      source: 'searchapi',
    });
  });
}

export function mapLinkedin(json) {
  const rows = list(json, 'ads');
  if (!rows) return null;
  const out = [];
  for (const r of rows) {
    if (!r) continue;
    const linkId = /\/ad-library\/detail\/(\d+)/.exec(s(r.link));
    const id = s(r.id) || (linkId ? linkId[1] : '');
    if (!id) continue; // event ads etc. carry no ad id
    const c = r.content || {};
    const name = s(r.advertiser && typeof r.advertiser === 'object' ? r.advertiser.name : r.advertiser);
    const image = s(c.image || (Array.isArray(c.items) && c.items[0] && c.items[0].image) || (Array.isArray(c.pages) && c.pages[0]) || '');
    out.push(makeAd({
      platform: 'linkedin',
      id,
      advertiserId: name,
      advertiserName: name,
      format: s(r.ad_type) || (image ? 'image' : 'text'),
      title: s(c.title),
      text: s(c.headline),
      landingUrl: '',
      displayUrl: '',
      firstShown: null,
      lastShown: null,
      isActive: null,
      previewUrl: image,
      detailUrl: `https://www.linkedin.com/ad-library/detail/${encodeURIComponent(id)}`,
      placements: ['linkedin'],
      match: 'name',
      source: 'searchapi',
    }));
  }
  return out;
}

const MAPPERS = { google: mapGoogle, meta: mapMeta, tiktok: mapTiktok, linkedin: mapLinkedin };

export function advertiserUrlFor(platformId) {
  return (id, name) => {
    switch (platformId) {
      case 'google': return id ? `https://adstransparency.google.com/advertiser/${id}?region=anywhere` : '';
      case 'meta': return id ? `https://www.facebook.com/${id}` : '';
      case 'tiktok': return /^\d+$/.test(s(id))
        ? `https://library.tiktok.com/ads?region=all&adv_biz_ids=${id}&adv_name=${encodeURIComponent(s(name))}&query_type=2`
        : `https://library.tiktok.com/ads?region=all&adv_name=${encodeURIComponent(s(name))}&query_type=1`;
      case 'linkedin': return `https://www.linkedin.com/ad-library/search?accountOwner=${encodeURIComponent(s(name || id))}&countries=ALL`;
      default: return '';
    }
  };
}

/** Map a raw SearchAPI response for one platform -> {ads, advertisers, ok}. */
export function mapResponse(platformId, json, domain) {
  const mapper = MAPPERS[platformId];
  if (!mapper || !json || typeof json !== 'object') return { ads: [], advertisers: [], ok: false };
  const mapped = mapper(json, domain);
  if (mapped === null) return { ads: [], advertisers: [], ok: false };
  let ads = dedupeAds(mapped);
  ads = promoteAdvertiserMatches(ads) || ads;
  const advertisers = aggregateAdvertisers(ads, { platform: platformId, urlFor: advertiserUrlFor(platformId) });
  return { ads, advertisers, ok: true };
}

function scrub(text, key) {
  let t = s(text);
  if (key) t = t.split(key).join('***');
  return t.slice(0, 200);
}

/**
 * Fallback search. Never throws. Returns {status, source:'searchapi', advertisers, ads, message}.
 */
export async function fallback(platformId, seeds, ctx) {
  const empty = (status, message) => ({ status, source: 'searchapi', advertisers: [], ads: [], message });
  const key = ctx && ctx.settings && typeof ctx.settings.searchapiKey === 'string' ? ctx.settings.searchapiKey.trim() : '';
  if (!supports(platformId)) return empty('skipped', 'SearchAPI does not cover this platform');
  if (!key) return empty('skipped', 'No SearchAPI key set');
  const params = buildParams(platformId, seeds);
  if (!params || !(params.domain || params.q || params.advertiser)) return empty('skipped', 'Nothing to search on SearchAPI');
  try {
    if (ctx.progress) { try { ctx.progress(`Trying SearchAPI.io (${params.engine})`); } catch { /* ignore */ } }
    const res = await ctx.fetch(buildUrl(params), {
      credentials: 'omit',
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
    });
    if (res.status === 401 || res.status === 403) return empty('error', 'SearchAPI rejected the API key');
    if (res.status === 429) return empty('rate_limited', 'SearchAPI rate limit or quota reached');
    let json = null;
    try { json = JSON.parse(await res.text()); } catch { json = null; }
    if (res.status < 200 || res.status >= 300) {
      const detail = json && json.error ? `: ${scrub(json.error, key)}` : '';
      return empty('error', `SearchAPI returned HTTP ${res.status}${detail}`);
    }
    if (json && json.error && !Array.isArray(json.ads) && !Array.isArray(json.ad_creatives)) {
      return empty('error', `SearchAPI: ${scrub(json.error, key)}`);
    }
    const domain = (seeds && seeds.domain) || '';
    const r = mapResponse(platformId, json, domain);
    if (!r.ok) return empty('changed', 'SearchAPI response format not recognised');
    const total = json.search_information && json.search_information.total_results;
    const message = r.ads.length
      ? `${r.ads.length} ads via SearchAPI.io${total ? ` (of ~${total})` : ''}`
      : 'No ads found via SearchAPI.io';
    return { status: r.ads.length ? 'ok' : 'empty', source: 'searchapi', advertisers: r.advertisers, ads: r.ads, message };
  } catch (err) {
    if (ctx && ctx.signal && ctx.signal.aborted) return empty('error', 'Stopped');
    return empty('error', `SearchAPI request failed: ${scrub(err && err.message ? err.message : err, key)}`);
  }
}
