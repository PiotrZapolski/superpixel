// Fake extension runtime for the store screenshots. Injected by store/render.mjs into every frame
// (Playwright addInitScript, before any page script). It only acts inside the real, unmodified
// sidepanel/sidepanel.html: defines window.chrome with a port that replays the recorded demo scan
// (store/src/demo-data.js) exactly like background/scan.js would send it, then applies the view
// state for the shot (?shot=hero|tags|ads|export) the way a user would by clicking.
(function () {
  if (!/\/sidepanel\/sidepanel\.html$/.test(location.pathname)) return;
  const DEMO = window.SUPERPIXEL_DEMO;
  const shot = new URLSearchParams(location.search).get('shot') || 'hero';

  const listeners = [];
  const later = (fn, ms) => setTimeout(fn, ms || 0);
  const deliver = (msg) => later(() => listeners.forEach((l) => l(msg)));

  function replay() {
    let t = 30;
    for (const msg of DEMO.messages) {
      later(() => listeners.forEach((l) => l(msg)), t);
      t += 25;
    }
    later(afterScan, t + 200);
  }

  const port = {
    name: 'superpixel',
    onMessage: { addListener: (fn) => listeners.push(fn), removeListener() {} },
    onDisconnect: { addListener() {}, removeListener() {} },
    postMessage(msg) {
      if (!msg) return;
      if (msg.type === 'getSettings') deliver({ type: 'settings', settings: DEMO.settings });
      else if (msg.type === 'scan') replay();
    },
    disconnect() {},
  };

  const noop = () => {};
  const evt = { addListener: noop, removeListener: noop };
  window.chrome = {
    runtime: { connect: () => port, onMessage: evt, sendMessage: noop, getURL: (p) => '/' + p, id: 'demo' },
    storage: { local: { get: async () => ({}), set: async () => {} }, onChanged: evt },
    tabs: { query: async () => [{ id: 1, url: 'https://' + DEMO.domain + '/' }], create: noop },
  };

  // Font: the panel uses the OS UI font; the Linux render box has none, so use Inter instead.
  function styleFont() {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=block';
    document.head.appendChild(link);
    const st = document.createElement('style');
    st.textContent = ':root{--font-sans:"Inter",sans-serif;} html{scrollbar-width:none} ::-webkit-scrollbar{display:none}';
    document.head.appendChild(st);
  }

  function card(id) {
    return document.querySelector('.platform-card[data-platform="' + id + '"]');
  }
  function openAdvertiser(id, index) {
    const c = card(id);
    const blocks = c ? c.querySelectorAll('.platform-body > .advertiser-block') : [];
    if (blocks[index || 0]) blocks[index || 0].open = true;
  }
  function closeCard(id) {
    const c = card(id);
    if (c && c.classList.contains('open')) c.querySelector('.platform-card-header').click();
  }
  function topbarHeight() {
    return document.querySelector('.topbar').getBoundingClientRect().height;
  }

  async function afterScan() {
    if (shot === 'hero') {
      openAdvertiser('google', 0);
      closeCard('tiktok');
      closeCard('bing');
    } else if (shot === 'ads') {
      for (const id of ['google', 'meta', 'bing']) closeCard(id);
      openAdvertiser('tiktok', 0);
      const y = document.getElementById('platforms-section').getBoundingClientRect().top + scrollY - topbarHeight() - 4;
      scrollTo(0, y);
    } else if (shot === 'tags') {
      for (const id of ['google', 'meta', 'tiktok', 'bing']) closeCard(id);
      document.getElementById('tags-section').open = true;
      const y = document.getElementById('tags-section').getBoundingClientRect().top + scrollY - topbarHeight() - 6;
      scrollTo(0, y);
    } else if (shot === 'export') {
      document.getElementById('settings-btn').click();
      const drawer = document.getElementById('settings-drawer');
      drawer.scrollTop = drawer.scrollHeight;
    }
    await document.fonts.ready;
    // Let lazy thumbnails load before the shot.
    const loads = [...document.images].map((img) => (img.complete ? null : new Promise((r) => { img.onload = img.onerror = r; })));
    await Promise.race([Promise.all(loads), new Promise((r) => setTimeout(r, 3000))]);
    window.__spReady = true;
  }

  document.addEventListener('DOMContentLoaded', () => {
    styleFont();
    // Start the scan like a user: type the domain and press Scan.
    later(() => {
      document.getElementById('domain-input').value = DEMO.domain;
      document.getElementById('scan-btn').click();
    }, 50);
  });
})();
