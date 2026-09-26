import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  meta,
  buildSearchUrl,
  parseLinkedinSearch,
  parsePaginationMeta,
  parseLinkedinDetail,
  splitCards,
  companyIdsFromSocial,
  isAdLibraryPage,
  attributePromotedCards,
  mapLinkedinAd,
  search,
} from '../adapters/linkedin.js';

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const SEARCH_HTML = fixture('linkedin-search.html');
const DETAIL_HTML = fixture('linkedin-detail.html');

test('meta', () => {
  assert.equal(meta.id, 'linkedin');
  assert.equal(meta.coverage, 'Global, last 12 months');
});

test('buildSearchUrl: search and pagination fragment', () => {
  const u = new URL(buildSearchUrl({ accountOwner: 'Decathlon' }));
  assert.equal(u.origin + u.pathname, 'https://www.linkedin.com/ad-library/search');
  assert.equal(u.searchParams.get('accountOwner'), 'Decathlon');
  assert.equal(u.searchParams.get('countries'), 'ALL');
  assert.equal(u.searchParams.get('dateOption'), 'last-30-days');
  const p = new URL(buildSearchUrl({ companyIds: '12345', paginationToken: 'abc=' }));
  assert.equal(p.pathname, '/ad-library/searchPaginationFragment');
  assert.equal(p.searchParams.get('companyIds'), '12345');
  assert.equal(p.searchParams.get('paginationToken'), 'abc=');
});

test('parseLinkedinSearch extracts 3 cards', () => {
  const cards = parseLinkedinSearch(SEARCH_HTML);
  assert.equal(cards.length, 3);
  assert.deepEqual(cards.map((c) => c.id), ['123', '456', '789']);

  const [a, b, c] = cards;
  assert.equal(a.advertiserName, 'Decathlon');
  assert.equal(a.text, 'Run further with our new trail shoes & gear.');
  assert.equal(a.headline, 'Trail running collection');
  assert.ok(a.imageUrl.startsWith('https://media.licdn.com/dms/image/v2/D4D10AQ/'), a.imageUrl);
  assert.equal(a.promotedBy, '');

  assert.equal(b.advertiserName, 'Jane Doe');
  assert.equal(b.promotedBy, 'Decathlon');
  assert.equal(b.imageUrl, '');

  assert.equal(c.advertiserName, 'Acme Sports');
  assert.equal(c.text, 'Discounts on Decathlon-style gear.');
});

test('parseLinkedinSearch survives card class churn (anchors on detail links)', () => {
  const churned = SEARCH_HTML.replace(/search-result-item/g, 'ad-card-v2');
  assert.equal(splitCards(churned).length, 3);
  const cards = parseLinkedinSearch(churned);
  assert.deepEqual(cards.map((c) => c.id), ['123', '456', '789']);
  assert.equal(cards[0].advertiserName, 'Decathlon');
});

test('parsePaginationMeta', () => {
  assert.deepEqual(parsePaginationMeta(SEARCH_HTML), {
    isLastPage: false,
    paginationToken: 'MTIzNDU2Nzg5LTE3NTgwMDAwMDAwMDA=',
  });
  assert.deepEqual(
    parsePaginationMeta('<code id="paginationMetadata"><!--{"isLastPage":true}--></code>'),
    { isLastPage: true, paginationToken: null },
  );
  assert.equal(parsePaginationMeta('<html></html>'), null);
});

test('parseLinkedinDetail: company id, unwrapped landing, advertiser, payer', () => {
  const d = parseLinkedinDetail(DETAIL_HTML);
  assert.equal(d.companyId, '12345');
  assert.equal(new URL(d.landingUrl).hostname, 'www.decathlon.com');
  assert.equal(new URL(d.landingUrl).pathname, '/trail');
  assert.equal(d.advertiserName, 'Decathlon');
  assert.equal(d.paidBy, 'Decathlon SA');
});

test('parseLinkedinDetail ignores linkedin/app-store links when no ad link exists', () => {
  const d = parseLinkedinDetail('<a href="https://about.linkedin.com/">About</a><a href="https://play.google.com/store">App</a>');
  assert.equal(d.companyId, '');
  assert.equal(d.landingUrl, 'https://play.google.com/store');
  const none = parseLinkedinDetail('<a href="https://about.linkedin.com/">About</a>');
  assert.equal(none.landingUrl, '');
});

test('companyIdsFromSocial keeps numeric company ids only', () => {
  assert.deepEqual(
    companyIdsFromSocial(['https://www.linkedin.com/company/12345/', 'https://www.linkedin.com/company/decathlon', 'https://linkedin.com/company/12345']),
    ['12345'],
  );
});

function fakeResponse(body, { status = 200, url = '' } = {}) {
  return { status, url, ok: status >= 200 && status < 300, async text() { return body; } };
}

test('search() end to end with fake fetch', async () => {
  const seen = [];
  const ctx = {
    settings: { linkedinPages: 1, linkedinDetails: 2 },
    progress() {},
    async fetch(url, init) {
      seen.push({ url, init });
      if (url.includes('/ad-library/detail/')) return fakeResponse(DETAIL_HTML, { url });
      return fakeResponse(SEARCH_HTML, { url });
    },
  };
  const res = await search({ domain: 'decathlon.com', brand: 'Decathlon', social: { linkedin: [] } }, ctx);
  assert.equal(res.status, 'ok');
  assert.ok(seen.every((s) => s.init && s.init.credentials === 'omit'));
  assert.equal(seen.filter((s) => s.url.includes('/detail/')).length, 2);
  const byId = Object.fromEntries(res.ads.map((a) => [a.id, a]));
  assert.equal(byId['123'].match, 'confirmed');
  assert.equal(byId['123'].advertiserId, '12345');
  assert.equal(byId['456'].match, 'confirmed');
  assert.equal(byId['789'].match, 'name');
  const top = res.advertisers[0];
  assert.equal(top.id, '12345');
  assert.equal(top.url, 'https://www.linkedin.com/company/12345');
});

test('search() maps auth wall to needs_user', async () => {
  const ctx = {
    settings: {},
    async fetch() { return fakeResponse('', { url: 'https://www.linkedin.com/authwall?trk=x' }); },
  };
  const res = await search({ domain: 'decathlon.com', brand: 'Decathlon', social: { linkedin: [] } }, ctx);
  assert.equal(res.status, 'needs_user');
});

test('search() reports changed for unrecognised HTML', async () => {
  const ctx = {
    settings: { linkedinPages: 1 },
    async fetch(url) { return fakeResponse('<html><body>something else</body></html>', { url }); },
  };
  const res = await search({ domain: 'decathlon.com', brand: 'Decathlon', social: { linkedin: [] } }, ctx);
  assert.equal(res.status, 'changed');
});

// ---- live finding 2026-09-26: a brand without ads gets a normal page with 0 cards ----

const EMPTY_HTML = fixture('linkedin-empty.html');

test('isAdLibraryPage recognises an empty search page, in any language', () => {
  assert.equal(parseLinkedinSearch(EMPTY_HTML).length, 0);
  assert.equal(parsePaginationMeta(EMPTY_HTML), null);
  assert.equal(isAdLibraryPage(EMPTY_HTML), true);
  assert.equal(isAdLibraryPage(SEARCH_HTML), true);
  // Localised title only, no form.
  assert.equal(isAdLibraryPage('<html><head><title>Biblioteca de anuncios | LinkedIn</title></head><body><a href="/ad-library/home">x</a></body></html>'), true);
  // Results header "(0)" only.
  assert.equal(isAdLibraryPage('<div class="ad-library"><h1>Anzeigen (0)</h1></div>'), true);
  assert.equal(isAdLibraryPage('<html><body>something else</body></html>'), false);
  assert.equal(isAdLibraryPage('<html><head><title>LinkedIn</title></head><body>Sign in</body></html>'), false);
});

test('search() reports empty (not changed) for an Ad Library page without cards', async () => {
  const seen = [];
  const ctx = {
    settings: { linkedinPages: 2, linkedinDetails: 5 },
    async fetch(url) { seen.push(url); return fakeResponse(EMPTY_HTML, { url }); },
  };
  const res = await search({ domain: 'babylovegrowth.ai', brand: 'babylovegrowth', social: { linkedin: [] } }, ctx);
  assert.equal(res.status, 'empty');
  assert.match(res.message, /^No LinkedIn ads found for babylovegrowth/);
  assert.equal(seen.length, 1);
});

test('search() adds accountOwner searches for up to 2 advertiser names', async () => {
  const owners = [];
  const ctx = {
    settings: { linkedinPages: 1, linkedinDetails: 0 },
    async fetch(url) {
      const o = new URL(url).searchParams.get('accountOwner');
      if (o) owners.push(o);
      return fakeResponse(EMPTY_HTML, { url });
    },
  };
  const res = await search({
    domain: 'babylovegrowth.ai',
    brand: 'babylovegrowth',
    advertiserNames: ['BLG INC', 'Babylovegrowth', 'BLG', 'Other'],
    social: { linkedin: [] },
  }, ctx);
  assert.deepEqual(owners, ['babylovegrowth', 'BLG INC', 'BLG']);
  assert.equal(res.status, 'empty');
  assert.match(res.message, /babylovegrowth, BLG INC, BLG/);
});

// ---- live finding 2026-09-26: thought-leader ads (employee posts promoted by the company) ----

const PL_HTML = fixture('linkedin-search-pl.html');

test('parseLinkedinSearch drops sr-only text and keeps header lines (Polish UI)', () => {
  const cards = parseLinkedinSearch(PL_HTML);
  assert.deepEqual(cards.map((c) => c.id), ['1001', '1002', '1003']);
  assert.equal(cards[0].advertiserName, 'BabyLoveGrowth');
  assert.equal(cards[1].advertiserName, 'Tilen Babnik');
  assert.deepEqual(cards[1].headerLines, ['Tilen Babnik', 'Co-founder | SEO automation', 'Promowane przez BabyLoveGrowth']);
  assert.equal(cards[1].promotedBy, '');
});

test('attributePromotedCards resolves localised "promoted by" lines to a known company', () => {
  const cards = attributePromotedCards(parseLinkedinSearch(PL_HTML), ['babylovegrowth']);
  const [company, employee, stranger] = cards;
  assert.equal(company.promotedBy, '');
  assert.equal(employee.promotedBy, 'BabyLoveGrowth');
  assert.equal(employee.person, 'Tilen Babnik');
  // "Other Corp" is neither another card's advertiser nor the brand: left alone.
  assert.equal(stranger.promotedBy, '');
  assert.equal(stranger.person, '');
});

test('attributePromotedCards matches the brand when no company card is present', () => {
  const only = parseLinkedinSearch(PL_HTML).slice(1, 2);
  assert.equal(attributePromotedCards(only, [])[0].promotedBy, '');
  const withBrand = attributePromotedCards(parseLinkedinSearch(PL_HTML).slice(1, 2), ['BabyLoveGrowth']);
  assert.equal(withBrand[0].promotedBy, 'BabyLoveGrowth');
});

test('mapLinkedinAd titles employee posts and keeps the text', () => {
  const ad = mapLinkedinAd({ id: '9', advertiserName: 'Jane Doe', person: 'Jane Doe', promotedBy: 'Decathlon', headline: 'Our HQ', text: 'Proud of the team', imageUrl: '' }, null, 'decathlon.com');
  assert.equal(ad.advertiserName, 'Decathlon');
  assert.equal(ad.title, 'Employee post: Jane Doe - Our HQ');
  assert.equal(ad.text, 'Proud of the team');
  const plain = mapLinkedinAd({ id: '8', advertiserName: 'Decathlon', promotedBy: '', headline: 'Trail', text: 't', imageUrl: '' }, null, 'decathlon.com');
  assert.equal(plain.title, 'Trail');
});

test('search() attributes employee posts to the promoting company and its id', async () => {
  const detail = '<html><body><a href="https://www.linkedin.com/company/777">BabyLoveGrowth</a>'
    + '<a href="https://www.linkedin.com/redir/redirect?url=https%3A%2F%2Fbabylovegrowth.ai%2Fpricing">Start</a></body></html>';
  const ctx = {
    settings: { linkedinPages: 1, linkedinDetails: 1 },
    async fetch(url) {
      if (url.includes('/ad-library/detail/1001')) return fakeResponse(detail, { url });
      if (url.includes('/ad-library/detail/')) return fakeResponse('<html></html>', { url });
      return fakeResponse(PL_HTML, { url });
    },
  };
  const res = await search({ domain: 'babylovegrowth.ai', brand: 'babylovegrowth', social: { linkedin: [] } }, ctx);
  assert.equal(res.status, 'ok');
  const byId = Object.fromEntries(res.ads.map((a) => [a.id, a]));
  assert.equal(byId['1001'].match, 'confirmed');
  assert.equal(byId['1002'].advertiserName, 'BabyLoveGrowth');
  assert.equal(byId['1002'].advertiserId, '777');
  assert.equal(byId['1002'].title, 'Employee post: Tilen Babnik');
  assert.equal(byId['1002'].text, 'We grew organic traffic 4x in 90 days. Here is how.');
  assert.equal(byId['1002'].match, 'advertiser');
  assert.ok(!res.advertisers.some((a) => a.name === 'Tilen Babnik'));
  const blg = res.advertisers.find((a) => a.id === '777');
  assert.equal(blg.adCount, 2);
  assert.equal(blg.confirmedCount, 1);
});
