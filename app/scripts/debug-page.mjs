/**
 * Headless debug probe: opens the app, captures console messages, page
 * errors, and a screenshot. Usage:
 *   node scripts/debug-page.mjs [url] [shotPrefix]
 * Expects the dev server to be running (default http://localhost:5173).
 */
import puppeteer from 'puppeteer';

const url = process.argv[2] ?? 'http://localhost:5173';
const shot = process.argv[3] ?? '../pipeline/out/debug';

const browser = await puppeteer.launch({
  headless: 'new',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--window-size=1400,900'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 900 });

const logs = [];
page.on('console', (msg) => logs.push(`[console:${msg.type()}] ${msg.text()}`));
page.on('pageerror', (err) => logs.push(`[pageerror] ${err.message}`));
page.on('requestfailed', (req) => logs.push(`[requestfailed] ${req.url()} — ${req.failure()?.errorText}`));
page.on('response', (res) => { if (res.status() >= 400) logs.push(`[http ${res.status()}] ${res.url()}`); });

await page.goto(url, { waitUntil: 'networkidle2', timeout: 120000 });
// give the 36MB GLB + 4K textures time to load and a few frames to render
await new Promise((r) => setTimeout(r, 15000));
await page.screenshot({ path: `${shot}-1.png` });

// probe scene state from the page if the app exposes anything useful
const state = await page.evaluate(() => {
  const canvas = document.querySelector('canvas');
  return {
    canvas: canvas ? `${canvas.width}x${canvas.height}` : 'none',
    bodyText: document.body.innerText.slice(0, 300),
  };
});
console.log('page state:', JSON.stringify(state, null, 2));
console.log('--- logs ---');
for (const line of logs) console.log(line);
if (logs.length === 0) console.log('(no console output captured)');

await browser.close();
