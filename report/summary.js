// Data shaping for the full report and the social graphic. Pure, no DOM, no chrome.* (tested
// under Node). Input is a stored scan: {domain, at, tags, seeds, results, manual} (see lastScan in
// background/scan.js). Only data present in the scan is used; a missing fact is left out.

import { placementsText } from '../sidepanel/view.js';
import { labels, formatDate, formatName } from './labels.js';

export const MATCH_ORDER = ['confirmed', 'advertiser', 'keyword', 'name'];

/** Short platform names (no logos anywhere, text labels only). */
export const PLATFORM_NAMES = {
  google: 'Google / YouTube',
  meta: 'Meta',
  tiktok: 'TikTok',
  linkedin: 'LinkedIn',
  bing: 'Microsoft Bing',
  snap: 'Snapchat',
};

/** Neutral dot colors per platform, used as small markers only. */
export const PLATFORM_COLORS = {
  google: '#34a853',
  meta: '#3b82f6',
  tiktok: '#ec4899',
  linkedin: '#0ea5e9',
  bing: '#14b8a6',
  snap: '#eab308',
};
const FALLBACK_COLOR = '#a1a1aa';

export const TAG_CATEGORY_ORDER = ['ads', 'analytics', 'tag-manager', 'session', 'crm', 'other'];
export const TAG_CATEGORY_LABELS = {
  ads: 'Ads',
  analytics: 'Analytics',
  'tag-manager': 'Tag managers',
  session: 'Session recording',
  crm: 'CRM / email',
  other: 'Other',
};

/** Detected as 'analytics' by detect/signatures.js but shown as session recording tools. */
const SESSION_RECORDING = new Set(['Microsoft Clarity', 'Hotjar']);

/** Compact chip names for the graphic. */
const TAG_SHORT_NAMES = {
  'Google Analytics 4': 'GA4',
  'Universal Analytics': 'UA',
  'Google Tag Manager': 'GTM',
  'X (Twitter) Pixel': 'X Pixel',
  'Microsoft Clarity': 'Clarity',
  'Google Floodlight': 'Floodlight',
};

/** Matches that tie an ad to the scanned domain's owner (used for top advertisers). */
const OWNED_MATCHES = new Set(['confirmed', 'advertiser']);

function arr(v) {
  return Array.isArray(v) ? v.filter((x) => x && typeof x === 'object') : [];
}

/** True when the value looks like a stored scan. */
export function hasScan(data) {
  return !!(data && typeof data === 'object' && data.domain);
}

/**
 * Ads visible under the "Only confirmed" toggle (same semantics as the side panel).
 * @param {object[]} ads
 * @param {boolean} onlyConfirmed
 */
export function visibleAds(ads, onlyConfirmed) {
  const list = arr(ads);
  return onlyConfirmed ? list.filter((a) => a.match === 'confirmed') : list;
}

/** @param {string} id */
export function platformName(id, fallback) {
  return PLATFORM_NAMES[id] || fallback || id || '';
}

/** @param {string} id */
export function platformColor(id) {
  return PLATFORM_COLORS[id] || FALLBACK_COLOR;
}

/**
 * Per platform ad counts split by match label, sorted by visible ads desc (ties keep scan order).
 * @param {object} data scan
 * @param {{onlyConfirmed?:boolean}} [opts]
 * @returns {{platform:string, name:string, color:string, status:string, coverage:string,
 *   total:number, byMatch:{confirmed:number, advertiser:number, keyword:number, name:number}}[]}
 */
export function adStack(data, { onlyConfirmed = false } = {}) {
  const out = [];
  for (const r of arr(data && data.results)) {
    if (!r.platform) continue;
    const byMatch = { confirmed: 0, advertiser: 0, keyword: 0, name: 0 };
    const ads = visibleAds(r.ads, onlyConfirmed);
    for (const ad of ads) {
      const k = MATCH_ORDER.includes(ad.match) ? ad.match : 'keyword';
      byMatch[k]++;
    }
    out.push({
      platform: r.platform,
      name: platformName(r.platform, r.label),
      color: platformColor(r.platform),
      status: r.status || 'ok',
      coverage: r.coverage || '',
      total: ads.length,
      byMatch,
    });
  }
  return out
    .map((p, i) => ({ p, i }))
    .sort((a, b) => b.p.total - a.p.total || a.i - b.i)
    .map((x) => x.p);
}

/**
 * Libraries without automatic search (X, Pinterest, Apple), shown as links.
 * @param {object} data scan
 * @returns {{id:string, label:string, url:string, hint:string}[]}
 */
export function manualPlatforms(data) {
  return arr(data && data.manual)
    .filter((m) => m.url)
    .map((m) => ({ id: m.id || '', label: m.label || m.id || '', url: m.url, hint: m.hint || '' }));
}

/** Category of a tag hit in the report grouping. */
export function tagCategory(hit) {
  if (!hit) return 'other';
  if (SESSION_RECORDING.has(hit.platform)) return 'session';
  return ['ads', 'analytics', 'tag-manager', 'crm'].includes(hit.category) ? hit.category : 'other';
}

/** Short chip name of a tag platform ("Google Analytics 4" -> "GA4"). */
export function tagShortName(platform) {
  const p = String(platform || '').trim();
  return TAG_SHORT_NAMES[p] || p;
}

/**
 * Tags grouped by category in TAG_CATEGORY_ORDER, merging duplicate platforms (ids unioned; source
 * 'page' wins over 'container'). Empty categories are left out.
 * @param {object[]} tags
 * @returns {{category:string, label:string, items:{platform:string, short:string, ids:string[], source:string}[]}[]}
 */
export function tagStack(tags) {
  const groups = new Map();
  for (const hit of arr(tags)) {
    if (!hit.platform) continue;
    const cat = tagCategory(hit);
    if (!groups.has(cat)) groups.set(cat, new Map());
    const items = groups.get(cat);
    const prev = items.get(hit.platform);
    const ids = Array.isArray(hit.ids) ? hit.ids.filter(Boolean).map(String) : [];
    if (prev) {
      for (const id of ids) if (!prev.ids.includes(id)) prev.ids.push(id);
      if (hit.source === 'page') prev.source = 'page';
    } else {
      items.set(hit.platform, { platform: hit.platform, short: tagShortName(hit.platform), ids: [...new Set(ids)], source: hit.source || 'page' });
    }
  }
  const out = [];
  for (const cat of TAG_CATEGORY_ORDER) {
    const items = groups.get(cat);
    if (!items || !items.size) continue;
    out.push({ category: cat, label: TAG_CATEGORY_LABELS[cat], items: [...items.values()] });
  }
  return out;
}

/** Chip names for the graphic, in category order, deduped. */
export function tagChips(tags) {
  const out = [];
  for (const g of tagStack(tags)) {
    for (const item of g.items) if (!out.includes(item.short)) out.push(item.short);
  }
  return out;
}

/**
 * KPI row numbers. totalAds / advertisers / platformsWithAds follow the toggle; confirmedAds is
 * always the confirmed count.
 * @param {object} data scan
 * @param {{onlyConfirmed?:boolean}} [opts]
 */
export function kpis(data, { onlyConfirmed = false } = {}) {
  let totalAds = 0;
  let confirmedAds = 0;
  let platformsWithAds = 0;
  const advertisers = new Set();
  for (const r of arr(data && data.results)) {
    const ads = visibleAds(r.ads, onlyConfirmed);
    totalAds += ads.length;
    confirmedAds += arr(r.ads).filter((a) => a.match === 'confirmed').length;
    if (ads.length) platformsWithAds++;
    for (const ad of ads) {
      const key = ad.advertiserId || String(ad.advertiserName || '').trim().toLowerCase();
      if (key) advertisers.add(`${r.platform}|${key}`);
    }
  }
  const tags = new Set(arr(data && data.tags).map((t) => t.platform).filter(Boolean)).size;
  return { totalAds, confirmedAds, advertisers: advertisers.size, platformsWithAds, tags };
}

function countBy(list) {
  const m = new Map();
  for (const k of list) if (k) m.set(k, (m.get(k) || 0) + 1);
  return [...m.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count);
}

/**
 * Facts derived from the data; every field is null / [] when the scan has no data for it.
 * Top advertisers only count ads tied to the domain owner (confirmed / same advertiser), so a
 * competitor bidding on the brand never shows up as the "top advertiser".
 * @param {object} data scan
 * @param {{onlyConfirmed?:boolean}} [opts]
 * @returns {{oldestStart:string|null, newestStart:string|null,
 *   topAdvertisers:{name:string, count:number}[], formats:{key:string, count:number}[],
 *   placements:{key:string, count:number}[], countries:{key:string, count:number}[]}}
 */
export function keyFacts(data, { onlyConfirmed = false } = {}) {
  const ads = [];
  const countries = [];
  for (const r of arr(data && data.results)) {
    for (const ad of visibleAds(r.ads, onlyConfirmed)) ads.push({ ...ad, platform: ad.platform || r.platform });
    for (const a of arr(r.advertisers)) {
      if (onlyConfirmed && !(Number(a.confirmedCount) > 0)) continue;
      if (a.role === 'mention') continue;
      const c = String(a.country || '').trim().toUpperCase();
      if (/^[A-Z]{2}$/.test(c)) countries.push(c);
    }
  }
  const starts = ads
    .map((a) => (typeof a.firstShown === 'string' && /^\d{4}-\d{2}-\d{2}/.test(a.firstShown) ? a.firstShown.slice(0, 10) : null))
    .filter(Boolean)
    .sort();
  const names = ads
    .filter((a) => OWNED_MATCHES.has(a.match))
    .map((a) => String(a.advertiserName || '').replace(/\s+/g, ' ').trim());
  const formats = ads
    .map((a) => String(a.format || '').trim().toLowerCase())
    .filter((f) => f && f !== 'unknown');
  const placements = [];
  for (const ad of ads) {
    const t = placementsText(ad);
    if (t) placements.push(...t.split(', '));
  }
  return {
    oldestStart: starts.length ? starts[0] : null,
    newestStart: starts.length ? starts[starts.length - 1] : null,
    topAdvertisers: countBy(names).slice(0, 5).map((x) => ({ name: x.key, count: x.count })),
    formats: countBy(formats),
    placements: countBy(placements),
    countries: countBy(countries),
  };
}

/**
 * Everything the report page renders.
 * @param {object} data scan
 * @param {{onlyConfirmed?:boolean}} [opts]
 */
export function buildSummary(data, opts = {}) {
  if (!hasScan(data)) return null;
  return {
    domain: String(data.domain),
    at: data.at || '',
    kpis: kpis(data, opts),
    adStack: adStack(data, opts),
    manual: manualPlatforms(data),
    tagStack: tagStack(data.tags),
    tagChips: tagChips(data.tags),
    facts: keyFacts(data, opts),
  };
}

/**
 * Fact lines for the graphic, most interesting first; only facts with data.
 * @param {ReturnType<typeof keyFacts>} facts
 * @param {string} lang
 * @returns {string[]}
 */
export function factLines(facts, lang) {
  if (!facts) return [];
  const L = labels(lang);
  const out = [];
  if (facts.oldestStart) out.push(L.factOldest(formatDate(facts.oldestStart, lang)));
  const top = facts.topAdvertisers && facts.topAdvertisers[0];
  if (top && top.name) out.push(L.factTopAdvertiser(top.name, top.count));
  if (facts.formats && facts.formats.length) {
    out.push(L.factFormats(facts.formats.slice(0, 3).map((f) => formatName(f.key, lang)).join(', ')));
  }
  if (facts.placements && facts.placements.length) {
    out.push(L.factPlacements(facts.placements.slice(0, 4).map((p) => p.key).join(', ')));
  }
  if (facts.countries && facts.countries.length) {
    out.push(L.factCountries(facts.countries.slice(0, 5).map((c) => c.key).join(', ')));
  }
  if (facts.newestStart && facts.newestStart !== facts.oldestStart) {
    out.push(L.factNewest(formatDate(facts.newestStart, lang)));
  }
  return out;
}

/**
 * Text content of the social graphic (layout and drawing are separate).
 * @param {object} data scan
 * @param {{lang?:string, onlyConfirmed?:boolean}} [opts]
 */
export function graphicModel(data, { lang = 'en', onlyConfirmed = false } = {}) {
  if (!hasScan(data)) return null;
  const L = labels(lang);
  const k = kpis(data, { onlyConfirmed });
  const hero = onlyConfirmed ? k.confirmedAds : k.totalAds;
  const bars = adStack(data, { onlyConfirmed })
    .filter((p) => p.total > 0)
    .map((p) => ({ platform: p.platform, name: p.name, color: p.color, value: p.total, confirmed: p.byMatch.confirmed }));
  return {
    lang,
    onlyConfirmed,
    title: String(data.domain),
    subtitle: L.subtitle,
    hero,
    heroLabel: onlyConfirmed ? L.heroConfirmed(hero) : L.heroTotal(hero),
    heroSub: !onlyConfirmed && hero > 0 ? L.heroSub(k.confirmedAds) : '',
    barsTitle: L.barsTitle,
    legendConfirmed: L.legendConfirmed,
    legendOther: onlyConfirmed ? '' : L.legendOther,
    noAds: L.noAds,
    bars,
    tagsTitle: L.tagsTitle,
    noTags: L.noTags,
    chips: tagChips(data.tags),
    facts: factLines(keyFacts(data, { onlyConfirmed }), lang),
    footerBrand: 'Superpixel',
    footerDate: data.at ? L.scanned(formatDate(data.at, lang)) : '',
    more: L.more,
  };
}
