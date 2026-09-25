// Capture tabs in a dedicated, unfocused (minimized) scan window.
// Content scripts (content/hook-main.js + content/relay.js) forward network captures from these tabs.

const MAX_PAYLOADS_PER_TAB = 400;
const LOAD_TIMEOUT_MS = 20000;
const POLL_MS = 250;

let scanWindowId = null;
let anchorTabId = null;
let windowPromise = null;

/** Tabs opened by this module (the relay asks whether its tab is one of them). */
const captureTabs = new Set();
/** tabId -> {payloads:[], lastAt:number, closed:boolean} */
const sessions = new Map();

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
  chrome.tabs.onRemoved.addListener((tabId) => {
    captureTabs.delete(tabId);
    const s = sessions.get(tabId);
    if (s) s.closed = true;
    if (tabId === anchorTabId) anchorTabId = null;
  });
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

async function createTab(url, { showScanTabs = false, beforeNavigate } = {}) {
  const windowId = await ensureScanWindow(showScanTabs);
  // Create blank first and register the tab id BEFORE navigating, so the relay's isCaptureTab
  // question (sent at document_start) is always answered with true.
  const tab = await chrome.tabs.create({ windowId, url: 'about:blank', active: true });
  captureTabs.add(tab.id);
  if (beforeNavigate) beforeNavigate(tab.id);
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
    const finish = (v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        chrome.tabs.onUpdated.removeListener(onUpdated);
        chrome.tabs.onRemoved.removeListener(onRemoved);
      } catch {
        // ignore
      }
      resolve(v);
    };
    const isReal = (u) => !!u && u !== 'about:blank';
    const onUpdated = (id, info, tab) => {
      if (id !== tabId) return;
      if (info.status === 'complete' && isReal(tab && tab.url)) finish(true);
    };
    const onRemoved = (id) => {
      if (id === tabId) finish(false);
    };
    try {
      chrome.tabs.onUpdated.addListener(onUpdated);
      chrome.tabs.onRemoved.addListener(onRemoved);
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
  const session = { payloads: [], lastAt: 0, closed: false };
  let tabId = null;
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
      beforeNavigate: (id) => sessions.set(id, session),
    });

    const loaded = await waitForComplete(tabId, LOAD_TIMEOUT_MS);
    const loadedAt = Date.now();

    // Initial wait: waitMs after load, or earlier once payloads arrived and went quiet.
    let r = await waitLoop(waitMs, session, signal, () => {
      if (untilHit()) return true;
      const now = Date.now();
      return session.payloads.length > 0 && now - session.lastAt >= quietMs && now - loadedAt >= Math.min(waitMs, 2000);
    });

    for (let i = 0; i < scrolls && (r === 'time' || r === 'stop') && !untilHit(); i++) {
      await sendScroll(tabId);
      r = await waitLoop(scrollDelayMs, session, signal, untilHit);
    }

    // Final quiet period: wait until no new payload for quietMs (bounded).
    if (r === 'time' || r === 'stop') {
      r = await waitLoop(scrollDelayMs + quietMs, session, signal, () => untilHit() || Date.now() - session.lastAt >= quietMs);
    }

    if (r === 'aborted') error = 'aborted';
    else if (r === 'closed') error = 'tab_closed';
    else if (!loaded && session.payloads.length === 0) error = 'timeout';

    if (!session.closed) tabUrl = await tabUrlOf(tabId);
  } catch (e) {
    error = (e && e.message) || 'capture failed';
  } finally {
    if (tabId != null) await closeScanTab(tabId);
    if (release) release();
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
  const session = { payloads: [], lastAt: 0, closed: false };
  let tabId = null;
  let tabUrl = '';
  let error = '';
  let dom = { text: '', hrefs: [] };
  let release = null;
  try {
    release = await acquireMutex();
    if (signal && signal.aborted) return { text: '', hrefs: [], tabUrl: '', error: 'aborted' };
    tabId = await createTab(url, {
      showScanTabs,
      beforeNavigate: (id) => sessions.set(id, session),
    });
    const loaded = await waitForComplete(tabId, LOAD_TIMEOUT_MS);
    // Wait waitMs, extended while network captures keep arriving (bounded to 2x waitMs).
    let r = await waitLoop(waitMs, session, signal, null);
    if (r === 'time') {
      r = await waitLoop(waitMs, session, signal, () => Date.now() - session.lastAt >= 1500);
    }
    if (r === 'aborted') error = 'aborted';
    else if (r === 'closed') error = 'tab_closed';
    else {
      dom = await sendDomCommand(tabId);
      tabUrl = await tabUrlOf(tabId);
      if (!loaded && !dom.text) error = 'timeout';
      else if (!dom.text && !dom.hrefs.length) error = 'no_dom';
    }
  } catch (e) {
    error = (e && e.message) || 'capture failed';
  } finally {
    if (tabId != null) await closeScanTab(tabId);
    if (release) release();
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
