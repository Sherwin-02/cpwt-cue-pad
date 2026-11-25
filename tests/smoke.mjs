// End-to-end smoke test for Cue Pad in headless Chromium.
// Usage: node tests/smoke.mjs   (needs playwright and ffmpeg on PATH)
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFile, mkdir, access } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtures = path.join(root, 'tests', 'fixtures');

async function makeFixtures() {
  await mkdir(fixtures, { recursive: true });
  const specs = [
    ['Short Sting.mp3', 'sine=frequency=440:duration=4'],
    ['Shepherds_Dance.mp3', 'sine=frequency=330:duration=40'],
    ['Drama BGM.mp3', 'anoisesrc=d=25:c=pink:a=0.2'],
  ];
  for (const [name, src] of specs) {
    const out = path.join(fixtures, name);
    try { await access(out); continue; } catch {}
    execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', src, '-ac', '2', '-b:a', '320k', out]);
  }
  return specs.map(([n]) => path.join(fixtures, n));
}

const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.mp3': 'audio/mpeg' };
function serve() {
  return new Promise((resolve) => {
    const srv = createServer(async (req, res) => {
      let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      if (p.endsWith('/')) p += 'index.html';
      try {
        const body = await readFile(path.join(root, p));
        res.writeHead(200, { 'content-type': types[path.extname(p)] || 'application/octet-stream' });
        res.end(body);
      } catch { res.writeHead(404); res.end(); }
    });
    srv.listen(0, () => resolve(srv));
  });
}

let failures = 0;
const check = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) failures++; };

const files = await makeFixtures();
const srv = await serve();
const url = `http://localhost:${srv.address().port}/`;
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 1180, height: 820 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/404/.test(m.text())) errors.push(m.text()); });
page.on('response', (r) => { if (r.status() === 404 && !r.url().endsWith('/assets/logo.png')) errors.push('404 ' + r.url()); });

await page.goto(url);
await page.waitForFunction(() => window.cuepad && window.cuepad.state.show);
check(await page.isVisible('#startOverlay'), 'start overlay shown on launch');
await page.click('#startOverlay');
check(await page.evaluate(() => window.cuepad.engine.running), 'audio context running after tap');

await page.click('#editBtn');
await page.setInputFiles('#filePicker', files);
await page.waitForFunction(() => window.cuepad.state.show.tiles.length === 3);
await page.waitForFunction(() => window.cuepad.state.show.tiles.every((t) => window.cuepad.engine.prepStatus(t.id) === 'ready'), null, { timeout: 30000 });
check(true, 'three tracks imported and preloaded');
const labels = await page.$$eval('.tile:not(.add) .label', (n) => n.map((x) => x.textContent));
check(JSON.stringify(labels) === JSON.stringify(['Short Sting', 'Shepherds Dance', 'Drama BGM']), `tile labels ${JSON.stringify(labels)}`);
await page.click('#editBtn');

// Tap tile 2 (40 s track): plays instantly from the head, tail joins at 15 s.
const ids = await page.evaluate(() => window.cuepad.state.show.tiles.map((t) => t.id));
await page.locator(`.tile[data-id="${ids[1]}"]`).dispatchEvent('pointerdown');
check(await page.evaluate((id) => window.cuepad.engine.isPlaying(id), ids[1]), 'tile 2 playing immediately after touch');
await page.waitForFunction((id) => window.cuepad.engine.players.get(id)?.tailState === 'scheduled', ids[1], { timeout: 10000 });
check(true, 'tail of tile 2 scheduled before head ran out');

// Tap tile 3 (not layered) -> tile 2 fades out
await page.locator(`.tile[data-id="${ids[2]}"]`).dispatchEvent('pointerdown');
await page.waitForTimeout(100);
check(await page.evaluate(([a, b]) => !window.cuepad.engine.isPlaying(a) && window.cuepad.engine.isPlaying(b), [ids[1], ids[2]]), 'starting tile 3 fades out tile 2');

// Layered sting plays over
await page.evaluate((id) => { window.cuepad.state.show.tiles.find((t) => t.id === id).layer = true; }, ids[0]);
await page.locator(`.tile[data-id="${ids[0]}"]`).dispatchEvent('pointerdown');
check(await page.evaluate(([a, b]) => window.cuepad.engine.isPlaying(a) && window.cuepad.engine.isPlaying(b), [ids[0], ids[2]]), 'layered sting plays over tile 3');

await page.screenshot({ path: path.join(fixtures, 'screenshot-playing.png') });

await page.locator('#stopAll').dispatchEvent('pointerdown');
await page.waitForTimeout(300);
check(await page.evaluate(() => window.cuepad.engine.players.size === 0), 'stop all silences everything');

// Seam test: head + scheduled tail must equal playing the full buffer.
const seam = await page.evaluate(async (id) => {
  const { engine, state } = window.cuepad;
  const tile = state.show.tiles.find((t) => t.id === id);
  const prep = engine.preps.get(id);
  const bytes = await (await import('./js/db.js')).trackBytes(tile.trackId);
  const full = await engine.ctx.decodeAudioData(bytes);
  const sr = full.sampleRate;
  const secs = 20;
  const render = async (build) => {
    const oc = new OfflineAudioContext(2, sr * secs, sr);
    build(oc);
    return (await oc.startRendering()).getChannelData(0);
  };
  const ref = await render((oc) => { const s = oc.createBufferSource(); s.buffer = full; s.connect(oc.destination); s.start(0); });
  const joined = await render((oc) => {
    const h = oc.createBufferSource(); h.buffer = prep.head; h.connect(oc.destination); h.start(0);
    const t = oc.createBufferSource(); t.buffer = full; t.connect(oc.destination);
    t.start(prep.headFrames / sr, (prep.startFrame + prep.headFrames) / sr);
  });
  let maxDiff = 0;
  for (let i = 0; i < ref.length; i++) maxDiff = Math.max(maxDiff, Math.abs(ref[i] - joined[i]));
  return { maxDiff, headSeconds: prep.headFrames / sr };
}, ids[1]);
check(seam.maxDiff < 1e-4, `head/tail join is seamless (max sample diff ${seam.maxDiff.toExponential(2)}, head ${seam.headSeconds}s)`);

// Volume persists and the logo loads
check(await page.evaluate(() => document.querySelector('#logo').naturalWidth > 0), 'church logo shows in the header');
await page.evaluate(() => window.cuepad.setVolume(0.7));
await page.waitForTimeout(600);

// Persistence: reload keeps the show and reloads audio.
await page.reload();
await page.waitForFunction(() => window.cuepad && window.cuepad.state.show && window.cuepad.state.show.tiles.length === 3);
await page.waitForFunction(() => window.cuepad.state.show.tiles.every((t) => window.cuepad.engine.prepStatus(t.id) === 'ready'), null, { timeout: 30000 });
check(true, 'show and audio survive a reload');
check(await page.textContent('.vol-value') === '70%', 'master volume is remembered after a reload');

// Backup round trip
const roundTrip = await page.evaluate(async () => {
  const backup = await import('./js/backup.js');
  const blob = await backup.exportShow(window.cuepad.state.show);
  const show = await backup.importShow(new File([blob], 'x.cuepad'), 'imported-show');
  return { size: blob.size, tiles: show.tiles.length };
});
check(roundTrip.tiles === 3 && roundTrip.size > 2e6, `backup export/import round trip (${(roundTrip.size / 1e6).toFixed(1)} MB)`);

check(errors.length === 0, `no page errors ${errors.length ? JSON.stringify(errors) : ''}`);
await browser.close();
srv.close();
process.exit(failures ? 1 : 0);
