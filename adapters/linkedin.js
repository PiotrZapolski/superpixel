// LinkedIn Ad Library adapter (spec 4.4).
// Search and detail pages work logged-out, so requests use credentials:'omit'. Parsing is
// regex/string based (no DOMParser in the service worker). Cards are anchored on the
// /ad-library/detail/<id> link so class-name churn does not break id extraction.

import { hostMatches, unwrapRedirect } from '../lib/domain.js';
import { sleep, uniq } from '../lib/util.js';
import { decodeEntities, attrValues, firstClassText } from '../lib/html.js';
import { makeAd, makeResult, aggregateAdvertisers, promoteAdvertiserMatches, dedupeAds } from '../lib/model.js';
import { backoff } from '../background/queue.js';

export const meta = { id: 'linkedin', label: 'LinkedIn', coverage: 'Global, last 12 months' };

const ORIGIN = 'https://www.linkedin.com';
const DETAIL_RE = /\/ad-library\/detail\/(\d+)/;
const CARD_OPEN_RE = /<([a-z][a-z0-9]*)\b[^>]*\bclass\s*=\s*["']([^"']*\s)?search-result-item(?=[\s"'])[^"']*["'][^>]*>/gi;
const NOISE_LINE_RE = /^(promoted|sponsored|ad|ads|view details|see more|see less|learn more|show more|image|video|carousel|document|event|message|text ad|spotlight ad|follower ad|\.\.\.|…|see more\.*|…see more)$/i;
const LINKEDIN_HOST_RE = /(^|\.)(linkedin\.com|licdn\.com|lnkd\.in|linkedin\.cn)$/i;
const APP_STORE_HOST_RE = /(^|\.)(play\.google\.com|apps\.apple\.com|itunes\.apple\.com)$/i;

// ---------------------------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------------------------

/**
 * Build a search URL. params: {accountOwner, companyIds, keyword, countries='ALL',
 * dateOption='last-30-days', paginationToken}. With a paginationToken the
 * searchPaginationFragment endpoint is used.
 */
export function buildSearchUrl(params = {}) {
  const p = new URLSearchParams();
  if (params.companyIds) p.set('companyIds', String(params.companyIds));
  if (params.accountOwner) p.set('accountOwner', String(params.accountOwner));
  if (params.keyword) p.set('keyword', String(params.keyword));
  p.set('countries', params.countries || 'ALL');
  p.set('dateOption', params.dateOption || 'last-30-days');
  const path = params.paginationToken ? '/ad-library/searchPaginationFragment' : '/ad-library/search';
  if (params.paginationToken) p.set('paginationToken', String(params.paginationToken));
  return `${ORIGIN}${path}?${p.toString()}`;
}

export function detailUrlFor(id) {
  return `${ORIGIN}/ad-library/detail/${encodeURIComponent(String(id))}`;
}

/** HTML fragment to text lines (tags become line breaks). */
function htmlLines(html) {
  const withBreaks = String(html || '')
    .replace(/<(script|style|template|code)\b[\s\S]*?<\/\1>/gi, '\n')
    .replace(/<!--[\s\S]*?-->/g, '\n')
    .replace(/<[^>]+>/g, '\n');
  return decodeEntities(withBreaks)
    .split(/\n+/)
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter((l) => l.length > 0);
}

function htmlText(html) {
  return htmlLines(html).join(' ').trim();
}

/** Split a search page (or fragment) into card HTML chunks. */
export function splitCards(html) {
  const src = String(html || '');
  const starts = [];
  CARD_OPEN_RE.lastIndex = 0;
  let m;
  while ((m = CARD_OPEN_RE.exec(src)) !== null) starts.push(m.index);
  if (starts.length) {
    return starts
      .map((s, i) => src.slice(s, i + 1 < starts.length ? starts[i + 1] : src.length))
      .filter((c) => DETAIL_RE.test(c));
  }
  // Fallback when the card class changed: one chunk per distinct detail id, starting at the
  // enclosing <li> (or the link itself) and running until the next id.
  const linkRe = /<a\b[^>]*href\s*=\s*["'][^"']*\/ad-library\/detail\/(\d+)[^"']*["'][^>]*>/gi;
  const marks = [];
  let lastId = null;
  while ((m = linkRe.exec(src)) !== null) {
    if (m[1] === lastId) continue;
    lastId = m[1];
    const liStart = src.lastIndexOf('<li', m.index);
    const prevEnd = marks.length ? marks[marks.length - 1] : 0;
    marks.push(liStart >= prevEnd && liStart > -1 && m.index - liStart < 4000 ? liStart : m.index);
  }
  return marks.map((s, i) => src.slice(s, i + 1 < marks.length ? marks[i + 1] : src.length));
}

function imgUrls(html) {
  const out = [];
  for (const attr of ['src', 'data-delayed-url', 'data-src']) {
    let vals = [];
    try { vals = attrValues(html, 'img', attr) || []; } catch { vals = []; }
    for (const v of vals) out.push(decodeEntities(String(v)));
  }
  return out.filter((u) => /^https?:\/\/[^/]*media\.licdn\.com\//i.test(u));
}

/**
 * Parse search result cards.
 * @returns {{id:string, advertiserName:string, text:string, headline:string, imageUrl:string, promotedBy:string}[]}
 */
export function parseLinkedinSearch(html) {
  const out = [];
  const seen = new Set();
  for (const card of splitCards(html)) {
    const idm = DETAIL_RE.exec(card);
    if (!idm || seen.has(idm[1])) continue;
    seen.add(idm[1]);
    const text = firstClassText(card, 'commentary__content');
    const headline = firstClassText(card, 'sponsored-content-headline') || firstClassText(card, 'headline');
    const lines = htmlLines(card).filter((l) => !NOISE_LINE_RE.test(l));
    let promotedBy = '';
    const promotedIdx = lines.findIndex((l) => /^promoted by\b/i.test(l));
    if (promotedIdx >= 0) {
      const inline = lines[promotedIdx].replace(/^promoted by\s*/i, '').trim();
      promotedBy = inline || lines[promotedIdx + 1] || '';
    }
    const nameLine = lines.find((l) => !/^promoted by\b/i.test(l) && l !== text && l !== headline && l.length <= 120) || '';
    const imgs = imgUrls(card);
    const imageUrl = imgs.find((u) => !/company-logo|profile-displayphoto|profile-framedphoto/i.test(u)) || '';
    out.push({ id: idm[1], advertiserName: nameLine, text, headline, imageUrl, promotedBy });
  }
  return out;
}

/** `<code id="paginationMetadata"><!--{json}--></code>` -> {isLastPage, paginationToken} | null */
export function parsePaginationMeta(html) {
  const m = /<code\b[^>]*\bid\s*=\s*["']paginationMetadata["'][^>]*>\s*<!--([\s\S]*?)-->\s*<\/code>/i.exec(String(html || ''));
  if (!m) return null;
  let j;
  try {
    j = JSON.parse(m[1].trim());
  } catch {
    try { j = JSON.parse(decodeEntities(m[1].trim())); } catch { return null; }
  }
  if (!j || typeof j !== 'object') return null;
  return { isLastPage: Boolean(j.isLastPage), paginationToken: j.paginationToken ? String(j.paginationToken) : null };
}

function hostOfUrl(u) {
  try { return new URL(u).hostname.toLowerCase(); } catch { return ''; }
}

/** Parse an ad detail page. @returns {{companyId:string, landingUrl:string, advertiserName:string, paidBy:string}} */
export function parseLinkedinDetail(html) {
  const src = String(html || '');
  const cm = /linkedin\.com\/company\/(\d+)/i.exec(src);
  const companyId = cm ? cm[1] : '';

  let advertiserName = '';
  const nameRe = /<a\b[^>]*href\s*=\s*["'][^"']*linkedin\.com\/company\/[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = nameRe.exec(src)) !== null) {
    const t = htmlText(m[1]);
    if (t && t.length <= 120) { advertiserName = t; break; }
  }

  const redirected = [];
  const direct = [];
  const hrefRe = /\bhref\s*=\s*["']([^"']+)["']/gi;
  while ((m = hrefRe.exec(src)) !== null) {
    const raw = decodeEntities(m[1]).trim();
    if (!/^https?:\/\//i.test(raw)) continue;
    const isRedir = /linkedin\.com\/redir\/redirect/i.test(raw);
    const u = isRedir ? unwrapRedirect(raw) : raw;
    const host = hostOfUrl(u);
    if (!host || LINKEDIN_HOST_RE.test(host)) continue;
    (isRedir ? redirected : direct).push(u);
  }
  const landingUrl = redirected[0] || direct.find((u) => !APP_STORE_HOST_RE.test(hostOfUrl(u))) || direct[0] || '';

  let paidBy = '';
  const lines = htmlLines(src);
  const pi = lines.findIndex((l) => /^paid for by\b/i.test(l));
  if (pi >= 0) paidBy = lines[pi].replace(/^paid for by\s*/i, '').trim() || lines[pi + 1] || '';

  return { companyId, landingUrl, advertiserName, paidBy };
}

export function companyIdsFromSocial(links) {
  const ids = [];
  for (const l of links || []) {
    const m = /linkedin\.com\/company\/(\d+)/i.exec(String(l));
    if (m) ids.push(m[1]);
  }
  return uniq(ids);
}

/** Map a parsed card (+ optional detail) to an Ad. */
export function mapLinkedinAd(card, detail, domain) {
  const d = detail || {};
  const landingUrl = d.landingUrl || '';
  const confirmed = Boolean(landingUrl && domain && hostMatches(landingUrl, domain));
  const name = card.promotedBy || d.advertiserName || card.advertiserName || '';
  return makeAd({
    platform: 'linkedin',
    id: String(card.id),
    advertiserId: d.companyId || name,
    advertiserName: name,
    format: card.imageUrl ? 'image' : 'text',
    title: card.headline || '',
    text: card.text || '',
    landingUrl,
    displayUrl: '',
    firstShown: null,
    lastShown: null,
    isActive: null,
    previewUrl: card.imageUrl || '',
    detailUrl: detailUrlFor(card.id),
    placements: ['linkedin'],
    match: confirmed ? 'confirmed' : 'name',
    source: 'native',
  });
}

export function advertiserUrl(id, name) {
  if (id && /^\d+$/.test(String(id))) return `${ORIGIN}/company/${id}`;
  return buildSearchUrl({ accountOwner: name || '' });
}

export function deepLinks(seeds) {
  const links = [];
  const brand = (seeds && seeds.brand) || '';
  if (brand) links.push({ label: 'LinkedIn Ad Library', url: buildSearchUrl({ accountOwner: brand }) });
  for (const id of companyIdsFromSocial(seeds && seeds.social && seeds.social.linkedin).slice(0, 3)) {
    links.push({ label: `LinkedIn Ad Library (company ${id})`, url: buildSearchUrl({ companyIds: id }) });
  }
  if (!links.length) links.push({ label: 'LinkedIn Ad Library', url: `${ORIGIN}/ad-library/` });
  return links;
}

// ---------------------------------------------------------------------------------------------
// I/O
// ---------------------------------------------------------------------------------------------

function retryDelay(attempt) {
  const v = Number(backoff(attempt));
  return v > 0 ? v : [3000, 10000, 30000][Math.min(attempt, 2)];
}

/** GET text with 429 backoff. Returns {status, text, url} or {rateLimited:true} or {authwall:true}. */
async function getHtml(ctx, url) {
  for (let attempt = 0; ; attempt += 1) {
    if (ctx.throttle) await ctx.throttle();
    const res = await ctx.fetch(url, { credentials: 'omit' });
    const finalUrl = String(res.url || url);
    if (/authwall|\/login|\/uas\/login|\/checkpoint/i.test(finalUrl)) return { authwall: true };
    if (res.status === 429 || res.status === 999) {
      if (attempt >= 3) return { rateLimited: true };
      await sleep(retryDelay(attempt), ctx.signal);
      continue;
    }
    const text = await res.text();
    return { status: res.status, text, url: finalUrl };
  }
}

export async function search(seeds, ctx) {
  const domain = (seeds && seeds.domain) || '';
  const settings = (ctx && ctx.settings) || {};
  const links = deepLinks(seeds);
  const cards = new Map();
  const details = new Map();
  let rateLimited = false;
  let authwall = false;
  let anyRecognized = false;
  let anyResponse = false;
  let httpError = '';
  const progress = (t) => { try { ctx.progress && ctx.progress(t); } catch { /* ignore */ } };

  const finish = (status, message) => {
    // Propagate company ids to cards of the same advertiser name that were not detailed.
    const nameToCompany = new Map();
    for (const [id, d] of details) {
      const c = cards.get(id);
      const name = c && (c.promotedBy || d.advertiserName || c.advertiserName);
      if (d.companyId && name && !nameToCompany.has(name.toLowerCase())) nameToCompany.set(name.toLowerCase(), d.companyId);
    }
    let ads = [...cards.values()].map((c) => {
      let d = details.get(c.id);
      const name = (c.promotedBy || c.advertiserName || '').toLowerCase();
      if (!d && nameToCompany.has(name)) d = { companyId: nameToCompany.get(name), landingUrl: '', advertiserName: '' };
      return mapLinkedinAd(c, d, domain);
    });
    ads = dedupeAds(ads);
    ads = promoteAdvertiserMatches(ads) || ads;
    const advertisers = aggregateAdvertisers(ads, { platform: 'linkedin', urlFor: advertiserUrl });
    const extra = [];
    for (const a of ads) {
      if (a.match === 'confirmed' && /^\d+$/.test(a.advertiserId) && !extra.some((l) => l.id === a.advertiserId)) {
        extra.push({ id: a.advertiserId, label: `LinkedIn ads of ${a.advertiserName || a.advertiserId}`, url: buildSearchUrl({ companyIds: a.advertiserId }) });
      }
    }
    const allLinks = links.concat(extra.map(({ label, url }) => ({ label, url })));
    return makeResult(meta, { status, message, ads, advertisers, deepLinks: allLinks });
  };

  try {
    const brand = (seeds && seeds.brand) || '';
    const companyIds = companyIdsFromSocial(seeds && seeds.social && seeds.social.linkedin).slice(0, 2);
    const searches = companyIds.map((id) => ({ companyIds: id }));
    if (brand) searches.push({ accountOwner: brand });
    if (!searches.length) return finish('skipped', 'No brand name or LinkedIn company found');
    const maxPages = Math.max(1, Number(settings.linkedinPages) || 2);

    outer: for (const params of searches) {
      let token = null;
      for (let page = 0; page < maxPages; page += 1) {
        progress(`Searching ${params.companyIds ? `company ${params.companyIds}` : `"${params.accountOwner}"`} (page ${page + 1})`);
        const r = await getHtml(ctx, buildSearchUrl({ ...params, paginationToken: token }));
        if (r.authwall) { authwall = true; break outer; }
        if (r.rateLimited) { rateLimited = true; break outer; }
        if (r.status < 200 || r.status >= 300) { httpError = `HTTP ${r.status}`; break; }
        anyResponse = true;
        const parsed = parseLinkedinSearch(r.text);
        const pm = parsePaginationMeta(r.text);
        if (parsed.length || pm || /no (ads|results) (were )?(found|match)/i.test(r.text)) anyRecognized = true;
        for (const c of parsed) if (!cards.has(c.id)) cards.set(c.id, c);
        if (!pm || pm.isLastPage || !pm.paginationToken) break;
        token = pm.paginationToken;
      }
    }

    if (!rateLimited && !authwall) {
      const max = Number.isFinite(Number(settings.linkedinDetails)) ? Number(settings.linkedinDetails) : 10;
      const b = brand.toLowerCase();
      const ordered = [...cards.values()].sort((x, y) => {
        const xs = b && (x.promotedBy || x.advertiserName || '').toLowerCase().includes(b) ? 0 : 1;
        const ys = b && (y.promotedBy || y.advertiserName || '').toLowerCase().includes(b) ? 0 : 1;
        return xs - ys;
      }).slice(0, Math.max(0, max));
      for (let i = 0; i < ordered.length; i += 1) {
        progress(`Checking ad details ${i + 1}/${ordered.length}`);
        const r = await getHtml(ctx, detailUrlFor(ordered[i].id));
        if (r.authwall) { authwall = true; break; }
        if (r.rateLimited) { rateLimited = true; break; }
        if (r.status < 200 || r.status >= 300) continue;
        details.set(ordered[i].id, parseLinkedinDetail(r.text));
      }
    }

    const n = cards.size;
    if (rateLimited) return finish('rate_limited', n ? `LinkedIn rate limit hit, showing partial results (${n} ads)` : 'LinkedIn is rate limiting requests, try again later');
    if (authwall && !n) return finish('needs_user', 'LinkedIn asks for a sign-in, open the Ad Library link once');
    if (n) return finish('ok', `${n} ads found, landing pages checked for ${details.size}`);
    if (httpError && !anyResponse) return finish('error', `LinkedIn Ad Library returned ${httpError}`);
    if (anyResponse && !anyRecognized) return finish('changed', 'LinkedIn changed its response format');
    return finish('empty', 'No LinkedIn ads found in the last 30 days');
  } catch (err) {
    if (ctx && ctx.signal && ctx.signal.aborted) return finish('error', 'Stopped');
    return finish('error', `LinkedIn search failed: ${(err && err.message) || err}`);
  }
}
