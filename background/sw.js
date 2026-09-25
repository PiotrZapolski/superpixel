// Service worker entry: side panel behaviour, port protocol, runtime messages from the relay.
import { runScan } from './scan.js';
import { handleRuntimeMessage } from './hidden-tab.js';
import { loadSettings, saveSettings } from './settings.js';
import * as cache from './cache.js';

function enablePanelOnAction() {
  try {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  } catch {
    // ignore
  }
}

chrome.runtime.onInstalled.addListener(enablePanelOnAction);
chrome.runtime.onStartup.addListener(enablePanelOnAction);
enablePanelOnAction();

/** The single running scan: {controller, promise, port}. */
let current = null;
let scanSeq = 0;

async function startScan(port, msg) {
  const seq = ++scanSeq;
  if (current) {
    current.controller.abort();
    try {
      await current.promise;
    } catch {
      // ignore
    }
  }
  if (seq !== scanSeq) return; // a newer scan request superseded this one
  const controller = new AbortController();
  const emit = (m) => {
    try {
      port.postMessage(m);
    } catch {
      // panel closed
    }
  };
  const entry = { controller, port, promise: null };
  entry.promise = runScan({ input: msg.input, force: !!msg.force }, emit, controller.signal)
    .catch((e) => emit({ type: 'error', message: `Scan failed: ${(e && e.message) || e}` }))
    .finally(() => {
      if (current === entry) current = null;
    });
  current = entry;
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'superpixel') return;
  const post = (m) => {
    try {
      port.postMessage(m);
    } catch {
      // disconnected
    }
  };

  port.onMessage.addListener(async (msg) => {
    if (!msg || typeof msg !== 'object') return;
    try {
      switch (msg.type) {
        case 'scan':
          await startScan(port, msg);
          break;
        case 'stop':
          if (current) current.controller.abort();
          break;
        case 'getLast': {
          const { lastScan } = await chrome.storage.local.get('lastScan');
          post({ type: 'last', data: lastScan || null });
          break;
        }
        case 'getSettings':
          post({ type: 'settings', settings: await loadSettings() });
          break;
        case 'saveSettings':
          post({ type: 'settings', settings: await saveSettings(msg.settings || {}) });
          break;
        case 'clearCache':
          await cache.clear();
          post({ type: 'cacheCleared' });
          break;
        default:
          break;
      }
    } catch (e) {
      post({ type: 'error', message: (e && e.message) || String(e) });
    }
  });

  port.onDisconnect.addListener(() => {
    // Panel closed: stop the scan it started (the port is what keeps the SW alive).
    if (current && current.port === port) current.controller.abort();
  });
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  let res;
  try {
    res = handleRuntimeMessage(msg, sender);
  } catch {
    res = undefined;
  }
  if (res === undefined) return false;
  Promise.resolve(res)
    .then((r) => sendResponse(r))
    .catch(() => sendResponse(undefined));
  return true;
});
