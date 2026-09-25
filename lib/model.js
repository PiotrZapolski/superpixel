// Data model: JSDoc typedefs and factories. Pure, no chrome.* usage (tested under Node).

/** @typedef {{domain:string, brand:string, brandCandidates:string[],
 *   social:{facebook:string[],instagram:string[],linkedin:string[],tiktok:string[],youtube:string[],x:string[],pinterest:string[]},
 *   ids:Object<string,string[]>, settings:Object}} Seeds */
/** @typedef {{platform:string, id:string, advertiserId:string, advertiserName:string,
 *   format:string, title:string, text:string, landingUrl:string, displayUrl:string,
 *   firstShown:string|null, lastShown:string|null, isActive:boolean|null, previewUrl:string,
 *   detailUrl:string, placements:string[], match:'confirmed'|'advertiser'|'keyword'|'name',
 *   source:'native'|'searchapi'}} Ad */
/** @typedef {{platform:string, id:string, name:string, url:string, country:string,
 *   adCount:number, confirmedCount:number, totalAds:string|null}} Advertiser */
/** @typedef {{platform:string, label:string, coverage:string,
 *   status:'ok'|'empty'|'error'|'rate_limited'|'needs_user'|'changed'|'skipped',
 *   message:string, advertisers:Advertiser[], ads:Ad[], deepLinks:{label:string,url:string}[],
 *   stats:{requests:number, ms:number}}} PlatformResult */
/** @typedef {{platform:string, category:'ads'|'analytics'|'tag-manager'|'crm',
 *   ids:string[], evidence:string[]}} TagHit */

export const PLATFORM_ORDER = ['google', 'meta', 'tiktok', 'linkedin', 'bing', 'snap'];

const MATCH_RANK = { confirmed: 4, advertiser: 3, keyword: 2, name: 1 };

function assignDefined(target, partial) {
  if (!partial || typeof partial !== 'object') return target;
  for (const [k, v] of Object.entries(partial)) {
    if (v !== undefined) target[k] = v;
  }
  return target;
}

/**
 * @param {Partial<Ad>} [partial]
 * @returns {Ad}
 */
export function makeAd(partial = {}) {
  const ad = assignDefined(
    {
      platform: '',
      id: '',
      advertiserId: '',
      advertiserName: '',
      format: '',
      title: '',
      text: '',
      landingUrl: '',
      displayUrl: '',
      firstShown: null,
      lastShown: null,
      isActive: null,
      previewUrl: '',
      detailUrl: '',
      placements: [],
      match: 'keyword',
      source: 'native',
    },
    partial,
  );
  ad.placements = Array.isArray(ad.placements) ? [...ad.placements] : [];
  return ad;
}

/**
 * @param {Partial<Advertiser>} [partial]
 * @returns {Advertiser}
 */
export function makeAdvertiser(partial = {}) {
  return assignDefined(
    {
      platform: '',
      id: '',
      name: '',
      url: '',
      country: '',
      adCount: 0,
      confirmedCount: 0,
      totalAds: null,
    },
    partial,
  );
}

/**
 * @param {{id:string,label:string,coverage:string}} meta
 * @param {Partial<PlatformResult>} [partial]
 * @returns {PlatformResult}
 */
export function makeResult(meta, partial = {}) {
  const m = meta || {};
  const res = assignDefined(
    {
      platform: m.id || '',
      label: m.label || '',
      coverage: m.coverage || '',
      status: 'ok',
      message: '',
      advertisers: [],
      ads: [],
      deepLinks: [],
      stats: { requests: 0, ms: 0 },
    },
    partial,
  );
  res.stats = assignDefined({ requests: 0, ms: 0 }, partial && partial.stats);
  if (!Array.isArray(res.advertisers)) res.advertisers = [];
  if (!Array.isArray(res.ads)) res.ads = [];
  if (!Array.isArray(res.deepLinks)) res.deepLinks = [];
  return res;
}

/**
 * Group ads into advertisers (by advertiserId, fallback advertiserName).
 * Sorted by confirmedCount desc, then adCount desc.
 * @param {Ad[]} ads
 * @param {{platform?:string, urlFor?:(id:string,name:string)=>string}} [opts]
 * @returns {Advertiser[]}
 */
export function aggregateAdvertisers(ads, { platform, urlFor } = {}) {
  const groups = new Map();
  for (const ad of ads || []) {
    if (!ad) continue;
    const key = ad.advertiserId || ad.advertiserName;
    if (!key) continue;
    let g = groups.get(key);
    if (!g) {
      g = { id: ad.advertiserId || '', platform: platform || ad.platform || '', names: new Map(), adCount: 0, confirmedCount: 0 };
      groups.set(key, g);
    }
    if (!g.id && ad.advertiserId) g.id = ad.advertiserId;
    g.adCount++;
    if (ad.match === 'confirmed') g.confirmedCount++;
    if (ad.advertiserName) g.names.set(ad.advertiserName, (g.names.get(ad.advertiserName) || 0) + 1);
  }
  const out = [];
  for (const g of groups.values()) {
    let name = '';
    let best = 0;
    for (const [n, c] of g.names) {
      if (c > best) {
        best = c;
        name = n;
      }
    }
    let url = '';
    if (typeof urlFor === 'function') {
      try {
        url = urlFor(g.id, name) || '';
      } catch {
        url = '';
      }
    }
    out.push(
      makeAdvertiser({
        platform: g.platform,
        id: g.id,
        name,
        url,
        adCount: g.adCount,
        confirmedCount: g.confirmedCount,
      }),
    );
  }
  out.sort((a, b) => b.confirmedCount - a.confirmedCount || b.adCount - a.adCount);
  return out;
}

/**
 * Ads with match 'keyword' or 'name' whose advertiser has at least one confirmed ad become 'advertiser'.
 * @param {Ad[]} ads
 * @returns {Ad[]}
 */
export function promoteAdvertiserMatches(ads) {
  if (!Array.isArray(ads)) return ads;
  const confirmed = new Set();
  for (const ad of ads) {
    if (ad && ad.match === 'confirmed' && ad.advertiserId) confirmed.add(`${ad.platform}|${ad.advertiserId}`);
  }
  for (const ad of ads) {
    if (!ad || !ad.advertiserId) continue;
    if ((ad.match === 'keyword' || ad.match === 'name') && confirmed.has(`${ad.platform}|${ad.advertiserId}`)) {
      ad.match = 'advertiser';
    }
  }
  return ads;
}

/**
 * Dedupe by platform+id, keeping the better match (confirmed > advertiser > keyword > name) and
 * merging placements. Ads without an id are kept as-is.
 * @param {Ad[]} ads
 * @returns {Ad[]}
 */
export function dedupeAds(ads) {
  if (!Array.isArray(ads)) return [];
  const out = [];
  const index = new Map();
  for (const ad of ads) {
    if (!ad) continue;
    if (!ad.id) {
      out.push(ad);
      continue;
    }
    const key = `${ad.platform}|${ad.id}`;
    const pos = index.get(key);
    if (pos === undefined) {
      index.set(key, out.length);
      out.push(ad);
      continue;
    }
    const prev = out[pos];
    const placements = [...new Set([...(prev.placements || []), ...(ad.placements || [])])];
    const better = (MATCH_RANK[ad.match] || 0) > (MATCH_RANK[prev.match] || 0) ? ad : prev;
    better.placements = placements;
    out[pos] = better;
  }
  return out;
}
