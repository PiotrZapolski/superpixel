// Layer A: tag detection + brand/social seed extraction (spec 3.5).
// Pure functions only (no chrome.*), so they run in Node tests too.

import { SIGNATURES, CATEGORY_ORDER, GOOGLE_KEY_ROUTES, GLOBAL_ID_FORMATS } from './signatures.js';
import { normalizeDomain, domainLabel } from '../lib/domain.js';
import { decodeEntities, attrValues, extractHrefs } from '../lib/html.js';

export const HTML_LIMIT = 1.5 * 1024 * 1024;
const MAX_URLS = 3000;
const MAX_EVIDENCE = 3;

// Compiled global copies of the signature regexes (built once, lazily).
const compiled = new WeakMap();
function globalRe(re) {
  let g = compiled.get(re);
  if (!g) {
    g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
    compiled.set(re, g);
  }
  g.lastIndex = 0;
  return g;
}

function urlEvidence(u) {
  try {
    const x = new URL(u);
    return (x.host + x.pathname).slice(0, 80);
  } catch {
    return String(u).slice(0, 80);
  }
}

/** Split html into <script> blocks and the remaining markup. */
export function splitHtml(html) {
  const scripts = [];
  const rest = html.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, (m) => {
    scripts.push(m);
    return ' ';
  });
  return { scripts, rest };
}

function collectUrls(resourceUrls, html) {
  const out = [];
  const seen = new Set();
  const add = (u) => {
    if (typeof u !== 'string' || !u || out.length >= MAX_URLS) return;
    let v = u.trim();
    if (v.startsWith('//')) v = 'https:' + v;
    if (!/^https?:\/\//i.test(v) || seen.has(v)) return;
    seen.add(v);
    out.push(v);
  };
  for (const u of Array.isArray(resourceUrls) ? resourceUrls : []) add(u);
  if (html) {
    // HTML-only fallback: script and img sources behave like resource urls.
    for (const tag of ['script', 'img', 'iframe']) {
      let vals = [];
      try {
        vals = attrValues(html, tag, 'src') || [];
      } catch {
        vals = [];
      }
      for (const v of vals) add(typeof v === 'string' ? decodeEntities(v) : v);
    }
  }
  return out;
}

function getHit(hits, sig) {
  let h = hits.get(sig.platform);
  if (!h) {
    h = { platform: sig.platform, category: sig.category, ids: [], evidence: [] };
    hits.set(sig.platform, h);
  }
  return h;
}

function addId(hit, id) {
  if (id == null) return;
  const v = String(id).trim();
  if (v && !hit.ids.includes(v)) hit.ids.push(v);
}

function addEvidence(hit, ev) {
  if (ev && hit.evidence.length < MAX_EVIDENCE && !hit.evidence.includes(ev)) hit.evidence.push(ev);
}

function applyPattern(hits, sig, p, text, evidence) {
  const g = globalRe(p.re);
  let m;
  let matched = false;
  while ((m = g.exec(text)) !== null) {
    if (m[0] === '') {
      g.lastIndex++;
      continue;
    }
    matched = true;
    const hit = getHit(hits, sig);
    if (p.idGroup !== undefined && m[p.idGroup]) {
      const raw = m[p.idGroup];
      addId(hit, p.fmt ? p.fmt(raw) : raw);
    }
    addEvidence(hit, evidence);
    if (p.idGroup === undefined) break; // presence only: one match is enough
  }
  return matched;
}

const GLOBAL_EVIDENCE = {
  fbPixelIds: 'window.fbq',
  ttqIds: 'window.ttq',
  linkedinPartnerIds: 'window._linkedin_partner_id',
  hotjarId: 'window._hjSettings',
  adroll: 'window.adroll_adv_id',
};

function asList(v) {
  if (v == null) return [];
  if (Array.isArray(v)) return v;
  if (typeof v === 'object') return Object.values(v);
  return [v];
}

/**
 * @param {{resourceUrls?:string[], html?:string, globals?:object}} input
 * @returns {{platform:string, category:string, ids:string[], evidence:string[]}[]}
 */
export function detectTags({ resourceUrls = [], html = '', globals = {} } = {}) {
  const page = typeof html === 'string' ? html.slice(0, HTML_LIMIT) : '';
  const g = globals && typeof globals === 'object' ? globals : {};
  const urls = collectUrls(resourceUrls, page);
  const { scripts, rest } = splitHtml(page);
  const blocks = scripts.map((text) => ({ text, isScript: true }));
  if (rest.trim()) blocks.push({ text: rest, isScript: false });

  const hits = new Map();

  for (const sig of SIGNATURES) {
    for (const p of sig.patterns) {
      if (p.where === 'url' || p.where === 'any') {
        for (const u of urls) {
          if (p.context && !p.context.test(u)) continue;
          applyPattern(hits, sig, p, u, urlEvidence(u));
        }
      }
      if (p.where === 'html' || p.where === 'any') {
        for (const b of blocks) {
          if (p.context && (!b.isScript || !p.context.test(b.text))) continue;
          applyPattern(hits, sig, p, b.text, b.isScript ? 'inline script' : 'page html');
        }
      }
    }
  }

  // Google container keys (window.google_tag_manager).
  for (const key of asList(g.googleTagManagerKeys)) {
    const k = String(key || '').trim();
    const route = GOOGLE_KEY_ROUTES.find((r) => r.re.test(k));
    if (!route) continue;
    const sig = SIGNATURES.find((s) => s.platform === route.platform);
    if (!sig) continue;
    const hit = getHit(hits, sig);
    addId(hit, k);
    addEvidence(hit, 'window.google_tag_manager');
  }

  // Id-bearing globals declared on signatures.
  for (const sig of SIGNATURES) {
    if (!sig.idGlobal) continue;
    const fmt = GLOBAL_ID_FORMATS[sig.idGlobal];
    const ids = asList(g[sig.idGlobal])
      .map((v) => (v == null ? '' : String(v).trim()))
      .filter((v) => v && (!fmt || fmt.test(v)));
    if (!ids.length) continue;
    const hit = getHit(hits, sig);
    for (const id of ids) addId(hit, id);
    addEvidence(hit, GLOBAL_EVIDENCE[sig.idGlobal] || 'window.' + sig.idGlobal);
  }

  // Presence-only globals: only when nothing else found the platform.
  const present = g.present && typeof g.present === 'object' ? g.present : {};
  for (const sig of SIGNATURES) {
    if (hits.has(sig.platform)) continue;
    const name = (sig.globals || []).find((n) => present[n]);
    if (!name) continue;
    const hit = getHit(hits, sig);
    addEvidence(hit, 'window.' + name);
  }

  const catIndex = (c) => {
    const i = CATEGORY_ORDER.indexOf(c);
    return i === -1 ? CATEGORY_ORDER.length : i;
  };
  return [...hits.values()].sort(
    (a, b) => catIndex(a.category) - catIndex(b.category) || a.platform.localeCompare(b.platform)
  );
}

// ------------------------------------------------------------------ seeds

const ORG_TYPES = /^(Organization|Corporation|OnlineStore|OnlineBusiness|LocalBusiness|Store|Brand|NewsMediaOrganization|EducationalOrganization|SportsOrganization|NGO|Airline)$/i;
const SITE_TYPES = /^WebSite$/i;

function typesOf(node) {
  const t = node && node['@type'];
  return (Array.isArray(t) ? t : [t]).filter((x) => typeof x === 'string');
}

function parseJsonLdText(text) {
  if (typeof text !== 'string') return null;
  const t = text
    .trim()
    .replace(/^<!\[CDATA\[/, '')
    .replace(/\]\]>$/, '')
    .replace(/^<!--/, '')
    .replace(/-->$/, '')
    .trim();
  if (!t) return null;
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
}

/** Top-level JSON-LD nodes (flattening arrays and @graph), never deep product/brand nesting. */
function jsonLdNodes(docs) {
  const out = [];
  const push = (n, depth) => {
    if (!n || typeof n !== 'object' || depth > 3) return;
    if (Array.isArray(n)) {
      for (const x of n) push(x, depth + 1);
      return;
    }
    out.push(n);
    if (Array.isArray(n['@graph'])) for (const x of n['@graph']) push(x, depth + 1);
    else if (n['@graph'] && typeof n['@graph'] === 'object') push(n['@graph'], depth + 1);
  };
  for (const d of docs) push(d, 0);
  return out;
}

function nameOf(node) {
  const n = node && node.name;
  if (typeof n === 'string') return n;
  if (Array.isArray(n) && typeof n[0] === 'string') return n[0];
  if (n && typeof n === 'object' && typeof n['@value'] === 'string') return n['@value'];
  return '';
}

function metaContent(html, attr, value) {
  // <meta property="og:site_name" content="..."> in either attribute order.
  const esc = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const a = new RegExp(`<meta\\b[^>]*\\b${attr}\\s*=\\s*["']${esc}["'][^>]*>`, 'i').exec(html);
  if (!a) return '';
  const c = /\bcontent\s*=\s*("([^"]*)"|'([^']*)')/i.exec(a[0]);
  return c ? decodeEntities(c[2] !== undefined ? c[2] : c[3] || '') : '';
}

function tokens(s) {
  return String(s || '')
    .toLowerCase()
    .split(/[^a-z0-9\u00c0-\u024f]+/)
    .filter((t) => t.length >= 2);
}

function compact(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9\u00c0-\u024f]+/g, '');
}

function sharesWithLabel(part, label) {
  const lab = compact(label);
  if (!lab) return false;
  const cp = compact(part);
  if (cp.length >= 3 && (cp.includes(lab) || lab.includes(cp))) return true;
  const labTokens = tokens(label);
  return tokens(part).some((t) => t.length >= 3 && (labTokens.includes(t) || lab.includes(t)));
}

function titleCandidate(title, label) {
  if (!title) return '';
  const parts = String(title)
    .split(/\s+-\s+|\s*[|:\u00b7\u2013\u2014]\s*/)
    .map((p) => p.trim())
    .filter((p) => p.length >= 2 && p.length <= 60);
  const matching = parts.filter((p) => sharesWithLabel(p, label));
  if (!matching.length) return '';
  return matching.reduce((a, b) => (b.length < a.length ? b : a));
}

// ---- social links

const SOCIAL_KEYS = ['facebook', 'instagram', 'linkedin', 'tiktok', 'youtube', 'x', 'pinterest'];

const FB_EXCLUDE = new Set([
  'sharer', 'sharer.php', 'share.php', 'share', 'plugins', 'tr', 'dialog', 'login', 'login.php',
  'l.php', 'policies', 'policy.php', 'help', 'privacy', 'legal', 'terms', 'hashtag', 'watch',
  'events', 'groups', 'ads', 'business', 'home.php', 'photo.php', 'story.php', 'permalink.php',
  'signup', 'recover', 'settings', 'v2.0', 'v3.0', 'search',
]);
const IG_EXCLUDE = new Set(['p', 'reel', 'reels', 'explore', 'accounts', 'stories', 'tv', 'share', 'about', 'legal', 'direct']);
const X_EXCLUDE = new Set([
  'intent', 'share', 'home', 'hashtag', 'search', 'i', 'login', 'signup', 'tos', 'privacy',
  'settings', 'explore', 'messages', 'notifications', 'compose',
]);
const PIN_EXCLUDE = new Set(['pin', 'search', 'ideas', '_', 'business', 'today', 'login', 'about', 'settings', 'categories']);

function hostIs(host, base) {
  return host === base || host.endsWith('.' + base);
}

/** Map one href to [key, canonicalUrl] or null. */
function socialOf(href) {
  let u;
  try {
    let h = String(href || '').trim();
    if (h.startsWith('//')) h = 'https:' + h;
    if (!/^https?:\/\//i.test(h)) return null;
    u = new URL(h);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  const segs = u.pathname.split('/').filter(Boolean);
  const first = (segs[0] || '').toLowerCase();

  if (hostIs(host, 'facebook.com') || hostIs(host, 'fb.com')) {
    if (!segs.length) return null;
    if (first === 'profile.php') {
      const id = u.searchParams.get('id');
      return id && /^\d+$/.test(id) ? ['facebook', `https://www.facebook.com/profile.php?id=${id}`] : null;
    }
    if (FB_EXCLUDE.has(first)) return null;
    if (first === 'pages' && segs.length >= 2) {
      return ['facebook', 'https://www.facebook.com/' + segs.slice(0, 3).join('/')];
    }
    if (!/^[A-Za-z0-9.\-_]{2,80}$/.test(segs[0])) return null;
    return ['facebook', 'https://www.facebook.com/' + segs[0]];
  }
  if (hostIs(host, 'instagram.com')) {
    if (!segs.length || IG_EXCLUDE.has(first) || !/^[A-Za-z0-9_.]{1,30}$/.test(segs[0])) return null;
    return ['instagram', 'https://www.instagram.com/' + segs[0]];
  }
  if (hostIs(host, 'linkedin.com')) {
    if ((first === 'company' || first === 'showcase') && segs[1]) {
      return ['linkedin', `https://www.linkedin.com/${first}/${segs[1]}`];
    }
    return null;
  }
  if (hostIs(host, 'tiktok.com')) {
    if (/^@[A-Za-z0-9_.]{2,30}$/.test(segs[0] || '')) return ['tiktok', 'https://www.tiktok.com/' + segs[0]];
    return null;
  }
  if (hostIs(host, 'youtube.com')) {
    if (/^@[^/?#]{2,}$/.test(segs[0] || '')) return ['youtube', 'https://www.youtube.com/' + segs[0]];
    if (['channel', 'c', 'user'].includes(first) && segs[1]) {
      return ['youtube', `https://www.youtube.com/${first}/${segs[1]}`];
    }
    return null;
  }
  if (hostIs(host, 'x.com') || hostIs(host, 'twitter.com')) {
    if (!segs.length || X_EXCLUDE.has(first) || !/^[A-Za-z0-9_]{1,15}$/.test(segs[0])) return null;
    return ['x', 'https://x.com/' + segs[0]];
  }
  if (/(^|\.)pinterest\.[a-z]{2,3}(\.[a-z]{2})?$/.test(host)) {
    if (!segs.length || PIN_EXCLUDE.has(first) || !/^[A-Za-z0-9_]{3,30}$/.test(segs[0])) return null;
    return ['pinterest', 'https://www.pinterest.com/' + segs[0] + '/'];
  }
  return null;
}

function collectJsonLd(html, meta) {
  const texts = [];
  if (html) {
    const re = /<script\b[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script\s*>/gi;
    let m;
    while ((m = re.exec(html)) !== null) texts.push(m[1]);
  }
  for (const t of asList(meta && meta.jsonLd)) if (typeof t === 'string') texts.push(t);
  const docs = [];
  for (const t of texts) {
    const d = parseJsonLdText(t);
    if (d) docs.push(d);
  }
  return jsonLdNodes(docs);
}

/**
 * @returns {{domain:string, brand:string, brandCandidates:string[],
 *   social:Object<string,string[]>, ids:Object<string,string[]>}}
 */
export function extractSeeds({ domain, html = '', title = '', meta = {}, tags = [] } = {}) {
  const page = typeof html === 'string' ? html.slice(0, HTML_LIMIT) : '';
  const m = meta && typeof meta === 'object' ? meta : {};
  let d = '';
  try {
    d = normalizeDomain(domain) || '';
  } catch {
    d = '';
  }
  if (!d) d = String(domain || '').trim().toLowerCase();
  let label = '';
  try {
    label = domainLabel(d) || '';
  } catch {
    label = '';
  }
  if (!label) label = d.replace(/^www\./, '').split('.')[0] || '';

  const nodes = collectJsonLd(page, m);
  const orgNames = [];
  const siteNames = [];
  const sameAs = [];
  for (const n of nodes) {
    const types = typesOf(n);
    const name = nameOf(n);
    if (types.some((t) => ORG_TYPES.test(t))) {
      if (name) orgNames.push(name);
      for (const s of asList(n.sameAs)) if (typeof s === 'string') sameAs.push(s);
    } else if (types.some((t) => SITE_TYPES.test(t))) {
      if (name) siteNames.push(name);
      const pub = n.publisher;
      if (pub && typeof pub === 'object' && !Array.isArray(pub)) {
        for (const s of asList(pub.sameAs)) if (typeof s === 'string') sameAs.push(s);
      }
    }
  }

  let pageTitle = typeof title === 'string' ? title : '';
  if (!pageTitle && page) {
    const t = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(page);
    if (t) pageTitle = t[1];
  }
  pageTitle = decodeEntities(pageTitle.replace(/\s+/g, ' ').trim());

  const ogSiteName = m.ogSiteName || (page ? metaContent(page, 'property', 'og:site_name') : '');
  const appName = m.applicationName || (page ? metaContent(page, 'name', 'application-name') : '');

  const raw = [
    ...orgNames,
    ...siteNames,
    ogSiteName,
    appName,
    titleCandidate(pageTitle, label),
    label,
  ];
  const brandCandidates = [];
  const seenLower = new Set();
  for (const r of raw) {
    if (typeof r !== 'string') continue;
    const v = decodeEntities(r).replace(/\s+/g, ' ').trim();
    if (!v || v.length > 80) continue;
    const k = v.toLowerCase();
    if (seenLower.has(k)) continue;
    seenLower.add(k);
    brandCandidates.push(v);
  }

  // Social links from anchors + JSON-LD sameAs.
  const social = {};
  for (const k of SOCIAL_KEYS) social[k] = [];
  let hrefs = [];
  try {
    hrefs = (extractHrefs(page) || []).map((h) => (typeof h === 'string' ? h : h && h.href));
  } catch {
    hrefs = [];
  }
  const seenSocial = new Set();
  for (const h of [...sameAs, ...hrefs]) {
    if (typeof h !== 'string') continue;
    const hit = socialOf(decodeEntities(h));
    if (!hit) continue;
    const [key, url] = hit;
    const dk = key + '|' + url.toLowerCase();
    if (seenSocial.has(dk) || social[key].length >= 5) continue;
    seenSocial.add(dk);
    social[key].push(url);
  }

  const ids = {};
  for (const t of Array.isArray(tags) ? tags : []) {
    if (t && t.platform && Array.isArray(t.ids) && t.ids.length) ids[t.platform] = [...t.ids];
  }

  return { domain: d, brand: brandCandidates[0] || label || d, brandCandidates, social, ids };
}
