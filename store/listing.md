# Chrome Web Store listing

Paste-ready text for the developer dashboard. Item ID: `pffnggdhlpiegolckplpbfgbbigiiafh`.
Store page: https://chromewebstore.google.com/detail/superpixel/pffnggdhlpiegolckplpbfgbbigiiafh

Upload package: `sh store/pack.sh` writes `store/dist/superpixel-<version>.zip` (the same zip is
attached to each GitHub release).

## Name and summary (from manifest.json, shown automatically)

- Name: `Superpixel: Competitor Ads & Tags`
- Summary (132 characters max): `See the marketing tags and account IDs on any website, plus the ads it runs on Google, Meta, TikTok, LinkedIn, Bing and Snapchat.`

## Category and language

- Category: Developer Tools (or Workflow & Planning, whichever the dashboard already has set)
- Language: English

## Description

```
Superpixel shows two things about any website: the marketing tags installed on it, and the ads it is running right now.

Type a domain or scan the tab you are on. The side panel lists every marketing, advertising and analytics tag found on the page, with the account ID behind it. Then it searches six public ad transparency libraries in parallel and lists what points to that domain. Everything runs in your own browser.

WHAT YOU GET
- On-site tags with their IDs: Meta Pixel, Google Ads, GA4, Google Tag Manager, LinkedIn Insight, TikTok Pixel, X, Pinterest, Snap, Reddit, Microsoft UET, Quora, Taboola, Outbrain, Criteo, Amazon, HubSpot, Microsoft Clarity, Hotjar, AdRoll, Yandex Metrica, Klaviyo and more.
- Running ads from six sources: Google Ads Transparency Center, Snapchat Ads Gallery, and the ad libraries of Meta, TikTok, LinkedIn and Microsoft (Bing).
- A match label on each result (confirmed, advertiser, keyword, name), so you can tell which ones really lead to the scanned domain.
- "Only confirmed" switch: keep just the results whose landing page is on the domain.
- Export of the last scan as JSON.
- Local cache: reopening the panel shows your last scan, Rescan pulls fresh results.
- Clear statuses: when a platform changes its response format, its card says "changed" instead of reporting zero results.
- Direct links for Pinterest, X, Apple and Snap political advertising, which cannot be searched automatically.

WHAT IT NEEDS
- A Google account signed in to the same Chrome profile, for the Transparency Center search. Without it that card shows "needs you" with a sign-in link.
- Facebook login is optional and improves Meta results.
- No account for the other sources, and no account with us at all.

COVERAGE
Coverage differs by source: Google and Meta are global, TikTok covers EU/EEA, UK and Switzerland, LinkedIn is global for the last 12 months, Microsoft covers EU/EEA and Snapchat covers the EU. An empty result means nothing was found within that coverage, not that a company does not advertise there.

PRIVACY
Scans go straight from your browser to the public libraries. Results are stored only in your browser's local extension storage. The extension has no account, no analytics and no persistent install ID. A debug log (warnings and the scanned domain) is sent to superpixel.run only if you opt in, and you can turn it off in Settings.

Privacy policy: https://superpixel.run/privacy/
Website: https://superpixel.run
Source code (MIT license): https://github.com/PiotrZapolski/superpixel

The extension automates these public sources inside your own browser, with your own session and IP address. That may be against the terms of the platforms involved, and they may rate limit or block accounts that use it. Use it responsibly and at your own risk.
```

## Single purpose

```
Superpixel scans one website at the user's request and shows, in the side panel, the marketing tags installed on that site and the ads pointing to its domain in public ad transparency libraries.
```

## Permission justifications

One sentence each, matching the code.

| Permission | Justification |
|---|---|
| `sidePanel` | The whole interface is a side panel that opens when the user clicks the toolbar icon. |
| `storage` | Settings, the cache of the last scans and the local debug log are kept in `chrome.storage.local` on the user's device. |
| `tabs` | Reads the URL of the active tab for "Current tab" scans, and opens, tracks and closes the capture tabs in a minimized scan window that load ad library pages. |
| `scripting` | Injects the tag probe into the scanned page to read which marketing tags and IDs are present, only when the user starts a scan. |
| `offscreen` | Hosts the TikTok Ad Library page in an offscreen document frame when a capture tab cannot stay open, so the scan can still finish. |
| `declarativeNetRequestWithHostAccess` | Adds one session rule that removes frame-blocking response headers for `library.tiktok.com` sub-frames outside any tab, so that page can load in the offscreen document; normal browsing is not affected. |
| Host permission `<all_urls>` | The user can scan any website, so the extension must be able to read the tags on whatever domain the user chooses and to request the public ad library pages; it reads a page only during a scan the user started. |

Remote code: No. All JavaScript is in the package, there is no build step and nothing is loaded from a server.

## Data usage form

- Collected data: none of the listed personal data categories. The opt-in debug log holds warnings
  and the scanned domain, with no ID that identifies the user (see the privacy policy).
- Not sold, not used for anything unrelated to the single purpose, not used for creditworthiness.
- Privacy policy URL: https://superpixel.run/privacy/

## Graphics

Ready in `store/out/` (rendered by `store/render.sh` from `store/src/`, 24-bit PNG, no alpha):

| Dashboard field | File | Size |
|---|---|---|
| Store icon | `store/icon-128.png` | 128x128 |
| Screenshot 1 | `store/out/screenshot-1-hero.png` | 1280x800 |
| Screenshot 2 | `store/out/screenshot-2-tags.png` | 1280x800 |
| Screenshot 3 | `store/out/screenshot-3-ads.png` | 1280x800 |
| Screenshot 4 | `store/out/screenshot-4-export.png` | 1280x800 |
| Small promo tile | `store/out/promo-small.png` | 440x280 |
| Marquee promo tile | `store/out/promo-marquee.png` | 1400x560 |

Missing:

- Screenshot 5 (the store accepts up to five, four are ready).
- A YouTube link for the promo video field. The explainer exists only as a file on
  https://superpixel.run/video/ and the dashboard accepts only a YouTube URL.

## Upload checklist

1. Developer dashboard > Superpixel > Package > Upload new package: the zip from the latest release.
2. Store listing: paste the description, check that all graphics above are set.
3. Privacy practices: paste the single purpose and the permission justifications if the form asks again.
4. Submit for review.
