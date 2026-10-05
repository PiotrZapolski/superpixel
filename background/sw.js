// Service worker entry: side panel behaviour, port protocol, runtime messages from the relay.
import { runScan } from './scan.js';
import { handleRuntimeMessage } from './hidden-tab.js';
import { loadSettings, saveSettings } from './settings.js';
import * as cache from './cache.js';
import { logInfo, logError, errText, getLog, clearLog } from './log.js';
import { installRemoteLog } from './remote-log.js';

// Opt-in remote debug log: listens to log entries, sends only when settings.remoteLog is true.
const remote = installRemoteLog();

// Unhandled errors in the service worker end up in the debug log (and the console).
self.addEventListener('error', (e) => {
  logError('sw', `Unhandled error: ${errText((e && e.error) || (e && e.message) || e)}`);
});
self.addEventListener('unhandledrejection', (e) => {
  logError('sw', `Unhandled rejection: ${errText(e && e.reason)}`);
});

function enablePanelOnAction() {
  try {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  } catch {
    // ignore
  }
}

chrome.runtime.onInstalled.addListener(enablePanelOnAction);
// A new build (including reloading the unpacked extension) may parse platforms differently, so
// cached adapter results from the old code must not survive it.
chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === 'install' || reason === 'update') {
    cache.clear().then(() => logInfo('sw', `Result cache cleared (${reason})`));
  }
});
chrome.runtime.onStartup.addListener(enablePanelOnAction);
enablePanelOnAction();

/**
 * The single running scan: {controller, promise, port, pastLayerA}. `port` is null once the panel
 * that started it disconnected; a panel that reconnects while the scan runs is attached again.
 */
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
  const entry = { controller, port, promise: null, pastLayerA: false };
  const emit = (m) => {
    if (m && m.type === 'tags') entry.pastLayerA = true;
    if (!entry.port) return;
    try {
      entry.port.postMessage(m);
    } catch {
      entry.port = null; // panel closed; the scan keeps running
    }
  };
  entry.promise = runScan({ input: msg.input, force: !!msg.force }, emit, controller.signal)
    .catch((e) => {
      logError('scan', `Scan crashed: ${errText(e)}`);
      emit({ type: 'error', message: `Scan failed: ${(e && e.message) || e}` });
    })
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
          // The only way to abort a scan that is past layer A.
          if (current) current.controller.abort();
          break;
        case 'getLast': {
          const { lastScan } = await chrome.storage.local.get('lastScan');
          post({ type: 'last', data: lastScan || null });
          if (current && !current.port) {
            // Panel reopened while a detached scan runs: stream the rest of it to this panel.
            current.port = port;
            post({ type: 'phase', text: 'A scan is still running, results will appear when it finishes' });
          }
          break;
        }
        case 'getSettings': {
          const settings = await loadSettings();
          remote.setConsent(settings.remoteLog);
          post({ type: 'settings', settings });
          break;
        }
        case 'saveSettings': {
          const settings = await saveSettings(msg.settings || {});
          remote.setConsent(settings.remoteLog);
          post({ type: 'settings', settings });
          break;
        }
        case 'clearCache':
          await cache.clear();
          post({ type: 'cacheCleared' });
          break;
        case 'getLog':
          post({ type: 'log', entries: await getLog() });
          break;
        case 'clearLog':
          await clearLog();
          post({ type: 'log', entries: [] });
          break;
        default:
          break;
      }
    } catch (e) {
      logError('sw', `Port message ${msg.type} failed: ${errText(e)}`);
      post({ type: 'error', message: (e && e.message) || String(e) });
    }
  });

  port.onDisconnect.addListener(() => {
    if (!current || current.port !== port) return;
    if (current.pastLayerA) {
      // Panel closed after layer A: let the scan finish; results go to the cache and lastScan.
      current.port = null;
      logInfo('sw', 'Side panel closed, scan continues in the background');
    } else {
      // Nothing worth keeping yet: stop the scan the panel started.
      logInfo('sw', 'Side panel closed during layer A, scan stopped');
      current.controller.abort();
    }
  });
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  let res;
  try {
    res = handleRuntimeMessage(msg, sender);
  } catch (e) {
    logError('sw', `Runtime message failed: ${errText(e)}`);
    res = undefined;
  }
  if (res === undefined) return false;
  Promise.resolve(res)
    .then((r) => sendResponse(r))
    .catch(() => sendResponse(undefined));
  return true;
});
