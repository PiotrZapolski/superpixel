import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  detectTags,
  extractSeeds,
  splitHtml,
  unescapeContainer,
  detectTagsInContainer,
  containerIds,
  gtagLoaderIds,
  mergeTags,
} from '../detect/detect.js';
import { SIGNATURES } from '../detect/signatures.js';
import { probe } from '../detect/page-probe.js';

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const SITE_HTML = fixture('site.html');
const RESOURCE_URLS = JSON.parse(fixture('resource-urls.json'));

function idsByPlatform(tags) {
  const out = {};
  for (const t of tags) out[t.platform] = [...t.ids].sort();
  return out;
}

test('signature table covers every spec platform with valid shapes', () => {
  const names = SIGNATURES.map((s) => s.platform);
  for (const p of [
    'Meta Pixel', 'Google Ads', 'Google Analytics 4', 'Universal Analytics', 'Google Tag Manager',
    'Google Floodlight', 'LinkedIn Insight', 'TikTok Pixel', 'X (Twitter) Pixel', 'Pinterest Tag',
    'Snap Pixel', 'Reddit Pixel', 'Microsoft UET', 'Quora Pixel', 'Taboola', 'Outbrain', 'Criteo',
    'Amazon Ads', 'HubSpot', 'Microsoft Clarity', 'Hotjar', 'AdRoll', 'Yandex Metrica', 'Klaviyo',
  ]) {
    assert.ok(names.includes(p), `missing signature ${p}`);
  }
  for (const s of SIGNATURES) {
    assert.ok(['ads', 'analytics', 'tag-manager', 'crm'].includes(s.category), s.platform);
    assert.ok(Array.isArray(s.globals), s.platform);
    for (const p of s.patterns) {
      assert.ok(p.re instanceof RegExp, s.platform);
      assert.ok(!p.re.flags.includes('g'), `${s.platform} regex must not be global`);
      assert.ok(['url', 'html', 'any'].includes(p.where), s.platform);
    }
  }
});

test('detectTags finds IDs in inline html', () => {
  const tags = detectTags({ html: SITE_HTML });
  const ids = idsByPlatform(tags);
  assert.deepEqual(ids['Google Tag Manager'], ['GTM-ABC1234']);
  assert.deepEqual(ids['Google Analytics 4'], ['G-7XK2P9QRST']);
  assert.deepEqual(ids['Google Ads'], ['AW-987654321']);
  assert.deepEqual(ids['Meta Pixel'], ['123456789012345']);
  assert.deepEqual(ids['TikTok Pixel'], ['C4ABCDEFGHIJ1234567K']);
  assert.deepEqual(ids['LinkedIn Insight'], ['1234567']);
  assert.deepEqual(ids['Microsoft UET'], ['56012345']);
  assert.deepEqual(ids['Pinterest Tag'], ['2612345678901']);
  // Nothing that is not on the page.
  for (const absent of ['Snap Pixel', 'Reddit Pixel', 'Hotjar', 'Criteo', 'Universal Analytics', 'Amazon Ads']) {
    assert.equal(ids[absent], undefined, `${absent} should not be detected`);
  }
});

test('detectTags finds IDs in resource urls', () => {
  const ids = idsByPlatform(detectTags({ resourceUrls: RESOURCE_URLS }));
  assert.deepEqual(ids['Google Tag Manager'], ['GTM-ABC1234']);
  assert.deepEqual(ids['Google Analytics 4'], ['G-7XK2P9QRST']);
  assert.deepEqual(ids['Google Ads'], ['AW-987654321']);
  assert.deepEqual(ids['Meta Pixel'], ['123456789012345']);
  assert.deepEqual(ids['TikTok Pixel'], ['C4ABCDEFGHIJ1234567K']);
  assert.deepEqual(ids['LinkedIn Insight'], ['1234567']);
  assert.deepEqual(ids['Microsoft UET'], ['56012345']);
  assert.deepEqual(ids['Pinterest Tag'], ['2612345678901']);
  assert.deepEqual(ids['Microsoft Clarity'], ['abcd1234ef']);
  assert.deepEqual(ids['Hotjar'], ['3456789']);
  assert.deepEqual(ids['HubSpot'], ['7654321']);
  assert.deepEqual(ids['X (Twitter) Pixel'], ['o1abc']);
});

test('detectTags dedupes ids, caps evidence and sorts by category then platform', () => {
  const tags = detectTags({ resourceUrls: RESOURCE_URLS, html: SITE_HTML });
  const meta = tags.find((t) => t.platform === 'Meta Pixel');
  assert.deepEqual(meta.ids, ['123456789012345']);
  assert.ok(meta.evidence.length >= 1 && meta.evidence.length <= 3);
  for (const t of tags) assert.ok(t.evidence.length <= 3, t.platform);

  const order = ['ads', 'analytics', 'tag-manager', 'crm'];
  for (let i = 1; i < tags.length; i++) {
    const a = tags[i - 1];
    const b = tags[i];
    const ca = order.indexOf(a.category);
    const cb = order.indexOf(b.category);
    assert.ok(ca < cb || (ca === cb && a.platform.localeCompare(b.platform) <= 0), `${a.platform} before ${b.platform}`);
  }
  assert.equal(tags[0].category, 'ads');
  assert.equal(tags[tags.length - 1].category, 'crm');
});

test('no GA4 false positive from random G- strings outside a gtag script', () => {
  const html = `<html><body>
    <p>Use promo code G-ABCDEFGH at checkout.</p>
    <script>var promo = {code: "G-ZZZZ9999"};</script>
    <noscript><iframe src="https://www.googletagmanager.com/ns.html?id=GTM-QWERTY1"></iframe></noscript>
  </body></html>`;
  const ids = idsByPlatform(detectTags({ html }));
  assert.equal(ids['Google Analytics 4'], undefined);
  assert.deepEqual(ids['Google Tag Manager'], ['GTM-QWERTY1']);

  // The full fixture also contains G-ABCDEFGH / G-ZZZZ9999 in body text and a non-gtag script.
  const full = idsByPlatform(detectTags({ html: SITE_HTML }));
  assert.deepEqual(full['Google Analytics 4'], ['G-7XK2P9QRST']);
});

test('GA4 accepted from collect url with tid=G-', () => {
  const ids = idsByPlatform(
    detectTags({ resourceUrls: ['https://www.google-analytics.com/g/collect?v=2&tid=G-AB12CD34EF&cid=1'] })
  );
  assert.deepEqual(ids['Google Analytics 4'], ['G-AB12CD34EF']);
});

test('detectTags reads globals (container keys, pixel ids, presence)', () => {
  const tags = detectTags({
    globals: {
      googleTagManagerKeys: ['GTM-XYZ9876', 'G-ABC123XYZ', 'AW-111222333', 'dataLayer'],
      fbPixelIds: ['999888777666555', 'not-an-id'],
      ttqIds: ['CABCDEFGHIJKLMNOPQRS'],
      linkedinPartnerIds: [7654321],
      hotjarId: '1234567',
      adroll: { adv: 'ABCDEFGHIJKLMNOPQRSTUV', pix: 'ZYXWVUTSRQPONMLKJIHGFE' },
      present: { uetq: true, clarity: true, dataLayer: true, klaviyo: true, twq: false },
    },
  });
  const ids = idsByPlatform(tags);
  assert.deepEqual(ids['Google Tag Manager'], ['GTM-XYZ9876']);
  assert.deepEqual(ids['Google Analytics 4'], ['G-ABC123XYZ']);
  assert.deepEqual(ids['Google Ads'], ['AW-111222333']);
  assert.deepEqual(ids['Meta Pixel'], ['999888777666555']);
  assert.deepEqual(ids['TikTok Pixel'], ['CABCDEFGHIJKLMNOPQRS']);
  assert.deepEqual(ids['LinkedIn Insight'], ['7654321']);
  assert.deepEqual(ids['Hotjar'], ['1234567']);
  assert.deepEqual(ids['AdRoll'], ['ABCDEFGHIJKLMNOPQRSTUV', 'ZYXWVUTSRQPONMLKJIHGFE']);

  const uet = tags.find((t) => t.platform === 'Microsoft UET');
  assert.deepEqual(uet.ids, []);
  assert.deepEqual(uet.evidence, ['window.uetq']);
  assert.ok(tags.find((t) => t.platform === 'Microsoft Clarity'));
  assert.ok(tags.find((t) => t.platform === 'Klaviyo'));
  assert.equal(tags.find((t) => t.platform === 'X (Twitter) Pixel'), undefined);
});

test('presence global does not duplicate a platform already found with ids', () => {
  const tags = detectTags({
    resourceUrls: ['https://bat.bing.com/action/0?ti=56012345&Ver=2'],
    globals: { present: { uetq: true } },
  });
  const uet = tags.filter((t) => t.platform === 'Microsoft UET');
  assert.equal(uet.length, 1);
  assert.deepEqual(uet[0].ids, ['56012345']);
  assert.ok(!uet[0].evidence.includes('window.uetq'));
});

test('detectTags tolerates empty input', () => {
  assert.deepEqual(detectTags({}), []);
  assert.deepEqual(detectTags(), []);
});

test('splitHtml separates script blocks from markup', () => {
  const { scripts, rest } = splitHtml('<p>a</p><script>x()</script><div>b</div><script src="y.js"></script>');
  assert.equal(scripts.length, 2);
  assert.ok(!rest.includes('x()'));
  assert.ok(rest.includes('<div>b</div>'));
});

test('extractSeeds: brand from JSON-LD, candidates and domain label', () => {
  const tags = detectTags({ html: SITE_HTML });
  const seeds = extractSeeds({ domain: 'https://www.acme-outdoor.com/', html: SITE_HTML, tags });
  assert.equal(seeds.domain, 'acme-outdoor.com');
  assert.equal(seeds.brand, 'Acme Outdoor');
  assert.deepEqual(seeds.brandCandidates, ['Acme Outdoor', 'Acme Outdoor Store', 'Acme', 'acme-outdoor']);
  assert.deepEqual(seeds.ids['Meta Pixel'], ['123456789012345']);
  assert.deepEqual(seeds.ids['Google Tag Manager'], ['GTM-ABC1234']);
});

test('extractSeeds: meta.jsonLd strings, invalid JSON and title split', () => {
  const seeds = extractSeeds({
    domain: 'www.decathlon.co.uk',
    title: 'Decathlon UK \u2013 Sports Equipment',
    meta: { jsonLd: ['not json {', '[{"@type":["Organization"],"name":"Decathlon"}]'] },
  });
  assert.equal(seeds.brand, 'Decathlon');
  assert.deepEqual(seeds.brandCandidates, ['Decathlon', 'Decathlon UK']);
  assert.equal(seeds.domain, 'decathlon.co.uk');
});

test('extractSeeds: falls back to the domain label without any page data', () => {
  const seeds = extractSeeds({ domain: 'shop.nike.com' });
  assert.equal(seeds.brand, 'nike');
  assert.deepEqual(seeds.brandCandidates, ['nike']);
  assert.deepEqual(seeds.social.facebook, []);
  assert.deepEqual(seeds.ids, {});
});

test('extractSeeds: social links are filtered and normalised', () => {
  const seeds = extractSeeds({ domain: 'acme-outdoor.com', html: SITE_HTML });
  const s = seeds.social;
  assert.deepEqual(s.facebook, ['https://www.facebook.com/acmeoutdoor']);
  assert.ok(!s.facebook.some((u) => u.includes('sharer')));
  assert.deepEqual(s.instagram, ['https://www.instagram.com/acme.outdoor']);
  assert.deepEqual(s.linkedin, [
    'https://www.linkedin.com/company/acme-outdoor-inc',
    'https://www.linkedin.com/company/1234567',
  ]);
  assert.deepEqual(s.tiktok, ['https://www.tiktok.com/@acmeoutdoor']);
  assert.deepEqual(s.youtube, ['https://www.youtube.com/@AcmeOutdoor']);
  assert.deepEqual(s.x, ['https://x.com/acmeoutdoor']);
  assert.deepEqual(s.pinterest, ['https://www.pinterest.com/acmeoutdoor/']);
});

test('probe is self-contained (serialisable for chrome.scripting)', () => {
  const src = probe.toString();
  assert.ok(src.startsWith('function probe()'));
  assert.ok(!/\bimport\b/.test(src));
  assert.ok(!src.includes('chrome.'));
});

// ---- live findings 2026-09-26: consent banners hide pixels; weak presence hits ----

const GTM_CONTAINER = fixture('gtm-container.js');

test('unescapeContainer turns escaped quotes, \\u003C and \\/ into plain characters', () => {
  assert.equal(unescapeContainer('\\"vtp_pixelId\\":\\"1\\"'), '"vtp_pixelId":"1"');
  assert.equal(unescapeContainer('a.load(\\\\\\"X\\\\\\")'), 'a.load("X")');
  assert.equal(unescapeContainer('\\u003Cscript\\u003E\\/\\/x'), '<script>//x');
  assert.equal(unescapeContainer(''), '');
  assert.equal(unescapeContainer(null), '');
});

test('detectTagsInContainer finds pixels configured in a GTM container', () => {
  const tags = detectTagsInContainer(GTM_CONTAINER, { evidence: 'GTM container GTM-M7VSTNNQ' });
  const ids = idsByPlatform(tags);
  assert.deepEqual(ids['Meta Pixel'], ['1488345105464802']);
  assert.deepEqual(ids['TikTok Pixel'], ['D451OCJC77U1GG09RADG']);
  assert.deepEqual(ids['Google Ads'], ['AW-16911376865']);
  assert.deepEqual(ids['Google Analytics 4'], ['G-WHR3NL5TTJ']);
  assert.deepEqual(ids['LinkedIn Insight'], ['5432101']);
  assert.deepEqual(ids['Microsoft UET'], ['187000123']);
  assert.deepEqual(ids['Google Tag Manager'], ['GTM-M7VSTNNQ']);
  // Runtime mentions of vendor hosts without ids are not tags.
  assert.equal(ids['Google Floodlight'], undefined);
  assert.equal(ids['Reddit Pixel'], undefined);
  for (const t of tags) {
    assert.equal(t.source, 'container');
    assert.deepEqual(t.evidence, ['GTM container GTM-M7VSTNNQ']);
    assert.ok(t.ids.length > 0);
  }
});

test('detectTagsInContainer: near-context and platform allow-list', () => {
  const far = '"vtp_partnerId":"5432101"' + ' '.repeat(5000) + 'linkedin';
  assert.equal(idsByPlatform(detectTagsInContainer(far))['LinkedIn Insight'], undefined);
  const near = '{"function":"__bzi","vtp_partnerId":"5432101"}';
  assert.deepEqual(idsByPlatform(detectTagsInContainer(near))['LinkedIn Insight'], ['5432101']);
  // gtag.js: only Google destinations.
  const gtag = detectTagsInContainer(GTM_CONTAINER, { evidence: 'Google tag G-WHR3NL5TTJ', platforms: ['Google Ads', 'Google Analytics 4', 'Google Floodlight'] });
  assert.deepEqual(gtag.map((t) => t.platform).sort(), ['Google Ads', 'Google Analytics 4']);
  assert.deepEqual(detectTagsInContainer(''), []);
});

test('containerIds and gtagLoaderIds pick ids to fetch (max 3)', () => {
  const tags = [{ platform: 'Google Tag Manager', ids: ['GTM-AAAA1', 'GTM-BBBB2', 'GTM-CCCC3', 'GTM-DDDD4'] }, { platform: 'Meta Pixel', ids: ['1'] }];
  assert.deepEqual(containerIds(tags), ['GTM-AAAA1', 'GTM-BBBB2', 'GTM-CCCC3']);
  assert.deepEqual(containerIds([]), []);
  assert.deepEqual(gtagLoaderIds({ resourceUrls: RESOURCE_URLS }), ['G-7XK2P9QRST']);
  assert.deepEqual(
    gtagLoaderIds({ html: '<script async src="https://www.googletagmanager.com/gtag/js?id=AW-16911376865&amp;l=dataLayer"></script>' }),
    ['AW-16911376865'],
  );
});

test('mergeTags adds container-only platforms and new ids, keeps page source', () => {
  const page = detectTags({ html: '<script async src="https://www.googletagmanager.com/gtm.js?id=GTM-M7VSTNNQ"></script>' });
  assert.ok(page.every((t) => t.source === 'page'));
  const merged = mergeTags(page, detectTagsInContainer(GTM_CONTAINER, { evidence: 'GTM container GTM-M7VSTNNQ' }));
  const byName = Object.fromEntries(merged.map((t) => [t.platform, t]));
  assert.equal(byName['Google Tag Manager'].source, 'page');
  assert.deepEqual(byName['Google Tag Manager'].ids, ['GTM-M7VSTNNQ']);
  assert.equal(byName['Meta Pixel'].source, 'container');
  assert.deepEqual(byName['Meta Pixel'].evidence, ['GTM container GTM-M7VSTNNQ']);
  // Sorted by category: ads first, tag manager after analytics.
  assert.equal(merged[0].category, 'ads');
  // Existing platform gains a new id with container evidence.
  const withAds = mergeTags(
    [{ platform: 'Google Ads', category: 'ads', ids: ['AW-1234567'], evidence: ['inline script'], source: 'page' }],
    [{ platform: 'Google Ads', category: 'ads', ids: ['AW-1234567', 'AW-16911376865'], evidence: ['GTM container GTM-X1234'], source: 'container' }],
  );
  assert.deepEqual(withAds[0].ids, ['AW-1234567', 'AW-16911376865']);
  assert.deepEqual(withAds[0].evidence, ['inline script', 'GTM container GTM-X1234']);
  assert.equal(withAds[0].source, 'page');
});

test('presence-only mentions in html (consent banner vendor lists) are dropped', () => {
  const html = `<html><head>
    <script>var cmpVendors = [{name:"Google Floodlight", hosts:["fls.doubleclick.net"]},
      {name:"Reddit", hosts:["alb.reddit.com","www.redditstatic.com/ads/pixel.js"]},
      {name:"Bing", script:"bat.bing.com/bat.js"}];</script>
    </head><body><p>We use tr.snapchat.com and amazon-adsystem.com</p></body></html>`;
  const tags = detectTags({ html });
  for (const p of ['Google Floodlight', 'Reddit Pixel', 'Microsoft UET', 'Snap Pixel', 'Amazon Ads']) {
    assert.equal(tags.find((t) => t.platform === p), undefined, `${p} should be dropped`);
  }
  // A loaded resource url or a pixel global still counts.
  const real = detectTags({
    html,
    resourceUrls: ['https://alb.reddit.com/rp.gif?id=t2_abc'],
    globals: { present: { uetq: true } },
  });
  assert.ok(real.find((t) => t.platform === 'Reddit Pixel'));
  assert.ok(real.find((t) => t.platform === 'Microsoft UET'));
  assert.equal(real.find((t) => t.platform === 'Google Floodlight'), undefined);
  // Ids found in inline scripts are kept.
  const withId = detectTags({ html: "<script>rdt('init','t2_abcdef');</script>" });
  assert.deepEqual(withId.find((t) => t.platform === 'Reddit Pixel').ids, ['t2_abcdef']);
});

test('probe counts only function/object globals as present', () => {
  const src = probe.toString();
  assert.match(src, /typeof v === 'function' \|\| typeof v === 'object'/);
});
