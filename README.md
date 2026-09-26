<img src="icons/icon128.png" width="64" height="64" alt="Superpixel icon">

# Superpixel

Superpixel is a Chrome extension (Manifest V3, plain JavaScript, no build step) for competitor
research. Point it at a domain, typed or the active tab, and it shows two layers of information
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

1. Clone this repository.
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
4. Use "Export JSON" or "Export CSV" to save the full result for further analysis.
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

## Requirements

- Signing in to a Google account in the same Chrome profile is required for the Google Ads
  Transparency search to work; without it Superpixel shows a "needs you" status with a link to
  sign in.
- Being logged into Facebook in the same profile is not required but improves Meta Ad Library
  results.
- An internet connection and a normal, unrestricted Chrome profile. No account or install step is
  needed for the other libraries.

## Privacy

Everything runs locally in your browser. There is no Superpixel server: scans are performed
directly from your machine against the public ad library endpoints, and results are stored only in
your browser's local extension storage. The optional SearchAPI key, if you add one, is stored
locally in `chrome.storage.local` and is sent only to `searchapi.io` as a fallback request, never
anywhere else.

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
background/       service worker, scan orchestration, caching, settings, throttling
lib/              shared pure helpers: domain handling, the data model, HTML parsing, utilities
detect/           on site tag signatures and detection, seed extraction (brand, socials, IDs)
adapters/         one file per ad library, plus an optional SearchAPI.io fallback
content/          scripts injected into capture tabs to observe network responses
sidepanel/        the side panel UI (HTML, CSS, JS)
icons/            extension icons
tests/            unit tests and fixtures, run with node --test
```

## License

MIT, see [LICENSE](LICENSE).

## Issues

Found a bug or have a feature request? Please open an issue at
[github.com/PiotrZapolski/superpixel/issues](https://github.com/PiotrZapolski/superpixel/issues).
