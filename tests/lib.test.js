import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeDomain,
  hostOf,
  registrableDomain,
  domainLabel,
  hostMatches,
  unwrapRedirect,
  stripTracking,
} from '../lib/domain.js';
import { sleep, withTimeout, walkJson, parseJsonLines, toIsoDate, uniq, pick } from '../lib/util.js';
import { decodeEntities, stripTags, attrValues, extractHrefs, splitByClass, firstClassText } from '../lib/html.js';
import {
  PLATFORM_ORDER,
  makeAd,
  makeAdvertiser,
  accountNote,
  advertiserSummary,
  makeResult,
  aggregateAdvertisers,
  promoteAdvertiserMatches,
  dedupeAds,
  assignRoles,
  cleanAdvertiserName,
  advertiserNameSeeds,
  nameQueries,
  keepConfirmedAdvertisers,
  shouldSaveLastScan,
} from '../lib/model.js';
import {
  MAX_ENTRIES,
  log,
  logWarn,
  logError,
  getLog,
  clearLog,
  safeUrl,
  errText,
  formatLogLines,
} from '../background/log.js';

// ---- lib/domain.js ----

test('normalizeDomain handles URLs, bare domains and whitespace', () => {
  assert.equal(normalizeDomain('https://www.Example.co.uk/path?x'), 'example.co.uk');
  assert.equal(normalizeDomain('example.com'), 'example.com');
  assert.equal(normalizeDomain(' www.example.com '), 'example.com');
  assert.equal(normalizeDomain('http://shop.example.com:8080/a#b'), 'shop.example.com');
  assert.equal(normalizeDomain('not a domain'), '');
  assert.equal(normalizeDomain('localhost'), '');
  assert.equal(normalizeDomain(''), '');
  assert.equal(normalizeDomain(null), '');
});

test('hostOf strips www and accepts protocol-less input', () => {
  assert.equal(hostOf('https://WWW.Decathlon.com/fr/x'), 'decathlon.com');
  assert.equal(hostOf('example.com/x'), 'example.com');
  assert.equal(hostOf('//cdn.example.com/a.js'), 'cdn.example.com');
  assert.equal(hostOf(''), '');
});

test('registrableDomain and domainLabel handle multi-part suffixes', () => {
  assert.equal(registrableDomain('shop.decathlon.co.uk'), 'decathlon.co.uk');
  assert.equal(registrableDomain('www.decathlon.co.uk'), 'decathlon.co.uk');
  assert.equal(registrableDomain('a.b.example.com'), 'example.com');
  assert.equal(registrableDomain('example.com'), 'example.com');
  assert.equal(registrableDomain('shop.allegro.com.pl'), 'allegro.com.pl');
  assert.equal(domainLabel('shop.decathlon.co.uk'), 'decathlon');
  assert.equal(domainLabel('decathlon.com'), 'decathlon');
});

test('hostMatches: subdomains, sibling TLDs, mismatches', () => {
  assert.equal(hostMatches('https://shop.decathlon.com/p/1', 'decathlon.com'), true);
  assert.equal(hostMatches('decathlon.com', 'decathlon.com'), true);
  assert.equal(hostMatches('https://www.decathlon.fr/', 'decathlon.com', { siblingTlds: true }), true);
  assert.equal(hostMatches('https://www.decathlon.fr/', 'decathlon.com', { siblingTlds: false }), false);
  assert.equal(hostMatches('https://decathlon.co.uk/x', 'decathlon.com'), false);
  assert.equal(hostMatches('https://outrank.ie/', 'outrank.so'), false);
  assert.equal(hostMatches('https://nike.com/', 'decathlon.com'), false);
  assert.equal(hostMatches('https://decathlon.com.evil.net/', 'decathlon.com', { siblingTlds: false }), false);
  assert.equal(hostMatches('', 'decathlon.com'), false);
  assert.equal(hostMatches('https://decathlon.com', ''), false);
});

test('unwrapRedirect unwraps facebook, linkedin, google and doubleclick', () => {
  const target = 'https://www.decathlon.com/sale?utm_source=fb';
  assert.equal(unwrapRedirect(`https://l.facebook.com/l.php?u=${encodeURIComponent(target)}&h=AT0x`), target);
  assert.equal(unwrapRedirect(`https://lm.facebook.com/l.php?u=${encodeURIComponent(target)}`), target);
  assert.equal(
    unwrapRedirect(`https://www.linkedin.com/redir/redirect?url=${encodeURIComponent(target)}&urlhash=abc`),
    target,
  );
  assert.equal(unwrapRedirect(`https://www.google.com/url?q=${encodeURIComponent(target)}&sa=D`), target);
  assert.equal(
    unwrapRedirect('https://ad.doubleclick.net/ddm/clk/123;456;x;?https://www.decathlon.com/landing'),
    'https://www.decathlon.com/landing',
  );
  // nested: facebook -> google -> target
  const nested = `https://l.facebook.com/l.php?u=${encodeURIComponent(`https://www.google.com/url?q=${encodeURIComponent(target)}`)}`;
  assert.equal(unwrapRedirect(nested), target);
  assert.equal(unwrapRedirect('https://lnkd.in/abc'), 'https://lnkd.in/abc');
  assert.equal(unwrapRedirect('not a url'), 'not a url');
});

test('stripTracking removes utm and click ids only', () => {
  assert.equal(
    stripTracking('https://example.com/p?utm_source=a&utm_medium=b&id=5&fbclid=x&gclid=y'),
    'https://example.com/p?id=5',
  );
  assert.equal(stripTracking('https://example.com/p?utm_campaign=z'), 'https://example.com/p');
  assert.equal(stripTracking('https://example.com/p?a=1'), 'https://example.com/p?a=1');
  assert.equal(stripTracking('nope'), 'nope');
});

// ---- lib/util.js ----

test('parseJsonLines handles for(;;); prefix and multi-line bodies', () => {
  assert.deepEqual(parseJsonLines('for (;;);{"a":1}'), [{ a: 1 }]);
  assert.deepEqual(parseJsonLines('{"a":1}\n{"b":2}\n\nnot json\n{"c":3}'), [{ a: 1 }, { b: 2 }, { c: 3 }]);
  assert.deepEqual(parseJsonLines('for (;;);{"a":1}\n{"b":2}'), [{ a: 1 }, { b: 2 }]);
  assert.deepEqual(parseJsonLines('[1,2]'), [[1, 2]]);
  assert.deepEqual(parseJsonLines(''), []);
});

test('walkJson visits every object/array, can skip subtrees and survives cycles', () => {
  const root = { a: { collated_results: [{ id: 1 }, { id: 2 }] }, b: [{ skip: true, inner: { id: 3 } }] };
  root.self = root;
  const ids = [];
  walkJson(root, (node) => {
    if (node && node.skip) return false;
    if (node && typeof node.id === 'number') ids.push(node.id);
    return undefined;
  });
  assert.deepEqual(ids, [1, 2]);

  let count = 0;
  walkJson([{ x: [1, { y: {} }] }], () => {
    count++;
  });
  // [root array], {x}, [1,{y}], {y}, {} -> 5 nodes
  assert.equal(count, 5);
});

test('toIsoDate converts seconds, ms, numeric strings and date strings', () => {
  assert.equal(toIsoDate(1700000000), '2023-11-14');
  assert.equal(toIsoDate(1700000000000), '2023-11-14');
  assert.equal(toIsoDate('1700000000'), '2023-11-14');
  assert.equal(toIsoDate('2024-05-01T10:00:00Z'), '2024-05-01');
  assert.equal(toIsoDate('2024-05-01'), '2024-05-01');
  assert.equal(toIsoDate(''), null);
  assert.equal(toIsoDate(null), null);
  assert.equal(toIsoDate('garbage'), null);
  assert.equal(toIsoDate({}), null);
});

test('uniq and pick', () => {
  assert.deepEqual(uniq(['a', '', 'b', 'a', null, 'c', 'b']), ['a', 'b', 'c']);
  const obj = { advertiser: { name: '' }, adv_name: 'Nike', videos: [{ cover_img: 'https://x/c.jpg' }] };
  assert.equal(pick(obj, ['advertiser.name', 'adv_name']), 'Nike');
  assert.equal(pick(obj, ['videos.0.cover_img']), 'https://x/c.jpg');
  assert.equal(pick(obj, ['missing.path']), undefined);
});

test('sleep resolves and rejects with AbortError on abort; withTimeout falls back', async () => {
  await sleep(1);
  const ac = new AbortController();
  const p = sleep(10000, ac.signal);
  ac.abort();
  await assert.rejects(p, (e) => e.name === 'AbortError');
  const slow = new Promise((r) => setTimeout(() => r('late'), 200));
  assert.equal(await withTimeout(slow, 5, 'fallback'), 'fallback');
  assert.equal(await withTimeout(Promise.resolve('fast'), 1000, 'fallback'), 'fast');
});

// ---- lib/html.js ----

test('decodeEntities and stripTags', () => {
  assert.equal(decodeEntities('a &amp; b &lt;c&gt; &quot;d&quot; &#39;e&#39; &#x41;&#66;'), 'a & b <c> "d" \'e\' AB');
  assert.equal(decodeEntities('&amp;lt;'), '&lt;');
  assert.equal(
    stripTags('<div><script>var x = "<b>";</script><style>.a{}</style><p>Hello&nbsp;<b>big</b>\n world</p></div>'),
    'Hello big world',
  );
});

test('attrValues and extractHrefs decode values with both quote styles', () => {
  const html = `<a href="https://a.com/?x=1&amp;y=2">A</a><a class='c' href='/rel'>B</a><img src="https://img/1.png"><a name="n">C</a>`;
  assert.deepEqual(extractHrefs(html), ['https://a.com/?x=1&y=2', '/rel']);
  assert.deepEqual(attrValues(html, 'img', 'src'), ['https://img/1.png']);
});

test('splitByClass and firstClassText', () => {
  const html =
    '<ul><li class="search-result-item foo"><a href="/ad-library/detail/1">x</a><div class="headline"><span>Nike</span> <div>Inc</div></div></li>' +
    '<li class="bar search-result-item"><a href="/ad-library/detail/2">y</a></li></ul>';
  const chunks = splitByClass(html, 'search-result-item');
  assert.equal(chunks.length, 2);
  assert.ok(chunks[0].startsWith('<li class="search-result-item foo">'));
  assert.ok(chunks[0].includes('/ad-library/detail/1'));
  assert.ok(!chunks[0].includes('/ad-library/detail/2'));
  assert.ok(chunks[1].includes('/ad-library/detail/2'));
  assert.equal(firstClassText(html, 'headline'), 'Nike Inc');
  assert.equal(firstClassText(html, 'missing'), '');
});

// ---- lib/model.js ----

test('factories fill defaults', () => {
  assert.deepEqual(PLATFORM_ORDER, ['google', 'meta', 'tiktok', 'linkedin', 'bing', 'snap']);
  const ad = makeAd({ platform: 'meta', id: '1' });
  assert.equal(ad.match, 'keyword');
  assert.equal(ad.source, 'native');
  assert.equal(ad.firstShown, null);
  assert.equal(ad.isActive, null);
  assert.deepEqual(ad.placements, []);
  assert.equal(ad.title, '');
  const adv = makeAdvertiser({ id: 'x' });
  assert.equal(adv.adCount, 0);
  assert.equal(adv.totalAds, null);
  const res = makeResult({ id: 'google', label: 'Google', coverage: 'Global' }, { status: 'empty' });
  assert.equal(res.platform, 'google');
  assert.equal(res.status, 'empty');
  assert.deepEqual(res.stats, { requests: 0, ms: 0 });
  assert.deepEqual(res.ads, []);
});

test('aggregateAdvertisers groups, names and orders by confirmed then total', () => {
  const ads = [
    makeAd({ platform: 'meta', id: '1', advertiserId: 'A', advertiserName: 'Alpha', match: 'keyword' }),
    makeAd({ platform: 'meta', id: '2', advertiserId: 'A', advertiserName: 'Alpha', match: 'keyword' }),
    makeAd({ platform: 'meta', id: '3', advertiserId: 'A', advertiserName: 'Alpha Old', match: 'keyword' }),
    makeAd({ platform: 'meta', id: '4', advertiserId: 'B', advertiserName: 'Beta', match: 'confirmed' }),
    makeAd({ platform: 'meta', id: '5', advertiserId: '', advertiserName: 'Gamma', match: 'confirmed' }),
    makeAd({ platform: 'meta', id: '6', advertiserId: '', advertiserName: 'Gamma', match: 'keyword' }),
  ];
  const advs = aggregateAdvertisers(ads, { platform: 'meta', urlFor: (id, name) => `https://x/${id || name}` });
  assert.deepEqual(
    advs.map((a) => [a.name, a.adCount, a.confirmedCount]),
    [
      ['Gamma', 2, 1],
      ['Beta', 1, 1],
      ['Alpha', 3, 0],
    ],
  );
  assert.equal(advs[1].url, 'https://x/B');
  assert.equal(advs[1].platform, 'meta');
});

test('promoteAdvertiserMatches and dedupeAds', () => {
  const ads = [
    makeAd({ platform: 'tiktok', id: '1', advertiserId: 'A', match: 'confirmed' }),
    makeAd({ platform: 'tiktok', id: '2', advertiserId: 'A', match: 'keyword' }),
    makeAd({ platform: 'tiktok', id: '3', advertiserId: 'A', match: 'name' }),
    makeAd({ platform: 'tiktok', id: '4', advertiserId: 'B', match: 'keyword' }),
  ];
  promoteAdvertiserMatches(ads);
  assert.deepEqual(
    ads.map((a) => a.match),
    ['confirmed', 'advertiser', 'advertiser', 'keyword'],
  );

  const deduped = dedupeAds([
    makeAd({ platform: 'google', id: 'CR1', match: 'keyword', placements: ['youtube'] }),
    makeAd({ platform: 'google', id: 'CR1', match: 'confirmed', placements: [] }),
    makeAd({ platform: 'meta', id: 'CR1', match: 'keyword' }),
  ]);
  assert.equal(deduped.length, 2);
  assert.equal(deduped[0].match, 'confirmed');
  assert.deepEqual(deduped[0].placements, ['youtube']);
});

// ---- advertiser roles and name seeds ----

test('makeAdvertiser defaults role to primary', () => {
  assert.equal(makeAdvertiser({ id: 'x' }).role, 'primary');
  assert.equal(makeAdvertiser({ id: 'x', role: 'other' }).role, 'other');
});

test('assignRoles: >= 10% share or >= 5 ads is primary, top always primary', () => {
  const advs = [
    makeAdvertiser({ id: 'owner', adCount: 116, confirmedCount: 116 }),
    ...Array.from({ length: 12 }, (_, i) => makeAdvertiser({ id: `r${i}`, adCount: i === 0 ? 5 : 1, confirmedCount: 1 })),
  ];
  assignRoles(advs);
  assert.equal(advs[0].role, 'primary');
  assert.equal(advs[1].role, 'primary'); // 5 ads
  assert.ok(advs.slice(2).every((a) => a.role === 'other'));

  // Small platform: every advertiser holds >= 10%.
  const few = assignRoles([makeAdvertiser({ id: 'a', adCount: 2, confirmedCount: 1 }), makeAdvertiser({ id: 'b', adCount: 1, confirmedCount: 1 })]);
  assert.deepEqual(few.map((a) => a.role), ['primary', 'primary']);

  // Top advertiser is primary even below both thresholds; the rest has no confirmed ad.
  const many = assignRoles(Array.from({ length: 20 }, (_, i) => makeAdvertiser({ id: `m${i}`, adCount: 1, confirmedCount: i === 7 ? 1 : 0 })));
  assert.equal(many[7].role, 'primary');
  assert.equal(many.filter((a) => a.role === 'primary').length, 1);
  assert.equal(many.filter((a) => a.role === 'mention').length, 19);
  assert.deepEqual(assignRoles([]), []);
});

test('assignRoles: advertisers without confirmed ads are mention, never primary (outrank.so, Meta)', () => {
  // Live 2026-09-26: the owner 30/30, keyword matches TradeZip 0/8 and Opinly 0/7.
  const advs = assignRoles([
    makeAdvertiser({ platform: 'meta', id: 'owner', name: 'Outrank.so', adCount: 30, confirmedCount: 30 }),
    makeAdvertiser({ platform: 'meta', id: 'tz', name: 'TradeZip', adCount: 8, confirmedCount: 0 }),
    makeAdvertiser({ platform: 'meta', id: 'op', name: 'Opinly', adCount: 7, confirmedCount: 0 }),
    makeAdvertiser({ platform: 'meta', id: 'aff', name: 'Affiliate', adCount: 1, confirmedCount: 1 }),
  ]);
  assert.deepEqual(advs.map((a) => a.role), ['primary', 'mention', 'mention', 'other']);

  // Keyword matches only: nobody is primary.
  const none = assignRoles([
    makeAdvertiser({ platform: 'google', id: 'a', adCount: 12, confirmedCount: 0 }),
    makeAdvertiser({ platform: 'google', id: 'b', adCount: 2, confirmedCount: 0 }),
  ]);
  assert.deepEqual(none.map((a) => a.role), ['mention', 'mention']);

  // Snapchat never exposes landing pages: name matches keep size-based roles.
  const snap = assignRoles([
    makeAdvertiser({ platform: 'snap', id: 'Acme', adCount: 20, confirmedCount: 0 }),
    makeAdvertiser({ platform: 'snap', id: 'Tiny', adCount: 1, confirmedCount: 0 }),
  ]);
  assert.deepEqual(snap.map((a) => a.role), ['primary', 'other']);
});

test('keepConfirmedAdvertisers drops advertisers without an ad pointing to the domain', () => {
  const ads = [
    makeAd({ platform: 'linkedin', id: '1', advertiserId: '777', advertiserName: 'Outrank.so', match: 'confirmed' }),
    makeAd({ platform: 'linkedin', id: '2', advertiserId: '777', advertiserName: 'Outrank.so', match: 'name' }),
    makeAd({ platform: 'linkedin', id: '3', advertiserId: '144811284', advertiserName: 'Outrank', match: 'name' }),
    makeAd({ platform: 'linkedin', id: '4', advertiserId: 'Outrank.so', advertiserName: 'Outrank.so', match: 'name' }),
  ];
  assert.deepEqual(keepConfirmedAdvertisers(ads).map((a) => a.id), ['1', '2']);
  // adopt(): an employee post of the confirmed company joins it.
  const adopted = keepConfirmedAdvertisers(ads, (ad, byName) => (ad.id === '4' ? byName.get('outrank.so') : ''));
  assert.deepEqual(adopted.map((a) => [a.id, a.advertiserId]), [['1', '777'], ['2', '777'], ['4', '777']]);
  assert.equal(ads[3].advertiserId, 'Outrank.so'); // input not mutated
  // Nothing confirmed: nothing kept.
  assert.deepEqual(keepConfirmedAdvertisers(ads.slice(2)), []);
  assert.deepEqual(keepConfirmedAdvertisers(undefined), []);
});

test('aggregateAdvertisers assigns roles', () => {
  const ads = [];
  for (let i = 0; i < 30; i++) ads.push(makeAd({ platform: 'google', id: `o${i}`, advertiserId: 'OWN', advertiserName: 'Owner', match: 'confirmed' }));
  ads.push(makeAd({ platform: 'google', id: 'x1', advertiserId: 'AFF', advertiserName: 'Affiliate', match: 'confirmed' }));
  const advs = aggregateAdvertisers(ads, { platform: 'google' });
  assert.deepEqual(advs.map((a) => [a.id, a.role]), [['OWN', 'primary'], ['AFF', 'other']]);
});

test('cleanAdvertiserName strips legal suffixes', () => {
  assert.equal(cleanAdvertiserName('BLG INC'), 'BLG');
  assert.equal(cleanAdvertiserName('Acme, Inc.'), 'Acme');
  assert.equal(cleanAdvertiserName('Acme GmbH & Co. KG'), 'Acme');
  assert.equal(cleanAdvertiserName('Decathlon S.A.'), 'Decathlon');
  assert.equal(cleanAdvertiserName('Polska Firma Sp. z o.o.'), 'Polska Firma');
  assert.equal(cleanAdvertiserName('Dutch B.V.'), 'Dutch');
  assert.equal(cleanAdvertiserName('Brit Limited'), 'Brit');
  assert.equal(cleanAdvertiserName('Maison SAS'), 'Maison');
  assert.equal(cleanAdvertiserName('Babylovegrowth'), 'Babylovegrowth');
  assert.equal(cleanAdvertiserName('Inc'), 'Inc');
});

test('advertiserNameSeeds: primary advertisers with confirmed ads, raw + cleaned, max 5', () => {
  const results = [
    {
      platform: 'google',
      advertisers: [
        makeAdvertiser({ name: 'BLG INC', adCount: 116, confirmedCount: 116, role: 'primary' }),
        makeAdvertiser({ name: 'Reseller LLC', adCount: 1, confirmedCount: 1, role: 'other' }),
        makeAdvertiser({ name: 'Keyword Only', adCount: 9, confirmedCount: 0, role: 'primary' }),
        makeAdvertiser({ name: 'Competitor', adCount: 40, confirmedCount: 0, role: 'mention' }),
      ],
    },
    { platform: 'meta', advertisers: [makeAdvertiser({ name: 'Babylovegrowth', adCount: 12, confirmedCount: 12 })] },
  ];
  assert.deepEqual(advertiserNameSeeds(results), ['BLG INC', 'BLG', 'Babylovegrowth']);
  const lots = [{ advertisers: ['Acme Inc', 'Bolt Inc', 'Core Inc'].map((name, i) => makeAdvertiser({ name, confirmedCount: 3 - i })) }];
  assert.deepEqual(advertiserNameSeeds(lots), ['Acme Inc', 'Acme', 'Bolt Inc', 'Bolt', 'Core Inc']);
  assert.deepEqual(advertiserNameSeeds([]), []);
});

test('nameQueries: brand first, then up to max extra names, case-insensitive dedupe', () => {
  assert.deepEqual(nameQueries('babylovegrowth', ['BLG INC', 'BabyLoveGrowth', 'BLG', 'X'], 2), ['babylovegrowth', 'BLG INC', 'BLG']);
  assert.deepEqual(nameQueries('', ['BLG'], 2), ['BLG']);
  assert.deepEqual(nameQueries('Acme', undefined, 2), ['Acme']);
});

// ---- background/log.js ----

test('debug log: ring buffer, levels, safe URLs, formatting', async () => {
  await clearLog();
  const origWarn = console.warn;
  const origError = console.error;
  const consoleCalls = [];
  console.warn = (m) => consoleCalls.push(['warn', m]);
  console.error = (m) => consoleCalls.push(['error', m]);
  try {
    for (let i = 0; i < MAX_ENTRIES + 20; i++) log('info', 'scan', `line ${i}`);
    logWarn('bing', 'HTTP 429 adlibrary.api.bingads.microsoft.com/api/v1/Ads');
    logError('sw', 'boom');
    log('bogus', '', 'x');
  } finally {
    console.warn = origWarn;
    console.error = origError;
  }
  const entries = await getLog();
  assert.equal(entries.length, MAX_ENTRIES);
  assert.equal(entries[entries.length - 1].level, 'info');
  assert.equal(entries[entries.length - 1].src, 'sw');
  assert.equal(entries[entries.length - 3].level, 'warn');
  assert.match(entries[0].t, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(consoleCalls.map((c) => c[0]), ['warn', 'error']);
  const lines = formatLogLines(entries.slice(-2));
  assert.match(lines[0], /ERROR \[sw\] boom$/);
  await clearLog();
  assert.equal((await getLog()).length, 0);
});

test('safeUrl never keeps query strings; errText adds the first stack line', () => {
  assert.equal(
    safeUrl('https://www.searchapi.io/api/v1/search?engine=google&api_key=SECRET'),
    'www.searchapi.io/api/v1/search',
  );
  assert.equal(safeUrl('not a url?key=SECRET'), 'not a url');
  const e = new Error('bad');
  assert.match(errText(e), /^bad \(at /);
  assert.equal(errText('plain'), 'plain');
});

test('makeAdvertiser defaults domains/note; accountNote and advertiserSummary', () => {
  const a = makeAdvertiser({ id: 'x' });
  assert.equal(a.domains, null);
  assert.equal(a.note, '');
  assert.equal(accountNote(4, false), 'Shared account: ads for 4 different sites');
  assert.equal(accountNote(3, true), 'Shared account: ads for 3 different sites');
  assert.equal(accountNote(1, true), 'Only advertises this domain');
  assert.equal(accountNote(2, false), '');
  assert.deepEqual(
    advertiserSummary([
      makeAdvertiser({ id: 'a', role: 'primary' }),
      makeAdvertiser({ id: 'b', role: 'other', domains: 12 }),
      makeAdvertiser({ id: 'c', role: 'other', domains: 1 }),
      makeAdvertiser({ id: 'd', role: 'mention' }),
      null,
    ]),
    { primary: 1, other: 2, mention: 1, sharedAccounts: 1 },
  );
  assert.deepEqual(advertiserSummary(undefined), { primary: 0, other: 0, mention: 0, sharedAccounts: 0 });
});

test('shouldSaveLastScan: a stopped scan without findings keeps the previous lastScan', () => {
  const empty = [{ platform: 'meta', ads: [], advertisers: [] }, { platform: 'snap', status: 'skipped', ads: [], advertisers: [] }];
  assert.equal(shouldSaveLastScan(false, empty), true);
  assert.equal(shouldSaveLastScan(false, []), true);
  assert.equal(shouldSaveLastScan(true, empty), false);
  assert.equal(shouldSaveLastScan(true, []), false);
  assert.equal(shouldSaveLastScan(true, [{ platform: 'meta', ads: [{ id: '1' }], advertisers: [] }]), true);
  assert.equal(shouldSaveLastScan(true, [{ platform: 'google', ads: [], advertisers: [{ id: 'a' }] }]), true);
});
