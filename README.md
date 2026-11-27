<img src="icons/icon128.png" width="64" height="64" alt="Superpixel icon">

# Superpixel

Superpixel is a free, open-source Chrome extension that shows which marketing tags (Meta Pixel, GA4,
Google Tag Manager and 20+ more) a website uses, with the account IDs behind them, and which ads it
is running in the Google, Meta, TikTok, LinkedIn, Microsoft and Snapchat ad libraries. It replaces
checking each ad library by hand, runs entirely in your browser and needs no account. MIT licensed.

[![License: MIT](https://img.shields.io/github/license/PiotrZapolski/superpixel)](LICENSE)
[![Version](https://img.shields.io/github/manifest-json/v/PiotrZapolski/superpixel?label=version)](manifest.json)
[![Chrome Web Store version](https://img.shields.io/chrome-web-store/v/pffnggdhlpiegolckplpbfgbbigiiafh?label=chrome%20web%20store)](https://chromewebstore.google.com/detail/superpixel/pffnggdhlpiegolckplpbfgbbigiiafh)
[![Chrome Web Store users](https://img.shields.io/chrome-web-store/users/pffnggdhlpiegolckplpbfgbbigiiafh)](https://chromewebstore.google.com/detail/superpixel/pffnggdhlpiegolckplpbfgbbigiiafh)

**[Add to Chrome](https://chromewebstore.google.com/detail/superpixel/pffnggdhlpiegolckplpbfgbbigiiafh)** | [Website](https://superpixel.run) | [40 s video](https://superpixel.run/video/)

Superpixel is a Chrome extension for competitor ads and tags (Manifest V3, plain JavaScript, no
build step). Point it at a domain, typed or the active tab, and it shows two layers of information
directly in a side panel, entirely in your own browser.

- **Layer A, on site tags**: every marketing, ads and analytics tag installed on the site and the
  account IDs behind them (Meta Pixel, Google Ads, GA4, Google Tag Manager, LinkedIn Insight,
  TikTok Pixel, X, Pinterest, Snap, Reddit, Microsoft UET, Quora, Taboola, Outbrain, Criteo,
  Amazon, HubSpot, Microsoft Clarity, Hotjar, AdRoll, Yandex Metrica, Klaviyo, and more).
- **Layer B, running ads**: advertisers and ads pulled from public ad transparency libraries that
  point to the domain, so you can see what a competitor is actually running right now.

## Supported ad libraries

| Platform | Coverage |
|---|---|
| Google Ads Transparency Center | Global, including YouTube |
| Meta Ad Library | Global, active ads |
| TikTok Ad Library | EU/EEA, UK, Switzerland |
| LinkedIn Ad Library | Global, last 12 months |
| Microsoft (Bing) Ad Library | EU/EEA |
| Snapchat Ads Gallery | EU |

An optional [SearchAPI.io](https://www.searchapi.io/) key can be added as a fallback when a
scraper breaks, since these are all unofficial or undocumented endpoints that platforms can change
at any time.

Pinterest, X, Apple and Snap political ads do not have a scrapeable API, so Superpixel shows a
direct deep link to each library instead of scraping it.

## Install

**From the Chrome Web Store (quickest):** open the
[Superpixel page in the Chrome Web Store](https://chromewebstore.google.com/detail/superpixel/pffnggdhlpiegolckplpbfgbbigiiafh), click "Add to Chrome", pin the icon and click it to
open the side panel.

**Newest version from GitHub (Load unpacked):** the store build can be a few versions behind this
repository.

1. Clone this repository (or download a release zip from the
   [releases page](https://github.com/PiotrZapolski/superpixel/releases) and unzip it):

   ```
   git clone https://github.com/PiotrZapolski/superpixel.git
   ```

2. In Chrome, open `chrome://extensions`.
3. Turn on "Developer mode" (top right).
4. Click "Load unpacked" and select the cloned repository folder.
5. Pin the Superpixel icon to your toolbar.
6. Click the icon to open the side panel.

## Usage

1. Open the side panel and either type a domain (for example `example.com`) and click "Scan", or
   click "Current tab" to scan the site you are already on.
2. Superpixel first inspects the page for marketing tags, then queries each enabled ad library in
   parallel and streams results into the panel as they arrive.
3. Use "Only confirmed" to hide everything except ads whose landing page actually points back to
   the scanned domain.
4. Open Settings and use "Export last scan as JSON" to save the full result for further analysis.
5. Results are cached locally; reopening the panel shows your last scan, and "Rescan" forces a
   fresh pull ignoring the cache.

## What the match labels mean

Every ad is tagged with how confident Superpixel is that it belongs to the scanned domain:

- **confirmed**: the ad's landing page or display URL is on the scanned domain (or a subdomain of
  it).
- **advertiser**: the ad belongs to an advertiser account that has at least one confirmed ad, but
  this particular ad's landing page was not checked or points elsewhere.
- **keyword**: the ad only matched a keyword search for the domain or brand name; the landing page
  is not on the domain.
- **name**: the ad was only found through an advertiser name search (used by libraries, such as
  Snap, that do not support keyword search), with no landing page confirmation.

## How is Superpixel different?

| | Superpixel | Checking each ad library by hand | Paid ad spy tools |
|---|---|---|---|
| On-site tags and account IDs | Yes, in the same scan as the ads | No, ad libraries do not show a site's tags | Depends on the tool |
| Ads from six libraries in one panel | Yes, queried in parallel | One library at a time, each in its own tab | Usually the tool's own ad database |
| Account | No Superpixel account; Google sign-in in Chrome for Google's library | The sign-ins the libraries ask for | Usually an account with the vendor |
| Where the data is | Your browser's local extension storage | Your browser | The vendor's servers |
| Source code | Open, MIT | Not applicable | Usually closed |

## FAQ

**How do I see what ads a website is running?** Install Superpixel, open the website and click
"Current tab" (or type the domain and click "Scan"). Superpixel searches the six ad libraries above
at once and lists the ads that point to that domain.

**How do I find a website's Meta Pixel ID and ad account IDs?** Scan the site with Superpixel. Next
to each detected tag the side panel shows the account ID found in the page, for example the Meta
Pixel ID, the GA4 measurement ID, the Google Tag Manager container and the Google Ads conversion ID.
A tag that does not expose an ID in the page's code is still listed as present.

**Is Superpixel free? Does it need an account?** It is free, MIT licensed, and has no account. Only
Google Ads Transparency search needs a Google account signed in to the same Chrome profile; Facebook
login is optional.

**Where is my data sent?** Scan requests go from your browser to the public ad libraries and results
stay in local extension storage. See [Privacy](#privacy).

**Why does it need access to all sites?** Because you can scan any website: reading the tags on a
page you pick needs host access to it. Superpixel reads a page only when you start a scan, and its
content scripts run only on the Meta and TikTok ad library pages.

**Which browsers?** Google Chrome 116 or newer on desktop. Other browsers are not officially
supported.

## Requirements

- Signing in to a Google account in the same Chrome profile is required for the Google Ads
  Transparency search to work; without it Superpixel shows a "needs you" status with a link to
  sign in.
- Being logged into Facebook in the same profile is not required but improves Meta Ad Library
  results.
- An internet connection and a normal, unrestricted Chrome profile. No account or install step is
  needed for the other libraries.

## Privacy

Everything runs locally in your browser. Scans are performed directly from your machine against
the public ad library endpoints, and results are stored only in your browser's local extension
storage. The optional SearchAPI key, if you add one, is stored locally in `chrome.storage.local`
and is sent only to `searchapi.io` as a fallback request, never anywhere else. The only data that
can reach a Superpixel server is the opt-in remote debug log below. Superpixel processes no personal
data: no account, no analytics, no persistent install id, and the server does not store or log IP
addresses. Full policy: https://superpixel.run/privacy/

## Remote debug log

Opt-in only. The first time the side panel opens after install (or after the update that added
this), a banner asks "Help fix broken scans?". Nothing is sent unless you click "Send logs"; the
question is asked once.

When enabled, after each scan the extension sends one batch to `https://superpixel.run/v1/logs`
with: the extension version, a random per-scan id, the scanned domain, the warnings and
errors from the debug log and each platform's final status line (for example
"Adapter finish: rate_limited, 0 ads"). Warnings outside a scan are sent in a batch about 30
seconds later. Log lines never contain query strings. No settings, keys, ads or page content are
sent. A failed send is dropped, not retried. There is no persistent install id: the `install` field
the server requires carries the scan id (or a fresh random value for warnings outside a scan), and
any id stored by older versions is deleted on start. Entries are deleted after 30 days.

Turn it off anytime: Settings > Debug > uncheck "Send warnings to superpixel.run", then
"Save settings".

## Limitations

- The ad libraries used here are mostly undocumented, unofficial endpoints. Platforms can change
  their response format at any time; when that happens a platform card shows a "changed" status
  instead of silently reporting no results.
- Coverage varies a lot by platform (see the table above); a platform showing no ads does not mean
  a competitor is not advertising there, only that no ads were found within that library's
  coverage and the request limits configured in Settings.
- Minimized scan windows used for some platforms may render more slowly or inconsistently than a
  normal foreground tab; scroll driven pagination on those platforms is best effort.
- Rate limits and occasional captchas are expected; Superpixel throttles requests per platform, but
  a busy account or IP can still be temporarily blocked.

## Terms of use and responsibility

Superpixel automates the public ad transparency libraries and on site tag detection inside your
own browser, at a human like request volume, using your own browser session and IP address. It
does not run on a server and does not run on anyone else's behalf. Automating these libraries may
be against the terms of service of the platforms involved, and platforms may rate limit, block, or
otherwise restrict accounts or IP addresses that use it. By using Superpixel you accept full
responsibility for how you use it, and you should use it responsibly and at your own risk.

## Development

Tests run with Node's built in test runner and have no external dependencies:

```
node --test 'tests/*.test.js'
```

CI runs the same command on every push and pull request, together with a syntax check over every
JavaScript file and a check that forbids em dash and en dash characters anywhere in the repository.
Local runs of Node are not required to contribute; CI is the gate.

### Project structure

```
manifest.json
background/       service worker, scan orchestration, caching, settings, throttling, debug log
lib/              shared pure helpers: domain handling, the data model, HTML parsing, utilities
detect/           on site tag signatures and detection, seed extraction (brand, socials, IDs)
adapters/         one file per ad library, plus an optional SearchAPI.io fallback
content/          scripts injected into capture tabs to observe network responses
sidepanel/        the side panel UI (HTML, CSS, JS)
icons/            extension icons
store/            Chrome Web Store listing text, graphics and the package script (store/pack.sh)
tests/            unit tests and fixtures, run with node --test
```

## License

MIT, see [LICENSE](LICENSE).

## Issues

Found a bug or have a feature request? Please open an issue at
[github.com/PiotrZapolski/superpixel/issues](https://github.com/PiotrZapolski/superpixel/issues).
