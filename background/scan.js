// Scan orchestration: layer A (on-site tags + seeds), then the ad-library adapters in two waves:
// google + meta first (in parallel), their primary advertiser names become
// seeds.advertiserNames, then the name-based platforms (tiktok, linkedin, bing, snap) in parallel.
import { normalizeDomain, hostOf, registrableDomain } from '../lib/domain.js';
import { sleep, withTimeout } from '../lib/util.js';
import { makeResult, makeAd, dedupeAds, assignRoles, advertiserNameSeeds } from '../lib/model.js';
import { stripTags } from '../lib/html.js';
import { detectTags, extractSeeds, containerIds, gtagLoaderIds, detectTagsInContainer, mergeTags } from '../detect/detect.js';
import { GTAG_PLATFORMS } from '../detect/signatures.js';
import { probe } from '../detect/page-probe.js';
import { ADAPTERS } from '../adapters/index.js';
import { manualLibraries } from '../adapters/manual.js';
import * as searchapi from '../adapters/searchapi.js';
import { loadSettings } from './settings.js';
import * as cache from './cache.js';
import { getThrottle } from './queue.js';
import { log, logInfo, logWarn, logError, safeUrl, errText } from './log.js';
import { remoteLog } from './remote-log.js';
import {
  openCaptureTab,
  openCaptureTabDom,
  openScanTab,
  waitForComplete,
  closeScanTab,
  closeScanWindow,
} from './hidden-tab.js';

/** Min interval between requests per platform (spec section 4; Bing 429s after ~5 quick calls). */
export const THROTTLE_MS = { google: 900, meta: 1000, tiktok: 3000, linkedin: 2500, bing: 1500, snap: 3000 };
/** First wave: their advertisers seed the name-based platforms of the second wave. */
export const FIRST_WAVE = ['google', 'meta'];
const FETCH_TIMEOUT_MS = 30000;
const FALLBACK_STATUSES = new Set(['changed', 'error', 'rate_limited']);
const CACHEABLE_STATUSES = new Set(['ok', 'empty']);

function isAbort(e, signal) {
  return (signal && signal.aborted) || (e && e.name === 'AbortError');
}

function publicSeeds(seeds) {
  if (!seeds || typeof seeds !== 'object') return seeds;
  const { settings, ...rest } = seeds; // never ship settings (SearchAPI key) to the panel / storage
  return rest;
}

function fetchSignal(signal) {
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.any === 'function' && typeof AbortSignal.timeout === 'function') {
    return signal ? AbortSignal.any([signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]) : AbortSignal.timeout(FETCH_TIMEOUT_MS);
  }
  return signal;
}

async function runProbe(tabId) {
  try {
    const res = await withTimeout(
      chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: probe }),
      15000,
      null,
    );
    const r = Array.isArray(res) && res[0] ? res[0].result : null;
    if (!r || typeof r !== 'object') logWarn('scan', 'Page probe returned nothing');
    return r && typeof r === 'object' ? r : null;
  } catch (e) {
    logWarn('scan', `Page probe failed: ${errText(e)}`);
    return null;
  }
}

async function fetchHomepage(domain, signal) {
  try {
    const res = await fetch(`https://${domain}/`, { credentials: 'include', signal: fetchSignal(signal) });
    const html = await res.text();
    const m = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html);
    return {
      resourceUrls: [],
      html: html.slice(0, 1.5 * 1024 * 1024),
      globals: {},
      title: m ? stripTags(m[1]) : '',
      meta: {},
      url: res.url || `https://${domain}/`,
    };
  } catch (e) {
    if (isAbort(e, signal) && signal && signal.aborted) throw e;
    logWarn('scan', `Homepage fetch failed: ${errText(e)}`);
    return null;
  }
}

const CONTAINER_TIMEOUT_MS = 15000;
export const MAX_CONTAINERS = 3;
const GTM_JS_URL = 'https://www.googletagmanager.com/gtm.js?id=';
const GTAG_JS_URL = 'https://www.googletagmanager.com/gtag/js?id=';

/** Plain SW fetch of a Google tag script (page CSP does not apply here), 15s timeout, no cookies. */
async function fetchTagScript(url, signal) {
  let sig = signal;
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    const t = AbortSignal.timeout(CONTAINER_TIMEOUT_MS);
    sig = signal && typeof AbortSignal.any === 'function' ? AbortSignal.any([signal, t]) : t;
  }
  try {
    const res = await fetch(url, { credentials: 'omit', signal: sig });
    if (!res.ok) {
      logWarn('scan', `HTTP ${res.status} ${safeUrl(url)}`);
      return '';
    }
    return await res.text();
  } catch (e) {
    if (signal && signal.aborted) throw e;
    logWarn('scan', `Tag script fetch failed ${safeUrl(url)}: ${errText(e)}`);
    return '';
  }
}

/**
 * Tags configured in the site's GTM containers and Google tag loaders. Sites with a consent
 * banner load no pixel before consent, so the page shows only GTM; the container still lists
 * every tag it would fire.
 */
async function containerTags(tags, ctxData, emit, signal) {
  const gtm = containerIds(tags, MAX_CONTAINERS);
  const gtag = gtagLoaderIds(
    {
      resourceUrls: (ctxData && Array.isArray(ctxData.resourceUrls) && ctxData.resourceUrls) || [],
      html: (ctxData && typeof ctxData.html === 'string' && ctxData.html) || '',
    },
    MAX_CONTAINERS,
  );
  if (!gtm.length && !gtag.length) return [];
  emit({ type: 'phase', text: 'Reading the site\'s Google Tag Manager container' });
  const found = [];
  for (const id of gtm) {
    const js = await fetchTagScript(GTM_JS_URL + encodeURIComponent(id), signal);
    if (js) found.push(...detectTagsInContainer(js, { evidence: `GTM container ${id}` }));
  }
  for (const id of gtag) {
    const js = await fetchTagScript(GTAG_JS_URL + encodeURIComponent(id), signal);
    if (js) found.push(...detectTagsInContainer(js, { evidence: `Google tag ${id}`, platforms: GTAG_PLATFORMS }));
  }
  if (found.length) logInfo('scan', `Container tags: ${found.map((t) => `${t.platform} ${t.ids.join('/')}`).join(', ')}`);
  return found;
}

async function resolveInput(input) {
  const mode = input && input.mode === 'tab' ? 'tab' : 'domain';
  if (mode === 'tab') {
    let tab = null;
    if (input.tabId != null) {
      tab = await chrome.tabs.get(input.tabId).catch(() => null);
    }
    if (!tab) {
      const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      tab = tabs[0] || null;
    }
    const url = (tab && (tab.url || tab.pendingUrl)) || '';
    const domain = /^https?:\/\//i.test(url) ? normalizeDomain(registrableDomain(hostOf(url))) : '';
    return { mode, domain, tabId: tab ? tab.id : null };
  }
  return { mode, domain: normalizeDomain(input && input.domain), tabId: null };
}

async function layerA({ mode, domain, tabId }, settings, emit, signal) {
  emit({ type: 'phase', text: mode === 'tab' ? 'Reading tags from the current tab' : `Loading ${domain} to read its tags` });
  let ctxData = null;
  if (mode === 'tab' && tabId != null) {
    ctxData = await runProbe(tabId);
  } else {
    let scanTab = null;
    try {
      scanTab = await openScanTab(`https://${domain}/`, { showScanTabs: settings.showScanTabs });
      await waitForComplete(scanTab, 20000);
      await sleep(8000, signal); // tags fire late via GTM
      ctxData = await runProbe(scanTab);
    } catch (e) {
      if (signal && signal.aborted) throw e;
      logWarn('scan', `Scan tab failed: ${errText(e)}`);
      ctxData = null;
    } finally {
      if (scanTab != null) await closeScanTab(scanTab);
    }
  }
  if (!ctxData) {
    emit({ type: 'phase', text: 'Page probe unavailable, reading homepage HTML' });
    ctxData = await fetchHomepage(domain, signal);
  }
  const html = (ctxData && typeof ctxData.html === 'string' && ctxData.html) || '';
  let tags = [];
  try {
    tags =
      (await detectTags({
        resourceUrls: (ctxData && Array.isArray(ctxData.resourceUrls) && ctxData.resourceUrls) || [],
        html,
        globals: (ctxData && ctxData.globals) || {},
      })) || [];
  } catch (e) {
    logError('scan', `detectTags failed: ${errText(e)}`);
    tags = [];
  }
  try {
    const extra = await containerTags(tags, ctxData, emit, signal);
    if (extra.length) tags = mergeTags(tags, extra);
  } catch (e) {
    if (signal && signal.aborted) throw e;
    logWarn('scan', `Container scan failed: ${errText(e)}`);
  }
  let seeds = null;
  try {
    seeds = await extractSeeds({
      domain,
      html,
      title: (ctxData && ctxData.title) || '',
      meta: (ctxData && ctxData.meta) || {},
      tags,
    });
  } catch (e) {
    logError('scan', `extractSeeds failed: ${errText(e)}`);
    seeds = null;
  }
  if (!seeds || typeof seeds !== 'object') {
    const label = domain.split('.')[0];
    seeds = {
      domain,
      brand: label,
      brandCandidates: [label],
      social: { facebook: [], instagram: [], linkedin: [], tiktok: [], youtube: [], x: [], pinterest: [] },
      ids: {},
    };
  }
  seeds.domain = seeds.domain || domain;
  seeds.settings = settings;
  return { tags, seeds };
}

function buildCtx(adapter, settings, emit, signal, stats) {
  const id = adapter.meta.id;
  return {
    settings,
    signal,
    fetch: async (url, init = {}) => {
      stats.requests++;
      let res;
      try {
        res = await fetch(url, { credentials: 'include', ...init, signal: init.signal || fetchSignal(signal) });
      } catch (e) {
        if (!(signal && signal.aborted)) logWarn(id, `Fetch failed ${safeUrl(url)}: ${errText(e)}`);
        throw e;
      }
      // Never log query strings: they can carry the SearchAPI key.
      if (res && (res.status < 200 || res.status >= 300)) logWarn(id, `HTTP ${res.status} ${safeUrl(url)}`);
      return res;
    },
    throttle: () => getThrottle(id, THROTTLE_MS[id] || 1000)(signal),
    capture: (url, opts = {}) => {
      stats.requests++;
      return openCaptureTab(url, { platform: id, ...opts, showScanTabs: !!settings.showScanTabs, signal });
    },
    captureDom: (url, { waitMs = 6000 } = {}) => {
      stats.requests++;
      return openCaptureTabDom(url, { waitMs, showScanTabs: !!settings.showScanTabs, signal });
    },
    progress: (text) => emit({ type: 'progress', id, text: String(text) }),
    // Adapter diagnostics into the debug log. Callers must never pass bodies or query strings.
    log: (level, msg) => log(level, id, msg),
  };
}

function safeDeepLinks(adapter, seeds) {
  try {
    const links = adapter.deepLinks(seeds);
    return Array.isArray(links) ? links : [];
  } catch {
    return [];
  }
}

async function applySearchapiFallback(adapter, result, seeds, ctx, settings, signal) {
  const id = adapter.meta.id;
  if (!FALLBACK_STATUSES.has(result.status)) return result;
  if (!settings.searchapiKey || !settings.useSearchapiFallback) return result;
  if (signal && signal.aborted) return result;
  try {
    if (typeof searchapi.supports === 'function' && !searchapi.supports(id)) return result;
    ctx.progress('Trying SearchAPI fallback');
    const fb = await searchapi.fallback(id, seeds, ctx);
    const fbAds = (Array.isArray(fb) ? fb : (fb && fb.ads) || []).map((a) => makeAd({ ...a, platform: a.platform || id, source: 'searchapi' }));
    const fbAdvertisers = (!Array.isArray(fb) && fb && Array.isArray(fb.advertisers) && fb.advertisers) || [];
    if (!fbAds.length && !fbAdvertisers.length) {
      const why = (!Array.isArray(fb) && fb && fb.message) || 'returned nothing';
      result.message = [result.message, `SearchAPI fallback: ${why}`].filter(Boolean).join(' - ');
      return result;
    }
    result.ads = dedupeAds([...result.ads, ...fbAds]);
    const known = new Set(result.advertisers.map((a) => a.id || a.name));
    for (const adv of fbAdvertisers) {
      const k = adv && (adv.id || adv.name);
      if (k && !known.has(k)) {
        known.add(k);
        result.advertisers.push(adv);
      }
    }
    result.message = [result.message, `results from SearchAPI fallback (${fbAds.length} ads)`].filter(Boolean).join(' - ');
    result.status = 'ok';
  } catch (e) {
    logError(id, `SearchAPI fallback failed: ${errText(e)}`);
    result.message = [result.message, `SearchAPI fallback failed: ${(e && e.message) || e}`].filter(Boolean).join(' - ');
  }
  return result;
}

async function runAdapter(adapter, seeds, settings, domain, force, emit, signal) {
  const meta = adapter.meta;
  const t0 = Date.now();
  emit({ type: 'platformStart', id: meta.id, label: meta.label, coverage: meta.coverage });
  const cacheKey = `${meta.id}:${domain}`;

  if (!force) {
    const cached = await cache.get(cacheKey);
    if (cached && typeof cached === 'object') {
      const result = makeResult(meta, { ...cached, cached: true });
      result.advertisers = assignRoles(result.advertisers);
      logInfo(meta.id, `Cached result: ${result.status}, ${result.ads.length} ads`);
      emit({ type: 'platform', result });
      return result;
    }
  }

  logInfo(meta.id, 'Adapter start');
  const stats = { requests: 0 };
  const ctx = buildCtx(adapter, settings, emit, signal, stats);
  let result;
  try {
    const raw = await adapter.search(seeds, ctx);
    if (!raw || typeof raw !== 'object') {
      result = makeResult(meta, { status: 'changed', message: `${meta.label} adapter returned no result` });
    } else {
      result = makeResult(meta, raw);
    }
  } catch (e) {
    const stopped = isAbort(e, signal);
    if (!stopped) logError(meta.id, `Adapter threw: ${errText(e)}`);
    result = makeResult(meta, {
      status: 'error',
      message: stopped ? 'Stopped' : `Unexpected error: ${(e && e.message) || e}`,
    });
  }

  result = await applySearchapiFallback(adapter, result, seeds, ctx, settings, signal);
  result.advertisers = assignRoles(result.advertisers);

  if (!result.deepLinks.length) result.deepLinks = safeDeepLinks(adapter, seeds);
  result.stats = {
    requests: Math.max(stats.requests, Number(result.stats && result.stats.requests) || 0),
    ms: Date.now() - t0,
  };

  const finishMsg = `Adapter finish: ${result.status}, ${result.ads.length} ads, ${result.stats.requests} requests, ${result.stats.ms}ms${result.message ? ` - ${result.message}` : ''}`;
  if (result.status === 'error' || result.status === 'changed') logWarn(meta.id, finishMsg);
  else logInfo(meta.id, finishMsg);

  if (!(signal && signal.aborted) && CACHEABLE_STATUSES.has(result.status)) {
    await cache.set(cacheKey, result, settings.cacheHours);
  }
  emit({ type: 'platform', result });
  return result;
}

function summarize(domain, tags, results, t0, stopped) {
  const platforms = {};
  let totalAds = 0;
  let confirmedAds = 0;
  for (const r of results) {
    const confirmed = r.ads.filter((a) => a.match === 'confirmed').length;
    platforms[r.platform] = { status: r.status, ads: r.ads.length, confirmed, advertisers: r.advertisers.length, cached: !!r.cached };
    totalAds += r.ads.length;
    confirmedAds += confirmed;
  }
  return { domain, tags: tags.length, totalAds, confirmedAds, platforms, ms: Date.now() - t0, stopped: !!stopped };
}

/**
 * Run a full scan. Emits progress messages (spec 3.7) through `emit`.
 * @param {{input:{mode:'tab'|'domain', tabId?:number, domain?:string}, force?:boolean}} args
 * @param {(msg:object)=>void} emit
 * @param {AbortSignal} signal
 */
export async function runScan({ input, force } = {}, emit, signal) {
  const t0 = Date.now();
  const say = (m) => {
    try {
      emit(m);
    } catch {
      // port closed
    }
  };
  let domain = '';
  let tags = [];
  let seeds = null;
  const results = [];
  try {
    const settings = await loadSettings();
    const resolved = await resolveInput(input || {});
    domain = resolved.domain;
    if (!domain) {
      say({
        type: 'error',
        message: resolved.mode === 'tab' ? 'The current tab is not a website that can be scanned' : 'Enter a valid domain, e.g. example.com',
      });
      return;
    }
    remoteLog().scanStart(domain); // collects this scan's entries for the opt-in remote log
    logInfo('scan', `Scan start ${domain} (${resolved.mode}${force ? ', forced' : ''})`);

    ({ tags, seeds } = await layerA(resolved, settings, say, signal));
    say({ type: 'tags', tags, seeds: publicSeeds(seeds) });
    let manual = [];
    try {
      manual = manualLibraries(seeds);
    } catch (e) {
      logWarn('scan', `manualLibraries failed: ${errText(e)}`);
    }
    say({ type: 'manual', libraries: manual });

    say({ type: 'phase', text: 'Searching ad libraries' });
    const enabled = [];
    for (const adapter of ADAPTERS) {
      const on = !settings.platforms || settings.platforms[adapter.meta.id] !== false;
      if (on) {
        enabled.push(adapter);
      } else {
        const r = makeResult(adapter.meta, { status: 'skipped', message: 'Disabled in settings', deepLinks: safeDeepLinks(adapter, seeds) });
        results.push(r);
        say({ type: 'platform', result: r });
      }
    }

    const runWave = async (wave) => {
      const settled = await Promise.allSettled(wave.map((a) => runAdapter(a, seeds, settings, domain, !!force, say, signal)));
      const out = [];
      settled.forEach((s, i) => {
        if (s.status === 'fulfilled') {
          out.push(s.value);
        } else {
          const a = wave[i];
          logError(a.meta.id, `Adapter rejected: ${errText(s.reason)}`);
          const r = makeResult(a.meta, {
            status: 'error',
            message: `Unexpected error: ${(s.reason && s.reason.message) || s.reason}`,
            deepLinks: safeDeepLinks(a, seeds),
          });
          say({ type: 'platform', result: r });
          out.push(r);
        }
      });
      results.push(...out);
      return out;
    };

    // Wave 1: google + meta. Their primary advertiser names ("BLG INC" for babylovegrowth.ai)
    // are what the name-based libraries of wave 2 need.
    const first = enabled.filter((a) => FIRST_WAVE.includes(a.meta.id));
    const second = enabled.filter((a) => !FIRST_WAVE.includes(a.meta.id));
    if (first.length && second.length) {
      for (const a of second) {
        say({ type: 'platformStart', id: a.meta.id, label: a.meta.label, coverage: a.meta.coverage });
        say({ type: 'progress', id: a.meta.id, text: 'Waiting for advertiser names from Google and Meta' });
      }
    }
    const firstResults = await runWave(first);
    seeds.advertiserNames = advertiserNameSeeds(firstResults, { max: 5 });
    if (seeds.advertiserNames.length) logInfo('scan', `Advertiser names: ${seeds.advertiserNames.join(', ')}`);
    say({ type: 'seeds', seeds: publicSeeds(seeds) });

    // Wave 2: tiktok, linkedin, bing, snap, with seeds.advertiserNames available.
    await runWave(second);

    const order = ADAPTERS.map((a) => a.meta.id);
    results.sort((a, b) => order.indexOf(a.platform) - order.indexOf(b.platform));

    const stopped = !!(signal && signal.aborted);
    const summary = summarize(domain, tags, results, t0, stopped);
    try {
      await chrome.storage.local.set({
        lastScan: { domain, at: new Date().toISOString(), tags, seeds: publicSeeds(seeds), results, manual },
      });
    } catch (e) {
      // quota errors are not fatal
      logWarn('scan', `Saving lastScan failed: ${errText(e)}`);
    }
    logInfo('scan', `Scan end ${domain}: ${summary.totalAds} ads (${summary.confirmedAds} confirmed), ${summary.ms}ms${stopped ? ', stopped' : ''}`);
    say({ type: 'done', summary });
  } catch (e) {
    if (isAbort(e, signal)) {
      logInfo('scan', `Scan stopped ${domain}`);
      say({ type: 'done', summary: summarize(domain, tags, results, t0, true) });
    } else {
      logError('scan', `Scan failed ${domain}: ${errText(e)}`);
      say({ type: 'error', message: `Scan failed: ${(e && e.message) || e}` });
    }
  } finally {
    try {
      await closeScanWindow();
    } finally {
      // Ships the batch only with consent; never throws, not awaited so the scan ends promptly.
      remoteLog().scanEnd().catch(() => {});
    }
  }
}
