import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { meta, deepLinks, buildSearchUrl, parseMetaPayloads, mapMetaResult, describeCapture, search } from '../adapters/meta.js';

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const SSR = fixture('meta-ssr.json');
const SSR_EMPTY = fixture('meta-ssr-empty.json');
const GRAPHQL = fixture('meta-graphql.txt');
const RATE_LIMIT = fixture('meta-ratelimit.txt');

const PAYLOADS = [
  { url: 'ssr', status: 200, body: SSR },
  {
    url: 'https://www.facebook.com/api/graphql/',
    status: 200,
    body: GRAPHQL,
    reqBody: 'fb_api_req_friendly_name=AdLibrarySearchPaginationQuery&variables=%7B%7D',
  },
];

const DOMAIN = 'acme-outdoor.com';

test('meta describes the adapter', () => {
  assert.equal(meta.id, 'meta');
  assert.equal(meta.label, 'Meta (Facebook, Instagram, Messenger)');
  assert.equal(meta.coverage, 'Global (active ads); inactive only EU/political');
});

test('buildSearchUrl builds keyword and page urls', () => {
  const kw = new URL(buildSearchUrl({ q: 'acme-outdoor.com' }));
  assert.equal(kw.origin + kw.pathname, 'https://www.facebook.com/ads/library/');
  assert.equal(kw.searchParams.get('q'), 'acme-outdoor.com');
  assert.equal(kw.searchParams.get('search_type'), 'keyword_unordered');
  assert.equal(kw.searchParams.get('active_status'), 'active');
  assert.equal(kw.searchParams.get('country'), 'ALL');
  assert.equal(kw.searchParams.get('ad_type'), 'all');

  const brand = new URL(buildSearchUrl({ q: 'Acme & Co' }));
  assert.equal(brand.searchParams.get('q'), 'Acme & Co');

  const page = new URL(buildSearchUrl({ pageId: '222222222' }));
  assert.equal(page.searchParams.get('view_all_page_id'), '222222222');
  assert.equal(page.searchParams.get('search_type'), 'page');
  assert.equal(page.searchParams.get('q'), null);
});

test('parseMetaPayloads collects SSR and graphql results, deduped', () => {
  const { results, rateLimited, found } = parseMetaPayloads(PAYLOADS);
  assert.equal(rateLimited, false);
  assert.ok(found >= 3);
  assert.deepEqual(results.map((r) => r.ad_archive_id).sort(), [
    '1111111111111111',
    '3333333333333333',
    '5555555555555555',
  ]);
});

test('parseMetaPayloads detects the rate-limit error code', () => {
  const res = parseMetaPayloads([...PAYLOADS, { url: 'https://www.facebook.com/api/graphql/', status: 200, body: RATE_LIMIT }]);
  assert.equal(res.rateLimited, true);
  assert.equal(res.results.length, 3);

  const only = parseMetaPayloads([{ url: 'x', status: 200, body: RATE_LIMIT }]);
  assert.equal(only.rateLimited, true);
  assert.equal(only.found, 0);
});

test('parseMetaPayloads tolerates junk', () => {
  const res = parseMetaPayloads([{ url: 'x', body: 'not json' }, { url: 'y' }, null]);
  assert.deepEqual(res.results, []);
  assert.equal(res.found, 0);
  assert.deepEqual(parseMetaPayloads(undefined).results, []);
});

test('mapMetaResult: confirmed ad with l.php unwrap', () => {
  const { results } = parseMetaPayloads(PAYLOADS);
  const raw = results.find((r) => r.ad_archive_id === '1111111111111111');
  const ad = mapMetaResult(raw, DOMAIN);
  assert.equal(ad.platform, 'meta');
  assert.equal(ad.id, '1111111111111111');
  assert.equal(ad.advertiserId, '222222222');
  assert.equal(ad.advertiserName, 'Acme Outdoor');
  assert.ok(ad.landingUrl.startsWith('https://www.acme-outdoor.com/sale'), ad.landingUrl);
  assert.ok(!ad.landingUrl.includes('l.facebook.com'));
  assert.equal(ad.displayUrl, 'acme-outdoor.com');
  assert.equal(ad.title, 'Summer Sale');
  assert.equal(ad.text, 'Up to 50% off tents.');
  assert.equal(ad.previewUrl, 'https://scontent.xx.fbcdn.net/v/t39.35426-6/img1.jpg');
  assert.equal(ad.format, 'image');
  assert.equal(ad.isActive, true);
  assert.equal(ad.firstShown, '2024-07-01');
  assert.equal(ad.lastShown, '2024-09-25');
  assert.deepEqual(ad.placements, ['facebook', 'instagram']);
  assert.equal(ad.detailUrl, 'https://www.facebook.com/ads/library/?id=1111111111111111');
  assert.equal(ad.match, 'confirmed');
  assert.equal(ad.source, 'native');
});

test('mapMetaResult: keyword ad, inactive, fields from the first card', () => {
  const { results } = parseMetaPayloads(PAYLOADS);
  const raw = results.find((r) => r.ad_archive_id === '3333333333333333');
  const ad = mapMetaResult(raw, DOMAIN);
  assert.equal(ad.match, 'keyword');
  assert.equal(ad.isActive, false);
  assert.equal(ad.landingUrl, 'https://gearblog.example/review-acme');
  assert.equal(ad.displayUrl, 'gearblog.example');
  assert.equal(ad.title, 'Acme tent review');
  assert.equal(ad.text, 'We tested the Acme tent');
  assert.equal(ad.previewUrl, 'https://scontent.xx.fbcdn.net/v/t39.35426-6/card1.jpg');
  assert.equal(ad.format, 'carousel');
  assert.equal(ad.firstShown, '2024-01-01');
  assert.equal(ad.lastShown, '2024-02-01');
  assert.deepEqual(ad.placements, ['facebook']);
});

test('mapMetaResult: confirmed by display url (caption) and video preview', () => {
  const { results } = parseMetaPayloads(PAYLOADS);
  const raw = results.find((r) => r.ad_archive_id === '5555555555555555');
  const ad = mapMetaResult(raw, DOMAIN);
  assert.equal(ad.match, 'confirmed');
  assert.equal(ad.landingUrl, 'https://m.me/acmeoutdoor');
  assert.equal(ad.format, 'video');
  assert.equal(ad.previewUrl, 'https://scontent.xx.fbcdn.net/v/t15.5256-10/vid1.jpg');
  assert.equal(ad.firstShown, '2024-08-01');
  assert.deepEqual(ad.placements, ['facebook', 'instagram', 'messenger', 'audience_network']);
});

test('mapMetaResult: missing snapshot fields are safe', () => {
  const ad = mapMetaResult({ ad_archive_id: 42 }, DOMAIN);
  assert.equal(ad.id, '42');
  assert.equal(ad.match, 'keyword');
  assert.equal(ad.landingUrl, '');
  assert.equal(ad.title, '');
  assert.equal(ad.isActive, null);
  assert.equal(ad.firstShown, null);
  assert.deepEqual(ad.placements, []);
  assert.doesNotThrow(() => mapMetaResult(null, DOMAIN));
  assert.doesNotThrow(() => mapMetaResult({ ad_archive_id: '1', snapshot: { cards: [null], images: 'x' } }, DOMAIN));
});

test('deepLinks include the keyword search url', () => {
  const links = deepLinks({ domain: DOMAIN, brand: 'Acme Outdoor' });
  assert.ok(links[0].url.includes('q=acme-outdoor.com'));
  assert.ok(links.some((l) => l.url.includes('q=Acme%20Outdoor')));
});

// ---- search() with a fake ctx (no browser)

function fakeCtx(handler, settings = { metaScrolls: 1, metaExpandPages: 1 }) {
  const calls = [];
  return {
    calls,
    settings,
    signal: undefined,
    throttle: async () => {},
    progress: () => {},
    capture: async (url, opts) => {
      calls.push({ url, opts });
      return handler(url, opts, calls.length);
    },
  };
}

test('search returns needs_user on a login redirect', async () => {
  const ctx = fakeCtx(() => ({ payloads: [], tabUrl: 'https://www.facebook.com/login/?next=x' }));
  const res = await search({ domain: DOMAIN, brand: 'acme-outdoor' }, ctx);
  assert.equal(res.status, 'needs_user');
});

test('search returns changed when nothing recognisable was captured', async () => {
  const ctx = fakeCtx(() => ({ payloads: [{ url: 'ssr', body: '{"foo":1}' }], tabUrl: 'https://www.facebook.com/ads/library/' }));
  const res = await search({ domain: DOMAIN, brand: 'acme-outdoor' }, ctx);
  assert.equal(res.status, 'changed');
  assert.match(res.message, /Meta changed its response format/);
});

test('parseMetaPayloads recognises an empty search_results_connection', () => {
  const r = parseMetaPayloads([{ url: 'ssr', status: 200, body: SSR_EMPTY }]);
  assert.deepEqual(r.results, []);
  assert.equal(r.found, 0);
  assert.equal(r.connections, 1);
  assert.equal(r.emptyConnection, true);
});

test('parseMetaPayloads keeps extracting results through a non-empty connection', () => {
  const r = parseMetaPayloads([{ url: 'ssr', status: 200, body: SSR }]);
  assert.equal(r.results.length, 2);
  assert.equal(r.connections, 1);
  assert.equal(r.emptyConnection, false);
});

test('search returns empty (not changed) when Meta reports zero ads', async () => {
  const ctx = fakeCtx(() => ({ payloads: [{ url: 'ssr', body: SSR_EMPTY }], tabUrl: 'https://www.facebook.com/ads/library/' }));
  const res = await search({ domain: DOMAIN, brand: 'acme-outdoor' }, ctx);
  assert.equal(res.status, 'empty');
});

test('search returns rate_limited when only the error came back', async () => {
  const ctx = fakeCtx(() => ({ payloads: [{ url: 'x', body: RATE_LIMIT }], tabUrl: 'https://www.facebook.com/ads/library/' }));
  const res = await search({ domain: DOMAIN, brand: 'acme-outdoor' }, ctx);
  assert.equal(res.status, 'rate_limited');
});

test('search maps, expands confirmed pages and aggregates advertisers', async () => {
  const pageAd = {
    ad_archive_id: '7777777777777777',
    page_id: '222222222',
    page_name: 'Acme Outdoor',
    is_active: true,
    start_date: 1722470400,
    publisher_platform: ['INSTAGRAM'],
    snapshot: { link_url: 'https://apps.apple.com/app/acme/id123', caption: 'apps.apple.com' },
  };
  const pageBody = JSON.stringify({
    data: { ad_library_main: { search_results_connection: { edges: [{ node: { collated_results: [pageAd] } }] } } },
  });
  const ctx = fakeCtx((url) => {
    const u = new URL(url);
    if (u.searchParams.get('view_all_page_id')) return { payloads: [{ url: 'ssr', body: pageBody }], tabUrl: url };
    return { payloads: PAYLOADS, tabUrl: url };
  });
  const res = await search({ domain: DOMAIN, brand: 'acme-outdoor' }, ctx);
  assert.equal(res.status, 'ok');
  assert.equal(res.platform, 'meta');
  assert.equal(res.ads.length, 4);
  const expanded = res.ads.find((a) => a.id === '7777777777777777');
  assert.equal(expanded.match, 'advertiser');
  // brand equals the domain label, so no brand pass: 1 keyword capture + 1 expansion capture.
  assert.equal(ctx.calls.length, 2);
  assert.ok(ctx.calls[1].url.includes('view_all_page_id=222222222'));

  const top = res.advertisers[0];
  assert.equal(top.id, '222222222');
  assert.equal(top.confirmedCount, 2);
  assert.equal(top.url, 'https://www.facebook.com/222222222');
});

test('search logs a capture diagnostic when the first pass is changed', async () => {
  const logs = [];
  const ctx = fakeCtx(() => ({
    payloads: [
      { url: 'ssr', status: 200, body: '{"foo":1}' },
      { url: 'https://www.facebook.com/api/graphql/?doc_id=123&secret=x', status: 500, body: 'oops' },
    ],
    tabUrl: 'https://www.facebook.com/ads/library/?q=acme-outdoor.com',
    error: 'timeout',
  }));
  ctx.log = (level, msg) => logs.push({ level, msg });
  const res = await search({ domain: DOMAIN, brand: 'acme-outdoor' }, ctx);
  assert.equal(res.status, 'changed');
  assert.equal(logs.length, 1);
  assert.equal(logs[0].level, 'warn');
  assert.equal(
    logs[0].msg,
    'First pass found no collated_results: 2 payloads [ssr 200 9b, www.facebook.com/api/graphql/ 500 4b], tab www.facebook.com/ads/library/, error: timeout',
  );
  assert.doesNotMatch(logs[0].msg, /\?|secret|foo/);
});

test('search does not log the diagnostic on a normal result', async () => {
  const logs = [];
  const ctx = fakeCtx((url) => ({ payloads: PAYLOADS, tabUrl: url }), { metaScrolls: 0, metaExpandPages: 0 });
  ctx.log = (level, msg) => logs.push({ level, msg });
  const res = await search({ domain: DOMAIN, brand: 'acme-outdoor' }, ctx);
  assert.equal(res.status, 'ok');
  assert.equal(logs.length, 0);
});

test('describeCapture caps payloads, strips query strings and survives junk', () => {
  const payloads = Array.from({ length: 12 }, (_, i) => ({ url: `https://www.facebook.com/api/graphql/?n=${i}`, status: 200, body: 'ab' }));
  const line = describeCapture({ payloads, tabUrl: '', error: 'failed https://x.example/p?key=1' });
  assert.match(line, /^12 payloads \[/);
  assert.equal((line.match(/www\.facebook\.com\/api\/graphql\/ 200 2b/g) || []).length, 10);
  assert.match(line, /\+2 more\], tab -, error: failed https:\/\/x\.example\/p$/);
  assert.doesNotMatch(line, /n=|key=/);
  assert.equal(describeCapture(null), '0 payloads [], tab -');
  assert.equal(describeCapture({ payloads: [null] }), '1 payloads [? - 0b], tab -');
});
