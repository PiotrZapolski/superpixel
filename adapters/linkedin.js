// LinkedIn Ad Library adapter (spec 4.4).
// Search and detail pages work logged-out, so requests use credentials:'omit'. Parsing is
// regex/string based (no DOMParser in the service worker). Cards are anchored on the
// /ad-library/detail/<id> link so class-name churn does not break id extraction.

import { hostMatches, unwrapRedirect } from '../lib/domain.js';
import { sleep, uniq } from '../lib/util.js';
import { decodeEntities, attrValues, firstClassText } from '../lib/html.js';
import { makeAd, makeResult, aggregateAdvertisers, promoteAdvertiserMatches, dedupeAds, nameQueries, keepConfirmedAdvertisers } from '../lib/model.js';
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

// Screen-reader-only elements ("View details", localised) are not card content.
const SR_ONLY_RE = /<(span|div|p)\b[^>]*\bclass\s*=\s*["'][^"']*\b(?:sr-only|visually-hidden|a11y-text)\b[^"']*["'][^>]*>[\s\S]*?<\/\1>/gi;
const MAX_HEADER_LINES = 4;

/**
 * Parse search result cards.
 * Thought-leader ads (an employee's post promoted by the company) show the person's name, their
 * headline and "Promoted by <Company>" (localised, e.g. "Promowane przez <Company>"). The English
 * form is read here; attributePromotedCards() resolves the localised form across all cards.
 * @returns {{id:string, advertiserName:string, text:string, headline:string, imageUrl:string,
 *   promotedBy:string, person:string, headerLines:string[]}[]}
 */
export function parseLinkedinSearch(html) {
  const out = [];
  const seen = new Set();
  for (const rawCard of splitCards(html)) {
    const idm = DETAIL_RE.exec(rawCard);
    if (!idm || seen.has(idm[1])) continue;
    seen.add(idm[1]);
    const card = rawCard.replace(SR_ONLY_RE, ' ');
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
    // Lines above the ad content: name, [person headline], "Promoted" / "Promoted by X".
    // Cut the markup at the commentary / headline element when present, else at the text line.
    const marks = ['commentary__content', 'sponsored-content-headline'].map((c) => card.indexOf(c)).filter((i) => i >= 0);
    let headerSrc = lines;
    if (marks.length) {
      const tagStart = card.lastIndexOf('<', Math.min(...marks));
      headerSrc = htmlLines(card.slice(0, tagStart >= 0 ? tagStart : Math.min(...marks))).filter((l) => !NOISE_LINE_RE.test(l));
    }
    const headerLines = [];
    for (const l of headerSrc) {
      if (headerLines.length >= MAX_HEADER_LINES) break;
      if (l === headline || (text && l === text)) break;
      headerLines.push(l);
    }
    const imgs = imgUrls(card);
    const imageUrl = imgs.find((u) => !/company-logo|profile-displayphoto|profile-framedphoto/i.test(u)) || '';
    out.push({
      id: idm[1],
      advertiserName: nameLine,
      text,
      headline,
      imageUrl,
      promotedBy,
      person: promotedBy ? nameLine : '',
      headerLines,
    });
  }
  return out;
}

function norm(s) {
  return String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/** True when `line` ends with `name` on a word boundary (and is not just the name itself). */
function endsWithName(line, name) {
  const l = norm(line);
  const n = norm(name);
  if (n.length < 2 || l.length <= n.length || !l.endsWith(n)) return false;
  return !/[\p{L}\p{N}]/u.test(l.charAt(l.length - n.length - 1));
}

/**
 * Language-agnostic thought-leader detection over all cards: a card whose header has at least two
 * lines (person name + headline, or name + promo line) and a later line ending with a known
 * company name (another card's advertiser, the brand or an advertiser name seed) is attributed to
 * that company: promotedBy = company, person = the card's own name line. Mutates and returns cards.
 * @param {object[]} cards parsed cards (parseLinkedinSearch)
 * @param {string[]} [extraNames] brand + advertiser names
 */
export function attributePromotedCards(cards, extraNames = []) {
  const list = Array.isArray(cards) ? cards : [];
  const known = [];
  const seen = new Set();
  const addName = (n) => {
    const s = String(n || '').replace(/\s+/g, ' ').trim();
    if (s.length < 2 || s.length > 120 || seen.has(s.toLowerCase())) return;
    seen.add(s.toLowerCase());
    known.push(s);
  };
  for (const c of list) if (c && !c.person) addName(c.promotedBy || c.advertiserName);
  for (const c of list) if (c && c.promotedBy) addName(c.promotedBy);
  for (const n of Array.isArray(extraNames) ? extraNames : []) addName(n);
  // Longest names first so "Acme Sports" wins over "Sports".
  known.sort((a, b) => b.length - a.length);

  for (const c of list) {
    if (!c || c.promotedBy) continue;
    const header = Array.isArray(c.headerLines) ? c.headerLines : [];
    if (header.length < 2) continue;
    const own = norm(c.advertiserName);
    let company = '';
    for (let i = header.length - 1; i >= 1 && !company; i--) {
      for (const name of known) {
        if (norm(name) === own) continue;
        // "Promowane przez Acme", or "Acme" alone on its own line below name + headline.
        if (endsWithName(header[i], name) || (i >= 2 && norm(header[i]) === norm(name))) {
          company = name;
          break;
        }
      }
    }
    if (!company) continue;
    c.person = c.advertiserName;
    c.promotedBy = company;
  }
  return list;
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

/**
 * True when the HTML is a LinkedIn Ad Library search page (or pagination fragment), even with
 * zero result cards: a brand without ads gets HTTP 200 with a normal ~110KB page, no
 * `search-result-item` and no paginationMetadata. Language independent: relies on the
 * search form / accountOwner field, a LinkedIn page title, or a "(0)" results header, all on a
 * page that references /ad-library.
 */
export function isAdLibraryPage(html) {
  const s = String(html || '');
  if (!/ad-library/i.test(s)) return false;
  if (DETAIL_RE.test(s) || /paginationMetadata/i.test(s)) return true;
  if (/<form\b[^>]*\baction\s*=\s*["'][^"']*ad-library\/search/i.test(s)) return true;
  if (/\bname\s*=\s*["'](?:accountOwner|keyword|countries)["']/i.test(s)) return true;
  const title = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(s);
  if (title && /ad library|linkedin/i.test(decodeEntities(title[1]))) return true;
  // "(0)" results header in visible text (scripts are dropped by htmlLines).
  return htmlLines(s).some((l) => /\(\s*0\s*\)/.test(l));
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
  // Thought-leader ad: the post belongs to an employee, the company pays for it.
  const person = card.promotedBy ? card.person || '' : '';
  const title = person
    ? `Employee post: ${person}${card.headline ? ` - ${card.headline}` : ''}`
    : card.headline || '';
  return makeAd({
    platform: 'linkedin',
    id: String(card.id),
    advertiserId: d.companyId || name,
    advertiserName: name,
    format: card.imageUrl ? 'image' : 'text',
    title,
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

  // Employee posts ("Promoted by <Company>") join the confirmed advertiser of that company.
  const adoptEmployeePost = (ad, confirmedByName) => {
    const c = cards.get(ad.id);
    if (!c || !c.promotedBy) return '';
    return confirmedByName.get(String(c.promotedBy).trim().toLowerCase()) || '';
  };

  // Ads of advertisers with at least one ad pointing to the domain. A same-name company without
  // such an ad (outrank.so vs "Outrank" of outrank.ie, 2026-09-26) is a different company.
  const buildAds = () => {
    // Propagate company ids to cards of the same advertiser name that were not detailed.
    const nameToCompany = new Map();
    for (const [id, d] of details) {
      const c = cards.get(id);
      if (!d.companyId || !c) continue;
      for (const name of [c.promotedBy || c.advertiserName, !c.person ? d.advertiserName : '']) {
        const k = String(name || '').toLowerCase();
        if (k && !nameToCompany.has(k)) nameToCompany.set(k, d.companyId);
      }
    }
    let ads = [...cards.values()].map((c) => {
      let d = details.get(c.id);
      const name = (c.promotedBy || c.advertiserName || '').toLowerCase();
      if ((!d || !d.companyId) && nameToCompany.has(name)) {
        d = { landingUrl: '', advertiserName: '', ...(d || {}), companyId: nameToCompany.get(name) };
      }
      return mapLinkedinAd(c, d, domain);
    });
    ads = dedupeAds(ads);
    ads = keepConfirmedAdvertisers(ads, adoptEmployeePost);
    return promoteAdvertiserMatches(ads) || ads;
  };

  const result = (status, message, ads) => {
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
  const finish = (status, message) => result(status, message, buildAds());

  try {
    const brand = (seeds && seeds.brand) || '';
    const companyIds = companyIdsFromSocial(seeds && seeds.social && seeds.social.linkedin).slice(0, 2);
    const searches = companyIds.map((id) => ({ companyIds: id }));
    // accountOwner: the brand plus up to 2 advertiser names found on Google/Meta.
    const owners = nameQueries(brand, seeds && seeds.advertiserNames, 2);
    for (const owner of owners) searches.push({ accountOwner: owner });
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
        if (parsed.length || pm || /no (ads|results) (were )?(found|match)/i.test(r.text) || isAdLibraryPage(r.text)) anyRecognized = true;
        for (const c of parsed) if (!cards.has(c.id)) cards.set(c.id, c);
        if (!pm || pm.isLastPage || !pm.paginationToken) break;
        token = pm.paginationToken;
      }
    }

    // Thought-leader ads: attribute employee posts to the promoting company (any UI language).
    attributePromotedCards([...cards.values()], owners);

    if (!rateLimited && !authwall) {
      const max =Number.isFinite(Number(settings.linkedinDetails)) ? Number(settings.linkedinDetails) : 10;
      const names = owners.map((o) => o.toLowerCase());
      const rank = (c) => {
        const n = (c.promotedBy || c.advertiserName || '').toLowerCase();
        return names.some((o) => n.includes(o)) ? 0 : 1;
      };
      const ordered = [...cards.values()].sort((x, y) => rank(x) - rank(y)).slice(0, Math.max(0, max));
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
    const ads = buildAds();
    const confirmed = ads.filter((a) => a.match === 'confirmed').length;
    if (rateLimited) return result('rate_limited', ads.length ? `LinkedIn rate limit hit, showing partial results (${ads.length} ads)` : 'LinkedIn is rate limiting requests, try again later', ads);
    if (authwall && !confirmed) return result('needs_user', 'LinkedIn asks for a sign-in, open the Ad Library link once', []);
    if (confirmed) return result('ok', `${ads.length} ads, ${confirmed} pointing to ${domain} (landing pages checked for ${details.size} of ${n})`, ads);
    if (httpError && !anyResponse) return result('error', `LinkedIn Ad Library returned ${httpError}`, []);
    if (anyResponse && !anyRecognized) return result('changed', 'LinkedIn changed its response format', []);
    const searched = owners.concat(companyIds.map((id) => `company ${id}`)).join(', ');
    return result('empty', `No LinkedIn ads point to ${domain} (searched: ${searched})`, []);
  } catch (err) {
    if (ctx && ctx.signal && ctx.signal.aborted) return finish('error', 'Stopped');
    return finish('error', `LinkedIn search failed: ${(err && err.message) || err}`);
  }
}
