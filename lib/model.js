// Data model: JSDoc typedefs and factories. Pure, no chrome.* usage (tested under Node).

/** @typedef {{domain:string, brand:string, brandCandidates:string[],
 *   social:{facebook:string[],instagram:string[],linkedin:string[],tiktok:string[],youtube:string[],x:string[],pinterest:string[]},
 *   ids:Object<string,string[]>, settings:Object, advertiserNames?:string[]}} Seeds
 * advertiserNames: names of the primary advertisers found by Google/Meta (set by scan.js before
 * the name-based platforms run). */
/** @typedef {{platform:string, id:string, advertiserId:string, advertiserName:string,
 *   format:string, title:string, text:string, landingUrl:string, displayUrl:string,
 *   firstShown:string|null, lastShown:string|null, isActive:boolean|null, previewUrl:string,
 *   detailUrl:string, placements:string[], match:'confirmed'|'advertiser'|'keyword'|'name',
 *   source:'native'|'searchapi'}} Ad */
/** @typedef {{platform:string, id:string, name:string, url:string, country:string,
 *   adCount:number, confirmedCount:number, totalAds:string|null, role:'primary'|'other'|'mention',
 *   domains:number|null, note:string}} Advertiser
 * role: 'primary' (owner-sized account with ads to the domain), 'other' (small account with ads to
 * the domain), 'mention' (no ad links to the domain: keyword matches, often competitors).
 * totalAds: all ads of the account on the platform, when known (Google: "28" or "1000-2000").
 * domains: distinct sites the account advertises (Google 'other' accounts), null when unknown.
 * note: short human hint, e.g. "Shared account: ads for 12 different sites". */
/** @typedef {{primary:number, other:number, mention:number, sharedAccounts:number}} AdvertiserSummary */
/** @typedef {{platform:string, label:string, coverage:string,
 *   status:'ok'|'empty'|'error'|'rate_limited'|'needs_user'|'changed'|'skipped',
 *   message:string, advertisers:Advertiser[], ads:Ad[], deepLinks:{label:string,url:string}[],
 *   stats:{requests:number, ms:number}, summary?:AdvertiserSummary}} PlatformResult */
/** @typedef {{platform:string, category:'ads'|'analytics'|'tag-manager'|'crm',
 *   ids:string[], evidence:string[], source:'page'|'container'}} TagHit
 * source: 'page' when the page itself showed the tag, 'container' when only found inside the
 * site's GTM container / Google tag (e.g. pixels held back by a consent banner). */

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
      role: 'primary',
      domains: null,
      note: '',
    },
    partial,
  );
}

/** Advertisers with at least this many distinct sites are shared (agency / rented) accounts. */
export const SHARED_ACCOUNT_MIN_DOMAINS = 3;

/**
 * Note for an advertiser from the distinct domains it advertises.
 * @param {number} domains distinct domain count
 * @param {boolean} onlyTarget true when every known ad of the account points to the target domain
 * @returns {string}
 */
export function accountNote(domains, onlyTarget) {
  const n = Number(domains) || 0;
  if (n >= SHARED_ACCOUNT_MIN_DOMAINS) return `Shared account: ads for ${n} different sites`;
  if (onlyTarget) return 'Only advertises this domain';
  return '';
}

/**
 * @param {Advertiser[]} advertisers
 * @returns {AdvertiserSummary}
 */
export function advertiserSummary(advertisers) {
  const out = { primary: 0, other: 0, mention: 0, sharedAccounts: 0 };
  for (const a of Array.isArray(advertisers) ? advertisers : []) {
    if (!a || typeof a !== 'object') continue;
    if (a.role === 'other') out.other++;
    else if (a.role === 'mention') out.mention++;
    else out.primary++;
    if ((Number(a.domains) || 0) >= SHARED_ACCOUNT_MIN_DOMAINS) out.sharedAccounts++;
  }
  return out;
}

/** Share of a platform's ads (or absolute count) that makes an advertiser 'primary'. */
export const PRIMARY_SHARE = 0.1;
export const PRIMARY_MIN_ADS = 5;

/**
 * Platforms that never expose landing pages, so no ad can be confirmed: advertisers there are
 * name matches and keep the size-based primary / other roles instead of 'mention'.
 */
export const NAME_ONLY_PLATFORMS = new Set(['snap']);

/**
 * Mark each advertiser:
 * - 'mention': no confirmed ad (its ads mention the brand or domain but link elsewhere, often a
 *   competitor). Never primary. Not used on NAME_ONLY_PLATFORMS.
 * - 'primary': has confirmed ads and holds >= 10% of the ranked ads or >= 5 ads; the top
 *   advertiser always.
 * - 'other': has confirmed ads but is small (affiliates, resellers, brand bidders).
 * The top advertiser is the one with the most confirmed ads, then the most ads; the share is
 * computed over the non-mention advertisers. Mutates and returns the same array.
 * @param {Advertiser[]} advertisers
 * @returns {Advertiser[]}
 */
export function assignRoles(advertisers) {
  if (!Array.isArray(advertisers)) return advertisers;
  const list = advertisers.filter((a) => a && typeof a === 'object');
  const isMention = (a) => !NAME_ONLY_PLATFORMS.has(a.platform) && !(Number(a.confirmedCount) > 0);
  const ranked = list.filter((a) => !isMention(a));
  const total = ranked.reduce((n, a) => n + (Number(a.adCount) || 0), 0);
  let top = null;
  for (const a of ranked) {
    if (!top) {
      top = a;
      continue;
    }
    const c = (Number(a.confirmedCount) || 0) - (Number(top.confirmedCount) || 0);
    if (c > 0 || (c === 0 && (Number(a.adCount) || 0) > (Number(top.adCount) || 0))) top = a;
  }
  for (const a of list) {
    if (isMention(a)) {
      a.role = 'mention';
      continue;
    }
    const n = Number(a.adCount) || 0;
    const big = n >= PRIMARY_MIN_ADS || (total > 0 && n / total >= PRIMARY_SHARE);
    a.role = a === top || big ? 'primary' : 'other';
  }
  return advertisers;
}

/**
 * Name-based platforms (TikTok, LinkedIn): keep only the ads of advertisers with at least one ad
 * pointing to the domain. `adopt(ad, confirmed)` may return the id of a confirmed advertiser that
 * an unconfirmed ad belongs to (LinkedIn employee posts); the ad is then moved to that advertiser.
 * `confirmed` maps lower-cased advertiser names to confirmed advertiser ids.
 * @param {Ad[]} ads
 * @param {(ad:Ad, confirmed:Map<string,string>)=>string|undefined} [adopt]
 * @returns {Ad[]}
 */
export function keepConfirmedAdvertisers(ads, adopt) {
  if (!Array.isArray(ads)) return [];
  const ids = new Set();
  const byName = new Map();
  for (const ad of ads) {
    if (!ad || ad.match !== 'confirmed' || !ad.advertiserId) continue;
    ids.add(ad.advertiserId);
    const k = String(ad.advertiserName || '').trim().toLowerCase();
    if (k && !byName.has(k)) byName.set(k, ad.advertiserId);
  }
  const out = [];
  for (const ad of ads) {
    if (!ad) continue;
    if (ids.has(ad.advertiserId)) {
      out.push(ad);
      continue;
    }
    const id = typeof adopt === 'function' ? adopt(ad, byName) : '';
    if (id && ids.has(id)) out.push({ ...ad, advertiserId: id });
  }
  return out;
}

// Legal-form suffixes stripped from advertiser names (applied repeatedly, from the end).
const LEGAL_SUFFIX_RE =
  /[\s,]+(?:&\s*co\.?\s*kg|sp\.?\s*z\s*o\.?\s*o\.?|s\.a\.s\.?|s\.a\.?|b\.v\.?|gmbh|inc\.?|llc\.?|ltd\.?|limited|co\.?|corp\.?|sas|sa|bv|plc)\s*$/i;

/**
 * Advertiser name without legal-form suffixes: "BLG INC" -> "BLG", "Acme GmbH & Co. KG" -> "Acme".
 * Returns the trimmed input when nothing (or everything) would be stripped.
 * @param {string} name
 * @returns {string}
 */
export function cleanAdvertiserName(name) {
  const orig = String(name || '').replace(/\s+/g, ' ').trim();
  let s = orig;
  for (let i = 0; i < 4; i++) {
    const next = s.replace(LEGAL_SUFFIX_RE, '').replace(/[\s,.-]+$/, '').trim();
    if (next === s) break;
    s = next;
  }
  return s.length >= 2 ? s : orig;
}

/**
 * Advertiser names to seed the name-based platforms (TikTok, LinkedIn, Bing, Snap): names of the
 * 'primary' advertisers with confirmed ads in the given results (Google, Meta), each followed by
 * its cleaned variant. Ordered by confirmed ads desc, deduped case-insensitively, max `max`.
 * @param {PlatformResult[]} results
 * @param {{max?:number}} [opts]
 * @returns {string[]}
 */
export function advertiserNameSeeds(results, { max = 5 } = {}) {
  const advs = [];
  for (const r of results || []) {
    if (!r || !Array.isArray(r.advertisers)) continue;
    for (const a of r.advertisers) {
      if (!a || !a.name || !(Number(a.confirmedCount) > 0)) continue;
      if (a.role && a.role !== 'primary') continue;
      advs.push(a);
    }
  }
  advs.sort((a, b) => (Number(b.confirmedCount) || 0) - (Number(a.confirmedCount) || 0));
  const out = [];
  const seen = new Set();
  const add = (n) => {
    const s = String(n || '').replace(/\s+/g, ' ').trim();
    if (!s || seen.has(s.toLowerCase()) || out.length >= max) return;
    seen.add(s.toLowerCase());
    out.push(s);
  };
  for (const a of advs) {
    add(a.name);
    add(cleanAdvertiserName(a.name));
  }
  return out;
}

/**
 * Query list: the brand first, then up to `max` extra names, deduped case-insensitively.
 * @param {string} brand
 * @param {string[]} names
 * @param {number} max
 * @returns {string[]}
 */
export function nameQueries(brand, names, max) {
  const out = [];
  const seen = new Set();
  const add = (n, limit) => {
    const s = String(n || '').trim();
    if (!s || seen.has(s.toLowerCase()) || out.length >= limit) return;
    seen.add(s.toLowerCase());
    out.push(s);
  };
  add(brand, 1);
  const limit = out.length + Math.max(0, Number(max) || 0);
  for (const n of Array.isArray(names) ? names : []) add(n, limit);
  return out;
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
 * Sorted by confirmedCount desc, then adCount desc; roles set by assignRoles().
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
  return assignRoles(out);
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
