// Scan orchestration: layer A (on-site tags + seeds), then all enabled ad-library adapters in parallel.
import { normalizeDomain, hostOf, registrableDomain } from '../lib/domain.js';
import { sleep, withTimeout } from '../lib/util.js';
import { makeResult, makeAd, dedupeAds } from '../lib/model.js';
import { stripTags } from '../lib/html.js';
import { detectTags, extractSeeds } from '../detect/detect.js';
import { probe } from '../detect/page-probe.js';
import { ADAPTERS } from '../adapters/index.js';
import * as searchapi from '../adapters/searchapi.js';
import { loadSettings } from './settings.js';
import * as cache from './cache.js';
import { getThrottle } from './queue.js';
import {
  openCaptureTab,
  openCaptureTabDom,
  openScanTab,
  waitForComplete,
  closeScanTab,
  closeScanWindow,
} from './hidden-tab.js';

/** Min interval between requests per platform (spec section 4). */
const THROTTLE_MS = { google: 900, meta: 1000, tiktok: 3000, linkedin: 2500, bing: 400, snap: 3000 };
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
    return r && typeof r === 'object' ? r : null;
  } catch {
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
    return null;
  }
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
  } catch {
    tags = [];
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
  } catch {
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
    fetch: (url, init = {}) => {
      stats.requests++;
      return fetch(url, { credentials: 'include', ...init, signal: init.signal || fetchSignal(signal) });
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
      emit({ type: 'platform', result });
      return result;
    }
  }

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
    result = makeResult(meta, {
      status: 'error',
      message: stopped ? 'Stopped' : `Unexpected error: ${(e && e.message) || e}`,
    });
  }

  result = await applySearchapiFallback(adapter, result, seeds, ctx, settings, signal);

  if (!result.deepLinks.length) result.deepLinks = safeDeepLinks(adapter, seeds);
  result.stats = {
    requests: Math.max(stats.requests, Number(result.stats && result.stats.requests) || 0),
    ms: Date.now() - t0,
  };

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

    ({ tags, seeds } = await layerA(resolved, settings, say, signal));
    say({ type: 'tags', tags, seeds: publicSeeds(seeds) });

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

    const settled = await Promise.allSettled(enabled.map((a) => runAdapter(a, seeds, settings, domain, !!force, say, signal)));
    settled.forEach((s, i) => {
      if (s.status === 'fulfilled') {
        results.push(s.value);
      } else {
        const a = enabled[i];
        const r = makeResult(a.meta, {
          status: 'error',
          message: `Unexpected error: ${(s.reason && s.reason.message) || s.reason}`,
          deepLinks: safeDeepLinks(a, seeds),
        });
        results.push(r);
        say({ type: 'platform', result: r });
      }
    });

    const order = ADAPTERS.map((a) => a.meta.id);
    results.sort((a, b) => order.indexOf(a.platform) - order.indexOf(b.platform));

    const stopped = !!(signal && signal.aborted);
    const summary = summarize(domain, tags, results, t0, stopped);
    try {
      await chrome.storage.local.set({
        lastScan: { domain, at: new Date().toISOString(), tags, seeds: publicSeeds(seeds), results },
      });
    } catch {
      // quota errors are not fatal
    }
    say({ type: 'done', summary });
  } catch (e) {
    if (isAbort(e, signal)) {
      say({ type: 'done', summary: summarize(domain, tags, results, t0, true) });
    } else {
      say({ type: 'error', message: `Scan failed: ${(e && e.message) || e}` });
    }
  } finally {
    await closeScanWindow();
  }
}
