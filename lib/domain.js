// Domain helpers. Pure functions, no chrome.* usage (tested under Node).

const MULTI_PART_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'com.au', 'net.au', 'org.au', 'co.nz', 'co.jp', 'ne.jp',
  'com.br', 'com.mx', 'com.ar', 'com.tr', 'com.pl', 'net.pl', 'org.pl', 'co.za', 'com.cn',
  'com.hk', 'com.sg', 'com.my', 'co.in', 'co.id', 'co.kr', 'com.tw', 'com.ua', 'co.il', 'com.co',
  'com.pe', 'com.vn', 'com.ph', 'com.sa', 'com.eg', 'co.th',
]);

const HOSTNAME_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;
const IPV4_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/;

function stripWww(host) {
  return host.replace(/^www\./, '');
}

/**
 * Normalize user input into a bare hostname: "https://www.Example.co.uk/path?x" -> "example.co.uk".
 * Returns '' when the result is not a plausible hostname.
 * @param {string} input
 * @returns {string}
 */
export function normalizeDomain(input) {
  if (input == null) return '';
  let s = String(input).trim().toLowerCase();
  if (!s) return '';
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  s = s.replace(/^\/\//, '');
  s = s.split(/[/?#\\]/)[0];
  const at = s.lastIndexOf('@');
  if (at !== -1) s = s.slice(at + 1);
  s = s.replace(/:\d*$/, '');
  s = s.replace(/\.+$/, '');
  s = stripWww(s);
  if (!HOSTNAME_RE.test(s)) return '';
  return s;
}

/**
 * Hostname of a URL (or protocol-less "example.com/x"), lowercased, without leading "www.".
 * @param {string} url
 * @returns {string}
 */
export function hostOf(url) {
  if (url == null) return '';
  let s = String(url).trim();
  if (!s) return '';
  if (s.startsWith('//')) s = 'https:' + s;
  else if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = 'https://' + s;
  try {
    const h = new URL(s).hostname.toLowerCase().replace(/\.+$/, '');
    return stripWww(h);
  } catch {
    return '';
  }
}

function toHost(hostOrUrl) {
  if (hostOrUrl == null) return '';
  const s = String(hostOrUrl).trim().toLowerCase();
  if (!s) return '';
  if (/[/:?#@]/.test(s)) return hostOf(s);
  return stripWww(s.replace(/\.+$/, ''));
}

/**
 * eTLD+1 using a small built-in list of multi-part suffixes.
 * @param {string} host
 * @returns {string}
 */
export function registrableDomain(host) {
  const h = toHost(host);
  if (!h) return '';
  if (IPV4_RE.test(h) || h.includes(':')) return h;
  const labels = h.split('.').filter(Boolean);
  if (labels.length <= 2) return labels.join('.');
  const lastTwo = labels.slice(-2).join('.');
  if (MULTI_PART_SUFFIXES.has(lastTwo)) return labels.slice(-3).join('.');
  return lastTwo;
}

/**
 * Registrable domain without its public suffix: "shop.decathlon.co.uk" -> "decathlon".
 * @param {string} host
 * @returns {string}
 */
export function domainLabel(host) {
  const rd = registrableDomain(host);
  if (!rd || IPV4_RE.test(rd)) return '';
  const labels = rd.split('.');
  if (labels.length < 2) return '';
  const lastTwo = labels.slice(-2).join('.');
  const rest = MULTI_PART_SUFFIXES.has(lastTwo) && labels.length >= 3 ? labels.slice(0, -2) : labels.slice(0, -1);
  return rest.length ? rest[rest.length - 1] : '';
}

/**
 * True when urlOrHost is on the same registrable domain as `domain` (subdomains included).
 * With siblingTlds (off by default: outrank.ie is not outrank.so), also true for the same label on another TLD.
 * @param {string} urlOrHost
 * @param {string} domain
 * @param {{siblingTlds?:boolean}} [opts]
 * @returns {boolean}
 */
export function hostMatches(urlOrHost, domain, { siblingTlds = false } = {}) {
  const h = toHost(urlOrHost);
  const d = normalizeDomain(domain) || toHost(domain);
  if (!h || !d) return false;
  const rh = registrableDomain(h);
  const rd = registrableDomain(d);
  if (!rh || !rd) return false;
  if (rh === rd) return true;
  if (siblingTlds) {
    const lh = domainLabel(rh);
    const ld = domainLabel(rd);
    if (lh && lh === ld) return true;
  }
  return false;
}

function unwrapOnce(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  const path = u.pathname;
  const isHttp = (v) => typeof v === 'string' && /^https?:\/\//i.test(v);

  if ((host === 'l.facebook.com' || host === 'lm.facebook.com' || /(^|\.)facebook\.com$/.test(host)) && path === '/l.php') {
    const v = u.searchParams.get('u');
    return isHttp(v) ? v : null;
  }
  if (/(^|\.)linkedin\.com$/.test(host) && path.startsWith('/redir/redirect')) {
    const v = u.searchParams.get('url');
    return isHttp(v) ? v : null;
  }
  if (/^(www\.)?google\.[a-z.]+$/.test(host) && path === '/url') {
    const v = u.searchParams.get('q') || u.searchParams.get('url');
    return isHttp(v) ? v : null;
  }
  if (host === 'ad.doubleclick.net' || host.endsWith('.doubleclick.net')) {
    const re = /https?(?::\/\/|%3A%2F%2F)/gi;
    let last = -1;
    let m;
    while ((m = re.exec(url)) !== null) {
      if (m.index > 0) last = m.index;
    }
    if (last > 0) {
      let v = url.slice(last);
      if (/^https?%3A/i.test(v)) {
        try {
          v = decodeURIComponent(v);
        } catch {
          return null;
        }
      }
      return isHttp(v) ? v : null;
    }
    return null;
  }
  return null;
}

/**
 * Unwrap known redirectors (Facebook l.php, LinkedIn redir, Google /url, DoubleClick), up to 3 levels.
 * @param {string} url
 * @returns {string}
 */
export function unwrapRedirect(url) {
  if (typeof url !== 'string' || !url) return url;
  let cur = url;
  try {
    for (let i = 0; i < 3; i++) {
      const next = unwrapOnce(cur);
      if (!next || next === cur) break;
      cur = next;
    }
    return cur;
  } catch {
    return url;
  }
}

const TRACKING_PARAMS = new Set([
  'fbclid', 'gclid', 'gbraid', 'wbraid', 'dclid', 'ttclid', 'msclkid', 'li_fat_id', 'twclid',
  'epik', 'igshid', 'mc_cid', 'mc_eid', '_hsenc', '_hsmi',
]);

/**
 * Remove common tracking parameters (utm_*, click ids).
 * @param {string} url
 * @returns {string}
 */
export function stripTracking(url) {
  if (typeof url !== 'string' || !url) return url;
  try {
    const u = new URL(url);
    const keys = [...new Set([...u.searchParams.keys()])];
    let removed = false;
    for (const k of keys) {
      const lk = k.toLowerCase();
      if (lk.startsWith('utm_') || TRACKING_PARAMS.has(lk)) {
        u.searchParams.delete(k);
        removed = true;
      }
    }
    if (!removed) return url;
    return u.toString();
  } catch {
    return url;
  }
}
