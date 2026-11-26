import { Engine } from './engine.js';
import * as db from './db.js';
import * as backup from './backup.js';
import { setupRemoteHost, openPairingSheet, remoteCount, disconnectAll, pairedCount } from './remote-host.js';
import { createVolumeRail, toGain } from './volume.js';
import { createTransport } from './transport.js';
import { renderPauseBtn, setupOrientationGuard, squareGrid } from './layout.js';

export const APP_VERSION = '1.7.0';

const COLORS = [
  { key: 'none', name: 'None' },
  { key: 'apricot', name: 'Apricot' },
  { key: 'gold', name: 'Gold' },
  { key: 'rust', name: 'Orange' },
  { key: 'sky', name: 'Blue' },
  { key: 'green', name: 'Green' },
  { key: 'pink', name: 'Pink' },
];

const $ = (sel) => document.querySelector(sel);
const el = (tag, props = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k === 'style') node.setAttribute('style', v);
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (v === true) node.setAttribute(k, '');
    else if (v !== false && v != null) node.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c != null) node.append(c);
  return node;
};

const uid = () => (crypto.randomUUID ? crypto.randomUUID() : 'id-' + Date.now().toString(36) + Math.random().toString(36).slice(2));

export function fmtTime(sec) {
  if (sec == null || !isFinite(sec)) return '--:--';
  sec = Math.max(0, Math.round(sec));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function cleanName(filename) {
  return filename.replace(/\.[a-z0-9]{2,4}$/i, '').replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function newTile(trackId, label) {
  return { id: uid(), trackId, label, color: 'none', volume: 1, startAt: 0, fadeIn: 0, fadeOut: 2, loop: false, layer: false };
}

// ---------------------------------------------------------------- state

const state = {
  shows: [],
  show: null,
  tracks: new Map(), // id -> info
  editing: false,
  started: false,
  updateReady: false,
  swReg: null,
  fits: false,
  bannerMsg: null,
  nextId: null,
  fadeMode: false,
  fadeTime: 5, // seconds, for the Fade in / Fade out buttons
};

const engine = new Engine((trackId) => db.trackBytes(trackId));
// Hooks other modules (e.g. the remote) can subscribe to.
export const bus = new EventTarget();
const notify = () => bus.dispatchEvent(new Event('change'));

function tileById(id) {
  return state.show && state.show.tiles.find((t) => t.id === id);
}

async function saveShow() {
  state.show.updatedAt = Date.now();
  await db.put('shows', state.show);
}

// ---------------------------------------------------------------- commands (shared with remote)

// opts.fadeIn (seconds): start with a fade-in and fade the previous cue out
// over the same time (the Fade in button). Otherwise the Fade switch decides.
export function toggle(tileId, opts = {}) {
  const tile = tileById(tileId);
  const xfade = opts.fadeIn > 0 ? opts.fadeIn : null;
  if (!tile) return;
  if (!engine.running) {
    showOverlay('Tap anywhere to turn audio back on');
    return;
  }
  if (engine.isPaused(tileId)) {
    engine.resume(tileId, xfade || 0.04);
    return;
  }
  if (engine.isPlaying(tileId)) {
    engine.stop(tileId, state.fadeMode ? (tile.fadeOut ?? 2) : 0);
    return;
  }
  if (engine.prepStatus(tileId) !== 'ready') {
    flash(tileId);
    return;
  }
  if (!tile.layer) {
    for (const id of engine.playingIds()) {
      const other = tileById(id);
      // Default: the previous cue cuts instantly. With Fade on, it fades out.
      engine.stop(id, xfade || (state.fadeMode && other ? Math.min(other.fadeOut ?? 2, 2) : 0));
    }
    for (const id of engine.pausedIds()) engine.stop(id, 0);
  }
  engine.play(tile, xfade ? { fadeIn: xfade } : { noFade: !state.fadeMode });
  // Starting a cue by hand moves GO along to the cue after it, so GO always
  // follows the operator. "Play over" stings are one-offs and leave it alone.
  if (!tile.layer) setNextIndex(state.show.tiles.indexOf(tile) + 1);
}

// ---------------------------------------------------------------- GO / running order
//
// state.nextId is the cue GO plays next: a tile id, or END after the last cue.

const END = 'end';
const GO_GUARD_MS = 400; // ignore a second GO this soon (double tap, pedal bounce)
let lastGoAt = -Infinity;

export function nextIndex() {
  const tiles = state.show ? state.show.tiles : [];
  if (state.nextId === END) return tiles.length;
  const i = tiles.findIndex((t) => t.id === state.nextId);
  return i < 0 ? 0 : i;
}

function setNextIndex(i) {
  if (!state.show) return;
  const tiles = state.show.tiles;
  i = Math.max(0, Math.min(tiles.length, i));
  const id = i >= tiles.length ? END : tiles[i].id;
  if (id === state.nextId) return;
  state.nextId = id;
  db.setMeta(`next:${state.show.id}`, id).catch(() => {});
  renderNext();
  notify();
}

export function go(opts = {}) {
  const now = performance.now();
  if (now - lastGoAt < GO_GUARD_MS) return;
  lastGoAt = now;
  const tiles = state.show ? state.show.tiles : [];
  const i = nextIndex();
  if (i >= tiles.length) { flashNext(); return; }
  const tile = tiles[i];
  if (!engine.running) {
    showOverlay('Tap anywhere to turn audio back on');
    return;
  }
  if (engine.prepStatus(tile.id) !== 'ready') {
    flash(tile.id);
    flashNext();
    return;
  }
  if (!engine.isPlaying(tile.id)) toggle(tile.id, opts);
  setNextIndex(i + 1);
}

export function stepNext(delta) {
  setNextIndex(nextIndex() + delta);
}

function nextInfo() {
  const tiles = state.show ? state.show.tiles : [];
  if (!tiles.length) return { id: null, n: 0, label: 'No cues', end: true };
  const i = nextIndex();
  if (i >= tiles.length) return { id: null, n: 0, label: 'End of show', end: true };
  return { id: tiles[i].id, n: i + 1, label: tiles[i].label, end: false };
}

function renderNext() {
  const info = nextInfo();
  const name = $('#nextName');
  name.textContent = info.end ? info.label : `${info.n}. ${info.label}`;
  name.classList.toggle('end', info.end);
  const tiles = state.show ? state.show.tiles : [];
  $('#prevCue').disabled = nextIndex() === 0;
  $('#skipCue').disabled = info.end;
  $('#goBtn').disabled = info.end;
  for (const node of document.querySelectorAll('#grid .tile[data-id]')) {
    node.classList.toggle('next', !state.editing && node.dataset.id === info.id);
  }
  if (!tiles.length) $('#prevCue').disabled = true;
}

function flashNext() {
  const node = document.querySelector('.next-box');
  node.classList.remove('flash');
  void node.offsetWidth;
  node.classList.add('flash');
}

async function loadNext() {
  const saved = state.show ? await db.getMeta(`next:${state.show.id}`) : null;
  const tiles = state.show ? state.show.tiles : [];
  state.nextId = saved === END || tiles.some((t) => t.id === saved) ? saved : (tiles[0] ? tiles[0].id : END);
  renderNext();
}

export function stopAll() {
  engine.stopAll(0);
}

// Fade out (and Esc): everything playing fades out over the fade time from Settings.
export function fadeAll() {
  for (const id of engine.playingIds()) engine.stop(id, state.fadeTime);
  for (const id of engine.pausedIds()) engine.stop(id, 0);
}

// Fade in: a paused current cue carries on, fading in. Otherwise the Next cue
// starts, fading in, while whatever was playing fades out over the same time.
export function fadeIn() {
  const id = engine.focusId();
  if (id && engine.isPaused(id)) { engine.resume(id, state.fadeTime); return; }
  go({ fadeIn: state.fadeTime });
}

// Play the current cue again from its start point.
export function fromStart() {
  const id = engine.focusId();
  if (!id) return;
  engine.seek(id, 0);
  if (engine.isPaused(id)) engine.resume(id);
}

function canFadeIn() {
  const id = engine.focusId();
  if (id && engine.isPaused(id)) return true;
  const n = nextInfo();
  return !n.end && engine.prepStatus(n.id) === 'ready';
}

export function setFadeTime(secs) {
  state.fadeTime = Math.max(0.5, Math.min(30, Number(secs) || 5));
  db.setMeta('fadeTime', state.fadeTime).catch(() => {});
  updateTiles();
  notify();
}

// Pause everything that's playing; if nothing is playing, resume what was paused.
export function pauseAll() {
  const playing = engine.playingIds();
  if (playing.length) playing.forEach((id) => engine.pause(id));
  else engine.pausedIds().forEach((id) => engine.resume(id));
}

function pauseState() {
  if (engine.playingIds().length) return 'pause';
  if (engine.pausedIds().length) return 'resume';
  return 'idle';
}

let volume = 1;
let volumeRail = null;
let volumeSaveTimer = null;

export function setVolume(v, fromRemote = false) {
  volume = Math.max(0, Math.min(1, Number(v) || 0));
  engine.setMasterGain(toGain(volume));
  if (fromRemote && volumeRail) volumeRail.set(volume);
  clearTimeout(volumeSaveTimer);
  volumeSaveTimer = setTimeout(() => db.setMeta('masterVolume', volume), 400);
  notify();
}

// ---------------------------------------------------------------- transport (current cue)

let transport = null;

function focusInfo() {
  const id = engine.focusId();
  if (!id || !state.show) return null;
  const i = state.show.tiles.findIndex((t) => t.id === id);
  const p = engine.position(id);
  if (i < 0 || !p) return null;
  return { id, n: i + 1, label: state.show.tiles[i].label, pos: p.pos, dur: p.duration, paused: !!p.paused, loop: !!p.loop };
}

export function seekBy(delta) {
  const f = focusInfo();
  if (f) engine.seek(f.id, f.pos + delta);
}

export function seekTo(pos) {
  const id = engine.focusId();
  if (id) engine.seek(id, pos);
}

export function setFadeMode(on) {
  state.fadeMode = !!on;
  db.setMeta('fadeMode', state.fadeMode).catch(() => {});
  if (transport) transport.update(focusInfo(), transportOpts());
  notify();
}

function transportOpts() {
  return { fade: !!state.fadeMode, fadeTime: state.fadeTime, canFadeIn: canFadeIn(), canFadeOut: engine.playingIds().length > 0 };
}

export function snapshot() {
  const show = state.show;
  return {
    vol: volume,
    pause: pauseState(),
    fade: !!state.fadeMode,
    ...transportOpts(),
    focus: focusInfo(),
    showName: show ? show.name : '',
    tiles: show ? show.tiles.map((t, i) => {
      const p = engine.position(t.id);
      return {
        id: t.id, n: i + 1, label: t.label, color: t.color,
        status: engine.prepStatus(t.id),
        playing: engine.isPlaying(t.id),
        paused: !!(p && p.paused),
        stopping: !!(p && p.stopping),
        pos: p ? p.pos : null, dur: p ? p.duration : (engine.preps.get(t.id)?.playDuration ?? null),
        loop: !!t.loop,
      };
    }) : [],
    next: nextInfo(),
  };
}

function flash(tileId) {
  const node = document.querySelector(`.tile[data-id="${tileId}"]`);
  if (!node) return;
  node.classList.remove('flash');
  void node.offsetWidth;
  node.classList.add('flash');
}

// ---------------------------------------------------------------- rendering

function layoutGrid() {
  const grid = $('#grid');
  const count = (state.show ? state.show.tiles.length : 0) + (state.editing ? 1 : 0);
  const res = squareGrid(grid, count, { minSide: window.innerWidth < 700 ? 100 : 96 });
  state.fits = res.fits;
  grid.classList.toggle('fits', state.fits && !state.editing);
}

function renderTopbar() {
  $('#showName').textContent = state.show ? state.show.name : 'Show';
  const edit = $('#editBtn');
  edit.setAttribute('aria-pressed', String(state.editing));
  edit.textContent = state.editing ? 'Done' : 'Edit';
  renderStatus();
}

function renderStatus() {
  const tiles = state.show ? state.show.tiles : [];
  let ready = 0, errors = 0;
  for (const t of tiles) {
    const s = engine.prepStatus(t.id);
    if (s === 'ready') ready++;
    else if (s === 'error') errors++;
  }
  const status = $('#status');
  status.textContent = '';
  if (!tiles.length) return;
  if (errors) status.append(el('span', { class: 'warn' }, `${errors} failed · `));
  status.append(ready === tiles.length ? `All ${ready} ready` : `Loading ${ready}/${tiles.length}`);
}

function renderBanner() {
  const b = $('#banner');
  const tiles = state.show ? state.show.tiles : [];
  const errors = tiles.filter((t) => engine.prepStatus(t.id) === 'error').length;
  let msg = state.bannerMsg;
  let info = false;
  if (!msg && errors) msg = `${errors} cue${errors > 1 ? 's' : ''} could not be loaded. Open Edit and replace the audio.`;
  if (!msg && state.started && engine.ctx && engine.ctx.state !== 'running') msg = 'Audio is paused by the iPad. Tap anywhere to turn it back on.';
  if (msg && msg === state.bannerMsg) info = true;
  b.hidden = !msg;
  b.textContent = msg || '';
  b.classList.toggle('info', info);
}

function tileNode(tile, index) {
  const status = engine.prepStatus(tile.id);
  const node = el('button', {
    class: `tile ${status}`,
    type: 'button',
    dataset: { id: tile.id },
    style: `--stripe: var(--stripe-${tile.color || 'none'})`,
    'aria-label': `${index + 1}. ${tile.label}`,
  },
  el('div', { class: 'top' },
    el('span', { class: 'num' }, String(index + 1)),
    el('span', { class: 'flags' }, [tile.loop ? '⟳ loop' : null, tile.layer ? ' ⧉ over' : null].filter(Boolean).join(' '))),
  el('div', { class: 'label' }, tile.label),
  el('div', { class: 'info' }, ''),
  el('div', { class: 'progress' }));
  return node;
}

function renderGrid() {
  const grid = $('#grid');
  grid.classList.toggle('editing', state.editing);
  grid.textContent = '';
  const tiles = state.show ? state.show.tiles : [];
  tiles.forEach((t, i) => grid.append(tileNode(t, i)));
  if (state.editing) {
    grid.append(el('button', { class: 'tile add', type: 'button', id: 'addTile' }, '+ Add tracks'));
  } else if (!tiles.length) {
    grid.append(el('div', { class: 'empty' },
      el('div', {}, 'This show has no cues yet.'),
      el('div', {}, 'Tap ', el('strong', {}, 'Edit'), ', then ', el('strong', {}, '+ Add tracks'), ' to choose MP3s from Files or iCloud Drive.')));
  }
  layoutGrid();
  updateTiles();
  renderNext();
}

// Cheap per-frame update of tile state, progress and the bottom bar.
function updateTiles() {
  const tiles = state.show ? state.show.tiles : [];
  const nowParts = [];
  for (const t of tiles) {
    const node = document.querySelector(`.tile[data-id="${t.id}"]`);
    const status = engine.prepStatus(t.id);
    const p = engine.position(t.id);
    const prep = engine.preps.get(t.id);
    if (!node) continue;
    const playing = !!p && !p.stopping && !p.paused;
    const paused = !!p && !p.stopping && p.paused;
    const stopping = !!p && p.stopping;
    node.classList.toggle('queued', status === 'queued');
    node.classList.toggle('loading', status === 'loading');
    node.classList.toggle('ready', status === 'ready');
    node.classList.toggle('error', status === 'error');
    node.classList.toggle('playing', playing);
    node.classList.toggle('stopping', stopping);
    node.classList.toggle('paused', paused);
    const info = node.querySelector('.info');
    const bar = node.querySelector('.progress');
    let text;
    if (p) {
      const left = p.loop ? null : p.duration - p.pos;
      text = stopping ? 'Fading…' : (p.loop ? `${fmtTime(p.pos)} looping` : `−${fmtTime(left)}`);
      if (paused) text = `Paused ${text}`;
      bar.style.width = `${Math.min(100, (p.pos / Math.max(0.1, p.duration)) * 100)}%`;
      if (playing || paused) nowParts.push({ n: tiles.indexOf(t) + 1, label: t.label, text });
    } else {
      bar.style.width = '0';
      if (status === 'ready') text = fmtTime(prep.playDuration);
      else if (status === 'error') text = 'Missing audio';
      else text = 'Loading…';
    }
    if (info.textContent !== text) info.textContent = text;
  }
  renderPauseBtn($('#pauseAll'), pauseState());
  if (transport) transport.update(focusInfo(), transportOpts());
  const now = $('#now');
  if (!nowParts.length) {
    if (now.textContent !== 'Nothing playing') now.textContent = 'Nothing playing';
  } else {
    now.textContent = '';
    nowParts.forEach((p, i) => {
      if (i) now.append('   ');
      now.append(el('b', {}, `${p.n}. ${p.label}`), ` ${p.text}`);
    });
  }
}

let rafPending = false;
function loop() {
  updateTiles();
  if (engine.players.size) requestAnimationFrame(loop);
  else rafPending = false;
}
function kick() {
  if (!rafPending) {
    rafPending = true;
    requestAnimationFrame(loop);
  }
}

function renderAll() {
  renderTopbar();
  renderBanner();
  renderGrid();
}

// ---------------------------------------------------------------- input

function setupGridInput() {
  const grid = $('#grid');
  let down = null;
  grid.addEventListener('pointerdown', (e) => {
    const tileEl = e.target.closest('.tile');
    if (!tileEl) return;
    tileEl.classList.add('pressed');
    if (!state.editing && tileEl.dataset.id && state.fits) {
      // Grid doesn't scroll: fire on touch down for zero delay.
      e.preventDefault();
      triggerTile(tileEl.dataset.id);
      down = { el: tileEl, fired: true };
    } else {
      down = { el: tileEl, x: e.clientX, y: e.clientY, fired: false };
    }
  });
  const release = (e, cancel) => {
    if (!down) return;
    down.el.classList.remove('pressed');
    if (!cancel && !down.fired) {
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
      if (moved < 12) {
        if (down.el.id === 'addTile') $('#filePicker').click();
        else if (state.editing) openTileEditor(down.el.dataset.id);
        else triggerTile(down.el.dataset.id);
      }
    }
    down = null;
  };
  grid.addEventListener('pointerup', (e) => release(e, false));
  grid.addEventListener('pointercancel', (e) => release(e, true));
  grid.addEventListener('contextmenu', (e) => e.preventDefault());
}

function triggerTile(id) {
  toggle(id);
  kick();
}

// ---------------------------------------------------------------- overlay / audio unlock

function showOverlay(msg) {
  $('#startMsg').textContent = msg;
  $('#startOverlay').hidden = false;
}

async function start() {
  $('#startOverlay').hidden = true;
  await engine.unlock();
  state.started = true;
  requestWakeLock();
  renderBanner();
}

let wakeLock = null;
async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator && document.visibilityState === 'visible') {
      wakeLock = await navigator.wakeLock.request('screen');
    }
  } catch {}
}

// ---------------------------------------------------------------- sheets

const sheet = () => $('#sheet');

function openSheet(title, body, { onClose } = {}) {
  const d = sheet();
  d.textContent = '';
  d.append(
    el('div', { class: 'sheet-head' },
      el('h2', {}, title),
      el('button', { class: 'btn ghost', type: 'button', onclick: () => d.close() }, 'Done')),
    el('div', { class: 'sheet-body' }, body));
  d.onclose = () => { if (onClose) onClose(); };
  if (!d.open) d.showModal();
}

function field(label, input, hint) {
  return el('label', { class: 'field' }, el('span', {}, label), input, hint ? el('small', {}, hint) : null);
}

function numInput(value, { step = 0.1, min = 0, max = 3600 } = {}, onchange) {
  return el('input', {
    class: 'num-input', type: 'number', inputmode: 'decimal', step, min, max, value: String(value),
    onchange: (e) => {
      let v = parseFloat(e.target.value);
      if (!isFinite(v)) v = 0;
      v = Math.min(max, Math.max(min, v));
      e.target.value = String(v);
      onchange(v);
    },
  });
}

let editingTileId = null;

function openTileEditor(tileId) {
  const tile = tileById(tileId);
  if (!tile) return;
  editingTileId = tileId;
  const idx = state.show.tiles.indexOf(tile);
  const track = state.tracks.get(tile.trackId);
  const prep = engine.preps.get(tile.id);

  const commit = async (reload = false) => {
    await saveShow();
    renderGrid();
    renderStatus();
    if (reload) loadShowAudio();
    notify();
  };

  const swatches = el('div', { class: 'swatches' }, COLORS.map((c) => el('button', {
    type: 'button',
    class: `swatch ${c.key === 'none' ? 'none' : ''}`,
    style: `--sw: var(--stripe-${c.key})`,
    'aria-label': c.name,
    'aria-pressed': String((tile.color || 'none') === c.key),
    onclick: (e) => {
      tile.color = c.key;
      swatches.querySelectorAll('.swatch').forEach((s) => s.setAttribute('aria-pressed', 'false'));
      e.currentTarget.setAttribute('aria-pressed', 'true');
      commit();
    },
  })));

  const volLabel = el('span', {}, `Volume ${Math.round((tile.volume ?? 1) * 100)}%`);
  const vol = el('input', {
    type: 'range', min: '0', max: '1.5', step: '0.05', value: String(tile.volume ?? 1),
    oninput: (e) => { tile.volume = parseFloat(e.target.value); volLabel.textContent = `Volume ${Math.round(tile.volume * 100)}%`; },
    onchange: () => commit(),
  });

  const previewBtn = el('button', { class: 'btn', type: 'button' }, engine.isPlaying(tile.id) ? 'Stop preview' : 'Preview');
  previewBtn.addEventListener('click', async () => {
    if (!engine.running) await start();
    toggle(tile.id);
    kick();
    setTimeout(() => { previewBtn.textContent = engine.isPlaying(tile.id) ? 'Stop preview' : 'Preview'; }, 50);
  });

  const body = el('div', {},
    field('Name', el('input', {
      class: 'text-input', type: 'text', value: tile.label, maxlength: '60',
      onchange: (e) => { tile.label = e.target.value.trim() || tile.label; commit(); },
    })),
    el('div', { class: 'field' }, el('span', {}, 'Colour'), swatches),
    el('label', { class: 'field' }, volLabel, vol),
    el('div', { class: 'row' },
      field('Start at (seconds)', numInput(tile.startAt || 0, { step: 0.1, min: 0, max: 3600 }, (v) => { tile.startAt = v; commit(true); }), 'Skips silence at the start'),
      field('Fade in (s)', numInput(tile.fadeIn || 0, { step: 0.5, min: 0, max: 30 }, (v) => { tile.fadeIn = v; commit(); })),
      field('Fade out (s)', numInput(tile.fadeOut ?? 2, { step: 0.5, min: 0, max: 30 }, (v) => { tile.fadeOut = v; commit(); }), 'Used when you tap to stop')),
    el('label', { class: 'check' }, el('input', { type: 'checkbox', checked: !!tile.loop, onchange: (e) => { tile.loop = e.target.checked; commit(); } }), 'Loop (repeat until stopped)'),
    el('label', { class: 'check' }, el('input', { type: 'checkbox', checked: !!tile.layer, onchange: (e) => { tile.layer = e.target.checked; commit(); } }), 'Play over other cues (don\'t stop what\'s playing)'),
    el('div', { class: 'muted' }, `Audio: ${track ? track.name : 'missing'}${prep && prep.trackDuration ? ` · ${fmtTime(prep.trackDuration)}` : ''}`),
    el('div', { class: 'btn-row' },
      previewBtn,
      el('button', { class: 'btn', type: 'button', onclick: () => $('#replacePicker').click() }, 'Replace audio')),
    el('div', { class: 'btn-row' },
      el('button', {
        class: 'btn', type: 'button', disabled: nextIndex() === idx,
        onclick: (e) => { setNextIndex(idx); e.currentTarget.disabled = true; e.currentTarget.textContent = 'This is the next cue for GO'; },
      }, nextIndex() === idx ? 'This is the next cue for GO' : 'Make this the next cue for GO')),
    el('div', { class: 'btn-row' },
      el('button', { class: 'btn', type: 'button', disabled: idx === 0, onclick: () => moveTile(tile.id, -1) }, '◀ Move earlier'),
      el('button', { class: 'btn', type: 'button', disabled: idx === state.show.tiles.length - 1, onclick: () => moveTile(tile.id, 1) }, 'Move later ▶')),
    el('div', { class: 'divider' }),
    el('div', { class: 'btn-row' },
      el('button', {
        class: 'btn danger', type: 'button',
        onclick: async () => {
          if (!confirm(`Delete cue "${tile.label}"? The audio stays on the iPad for other shows.`)) return;
          engine.stop(tile.id, 0);
          const wasNext = nextIndex() === idx;
          state.show.tiles = state.show.tiles.filter((t) => t.id !== tile.id);
          if (wasNext) { state.nextId = null; setNextIndex(idx); }
          sheet().close();
          await commit(true);
        },
      }, 'Delete cue')));

  openSheet(`Cue ${idx + 1}`, body, { onClose: () => { editingTileId = null; } });
}

async function moveTile(id, delta) {
  const tiles = state.show.tiles;
  const i = tiles.findIndex((t) => t.id === id);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= tiles.length) return;
  [tiles[i], tiles[j]] = [tiles[j], tiles[i]];
  await saveShow();
  renderGrid();
  notify();
  openTileEditor(id);
}

async function addFiles(files, replaceTileId = null) {
  if (!files.length) return;
  const startLen = state.show.tiles.length;
  const wasAtEnd = !replaceTileId && nextIndex() >= startLen;
  state.bannerMsg = `Saving ${files.length} file${files.length > 1 ? 's' : ''} to the iPad…`;
  renderBanner();
  try {
    for (const f of files) {
      const id = uid();
      const blob = new Blob([await f.arrayBuffer()], { type: f.type || 'audio/mpeg' });
      const info = { id, name: f.name, type: blob.type, size: blob.size, addedAt: Date.now() };
      await db.put('tracks', { ...info, blob });
      state.tracks.set(id, info);
      if (replaceTileId) {
        const t = tileById(replaceTileId);
        if (t) t.trackId = id;
      } else {
        state.show.tiles.push(newTile(id, cleanName(f.name)));
      }
    }
    await saveShow();
    // GO was past the last cue: point it at the first cue just added.
    if (wasAtEnd) { state.nextId = null; setNextIndex(startLen); }
  } catch (err) {
    alert('Could not save audio: ' + (err.message || err));
  }
  state.bannerMsg = null;
  renderAll();
  loadShowAudio();
  notify();
  if (replaceTileId) openTileEditor(replaceTileId);
}

// ---------------------------------------------------------------- shows

async function openShow(id) {
  const show = state.shows.find((s) => s.id === id);
  if (!show) return;
  if (engine.players.size) engine.stopAll(0.5);
  state.show = show;
  await db.setMeta('currentShow', id);
  await loadNext();
  renderAll();
  loadShowAudio();
  notify();
}

function loadShowAudio() {
  if (!state.show) return;
  engine.loadShow(state.show.tiles);
}

async function createShow(name, tiles = []) {
  const show = { id: uid(), name, tiles, updatedAt: Date.now() };
  await db.put('shows', show);
  state.shows.push(show);
  return show;
}

function openShowsSheet() {
  const body = el('div', {});
  const list = el('ul', { class: 'list' }, state.shows
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((s) => el('li', {}, el('button', {
      type: 'button',
      class: s === state.show ? 'current' : '',
      onclick: async () => { sheet().close(); await openShow(s.id); },
    }, s.name, el('small', {}, `${s.tiles.length} cue${s.tiles.length === 1 ? '' : 's'}`)))));

  const act = (label, fn, cls = 'btn') => el('button', { class: cls, type: 'button', onclick: fn }, label);

  body.append(
    list,
    el('div', { class: 'btn-row' },
      act('New show', async () => {
        const name = prompt('Name for the new show', 'New show');
        if (!name) return;
        const s = await createShow(name.trim());
        sheet().close();
        await openShow(s.id);
      }, 'btn primary'),
      act('Rename', async () => {
        const name = prompt('Rename show', state.show.name);
        if (!name) return;
        state.show.name = name.trim();
        await saveShow();
        renderTopbar();
        openShowsSheet();
        notify();
      }),
      act('Duplicate', async () => {
        const copy = await createShow(`${state.show.name} (copy)`, state.show.tiles.map((t) => ({ ...t, id: uid() })));
        sheet().close();
        await openShow(copy.id);
      })),
    el('div', { class: 'btn-row' },
      act('Export backup', async () => {
        try {
          state.bannerMsg = 'Preparing backup file…';
          renderBanner();
          const blob = await backup.exportShow(state.show);
          state.bannerMsg = null;
          renderBanner();
          const safe = state.show.name.replace(/[^\w\- ]+/g, '').trim() || 'show';
          await backup.saveFile(blob, `${safe}.cuepad`);
        } catch (err) {
          state.bannerMsg = null;
          renderBanner();
          alert('Export failed: ' + (err.message || err));
        }
      }),
      act('Import backup', () => $('#backupPicker').click())),
    el('div', { class: 'btn-row' },
      act('Start again from cue 1', () => { setNextIndex(0); sheet().close(); })),
    el('div', { class: 'divider' }),
    el('div', { class: 'btn-row' },
      act('Delete this show', async () => {
        if (state.shows.length === 1) { alert('You need at least one show.'); return; }
        if (!confirm(`Delete the show "${state.show.name}"? Its audio stays on the iPad.`)) return;
        engine.stopAll(0);
        await db.del('shows', state.show.id);
        state.shows = state.shows.filter((s) => s !== state.show);
        sheet().close();
        await openShow(state.shows[0].id);
      }, 'btn danger'),
      act('Clean up unused audio', cleanUnusedAudio)),
    el('div', { class: 'divider' }),
    storageInfo(),
    updateRow());

  openSheet('Shows', body);
}

function openSettingsSheet() {
  const body = el('div', {});
  body.append(
    field('Fade in / Fade out time (seconds)',
      numInput(state.fadeTime, { step: 0.5, min: 0.5, max: 30 }, (v) => setFadeTime(v)),
      'Used by the Fade in and Fade out buttons and the Esc key. Default 5 s.'),
    el('div', { class: 'divider' }),
    el('div', { class: 'muted' }, `Cue Pad ${APP_VERSION}`));
  openSheet('Settings', body);
}

function storageInfo() {
  const node = el('div', { class: 'muted' }, `Cue Pad ${APP_VERSION}`);
  db.estimate().then((est) => {
    if (!est) return;
    const mb = (n) => `${Math.round(n / 1e6).toLocaleString()} MB`;
    node.textContent = `Cue Pad ${APP_VERSION} · ${state.tracks.size} audio files · ${mb(est.usage || 0)} used of ${mb(est.quota || 0)} available`;
  });
  return node;
}

function updateRow() {
  if (!state.updateReady) return el('div', { class: 'muted' }, 'You have the latest version.');
  return el('div', { class: 'btn-row' }, el('button', {
    class: 'btn primary', type: 'button',
    onclick: () => {
      if (engine.players.size && !confirm('Audio is playing. Update and reload now?')) return;
      const w = state.swReg && state.swReg.waiting;
      if (w) w.postMessage('skipWaiting');
      else location.reload();
    },
  }, 'Update to the new version'));
}

async function cleanUnusedAudio() {
  const used = new Set(state.shows.flatMap((s) => s.tiles.map((t) => t.trackId)));
  const unused = [...state.tracks.keys()].filter((id) => !used.has(id));
  if (!unused.length) { alert('All saved audio is used by a show.'); return; }
  if (!confirm(`Remove ${unused.length} audio file${unused.length > 1 ? 's' : ''} that no show uses?`)) return;
  for (const id of unused) { await db.del('tracks', id); state.tracks.delete(id); }
  openShowsSheet();
}

async function importBackup(file) {
  try {
    state.bannerMsg = 'Importing backup…';
    renderBanner();
    const show = await backup.importShow(file, uid());
    for (const info of await db.listTrackInfo()) state.tracks.set(info.id, info);
    state.shows.push(show);
    state.bannerMsg = null;
    if (sheet().open) sheet().close();
    await openShow(show.id);
  } catch (err) {
    state.bannerMsg = null;
    renderBanner();
    alert('Import failed: ' + (err.message || err));
  }
}

// ---------------------------------------------------------------- service worker

function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('sw.js').then((reg) => {
    state.swReg = reg;
    const mark = () => { state.updateReady = true; };
    if (reg.waiting && navigator.serviceWorker.controller) mark();
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      if (!w) return;
      w.addEventListener('statechange', () => {
        if (w.state === 'installed' && navigator.serviceWorker.controller) mark();
      });
    });
  }).catch((err) => console.warn('Service worker failed', err));
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloaded || !state.updateReady) return;
    reloaded = true;
    location.reload();
  });
}

// ---------------------------------------------------------------- init

async function init() {
  registerSW();
  db.requestPersistence();

  volume = await db.getMeta('masterVolume', 1);
  engine.setMasterGain(toGain(volume));
  volumeRail = createVolumeRail($('#volume'), { value: volume, onChange: (v) => setVolume(v) });
  state.fadeMode = !!(await db.getMeta('fadeMode', false));
  state.fadeTime = Number(await db.getMeta('fadeTime', 5)) || 5;
  transport = createTransport($('#transport'), {
    onSeekBy: (d) => { seekBy(d); updateTiles(); kick(); },
    onSeekTo: (p) => { seekTo(p); updateTiles(); kick(); },
    onFadeToggle: (on) => setFadeMode(on),
    onFromStart: () => { fromStart(); updateTiles(); kick(); },
    onFadeIn: () => { fadeIn(); updateTiles(); kick(); },
    onFadeOut: () => { fadeAll(); updateTiles(); kick(); },
  });
  transport.update(null, { fade: state.fadeMode, fadeTime: state.fadeTime });

  for (const info of await db.listTrackInfo()) state.tracks.set(info.id, info);
  state.shows = await db.getAll('shows');
  if (!state.shows.length) await createShow('My first show');
  const currentId = await db.getMeta('currentShow');
  state.show = state.shows.find((s) => s.id === currentId) || state.shows[0];
  await loadNext();

  engine.addEventListener('prep', () => { updateTiles(); renderStatus(); renderBanner(); notify(); });
  engine.addEventListener('playback', () => { kick(); notify(); });
  engine.addEventListener('contextstate', () => {
    renderBanner();
    if (state.started && engine.ctx && engine.ctx.state !== 'running') showOverlay('Tap anywhere to turn audio back on');
  });

  setupRemoteHost({
    toggle: (id) => { toggle(id); kick(); },
    stopAll: () => { stopAll(); kick(); },
    pauseAll: () => { pauseAll(); kick(); },
    fadeAll: () => { fadeAll(); kick(); },
    fadeIn: () => { fadeIn(); kick(); },
    fromStart: () => { fromStart(); kick(); },
    go: () => { go(); kick(); },
    stepNext,
    setVolume: (v) => setVolume(v, true),
    seekBy: (d) => { seekBy(d); kick(); },
    seekTo: (p) => { seekTo(p); kick(); },
    setFadeMode,
    snapshot, bus, el, openSheet,
    closeSheet: () => { if (sheet().open) sheet().close(); },
    onCount: (n, away = 0) => { $('#remoteBtn').textContent = (n ? `Remote · ${n}` : 'Remote') + (away ? ` · ${away} away` : ''); },
  });
  $('#remoteBtn').hidden = false;
  $('#remoteBtn').addEventListener('click', openPairingSheet);

  setupGridInput();
  $('#startOverlay').addEventListener('pointerdown', (e) => { e.preventDefault(); start(); });
  $('#startOverlay').addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') start(); });
  $('#banner').addEventListener('click', () => { if (!engine.running) start(); });
  $('#editBtn').addEventListener('click', () => {
    state.editing = !state.editing;
    renderTopbar();
    renderGrid();
  });
  $('#showBtn').addEventListener('click', openShowsSheet);
  $('#stopAll').addEventListener('pointerdown', (e) => { e.preventDefault(); stopAll(); kick(); });
  $('#settingsBtn').addEventListener('click', openSettingsSheet);
  $('#pauseAll').addEventListener('pointerdown', (e) => { e.preventDefault(); pauseAll(); updateTiles(); kick(); });
  setupOrientationGuard({ onStopAll: () => { stopAll(); kick(); } });
  $('#goBtn').addEventListener('pointerdown', (e) => { e.preventDefault(); go(); kick(); });
  // blur() so a later Space/Enter from a pedal is GO, not another click here.
  $('#prevCue').addEventListener('click', (e) => { e.currentTarget.blur(); stepNext(-1); });
  $('#skipCue').addEventListener('click', (e) => { e.currentTarget.blur(); stepNext(1); });
  setupKeys();
  $('#filePicker').addEventListener('change', (e) => { const files = [...e.target.files]; e.target.value = ''; addFiles(files); });
  $('#replacePicker').addEventListener('change', (e) => {
    const files = [...e.target.files]; e.target.value = '';
    if (editingTileId && files.length) { sheet().close(); addFiles(files.slice(0, 1), editingTileId); }
  });
  $('#backupPicker').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) importBackup(f); });

  window.addEventListener('resize', layoutGrid);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      requestWakeLock();
      if (state.started && engine.ctx && engine.ctx.state !== 'running') showOverlay('Tap anywhere to turn audio back on');
    }
  });

  renderAll();
  loadShowAudio();
}

// A Bluetooth keyboard or page-turner pedal can drive the show:
// GO = Space, Enter, Page Down, → or ↓. Back one = Page Up, ← or ↑. Esc = Fade all.
function setupKeys() {
  const GO_KEYS = new Set([' ', 'Enter', 'PageDown', 'ArrowRight', 'ArrowDown']);
  const BACK_KEYS = new Set(['PageUp', 'ArrowLeft', 'ArrowUp']);
  document.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (sheet().open || !$('#startOverlay').hidden || state.editing) return;
    if (e.target.closest && e.target.closest('input, textarea, select')) return;
    // Arrow keys on a focused slider (the volume rail) belong to the slider.
    if (e.key.startsWith('Arrow') && e.target.closest && e.target.closest('[role="slider"]')) return;
    if (GO_KEYS.has(e.key)) {
      e.preventDefault();
      if (!e.repeat) { go(); kick(); }
    } else if (BACK_KEYS.has(e.key)) {
      e.preventDefault();
      stepNext(-1);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      fadeAll(); kick();
    }
  });
}

// Exposed for automated tests and the remote module.
window.cuepad = { state, engine, setVolume, seekBy, seekTo, setFadeMode, setFadeTime, fadeIn, fromStart, getVolume: () => volume, toggle, stopAll, fadeAll, pauseAll, go, stepNext, nextIndex, snapshot, bus, start, addFiles, remoteCount, pairedCount, disconnectAll };

init();
