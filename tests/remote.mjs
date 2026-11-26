// Remote pairing test: main iPad page + remote page in headless Chromium.
// The QR codes are decoded from the rendered SVGs with jsQR, so the whole
// path (offer QR -> remote page -> answer QR -> host) is exercised.
// Usage: node tests/remote.mjs   (needs playwright and ffmpeg)
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
const track = path.join(fixtures, 'Shepherds_Dance.mp3');
try { await access(track); } catch {
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=40', '-ac', '2', '-b:a', '320k', track]);
}

const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
const srv = await new Promise((resolve) => {
  const s = createServer(async (req, res) => {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p.endsWith('/')) p += 'index.html';
    try { const b = await readFile(path.join(root, p)); res.writeHead(200, { 'content-type': types[path.extname(p)] || 'application/octet-stream' }); res.end(b); }
    catch { res.writeHead(404); res.end(); }
  });
  s.listen(0, () => resolve(s));
});
const base = `http://localhost:${srv.address().port}/`;

let failures = 0;
const check = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) failures++; };

const browser = await chromium.launch({
  args: ['--autoplay-policy=no-user-gesture-required', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
});
const ctxHost = await browser.newContext({ viewport: { width: 1180, height: 820 }, permissions: ['camera'] });
const ctxRemote = await browser.newContext({ viewport: { width: 390, height: 844 } });
const host = await ctxHost.newPage();
const remote = await ctxRemote.newPage();
const errors = [];
for (const [name, p] of [['host', host], ['remote', remote]]) {
  p.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
}

// Decode the QR SVG inside a page with jsQR.
const decodeQr = (page, selector) => page.evaluate(async (sel) => {
  if (!window.jsQR) await new Promise((r) => { const s = document.createElement('script'); s.src = 'vendor/jsQR.js'; s.onload = r; document.head.append(s); });
  const svg = document.querySelector(sel);
  const img = new Image();
  img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg.outerHTML);
  await img.decode();
  const c = document.createElement('canvas');
  c.width = 800; c.height = 800;
  const g = c.getContext('2d');
  g.imageSmoothingEnabled = false;
  g.drawImage(img, 0, 0, 800, 800);
  const d = g.getImageData(0, 0, 800, 800);
  const code = window.jsQR(d.data, 800, 800);
  return code ? code.data : null;
}, selector);

await host.goto(base);
await host.waitForFunction(() => window.cuepad && window.cuepad.state.show);
await host.click('#startOverlay');
await host.setInputFiles('#filePicker', [track]);
await host.waitForFunction(() => window.cuepad.state.show.tiles.length === 1 && window.cuepad.engine.prepStatus(window.cuepad.state.show.tiles[0].id) === 'ready');

await host.click('#remoteBtn');
await host.waitForSelector('.qr-box svg', { timeout: 15000 });
const offerUrl = await decodeQr(host, '.qr-box svg');
check(!!offerUrl && offerUrl.startsWith(base + '#pair='), `host QR decodes to a pairing link (${offerUrl ? offerUrl.length : 0} chars)`);

await remote.goto(offerUrl);
await remote.waitForSelector('.remote-pair .qr-box svg', { timeout: 15000 });
const answer = await decodeQr(remote, '.remote-pair .qr-box svg');
check(!!answer && answer.startsWith('CPA1:'), `remote QR decodes to an answer code (${answer ? answer.length : 0} chars)`);

check(await host.evaluate((a) => window.cuepad.pairWithCode(a), answer), 'host accepts the remote code');
await remote.waitForFunction(() => document.querySelectorAll('.tile').length === 1, null, { timeout: 15000 });
check(true, 'remote shows the main iPad\'s tiles');
check(await host.evaluate(() => window.cuepad.remoteCount()) === 1, 'host counts one connected remote');
await host.waitForFunction(() => !document.querySelector('#sheet').open, null, { timeout: 5000 }).catch(() => {});
check(!(await host.evaluate(() => document.querySelector('#sheet').open)), 'pairing sheet closes once connected');

// Tap on remote -> plays on host
const tileId = await host.evaluate(() => window.cuepad.state.show.tiles[0].id);
await remote.locator('.tile').dispatchEvent('pointerdown');
await host.waitForFunction((id) => window.cuepad.engine.isPlaying(id), tileId, { timeout: 3000 });
check(true, 'tap on remote starts the cue on the main iPad');
await remote.waitForFunction(() => document.querySelector('.tile').classList.contains('playing'), null, { timeout: 3000 });
check(true, 'remote shows the cue as playing');
await remote.waitForTimeout(1200);
const info = await remote.textContent('.tile .info');
check(/^−0:3\d$/.test(info), `remote shows time left (${info})`);
await remote.screenshot({ path: path.join(fixtures, 'remote-playing.png') });

// Volume: a tap must not change it, a drag on the remote changes the main iPad
const vbox = await remote.locator('.vol-track').boundingBox();
await remote.mouse.click(vbox.x + vbox.width / 2, vbox.y + vbox.height * 0.8);
await remote.waitForTimeout(300);
check(await host.evaluate(() => window.cuepad.getVolume()) === 1, 'tapping the volume rail does not jump the volume');
await remote.mouse.move(vbox.x + vbox.width / 2, vbox.y + 20);
await remote.mouse.down();
await remote.mouse.move(vbox.x + vbox.width / 2, vbox.y + 20 + vbox.height * 0.4, { steps: 8 });
await remote.mouse.up();
await host.waitForFunction(() => Math.abs(window.cuepad.getVolume() - 0.6) < 0.05, null, { timeout: 3000 }).catch(() => {});
const hv = await host.evaluate(() => window.cuepad.getVolume());
check(Math.abs(hv - 0.6) < 0.05, `dragging the remote's volume sets the main iPad to ${Math.round(hv * 100)}%`);
await host.waitForTimeout(200);
const hostLabel = await host.textContent('.vol-value');
check(hostLabel === `${Math.round(hv * 100)}%`, `main iPad's slider follows the remote (${hostLabel})`);
const gain = await host.evaluate(() => window.cuepad.engine.master.gain.value);
check(Math.abs(gain - hv * hv) < 0.02, `master gain applied (${gain.toFixed(2)})`);
await host.evaluate(() => window.cuepad.setVolume(0.9));
await remote.waitForFunction(() => document.querySelector('.vol-value').textContent === '90%', null, { timeout: 3000 }).catch(() => {});
check(await remote.textContent('.vol-value') === '90%', 'remote slider follows the main iPad');

await remote.locator('#pauseAll').dispatchEvent('pointerdown');
await host.waitForFunction((id) => window.cuepad.engine.isPaused(id), tileId, { timeout: 3000 });
check(true, 'Pause on remote pauses the main iPad');
await remote.locator('.tp-skip[data-d="10"]').dispatchEvent('pointerdown');
await host.waitForFunction((id) => window.cuepad.engine.position(id).pos > 9, tileId, { timeout: 3000 }).catch(() => {});
check(await host.evaluate((id) => window.cuepad.engine.position(id).pos > 9, tileId), '+10s on remote moves the main iPad\'s cue');
await remote.click('.tp-fade');
await host.waitForFunction(() => window.cuepad.state.fadeMode === true, null, { timeout: 3000 }).catch(() => {});
check(await host.evaluate(() => window.cuepad.state.fadeMode === true), 'Fade switch on remote turns fades on for the main iPad');
await remote.waitForFunction(() => document.querySelector('.tp-fade').textContent === 'Fade: On', null, { timeout: 3000 }).catch(() => {});
check(await remote.textContent('.tp-fade') === 'Fade: On', 'remote Fade switch shows the main iPad\'s setting');
await host.evaluate(() => window.cuepad.setFadeMode(false));
await remote.waitForFunction(() => document.querySelector('#pauseAll').dataset.state === 'resume', null, { timeout: 3000 });
check(true, 'remote Pause button turns into Resume');
await remote.locator('#pauseAll').dispatchEvent('pointerdown');
await host.waitForFunction((id) => window.cuepad.engine.isPlaying(id), tileId, { timeout: 3000 });
check(true, 'Resume on remote resumes the main iPad');

await remote.locator('#stopAll').dispatchEvent('pointerdown');
await host.waitForFunction(() => window.cuepad.engine.players.size === 0, null, { timeout: 3000 });
check(true, 'Stop all on remote stops the main iPad');

// Running order from the remote (the tap above moved next past the only cue)
check(await remote.textContent('#nextName') === 'End of show', `remote shows the next cue (${await remote.textContent('#nextName')})`);
await remote.click('#prevCue');
await host.waitForFunction(() => window.cuepad.nextIndex() === 0, null, { timeout: 3000 });
await remote.waitForFunction(() => document.querySelector('#nextName').textContent === '1. Shepherds Dance', null, { timeout: 3000 });
check(true, 'back button on remote moves the main iPad\'s next cue');
await remote.locator('#goBtn').dispatchEvent('pointerdown');
await host.waitForFunction((id) => window.cuepad.engine.isPlaying(id), tileId, { timeout: 3000 });
await remote.waitForFunction(() => document.querySelector('#nextName').textContent === 'End of show', null, { timeout: 3000 });
check(true, 'GO on remote plays the next cue on the main iPad and moves next along');
await remote.screenshot({ path: path.join(fixtures, 'remote-go.png') });
await remote.locator('#stopAll').dispatchEvent('pointerdown');
await host.waitForFunction(() => window.cuepad.engine.players.size === 0, null, { timeout: 3000 });

// In from the remote with nothing playing arms a fade-in for the next tile tapped
await remote.waitForFunction(() => !document.querySelector('#fadeInBtn').disabled, null, { timeout: 3000 });
await remote.locator('#fadeInBtn').dispatchEvent('pointerdown');
await host.waitForFunction(() => window.cuepad.state.fadeArmed, null, { timeout: 3000 });
await remote.waitForFunction(() => document.querySelector('#fadeInBtn').getAttribute('aria-pressed') === 'true', null, { timeout: 3000 });
check(await host.evaluate(() => window.cuepad.engine.players.size === 0), 'In on the remote arms the fade without starting anything');
await remote.waitForTimeout(150);
await remote.screenshot({ path: path.join(fixtures, 'fade-armed-phone.png') });
await remote.locator('.tile').dispatchEvent('pointerdown');
await host.waitForFunction((id) => window.cuepad.engine.isPlaying(id), tileId, { timeout: 3000 });
await host.waitForTimeout(300);
const rg = await host.evaluate((id) => window.cuepad.engine.players.get(id).gain.gain.value, tileId);
check(rg < 0.5 && !(await host.evaluate(() => window.cuepad.state.fadeArmed)), `tile tapped on the remote fades in (level ${rg.toFixed(2)} at 0.3 s)`);
await remote.locator('#stopAll').dispatchEvent('pointerdown');
await host.waitForFunction(() => window.cuepad.engine.players.size === 0, null, { timeout: 3000 });

// Reconnect without scanning: the remote saves a standby from the main iPad
await remote.waitForFunction(() => window.cuepadRemote.pairing && window.cuepadRemote.pairing.offer, null, { timeout: 8000 }).catch(() => {});
check(await remote.evaluate(() => !!(window.cuepadRemote.pairing && window.cuepadRemote.pairing.offer)), 'remote has a standby link ready for reconnecting');
check(await host.evaluate(() => window.cuepad.pairedCount()) === 1, 'main iPad remembers the paired remote');

const tapAndCheck = async (label) => {
  await remote.waitForFunction(() => window.cuepadRemote?.link && window.cuepadRemote.link.state === 'open' && document.querySelectorAll('.tile').length === 1, null, { timeout: 20000 });
  await remote.locator('.tile').dispatchEvent('pointerdown');
  const ok = await host.waitForFunction((id) => window.cuepad.engine.isPlaying(id), tileId, { timeout: 3000 }).then(() => true, () => false);
  check(ok, label);
  await remote.locator('#stopAll').dispatchEvent('pointerdown');
  await host.waitForFunction(() => window.cuepad.engine.players.size === 0, null, { timeout: 3000 });
};

// 1. The link drops (wifi gone, screen locked): it comes back on its own.
const before = await remote.evaluate(() => window.cuepadRemote.link);
await remote.evaluate(() => window.cuepadRemote.link.close());
await tapAndCheck('remote reconnects by itself after the link drops, and taps work');
check(await host.evaluate(() => window.cuepad.remoteCount()) === 1, `host counts one remote after reconnecting (${await host.evaluate(() => window.cuepad.remoteCount())})`);
void before;

// 2. It drops again (each reconnect prepares the next standby).
await remote.waitForFunction(() => window.cuepadRemote.pairing.offer && window.cuepadRemote.link.state === 'open', null, { timeout: 8000 });
await remote.waitForTimeout(1500);
await remote.evaluate(() => window.cuepadRemote.link.close());
await tapAndCheck('remote reconnects a second time');

// 2b. A silent drop: the main iPad still thinks the old link is up when the
// remote comes back on the standby. The old one must be replaced, not doubled.
await remote.waitForFunction(() => window.cuepadRemote.pairing.offer && window.cuepadRemote.link.state === 'open', null, { timeout: 8000 });
await remote.waitForTimeout(1500);
await remote.evaluate(() => { const l = window.cuepadRemote.link; l.close = () => {}; window.cuepadRemote.reconnect(); });
await tapAndCheck('remote reconnects while the main iPad still holds the old link');
await host.waitForTimeout(300);
check(await host.evaluate(() => window.cuepad.remoteCount()) === 1, `old link is replaced, not counted twice (${await host.evaluate(() => window.cuepad.remoteCount())})`);

// 3. The browser reloads the remote page: still no scanning needed.
await remote.waitForTimeout(1500);
await remote.reload();
await tapAndCheck('remote reconnects by itself after its page reloads');
check(await host.evaluate(() => window.cuepad.remoteCount()) === 1, 'host still counts one remote');
await remote.screenshot({ path: path.join(fixtures, 'remote-reconnected.png') });

// Adding tracks from the remote: the file travels over the same link
const sendPath = path.join(fixtures, 'Remote Upload.mp3');
try { await access(sendPath); } catch { execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=550:duration=120', '-ac', '2', '-b:a', '320k', sendPath]); }
const sendSize = (await import('node:fs')).statSync(sendPath).size;
await remote.waitForFunction(() => !document.querySelector('#remoteAddBtn').hidden, null, { timeout: 5000 });
check(true, 'remote shows + Add tracks once connected');
const t0 = Date.now();
await remote.setInputFiles('#filePicker', [sendPath]);
await host.waitForFunction(() => window.cuepad.state.show.tiles.length === 2, null, { timeout: 30000 }).catch(() => {});
const got = await host.evaluate(async () => {
  const { state } = window.cuepad;
  const t = state.show.tiles[1];
  if (!t) return null;
  const bytes = await (await import('./js/db.js')).trackBytes(t.trackId);
  return { label: t.label, size: bytes.byteLength };
});
check(got && got.label === 'Remote Upload' && got.size === sendSize, `track sent from the remote is saved on the main iPad, byte for byte (${got && got.size} of ${sendSize} bytes, ${((Date.now() - t0) / 1000).toFixed(1)} s)`);
await host.waitForFunction(() => { const t = window.cuepad.state.show.tiles[1]; return t && window.cuepad.engine.prepStatus(t.id) === 'ready'; }, null, { timeout: 15000 }).catch(() => {});
check(await host.evaluate(() => window.cuepad.engine.prepStatus(window.cuepad.state.show.tiles[1].id)) === 'ready', 'the new cue is loaded and ready to play');
await remote.waitForFunction(() => document.querySelectorAll('.tile').length === 2, null, { timeout: 5000 }).catch(() => {});
check(await remote.evaluate(() => document.querySelectorAll('.tile').length) === 2, 'the new tile appears on the remote');
await remote.waitForFunction(() => document.querySelector('#banner').textContent.includes('Added 1 track'), null, { timeout: 5000 }).catch(() => {});
check(await remote.evaluate(() => document.querySelector('#banner').textContent.includes('Added 1 track')), 'remote says the track was added');
check(!(await host.evaluate(() => document.querySelector('#sheet').open)) && await host.isHidden('#banner'), 'nothing pops up on the main iPad');
await remote.screenshot({ path: path.join(fixtures, 'remote-added.png') });
await remote.setInputFiles('#filePicker', [{ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') }]);
await remote.waitForTimeout(300);
check((await remote.textContent('#banner')).includes('aren\'t audio') && await host.evaluate(() => window.cuepad.state.show.tiles.length) === 2, 'non-audio files are refused');

// 4. Forget on the main iPad: the remote is told and stops trying.
await host.evaluate(() => window.cuepad.disconnectAll());
await remote.waitForFunction(() => document.body.textContent.includes('disconnected this remote'), null, { timeout: 5000 }).catch(() => {});
check(await remote.evaluate(() => document.body.textContent.includes('disconnected this remote') && !window.cuepadRemote.pairing), 'remote forgets the pairing when the main iPad disconnects it');
check(await host.evaluate(() => window.cuepad.pairedCount()) === 0, 'main iPad forgets the remote');

// Host keeps working when the remote goes away
await remote.close();
await host.waitForTimeout(500);
await host.locator('.tile').first().dispatchEvent('pointerdown');
check(await host.evaluate((id) => window.cuepad.engine.isPlaying(id), tileId), 'main iPad still plays after the remote disconnects');

check(errors.length === 0, `no page errors ${errors.length ? JSON.stringify(errors) : ''}`);
await browser.close();
srv.close();
process.exit(failures ? 1 : 0);
