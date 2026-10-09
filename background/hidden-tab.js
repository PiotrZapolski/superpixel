// Capture tabs in a dedicated, unfocused (minimized) scan window.
// Content scripts (content/hook-main.js + content/relay.js) forward network captures from these tabs.
import { logInfo, logWarn, safeUrl, errText } from './log.js';

const MAX_PAYLOADS_PER_TAB = 400;
const LOAD_TIMEOUT_MS = 20000;
const POLL_MS = 250;
// Chrome can swap a tab for another one (prerender, process swap); the old id may be reported as
// removed just before onReplaced arrives. Wait this long before treating a removal as a close.
const REPLACE_GRACE_MS = 500;
// content/hook-main.js posts this url instead of letting the page close its own tab.
export const WINDOW_CLOSE_URL = 'superpixel:window-close';
// Extension page a capture tab starts on, so its session history has 2 entries once it navigates
// to the target: Chrome then ignores a script's window.close() (issue #17).
const BLANK_PATH = 'blank.html';
const BLANK_WAIT_MS = 2000;

let scanWindowId = null;
let anchorTabId = null;
let windowPromise = null;

/** Tabs opened by this module (the relay asks whether its tab is one of them). */
const captureTabs = new Set();
/**
 * tabId -> session. The diagnostics fields come from chrome.tabs events:
 * {payloads:[], lastAt:number, closed:boolean, tabId:number|null, lastUrl:string, lastStatus:string,
 *  discarded:boolean, replaced:number, removeInfo:{windowClosing:boolean, scanWindow:boolean}|null,
 *  closeTimer:any, windowCloses:number}
 */
const sessions = new Map();
/** Capture tab ids removed a moment ago (onReplaced may still follow the removal). */
const recentlyRemoved = new Set();

function newSession() {
  return {
    payloads: [], lastAt: 0, closed: false, tabId: null,
    lastUrl: '', lastStatus: '', discarded: false, replaced: 0, removeInfo: null, closeTimer: null,
    windowCloses: 0,
  };
}

/** chrome-extension://<id>/blank.html, or '' outside the extension (tests). */
function blankUrl() {
  try {
    return typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL ? chrome.runtime.getURL(BLANK_PATH) : '';
  } catch {
    return '';
  }
}

/**
 * True for a url a capture tab is really loading: not empty, not about:blank, not our blank page.
 * @param {string} u
 * @param {string} [blank]
 */
export function isRealTabUrl(u, blank = blankUrl()) {
  if (!u || u === 'about:blank') return false;
  if (blank && u.split(/[?#]/)[0] === blank) return false;
  return true;
}

/**
 * Up to 3 distinct script urls from a stack trace, without query strings and without our own
 * extension frames (the window.close wrapper itself).
 * @param {string} stack
 * @returns {string}
 */
export function stackFrameUrls(stack) {
  const out = [];
  const re = /\b((?:https?|blob|chrome-extension):\/\/[^\s()]+)/g;
  let m;
  while ((m = re.exec(String(stack || ''))) && out.length < 3) {
    const raw = m[1];
    if (raw.startsWith('chrome-extension://')) continue;
    const pos = raw.match(/(:\d+:\d+)$/);
    const base = (pos ? raw.slice(0, -pos[1].length) : raw).split(/[?#]/)[0];
    const u = base + (pos ? pos[1] : '');
    if (!out.includes(u)) out.push(u);
  }
  return out.join(' < ');
}

// One capture tab at a time (meta and tiktok share it).
let mutexTail = Promise.resolve();
function acquireMutex() {
  let release;
  const held = new Promise((r) => {
    release = r;
  });
  const prev = mutexTail;
  mutexTail = prev.then(() => held);
  return prev.then(() => release);
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, Math.max(0, ms)));
}

if (typeof chrome !== 'undefined' && chrome.tabs && chrome.tabs.onRemoved) {
  chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
    if (captureTabs.has(tabId)) {
      recentlyRemoved.add(tabId);
      setTimeout(() => recentlyRemoved.delete(tabId), 5000);
    }
    captureTabs.delete(tabId);
    if (tabId === anchorTabId) anchorTabId = null;
    const s = sessions.get(tabId);
    if (!s) return;
    s.removeInfo = {
      windowClosing: !!(removeInfo && removeInfo.isWindowClosing),
      scanWindow: !!(removeInfo && scanWindowId != null && removeInfo.windowId === scanWindowId),
    };
    if (!s.closeTimer) {
      s.closeTimer = setTimeout(() => {
        s.closeTimer = null;
        if (sessions.get(tabId) === s) s.closed = true;
      }, REPLACE_GRACE_MS);
    }
  });
}
if (typeof chrome !== 'undefined' && chrome.tabs && chrome.tabs.onUpdated) {
  chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
    const s = sessions.get(tabId);
    if (!s || !info) return;
    const url = info.url || (tab && tab.url) || '';
    if (url) s.lastUrl = url;
    if (info.status) s.lastStatus = info.status;
    if (info.discarded) s.discarded = true;
  });
}
if (typeof chrome !== 'undefined' && chrome.tabs && chrome.tabs.onReplaced) {
  // Chrome swapped the tab (prerender, process swap): the capture continues under the new id.
  chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
    if (removedTabId === anchorTabId) anchorTabId = addedTabId;
    const s = sessions.get(removedTabId);
    if (!s && !captureTabs.has(removedTabId) && !recentlyRemoved.has(removedTabId)) return;
    captureTabs.delete(removedTabId);
    recentlyRemoved.delete(removedTabId);
    captureTabs.add(addedTabId);
    if (s) {
      sessions.delete(removedTabId);
      sessions.set(addedTabId, s);
      s.tabId = addedTabId;
      s.replaced += 1;
      s.removeInfo = null;
      if (s.closeTimer) clearTimeout(s.closeTimer);
      s.closeTimer = null;
      s.closed = false;
    }
    logInfo('capture', `Tab replaced ${removedTabId} -> ${addedTabId}${s && s.lastUrl ? ` on ${safeUrl(s.lastUrl)}` : ''}`);
  });
}

/** Reason detail for the close log line: last url (no query), status, how the tab went away. */
function closeDetail(s) {
  const parts = [`last url ${s.lastUrl ? safeUrl(s.lastUrl) : '-'}`, `status ${s.lastStatus || '-'}`];
  if (s.removeInfo) {
    parts.push(`window closing: ${s.removeInfo.windowClosing ? 'yes' : 'no'}`);
    parts.push(`scan window: ${s.removeInfo.scanWindow ? 'yes' : 'no'}`);
  } else {
    parts.push('no remove event');
  }
  if (s.discarded) parts.push('discarded');
  if (s.windowCloses) parts.push(`window.close() blocked ${s.windowCloses}x`);
  if (s.replaced) parts.push(`replaced ${s.replaced}x`);
  return parts.join(', ');
}

function errorWithDetail(error, s) {
  if (error === 'tab_closed' || error === 'timeout') return `${error} (${closeDetail(s)})`;
  return error;
}
if (typeof chrome !== 'undefined' && chrome.windows && chrome.windows.onRemoved) {
  chrome.windows.onRemoved.addListener((windowId) => {
    if (windowId === scanWindowId) {
      scanWindowId = null;
      anchorTabId = null;
    }
  });
}

async function windowAlive(id) {
  if (id == null) return false;
  try {
    await chrome.windows.get(id);
    return true;
  } catch {
    return false;
  }
}

async function ensureScanWindow(showScanTabs) {
  if (await windowAlive(scanWindowId)) return scanWindowId;
  if (windowPromise) return windowPromise;
  windowPromise = (async () => {
    // The first tab is an about:blank anchor that keeps the window alive while capture tabs rotate.
    const win = await chrome.windows.create({
      url: 'about:blank',
      focused: false,
      state: showScanTabs ? 'normal' : 'minimized',
    });
    scanWindowId = win.id;
    anchorTabId = win.tabs && win.tabs[0] ? win.tabs[0].id : null;
    return win.id;
  })();
  try {
    return await windowPromise;
  } finally {
    windowPromise = null;
  }
}

/** Wait (bounded) until the tab committed our blank page, so the next navigation adds an entry. */
async function waitForBlank(tabId, blank) {
  const end = Date.now() + BLANK_WAIT_MS;
  while (Date.now() < end) {
    try {
      const t = await chrome.tabs.get(tabId);
      if (t.url === blank && t.status === 'complete') return;
    } catch {
      return;
    }
    await delay(25);
  }
}

async function createTab(url, { showScanTabs = false, beforeNavigate } = {}) {
  const windowId = await ensureScanWindow(showScanTabs);
  // Create blank first and register the tab id BEFORE navigating, so the relay's isCaptureTab
  // question (sent at document_start) is always answered with true. The blank page is our own
  // extension page (not about:blank, whose entry the next navigation replaces): with 2 history
  // entries the target page can no longer close the tab with window.close().
  const blank = blankUrl();
  const tab = await chrome.tabs.create({ windowId, url: blank || 'about:blank', active: true });
  captureTabs.add(tab.id);
  if (beforeNavigate) beforeNavigate(tab.id);
  if (blank) await waitForBlank(tab.id, blank);
  await chrome.tabs.update(tab.id, { url });
  return tab.id;
}

/**
 * Open a tab in the scan window (layer A domain scans).
 * @param {string} url
 * @param {{showScanTabs?:boolean}} [opts]
 * @returns {Promise<number>} tabId
 */
export async function openScanTab(url, { showScanTabs = false } = {}) {
  return createTab(url, { showScanTabs });
}

/**
 * Wait until the tab finished loading a non-blank URL. Resolves true on complete, false on
 * timeout or when the tab is gone. Never rejects.
 * @param {number} tabId
 * @param {number} [timeoutMs]
 * @returns {Promise<boolean>}
 */
export function waitForComplete(tabId, timeoutMs = LOAD_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let done = false;
    let timer = null;
    let removeTimer = null;
    const hasReplaced = !!(chrome.tabs && chrome.tabs.onReplaced);
    const finish = (v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(removeTimer);
      try {
        chrome.tabs.onUpdated.removeListener(onUpdated);
        chrome.tabs.onRemoved.removeListener(onRemoved);
        if (hasReplaced) chrome.tabs.onReplaced.removeListener(onReplaced);
      } catch {
        // ignore
      }
      resolve(v);
    };
    const blank = blankUrl();
    const isReal = (u) => isRealTabUrl(u, blank);
    const onUpdated = (id, info, tab) => {
      if (id !== tabId) return;
      if (info.status === 'complete' && isReal(tab && tab.url)) finish(true);
    };
    const onRemoved = (id) => {
      if (id !== tabId || removeTimer) return;
      removeTimer = setTimeout(() => finish(false), REPLACE_GRACE_MS);
    };
    // A replaced tab (prerender, process swap) lives on under the new id.
    const onReplaced = (addedId, removedId) => {
      if (removedId !== tabId) return;
      tabId = addedId;
      clearTimeout(removeTimer);
      removeTimer = null;
      chrome.tabs
        .get(addedId)
        .then((tab) => {
          if (tab.status === 'complete' && isReal(tab.url) && !tab.pendingUrl) finish(true);
        })
        .catch(() => {});
    };
    try {
      chrome.tabs.onUpdated.addListener(onUpdated);
      chrome.tabs.onRemoved.addListener(onRemoved);
      if (hasReplaced) chrome.tabs.onReplaced.addListener(onReplaced);
    } catch {
      finish(false);
      return;
    }
    timer = setTimeout(() => finish(false), timeoutMs);
    chrome.tabs
      .get(tabId)
      .then((tab) => {
        if (tab.status === 'complete' && isReal(tab.url) && !tab.pendingUrl) finish(true);
      })
      .catch(() => finish(false));
  });
}

/** @param {number} tabId */
export async function closeScanTab(tabId) {
  captureTabs.delete(tabId);
  const s = sessions.get(tabId);
  if (s && s.closeTimer) {
    clearTimeout(s.closeTimer);
    s.closeTimer = null;
  }
  sessions.delete(tabId);
  if (tabId == null) return;
  try {
    await chrome.tabs.remove(tabId);
  } catch {
    // already closed
  }
}

/** Close the scan window (end of scan). */
export async function closeScanWindow() {
  const id = scanWindowId;
  scanWindowId = null;
  anchorTabId = null;
  if (id == null) return;
  try {
    await chrome.windows.remove(id);
  } catch {
    // already closed
  }
}

/** @param {number} tabId */
export function isCaptureTab(tabId) {
  return captureTabs.has(tabId);
}

async function tabUrlOf(tabId) {
  try {
    const t = await chrome.tabs.get(tabId);
    return t.url || t.pendingUrl || '';
  } catch {
    return '';
  }
}

/**
 * Ask the relay in the tab for page text + absolute hrefs. Never rejects.
 * @param {number} tabId
 * @returns {Promise<{text:string, hrefs:string[]}>}
 */
export async function sendDomCommand(tabId) {
  try {
    const res = await Promise.race([
      chrome.tabs.sendMessage(tabId, { cmd: 'dom' }),
      delay(5000).then(() => null),
    ]);
    return {
      text: res && typeof res.text === 'string' ? res.text : '',
      hrefs: res && Array.isArray(res.hrefs) ? res.hrefs : [],
    };
  } catch {
    return { text: '', hrefs: [] };
  }
}

async function sendScroll(tabId) {
  try {
    await Promise.race([chrome.tabs.sendMessage(tabId, { cmd: 'scroll' }), delay(3000)]);
  } catch {
    // relay not ready or tab gone
  }
}

/**
 * Wait up to ms, returning early when stop() is true. Returns 'aborted' | 'closed' | 'stop' | 'time'.
 */
async function waitLoop(ms, session, signal, stop) {
  const end = Date.now() + Math.max(0, ms);
  for (;;) {
    if (signal && signal.aborted) return 'aborted';
    if (session.closed) return 'closed';
    if (stop && stop()) return 'stop';
    const left = end - Date.now();
    if (left <= 0) return 'time';
    await delay(Math.min(POLL_MS, left));
  }
}

/**
 * Open a capture tab, collect network payloads forwarded by the relay, scroll, close.
 * Always resolves.
 * @param {string} url
 * @param {{platform?:string, waitMs?:number, scrolls?:number, scrollDelayMs?:number, quietMs?:number,
 *   showScanTabs?:boolean, signal?:AbortSignal, until?:(payloads:any[])=>boolean}} [opts]
 * @returns {Promise<{payloads:{url:string,status:number,body:string,reqBody:string}[], tabUrl:string, error:string}>}
 */
export async function openCaptureTab(url, opts = {}) {
  const {
    waitMs = 6000,
    scrolls = 0,
    scrollDelayMs = 2500,
    quietMs = 2500,
    showScanTabs = false,
    signal,
    until,
  } = opts;
  const session = newSession();
  let tabId = null;
  // The live id: session.tabId follows chrome.tabs.onReplaced.
  const liveId = () => (session.tabId != null ? session.tabId : tabId);
  let tabUrl = '';
  let error = '';
  let release = null;
  try {
    release = await acquireMutex();
    if (signal && signal.aborted) return { payloads: [], tabUrl: '', error: 'aborted' };
    const untilHit = () => {
      if (typeof until !== 'function') return false;
      try {
        return !!until(session.payloads);
      } catch {
        return false;
      }
    };

    tabId = await createTab(url, {
      showScanTabs,
      beforeNavigate: (id) => {
        session.tabId = id;
        sessions.set(id, session);
      },
    });
    logInfo('capture', `Open ${opts.platform || ''} tab ${safeUrl(url)}`);

    const loaded = await waitForComplete(liveId(), LOAD_TIMEOUT_MS);
    if (!loaded) logWarn('capture', `Load timeout ${safeUrl(url)}`);
    const loadedAt = Date.now();

    // Initial wait: waitMs after load, or earlier once payloads arrived and went quiet.
    let r = await waitLoop(waitMs, session, signal, () => {
      if (untilHit()) return true;
      const now = Date.now();
      return session.payloads.length > 0 && now - session.lastAt >= quietMs && now - loadedAt >= Math.min(waitMs, 2000);
    });

    for (let i = 0; i < scrolls && (r === 'time' || r === 'stop') && !untilHit(); i++) {
      await sendScroll(liveId());
      r = await waitLoop(scrollDelayMs, session, signal, untilHit);
    }

    // Final quiet period: wait until no new payload for quietMs (bounded).
    if (r === 'time' || r === 'stop') {
      r = await waitLoop(scrollDelayMs + quietMs, session, signal, () => untilHit() || Date.now() - session.lastAt >= quietMs);
    }

    if (r === 'aborted') error = 'aborted';
    else if (r === 'closed') error = 'tab_closed';
    else if (!loaded && session.payloads.length === 0) error = 'timeout';

    if (!session.closed) tabUrl = await tabUrlOf(liveId());
  } catch (e) {
    error = (e && e.message) || 'capture failed';
    logWarn('capture', `Capture failed ${safeUrl(url)}: ${errText(e)}`);
  } finally {
    if (tabId != null) await closeScanTab(liveId());
    if (release) release();
  }
  if (tabId != null) {
    const msg = `Close tab ${safeUrl(url)}: ${session.payloads.length} payloads${error ? `, ${errorWithDetail(error, session)}` : ''}${tabUrl ? `, ended on ${safeUrl(tabUrl)}` : ''}`;
    if (error && error !== 'aborted') logWarn('capture', msg);
    else logInfo('capture', msg);
  }
  return { payloads: session.payloads, tabUrl, error };
}

/**
 * Open a capture tab, wait for load + waitMs, read page text and hrefs via the relay, close.
 * Always resolves.
 * @param {string} url
 * @param {{waitMs?:number, showScanTabs?:boolean, signal?:AbortSignal}} [opts]
 * @returns {Promise<{text:string, hrefs:string[], tabUrl:string, error:string}>}
 */
export async function openCaptureTabDom(url, opts = {}) {
  const { waitMs = 6000, showScanTabs = false, signal } = opts;
  const session = newSession();
  let tabId = null;
  const liveId = () => (session.tabId != null ? session.tabId : tabId);
  let tabUrl = '';
  let error = '';
  let dom = { text: '', hrefs: [] };
  let release = null;
  try {
    release = await acquireMutex();
    if (signal && signal.aborted) return { text: '', hrefs: [], tabUrl: '', error: 'aborted' };
    tabId = await createTab(url, {
      showScanTabs,
      beforeNavigate: (id) => {
        session.tabId = id;
        sessions.set(id, session);
      },
    });
    logInfo('capture', `Open DOM tab ${safeUrl(url)}`);
    const loaded = await waitForComplete(liveId(), LOAD_TIMEOUT_MS);
    if (!loaded) logWarn('capture', `Load timeout ${safeUrl(url)}`);
    // Wait waitMs, extended while network captures keep arriving (bounded to 2x waitMs).
    let r = await waitLoop(waitMs, session, signal, null);
    if (r === 'time') {
      r = await waitLoop(waitMs, session, signal, () => Date.now() - session.lastAt >= 1500);
    }
    if (r === 'aborted') error = 'aborted';
    else if (r === 'closed') error = 'tab_closed';
    else {
      dom = await sendDomCommand(liveId());
      tabUrl = await tabUrlOf(liveId());
      if (!loaded && !dom.text) error = 'timeout';
      else if (!dom.text && !dom.hrefs.length) error = 'no_dom';
    }
  } catch (e) {
    error = (e && e.message) || 'capture failed';
    logWarn('capture', `DOM capture failed ${safeUrl(url)}: ${errText(e)}`);
  } finally {
    if (tabId != null) await closeScanTab(liveId());
    if (release) release();
  }
  if (tabId != null) {
    const msg = `Close DOM tab ${safeUrl(url)}: ${dom.hrefs.length} links, ${dom.text.length} chars${error ? `, ${errorWithDetail(error, session)}` : ''}`;
    if (error && error !== 'aborted') logWarn('capture', msg);
    else logInfo('capture', msg);
  }
  return { text: dom.text, hrefs: dom.hrefs, tabUrl, error };
}

/**
 * Runtime message handler for content/relay.js. Returns a response object (or undefined when the
 * message is not handled). sw.js wires it into chrome.runtime.onMessage.
 * @param {any} msg
 * @param {chrome.runtime.MessageSender} sender
 */
export function handleRuntimeMessage(msg, sender) {
  if (!msg || typeof msg !== 'object') return undefined;
  const tabId = sender && sender.tab ? sender.tab.id : undefined;
  if (msg.type === 'isCaptureTab') {
    return { isCaptureTab: tabId !== undefined && captureTabs.has(tabId) };
  }
  if (msg.type === 'capture') {
    const s = tabId !== undefined ? sessions.get(tabId) : undefined;
    if (!s || !captureTabs.has(tabId)) return { ok: false };
    if (msg.url === WINDOW_CLOSE_URL) {
      // Diagnostics only: never a payload, never counts as network activity.
      s.windowCloses += 1;
      if (s.windowCloses === 1) {
        const where = s.lastUrl || (sender.tab && sender.tab.url) || '';
        const frames = stackFrameUrls(typeof msg.body === 'string' ? msg.body : '');
        logWarn('capture', `Page called window.close() on ${safeUrl(where)}: ${frames || 'no stack frames'}`);
      }
      return { ok: true };
    }
    if (s.payloads.length < MAX_PAYLOADS_PER_TAB) {
      s.payloads.push({
        url: typeof msg.url === 'string' ? msg.url : '',
        status: typeof msg.status === 'number' ? msg.status : Number(msg.status) || 0,
        body: typeof msg.body === 'string' ? msg.body : '',
        reqBody: typeof msg.reqBody === 'string' ? msg.reqBody : '',
      });
    }
    s.lastAt = Date.now();
    return { ok: true };
  }
  return undefined;
}
