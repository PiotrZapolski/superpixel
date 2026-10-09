// Renders the store graphics. Runs inside the Playwright Docker image (see render.sh), with the
// repo mounted at /repo and playwright-core installed in /deps. Serves the repo over HTTP so the
// real side panel (ES modules) loads, injects the fake chrome runtime (store/src/stub.js) into
// every frame, and writes unflattened PNGs to store/out/raw/.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire('/deps/node_modules/');
const { chromium } = require('playwright-core');

const ROOT = '/repo';
const OUT = path.join(ROOT, 'store/out/raw');
const PORT = 8123;

const TARGETS = [
  { name: 'screenshot-1-hero', w: 1280, h: 800 },
  { name: 'screenshot-2-tags', w: 1280, h: 800 },
  { name: 'screenshot-3-ads', w: 1280, h: 800 },
  { name: 'screenshot-4-export', w: 1280, h: 800 },
  { name: 'promo-small', w: 440, h: 280 },
  { name: 'promo-marquee', w: 1400, h: 560 },
];

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json' };

const server = http.createServer((req, res) => {
  const p = path.normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname));
  const file = path.join(ROOT, p);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404);
    res.end();
    return;
  }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(PORT, r));

const only = process.argv.slice(2);
fs.mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
try {
  for (const t of TARGETS) {
    if (only.length && !only.includes(t.name)) continue;
    const ctx = await browser.newContext({ viewport: { width: t.w, height: t.h }, deviceScaleFactor: 1, colorScheme: 'light', locale: 'en-US', timezoneId: 'Europe/Berlin' });
    await ctx.addInitScript({ path: path.join(ROOT, 'store/src/demo-data.js') });
    await ctx.addInitScript({ path: path.join(ROOT, 'store/src/stub.js') });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => console.error(`[${t.name}] pageerror:`, e.message));
    page.on('console', (m) => { if (m.type() === 'error') console.error(`[${t.name}] console:`, m.text()); });
    await page.goto(`http://localhost:${PORT}/store/src/${t.name}.html`, { waitUntil: 'load' });
    for (const f of page.frames()) {
      if (f.url().includes('/sidepanel/sidepanel.html')) await f.waitForFunction(() => window.__spReady === true, null, { timeout: 20000 });
    }
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(OUT, `${t.name}.png`), clip: { x: 0, y: 0, width: t.w, height: t.h } });
    console.log('rendered', t.name);
    await ctx.close();
  }
} finally {
  await browser.close();
  server.close();
}
