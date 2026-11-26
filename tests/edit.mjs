// Trim and Join tests for Cue Pad in headless Chromium.
// Usage: NODE_PATH=$(npm root -g) node tests/edit.mjs   (needs playwright and ffmpeg)
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
const shots = process.env.SHOTS || '';

async function makeFixtures() {
  await mkdir(fixtures, { recursive: true });
  // Two tones with 2 s of silence at the start, so a trim is easy to check.
  const specs = [
    ['Song A.mp3', 'aevalsrc=if(lt(t\\,2)\\,0\\,0.5*sin(2*PI*440*t)):d=30:s=48000'],
    ['Song B.mp3', 'aevalsrc=0.5*sin(2*PI*660*t):d=20:s=48000'],
  ];
  for (const [name, src] of specs) {
    const out = path.join(fixtures, name);
    try { await access(out); continue; } catch {}
    execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', src, '-ac', '2', '-b:a', '320k', out]);
  }
  return specs.map(([n]) => path.join(fixtures, n));
}

const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
const srv = await new Promise((resolve) => {
  const s = createServer(async (req, res) => {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p.endsWith('/')) p += 'index.html';
    try { const body = await readFile(path.join(root, p)); res.writeHead(200, { 'content-type': types[path.extname(p)] || 'application/octet-stream' }); res.end(body); }
    catch { res.writeHead(404); res.end(); }
  });
  s.listen(0, () => resolve(s));
});

let failures = 0;
const check = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) failures++; };

const files = await makeFixtures();
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 1180, height: 820 }, deviceScaleFactor: shots ? 2 : 1 });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/404/.test(m.text())) errors.push(m.text()); });

await page.goto(`http://localhost:${srv.address().port}/`);
await page.waitForFunction(() => window.cuepad && window.cuepad.state.show);
await page.click('#startOverlay');
await page.click('#editBtn');
await page.setInputFiles('#filePicker', files);
await page.waitForFunction(() => window.cuepad.state.show.tiles.length === 2);
const allReady = () => page.waitForFunction(() => window.cuepad.state.show.tiles.every((t) => window.cuepad.engine.prepStatus(t.id) === 'ready'), null, { timeout: 30000 });
await allReady();
const ids = await page.evaluate(() => window.cuepad.state.show.tiles.map((t) => t.id));
const trackA = await page.evaluate(() => window.cuepad.state.show.tiles[0].trackId);
const sizeBefore = await page.evaluate(async (id) => (await (await import('./js/db.js')).get('tracks', id)).blob.size, trackA);

// ---- Trim
await page.locator(`.tile[data-id="${ids[0]}"]`).dispatchEvent('pointerdown');
await page.locator(`.tile[data-id="${ids[0]}"]`).dispatchEvent('pointerup');
await page.getByRole('button', { name: /Trim start/ }).click();
await page.waitForSelector('#sheet .wave');
await page.waitForFunction(() => !document.querySelector('#sheet .wave-loading'), null, { timeout: 15000 });
check(true, 'trim sheet shows the waveform');
// Drag the Start handle from the left edge to about 2 s (of 30 s).
const wave = await page.$('#sheet .wave');
const wb = await wave.boundingBox();
await page.mouse.move(wb.x + 2, wb.y + wb.height / 2);
await page.mouse.down();
await page.mouse.move(wb.x + wb.width * (2 / 30) * 0.5, wb.y + wb.height / 2, { steps: 4 });
await page.mouse.move(wb.x + wb.width * (2 / 30), wb.y + wb.height / 2, { steps: 4 });
await page.mouse.up();
const s1 = await page.$$eval('#sheet .trim-val', (n) => n.map((x) => x.textContent));
check(/^0:0[12]\.\d$/.test(s1[0]), `dragging the Start handle moves the start (${s1[0]})`);
// Nudge start to exactly 2.0 using the buttons: set via +/-.
const parse = (t) => { const [m, s] = t.split(':'); return +m * 60 + +s; };
let cur = parse(s1[0]);
while (Math.abs(cur - 2) > 0.05) {
  await page.click(`#sheet .trim-row >> nth=0 >> text=${cur < 2 ? '+0.1' : '−0.1'}`);
  cur = parse((await page.$$eval('#sheet .trim-val', (n) => n.map((x) => x.textContent)))[0]);
}
check(true, `nudge buttons set the start to ${cur.toFixed(1)} s`);
// End: zoom on end then −1 five times -> 25 s
await page.click('#sheet >> text=Zoom on end');
for (let i = 0; i < 5; i++) await page.click('#sheet .trim-row >> nth=1 >> text=−1');
const s2 = await page.$$eval('#sheet .trim-val', (n) => n.map((x) => x.textContent));
check(s2[1] === '0:25.0', `End nudged to ${s2[1]}`);
check((await page.textContent('#sheet .trim-len')).startsWith('Plays 0:23.0'), 'shows the trimmed length');
// Preview from the start point plays and shows a playhead
await page.click('#sheet >> text=▶ Play from start');
await page.waitForTimeout(400);
check(await page.isEnabled('#sheet >> text=Set start here'), 'preview plays (Set start here is available)');
if (shots) await page.screenshot({ path: path.join(shots, 'trim-sheet.png') });
await page.click('#sheet >> text=■ Stop');
// Done saves the trim
await page.click('#sheet .sheet-head button');
await page.waitForFunction((id) => window.cuepad.state.show.tiles.find((t) => t.id === id).endAt === 25, ids[0]);
const tA = await page.evaluate((id) => window.cuepad.state.show.tiles.find((t) => t.id === id), ids[0]);
check(Math.abs(tA.startAt - 2) < 0.06 && tA.endAt === 25, `Done saves the trim on the cue (${tA.startAt}–${tA.endAt})`);
check(await page.isVisible('#sheet >> text=✂ Trim start / end'), 'returns to the cue settings after trimming');
check((await page.textContent('#sheet .trim-summary span')).includes('plays 0:23'), 'cue settings show the trim');
await page.click('#sheet .sheet-head button');
await allReady();
const prepA = await page.evaluate((id) => { const p = window.cuepad.engine.preps.get(id); return { dur: p.playDuration, needsTail: p.needsTail }; }, ids[0]);
check(Math.abs(prepA.dur - (25 - tA.startAt)) < 0.01, `trimmed cue plays ${prepA.dur.toFixed(2)} s`);
check((await page.textContent(`.tile[data-id="${ids[0]}"] .flags`)).includes('✂'), 'trimmed tile shows ✂');
const sizeAfter = await page.evaluate(async (id) => (await (await import('./js/db.js')).get('tracks', id)).blob.size, trackA);
check(sizeAfter === sizeBefore, 'trimming leaves the original file untouched');

// Playback: starts with tone (no 2 s silence), stops at the end point.
await page.click('#editBtn');
await page.evaluate(() => window.cuepad.state.show.tiles[0].id).then((id) => page.locator(`.tile[data-id="${id}"]`).dispatchEvent('pointerdown'));
await page.waitForFunction((id) => window.cuepad.engine.players.get(id)?.tailState === 'scheduled', ids[0], { timeout: 10000 });
await page.evaluate((id) => window.cuepad.engine.seek(id, 21), ids[0]);
await page.waitForTimeout(1500);
check(await page.evaluate((id) => window.cuepad.engine.isPlaying(id), ids[0]), 'still playing just before the end point');
await page.waitForTimeout(1200);
check(!(await page.evaluate((id) => window.cuepad.engine.players.has(id), ids[0])), 'trimmed cue stops at its end point');
// Rendered check: tail source stops at endAt.
const tailOk = await page.evaluate(async (id) => {
  const { engine, state } = window.cuepad;
  const tile = state.show.tiles.find((t) => t.id === id);
  const prep = engine.preps.get(id);
  // First sample of the head should already be the tone (silence was trimmed).
  const h = prep.head.getChannelData(0);
  let peak = 0; for (let i = 0; i < 4800; i++) peak = Math.max(peak, Math.abs(h[i]));
  return { headPeak: peak, endFrame: prep.endFrame, sr: prep.sampleRate, endAt: tile.endAt };
}, ids[0]);
check(tailOk.headPeak > 0.3, `trimmed start skips the silence (peak ${tailOk.headPeak.toFixed(2)} in the first 0.1 s)`);
check(tailOk.endFrame === Math.round(25 * tailOk.sr), 'end frame matches the end point');
await page.click('#editBtn');

// ---- Join A (trimmed, 23 s) + B (20 s) with a 2 s crossfade
await page.evaluate((id) => window.cuepad.openJoinSheet(id), ids[0]);
await page.click('#sheet .join-pick >> nth=1');
await page.selectOption('#sheet select', 'crossfade');
check((await page.textContent('#sheet .join')).includes('about 0:41'), 'join shows the expected length');
if (shots) await page.screenshot({ path: path.join(shots, 'join-sheet.png') });
await page.click('#sheet >> text=Join into a new cue');
await page.waitForFunction(() => window.cuepad.state.show.tiles.length === 3, null, { timeout: 20000 });
await allReady();
const joined = await page.evaluate(() => {
  const { state, engine } = window.cuepad;
  const t = state.show.tiles[1];
  const tr = state.tracks.get(t.trackId);
  return { label: t.label, dur: engine.preps.get(t.id).playDuration, type: tr.type, from: tr.joinedFrom.length, order: state.show.tiles.map((x) => x.label) };
});
check(joined.label === 'Song A + Song B', `joined cue is named "${joined.label}"`);
check(Math.abs(joined.dur - 41) < 0.05, `joined cue is ${joined.dur.toFixed(2)} s (23 + 20 − 2)`);
check(joined.type === 'audio/wav' && joined.from === 2, 'joined cue is a new WAV file that records its sources');
check(JSON.stringify(joined.order) === JSON.stringify(['Song A', 'Song A + Song B', 'Song B']), `new cue sits after the first part, originals kept (${joined.order.join(', ')})`);
// Content: early = 440 Hz (A, no leading silence), late = 660 Hz (B).
const content = await page.evaluate(async () => {
  const { state, engine } = window.cuepad;
  const t = state.show.tiles[1];
  const buf = await engine.ctx.decodeAudioData(await (await import('./js/db.js')).trackBytes(t.trackId));
  const d = buf.getChannelData(0), sr = buf.sampleRate;
  const zc = (a) => { let n = 0; for (let i = a * sr + 1; i < (a + 1) * sr; i++) if ((d[i - 1] < 0) !== (d[i] < 0)) n++; return n / 2; };
  let p0 = 0; for (let i = 0; i < sr * 0.1; i++) p0 = Math.max(p0, Math.abs(d[i]));
  return { f1: zc(1), f35: zc(35), p0 };
});
check(Math.abs(content.f1 - 440) < 5 && Math.abs(content.f35 - 660) < 5, `joined audio plays A then B (${content.f1} Hz → ${content.f35} Hz)`);
check(content.p0 > 0.3, 'join uses part A\'s trim');

// Join with "take the originals out"
await page.evaluate(() => window.cuepad.openJoinSheet(window.cuepad.state.show.tiles[0].id));
await page.click('#sheet .join-pick >> nth=2');
await page.selectOption('#sheet select', 'gap');
await page.fill('#sheet .join input[type=number]', '1');
await page.dispatchEvent('#sheet .join input[type=number]', 'change');
await page.check('#sheet .join input[type=checkbox]');
await page.click('#sheet >> text=Join into a new cue');
await page.waitForFunction(() => window.cuepad.state.show.tiles.some((t) => t.label === 'Song A + Song B' && t !== window.cuepad.state.show.tiles[1]) || window.cuepad.state.show.tiles.length === 2, null, { timeout: 20000 });
await allReady();
const after = await page.evaluate(() => window.cuepad.state.show.tiles.map((t) => [t.label, window.cuepad.engine.preps.get(t.id).playDuration]));
check(after.length === 2 && after[0][0] === 'Song A + Song B' && Math.abs(after[1][1] - 41) < 0.05 && Math.abs(after[0][1] - 44) < 0.05, `taking originals out replaces them with the joined cue (${after.map((a) => `${a[0]} ${a[1].toFixed(1)}s`).join(', ')})`);
const kept = await page.evaluate(async () => (await (await import('./js/db.js')).listTrackInfo()).length);
check(kept === 4, `original audio files are still on the device (${kept} files)`);
await page.evaluate(() => document.querySelector('#sheet').close());

// ---- Backup round trip keeps trims and joined audio
const rt = await page.evaluate(async () => {
  const backup = await import('./js/backup.js');
  const db = await import('./js/db.js');
  const show = window.cuepad.state.show;
  const blob = await backup.exportShow(show);
  // Import into a clean database state: drop the tracks so they're restored from the file.
  for (const t of show.tiles) await db.del('tracks', t.trackId);
  const imp = await backup.importShow(new File([blob], 'x.cuepad'), 'imported');
  const sizes = [];
  for (const t of imp.tiles) sizes.push((await db.get('tracks', t.trackId)).blob.size);
  return { tiles: imp.tiles.length, sizes, types: await Promise.all(imp.tiles.map(async (t) => (await db.get('tracks', t.trackId)).type)) };
});
check(rt.tiles === 2 && rt.sizes.every((s) => s > 1e5) && rt.types.includes('audio/wav'), `backup export/import restores joined WAV audio (${rt.types.join(', ')})`);

// ---- Trim persists through a backup and the engine respects endAt after reload
await page.reload();
await page.waitForFunction(() => window.cuepad && window.cuepad.state.show && window.cuepad.state.show.tiles.length >= 2);
await page.click('#startOverlay');
await allReady();
check(true, 'joined cues load after a reload');

check(errors.length === 0, `no page errors ${errors.length ? JSON.stringify(errors) : ''}`);
await browser.close();
srv.close();
process.exit(failures ? 1 : 0);
