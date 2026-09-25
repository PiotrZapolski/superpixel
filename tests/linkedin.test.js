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
