// Pure display helpers for the side panel (no DOM, tested under Node).

export const STATUS_LABELS = {
  ok: 'OK',
  empty: 'No ads',
  error: 'Error',
  rate_limited: 'Rate limited',
  needs_user: 'Needs you',
  changed: 'Changed',
  skipped: 'Skipped',
  running: 'Running',
};

export const MATCH_LABELS = {
  confirmed: 'Links to domain',
  advertiser: 'Same advertiser',
  keyword: 'Mentions',
  name: 'Name match',
};

export const MATCH_HINTS = {
  confirmed: 'The ad links to the scanned domain',
  advertiser: 'Another ad of this advertiser links to the scanned domain',
  keyword: 'The ad mentions the brand or domain but links elsewhere',
  name: 'Found by advertiser name only, the landing page is unknown',
};

/** Platforms whose ads run on several placements worth listing (Google: Search / YouTube, Meta: Facebook / Instagram / ...). */
const MULTI_PLACEMENT_PLATFORMS = new Set(['google', 'meta']);
const PLACEMENT_NAMES = { youtube: 'YouTube', audience_network: 'Audience Network', whatsapp: 'WhatsApp' };

/**
 * Status chip text. ok: "N confirmed", or "N ads" when none is confirmed; empty: "No ads".
 * Never "None" for a card that has ads.
 * @param {{status?:string, ads?:{match?:string}[]}} result
 * @returns {string}
 */
export function statusChipText(result) {
  const r = result || {};
  const status = r.status || 'ok';
  const ads = Array.isArray(r.ads) ? r.ads.filter(Boolean) : [];
  if (status === 'ok') {
    const confirmed = ads.filter((a) => a.match === 'confirmed').length;
    if (confirmed) return `${confirmed} confirmed`;
    if (ads.length) return ads.length === 1 ? '1 ad' : `${ads.length} ads`;
    return STATUS_LABELS.empty;
  }
  return STATUS_LABELS[status] || status;
}

/** @param {string} match @returns {string} */
export function matchLabel(match) {
  return MATCH_LABELS[match] || MATCH_LABELS.keyword;
}

/** Ad format as a short label, '' when unknown. */
export function formatLabel(ad) {
  return String((ad && ad.format) || '').trim();
}

function placementName(p) {
  const k = String(p || '').trim().toLowerCase();
  if (!k) return '';
  if (PLACEMENT_NAMES[k]) return PLACEMENT_NAMES[k];
  return k.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Placements worth showing: only on multi-placement platforms, never the platform's own name.
 * @param {{platform?:string, placements?:string[]}} ad
 * @returns {string} e.g. "Facebook, Instagram", or ''
 */
export function placementsText(ad) {
  if (!ad || !MULTI_PLACEMENT_PLATFORMS.has(ad.platform)) return '';
  const own = String(ad.platform).toLowerCase();
  const out = [];
  for (const p of Array.isArray(ad.placements) ? ad.placements : []) {
    if (String(p || '').trim().toLowerCase() === own) continue;
    const name = placementName(p);
    if (name && !out.includes(name)) out.push(name);
  }
  return out.join(', ');
}

/** Max deep links shown in the card header; more go into a list in the card body. */
export const MAX_HEADER_LINKS = 2;

function shorten(s, max = 16) {
  const t = String(s || '').replace(/["“”]/g, '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}...` : t;
}

/**
 * Short visible text for a deep link from its full label:
 * "YouTube ads" -> "YouTube", "Meta Ad Library (domain)" -> "Domain",
 * 'Meta Ad Library ("Acme")' -> "Acme", "LinkedIn ads of Acme" -> "Acme", else "Library".
 * @param {string} label
 * @returns {string}
 */
export function deepLinkShortLabel(label) {
  const s = String(label || '');
  if (/youtube/i.test(s)) return 'YouTube';
  const paren = /\(([^)]+)\)\s*$/.exec(s);
  if (paren) {
    const inner = shorten(paren[1]);
    return inner ? inner.charAt(0).toUpperCase() + inner.slice(1) : 'Library';
  }
  const of = /\bads of\s+(.+)$/i.exec(s);
  if (of) return shorten(of[1]) || 'Library';
  return 'Library';
}

/**
 * Header links: [{label, url, short}] with distinct short labels ("Library", "Library 2"), or
 * null when there are more than MAX_HEADER_LINKS links (render them as a list in the body).
 * @param {{label:string,url:string}[]} links
 */
export function headerDeepLinks(links) {
  const list = (Array.isArray(links) ? links : []).filter((l) => l && l.url);
  if (list.length > MAX_HEADER_LINKS) return null;
  const used = new Map();
  return list.map((l) => {
    const base = deepLinkShortLabel(l.label);
    const n = (used.get(base) || 0) + 1;
    used.set(base, n);
    return { label: l.label || base, url: l.url, short: n > 1 ? `${base} ${n}` : base };
  });
}
