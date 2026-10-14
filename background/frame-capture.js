// Tab-free TikTok capture (issue #17): an offscreen document (offscreen/offscreen.html) hosts an
// iframe that loads the library.tiktok.com page. Used when a capture tab was closed right after
// loading by something outside Superpixel (another extension): a frame in our offscreen document
// is not a tab, so no tab-managing extension can see or close it.
//
// - content/hook-main.js + content/relay.js run in the frame (all_frames on library.tiktok.com).
//   The frame's window.name carries a per-capture token; the relay sends it with every message and
//   the service worker accepts a tab-less library.tiktok.com sender only with the token of the
//   capture that is running, so a TikTok iframe on some website never counts as a capture.
// - X-Frame-Options / CSP (frame-ancestors) are removed by a declarativeNetRequest session rule
//   that matches only sub_frame responses of library.tiktok.com outside any tab (TAB_ID_NONE),
//   so normal browsing is never affected.
// - The offscreen document and the relay in the frame talk to the service worker over ports
//   (chrome.tabs.sendMessage cannot reach a frame that has no tab).
import { logInfo, logWarn, safeUrl, errText } from './log.js';
import { acquireMutex, waitLoop, delay, MAX_PAYLOADS_PER_TAB, LOAD_TIMEOUT_MS } from './hidden-tab.js';
import { memGet, memSet, memRemove } from './memory.js';

export const FRAME_HOST = 'library.tiktok.com';
export const FRAME_TOKEN_PREFIX = 'superpixel-frame-';
export const OFFSCREEN_PORT = 'superpixel-offscreen';
export const FRAME_PORT = 'superpixel-frame';
const OFFSCREEN_PATH = 'offscreen/offscreen.html';
const DNR_RULE_ID = 1701;
const OFFSCREEN_WAIT_MS = 5000;
const COMMAND_TIMEOUT_MS = 5000;

/**
 * The running frame capture (one at a time, the capture mutex is shared with the tab path):
 * {token, payloads:[], lastAt:number, closed:boolean, port:chrome.runtime.Port|null, documentId:string}
 */
let session = null;
let offscreenPort = null;
let offscreenWaiters = [];
let offscreenPromise = null;
let reqSeq = 0;
/** reqId -> resolve, for answers from the offscreen document and the relay in the frame. */
const pending = new Map();

function hasChrome() {
  return typeof chrome !== 'undefined' && !!chrome.runtime;
}

function hostOfUrl(u) {
  try {
    return new URL(String(u)).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function newToken() {
  let rnd = '';
  try {
    rnd = crypto.randomUUID().replace(/-/g, '');
  } catch {
    rnd = `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  }
  return FRAME_TOKEN_PREFIX + rnd;
}

/** Test hook: set or clear the running session. */
export function _setSession(s) {
  session = s;
}

/**
 * True when a runtime message comes from the frame of the running capture: no tab (a frame in
 * our offscreen document), library.tiktok.com, and the token of this capture.
 * @param {any} msg
 * @param {chrome.runtime.MessageSender} sender
 */
export function isCaptureFrame(msg, sender) {
  if (!session || session.closed || !msg || !sender) return false;
  if (sender.tab) return false;
  if (hasChrome() && chrome.runtime.id && sender.id && sender.id !== chrome.runtime.id) return false;
  if (hostOfUrl(sender.url) !== FRAME_HOST) return false;
  return typeof msg.frameToken === 'string' && msg.frameToken === session.token;
}

/**
 * Runtime messages from a relay without a tab. Returns a response, or undefined when the message
 * is not handled here (sw.js then asks hidden-tab.js).
 * @param {any} msg
 * @param {chrome.runtime.MessageSender} sender
 */
export function handleFrameMessage(msg, sender) {
  if (!msg || typeof msg !== 'object' || !sender || sender.tab) return undefined;
  if (msg.type === 'isCaptureTab') {
    const ok = isCaptureFrame(msg, sender);
    if (ok && sender.documentId) session.documentId = sender.documentId;
    return { isCaptureTab: ok };
  }
  if (msg.type === 'capture') {
    if (!isCaptureFrame(msg, sender)) return { ok: false };
    const s = session;
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

function settle(m) {
  if (!m || typeof m !== 'object' || typeof m.reqId !== 'number') return;
  const resolve = pending.get(m.reqId);
  if (!resolve) return;
  pending.delete(m.reqId);
  resolve(m.res);
}

/** Post a command on a port and wait (bounded) for {reqId, res}. Resolves null on timeout. */
function request(port, msg, timeoutMs) {
  return new Promise((resolve) => {
    if (!port) {
      resolve(null);
      return;
    }
    const reqId = ++reqSeq;
    const timer = setTimeout(() => {
      pending.delete(reqId);
      resolve(null);
    }, timeoutMs);
    pending.set(reqId, (res) => {
      clearTimeout(timer);
      resolve(res === undefined ? null : res);
    });
    try {
      port.postMessage({ ...msg, reqId });
    } catch {
      clearTimeout(timer);
      pending.delete(reqId);
      resolve(null);
    }
  });
}

/**
 * Ports from offscreen/offscreen.js and from the relay in the capture frame. sw.js forwards every
 * onConnect here; returns true when the port was taken.
 * @param {chrome.runtime.Port} port
 */
export function handleFramePort(port) {
  if (!port) return false;
  const sender = port.sender || {};
  if (port.name === OFFSCREEN_PORT) {
    if (sender.tab || !String(sender.url || '').includes(OFFSCREEN_PATH)) return false;
    offscreenPort = port;
    port.onMessage.addListener(settle);
    port.onDisconnect.addListener(() => {
      if (offscreenPort === port) offscreenPort = null;
      if (session) session.closed = true;
    });
    const waiters = offscreenWaiters;
    offscreenWaiters = [];
    for (const w of waiters) w(port);
    return true;
  }
  if (port.name === FRAME_PORT) {
    if (sender.tab || hostOfUrl(sender.url) !== FRAME_HOST) return false;
    port.onMessage.addListener((m) => {
      if (!m || typeof m !== 'object') return;
      if (m.type === 'hello') {
        // The relay of the capture frame (a frame reload connects again and replaces the port).
        if (session && !session.closed && m.frameToken === session.token) session.port = port;
        return;
      }
      settle(m);
    });
    port.onDisconnect.addListener(() => {
      if (session && session.port === port) session.port = null;
    });
    return true;
  }
  return false;
}

async function offscreenExists() {
  try {
    if (chrome.runtime.getContexts) {
      const ctxs = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
      return ctxs.length > 0;
    }
  } catch {
    // ignore
  }
  return false;
}

/** Create the offscreen document if needed and wait for its port. Resolves null on failure. */
async function ensureOffscreen() {
  if (offscreenPort) return offscreenPort;
  if (offscreenPromise) return offscreenPromise;
  offscreenPromise = (async () => {
    const connected = new Promise((resolve) => {
      offscreenWaiters.push(resolve);
      setTimeout(() => resolve(null), OFFSCREEN_WAIT_MS);
    });
    if (!(await offscreenExists())) {
      await chrome.offscreen.createDocument({
        url: OFFSCREEN_PATH,
        reasons: ['IFRAME_SCRIPTING'],
        justification: 'Load the TikTok Ad Library page in a frame to read its ad search results.',
      });
    }
    return offscreenPort || (await connected);
  })();
  try {
    return await offscreenPromise;
  } finally {
    offscreenPromise = null;
  }
}

/** Session rule: strip framing headers from library.tiktok.com frames outside any tab. */
async function addFrameRule() {
  const tabNone = chrome.tabs && typeof chrome.tabs.TAB_ID_NONE === 'number' ? chrome.tabs.TAB_ID_NONE : -1;
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [DNR_RULE_ID],
    addRules: [{
      id: DNR_RULE_ID,
      priority: 1,
      action: {
        type: 'modifyHeaders',
        responseHeaders: [
          { header: 'x-frame-options', operation: 'remove' },
          { header: 'content-security-policy', operation: 'remove' },
        ],
      },
      condition: {
        requestDomains: [FRAME_HOST],
        resourceTypes: ['sub_frame'],
        tabIds: [tabNone],
      },
    }],
  });
}

async function removeFrameRule() {
  try {
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [DNR_RULE_ID] });
  } catch {
    // ignore
  }
}

/** Ask the relay in the frame to run a command ({cmd:'scroll'|'dom'}). Resolves null when it cannot. */
async function frameCommand(s, cmd, timeoutMs = COMMAND_TIMEOUT_MS) {
  // The relay connects once the SW confirmed the frame; give it a moment after load.
  const end = Date.now() + 2000;
  while (!s.port && !s.closed && Date.now() < end) await delay(100);
  return request(s.port, { cmd }, timeoutMs);
}

/**
 * Load url in the offscreen frame and run fn(session) while it is open. Shared by the capture and
 * the DOM variant: mutex, offscreen document, header rule, open, close, log line.
 */
async function withFrame(url, kind, signal, fn) {
  const s = { token: newToken(), payloads: [], lastAt: 0, closed: false, port: null, documentId: '' };
  let release = null;
  let opened = false;
  let out = { error: '' };
  try {
    release = await acquireMutex();
    if (signal && signal.aborted) return { error: 'aborted', s, opened };
    await addFrameRule();
    const port = await ensureOffscreen();
    if (!port) throw new Error('offscreen document did not start');
    session = s;
    opened = true;
    logInfo('capture', `Open tiktok frame${kind ? ` ${kind}` : ''} ${safeUrl(url)}`);
    const res = await request(port, { cmd: 'open', url, name: s.token }, LOAD_TIMEOUT_MS);
    const loaded = !!(res && res.loaded);
    if (!loaded) logWarn('capture', `Frame load timeout ${safeUrl(url)}`);
    out = await fn(s, loaded);
  } catch (e) {
    out = { error: (e && e.message) || 'frame capture failed' };
    logWarn('capture', `Frame capture failed ${safeUrl(url)}: ${errText(e)}`);
  } finally {
    if (opened) {
      if (offscreenPort) await request(offscreenPort, { cmd: 'close' }, 2000);
      if (session === s) session = null;
      s.closed = true;
    }
    if (release) release();
  }
  return { ...out, s, opened };
}

/**
 * Same contract as hidden-tab.js openCaptureTab, through the offscreen frame. Always resolves.
 * @param {string} url
 * @param {{waitMs?:number, scrolls?:number, scrollDelayMs?:number, quietMs?:number,
 *   signal?:AbortSignal, until?:(payloads:any[])=>boolean}} [opts]
 * @returns {Promise<{payloads:any[], tabUrl:string, error:string}>}
 */
export async function openCaptureFrame(url, opts = {}) {
  const { waitMs = 6000, scrolls = 0, scrollDelayMs = 2500, quietMs = 2500, signal, until } = opts;
  const r = await withFrame(url, '', signal, async (s, loaded) => {
    const untilHit = () => {
      if (typeof until !== 'function') return false;
      try {
        return !!until(s.payloads);
      } catch {
        return false;
      }
    };
    const loadedAt = Date.now();
    let w = await waitLoop(waitMs, s, signal, () => {
      if (untilHit()) return true;
      const now = Date.now();
      return s.payloads.length > 0 && now - s.lastAt >= quietMs && now - loadedAt >= Math.min(waitMs, 2000);
    });
    for (let i = 0; i < scrolls && (w === 'time' || w === 'stop') && !untilHit(); i++) {
      await frameCommand(s, 'scroll', 3000);
      w = await waitLoop(scrollDelayMs, s, signal, untilHit);
    }
    if (w === 'time' || w === 'stop') {
      w = await waitLoop(scrollDelayMs + quietMs, s, signal, () => untilHit() || Date.now() - s.lastAt >= quietMs);
    }
    let error = '';
    if (w === 'aborted') error = 'aborted';
    else if (w === 'closed') error = 'frame_closed';
    else if (!loaded && s.payloads.length === 0) error = 'timeout';
    return { error };
  });
  const payloads = r.s.payloads;
  if (r.opened) {
    const msg = `Close frame ${safeUrl(url)}: ${payloads.length} payloads${r.error ? `, ${r.error}` : ''}`;
    if (r.error && r.error !== 'aborted') logWarn('capture', msg);
    else logInfo('capture', msg);
  }
  return { payloads, tabUrl: r.opened ? url : '', error: r.error || '' };
}

/**
 * Same contract as hidden-tab.js openCaptureTabDom, through the offscreen frame. Always resolves.
 * @param {string} url
 * @param {{waitMs?:number, signal?:AbortSignal}} [opts]
 * @returns {Promise<{text:string, hrefs:string[], tabUrl:string, error:string}>}
 */
export async function openCaptureFrameDom(url, opts = {}) {
  const { waitMs = 6000, signal } = opts;
  const r = await withFrame(url, 'DOM', signal, async (s, loaded) => {
    let w = await waitLoop(waitMs, s, signal, null);
    if (w === 'time') w = await waitLoop(waitMs, s, signal, () => Date.now() - s.lastAt >= 1500);
    if (w === 'aborted') return { error: 'aborted' };
    if (w === 'closed') return { error: 'frame_closed' };
    const res = await frameCommand(s, 'dom');
    const dom = {
      text: res && typeof res.text === 'string' ? res.text : '',
      hrefs: res && Array.isArray(res.hrefs) ? res.hrefs : [],
    };
    let error = '';
    if (!loaded && !dom.text) error = 'timeout';
    else if (!dom.text && !dom.hrefs.length) error = 'no_dom';
    return { error, dom };
  });
  const dom = r.dom || { text: '', hrefs: [] };
  if (r.opened) {
    const msg = `Close DOM frame ${safeUrl(url)}: ${dom.hrefs.length} links, ${dom.text.length} chars${r.error ? `, ${r.error}` : ''}`;
    if (r.error && r.error !== 'aborted') logWarn('capture', msg);
    else logInfo('capture', msg);
  }
  return { text: dom.text, hrefs: dom.hrefs, tabUrl: r.opened ? url : '', error: r.error || '' };
}

/** End of scan: close the offscreen document and drop the header rule. Never throws. */
export async function closeCaptureFrames() {
  if (!hasChrome()) return;
  await removeFrameRule();
  if (!offscreenPort && !(await offscreenExists())) return;
  try {
    await chrome.offscreen.closeDocument();
  } catch {
    // already closed
  }
  offscreenPort = null;
}

/** True for a url the frame path can load (the TikTok Ad Library only). */
export function frameCapable(url) {
  return hostOfUrl(url) === FRAME_HOST;
}

/** chrome.storage.local key: until when (ms) TikTok goes straight to the frame (capture tabs get closed). */
export const FRAME_MEMORY_KEY = 'tiktokFrameUntil';
export const FRAME_MEMORY_MS = 7 * 24 * 60 * 60 * 1000;

/** A capture (payloads) or DOM capture (text) that ended without error and brought something back. */
export function frameCaptureWorked(cap) {
  if (!cap || cap.error) return false;
  return (Array.isArray(cap.payloads) && cap.payloads.length > 0) || (typeof cap.text === 'string' && cap.text.length > 0);
}

/**
 * Per-run router between the capture tab and the offscreen frame (issue #17). Something outside
 * Superpixel (another extension) may close every TikTok tab right after it loads:
 * - no memory: try the tab; after the first tab_closed the rest of the run uses the frame, and
 *   once a frame capture works that is remembered for FRAME_MEMORY_MS;
 * - remembered: go straight to the frame (one info line per run); a frame capture that fails
 *   (other than a user abort) forgets it and retries that request through the tab, so a removed
 *   blocker or a broken frame heals itself.
 * @param {{memory?:{get:Function,set:Function,remove:Function}, signal?:AbortSignal,
 *   now?:()=>number, log?:(level:string, msg:string)=>void}} opts
 * @returns {(url:string, tabCapture:()=>Promise<any>, frameCapture:()=>Promise<any>)=>Promise<any>}
 */
export function createFrameRouter({ memory, signal, now = Date.now, log = () => {} } = {}) {
  let useFrame = false;
  let stored = false;
  let announced = false;
  /** null until read once per run; then the remembered deadline (ms) or 0. */
  let rememberedUntil = null;

  const remembered = async () => {
    if (rememberedUntil === null) {
      const v = Number(await memGet(memory, FRAME_MEMORY_KEY));
      rememberedUntil = Number.isFinite(v) && v > now() ? v : 0;
    }
    return rememberedUntil;
  };
  const remember = async (cap) => {
    if (stored || !frameCaptureWorked(cap)) return;
    stored = true;
    await memSet(memory, FRAME_MEMORY_KEY, now() + FRAME_MEMORY_MS);
  };
  const viaTab = async (tabCapture, frameCapture) => {
    const cap = await tabCapture();
    if (!cap || cap.error !== 'tab_closed' || (signal && signal.aborted)) return cap;
    useFrame = true;
    log('warn', 'Capture tab closed right after loading, switching to the offscreen frame for this run');
    const fcap = await frameCapture();
    await remember(fcap);
    return fcap;
  };

  return async (url, tabCapture, frameCapture) => {
    if (!frameCapable(url) || (signal && signal.aborted)) return tabCapture();
    if (useFrame) {
      const cap = await frameCapture();
      await remember(cap);
      return cap;
    }
    const until = await remembered();
    if (!until) return viaTab(tabCapture, frameCapture);
    if (!announced) {
      announced = true;
      log('info', `Using the offscreen frame: capture tabs were closed by something in this browser (remembered until ${new Date(until).toISOString()})`);
    }
    const cap = await frameCapture();
    if (frameCaptureWorked(cap) || (cap && cap.error === 'aborted') || (signal && signal.aborted)) return cap;
    rememberedUntil = 0;
    await memRemove(memory, FRAME_MEMORY_KEY);
    log('info', `Offscreen frame capture failed (${(cap && cap.error) || 'nothing captured'}), forgetting it and trying a capture tab`);
    return viaTab(tabCapture, frameCapture);
  };
}
