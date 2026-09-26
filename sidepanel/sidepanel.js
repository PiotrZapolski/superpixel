// Superpixel side panel UI. Talks to the service worker over a long-lived port
// named "superpixel". No frameworks, no innerHTML with remote data.

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

const STATUS_LABELS = {
  ok: 'OK',
  empty: 'Empty',
  error: 'Error',
  rate_limited: 'Rate limited',
  needs_user: 'Needs you',
  changed: 'Changed',
  skipped: 'Skipped',
  running: 'Running',
};

const MORE_LIBRARIES = [
  { label: 'Pinterest', url: 'https://ads.pinterest.com/ads-repository/' },
  { label: 'X', url: 'https://ads.x.com/ads-repository' },
  { label: 'Apple', url: 'https://adrepository.apple.com/' },
  { label: 'Snap (political)', url: 'https://www.snap.com/political-ads' },
];

const CSV_COLUMNS = [
  'platform', 'advertiser_id', 'advertiser_name', 'advertiser_role', 'ad_id', 'match', 'format', 'title', 'text',
  'landing_url', 'display_url', 'first_shown', 'last_shown', 'is_active', 'placements',
  'detail_url', 'source',
];

// ---- state ----

let port = null;
let scanning = false;
let currentScan = null; // scan being built up from live events
let lastData = null; // last completed / stored scan, used for export and rendering
let lastScanInput = null; // {mode:'domain', domain} | {mode:'tab', tabId}
let onlyConfirmed = false;
const cardEls = new Map(); // platform id -> card refs

// ---- DOM refs ----

const domainInput = document.getElementById('domain-input');
const scanBtn = document.getElementById('scan-btn');
const currentTabBtn = document.getElementById('current-tab-btn');
const stopBtn = document.getElementById('stop-btn');
const settingsBtn = document.getElementById('settings-btn');
const phaseTextEl = document.getElementById('phase-text');
const errorTextEl = document.getElementById('error-text');

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

const tagsGroupsEl = document.getElementById('tags-groups');
const brandSignalsEl = document.getElementById('brand-signals');

const onlyConfirmedToggle = document.getElementById('only-confirmed-toggle');
const platformCardsEl = document.getElementById('platform-cards');
const moreLibrariesEl = document.getElementById('more-libraries');

const exportJsonBtn = document.getElementById('export-json-btn');
const exportCsvBtn = document.getElementById('export-csv-btn');
const lastScanNoteEl = document.getElementById('last-scan-note');
const rescanBtn = document.getElementById('rescan-btn');

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
      attrs: { href: url, target: '_blank', rel: 'noopener noreferrer' },
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
  scanBtn.disabled = scanning;
  currentTabBtn.disabled = scanning;
  stopBtn.hidden = !scanning;
  rescanBtn.disabled = scanning;
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
  };
  cardEls.clear();
  platformCardsEl.replaceChildren();
  tagsGroupsEl.replaceChildren();
  brandSignalsEl.replaceChildren();
  send({ type: 'scan', input, force: !!force });
}

function onPhase(text) {
  scanning = true;
  updateScanUi();
  phaseTextEl.textContent = text || '';
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

function onPlatformStart(id, label, coverage) {
  const card = getOrCreateCard(id);
  card.labelEl.textContent = label || id;
  card.coverageEl.textContent = coverage || '';
  setStatusChip(card.statusEl, 'running');
  card.progressEl.textContent = '';
  card.messageEl.textContent = '';
  card.needsUserEl.replaceChildren();
  card.deepLinksEl.replaceChildren();
  card.bodyEl.replaceChildren();
  card.result = null;
}

function onProgress(id, text) {
  const card = getOrCreateCard(id);
  card.progressEl.textContent = text || '';
}

function onPlatformResult(result) {
  if (!result || !result.platform) return;
  if (!currentScan) {
    // Results of a scan this panel did not start (reattached background scan).
    currentScan = { domain: domainInput.value.trim(), at: new Date().toISOString(), tags: [], seeds: null, results: [], partial: true };
  }
  const idx = currentScan.results.findIndex((r) => r.platform === result.platform);
  if (idx >= 0) currentScan.results[idx] = result;
  else currentScan.results.push(result);
  renderPlatformCard(result);
}

function formatSummary(summary) {
  if (!summary || typeof summary !== 'object') return summary ? String(summary) : 'Done.';
  const secs = Math.round((Number(summary.ms) || 0) / 1000);
  return (summary.stopped ? 'Stopped. ' : 'Done. ') +
    (summary.totalAds || 0) + ' ads, ' + (summary.confirmedAds || 0) + ' confirmed, ' + secs + 's.';
}

function onDone(summary) {
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
  scanning = false;
  updateScanUi();
  showError(message || 'An error occurred.');
}

function onLast(data) {
  if (!data) return;
  lastData = data;
  currentScan = null;
  lastScanInput = { mode: 'domain', domain: data.domain };
  domainInput.value = data.domain || '';
  cardEls.clear();
  platformCardsEl.replaceChildren();
  renderTags(data.tags, data.seeds);
  for (const result of data.results || []) {
    renderPlatformCard(result);
  }
  afterDataReady(true);
}

function afterDataReady(cached) {
  updateLastScanNote(lastData.at, cached);
  rescanBtn.hidden = false;
  exportJsonBtn.disabled = false;
  exportCsvBtn.disabled = false;
}

function updateLastScanNote(atIso, cached) {
  if (!atIso) {
    lastScanNoteEl.textContent = '';
    return;
  }
  let when;
  try {
    when = new Date(atIso).toLocaleString();
  } catch {
    when = atIso;
  }
  lastScanNoteEl.textContent = (cached ? 'Cached scan from ' : 'Last scan ') + when;
}

function onSettings(settings) {
  populateSettingsForm(settings || {});
}

// ---- tags / brand signals ----

function renderTags(tags, seeds) {
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
  head.appendChild(el('span', { text: hit.platform }));
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

// ---- platform cards ----

function setStatusChip(node, status) {
  node.className = 'status-chip status-' + status;
  node.textContent = STATUS_LABELS[status] || status;
}

function getOrCreateCard(id) {
  let card = cardEls.get(id);
  if (card) return card;

  const root = el('div', { className: 'platform-card', attrs: { 'data-platform': id } });

  const header = el('div', { className: 'platform-card-header' });
  const titleWrap = el('div', { className: 'platform-card-title' });
  const labelEl = el('span', { className: 'platform-label', text: id });
  const coverageEl = el('span', { className: 'platform-coverage', text: '' });
  titleWrap.appendChild(labelEl);
  titleWrap.appendChild(coverageEl);
  const statusEl = el('span', { className: 'status-chip status-running', text: 'Waiting' });
  header.appendChild(titleWrap);
  header.appendChild(statusEl);
  root.appendChild(header);

  const progressEl = el('div', { className: 'platform-progress', text: '' });
  root.appendChild(progressEl);

  const messageEl = el('div', { className: 'platform-message', text: '' });
  root.appendChild(messageEl);

  const needsUserEl = el('div', { className: 'platform-needs-user' });
  root.appendChild(needsUserEl);

  const deepLinksEl = el('div', { className: 'platform-deeplinks' });
  root.appendChild(deepLinksEl);

  const bodyEl = el('div', { className: 'platform-body' });
  root.appendChild(bodyEl);

  card = { id, root, labelEl, coverageEl, statusEl, progressEl, messageEl, needsUserEl, deepLinksEl, bodyEl, result: null };
  cardEls.set(id, card);

  const idx = PLATFORM_ORDER.indexOf(id);
  let inserted = false;
  for (const child of platformCardsEl.children) {
    const childIdx = PLATFORM_ORDER.indexOf(child.getAttribute('data-platform'));
    if (idx >= 0 && (childIdx < 0 || childIdx > idx)) {
      platformCardsEl.insertBefore(root, child);
      inserted = true;
      break;
    }
  }
  if (!inserted) platformCardsEl.appendChild(root);

  return card;
}

function renderPlatformCard(result) {
  const card = getOrCreateCard(result.platform);
  card.result = result;
  card.labelEl.textContent = result.label || result.platform;
  card.coverageEl.textContent = result.coverage || '';
  card.progressEl.textContent = '';
  setStatusChip(card.statusEl, result.status || 'ok');
  card.messageEl.textContent = result.message || '';

  card.needsUserEl.replaceChildren();
  if (result.status === 'needs_user' && result.deepLinks && result.deepLinks[0]) {
    const dl = result.deepLinks[0];
    const wrap = el('div');
    wrap.appendChild(safeLink(dl.url, dl.label || 'Open', { className: 'btn-link' }));
    card.needsUserEl.appendChild(wrap);
  }

  card.deepLinksEl.replaceChildren();
  if (result.deepLinks && result.deepLinks.length) {
    const row = el('div', { className: 'deeplink-row' });
    for (const dl of result.deepLinks) {
      row.appendChild(safeLink(dl.url, dl.label, { className: 'deeplink' }));
    }
    card.deepLinksEl.appendChild(row);
  }

  renderPlatformBody(card, result);
}

function renderPlatformBody(card, result) {
  card.bodyEl.replaceChildren();
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
  // Small accounts (role 'other': affiliates, resellers, brand bidders) go into one collapsed block.
  const otherBlocks = [];

  for (const adv of advertisers) {
    const advAds = adsByAdvertiser.get(adv.id) || [];
    grouped.add(adv.id);
    const confirmedCount = advAds.filter((a) => a.match === 'confirmed').length;
    if (onlyConfirmed && confirmedCount === 0) continue;
    const visibleAds = onlyConfirmed ? advAds.filter((a) => a.match === 'confirmed') : advAds;
    const block = renderAdvertiserBlock(adv, visibleAds, confirmedCount);
    if (adv.role === 'other') {
      otherBlocks.push(block);
    } else {
      card.bodyEl.appendChild(block);
    }
    anyRendered = true;
  }

  if (otherBlocks.length) {
    const group = el('details', { className: 'other-advertisers' });
    group.appendChild(el('summary', {
      className: 'other-advertisers-summary',
      text: 'Other accounts running ads to this domain (' + otherBlocks.length + ')',
    }));
    group.appendChild(el('p', { className: 'other-advertisers-hint', text: 'Often affiliates, resellers or brand bidders' }));
    const list = el('div', { className: 'other-advertisers-list' });
    for (const block of otherBlocks) list.appendChild(block);
    group.appendChild(list);
    card.bodyEl.appendChild(group);
  }

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
      card.bodyEl.appendChild(renderAdvertiserBlock(pseudo, visible, confirmedCount));
      anyRendered = true;
    }
  }

  if (!anyRendered) {
    card.bodyEl.appendChild(el('p', {
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
  headRow.appendChild(el('span', { className: 'badge badge-' + (ad.match || 'keyword'), text: ad.match || '' }));
  if (ad.format) headRow.appendChild(el('span', { className: 'ad-format', text: ad.format }));
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
  if (ad.placements && ad.placements.length) {
    meta.appendChild(el('span', { text: ad.placements.join(', ') }));
  }
  if (meta.childNodes.length) main.appendChild(meta);

  const linkRow = el('div', { className: 'ad-link-row' });
  if (ad.landingUrl) linkRow.appendChild(safeLink(ad.landingUrl, 'Landing page'));
  if (ad.detailUrl) linkRow.appendChild(safeLink(ad.detailUrl, 'Open in library'));
  if (linkRow.childNodes.length) main.appendChild(linkRow);

  row.appendChild(main);
  return row;
}

function renderMoreLibraries() {
  moreLibrariesEl.replaceChildren();
  moreLibrariesEl.appendChild(el('h3', { text: 'More libraries' }));
  const row = el('div', { className: 'chip-row' });
  for (const item of MORE_LIBRARIES) {
    row.appendChild(safeLink(item.url, item.label, { className: 'chip chip-link' }));
  }
  moreLibrariesEl.appendChild(row);
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

function csvField(value) {
  if (value === null || value === undefined) return '';
  const str = String(value);
  if (/["\n\r,]/.test(str)) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

function buildCsv(data) {
  const rows = [CSV_COLUMNS.join(',')];
  for (const result of data.results || []) {
    const roles = new Map();
    for (const adv of result.advertisers || []) {
      if (adv && adv.id) roles.set(adv.id, adv.role || 'primary');
    }
    for (const ad of result.ads || []) {
      const row = [
        ad.platform || result.platform || '',
        ad.advertiserId || '',
        ad.advertiserName || '',
        roles.get(ad.advertiserId) || '',
        ad.id || '',
        ad.match || '',
        ad.format || '',
        ad.title || '',
        ad.text || '',
        ad.landingUrl || '',
        ad.displayUrl || '',
        ad.firstShown || '',
        ad.lastShown || '',
        ad.isActive === null || ad.isActive === undefined ? '' : String(ad.isActive),
        (ad.placements || []).join(';'),
        ad.detailUrl || '',
        ad.source || '',
      ];
      rows.push(row.map(csvField).join(','));
    }
  }
  return rows.join('\r\n');
}

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
  for (const card of cardEls.values()) {
    if (card.result) renderPlatformBody(card, card.result);
  }
});

exportJsonBtn.addEventListener('click', () => {
  if (!lastData) return;
  const blob = new Blob([JSON.stringify(lastData, null, 2)], { type: 'application/json' });
  downloadBlob(blob, exportFilename(lastData, 'json'));
});

exportCsvBtn.addEventListener('click', () => {
  if (!lastData) return;
  const blob = new Blob([buildCsv(lastData)], { type: 'text/csv' });
  downloadBlob(blob, exportFilename(lastData, 'csv'));
});

// ---- init ----

function init() {
  renderTiktokRegionCheckboxes();
  renderMoreLibraries();
  updateScanUi();
  send({ type: 'getLast' });
  send({ type: 'getSettings' });
}

document.addEventListener('DOMContentLoaded', init);
