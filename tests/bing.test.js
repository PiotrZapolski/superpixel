import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  meta,
  parseBingAdvertisers,
  parseBingAds,
  filterBingAds,
  advertiserUrl,
  search,
  advertisersUrl,
  adsByAdvertiserUrl,
  adsBySearchUrl,
  mergeAdvertiserLists,
  ADS_TOP,
  TEXT_DOWN_KEY,
  TEXT_DOWN_MS,
  MAX_429_RETRIES,
} from '../adapters/bing.js';
import { logHttpStatus, onEntry } from '../background/log.js';

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const ADVERTISERS = JSON.parse(fixture('bing-advertisers.json'));
const ADS = JSON.parse(fixture('bing-ads.json'));

test('meta', () => {
  assert.equal(meta.id, 'bing');
  assert.equal(meta.label, 'Microsoft Advertising (Bing)');
  assert.equal(meta.coverage, 'EU/EEA-served ads');
});

test('parseBingAdvertisers', () => {
  const list = parseBingAdvertisers(ADVERTISERS);
  assert.deepEqual(list, [
    { id: '1001', name: 'Decathlon', country: 'France', verified: true },
    { id: '1002', name: 'Sport Reseller GmbH', country: 'Germany', verified: false },
  ]);
  assert.equal(parseBingAdvertisers({ items: [] }), null);
  assert.equal(parseBingAdvertisers('not json'), null);
});

test('parseBingAds maps fields and match', () => {
  const r = parseBingAds(ADS, 'decathlon.com');
  assert.equal(r.total, 3);
  assert.equal(r.ads.length, 3);
  const [a, b, c] = r.ads;
  assert.equal(a.platform, 'bing');
  assert.equal(a.id, '5001');
  assert.equal(a.advertiserId, '1001');
  assert.equal(a.advertiserName, 'Decathlon');
  assert.equal(a.title, 'Decathlon Official Site');
  assert.equal(a.text, 'Sports gear for everyone. Free returns.');
  assert.equal(a.displayUrl, 'www.decathlon.com/running');
  assert.equal(new URL(a.landingUrl).hostname, 'www.decathlon.com');
  assert.equal(a.detailUrl, 'https://adlibrary.ads.microsoft.com/ad-details?adId=5001');
  assert.equal(a.format, 'text');
  assert.equal(a.match, 'confirmed');

  // Confirmed through the display URL alone; AssetJson with an image.
  assert.equal(b.match, 'confirmed');
  assert.equal(b.format, 'image');
  assert.equal(b.previewUrl, 'https://tse1.mm.bing.net/images/trail.jpg');

  assert.equal(c.match, 'keyword');
  assert.equal(c.advertiserId, '1002');
  assert.equal(parseBingAds({ nope: true }, 'decathlon.com'), null);
});

test('filterBingAds drops advertisers without confirmed ads', () => {
  const { ads } = parseBingAds(ADS, 'decathlon.com');
  const kept = filterBingAds(ads, ['1001', '1002']);
  assert.deepEqual(kept.map((a) => a.id), ['5001', '5002']);
});

test('filterBingAds keeps top 2 advertisers as name matches when none is confirmed', () => {
  const { ads } = parseBingAds(ADS, 'example.org');
  const kept = filterBingAds(ads, ['1002', '1001', '1003']);
  assert.equal(kept.length, 3);
  assert.ok(kept.every((a) => a.match === 'name'));
  const onlyFirst = filterBingAds(ads, ['1002']);
  assert.deepEqual(onlyFirst.map((a) => a.id), ['5003']);
});

test('advertiserUrl', () => {
  assert.equal(advertiserUrl('1001'), 'https://adlibrary.ads.microsoft.com/?advertiserId=1001');
});

function fakeResponse(obj, status = 200) {
  return { status, ok: status < 300, async text() { return typeof obj === 'string' ? obj : JSON.stringify(obj); } };
}

test('search() end to end with fake fetch', async () => {
  const urls = [];
  const ctx = {
    settings: { bingAdvertisers: 6 },
    progress() {},
    async fetch(url) {
      urls.push(url);
      if (url.includes('/Advertisers?')) return fakeResponse(ADVERTISERS);
      if (url.includes('advertiserId=1001')) return fakeResponse(ADS);
      return fakeResponse({ '@odata.count': 0, value: [] });
    },
  };
  const res = await search({ domain: 'decathlon.com', brand: 'Decathlon' }, ctx);
  assert.equal(res.status, 'ok');
  assert.ok(urls[0].startsWith('https://adlibrary.api.bingads.microsoft.com/api/v1/Advertisers?searchText=Decathlon'));
  assert.ok(urls.some((u) => u.includes('Ads?searchText=decathlon.com')));
  assert.deepEqual(res.ads.map((a) => a.id).sort(), ['5001', '5002']);
  assert.equal(res.advertisers.length, 1);
  assert.equal(res.advertisers[0].id, '1001');
  assert.equal(res.advertisers[0].country, 'France');
  assert.equal(res.advertisers[0].url, 'https://adlibrary.ads.microsoft.com/?advertiserId=1001');
});

test('search() reports changed on unexpected shape', async () => {
  const ctx = { settings: {}, async fetch() { return fakeResponse({ unexpected: 1 }); } };
  const res = await search({ domain: 'decathlon.com', brand: 'Decathlon' }, ctx);
  assert.equal(res.status, 'changed');
});

// ---- live findings 2026-09-26: top <= 24, pagination, 429 handling, advertiser names ----

function adsPage(advertiserId, count, total, { domain = 'babylovegrowth.ai', offset = 0 } = {}) {
  const value = [];
  for (let i = 0; i < count; i += 1) {
    value.push({
      AdId: 9000 + offset + i,
      AdvertiserName: 'BLG',
      AdvertiserId: advertiserId,
      Title: `Ad ${offset + i}`,
      Description: 'AI SEO content',
      DisplayUrl: domain,
      DestinationUrl: `https://${domain}/`,
      AssetJson: null,
    });
  }
  return { '@odata.count': total, value };
}

test('URL builders: Ads top is capped at 24, Advertisers keeps 20', () => {
  assert.equal(ADS_TOP, 24);
  assert.ok(advertisersUrl('BLG').endsWith('searchText=BLG&top=20&skip=0'));
  assert.ok(adsByAdvertiserUrl('1001').endsWith('advertiserId=1001&top=24&skip=0'));
  assert.ok(adsByAdvertiserUrl('1001', 50, 24).endsWith('advertiserId=1001&top=24&skip=24'));
  assert.ok(adsBySearchUrl('x.com', 50).endsWith('searchText=x.com&top=24&skip=0'));
});

test('mergeAdvertiserLists: round robin, dedupe by id, cap', () => {
  const a = [{ id: '1' }, { id: '2' }, { id: '3' }];
  const b = [{ id: '2' }, { id: '9' }];
  assert.deepEqual(mergeAdvertiserLists([a, b], 6).map((x) => x.id), ['1', '2', '3', '9']);
  assert.deepEqual(mergeAdvertiserLists([a, b], 2).map((x) => x.id), ['1', '2']);
  assert.deepEqual(mergeAdvertiserLists([[], b], 6).map((x) => x.id), ['2', '9']);
});

test('search() pages Ads with top=24 and skip (max 2 pages), never top > 24', async () => {
  const urls = [];
  const ctx = {
    settings: { bingAdvertisers: 6 },
    async fetch(url) {
      urls.push(url);
      if (url.includes('/Advertisers?')) return fakeResponse({ value: [{ AdvertiserId: 2001, AdvertiserName: 'BLG', AdvertiserCountry: 'US' }] });
      if (url.includes('advertiserId=2001') && url.endsWith('skip=0')) return fakeResponse(adsPage(2001, 24, 60));
      if (url.includes('advertiserId=2001') && url.endsWith('skip=24')) return fakeResponse(adsPage(2001, 24, 60, { offset: 24 }));
      return fakeResponse({ '@odata.count': 0, value: [] });
    },
  };
  const res = await search({ domain: 'babylovegrowth.ai', brand: 'BLG' }, ctx);
  assert.equal(res.status, 'ok');
  const adsCalls = urls.filter((u) => u.includes('/Ads?advertiserId='));
  assert.equal(adsCalls.length, 2);
  assert.ok(urls.every((u) => !/[?&]top=(\d+)/.test(u) || Number(/[?&]top=(\d+)/.exec(u)[1]) <= 24));
  assert.equal(res.ads.length, 48);
});

test('search() stops paging when the first page is not full', async () => {
  const urls = [];
  const ctx = {
    settings: {},
    async fetch(url) {
      urls.push(url);
      if (url.includes('/Advertisers?')) return fakeResponse(ADVERTISERS);
      if (url.includes('advertiserId=1001')) return fakeResponse(ADS);
      return fakeResponse({ '@odata.count': 0, value: [] });
    },
  };
  await search({ domain: 'decathlon.com', brand: 'Decathlon' }, ctx);
  assert.equal(urls.filter((u) => u.includes('advertiserId=1001')).length, 1);
});

test('search() retries a 429 (HTML body) twice, then rate_limited, never changed', async () => {
  let calls = 0;
  const delays = [];
  const ctx = {
    settings: {},
    retryDelay(attempt) { delays.push(attempt); return 0; },
    async fetch() {
      calls += 1;
      return fakeResponse('<html><body>Too Many Requests</body></html>', 429);
    },
  };
  const res = await search({ domain: 'decathlon.com', brand: 'Decathlon' }, ctx);
  assert.equal(res.status, 'rate_limited');
  assert.equal(calls, 3);
  assert.deepEqual(delays, [0, 1]);
});

test('search() recovers when a 429 is followed by a normal answer', async () => {
  let first = true;
  const ctx = {
    settings: {},
    retryDelay: () => 0,
    async fetch(url) {
      if (first) { first = false; return fakeResponse('<html>busy</html>', 429); }
      if (url.includes('/Advertisers?')) return fakeResponse(ADVERTISERS);
      if (url.includes('advertiserId=1001')) return fakeResponse(ADS);
      return fakeResponse({ '@odata.count': 0, value: [] });
    },
  };
  const res = await search({ domain: 'decathlon.com', brand: 'Decathlon' }, ctx);
  assert.equal(res.status, 'ok');
  assert.deepEqual(res.ads.map((a) => a.id).sort(), ['5001', '5002']);
});

test('search() also searches advertisers by seeds.advertiserNames', async () => {
  const searched = [];
  const ctx = {
    settings: { bingAdvertisers: 6 },
    async fetch(url) {
      if (url.includes('/Advertisers?')) {
        const q = new URL(url).searchParams.get('searchText');
        searched.push(q);
        if (q === 'BLG') return fakeResponse({ value: [{ AdvertiserId: 2001, AdvertiserName: 'BLG', AdvertiserCountry: 'US' }] });
        return fakeResponse({ value: [] });
      }
      if (url.includes('advertiserId=2001')) return fakeResponse(adsPage(2001, 3, 3));
      return fakeResponse({ '@odata.count': 0, value: [] });
    },
  };
  const res = await search({ domain: 'babylovegrowth.ai', brand: 'babylovegrowth', advertiserNames: ['BLG INC', 'BLG', 'babylovegrowth'] }, ctx);
  assert.deepEqual(searched, ['babylovegrowth', 'BLG INC', 'BLG']);
  assert.equal(res.status, 'ok');
  assert.equal(res.advertisers.length, 1);
  assert.equal(res.advertisers[0].id, '2001');
  assert.ok(res.ads.every((a) => a.match === 'confirmed'));
});

// ---- live finding 2026-09-26: name search returns unrelated advertisers with 0 confirmed ads ----

test('search() returns empty with no advertisers when no ad points to the domain', async () => {
  const ctx = {
    settings: { bingAdvertisers: 6 },
    retryDelay: () => 0,
    async fetch(url) {
      if (url.includes('/Advertisers?')) {
        return fakeResponse({ value: [
          { AdvertiserId: 3001, AdvertiserName: 'GMC of Goshen BLGMCG - Bob Loquercio Auto Group', AdvertiserCountry: 'US' },
          { AdvertiserId: 3002, AdvertiserName: 'BLG srl', AdvertiserCountry: 'IT' },
        ] });
      }
      if (url.includes('advertiserId=3001')) return fakeResponse(adsPage(3001, 3, 3, { domain: 'goshengmc.com' }));
      if (url.includes('advertiserId=3002')) return fakeResponse(adsPage(3002, 2, 2, { domain: 'blg.it', offset: 50 }));
      return fakeResponse({ '@odata.count': 0, value: [] });
    },
  };
  const res = await search({ domain: 'babylovegrowth.ai', brand: 'BabyLoveGrowth', advertiserNames: ['BLG INC', 'BLG'] }, ctx);
  assert.equal(res.status, 'empty');
  assert.equal(res.message, 'No Bing ads point to babylovegrowth.ai (searched: BabyLoveGrowth, BLG INC, BLG)');
  assert.deepEqual(res.ads, []);
  assert.deepEqual(res.advertisers, []);
});

test('search() rate limited without confirmed ads shows no unrelated advertisers', async () => {
  let n = 0;
  const ctx = {
    settings: { bingAdvertisers: 6 },
    retryDelay: () => 0,
    async fetch(url) {
      n += 1;
      if (url.includes('/Advertisers?')) return fakeResponse({ value: [{ AdvertiserId: 3002, AdvertiserName: 'BLG srl' }, { AdvertiserId: 3003, AdvertiserName: 'BLG GmbH' }] });
      if (url.includes('advertiserId=3002')) return fakeResponse(adsPage(3002, 2, 2, { domain: 'blg.it' }));
      if (url.includes('advertiserId=3003')) return fakeResponse('<html>Too Many Requests</html>', 429);
      return fakeResponse({ '@odata.count': 0, value: [] });
    },
  };
  const res = await search({ domain: 'babylovegrowth.ai', brand: 'BLG' }, ctx);
  assert.ok(n > 0);
  assert.equal(res.status, 'rate_limited');
  assert.deepEqual(res.ads, []);
  assert.deepEqual(res.advertisers, []);
});

// ---- Microsoft outage 2026-10-14: every Ads?searchText request answers 500 / 503 ----

test('search() retries a 5xx twice and continues normally when it recovers', async () => {
  let failures = 2;
  const delays = [];
  const ctx = {
    settings: { bingAdvertisers: 6 },
    retryDelay(attempt) { delays.push(attempt); return 0; },
    async fetch(url) {
      if (url.includes('/Advertisers?')) {
        if (failures > 0) { failures -= 1; return fakeResponse('', 503); }
        return fakeResponse(ADVERTISERS);
      }
      if (url.includes('advertiserId=1001')) return fakeResponse(ADS);
      return fakeResponse({ '@odata.count': 0, value: [] });
    },
  };
  const res = await search({ domain: 'decathlon.com', brand: 'Decathlon' }, ctx);
  assert.equal(res.status, 'ok');
  assert.deepEqual(delays, [0, 1]);
  assert.deepEqual(res.ads.map((a) => a.id).sort(), ['5001', '5002']);
  assert.ok(!/Microsoft's side/.test(res.message));
});

test('search() is unavailable, not empty or error, when every Ads search returns 500', async () => {
  let adsCalls = 0;
  const ctx = {
    settings: { bingAdvertisers: 6 },
    retryDelay: () => 0,
    async fetch(url) {
      if (url.includes('/Advertisers?')) return fakeResponse({ value: [{ AdvertiserId: 3002, AdvertiserName: 'BLG srl' }] });
      adsCalls += 1;
      return fakeResponse('', 500);
    },
  };
  const res = await search({ domain: 'babylovegrowth.ai', brand: 'BLG' }, ctx);
  assert.equal(res.status, 'unavailable');
  assert.equal(res.message, "Microsoft Ad Library is not responding on Microsoft's side (HTTP 500), try again later");
  // The advertiser's ads query ran 3 attempts; the domain text search ran once (never retried).
  assert.equal(adsCalls, 4);
  assert.deepEqual(res.ads, []);
  assert.deepEqual(res.advertisers, []);
});

test('search() keeps confirmed ads when one query fails with 500, adding a note', async () => {
  const ctx = {
    settings: { bingAdvertisers: 6 },
    retryDelay: () => 0,
    async fetch(url) {
      if (url.includes('/Advertisers?')) return fakeResponse(ADVERTISERS);
      if (url.includes('advertiserId=1001')) return fakeResponse(ADS);
      if (url.includes('searchText=')) return fakeResponse('', 500);
      return fakeResponse({ '@odata.count': 0, value: [] });
    },
  };
  const res = await search({ domain: 'decathlon.com', brand: 'Decathlon' }, ctx);
  assert.equal(res.status, 'ok');
  assert.match(res.message, /, Microsoft's ad text search is down, searched by advertiser$/);
  assert.deepEqual(res.ads.map((a) => a.id).sort(), ['5001', '5002']);
});

test('search() keeps the failure note when an ads-by-advertiser call fails with 500', async () => {
  const ctx = {
    settings: { bingAdvertisers: 6 },
    retryDelay: () => 0,
    async fetch(url) {
      if (url.includes('/Advertisers?')) return fakeResponse(ADVERTISERS);
      if (url.includes('advertiserId=1001')) return fakeResponse(ADS);
      if (url.includes('advertiserId=1002')) return fakeResponse('', 500);
      return fakeResponse({ '@odata.count': 0, value: [] });
    },
  };
  const res = await search({ domain: 'decathlon.com', brand: 'Decathlon' }, ctx);
  assert.equal(res.status, 'ok');
  assert.match(res.message, /, some Microsoft searches failed on Microsoft's side$/);
});

test('search() falls back to an advertiser search for the domain label when the text search is down', async () => {
  const urls = [];
  const ctx = {
    settings: { bingAdvertisers: 6 },
    retryDelay: () => 0,
    async fetch(url) {
      urls.push(url);
      if (url.includes('/Advertisers?searchText=pupilkarma&')) {
        return fakeResponse({ value: [{ AdvertiserId: 7001, AdvertiserName: 'Pupil Karma Sp. z o.o.', AdvertiserCountry: 'Poland' }] });
      }
      if (url.includes('/Advertisers?')) return fakeResponse({ value: [] });
      if (url.includes('advertiserId=7001')) {
        return fakeResponse({ '@odata.count': 1, value: [{ AdId: 9001, AdvertiserId: 7001, AdvertiserName: 'Pupil Karma Sp. z o.o.', Title: 'Karma dla psa', DestinationUrl: 'https://pupilkarma.pl/psy' }] });
      }
      if (url.includes('searchText=')) return fakeResponse('', 500);
      return fakeResponse({ '@odata.count': 0, value: [] });
    },
  };
  const res = await search({ domain: 'pupilkarma.pl', brand: 'Pupil Karma' }, ctx);
  assert.equal(res.status, 'ok');
  assert.equal(res.message, "1 ads, 1 pointing to pupilkarma.pl, Microsoft's ad text search is down, searched by advertiser");
  assert.deepEqual(res.ads.map((a) => a.id), ['9001']);
  assert.ok(urls.some((u) => u.includes('/Advertisers?searchText=pupilkarma.pl&')));
  assert.equal(urls.filter((u) => u.includes('advertiserId=7001')).length, 1);
});

test('search() is empty, not unavailable, when only the text search is down and nothing is found', async () => {
  const ctx = {
    settings: { bingAdvertisers: 6 },
    retryDelay: () => 0,
    async fetch(url) {
      if (url.includes('/Advertisers?')) return fakeResponse({ value: [] });
      return fakeResponse('', 500);
    },
  };
  const res = await search({ domain: 'pupilkarma.pl', brand: 'Pupil Karma' }, ctx);
  assert.equal(res.status, 'empty');
  assert.equal(res.message, "No Bing ads point to pupilkarma.pl (searched advertisers: Pupil Karma, pupilkarma, pupilkarma.pl; Microsoft's ad text search is down)");
  assert.deepEqual(res.ads, []);
  assert.deepEqual(res.advertisers, []);
});

test('search() never retries a 500 on the text search and runs the advertiser fallback', async () => {
  const urls = [];
  const ctx = {
    settings: { bingAdvertisers: 6 },
    retryDelay: () => 0,
    async fetch(url) {
      urls.push(url);
      if (url.includes('/Advertisers?')) return fakeResponse({ value: [] });
      return fakeResponse('', 500);
    },
  };
  const res = await search({ domain: 'drmalou.com', brand: 'Dr Malou' }, ctx);
  assert.equal(urls.filter((u) => u.includes('/Ads?searchText=')).length, 1);
  assert.ok(urls.some((u) => u.includes('/Advertisers?searchText=drmalou&')));
  assert.ok(urls.some((u) => u.includes('/Advertisers?searchText=drmalou.com&')));
  assert.equal(res.status, 'empty');
  assert.match(res.message, /Microsoft's ad text search is down\)$/);
});

test('search() treats a 429 on the text search as non-fatal and runs the advertiser fallback', async () => {
  const urls = [];
  const delays = [];
  const ctx = {
    settings: { bingAdvertisers: 6 },
    retryDelay(attempt) { delays.push(attempt); return 0; },
    async fetch(url) {
      urls.push(url);
      if (url.includes('/Advertisers?')) return fakeResponse({ value: [] });
      return fakeResponse('<html>Too Many Requests</html>', 429);
    },
  };
  const res = await search({ domain: 'drmalou.com', brand: 'Dr Malou' }, ctx);
  assert.equal(urls.filter((u) => u.includes('/Ads?searchText=')).length, 3);
  // Two 429 retries, then one cooldown before the fallback.
  assert.deepEqual(delays, [0, 1, 1]);
  assert.ok(urls.some((u) => u.includes('/Advertisers?searchText=drmalou&')));
  assert.equal(res.status, 'empty');
  assert.equal(res.message, "No Bing ads point to drmalou.com (searched advertisers: Dr Malou, drmalou, drmalou.com; Microsoft's ad text search is rate limited)");
});

test('search() keeps ads found by the fallback when the text search is rate limited', async () => {
  const ctx = {
    settings: { bingAdvertisers: 6 },
    retryDelay: () => 0,
    async fetch(url) {
      if (url.includes('/Advertisers?searchText=pupilkarma&')) {
        return fakeResponse({ value: [{ AdvertiserId: 7001, AdvertiserName: 'Pupil Karma Sp. z o.o.' }] });
      }
      if (url.includes('/Advertisers?')) return fakeResponse({ value: [] });
      if (url.includes('advertiserId=7001')) {
        return fakeResponse({ '@odata.count': 1, value: [{ AdId: 9001, AdvertiserId: 7001, AdvertiserName: 'Pupil Karma Sp. z o.o.', Title: 'Karma', DestinationUrl: 'https://pupilkarma.pl/psy' }] });
      }
      return fakeResponse('<html>Too Many Requests</html>', 429);
    },
  };
  const res = await search({ domain: 'pupilkarma.pl', brand: 'Pupil Karma' }, ctx);
  assert.equal(res.status, 'ok');
  assert.equal(res.message, "1 ads, 1 pointing to pupilkarma.pl, Microsoft's ad text search is rate limited, searched by advertiser");
});

test('search() is still rate_limited when the advertiser search stays 429', async () => {
  let textCalls = 0;
  const ctx = {
    settings: { bingAdvertisers: 6 },
    retryDelay: () => 0,
    async fetch(url) {
      if (url.includes('/Ads?searchText=')) { textCalls += 1; return fakeResponse({ '@odata.count': 0, value: [] }); }
      return fakeResponse('<html>Too Many Requests</html>', 429);
    },
  };
  const res = await search({ domain: 'drmalou.com', brand: 'Dr Malou' }, ctx);
  assert.equal(res.status, 'rate_limited');
  assert.equal(textCalls, 0);
});

test('search() stays unavailable when the advertiser search itself returns 500', async () => {
  const ctx = {
    settings: { bingAdvertisers: 6 },
    retryDelay: () => 0,
    async fetch() {
      return fakeResponse('', 500);
    },
  };
  const res = await search({ domain: 'pupilkarma.pl', brand: 'Pupil Karma' }, ctx);
  assert.equal(res.status, 'unavailable');
  assert.equal(res.message, "Microsoft Ad Library is not responding on Microsoft's side (HTTP 500), try again later");
});

test('search() treats a fetch timeout as unavailable, not a failed adapter', async () => {
  const ctx = {
    settings: { bingAdvertisers: 6 },
    retryDelay: () => 0,
    async fetch() {
      const err = new Error('The operation timed out.');
      err.name = 'TimeoutError';
      throw err;
    },
  };
  const res = await search({ domain: 'babylovegrowth.ai', brand: 'BLG' }, ctx);
  assert.equal(res.status, 'unavailable');
  assert.match(res.message, /\(timeout\)/);
});

test('search() still ends as error on a non-5xx HTTP error such as 400', async () => {
  let calls = 0;
  const ctx = {
    settings: { bingAdvertisers: 6 },
    retryDelay: () => 0,
    async fetch() {
      calls += 1;
      return fakeResponse('bad request', 400);
    },
  };
  const res = await search({ domain: 'decathlon.com', brand: 'Decathlon' }, ctx);
  assert.equal(res.status, 'error');
  assert.equal(res.message, 'Microsoft Ad Library returned HTTP 400');
  assert.equal(calls, 2);
});

function fakeMemory(initial = {}) {
  const data = { ...initial };
  return {
    data,
    async get(k) { return data[k]; },
    async set(k, v) { data[k] = v; },
    async remove(k) { delete data[k]; },
  };
}

test('search() text search 500 sets the breaker for an hour and is sent as an expected failure', async () => {
  const memory = fakeMemory();
  const inits = [];
  const ctx = {
    settings: { bingAdvertisers: 6 },
    retryDelay: () => 0,
    memory,
    async fetch(url, init) {
      inits.push({ url, expectedFailure: !!(init && init.expectedFailure) });
      if (url.includes('/Advertisers?')) return fakeResponse({ value: [] });
      return fakeResponse('', 500);
    },
  };
  const before = Date.now();
  const res = await search({ domain: 'drmalou.com', brand: 'Dr Malou' }, ctx);
  assert.equal(res.status, 'empty');
  assert.ok(memory.data[TEXT_DOWN_KEY] >= before + TEXT_DOWN_MS);
  assert.ok(memory.data[TEXT_DOWN_KEY] <= Date.now() + TEXT_DOWN_MS);
  // Only the text search tolerates failure; advertiser searches keep their warnings.
  assert.deepEqual(inits.filter((i) => i.expectedFailure).map((i) => i.url.includes('/Ads?searchText=')), [true]);
  assert.ok(inits.filter((i) => !i.url.includes('/Ads?searchText=')).every((i) => !i.expectedFailure));
});

test('search() text search 429 also sets the breaker', async () => {
  const memory = fakeMemory();
  const ctx = {
    settings: { bingAdvertisers: 6 },
    retryDelay: () => 0,
    memory,
    async fetch(url) {
      if (url.includes('/Advertisers?')) return fakeResponse({ value: [] });
      return fakeResponse('<html>Too Many Requests</html>', 429);
    },
  };
  await search({ domain: 'drmalou.com', brand: 'Dr Malou' }, ctx);
  assert.ok(memory.data[TEXT_DOWN_KEY] > Date.now());
});

test('search() skips the text search while the breaker is set, message unchanged', async () => {
  const until = Date.now() + 30 * 60 * 1000;
  const memory = fakeMemory({ [TEXT_DOWN_KEY]: until });
  const urls = [];
  const logs = [];
  const progress = [];
  const ctx = {
    settings: { bingAdvertisers: 6 },
    retryDelay: () => 0,
    memory,
    log: (level, msg) => logs.push({ level, msg }),
    progress: (t) => progress.push(t),
    async fetch(url) {
      urls.push(url);
      if (url.includes('/Advertisers?')) return fakeResponse({ value: [] });
      return fakeResponse('', 500);
    },
  };
  const res = await search({ domain: 'drmalou.com', brand: 'Dr Malou' }, ctx);
  assert.equal(urls.filter((u) => u.includes('/Ads?searchText=')).length, 0);
  assert.ok(urls.some((u) => u.includes('/Advertisers?searchText=drmalou&')));
  assert.ok(urls.some((u) => u.includes('/Advertisers?searchText=drmalou.com&')));
  assert.equal(res.status, 'empty');
  assert.equal(res.message, "No Bing ads point to drmalou.com (searched advertisers: Dr Malou, drmalou, drmalou.com; Microsoft's ad text search is down)");
  assert.deepEqual(logs, [{ level: 'info', msg: 'Microsoft ad text search skipped, it failed in the last hour' }]);
  assert.ok(progress.includes('Microsoft ad text search skipped, it failed in the last hour'));
  assert.equal(memory.data[TEXT_DOWN_KEY], until);
});

test('logHttpStatus: an expected text search 500 is info, any other 5xx stays a warning', () => {
  const seen = [];
  const off = onEntry((e) => seen.push(e));
  try {
    logHttpStatus('bing', 500, 'https://adlibrary.api.bingads.microsoft.com/api/v1/Ads?searchText=drmalou.com&top=24', { expectedFailure: true });
    logHttpStatus('bing', 500, 'https://adlibrary.api.bingads.microsoft.com/api/v1/Advertisers?searchText=drmalou&top=20');
    assert.equal(logHttpStatus('bing', 200, 'https://adlibrary.api.bingads.microsoft.com/api/v1/Ads'), null);
  } finally {
    off();
  }
  assert.deepEqual(seen.map((e) => [e.level, e.msg]), [
    ['info', 'HTTP 500 adlibrary.api.bingads.microsoft.com/api/v1/Ads (expected, handled)'],
    ['warn', 'HTTP 500 adlibrary.api.bingads.microsoft.com/api/v1/Advertisers'],
  ]);
});

test('logHttpStatus: a retried status is info, the final give-up warns once', () => {
  const seen = [];
  const off = onEntry((e) => seen.push(e));
  try {
    logHttpStatus('bing', 429, 'https://adlibrary.api.bingads.microsoft.com/api/v1/Advertisers?searchText=x', { retrying: true });
    logHttpStatus('bing', 429, 'https://adlibrary.api.bingads.microsoft.com/api/v1/Advertisers?searchText=x');
  } finally {
    off();
  }
  assert.deepEqual(seen.map((e) => [e.level, e.msg]), [
    ['info', 'HTTP 429 adlibrary.api.bingads.microsoft.com/api/v1/Advertisers (retrying)'],
    ['warn', 'HTTP 429 adlibrary.api.bingads.microsoft.com/api/v1/Advertisers'],
  ]);
});

test('search() marks only attempts it will retry: a recovered 429 never reaches warn level', async () => {
  const sent = [];
  let advCalls = 0;
  const ctx = {
    settings: { bingAdvertisers: 6 },
    retryDelay: () => 0,
    async fetch(url, init) {
      sent.push({ url, retryStatuses: init.retryStatuses || [] });
      if (url.includes('/Advertisers?')) {
        advCalls += 1;
        if (advCalls === 1) return fakeResponse('<html>Too Many Requests</html>', 429);
        return fakeResponse({ value: [] });
      }
      return fakeResponse({ '@odata.count': 0, value: [] });
    },
  };
  await search({ domain: 'drmalou.com', brand: 'Dr Malou' }, ctx);
  // First advertiser attempt: 429 and 5xx would be retried.
  assert.ok(sent[0].retryStatuses.includes(429));
  assert.ok(sent[0].retryStatuses.includes(500));
  // Text search: no 5xx retries, so only 429 is marked.
  const text = sent.find((s) => s.url.includes('/Ads?searchText='));
  assert.deepEqual(text.retryStatuses, [429]);
});

test('search() final 429 attempt is not marked as retrying, so it warns', async () => {
  const sent = [];
  const ctx = {
    settings: { bingAdvertisers: 6 },
    retryDelay: () => 0,
    async fetch(url, init) {
      sent.push(init.retryStatuses || []);
      return fakeResponse('<html>Too Many Requests</html>', 429);
    },
  };
  const res = await search({ domain: 'drmalou.com', brand: 'Dr Malou' }, ctx);
  assert.equal(res.status, 'rate_limited');
  assert.equal(sent.length, MAX_429_RETRIES + 1);
  assert.ok(sent[MAX_429_RETRIES - 1].includes(429));
  assert.ok(!sent[MAX_429_RETRIES].includes(429));
});

test('search() treats a timeout thrown by ctx.fetch on the text search as textServerError (empty, circuit breaker set)', async () => {
  const memory = fakeMemory();
  const before = Date.now();
  const ctx = {
    settings: { bingAdvertisers: 6 },
    retryDelay: () => 0,
    memory,
    async fetch(url) {
      if (url.includes('/Advertisers?')) return fakeResponse({ value: [] });
      const err = new Error('signal timed out');
      err.name = 'TimeoutError';
      throw err;
    },
  };
  const res = await search({ domain: 'drmalou.com', brand: 'Dr Malou' }, ctx);
  assert.equal(res.status, 'empty');
  assert.match(res.message, /Microsoft's ad text search is down/);
  assert.ok(memory.data[TEXT_DOWN_KEY] >= before + TEXT_DOWN_MS);
});

test('search() clears an expired breaker when the text search answers again', async () => {
  const memory = fakeMemory({ [TEXT_DOWN_KEY]: Date.now() - 1 });
  const urls = [];
  const ctx = {
    settings: { bingAdvertisers: 6 },
    retryDelay: () => 0,
    memory,
    async fetch(url) {
      urls.push(url);
      if (url.includes('/Advertisers?')) return fakeResponse({ value: [] });
      return fakeResponse({ '@odata.count': 0, value: [] });
    },
  };
  const res = await search({ domain: 'drmalou.com', brand: 'Dr Malou' }, ctx);
  assert.equal(urls.filter((u) => u.includes('/Ads?searchText=')).length, 1);
  assert.equal(TEXT_DOWN_KEY in memory.data, false);
  assert.equal(res.status, 'empty');
  assert.equal(res.message, 'No Bing ads point to drmalou.com (searched: Dr Malou)');
});
