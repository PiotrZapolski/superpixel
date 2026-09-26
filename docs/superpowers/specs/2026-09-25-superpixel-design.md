# Superpixel v1 - design spec

Date: 2026-09-25. Tracking issue: #1.

## 1. Goal

A Chrome extension (Manifest V3, plain JavaScript, no build step, loaded unpacked, public repo)
for competitor research. Given a domain (typed, or the active tab), it shows:

- **Layer A - on-site tags:** every marketing / ads / analytics tag installed on the site and the
  account IDs used (Meta Pixel, Google Ads AW-, GA4, GTM, LinkedIn Insight, TikTok, X, Pinterest,
  Snap, Reddit, Microsoft UET, Quora, Taboola, Outbrain, Criteo, Amazon, HubSpot, Clarity, Hotjar,
  AdRoll, Yandex Metrica, Klaviyo).
- **Layer B - running ads:** advertisers and ads from public ad libraries that point to the domain:
  Google Ads Transparency Center (incl. YouTube), Meta Ad Library, TikTok Ad Library, LinkedIn Ad
  Library, Microsoft (Bing) Ad Library, Snapchat Ads Gallery API. Optional SearchAPI.io key as a
  fallback when a scraper breaks.

Non-goals (v1): Chrome Web Store listing, backend server, Pinterest/X/Apple/Amazon/Reddit scraping
(deep links only), historical tracking, i18n of the UI (English UI).

## 2. Live-verified facts (2026-09-25, in a real logged-in Chrome)

| Source | Verified behaviour |
|---|---|
| Google | `POST https://adstransparency.google.com/anji/_/rpc/SearchService/SearchCreatives?authuser=0`, form body `f.req=<json>`, headers `X-Same-Domain: 1` and `X-Framework-Xsrf-Token: <token>` are REQUIRED (400 without). Token = `xsrfToken: '...'` in the homepage HTML, present only when the user is signed in to Google; the token works even without cookies. Request `{"2":40,"3":{"12":{"1":"<domain>","2":true}},"7":{"1":1,"2":24,"3":2616}}` (field 7 must contain 2 and 3, else 400). YouTube filter: `"3":{..., "14":[5]}`. Response `{"1":[rows],"2":"<cursor>","4":"1000","5":"2000"}`. Row: `1` advertiser id AR..., `2` creative id CR..., `3` preview (`3.3.2` = `<img src="...">` html, or `3.1.4` = content.js url), `4` format (1 text, 2 image, 3 video), `6`/`7` first/last shown `{1:"<epoch s>",2:nanos}`, `12` advertiser name, `13` number, `14` domain. decathlon.com returned 40 rows / page, ~2000 total, advertisers incl. resellers. |
| Meta | `https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&is_targeted_country=false&media_type=all&search_type=keyword_unordered&q=<domain>` renders first page server-side inside `<script type="application/json">` blobs containing `collated_results`. Scrolling triggers `POST /api/graphql/` with `fb_api_req_friendly_name=AdLibrarySearchPaginationQuery`, response JSON (may be multiple newline-separated JSON objects, may start with `for (;;);`) with `data.ad_library_main.search_results_connection.edges[].node.collated_results[]`. Each result: `ad_archive_id`, `page_id`, `page_name`, `is_active`, `start_date`, `end_date` (epoch s), `publisher_platform[]`, `snapshot.{link_url, caption, title, body.text, cards[].{link_url,caption,title,body}, images[].original_image_url, videos[].video_preview_image_url, page_profile_uri}`. 27 SSR + 26 per scroll page, all with link_url. Rate-limit = HTTP 200 with error code `1675004`. |
| TikTok | Direct `fetch` to `/api/v1/search` and `/api/v1/items/{id}/details` from page context returns `421 system busy` (requests are signed by the app). The UI itself works: `https://library.tiktok.com/ads?region=DE&adv_name=nike&query_type=1&sort_type=last_shown_date,desc` shows 520 ads; the app calls `POST /api/v1/search?region=..&type=1&start_time=<s>&end_time=<s>` and on the detail page `GET /api/v1/items/{ad_id}/details`. A hook installed after page load does not see these calls (the app keeps its own reference), so the hook MUST run at `document_start` in the MAIN world. Detail page `https://library.tiktok.com/ads/detail/?ad_id=<id>` shows advertiser, paid-by, caption, reach, and an external landing link. Result links on the search page: `a[href*="/ads/detail/?ad_id="]`. JSON response shapes are NOT yet captured: parsers must be defensive (see 6.3). |
| LinkedIn | `GET https://www.linkedin.com/ad-library/search?accountOwner=<name>&countries=ALL&dateOption=last-30-days` works logged-out, no cookies needed. HTML with 24 `li.search-result-item` cards, links `/ad-library/detail/<id>`, and `<code id="paginationMetadata"><!--{"isLastPage":false,"paginationToken":"..."}--></code>`. Cards carry no company link or landing URL. `GET /ad-library/detail/<id>` HTML contains `https://www.linkedin.com/company/<numericId>` and the external landing URL as `<a href="https://...">`. Results also include employee "thought leader" ads promoted by the company. |
| Bing | `GET https://adlibrary.api.bingads.microsoft.com/api/v1/Advertisers?searchText=<brand>&top=10&skip=0` returns `{value:[{AdvertiserId, AdvertiserName, AdvertiserCountry, IsVerified}]}`; `GET /api/v1/Ads?advertiserId=<id>&top=50&skip=0` returns `{"@odata.count":N, value:[{AdId, AdvertiserName, AdvertiserId, Title, Description, DisplayUrl, DestinationUrl, AssetJson}]}`. No auth. EU/EEA-served ads only. |
| Snap | `POST https://adsapi.snapchat.com/v1/ads_library/ads/search` answered `429 Too many requests` on the first call. Body per docs: `{paying_advertiser_name, countries:[lowercase iso2], start_date, end_date}`. Treat as best-effort. |

Browser environment note: `DOMParser` is NOT available in the MV3 service worker. HTML parsing
(LinkedIn, site HTML) must be string/regex based so it also runs under Node for tests.

## 3. Architecture

```
manifest.json
background/sw.js          service worker entry: port handling, scan orchestration
background/scan.js        runScan(input, emit): layer A, seeds, adapters in parallel
background/hidden-tab.js  openCaptureTab(url, opts) -> captured payloads; scan-tab window mgmt
background/queue.js       per-key throttle (min interval, backoff helpers)
background/cache.js       chrome.storage.local TTL cache (24h)
background/settings.js    defaults + load/save (chrome.storage.local)
lib/domain.js             normalizeDomain, registrableDomain, hostMatches, unwrapRedirect, stripTracking
lib/model.js              JSDoc typedefs + factories: makeAd, makeAdvertiser, makeResult
lib/html.js               tiny regex helpers: stripTags, decodeEntities, attrAll, textBetween
lib/util.js               sleep, withTimeout, walkJson(obj, visitor), parseJsonLines
detect/signatures.js      tag signature table (data only + small extractor fns)
detect/detect.js          detectTags({resourceUrls, html, globals}) -> TagHit[]; extractSeeds(...)
detect/page-probe.js      function injected via chrome.scripting.executeScript (MAIN world):
                          returns {resourceUrls, html (first 1.5MB), globals, title, meta}
adapters/index.js         registry: [google, meta, tiktok, linkedin, bing, snap]
adapters/google.js
adapters/meta.js
adapters/tiktok.js
adapters/linkedin.js
adapters/bing.js
adapters/snap.js
adapters/searchapi.js     optional fallback (user key)
content/hook-main.js      MAIN world, document_start: wraps fetch + XHR, posts captures
content/relay.js          ISOLATED world, document_start: forwards captures + SSR blobs to SW,
                          executes scroll/collect commands from SW
sidepanel/sidepanel.html, sidepanel.css, sidepanel.js
icons/icon16.png, icon48.png, icon128.png
tests/*.test.js, tests/fixtures/*
.github/workflows/test.yml
package.json              {"type":"module","private":true,"scripts":{"test":"node --test tests/"}}  (no dependencies)
README.md, LICENSE (MIT)
```

All code is ES modules. The service worker is `"type": "module"`. Every adapter and detector
separates **pure parse functions** (exported, no `chrome.*`, testable in Node) from the
**`search(seeds, ctx)`** function that does I/O through `ctx` only.

### 3.1 Manifest

- `manifest_version: 3`, name "Superpixel", `action` opens the side panel
  (`chrome.sidePanel.setPanelBehavior({openPanelOnActionClick:true})`).
- permissions: `sidePanel`, `storage`, `tabs`, `scripting`.
- host_permissions: `<all_urls>` (scan arbitrary sites, call library endpoints from the SW).
- content_scripts (both `run_at: document_start`, `all_frames: false`):
  - `content/hook-main.js`, `world: "MAIN"`, matches `https://www.facebook.com/ads/library/*`,
    `https://library.tiktok.com/*`.
  - `content/relay.js`, isolated world, same matches.

### 3.2 Data model (lib/model.js)

```js
/** @typedef {{domain:string, brand:string, brandCandidates:string[],
 *   social:{facebook:string[],instagram:string[],linkedin:string[],tiktok:string[],youtube:string[],x:string[],pinterest:string[]},
 *   ids:Object<string,string[]>, settings:Settings}} Seeds */
/** @typedef {{platform:string, id:string, advertiserId:string, advertiserName:string,
 *   format:string, title:string, text:string, landingUrl:string, displayUrl:string,
 *   firstShown:string|null, lastShown:string|null, isActive:boolean|null, previewUrl:string,
 *   detailUrl:string, placements:string[], match:'confirmed'|'advertiser'|'keyword'|'name',
 *   source:'native'|'searchapi'}} Ad */
/** @typedef {{platform:string, id:string, name:string, url:string, country:string,
 *   adCount:number, confirmedCount:number, totalAds:string|null}} Advertiser */
/** @typedef {{platform:string, label:string, coverage:string,
 *   status:'ok'|'empty'|'error'|'rate_limited'|'needs_user'|'changed'|'skipped',
 *   message:string, advertisers:Advertiser[], ads:Ad[], deepLinks:{label:string,url:string}[],
 *   stats:{requests:number, ms:number}}} PlatformResult */
/** @typedef {{platform:string, category:'ads'|'analytics'|'tag-manager'|'crm',
 *   ids:string[], evidence:string[]}} TagHit */
```

Dates are ISO `YYYY-MM-DD` strings. `match` meaning:
- `confirmed`: landing/display URL host is the target registrable domain or a subdomain of it
  (or Google row field 14 equals the domain).
- `advertiser`: ad belongs to an advertiser that has at least one confirmed ad, landing not checked or different.
- `keyword`: found by keyword search, landing not on the domain.
- `name`: found only by advertiser-name search (Snap).

Advertisers are sorted by `confirmedCount` desc, then `adCount` desc.

### 3.3 Adapter contract (adapters/*.js)

```js
export const meta = { id:'google', label:'Google Ads (Search, YouTube, Display)', coverage:'Global' };
export function deepLinks(seeds) -> {label,url}[]
export async function search(seeds, ctx) -> PlatformResult
// plus exported pure parse* functions used by search() and tests
```

`ctx` (built in background/scan.js):
- `ctx.fetch(url, init)` - SW fetch with `credentials:'include'` by default, counts requests,
  honours `ctx.signal`.
- `ctx.throttle()` - awaits the platform's min interval (queue.js, key = platform id).
- `ctx.capture(url, opts)` - opens a capture tab (hidden-tab.js), returns `{payloads, tabUrl, error}`.
- `ctx.progress(text)` - streams a status line to the side panel.
- `ctx.settings` - see 3.6. `ctx.signal` - AbortSignal (user pressed Stop).

Adapters never throw to the orchestrator: every failure maps to a `status` + `message`, keeping
whatever partial results were collected. If a response does not have the expected shape, status
is `changed` with message "<Platform> changed its response format" (never silently `empty`).

### 3.4 Capture tabs (background/hidden-tab.js, content/*)

- One dedicated scan window: `chrome.windows.create({url, focused:false, state:'minimized'})`
  (setting `showScanTabs` = true creates it `state:'normal'` for debugging). Reuse it; close it
  when the scan ends. Track capture tab IDs in a Set; captures from other tabs are ignored.
- `openCaptureTab(url, {platform, waitMs=6000, scrolls=0, scrollDelayMs=2500, until})`:
  creates the tab, collects `capture` messages for that tab, performs `scrolls` by messaging the
  relay (`{cmd:'scroll'}`), resolves after quiet period / `waitMs`, closes the tab. Always
  resolves (timeout -> `{payloads, error:'timeout'}`).
- `content/hook-main.js` (MAIN): wraps `window.fetch` and `XMLHttpRequest.prototype.open/send`
  BEFORE page scripts run. For URLs matching `/api/graphql/` (Meta) or `/api/v1/` (TikTok) it
  sends `window.postMessage({__superpixel:true, url, status, body:text}, '*')` after the
  response loads. Request body is included for graphql (`reqBody`, truncated 4KB) so the
  friendly name can be read. Must not change page behaviour (always return original response).
- `content/relay.js` (ISOLATED): listens to those postMessages (check `event.source===window`
  and `__superpixel`), forwards `chrome.runtime.sendMessage({type:'capture', url, status, body})`.
  On `DOMContentLoaded` (and again 1.5s later) on facebook.com it forwards every
  `script[type="application/json"]` whose text contains `collated_results` as
  `{type:'capture', url:'ssr', body}`. Handles `{cmd:'scroll'}` (`window.scrollTo(0,
  document.body.scrollHeight)`) and `{cmd:'dom'}` (returns `document.body.innerText` (100KB cap)
  plus all `a[href]` absolute hrefs) for DOM fallbacks.
- The relay does nothing unless the SW confirms the tab is a capture tab (it asks once on load:
  `{type:'isCaptureTab'}`); normal browsing of these sites is unaffected.

### 3.5 Layer A (detect/)

Flow for **current tab**: `chrome.scripting.executeScript({target:{tabId}, world:'MAIN', func:probe})`.
Flow for **typed domain**: open `https://<domain>/` in the scan window (unfocused, minimized),
wait for `complete` + 8s (tags fire late via GTM), run the same probe, close.
If the probe fails (chrome:// page, blocked), fall back to `ctx.fetch` of the homepage HTML and
run HTML-only detection.

`probe()` (self-contained function, no imports) returns:
- `resourceUrls`: `performance.getEntriesByType('resource').map(e=>e.name)` (cap 3000) plus
  `document.scripts[].src` plus `img[src]` 1x1 pixels.
- `html`: `document.documentElement.outerHTML` (first 1.5MB) - includes inline scripts.
- `globals`: presence + safe extraction, all in try/catch:
  `dataLayer` (length and any `gtm.start`), `google_tag_manager` keys (GTM-*, G-*, AW-*),
  `_fbq/fbq` pixel IDs (`fbq.getState?.().pixels[].id` or `_fbq.instance.pixelsByID` keys),
  `ttq._i` keys (TikTok), `_linkedin_partner_id`, `_linkedin_data_partner_ids`,
  `uetq` presence, `twq` presence, `pintrk` presence, `snaptr` presence, `rdt` presence,
  `qp` presence, `_tfa` presence, `obApi` presence, `criteo_q` presence, `_hsq` presence,
  `clarity` presence, `hj` + `_hjSettings.hjid`, `adroll_adv_id`, `adroll_pix_id`, `ym` presence, `_learnq`/`klaviyo` presence.
- `title`, `meta`: `og:site_name`, `og:title`, `application-name`, JSON-LD blocks (raw text).

`detectTags({resourceUrls, html, globals})` applies `detect/signatures.js`. Each signature:
`{platform, category, patterns:[{re, idGroup?, where:'url'|'html'|'any'}], globals:[key]}`.
Minimum signature set (ID regexes in parentheses):
- Meta Pixel: `connect.facebook.net/signals/config/(\d{10,20})`, `facebook.com/tr/?\?[^"']*id=(\d{10,20})`, `fbq\(\s*['"]init['"]\s*,\s*['"](\d{10,20})`.
- Google Ads: `\b(AW-\d{6,12})\b`, `googleads\.g\.doubleclick\.net/pagead/(?:viewthrough)?conversion/(\d{6,12})`.
- Google Analytics 4: `\b(G-[A-Z0-9]{6,12})\b` (only in url or in gtag/config context in html to avoid false hits: require `gtag` or `googletagmanager.com` within the same html script, or a `collect?v=2&tid=G-` url).
- Universal Analytics (legacy): `\b(UA-\d{4,10}-\d{1,4})\b`.
- Google Tag Manager: `\b(GTM-[A-Z0-9]{4,10})\b`.
- Google Floodlight / Campaign Manager: `\b(DC-\d{6,10})\b`, `fls\.doubleclick\.net`.
- LinkedIn Insight: `_linkedin_partner_id\s*=\s*["']?(\d{3,10})`, `px\.ads\.linkedin\.com/collect/?\?[^"']*pid=(\d{3,10})`, `snap\.licdn\.com/li\.lms-analytics`.
- TikTok Pixel: `analytics\.tiktok\.com/i18n/pixel/events\.js\?sdkid=([A-Z0-9]{15,25})`, `ttq\.load\(\s*['"]([A-Z0-9]{15,25})`, `sdkid=([A-Z0-9]{15,25})`.
- X (Twitter): `twq\(\s*['"](?:config|init)['"]\s*,\s*['"]([a-z0-9]{4,10})`, `static\.ads-twitter\.com/uwt\.js`, `analytics\.twitter\.com/i/adsct\?[^"']*txn_id=([a-z0-9]+)`.
- Pinterest: `pintrk\(\s*['"]load['"]\s*,\s*['"](\d{10,16})`, `ct\.pinterest\.com/v3/\?[^"']*tid=(\d{10,16})`.
- Snap Pixel: `snaptr\(\s*['"]init['"]\s*,\s*['"]([0-9a-f-]{36})`, `tr\.snapchat\.com`.
- Reddit Pixel: `rdt\(\s*['"]init['"]\s*,\s*['"]((?:t2_|a2_)?[a-z0-9_]{5,20})`, `alb\.reddit\.com`.
- Microsoft UET: `bat\.bing\.com/action/0\?[^"']*ti=(\d{4,12})`, `\bti\s*:\s*["'](\d{4,12})["']` near `uetq`.
- Quora: `qp\(\s*['"]init['"]\s*,\s*['"]([0-9a-f]{32})`, `q\.quora\.com/_/ad/`.
- Taboola: `trc\.taboola\.com/(\d{5,8})/`, `_tfa\.push\(\{[^}]*id:\s*(\d{5,8})`.
- Outbrain: `amplify\.outbrain\.com/cp/obtp\.js`, `OB_ADV_ID\s*=\s*['"]([0-9a-f]{20,40})`.
- Criteo: `static\.criteo\.net/js/ld/ld\.js`, `\baccount\s*:\s*(\d{3,7})` near `criteo_q`.
- Amazon Ads: `amazon-adsystem\.com`, `s\.amazon-adsystem\.com/iu3\?[^"']*pid=([a-z0-9-]+)`.
- HubSpot: `js\.hs-scripts\.com/(\d{4,10})\.js`, `js\.hs-analytics\.net/analytics/\d+/(\d{4,10})\.js`.
- Microsoft Clarity: `clarity\.ms/tag/([a-z0-9]{8,12})`.
- Hotjar: `static\.hotjar\.com/c/hotjar-(\d{5,9})\.js`, `hjid\s*:\s*(\d{5,9})`.
- AdRoll: `adroll_adv_id\s*=\s*["']([A-Z0-9]{20,26})`, `adroll_pix_id\s*=\s*["']([A-Z0-9]{20,26})`.
- Yandex Metrica: `mc\.yandex\.ru/watch/(\d{5,10})`, `ym\(\s*(\d{5,10})\s*,\s*['"]init`.
- Klaviyo: `static\.klaviyo\.com/onsite/js/klaviyo\.js\?company_id=([A-Za-z0-9]{6})`.
IDs are deduped per platform; `evidence` holds up to 3 short strings (matched url host+path, or
"inline script", or "window.<global>").

`extractSeeds({domain, html, title, meta})` -> Seeds:
- `brandCandidates` (ordered, deduped, case-insensitive): JSON-LD Organization/WebSite `name`,
  `og:site_name`, `application-name`, title split on `|`, `-`, `:`, `·` and the Unicode dashes `U+2013` `U+2014` (write them as escapes in code) taking the shortest
  meaningful part that shares a token with the domain label, then the domain label itself
  (`decathlon` from `www.decathlon.co.uk`; handle multi-part TLDs `co.uk`, `com.au`, `com.br`,
  `co.jp`, `com.pl` via a small list in lib/domain.js). `brand` = first candidate.
- `social`: all `href`s matching facebook.com/<page> (excluding sharer, plugins, tr, dialog),
  instagram.com/<handle>, linkedin.com/company|showcase/<slug-or-id>, tiktok.com/@<handle>,
  youtube.com/(@x|channel/x|c/x|user/x), x.com|twitter.com/<handle> (excluding intent/share),
  pinterest.<tld>/<handle>. Deduped, max 5 each.
- `ids`: map platform -> ids from detectTags.

### 3.6 Settings (background/settings.js, stored in chrome.storage.local `settings`)

```js
{ platforms:{google:true, meta:true, tiktok:true, linkedin:true, bing:true, snap:true},
  maxPagesGoogle:5, metaScrolls:2, metaExpandPages:3, tiktokRegions:['DE','FR','GB','IT','ES','NL','PL','SE'],
  tiktokDetails:8, linkedinDetails:10, linkedinPages:2, bingAdvertisers:6,
  searchapiKey:'', useSearchapiFallback:true, showScanTabs:false, cacheHours:24 }
```

### 3.7 Orchestration (background/scan.js, sw.js)

Side panel connects `chrome.runtime.connect({name:'superpixel'})` and sends
`{type:'scan', input:{mode:'tab'|'domain', tabId?, domain?}, force?:bool}` or `{type:'stop'}`.
SW emits over the port:
`{type:'phase', text}`, `{type:'tags', tags, seeds}`, `{type:'platformStart', id, label, coverage}`
(when an adapter starts), `{type:'progress', id, text}`, `{type:'platform', result}` (when it
finishes), `{type:'done', summary}`, `{type:'error', message}`.

runScan: normalize domain -> layer A -> seeds -> for each enabled adapter start `search()` in
parallel (each has its own throttle key, so they do not block each other; capture-tab adapters
(meta, tiktok) run their tabs sequentially through a shared capture mutex to avoid many open tabs)
-> if result.status in (changed, error, rate_limited) and a SearchAPI key is set and
`useSearchapiFallback`, run `searchapi.fallback(platformId, seeds, ctx)` and merge
(`source:'searchapi'`) -> cache result per (platform, domain) for `cacheHours` unless `force`.
Everything also stored as `lastScan` in chrome.storage.local so reopening the panel shows it.

Update 2026-09-26 (live findings): adapters run in two waves. Wave 1 = google + meta in
parallel. Then `seeds.advertiserNames` = names of their `role:'primary'` advertisers with
confirmed ads plus a variant without legal suffixes (INC, LLC, GMBH, SP. Z O.O., ...), max 5
(`advertiserNameSeeds` in lib/model.js), emitted as `{type:'seeds', seeds}`. Wave 2 = tiktok,
linkedin, bing, snap in parallel, which also search by those names (the domain label is often
not the advertiser name: babylovegrowth.ai is "BLG INC" on Google). Advertisers carry
`role:'primary'|'other'` (`assignRoles`: >= 10% of the platform's ads or >= 5 ads, the top
advertiser always primary); the panel groups 'other' accounts in one collapsed block.

Closing the side panel aborts the scan only during layer A. After layer A the scan finishes in
the background and saves cache + `lastScan`; a panel that reconnects meanwhile is reattached.
Only an explicit Stop (or a new scan) aborts it. The SW may still be suspended by Chrome when no
port is open (risk accepted).

Debug log (background/log.js): ring buffer of the last 500 `{t, level, src, msg}` entries in
chrome.storage.local `debugLog` (debounced 1s), warnings/errors mirrored to the console. Logs scan
and adapter start/finish, non-2xx HTTP statuses (host + path only, never query strings), capture
tab open/close, caught and unhandled errors. Port: `{type:'getLog'}` -> `{type:'log', entries}`,
`{type:'clearLog'}`. Settings drawer: Copy debug log, Clear log, Show log (last 100 lines).

## 4. Adapters

Common: throttle intervals - google 900ms, meta capture-bound, tiktok capture-bound,
linkedin 2500ms, bing 1500ms (it answers 429 with an HTML body after ~5 quick calls), snap 3000ms. Backoff for 429: 3s, 10s, 30s then `rate_limited` (bing: 2 retries).

### 4.1 google.js

1. `ctx.fetch('https://adstransparency.google.com/?region=anywhere')` -> `parseXsrf(html)`
   (`/xsrfToken:\s*'([^']+)'/`). None -> status `needs_user`, message "Sign in to Google in this
   browser (any Google account) to enable Google Ads Transparency search", plus deep links.
   If response URL contains `/sorry/` -> `needs_user` "Google shows a captcha, open the link and solve it".
2. `searchCreatives(domain, {cursor, youtube})` builds `f.req` exactly as in section 2;
   cursor goes in field `"4"`. Pages until no cursor or `maxPagesGoogle`.
3. YouTube pass: 1 to 2 pages with `"14":[5]`; creative IDs found there get `placements:['youtube']`
   (others `[]`).
4. `parseCreatives(json)` -> Ad[] (format map 1 text, 2 image, 3 video; `previewUrl` from the
   `<img src>` inside `3.3.2` or the url in `3.1.4`; dates from `6.1`/`7.1` epoch seconds;
   `detailUrl` = `https://adstransparency.google.com/advertiser/<AR>/creative/<CR>?region=anywhere`;
   match `confirmed` when row 14 equals the domain (registrable compare), else `keyword`).
   Missing field `1` array on page 1 with HTTP 200 -> `empty` only if body is exactly `{}` after
   a well-formed request AND the xsrf token was present; otherwise `changed`. HTTP 400 -> `changed`.
5. Advertisers aggregated from rows (id `AR...`, url `https://adstransparency.google.com/advertiser/<AR>?region=anywhere`), `totalAds` = response fields `4`-`5` as "1000-2000" style range on the domain level (put in result `message`).
6. deepLinks: domain search url, `&platform=YOUTUBE` variant.

### 4.2 meta.js

1. `ctx.capture(<search url with q=domain>, {platform:'meta', scrolls: metaScrolls})`.
2. `parseMetaPayloads(payloads)`: for each payload body, strip `for (;;);`, split lines, JSON.parse
   each, `walkJson` collecting objects with array `collated_results`; also detect rate limit
   error code `1675004` and login/checkpoint (tabUrl contains `/login` or `/checkpoint`).
   Map result -> Ad: id `ad_archive_id`, advertiserId `page_id`, advertiserName `page_name`,
   landingUrl = `unwrapRedirect(snapshot.link_url || cards[0].link_url)` (unwrap
   `l.facebook.com/l.php?u=`), displayUrl = `snapshot.caption || cards[0].caption`, title/text from
   snapshot or first card, previewUrl images[0].original_image_url || videos[0].video_preview_image_url
   || cards[0].original_image_url, isActive, dates from epoch seconds, placements
   = publisher_platform lowercased, detailUrl `https://www.facebook.com/ads/library/?id=<id>`.
   Dedupe by id.
3. Match: confirmed if landing host or displayUrl host matches domain; else keyword.
4. Brand pass: if `seeds.brand` differs from the domain label, second capture with `q=<brand>`,
   keep only confirmed ads.
5. Expansion: for up to `metaExpandPages` page_ids with confirmed ads, capture
   `...&search_type=page&view_all_page_id=<id>` (no q), add ads with match `advertiser`
   (or `confirmed` if landing matches).
6. Advertiser url `https://www.facebook.com/<page_id>`; library link
   `https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&view_all_page_id=<id>&search_type=page`.
7. No payload parsed at all -> `changed`. deepLinks: keyword search URL.

### 4.3 tiktok.js

Coverage label: "EU/EEA, UK, CH only".
1. Queries: `seeds.brand` with `query_type=1`; also domain label if different.
2. Region: first try one capture with `region=all`; if it yields no search payload with data,
   loop `tiktokRegions` (one capture each, stop early after 3 regions with zero results in a row).
   URL `https://library.tiktok.com/ads?region=<R>&start_time=<ms now-365d>&end_time=<ms now>&adv_name=<q>&adv_biz_ids=&query_type=1&sort_type=last_shown_date,desc`.
3. `parseTiktokSearch(body)`: defensive. Accept JSON where an array of ad-like objects exists
   (walk: array of objects each having an id-like key among `id`, `ad_id`, `item_id`); map fields
   by first present key: advertiser name `name|advertiser_name|adv_name|advertiser.name`,
   business id `adv_biz_id|biz_id|advertiser_id|advertiser.biz_id`, dates `first_shown_date|first_shown|start_time`
   and `last_shown_date|last_shown|end_time` (seconds or ms or date string), reach
   `estimated_audience|audience|reach`, preview `videos[0].cover_img|cover_image|image_urls[0]`.
   Also detect body `system busy` / `limit exceed` -> rate limited.
   DOM fallback (when no JSON parsed): relay `{cmd:'dom'}`, collect `ad_id` values from
   `/ads/detail/?ad_id=(\d+)` hrefs.
4. Details: for the first `tiktokDetails` ads (sequential, one capture each, ~3s apart; stop on
   403/421/`limit exceed` with status `rate_limited` keeping partial data) capture
   `https://library.tiktok.com/ads/detail/?ad_id=<id>`; `parseTiktokDetail(body)` walks JSON for a
   landing url: keys matching `/external_url|landing|website|url/i` whose value is an http(s) URL not on
   tiktok/tiktokcdn/byteoversea/ibyteimg domains; advertiser name, biz id, paid_by. DOM fallback:
   external `a[href]` not on tiktok domains.
5. Match: confirmed if landing host matches; otherwise `keyword`. Advertisers with confirmed ads
   get their other ads marked `advertiser`.
6. deepLinks: the search URL with `region=all`.

### 4.4 linkedin.js

1. Company hints: from `seeds.social.linkedin` take numeric ids (`/company/(\d+)`) directly.
2. Searches (throttled 2.5s): `companyIds=<ids>` if any; always `accountOwner=<brand>`;
   params `countries=ALL&dateOption=last-30-days` (setting later). Follow pagination up to
   `linkedinPages`: `GET /ad-library/searchPaginationFragment?<same params>&paginationToken=<token>`.
3. `parseLinkedinSearch(html)` (regex, no DOM): split into cards on `search-result-item`; per
   card: ad id from `/ad-library/detail/(\d+)`, advertiser name (first text node / the element
   with class containing `sponsored-content-headline` or advertiser name link text), commentary
   text (class `commentary__content`), headline, image url (first `<img src>` from media.licdn.com),
   "promoted by" flag when text contains a second name line. `parsePaginationMeta(html)` from
   `<code id="paginationMetadata"><!--{json}--></code>`.
4. Details for up to `linkedinDetails` ads: `GET /ad-library/detail/<id>`; `parseLinkedinDetail(html)`:
   company id `linkedin.com/company/(\d+)`, landing url = first external `href="https?://..."` not on
   linkedin.com/licdn.com (unwrap `linkedin.com/redir/redirect?url=`), payer/dates best effort.
5. Match: confirmed if landing matches. Company IDs with confirmed ads -> advertisers with url
   `https://www.linkedin.com/company/<id>` and library link `.../ad-library/search?companyIds=<id>`;
   their other ads -> `advertiser`. Ads from advertisers with no confirmed ad keep `name` match.
6. HTTP 429 -> backoff, then `rate_limited`. Auth wall (response URL contains `authwall` or `/login`) -> `needs_user`.

### 4.5 bing.js

Coverage "EU/EEA-served ads".
1. `Advertisers?searchText=<q>&top=20&skip=0` for the brand and each `seeds.advertiserNames` entry, merged round-robin and deduped -> up to `bingAdvertisers` advertisers.
2. For each: `Ads?advertiserId=<id>&top=24&skip=0` (and `skip=24`, max 2 pages; top > 24 is HTTP 400) -> ads; also `Ads?searchText=<domain>&top=24&skip=0`.
3. `parseBingAds(json)`: id AdId, advertiser, title Title, text Description, displayUrl DisplayUrl,
   landingUrl DestinationUrl, detailUrl `https://adlibrary.ads.microsoft.com/ad-details?adId=<id>`,
   format from AssetJson presence (`text` default).
4. Match confirmed if landing or display host matches. Advertisers with zero confirmed ads are dropped
   (their ads too) unless no advertiser has any confirmed ad (then keep top 2 as `name`).
5. Advertiser url `https://adlibrary.ads.microsoft.com/?advertiserId=<id>` (best effort).

### 4.6 snap.js

Coverage "EU only". POST as in section 2 with countries = EU27 lowercase, last 365 days,
`paying_advertiser_name = brand`. Defensive parse (walk for objects with `id` and one of
`paying_advertiser_name|profile_name|brand_name`). Match `name`, or `confirmed` if any URL field
host matches. 429 -> backoff 5s/15s then `rate_limited`. deepLinks: `https://adsgallery.snap.com/`.

### 4.7 searchapi.js (optional)

Uses `https://www.searchapi.io/api/v1/search?engine=<engine>&api_key=<key>&...` with engines
`google_ads_transparency_center` (param `domain`), `meta_ad_library` (param `q`),
`tiktok_ads_library` (param `q`), `linkedin_ad_library` (param `advertiser` or `q`).
The implementer must confirm engine names and params via Context7/Exa (SearchAPI docs) before
coding. Maps responses to Ad/Advertiser with `source:'searchapi'`. Only called as fallback, never
by default. Key stored in chrome.storage.local, never logged.

### 4.8 Deep-link-only platforms

Shown as a "More libraries" row: Pinterest `https://ads.pinterest.com/ads-repository/`,
X `https://ads.x.com/ads-repository`, Apple `https://adrepository.apple.com/`,
Snap political `https://www.snap.com/political-ads`, Amazon (no public UI, omit).

## 5. Side panel UI

Single page, English copy, light + dark (prefers-color-scheme), system font, no frameworks.
- Header: input (domain), buttons "Scan" and "Current tab", "Stop" while running, settings gear.
- Settings drawer: platform toggles, TikTok regions (checkbox list of EU/UK/CH codes), page/detail
  limits, SearchAPI key (password field) + fallback toggle, show scan tabs, clear cache.
- Section "On-site tags": grouped by category (Ads, Analytics, Tag managers, CRM/other); each row:
  platform, IDs (monospace, copy button), evidence tooltip. Below: "Brand signals" (brand
  candidates, social links as chips).
- Section "Ad libraries": one card per platform in fixed order google, meta, tiktok, linkedin,
  bing, snap. Card header: label, coverage badge, status chip (running spinner / ok with counts /
  empty / needs you + link / rate limited / changed / error), deep links. Body: advertiser list
  (name, id, confirmed/total, link), each expandable to its ads. Ad row: thumbnail (lazy img,
  referrerpolicy no-referrer), title/text (2 lines), landing host, dates, format, placements,
  match badge (confirmed green, advertiser blue, keyword grey, name grey), open link.
  Filter toggle "Only confirmed".
- "More libraries" deep links row.
- Footer: Export JSON, Export CSV (one row per ad incl. platform and advertiser), timestamp,
  "cached" marker with "Rescan" (force).
- All text inserted with textContent / createElement (never innerHTML with remote data).

## 6. Testing

- `node --test tests/` with fixtures in `tests/fixtures/`; no dependencies. Run in GitHub Actions
  (`.github/workflows/test.yml`: checkout, setup-node 22, `node --test tests/`, plus
  `node --check` over all .js files). Local runs of node are NOT allowed on the author's machine;
  CI is the gate.
- Unit tests: lib/domain (registrable, hostMatches incl. subdomains and multi-part TLDs, unwrap
  facebook/linkedin redirects, strip utm), detect (fixture HTML + resource URL lists per platform
  produce the expected IDs, no GA4 false positive from random text), google parseCreatives and
  parseXsrf (fixture built from the verified shape), meta parseMetaPayloads (fixture with SSR blob,
  graphql lines with `for (;;);`, rate limit error), linkedin parseLinkedinSearch /
  parsePaginationMeta / parseLinkedinDetail (fixture HTML modelled on verified structure), bing
  parseBingAds, tiktok defensive parsers with two plausible shapes plus a `system busy` body.
- Manual E2E after build (by the orchestrator in Chrome): load unpacked, scan decathlon.com and
  nike.com, verify every platform card, capture real TikTok JSON into fixtures.

## 7. Risks

- Undocumented endpoints change (Google field numbers, Meta doc_ids, TikTok signing, LinkedIn markup):
  mitigated by status `changed`, SearchAPI fallback, parse functions isolated and fixture-tested.
- Rate limits/captcha on the user's IP and accounts: throttles, small default limits, README warning.
- Minimized scan windows may throttle rendering; SSR first page (Meta) and initial search
  request (TikTok) still load; scroll-driven pages are best-effort.
- Terms of service: README states it is a research tool that automates the public ad libraries in
  the user's own browser, at human-like volume, and the user is responsible for its use.
