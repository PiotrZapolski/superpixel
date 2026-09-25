import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { meta, deepLinks, parseXsrf, buildSearchBody, parseCreatives, search } from '../adapters/google.js';

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const CREATIVES = fixture('google-search-creatives.json');

function decodeBody(body) {
  assert.ok(body.startsWith('f.req='));
  return decodeURIComponent(body.slice('f.req='.length));
}

test('meta describes the adapter', () => {
  assert.deepEqual(meta, { id: 'google', label: 'Google Ads (Search, YouTube, Display)', coverage: 'Global' });
});

test('parseXsrf reads the token from the homepage html', () => {
  const html = `<html><script>window.WIZ_global_data = {"x":1};var cfg = {apiKey: 'k', xsrfToken: 'AB12cd-_:1727222400000', region: 'anywhere'};</script></html>`;
  assert.equal(parseXsrf(html), 'AB12cd-_:1727222400000');
  assert.equal(parseXsrf('<html>signed out</html>'), null);
  assert.equal(parseXsrf(undefined), null);
});

test('buildSearchBody encodes the exact verified request', () => {
  assert.equal(
    decodeBody(buildSearchBody('decathlon.com')),
    '{"2":40,"3":{"12":{"1":"decathlon.com","2":true}},"7":{"1":1,"2":24,"3":2616}}'
  );
  const params = new URLSearchParams(buildSearchBody('decathlon.com'));
  assert.deepEqual(JSON.parse(params.get('f.req')), {
    2: 40,
    3: { 12: { 1: 'decathlon.com', 2: true } },
    7: { 1: 1, 2: 24, 3: 2616 },
  });
});

test('buildSearchBody adds the YouTube filter and the cursor', () => {
  assert.equal(
    decodeBody(buildSearchBody('decathlon.com', { youtube: true })),
    '{"2":40,"3":{"12":{"1":"decathlon.com","2":true},"14":[5]},"7":{"1":1,"2":24,"3":2616}}'
  );
  const withCursor = JSON.parse(decodeBody(buildSearchBody('decathlon.com', { cursor: 'CgoAP7zn==', youtube: true })));
  assert.equal(withCursor['4'], 'CgoAP7zn==');
  assert.deepEqual(withCursor['3']['14'], [5]);
  assert.deepEqual(withCursor['7'], { 1: 1, 2: 24, 3: 2616 });
  // '+' and '=' in cursors must survive form encoding.
  const tricky = new URLSearchParams(buildSearchBody('a.com', { cursor: 'a+b/c=' }));
  assert.equal(JSON.parse(tricky.get('f.req'))['4'], 'a+b/c=');
});

test('parseCreatives maps rows, dates, previews and match', () => {
  const { ads, cursor, totalRange, ok } = parseCreatives(CREATIVES, 'decathlon.com');
  assert.equal(ok, true);
  assert.equal(cursor, 'CgoAP7znOtJ9f2XrEhAAHm6H2sVb3aYv7qLqj0wA');
  assert.equal(totalRange, '1000-2000');
  assert.equal(ads.length, 3);

  const [a, b, c] = ads;
  assert.equal(a.platform, 'google');
  assert.equal(a.id, 'CR11111111111111111111');
  assert.equal(a.advertiserId, 'AR01234567890123456789');
  assert.equal(a.advertiserName, 'Decathlon SE');
  assert.equal(a.format, 'image');
  assert.equal(a.firstShown, '2024-07-01');
  assert.equal(a.lastShown, '2024-09-25');
  assert.equal(a.previewUrl, 'https://tpc.googlesyndication.com/archive/simgad/11111111111111111111?sqp=abc&rs=AOga4qm');
  assert.equal(
    a.detailUrl,
    'https://adstransparency.google.com/advertiser/AR01234567890123456789/creative/CR11111111111111111111?region=anywhere'
  );
  assert.equal(a.displayUrl, 'decathlon.com');
  assert.equal(a.match, 'confirmed');
  assert.deepEqual(a.placements, []);
  assert.equal(a.source, 'native');

  assert.equal(b.format, 'text');
  assert.equal(b.firstShown, '2024-01-01');
  assert.equal(b.lastShown, '2024-09-24');
  assert.ok(b.previewUrl.startsWith('https://displayads-formats.googleusercontent.com/ads/preview/content.js?'));
  assert.equal(b.match, 'confirmed');

  assert.equal(c.format, 'video');
  assert.equal(c.advertiserName, 'Sports Reseller GmbH');
  assert.equal(c.firstShown, '2024-08-01');
  assert.equal(c.lastShown, '2024-09-22');
  assert.equal(c.previewUrl, 'https://i.ytimg.com/vi/abcDEF12345/hqdefault.jpg');
  assert.equal(c.match, 'keyword');
});

test('parseCreatives accepts objects and flags empty / changed shapes', () => {
  const obj = parseCreatives(JSON.parse(CREATIVES), 'www.decathlon.com');
  assert.equal(obj.ads.length, 3);
  assert.equal(obj.ads[0].match, 'confirmed');

  const empty = parseCreatives('{}', 'decathlon.com');
  assert.equal(empty.ok, false);
  assert.equal(empty.empty, true);
  assert.deepEqual(empty.ads, []);

  const changed = parseCreatives('{"9":[1,2,3]}', 'decathlon.com');
  assert.equal(changed.ok, false);
  assert.equal(changed.empty, false);

  const junk = parseCreatives('<html>error</html>', 'decathlon.com');
  assert.equal(junk.ok, false);
  assert.deepEqual(junk.ads, []);
});

test('deepLinks include the domain search and the YouTube variant', () => {
  const links = deepLinks({ domain: 'decathlon.com' });
  assert.equal(links.length, 2);
  assert.ok(links[0].url.includes('domain=decathlon.com'));
  assert.ok(links[1].url.includes('platform=YOUTUBE'));
});

// ---- search() with a fake ctx (no network)

function fakeResponse(body, { status = 200, url = '' } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    url,
    text: async () => body,
  };
}

function fakeCtx(handler) {
  const calls = [];
  return {
    calls,
    settings: { maxPagesGoogle: 2 },
    signal: undefined,
    throttle: async () => {},
    progress: () => {},
    fetch: async (url, init = {}) => {
      calls.push({ url, init });
      return handler(url, init, calls.length);
    },
  };
}

test('search returns needs_user without an xsrf token', async () => {
  const ctx = fakeCtx(() => fakeResponse('<html>no token</html>'));
  const res = await search({ domain: 'decathlon.com' }, ctx);
  assert.equal(res.status, 'needs_user');
  assert.match(res.message, /Sign in to Google/);
  assert.equal(res.deepLinks.length, 2);
});

test('search returns needs_user on a captcha redirect', async () => {
  const ctx = fakeCtx(() => fakeResponse('captcha', { url: 'https://www.google.com/sorry/index?continue=x' }));
  const res = await search({ domain: 'decathlon.com' }, ctx);
  assert.equal(res.status, 'needs_user');
  assert.match(res.message, /captcha/);
});

test('search pages, sends the required headers and tags YouTube placements', async () => {
  const page2 = JSON.stringify({ 1: [], 4: '1000', 5: '2000' });
  const yt = JSON.stringify({
    1: [
      {
        1: 'AR09999999999999999999',
        2: 'CR33333333333333333333',
        4: 3,
        6: { 1: '1722470400' },
        7: { 1: '1726963200' },
        12: 'Sports Reseller GmbH',
        14: 'sportsreseller.de',
      },
    ],
  });
  const ctx = fakeCtx((url, init) => {
    if (!init.method) return fakeResponse("<script>var x = {xsrfToken: 'TOKEN123'};</script>");
    const req = JSON.parse(new URLSearchParams(init.body).get('f.req'));
    if (req['3']['14']) return fakeResponse(yt);
    return fakeResponse(req['4'] ? page2 : CREATIVES);
  });
  const res = await search({ domain: 'decathlon.com' }, ctx);
  assert.equal(res.status, 'ok');
  assert.equal(res.platform, 'google');
  assert.equal(res.ads.length, 3);
  assert.match(res.message, /1000-2000/);

  const post = ctx.calls.find((c) => c.init.method === 'POST');
  assert.equal(post.url, 'https://adstransparency.google.com/anji/_/rpc/SearchService/SearchCreatives?authuser=0');
  assert.equal(post.init.headers['X-Same-Domain'], '1');
  assert.equal(post.init.headers['X-Framework-Xsrf-Token'], 'TOKEN123');
  assert.match(post.init.headers['content-type'], /application\/x-www-form-urlencoded/);

  const video = res.ads.find((a) => a.id === 'CR33333333333333333333');
  assert.deepEqual(video.placements, ['youtube']);
  const image = res.ads.find((a) => a.id === 'CR11111111111111111111');
  assert.deepEqual(image.placements, []);

  const top = res.advertisers[0];
  assert.equal(top.id, 'AR01234567890123456789');
  assert.equal(top.confirmedCount, 2);
  assert.equal(top.url, 'https://adstransparency.google.com/advertiser/AR01234567890123456789?region=anywhere');
});

test('search maps HTTP 400 to changed', async () => {
  const ctx = fakeCtx((url, init) =>
    init.method ? fakeResponse('bad', { status: 400 }) : fakeResponse("xsrfToken: 'T'")
  );
  const res = await search({ domain: 'decathlon.com' }, ctx);
  assert.equal(res.status, 'changed');
});

test('search maps an exact {} body to empty', async () => {
  const ctx = fakeCtx((url, init) => (init.method ? fakeResponse('{}') : fakeResponse("xsrfToken: 'T'")));
  const res = await search({ domain: 'decathlon.com' }, ctx);
  assert.equal(res.status, 'empty');
});
