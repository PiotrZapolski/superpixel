// Superpixel side panel UI. Talks to the service worker over a long-lived port
// named "superpixel". No frameworks, no innerHTML with remote data.

import {
  STATUS_LABELS,
  MATCH_HINTS,
  statusChipText,
  matchLabel,
  formatLabel,
  placementsText,
  headerDeepLinks,
} from './view.js';
import { platformIcon, tagIcon } from './platform-icons.js';

const PLATFORM_ORDER = ['google', 'meta', 'tiktok', 'linkedin', 'bing', 'snap'];

const REGION_CODES = [
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT',
  'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE', 'IS', 'LI', 'NO',
  'GB', 'CH',
];

const CATEGORY_ORDER = ['ads', 'analytics', 'tag-manager', 'crm'];
const CATEGORY_LABELS = {
  ads: 'Ads',
  analytics: 'Analytics',
  'tag-manager': 'Tag managers',
  crm: 'CRM / other',
};

// ---- state ----

let port = null;
let scanning = false;
let currentScan = null; // scan being built up from live events
let lastData = null; // last completed / stored scan, used for export and rendering
let lastScanInput = null; // {mode:'domain', domain} | {mode:'tab', tabId}
let onlyConfirmed = false;
let manualLibraries = []; // [{id,label,coverage,handle,url,hint}]
const platformEntries = new Map(); // platform id -> {slot, kind, refs, open, userToggled, result}
let remoteLogValue = null; // settings.remoteLog: null = never asked, true = granted, false = declined

// ---- DOM refs ----

const domainInput = document.getElementById('domain-input');
const scanBtn = document.getElementById('scan-btn');
const currentTabBtn = document.getElementById('current-tab-btn');
const stopBtn = document.getElementById('stop-btn');
const settingsBtn = document.getElementById('settings-btn');
const phaseTextEl = document.getElementById('phase-text');
const errorTextEl = document.getElementById('error-text');

const summaryStripEl = document.getElementById('summary-strip');
const summaryDomainEl = document.getElementById('summary-domain');
const summaryStatsEl = document.getElementById('summary-stats');
const summaryTimeEl = document.getElementById('summary-time');
const cachedChipEl = document.getElementById('cached-chip');
const rescanBtn = document.getElementById('rescan-btn');

const settingsBackdrop = document.getElementById('settings-backdrop');
const settingsDrawerEl = document.getElementById('settings-drawer');
const settingsCloseBtn = document.getElementById('settings-close-btn');
const settingsSaveBtn = document.getElementById('settings-save-btn');
const clearCacheBtn = document.getElementById('clear-cache-btn');
const settingsStatusEl = document.getElementById('settings-status');
const tiktokRegionsEl = document.getElementById('tiktok-regions');
const copyLogBtn = document.getElementById('copy-log-btn');
const clearLogBtn = document.getElementById('clear-log-btn');
const showLogToggle = document.getElementById('show-log-toggle');
const debugLogViewEl = document.getElementById('debug-log-view');
const debugLogStatusEl = document.getElementById('debug-log-status');
const exportJsonBtn = document.getElementById('export-json-btn');
const consentBannerEl = document.getElementById('consent-banner');
const consentYesBtn = document.getElementById('consent-yes-btn');
const consentNoBtn = document.getElementById('consent-no-btn');
const remoteLogInput = document.getElementById('setting-remoteLog');

const tagsSectionEl = document.getElementById('tags-section');
const tagsSummaryTextEl = document.getElementById('tags-summary-text');
const tagsGroupsEl = document.getElementById('tags-groups');
const brandSignalsEl = document.getElementById('brand-signals');

const onlyConfirmedToggle = document.getElementById('only-confirmed-toggle');
const platformCardsEl = document.getElementById('platform-cards');
const scanLoaderEl = document.getElementById('scan-loader');
const scanLoaderTextEl = scanLoaderEl.querySelector('.scan-loader-text');
const manualRowsEl = document.getElementById('manual-rows');

// ---- small DOM helpers ----

function el(tag, opts = {}, children = []) {
  const node = document.createElement(tag);
  if (opts.className) node.className = opts.className;
  if (opts.text !== undefined) node.textContent = opts.text;
  if (opts.attrs) {
    for (const [k, v] of Object.entries(opts.attrs)) {
      if (v !== undefined && v !== null) node.setAttribute(k, v);
    }
  }
  for (const child of children) {
    if (child) node.appendChild(child);
  }
  return node;
}

function isSafeHttpUrl(url) {
  if (!url || typeof url !== 'string') return false;
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function safeLink(url, text, opts = {}) {
  if (isSafeHttpUrl(url)) {
    return el('a', {
      text,
      className: opts.className,
      attrs: { href: url, target: '_blank', rel: 'noopener noreferrer', title: opts.title },
    });
  }
  return el('span', { text, className: opts.className });
}

function copyButton(value) {
  const btn = el('button', { text: 'Copy', className: 'copy-btn', attrs: { type: 'button' } });
  btn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(value);
      btn.textContent = 'Copied';
    } catch {
      btn.textContent = 'Error';
    }
    setTimeout(() => {
      btn.textContent = 'Copy';
    }, 1200);
  });
  return btn;
}

// ---- port handling ----

function ensurePort() {
  if (port) return port;
  port = chrome.runtime.connect({ name: 'superpixel' });
  port.onMessage.addListener(handleMessage);
  port.onDisconnect.addListener(() => {
    port = null;
  });
  return port;
}

function send(msg) {
  try {
    ensurePort().postMessage(msg);
  } catch {
    port = null;
    try {
      ensurePort().postMessage(msg);
    } catch {
      showError('Lost connection to the extension background. Try again.');
    }
  }
}

function handleMessage(msg) {
  if (!msg || typeof msg !== 'object') return;
  switch (msg.type) {
    case 'phase':
      onPhase(msg.text);
      break;
    case 'tags':
      onTags(msg.tags, msg.seeds);
      break;
    case 'seeds':
      onSeeds(msg.seeds);
      break;
    case 'manual':
      onManual(msg.libraries);
      break;
    case 'log':
      onLog(msg.entries);
      break;
    case 'platformStart':
      onPlatformStart(msg.id, msg.label, msg.coverage);
      break;
    case 'progress':
      onProgress(msg.id, msg.text);
      break;
    case 'platform':
      hideLoader();
      onPlatformResult(msg.result);
      break;
    case 'done':
      onDone(msg.summary);
      break;
    case 'error':
      onError(msg.message);
      break;
    case 'last':
      onLast(msg.data);
      break;
    case 'settings':
      onSettings(msg.settings);
      break;
    default:
      break;
  }
}

// ---- scan lifecycle ----

function updateScanUi() {
  scanBtn.hidden = scanning;
  stopBtn.hidden = !scanning;
  currentTabBtn.disabled = scanning;
  domainInput.disabled = scanning;
  rescanBtn.disabled = scanning;
}

function showLoader(text) {
  scanLoaderTextEl.textContent = text;
  scanLoaderEl.hidden = false;
}

function hideLoader() {
  scanLoaderEl.hidden = true;
}

function showError(text) {
  errorTextEl.textContent = text;
  errorTextEl.hidden = false;
}

function hideError() {
  errorTextEl.hidden = true;
  errorTextEl.textContent = '';
}

function beginScan(input, force) {
  hideError();
  lastScanInput = input;
  currentScan = {
    domain: input.domain || domainInput.value.trim(),
    at: new Date().toISOString(),
    tags: [],
    seeds: null,
    results: [],
    manual: [],
  };
  platformEntries.clear();
  platformCardsEl.replaceChildren();
  tagsGroupsEl.replaceChildren();
  brandSignalsEl.replaceChildren();
  manualLibraries = [];
  manualRowsEl.replaceChildren();
  updateTagsSummary([]);
  summaryStripEl.hidden = true;
  scanning = true;
  updateScanUi();
  showLoader(input && input.mode === 'tab' ? 'Scanning the current tab...' : 'Scanning ' + currentScan.domain + '...');
  send({ type: 'scan', input, force: !!force });
}

function onPhase(text) {
  scanning = true;
  updateScanUi();
  phaseTextEl.textContent = text || '';
  if (!scanLoaderEl.hidden && text) scanLoaderTextEl.textContent = text;
}

function onTags(tags, seeds) {
  if (currentScan) {
    currentScan.tags = tags || [];
    currentScan.seeds = seeds || null;
  }
  renderTags(tags, seeds);
}

// Seeds updated after Google + Meta (advertiserNames for the name-based libraries).
function onSeeds(seeds) {
  if (!seeds) return;
  if (currentScan) currentScan.seeds = seeds;
  renderBrandSignals(seeds);
}

function onManual(libraries) {
  manualLibraries = Array.isArray(libraries) ? libraries : [];
  if (currentScan) currentScan.manual = manualLibraries;
  renderManualRows();
}

function onPlatformStart(id, label, coverage) {
  hideLoader();
  const entry = getOrCreateEntry(id);
  if (entry.kind !== 'card') buildCardDom(entry, id);
  const { refs } = entry;
  refs.labelEl.textContent = label || id;
  refs.coverageEl.textContent = coverage || '';
  setStatusChip(refs.statusEl, 'running', 'Running');
  refs.progressEl.textContent = '';
  refs.messageEl.textContent = '';
  refs.needsUserEl.replaceChildren();
  refs.deepLinksEl.replaceChildren();
  refs.summaryLineEl.textContent = '';
  refs.bodyEl.replaceChildren();
  entry.result = null;
}

function onProgress(id, text) {
  const entry = getOrCreateEntry(id);
  if (entry.kind !== 'card') buildCardDom(entry, id);
  entry.refs.progressEl.textContent = text || '';
}

function onPlatformResult(result) {
  if (!result || !result.platform) return;
  if (!currentScan) {
    // Results of a scan this panel did not start (reattached background scan).
    currentScan = { domain: domainInput.value.trim(), at: new Date().toISOString(), tags: [], seeds: null, results: [], manual: [], partial: true };
  }
  const idx = currentScan.results.findIndex((r) => r.platform === result.platform);
  if (idx >= 0) currentScan.results[idx] = result;
  else currentScan.results.push(result);
  renderPlatformResult(result);
  // Keep the strip in step with the cards while the scan runs (it may still show a stored scan).
  updateSummaryStrip(currentScan, false, true);
}

function formatSummary(summary) {
  if (!summary || typeof summary !== 'object') return summary ? String(summary) : 'Done.';
  const secs = Math.round((Number(summary.ms) || 0) / 1000);
  return (summary.stopped ? 'Stopped. ' : 'Done. ') +
    (summary.totalAds || 0) + ' ads, ' + (summary.confirmedAds || 0) + ' confirmed, ' + secs + 's.';
}

function onDone(summary) {
  hideLoader();
  scanning = false;
  updateScanUi();
  phaseTextEl.textContent = formatSummary(summary);
  if (currentScan && currentScan.partial) {
    // Only part of this scan was streamed here: load the complete stored result.
    currentScan = null;
    send({ type: 'getLast' });
    return;
  }
  if (currentScan) {
    lastData = currentScan;
    currentScan = null;
    afterDataReady(false);
  }
}

function onError(message) {
  hideLoader();
  scanning = false;
  updateScanUi();
  if (currentScan && !summaryStripEl.hidden) updateSummaryStrip(currentScan, false);
  showError(message || 'An error occurred.');
}

function onLast(data) {
  hideLoader();
  if (!data) return;
  lastData = data;
  currentScan = null;
  lastScanInput = { mode: 'domain', domain: data.domain };
  domainInput.value = data.domain || '';
  platformEntries.clear();
  platformCardsEl.replaceChildren();
  renderTags(data.tags, data.seeds);
  manualLibraries = Array.isArray(data.manual) ? data.manual : [];
  renderManualRows();
  for (const result of data.results || []) {
    renderPlatformResult(result);
  }
  afterDataReady(true);
}

function afterDataReady(cached) {
  updateSummaryStrip(lastData, cached);
  exportJsonBtn.disabled = false;
}

function updateSummaryStrip(data, cached, live) {
  if (!data) {
    summaryStripEl.hidden = true;
    return;
  }
  const results = Array.isArray(data.results) ? data.results : [];
  let confirmedTotal = 0;
  let platformsWithAds = 0;
  for (const r of results) {
    const c = (Array.isArray(r.ads) ? r.ads : []).filter((a) => a && a.match === 'confirmed').length;
    confirmedTotal += c;
    if (c > 0) platformsWithAds++;
  }
  summaryDomainEl.textContent = data.domain || '';
  summaryStatsEl.textContent = confirmedTotal + (confirmedTotal === 1 ? ' confirmed ad' : ' confirmed ads') +
    ' across ' + platformsWithAds + (platformsWithAds === 1 ? ' platform' : ' platforms');
  let when = '';
  try {
    when = data.at ? new Date(data.at).toLocaleString() : '';
  } catch {
    when = data.at || '';
  }
  summaryTimeEl.textContent = live ? 'Scan in progress' : when ? 'Scanned ' + when : '';
  cachedChipEl.hidden = !cached;
  rescanBtn.hidden = !!live;
  summaryStripEl.hidden = false;
}

function onSettings(settings) {
  populateSettingsForm(settings || {});
  // Remote log consent is asked once: the banner shows until the user answers.
  consentBannerEl.hidden = remoteLogValue !== null;
}

function answerConsent(granted) {
  remoteLogValue = granted;
  remoteLogInput.checked = granted;
  consentBannerEl.hidden = true;
  send({ type: 'saveSettings', settings: { remoteLog: granted } });
}

// ---- tags / brand signals ----

function updateTagsSummary(tags) {
  const n = Array.isArray(tags) ? tags.length : 0;
  tagsSummaryTextEl.textContent = 'Tracking on the site (' + n + ')';
}

function renderTags(tags, seeds) {
  updateTagsSummary(tags);
  tagsGroupsEl.replaceChildren();
  if (!tags || tags.length === 0) {
    tagsGroupsEl.appendChild(el('p', { className: 'empty-note', text: 'No tags detected yet.' }));
  } else {
    const byCategory = new Map();
    for (const hit of tags) {
      const list = byCategory.get(hit.category) || [];
      list.push(hit);
      byCategory.set(hit.category, list);
    }
    for (const cat of CATEGORY_ORDER) {
      const items = byCategory.get(cat);
      if (!items || items.length === 0) continue;
      const group = el('div', { className: 'tag-group' });
      group.appendChild(el('h3', { text: CATEGORY_LABELS[cat] || cat }));
      const list = el('div', { className: 'tag-list' });
      for (const hit of items) list.appendChild(renderTagRow(hit));
      group.appendChild(list);
      tagsGroupsEl.appendChild(group);
    }
  }
  renderBrandSignals(seeds);
}

function renderTagRow(hit) {
  const row = el('div', { className: 'tag-row' });
  const head = el('div', { className: 'tag-row-head' });
  const logo = tagIcon(hit.platform);
  if (logo) head.appendChild(logo);
  head.appendChild(el('span', { text: hit.platform }));
  if (hit.source === 'container') {
    head.appendChild(el('span', { className: 'tag-source', text: 'from GTM container' }));
  }
  if (hit.evidence && hit.evidence.length) {
    head.appendChild(el('span', {
      className: 'tag-evidence',
      text: 'i',
      attrs: { title: hit.evidence.join(' | ') },
    }));
  }
  row.appendChild(head);

  const ids = el('div', { className: 'tag-ids' });
  for (const id of hit.ids || []) {
    const idWrap = el('span', { className: 'tag-id' });
    idWrap.appendChild(el('code', { text: id }));
    idWrap.appendChild(copyButton(id));
    ids.appendChild(idWrap);
  }
  row.appendChild(ids);
  return row;
}

function renderBrandSignals(seeds) {
  brandSignalsEl.replaceChildren();
  if (!seeds) return;
  const wrap = el('div', { className: 'brand-block' });
  wrap.appendChild(el('h3', { text: 'Brand signals' }));
  if (seeds.brand) {
    wrap.appendChild(el('p', { className: 'brand-main', text: 'Brand: ' + seeds.brand }));
  }
  if (seeds.brandCandidates && seeds.brandCandidates.length) {
    const chips = el('div', { className: 'chip-row' });
    for (const c of seeds.brandCandidates) chips.appendChild(el('span', { className: 'chip', text: c }));
    wrap.appendChild(chips);
  }
  if (seeds.advertiserNames && seeds.advertiserNames.length) {
    wrap.appendChild(el('p', { className: 'brand-main', text: 'Advertiser names (from Google / Meta):' }));
    const chips = el('div', { className: 'chip-row' });
    for (const n of seeds.advertiserNames) chips.appendChild(el('span', { className: 'chip', text: n }));
    wrap.appendChild(chips);
  }
  if (seeds.social) {
    const linkRow = el('div', { className: 'chip-row' });
    for (const urls of Object.values(seeds.social)) {
      for (const u of urls || []) {
        linkRow.appendChild(safeLink(u, u, { className: 'chip chip-link' }));
      }
    }
    if (linkRow.childNodes.length) wrap.appendChild(linkRow);
  }
  brandSignalsEl.appendChild(wrap);
}

// ---- platform entries (card or one-line empty row) ----

function getOrCreateEntry(id) {
  let entry = platformEntries.get(id);
  if (entry) return entry;

  const slot = el('div', { attrs: { 'data-platform': id } });
  entry = { slot, kind: null, refs: null, open: false, userToggled: false, result: null };
  platformEntries.set(id, entry);

  const idx = PLATFORM_ORDER.indexOf(id);
  let inserted = false;
  for (const child of platformCardsEl.children) {
    const childIdx = PLATFORM_ORDER.indexOf(child.getAttribute('data-platform'));
    if (idx >= 0 && (childIdx < 0 || childIdx > idx)) {
      platformCardsEl.insertBefore(slot, child);
      inserted = true;
      break;
    }
  }
  if (!inserted) platformCardsEl.appendChild(slot);

  return entry;
}

function setStatusChip(node, status, text) {
  node.className = 'status-chip status-' + status;
  node.textContent = text !== undefined ? text : (STATUS_LABELS[status] || status);
}

function setEntryOpen(entry, open) {
  entry.open = open;
  if (!entry.refs) return;
  entry.refs.root.classList.toggle('open', open);
  entry.refs.headerEl.setAttribute('aria-expanded', open ? 'true' : 'false');
}

function buildCardDom(entry, id) {
  const root = el('div', { className: 'platform-card', attrs: { 'data-platform': id } });

  const headerEl = el('div', {
    className: 'platform-card-header',
    attrs: { role: 'button', tabindex: '0', 'aria-expanded': 'false' },
  });
  const titleRow = el('div', { className: 'platform-card-title-row' });
  const chevronEl = el('span', { className: 'chevron', text: '›', attrs: { 'aria-hidden': 'true' } });
  const labelEl = el('span', { className: 'platform-label', text: id });
  const statusEl = el('span', { className: 'status-chip status-running', text: 'Waiting' });
  titleRow.appendChild(chevronEl);
  const iconEl = platformIcon(id);
  if (iconEl) titleRow.appendChild(iconEl);
  titleRow.appendChild(labelEl);
  titleRow.appendChild(statusEl);
  headerEl.appendChild(titleRow);

  const metaRow = el('div', { className: 'platform-card-meta-row' });
  const coverageEl = el('span', { className: 'platform-coverage', text: '' });
  const deepLinksEl = el('div', { className: 'platform-deeplinks' });
  metaRow.appendChild(coverageEl);
  metaRow.appendChild(deepLinksEl);
  headerEl.appendChild(metaRow);

  headerEl.addEventListener('click', () => {
    entry.userToggled = true;
    setEntryOpen(entry, !entry.open);
  });
  headerEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      entry.userToggled = true;
      setEntryOpen(entry, !entry.open);
    }
  });

  root.appendChild(headerEl);

  const progressEl = el('div', { className: 'platform-progress', text: '' });
  root.appendChild(progressEl);

  const messageEl = el('div', { className: 'platform-message', text: '' });
  root.appendChild(messageEl);

  const needsUserEl = el('div', { className: 'platform-needs-user' });
  root.appendChild(needsUserEl);

  const bodyEl = el('div', { className: 'platform-body' });
  const summaryLineEl = el('p', { className: 'platform-summary-line', text: '' });
  bodyEl.appendChild(summaryLineEl);
  root.appendChild(bodyEl);

  entry.kind = 'card';
  entry.refs = { root, headerEl, chevronEl, labelEl, statusEl, coverageEl, deepLinksEl, progressEl, messageEl, needsUserEl, bodyEl, summaryLineEl };
  entry.slot.replaceChildren(root);
  setEntryOpen(entry, !!entry.open);
}

function buildEmptyDom(entry, id, label, coverage) {
  const row = el('div', { className: 'platform-empty-row', attrs: { 'data-platform': id } });
  const nameEl = el('span', { className: 'platform-empty-name', text: label || id });
  const statusEl = el('span', { className: 'platform-empty-status', text: 'No ads' });
  const coverageEl = el('span', { className: 'platform-empty-coverage', text: coverage || '' });
  const emptyIcon = platformIcon(id);
  if (emptyIcon) row.appendChild(emptyIcon);
  row.appendChild(nameEl);
  row.appendChild(statusEl);
  row.appendChild(coverageEl);
  entry.kind = 'empty';
  entry.refs = null;
  entry.slot.replaceChildren(row);
}

function isEmptyResult(result) {
  if (result.status === 'empty') return true;
  if (result.status !== 'ok') return false;
  const hasAds = Array.isArray(result.ads) && result.ads.length > 0;
  const hasAdvertisers = Array.isArray(result.advertisers) && result.advertisers.length > 0;
  return !hasAds && !hasAdvertisers;
}

function renderPlatformResult(result) {
  const entry = getOrCreateEntry(result.platform);
  entry.result = result;

  if (isEmptyResult(result)) {
    buildEmptyDom(entry, result.platform, result.label, result.coverage);
    return;
  }

  if (entry.kind !== 'card') buildCardDom(entry, result.platform);
  const { refs } = entry;

  refs.labelEl.textContent = result.label || result.platform;
  refs.coverageEl.textContent = result.coverage || '';
  refs.progressEl.textContent = '';
  const confirmedCount = (Array.isArray(result.ads) ? result.ads : []).filter((a) => a && a.match === 'confirmed').length;
  setStatusChip(refs.statusEl, result.status || 'ok', statusChipText(result));
  refs.messageEl.textContent = result.message || '';

  refs.needsUserEl.replaceChildren();
  if (result.status === 'needs_user' && result.deepLinks && result.deepLinks[0]) {
    const dl = result.deepLinks[0];
    const wrap = el('div');
    wrap.appendChild(safeLink(dl.url, dl.label || 'Open', { className: 'btn-link' }));
    refs.needsUserEl.appendChild(wrap);
  }

  // Up to 2 library links in the header with short text ("Library", "YouTube"); more go into a
  // list in the card body (renderPlatformBody).
  refs.deepLinksEl.replaceChildren();
  for (const dl of headerDeepLinks(result.deepLinks) || []) {
    const link = safeLink(dl.url, dl.short + ' ↗', { className: 'deeplink', title: dl.label });
    if (link.tagName === 'A') {
      link.setAttribute('aria-label', dl.label);
      link.addEventListener('click', (e) => e.stopPropagation());
    }
    refs.deepLinksEl.appendChild(link);
  }

  if (!entry.userToggled) {
    setEntryOpen(entry, confirmedCount > 0);
  }

  renderPlatformBody(entry, result);
}

function renderPlatformBody(entry, result) {
  const { refs } = entry;
  refs.bodyEl.replaceChildren();

  refs.summaryLineEl.textContent = '';
  if (result.summary && typeof result.summary === 'object') {
    const parts = [];
    const primary = Number(result.summary.primary) || 0;
    const other = Number(result.summary.other) || 0;
    const shared = Number(result.summary.sharedAccounts) || 0;
    parts.push(primary + (primary === 1 ? ' primary advertiser' : ' primary advertisers'));
    const mention = Number(result.summary.mention) || 0;
    if (other > 0) parts.push(other + (other === 1 ? ' other account' : ' other accounts'));
    if (shared > 0) parts.push(shared + (shared === 1 ? ' shared account' : ' shared accounts'));
    if (mention > 0) parts.push(mention + (mention === 1 ? ' account mentioning the brand' : ' accounts mentioning the brand'));
    refs.summaryLineEl.textContent = parts.join(', ');
    refs.bodyEl.appendChild(refs.summaryLineEl);
  }

  // More than 2 library links: one plain list here instead of header icons.
  if (Array.isArray(result.deepLinks) && result.deepLinks.length && !headerDeepLinks(result.deepLinks)) {
    const wrap = el('div', { className: 'platform-library-links' });
    wrap.appendChild(el('span', { className: 'platform-library-links-title', text: 'Libraries' }));
    for (const dl of result.deepLinks) {
      if (dl && isSafeHttpUrl(dl.url)) wrap.appendChild(safeLink(dl.url, dl.label || 'Open library'));
    }
    refs.bodyEl.appendChild(wrap);
  }

  const ads = result.ads || [];
  const advertisers = result.advertisers || [];

  const adsByAdvertiser = new Map();
  for (const ad of ads) {
    const key = ad.advertiserId || '';
    const list = adsByAdvertiser.get(key) || [];
    list.push(ad);
    adsByAdvertiser.set(key, list);
  }

  const grouped = new Set();
  let anyRendered = false;
  // Small accounts (role 'other': affiliates, resellers, brand bidders) go into one collapsed block,
  // accounts whose ads only mention the brand (role 'mention') into another one after it.
  const otherBlocks = [];
  const mentionBlocks = [];

  for (const adv of advertisers) {
    const advAds = adsByAdvertiser.get(adv.id) || [];
    grouped.add(adv.id);
    const confirmedCount = advAds.filter((a) => a.match === 'confirmed').length;
    if (onlyConfirmed && confirmedCount === 0) continue;
    const visibleAds = onlyConfirmed ? advAds.filter((a) => a.match === 'confirmed') : advAds;
    const block = renderAdvertiserBlock(adv, visibleAds, confirmedCount);
    if (adv.role === 'other') {
      otherBlocks.push(block);
    } else if (adv.role === 'mention') {
      mentionBlocks.push(block);
    } else {
      refs.bodyEl.appendChild(block);
    }
    anyRendered = true;
  }

  const appendGroup = (blocks, title, hint) => {
    if (!blocks.length) return;
    const group = el('details', { className: 'other-advertisers' });
    group.appendChild(el('summary', {
      className: 'other-advertisers-summary',
      text: title + ' (' + blocks.length + ')',
    }));
    group.appendChild(el('p', { className: 'other-advertisers-hint', text: hint }));
    const list = el('div', { className: 'other-advertisers-list' });
    for (const block of blocks) list.appendChild(block);
    group.appendChild(list);
    refs.bodyEl.appendChild(group);
  };
  appendGroup(otherBlocks, 'Other accounts', 'Often affiliates, resellers or rented agency accounts');
  appendGroup(mentionBlocks, 'Ads mentioning the brand', 'Their ads mention the brand but link to other sites, often competitors');

  const otherAds = [];
  for (const [key, list] of adsByAdvertiser.entries()) {
    if (grouped.has(key)) continue;
    otherAds.push(...list);
  }
  if (otherAds.length) {
    const confirmedCount = otherAds.filter((a) => a.match === 'confirmed').length;
    const visible = onlyConfirmed ? otherAds.filter((a) => a.match === 'confirmed') : otherAds;
    if (visible.length) {
      const pseudo = { id: '', name: 'Other ads', url: '', adCount: otherAds.length, confirmedCount, totalAds: null };
      refs.bodyEl.appendChild(renderAdvertiserBlock(pseudo, visible, confirmedCount));
      anyRendered = true;
    }
  }

  if (!anyRendered) {
    refs.bodyEl.appendChild(el('p', {
      className: 'empty-note',
      text: onlyConfirmed ? 'No confirmed ads.' : 'No ads found.',
    }));
  }
}

function renderAdvertiserBlock(adv, ads, confirmedCount) {
  const details = el('details', { className: 'advertiser-block' });
  const summary = el('summary', { className: 'advertiser-summary' });

  const nameWrap = el('span', { className: 'advertiser-name' });
  if (isSafeHttpUrl(adv.url)) {
    nameWrap.appendChild(safeLink(adv.url, adv.name || adv.id || 'Advertiser'));
  } else {
    nameWrap.textContent = adv.name || adv.id || 'Advertiser';
  }
  summary.appendChild(nameWrap);

  if (adv.id) {
    summary.appendChild(el('code', { className: 'advertiser-id', text: adv.id }));
  }

  const total = adv.adCount != null ? adv.adCount : ads.length;
  const countText = confirmedCount + '/' + total + (adv.totalAds ? ' (' + adv.totalAds + ')' : '');
  summary.appendChild(el('span', { className: 'advertiser-count', text: countText }));

  details.appendChild(summary);

  const hasNote = typeof adv.note === 'string' && adv.note.trim().length > 0;
  const hasDomains = Array.isArray(adv.domains) && adv.domains.length > 0;
  if (hasNote || hasDomains) {
    const extra = el('div', { className: 'advertiser-extra' });
    if (hasNote) {
      const isShared = /^shared account/i.test(adv.note.trim());
      extra.appendChild(el('p', {
        className: 'advertiser-note' + (isShared ? ' is-shared' : ''),
        text: adv.note,
      }));
    }
    if (hasDomains) {
      extra.appendChild(el('p', { className: 'advertiser-domains', text: 'Also seen on: ' + adv.domains.join(', ') }));
    }
    details.appendChild(extra);
  }

  const list = el('div', { className: 'ad-list' });
  for (const ad of ads) list.appendChild(renderAdRow(ad));
  details.appendChild(list);

  return details;
}

function renderAdRow(ad) {
  const row = el('div', { className: 'ad-row' });

  if (isSafeHttpUrl(ad.previewUrl)) {
    row.appendChild(el('img', {
      className: 'ad-thumb',
      attrs: { src: ad.previewUrl, loading: 'lazy', referrerpolicy: 'no-referrer', alt: '' },
    }));
  }

  const main = el('div', { className: 'ad-main' });

  const headRow = el('div', { className: 'ad-head-row' });
  const match = MATCH_HINTS[ad.match] ? ad.match : 'keyword';
  headRow.appendChild(el('span', {
    className: 'badge badge-' + match,
    text: matchLabel(match),
    attrs: { title: MATCH_HINTS[match] },
  }));
  const format = formatLabel(ad);
  if (format) headRow.appendChild(el('span', { className: 'ad-format', text: format }));
  if (ad.isActive === true) headRow.appendChild(el('span', { className: 'ad-active', text: 'Active' }));
  else if (ad.isActive === false) headRow.appendChild(el('span', { className: 'ad-inactive', text: 'Inactive' }));
  main.appendChild(headRow);

  if (ad.title) main.appendChild(el('div', { className: 'ad-title', text: ad.title }));
  if (ad.text) main.appendChild(el('div', { className: 'ad-text', text: ad.text }));

  const meta = el('div', { className: 'ad-meta' });
  if (ad.displayUrl) meta.appendChild(el('span', { text: ad.displayUrl }));
  if (ad.firstShown || ad.lastShown) {
    meta.appendChild(el('span', { text: (ad.firstShown || '?') + ' - ' + (ad.lastShown || '?') }));
  }
  const placements = placementsText(ad);
  if (placements) meta.appendChild(el('span', { text: placements }));
  if (meta.childNodes.length) main.appendChild(meta);

  const linkRow = el('div', { className: 'ad-link-row' });
  if (ad.landingUrl) linkRow.appendChild(safeLink(ad.landingUrl, 'Landing page'));
  if (ad.detailUrl) linkRow.appendChild(safeLink(ad.detailUrl, 'Open in library'));
  if (linkRow.childNodes.length) main.appendChild(linkRow);

  row.appendChild(main);
  return row;
}

// ---- manual libraries ----

function renderManualRows() {
  manualRowsEl.replaceChildren();
  for (const item of manualLibraries) {
    if (!item || typeof item !== 'object') continue;
    const row = el('div', { className: 'manual-row' });
    const top = el('div', { className: 'manual-row-top' });
    top.appendChild(el('span', { className: 'chip chip-manual', text: 'Manual' }));
    top.appendChild(el('span', { className: 'manual-label', text: item.label || item.id || 'Library' }));
    if (item.handle) top.appendChild(el('span', { className: 'manual-handle', text: item.handle }));
    if (item.coverage) top.appendChild(el('span', { className: 'manual-coverage', text: item.coverage }));
    row.appendChild(top);
    if (item.hint) row.appendChild(el('p', { className: 'manual-hint', text: item.hint }));
    if (isSafeHttpUrl(item.url)) {
      const actions = el('div', { className: 'manual-row-actions' });
      actions.appendChild(safeLink(item.url, 'Open', { className: 'btn-link' }));
      row.appendChild(actions);
    }
    manualRowsEl.appendChild(row);
  }
}

// ---- settings drawer ----

function renderTiktokRegionCheckboxes() {
  tiktokRegionsEl.replaceChildren();
  for (const code of REGION_CODES) {
    const label = el('label', { className: 'region-checkbox' });
    const input = el('input', { attrs: { type: 'checkbox', id: 'region-' + code } });
    label.appendChild(input);
    label.appendChild(document.createTextNode(code));
    tiktokRegionsEl.appendChild(label);
  }
}

function setNumberField(id, value) {
  const input = document.getElementById(id);
  if (input && value !== undefined && value !== null) input.value = String(value);
}

function getNumberField(id, fallback) {
  const input = document.getElementById(id);
  if (!input || input.value === '') return fallback;
  const n = Number(input.value);
  return Number.isFinite(n) ? n : fallback;
}

function populateSettingsForm(settings) {
  for (const id of PLATFORM_ORDER) {
    const cb = document.getElementById('setting-platform-' + id);
    if (cb) cb.checked = !!(settings.platforms && settings.platforms[id]);
  }

  setNumberField('setting-maxPagesGoogle', settings.maxPagesGoogle);
  setNumberField('setting-metaScrolls', settings.metaScrolls);
  setNumberField('setting-metaExpandPages', settings.metaExpandPages);
  setNumberField('setting-tiktokDetails', settings.tiktokDetails);
  setNumberField('setting-linkedinDetails', settings.linkedinDetails);
  setNumberField('setting-linkedinPages', settings.linkedinPages);
  setNumberField('setting-bingAdvertisers', settings.bingAdvertisers);
  setNumberField('setting-cacheHours', settings.cacheHours);

  const regionSet = new Set(settings.tiktokRegions || []);
  for (const code of REGION_CODES) {
    const cb = document.getElementById('region-' + code);
    if (cb) cb.checked = regionSet.has(code);
  }

  const keyInput = document.getElementById('setting-searchapiKey');
  if (keyInput) keyInput.value = settings.searchapiKey || '';
  const fallbackInput = document.getElementById('setting-useSearchapiFallback');
  if (fallbackInput) fallbackInput.checked = !!settings.useSearchapiFallback;
  const showTabsInput = document.getElementById('setting-showScanTabs');
  if (showTabsInput) showTabsInput.checked = !!settings.showScanTabs;
  remoteLogValue = settings.remoteLog === true || settings.remoteLog === false ? settings.remoteLog : null;
  remoteLogInput.checked = remoteLogValue === true;
}

function collectSettingsForm() {
  const platforms = {};
  for (const id of PLATFORM_ORDER) {
    const cb = document.getElementById('setting-platform-' + id);
    platforms[id] = cb ? cb.checked : true;
  }

  const tiktokRegions = [];
  for (const code of REGION_CODES) {
    const cb = document.getElementById('region-' + code);
    if (cb && cb.checked) tiktokRegions.push(code);
  }

  return {
    platforms,
    maxPagesGoogle: getNumberField('setting-maxPagesGoogle', 5),
    metaScrolls: getNumberField('setting-metaScrolls', 2),
    metaExpandPages: getNumberField('setting-metaExpandPages', 3),
    tiktokRegions,
    tiktokDetails: getNumberField('setting-tiktokDetails', 8),
    linkedinDetails: getNumberField('setting-linkedinDetails', 10),
    linkedinPages: getNumberField('setting-linkedinPages', 2),
    bingAdvertisers: getNumberField('setting-bingAdvertisers', 6),
    searchapiKey: (document.getElementById('setting-searchapiKey') || {}).value || '',
    useSearchapiFallback: !!(document.getElementById('setting-useSearchapiFallback') || {}).checked,
    showScanTabs: !!(document.getElementById('setting-showScanTabs') || {}).checked,
    cacheHours: getNumberField('setting-cacheHours', 24),
    // Untouched while never asked stays null, so saving other settings does not answer the prompt.
    remoteLog: remoteLogValue,
  };
}

// ---- debug log ----

const LOG_VIEW_LINES = 100;
let pendingLogCopy = false;

// Same format as background/log.js formatLogLines.
function formatLogLines(entries) {
  return (Array.isArray(entries) ? entries : []).map(
    (e) => e.t + ' ' + String(e.level || 'info').toUpperCase() + ' [' + e.src + '] ' + e.msg,
  );
}

function setLogStatus(text) {
  debugLogStatusEl.textContent = text;
  setTimeout(() => {
    if (debugLogStatusEl.textContent === text) debugLogStatusEl.textContent = '';
  }, 2000);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fallback when the clipboard API refuses (document not focused).
    const ta = el('textarea', { attrs: { readonly: '', style: 'position:fixed;left:-9999px' } });
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    ta.remove();
    return ok;
  }
}

function onLog(entries) {
  const list = Array.isArray(entries) ? entries : [];
  if (showLogToggle.checked) {
    debugLogViewEl.textContent = formatLogLines(list.slice(-LOG_VIEW_LINES)).join('\n') || '(empty)';
    debugLogViewEl.scrollTop = debugLogViewEl.scrollHeight;
  }
  if (pendingLogCopy) {
    pendingLogCopy = false;
    if (!list.length) {
      setLogStatus('Log is empty.');
      return;
    }
    copyText(formatLogLines(list).join('\n')).then((ok) => {
      setLogStatus(ok ? 'Copied ' + list.length + ' lines.' : 'Copy failed.');
    });
  }
}

function openSettings() {
  settingsBackdrop.hidden = false;
  settingsDrawerEl.hidden = false;
}

function closeSettings() {
  settingsBackdrop.hidden = true;
  settingsDrawerEl.hidden = true;
}

// ---- export ----

function exportFilename(data, ext) {
  const domain = (data.domain || 'domain').replace(/[^a-z0-9.-]+/gi, '-');
  let dateStr = 'unknown';
  try {
    const d = new Date(data.at);
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    dateStr = yyyy + mm + dd;
  } catch {
    dateStr = 'unknown';
  }
  return 'superpixel-' + domain + '-' + dateStr + '.' + ext;
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = el('a', { attrs: { href: url, download: filename } });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

// ---- event wiring ----

function startScanFromInput() {
  const domain = domainInput.value.trim();
  if (!domain) return;
  beginScan({ mode: 'domain', domain }, false);
}

scanBtn.addEventListener('click', startScanFromInput);

domainInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    startScanFromInput();
  }
});

currentTabBtn.addEventListener('click', async () => {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = tabs && tabs[0];
    if (!tab) return;
    let hostname = '';
    try {
      hostname = new URL(tab.url).hostname;
    } catch {
      hostname = '';
    }
    domainInput.value = hostname;
    beginScan({ mode: 'tab', tabId: tab.id }, false);
  } catch {
    showError('Could not read the current tab.');
  }
});

stopBtn.addEventListener('click', () => {
  send({ type: 'stop' });
});

rescanBtn.addEventListener('click', () => {
  if (lastScanInput) beginScan(lastScanInput, true);
});

settingsBtn.addEventListener('click', openSettings);
settingsCloseBtn.addEventListener('click', closeSettings);
settingsBackdrop.addEventListener('click', closeSettings);

settingsSaveBtn.addEventListener('click', () => {
  const settings = collectSettingsForm();
  send({ type: 'saveSettings', settings });
  settingsStatusEl.textContent = 'Saved.';
  setTimeout(() => {
    settingsStatusEl.textContent = '';
  }, 1500);
});

clearCacheBtn.addEventListener('click', () => {
  send({ type: 'clearCache' });
  settingsStatusEl.textContent = 'Cache cleared.';
  setTimeout(() => {
    settingsStatusEl.textContent = '';
  }, 1500);
});

consentYesBtn.addEventListener('click', () => answerConsent(true));
consentNoBtn.addEventListener('click', () => answerConsent(false));

remoteLogInput.addEventListener('change', () => {
  remoteLogValue = remoteLogInput.checked;
  consentBannerEl.hidden = true;
});

copyLogBtn.addEventListener('click', () => {
  pendingLogCopy = true;
  send({ type: 'getLog' });
});

clearLogBtn.addEventListener('click', () => {
  send({ type: 'clearLog' });
  setLogStatus('Log cleared.');
});

showLogToggle.addEventListener('change', () => {
  debugLogViewEl.hidden = !showLogToggle.checked;
  if (showLogToggle.checked) send({ type: 'getLog' });
});

onlyConfirmedToggle.addEventListener('change', () => {
  onlyConfirmed = onlyConfirmedToggle.checked;
  for (const entry of platformEntries.values()) {
    if (entry.kind === 'card' && entry.result) renderPlatformBody(entry, entry.result);
  }
});

exportJsonBtn.addEventListener('click', () => {
  if (!lastData) return;
  const blob = new Blob([JSON.stringify(lastData, null, 2)], { type: 'application/json' });
  downloadBlob(blob, exportFilename(lastData, 'json'));
});

// ---- init ----

function init() {
  renderTiktokRegionCheckboxes();
  updateScanUi();
  send({ type: 'getLast' });
  send({ type: 'getSettings' });
}

document.addEventListener('DOMContentLoaded', init);
