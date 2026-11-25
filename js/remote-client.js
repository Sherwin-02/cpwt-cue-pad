// Remote side: a phone or second iPad that mirrors the main iPad's tiles and
// sends taps to it. It plays no audio itself.
import { createRemoteAnswer, remoteIdentity, standbyAnswer, reconnectToStandby, qrSvg, PAIR_PREFIX } from './pairing.js';
import { createVolumeRail } from './volume.js';
import { renderPauseBtn, squareGrid } from './layout.js';

let volumeRail = null;

const $ = (s) => document.querySelector(s);
const fmt = (sec) => {
  if (sec == null || !isFinite(sec)) return '--:--';
  sec = Math.max(0, Math.round(sec));
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
};

let link = null;
let snap = null;
let snapAt = 0;
let lastMsgAt = 0;
let connected = false;
let identity = null;
let pairing = null; // { from: pairing code it was first paired with, offer: standby to reconnect to }
let retryTimer = null;
let attempt = 0;
let reconnecting = false;

const PAIRING_KEY = 'cuepad.remote.pairing';

function loadPairing() {
  try { return JSON.parse(localStorage.getItem(PAIRING_KEY) || 'null'); } catch { return null; }
}

function savePairing() {
  try {
    if (pairing) localStorage.setItem(PAIRING_KEY, JSON.stringify(pairing));
    else localStorage.removeItem(PAIRING_KEY);
  } catch {}
}

function setStatus(text, warn = false) {
  const s = $('#status');
  s.textContent = '';
  const span = document.createElement('span');
  if (warn) span.className = 'warn';
  span.textContent = text;
  s.append(span);
}

function banner(text) {
  const b = $('#banner');
  b.hidden = !text;
  b.textContent = text || '';
}

// While pairing or waiting there are no tiles yet, so the code (or message)
// gets the whole screen and the tile controls are hidden.
function setPairingView(on) {
  document.body.classList.toggle('remote-pairing', on);
  if (on) renderedKey = '';
}

function showPairing(html, note) {
  setPairingView(true);
  const grid = $('#grid');
  grid.className = 'grid';
  grid.innerHTML = '';
  const card = document.createElement('div');
  card.className = 'remote-pair';
  card.innerHTML = `<h2>Show this to the main iPad</h2><div class="qr-box big">${html}</div><p>Hold this screen up to the main iPad's front camera until it says connected. Turn your brightness up if it doesn't read.</p><p class="muted">${note || ''}</p>`;
  grid.append(card);
}

function showMessage(title, text, { full = true } = {}) {
  if (full) setPairingView(true);
  const grid = $('#grid');
  grid.className = 'grid';
  grid.innerHTML = '';
  const card = document.createElement('div');
  card.className = 'remote-pair';
  const h = document.createElement('h2'); h.textContent = title;
  const p = document.createElement('p'); p.textContent = text;
  card.append(h, p);
  grid.append(card);
}

function layout(count) {
  squareGrid($('#grid'), count, { minSide: window.innerWidth < 500 ? 92 : 110 });
}

let renderedKey = '';
function render() {
  if (!snap) return;
  $('#showName').textContent = snap.showName || 'Show';
  const grid = $('#grid');
  const key = JSON.stringify(snap.tiles.map((t) => [t.id, t.label, t.color]));
  if (key !== renderedKey) {
    renderedKey = key;
    setPairingView(false);
    grid.className = 'grid';
    grid.innerHTML = '';
    for (const t of snap.tiles) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'tile';
      b.dataset.id = t.id;
      b.style.setProperty('--stripe', `var(--stripe-${t.color || 'none'})`);
      b.innerHTML = '<div class="top"><span class="num"></span><span class="flags"></span></div><div class="label"></div><div class="info"></div><div class="progress"></div>';
      b.querySelector('.num').textContent = String(t.n);
      b.querySelector('.flags').textContent = t.loop ? '⟳ loop' : '';
      b.querySelector('.label').textContent = t.label;
      grid.append(b);
    }
    if (!snap.tiles.length) showMessage('No cues yet', 'Add cues on the main iPad and they will appear here.', { full: false });
    layout(snap.tiles.length);
  }
  tick();
}

function tick() {
  if (!snap) return;
  const elapsed = (performance.now() - snapAt) / 1000;
  const parts = [];
  for (const t of snap.tiles) {
    const node = document.querySelector(`.tile[data-id="${t.id}"]`);
    if (!node) continue;
    node.classList.toggle('ready', t.status === 'ready');
    node.classList.toggle('loading', t.status === 'loading' || t.status === 'queued');
    node.classList.toggle('error', t.status === 'error');
    node.classList.toggle('playing', t.playing);
    node.classList.toggle('stopping', t.stopping);
    node.classList.toggle('paused', !!t.paused && !t.stopping);
    let text;
    const bar = node.querySelector('.progress');
    if (t.pos != null) {
      let pos = t.pos + (t.stopping || t.paused ? 0 : elapsed);
      if (t.loop && t.dur) pos %= t.dur;
      pos = Math.min(pos, t.dur || pos);
      text = t.stopping ? 'Fading…' : (t.loop ? `${fmt(pos)} looping` : `−${fmt((t.dur || 0) - pos)}`);
      if (t.paused && !t.stopping) text = `Paused ${text}`;
      bar.style.width = `${Math.min(100, (pos / Math.max(0.1, t.dur || 1)) * 100)}%`;
      if (t.playing || t.paused) parts.push(`${t.n}. ${t.label} ${text}`);
    } else {
      bar.style.width = '0';
      text = t.status === 'ready' ? fmt(t.dur) : t.status === 'error' ? 'Missing audio' : 'Loading…';
    }
    const info = node.querySelector('.info');
    if (info.textContent !== text) info.textContent = text;
  }
  renderNext();
  const now = $('#now');
  const s = parts.length ? parts.join('   ') : 'Nothing playing';
  if (now.textContent !== s) now.textContent = s;
}

function renderNext() {
  const n = snap.next || { id: null, n: 0, label: 'No cues', end: true };
  const text = n.end ? n.label : `${n.n}. ${n.label}`;
  const name = $('#nextName');
  if (name.textContent !== text) name.textContent = text;
  name.classList.toggle('end', !!n.end);
  $('#goBtn').disabled = !!n.end;
  $('#skipCue').disabled = !!n.end;
  $('#prevCue').disabled = !snap.tiles.length || n.n === 1;
  for (const node of document.querySelectorAll('#grid .tile[data-id]')) node.classList.toggle('next', node.dataset.id === n.id);
}

function frame() {
  tick();
  const quiet = performance.now() - lastMsgAt;
  if (connected && quiet > 4000) {
    setStatus('No signal from main iPad', true);
    banner('Lost contact with the main iPad. It keeps playing. Reconnecting…');
    if (quiet > 6000 && !reconnecting) reconnect();
  }
  requestAnimationFrame(frame);
}

function sendCmd(obj, node) {
  if (!link || !link.send(obj)) {
    banner('Not connected to the main iPad. Reconnecting…');
    if (!reconnecting) reconnect();
    return;
  }
  if (node) {
    node.classList.add('pressed');
    setTimeout(() => node.classList.remove('pressed'), 120);
  }
}

// ---------------------------------------------------------------- link handling

function useLink(l) {
  const old = link;
  link = l;
  if (old && old !== l) old.close();
  l.addEventListener('message', (e) => {
    if (l !== link) return;
    const m = e.detail;
    lastMsgAt = performance.now();
    if (m.t === 'state') {
      snap = m;
      snapAt = performance.now();
      if (volumeRail && typeof m.vol === 'number') volumeRail.set(m.vol);
      render();
      renderPauseBtn($('#pauseAll'), m.pause || 'idle');
      if (connected) { setStatus('Connected'); banner(''); }
    } else if (m.t === 'standby') {
      prepareStandby(l, m.sdp);
    } else if (m.t === 'armed' && pairing) {
      pairing.offer = m.offer;
      savePairing();
    } else if (m.t === 'forget') {
      forget('The main iPad disconnected this remote. To use it again, tap Remote on the main iPad and scan its code.');
    }
  });
  l.addEventListener('state', (e) => {
    if (l !== link) return;
    const s = e.detail;
    if (s === 'open') {
      connected = true;
      reconnecting = false;
      attempt = 0;
      clearTimeout(retryTimer);
      lastMsgAt = performance.now();
      setStatus('Connected');
      banner('');
      l.send({ t: 'hello', rid: identity && identity.id, reconnect: !!(identity && identity.cert) });
    } else if (s === 'reconnecting') {
      setStatus('Reconnecting…', true);
      banner('Lost contact with the main iPad. It keeps playing. Reconnecting…');
      // Short wifi blips recover by themselves; if not, use the standby.
      clearTimeout(retryTimer);
      retryTimer = setTimeout(() => { if (l === link && l.state !== 'open') reconnect(); }, 4000);
    } else if (s === 'closed') {
      connected = false;
      if (!reconnecting) reconnect();
    }
  });
}

async function prepareStandby(l, offerSdp) {
  if (!identity || !identity.cert || !pairing) return;
  try {
    const sdp = await standbyAnswer(offerSdp, identity);
    l.send({ t: 'standbyAnswer', offer: offerSdp, sdp });
  } catch (err) {
    console.warn('Could not prepare reconnect', err);
  }
}

function forget(text) {
  pairing = null;
  savePairing();
  clearTimeout(retryTimer);
  reconnecting = false;
  connected = false;
  if (link) { const l = link; link = null; l.close(); }
  snap = null;
  setStatus('Not paired', true);
  banner('');
  showMessage('Not connected', text);
}

// Reconnect to the main iPad's waiting standby. No codes to scan. Keeps trying
// while this screen is on; the main iPad just needs Cue Pad left open.
async function reconnect() {
  clearTimeout(retryTimer);
  if (!pairing || !pairing.offer || !identity || !identity.cert) {
    connected = false;
    if (link) { const l = link; link = null; l.close(); }
    setStatus('Disconnected', true);
    banner('');
    showMessage('Disconnected', 'This remote can\'t reconnect by itself. On the main iPad, tap Remote and scan its code to pair again.');
    return;
  }
  if (document.visibilityState === 'hidden') { reconnecting = false; return; }
  reconnecting = true;
  connected = false;
  attempt++;
  setStatus('Reconnecting…', true);
  if (attempt > 3) {
    banner('Still trying to reach the main iPad. Check this phone is on the same wifi. If Cue Pad was closed on the main iPad, tap Remote there and scan again.');
  } else {
    banner('Lost contact with the main iPad. It keeps playing. Reconnecting…');
  }
  if (!snap) showMessage('Reconnecting…', 'Finding the main iPad. You don\'t need to scan anything.');
  let l = null;
  try {
    l = await reconnectToStandby(pairing.offer, identity);
    useLink(l);
  } catch (err) {
    console.warn('Reconnect failed', err);
  }
  // Give this attempt a few seconds, then try again. Don't cut off an attempt
  // that is part-way through connecting: that could use up the standby.
  const started = performance.now();
  const check = () => {
    if (!l || l !== link) { if (!l) reconnect(); return; }
    if (l.state === 'open') return;
    const busy = l.pc && (l.pc.connectionState === 'connecting' || l.pc.connectionState === 'connected');
    if (busy && performance.now() - started < 15000) { retryTimer = setTimeout(check, 1000); return; }
    reconnect();
  };
  retryTimer = setTimeout(check, attempt > 3 ? 5000 : 3000);
}

async function pairFresh(code) {
  setStatus('Pairing…');
  showMessage('Getting ready…', 'Creating a pairing code.');
  try {
    const res = await createRemoteAnswer(code, identity);
    pairing = { from: code, offer: null };
    savePairing();
    useLink(res.link);
    showPairing(await qrSvg(res.answerText), 'You only need to do this once. After that, this remote reconnects by itself.');
  } catch (err) {
    console.error(err);
    setStatus('Not paired', true);
    showMessage('This pairing code has expired', 'On the main iPad, tap Remote, then scan the new code with this device\'s camera.');
  }
}

export async function startRemote() {
  document.body.classList.add('remote-mode');
  $('#startOverlay').hidden = true;
  $('#editBtn').hidden = true;
  $('#remoteBtn').hidden = true;
  $('#showBtn').disabled = true;
  $('.app-name').textContent = 'Cue Pad Remote';
  $('#logo')?.addEventListener('error', (e) => e.target.remove());

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  try { if ('wakeLock' in navigator) await navigator.wakeLock.request('screen'); } catch {}
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState !== 'visible') return;
    try { if ('wakeLock' in navigator) await navigator.wakeLock.request('screen'); } catch {}
    // Back from a locked screen or another app: reconnect straight away.
    if (pairing && pairing.offer && (!link || link.state !== 'open' || performance.now() - lastMsgAt > 2500)) {
      attempt = 0;
      reconnect();
    }
  });

  setupControls();
  requestAnimationFrame(frame);
  // Used by automated tests.
  window.cuepadRemote = { get link() { return link; }, get pairing() { return pairing; }, get identity() { return identity; }, reconnect: () => { attempt = 0; return reconnect(); } };

  showMessage('Getting ready…', 'Starting the remote.');
  try { identity = await remoteIdentity(); } catch { identity = null; }

  const code = location.hash.slice(PAIR_PREFIX.length);
  const saved = loadPairing();
  if (saved && saved.from === code && saved.offer) {
    // Same link as before (the page was reloaded): reconnect without codes.
    pairing = saved;
    reconnect();
  } else {
    await pairFresh(code);
  }
}

function setupControls() {
  const grid = $('#grid');
  // Fire on touch-down when the grid fits on screen; if it scrolls (phones),
  // fire on lift only when the finger didn't move, so scrolling is safe.
  let down = null;
  grid.addEventListener('pointerdown', (e) => {
    const t = e.target.closest('.tile');
    if (!t || !t.dataset.id) return;
    if (grid.scrollHeight <= grid.clientHeight + 2) {
      e.preventDefault();
      sendCmd({ t: 'toggle', id: t.dataset.id }, t);
      down = null;
    } else {
      down = { t, x: e.clientX, y: e.clientY };
    }
  });
  grid.addEventListener('pointerup', (e) => {
    if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 12) sendCmd({ t: 'toggle', id: down.t.dataset.id }, down.t);
    down = null;
  });
  grid.addEventListener('pointercancel', () => { down = null; });
  grid.addEventListener('contextmenu', (e) => e.preventDefault());
  $('#stopAll').addEventListener('pointerdown', (e) => { e.preventDefault(); sendCmd({ t: 'stopAll' }); });
  $('#fadeAll').addEventListener('pointerdown', (e) => { e.preventDefault(); sendCmd({ t: 'fadeAll' }); });
  $('#pauseAll').addEventListener('pointerdown', (e) => { e.preventDefault(); sendCmd({ t: 'pauseAll' }); });
  $('#goBtn').addEventListener('pointerdown', (e) => { e.preventDefault(); sendCmd({ t: 'go' }, e.currentTarget); });
  $('#prevCue').addEventListener('click', () => sendCmd({ t: 'step', delta: -1 }));
  $('#skipCue').addEventListener('click', () => sendCmd({ t: 'step', delta: 1 }));
  volumeRail = createVolumeRail($('#volume'), { value: 1, onChange: (v) => sendCmd({ t: 'volume', v }) });
  window.addEventListener('resize', () => snap && renderedKey && layout(snap.tiles.length));
}
