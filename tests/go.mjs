// GO running-order test: GO button, next-cue pointer, skip/back, keys, persistence.
// Usage: node tests/go.mjs   (needs playwright and ffmpeg; run smoke.mjs once first or let this make fixtures)
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

await mkdir(fixtures, { recursive: true });
const specs = [
  ['Short Sting.mp3', 'sine=frequency=440:duration=4'],
  ['Shepherds_Dance.mp3', 'sine=frequency=330:duration=40'],
  ['Drama BGM.mp3', 'anoisesrc=d=25:c=pink:a=0.2'],
];
for (const [name, src] of specs) {
  const out = path.join(fixtures, name);
  try { await access(out); } catch { execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', src, '-ac', '2', '-b:a', '320k', out]); }
}
const files = specs.map(([n]) => path.join(fixtures, n));

const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const srv = await new Promise((resolve) => {
  const s = createServer(async (req, res) => {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p.endsWith('/')) p += 'index.html';
    try { const b = await readFile(path.join(root, p)); res.writeHead(200, { 'content-type': types[path.extname(p)] || 'application/octet-stream' }); res.end(b); }
    catch { res.writeHead(404); res.end(); }
  });
  s.listen(0, () => resolve(s));
});
const url = `http://localhost:${srv.address().port}/`;

let failures = 0;
const check = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) failures++; };

const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 1180, height: 820 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

const nextIdx = () => page.evaluate(() => window.cuepad.nextIndex());
const nextText = () => page.textContent('#nextName');
const playing = () => page.evaluate(() => window.cuepad.state.show.tiles.map((t) => window.cuepad.engine.isPlaying(t.id)));
const goBtn = () => page.locator('#goBtn').dispatchEvent('pointerdown');
const wait = (ms) => page.waitForTimeout(ms);

await page.goto(url);
await page.waitForFunction(() => window.cuepad && window.cuepad.state.show);
check(await nextText() === 'No cues' && await page.isDisabled('#goBtn'), 'empty show: GO disabled, says No cues');
await page.click('#startOverlay');
await page.click('#editBtn');
await page.setInputFiles('#filePicker', files);
await page.waitForFunction(() => window.cuepad.state.show.tiles.length === 3);
await page.waitForFunction(() => window.cuepad.state.show.tiles.every((t) => window.cuepad.engine.prepStatus(t.id) === 'ready'), null, { timeout: 30000 });
await page.click('#editBtn');
const ids = await page.evaluate(() => window.cuepad.state.show.tiles.map((t) => t.id));

check(await nextIdx() === 0 && await nextText() === '1. Short Sting', `next starts at cue 1 after adding tracks (${await nextText()})`);
check(await page.locator(`.tile[data-id="${ids[0]}"]`).evaluate((n) => n.classList.contains('next')), 'cue 1 tile is highlighted as next');

await goBtn();
check(JSON.stringify(await playing()) === '[true,false,false]' && await nextIdx() === 1, 'GO plays cue 1 and moves next to cue 2');
await goBtn();
check(await nextIdx() === 1 && !(await playing())[1], 'a second GO within 400 ms is ignored');
await wait(450);
await goBtn();
await wait(100);
check(JSON.stringify(await playing()) === '[false,true,false]' && await nextIdx() === 2, 'GO plays cue 2, fades cue 1, next is cue 3');

await page.click('#prevCue');
check(await nextIdx() === 1, 'back button moves next to cue 2');
await page.click('#skipCue');
check(await nextIdx() === 2, 'skip button moves next to cue 3');

await page.locator(`.tile[data-id="${ids[0]}"]`).dispatchEvent('pointerdown');
check(await nextIdx() === 1, 'tapping cue 1 directly moves next to cue 2');

await page.evaluate((id) => { window.cuepad.state.show.tiles.find((t) => t.id === id).layer = true; }, ids[2]);
await page.locator(`.tile[data-id="${ids[2]}"]`).dispatchEvent('pointerdown');
check(await nextIdx() === 1 && (await playing())[2], 'a "play over" sting tapped directly leaves next alone');
await page.evaluate((id) => { window.cuepad.state.show.tiles.find((t) => t.id === id).layer = false; }, ids[2]);
await page.locator('#stopAll').dispatchEvent('pointerdown');

await wait(450);
await page.keyboard.press('Space');
check((await playing())[1] && await nextIdx() === 2, 'Space key works as GO');
await page.keyboard.press('ArrowLeft');
check(await nextIdx() === 1, 'Left arrow moves next back');
await page.keyboard.press('ArrowRight');
check(await nextIdx() === 1, 'a second key press within 400 ms is ignored');
await wait(450);
await page.keyboard.press('ArrowRight');
await wait(100);
check(await nextIdx() === 2 && (await playing())[1], 'GO on a cue that is already playing leaves it playing and moves on');
await wait(450);
await page.keyboard.press('PageDown');
check((await playing())[2] && await nextIdx() === 3, 'Page Down (pedal) plays cue 3');
check(await nextText() === 'End of show' && await page.isDisabled('#goBtn'), 'after the last cue GO is disabled and says End of show');
await page.screenshot({ path: path.join(fixtures, 'screenshot-go.png') });

await page.locator('#stopAll').dispatchEvent('pointerdown');
await page.reload();
await page.waitForFunction(() => window.cuepad && window.cuepad.state.show && window.cuepad.state.show.tiles.length === 3);
check(await nextIdx() === 3, 'next cue position survives a reload');

await page.click('#startOverlay');
await page.click('#showBtn');
await page.getByRole('button', { name: 'Start again from cue 1' }).click();
check(await nextIdx() === 0 && await nextText() === '1. Short Sting', 'Shows → Start again from cue 1 resets GO');

await page.click('#editBtn');
await page.locator(`.tile[data-id="${ids[1]}"]`).click();
await page.getByRole('button', { name: 'Make this the next cue for GO' }).click();
await page.click('#sheet .sheet-head button');
await page.click('#editBtn');
check(await nextIdx() === 1, 'cue editor can make a cue the next one');

// Deleting the next cue moves next to the cue that followed it.
await page.click('#editBtn');
page.once('dialog', (d) => d.accept());
await page.locator(`.tile[data-id="${ids[1]}"]`).click();
await page.getByRole('button', { name: 'Delete cue' }).click();
await page.waitForFunction(() => window.cuepad.state.show.tiles.length === 2);
await page.click('#editBtn');
check(await nextText() === '2. Drama BGM', `deleting the next cue points GO at the following cue (${await nextText()})`);

check(errors.length === 0, `no page errors ${errors.length ? JSON.stringify(errors) : ''}`);
await browser.close();
srv.close();
process.exit(failures ? 1 : 0);
