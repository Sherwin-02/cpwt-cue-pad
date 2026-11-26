// Trim and Join sheets (Edit mode).
//
// Trim: a touch waveform with Start and End handles. It only stores
// tile.startAt / tile.endAt; the audio file itself is never changed.
// Join: renders the chosen cues, one after another, into a NEW audio file
// and adds it as a new cue. The original cues and files stay as they were.

import { computePeaks, joinParts, joinedLength } from './audiotools.js';

const HANDLE_HIT = 36; // px either side of a handle that grabs it
const ZOOM_SECONDS = 8;

export function fmtPrecise(sec) {
  if (sec == null || !isFinite(sec)) return '--:--.-';
  sec = Math.max(0, sec);
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}

// deps: { el, openSheet, closeSheet, engine, db, ensureAudio, fmtTime,
//         onTrimSaved(tile), onJoined({ parts, track, blob, removeOriginals, label }), reopenTile(id) }
export function createEditors(deps) {
  const { el, engine } = deps;
  const decoded = new Map(); // trackId -> AudioBuffer (only the one being trimmed)

  async function decodeTrack(trackId) {
    if (decoded.has(trackId)) return decoded.get(trackId);
    const ctx = engine.ensureContext();
    const buf = await ctx.decodeAudioData(await deps.db.trackBytes(trackId));
    decoded.clear(); // keep at most one full song in memory
    decoded.set(trackId, buf);
    return buf;
  }

  // ------------------------------------------------------------ trim

  function openTrim(tile) {
    const orig = { startAt: tile.startAt || 0, endAt: tile.endAt || 0 };
    const t = { start: orig.startAt, end: 0 }; // end filled in once decoded
    let buf = null;
    let dur = 0;
    let view = [0, 0];
    let peaks = null;
    let preview = null; // { src, gain, t0, offset, until }
    let raf = 0;
    let saved = false;

    const canvas = el('canvas', { class: 'wave', 'aria-label': 'Waveform. Drag the Start and End handles.' });
    const wrap = el('div', { class: 'wave-wrap' }, canvas, el('div', { class: 'wave-loading' }, 'Loading waveform…'));
    const startVal = el('span', { class: 'trim-val' }, '');
    const endVal = el('span', { class: 'trim-val' }, '');
    const lenVal = el('div', { class: 'muted trim-len' }, '');
    const nudge = (which, d) => el('button', {
      class: 'btn nudge', type: 'button',
      onclick: () => { setPoint(which, (which === 'start' ? t.start : t.end) + d); },
    }, `${d > 0 ? '+' : '−'}${Math.abs(d)}`);
    const pointRow = (which, label, valNode) => el('div', { class: 'trim-row' },
      el('span', { class: 'trim-label' }, label),
      nudge(which, -1), nudge(which, -0.1), valNode, nudge(which, 0.1), nudge(which, 1));

    const zoomBtns = {
      all: el('button', { class: 'btn ghost', type: 'button', onclick: () => setView('all') }, 'Whole track'),
      start: el('button', { class: 'btn ghost', type: 'button', onclick: () => setView('start') }, 'Zoom on start'),
      end: el('button', { class: 'btn ghost', type: 'button', onclick: () => setView('end') }, 'Zoom on end'),
    };
    let zoom = 'all';

    const playBtn = el('button', { class: 'btn primary', type: 'button', onclick: () => play(t.start) }, '▶ Play from start');
    const endBtn = el('button', { class: 'btn', type: 'button', onclick: () => play(Math.max(t.start, t.end - 5)) }, '▶ Last 5 s');
    const stopBtn = el('button', { class: 'btn', type: 'button', onclick: () => stopPreview() }, '■ Stop');
    const setStartHere = el('button', { class: 'btn', type: 'button', disabled: true, onclick: () => { const p = playhead(); if (p != null) setPoint('start', p); } }, 'Set start here');
    const setEndHere = el('button', { class: 'btn', type: 'button', disabled: true, onclick: () => { const p = playhead(); if (p != null) { setPoint('end', p); stopPreview(); } } }, 'Set end here');

    const body = el('div', { class: 'trim' },
      el('div', { class: 'muted' }, 'Drag the handles to choose where this cue starts and ends. Tap the waveform to listen from there. The audio file itself is not changed.'),
      wrap,
      el('div', { class: 'btn-row zoom-row' }, zoomBtns.all, zoomBtns.start, zoomBtns.end),
      pointRow('start', 'Start', startVal),
      pointRow('end', 'End', endVal),
      lenVal,
      el('div', { class: 'btn-row' }, playBtn, endBtn, stopBtn),
      el('div', { class: 'btn-row' }, setStartHere, setEndHere),
      el('div', { class: 'divider' }),
      el('div', { class: 'btn-row' },
        el('button', { class: 'btn', type: 'button', onclick: () => { setPoint('start', 0); setPoint('end', dur); } }, 'Use the whole track'),
        el('button', { class: 'btn', type: 'button', onclick: () => { t.start = orig.startAt; t.end = orig.endAt > 0 ? Math.min(orig.endAt, dur) : dur; refresh(); } }, 'Undo changes')),
      el('div', { class: 'muted' }, 'Tap Done to keep the trim.'));

    deps.openSheet(`Trim · ${tile.label}`, body, {
      onClose: () => {
        stopPreview();
        cancelAnimationFrame(raf);
        window.removeEventListener('resize', draw);
        if (!saved && buf) {
          saved = true;
          const startAt = round1(t.start) <= 0 ? 0 : round3(t.start);
          const endAt = t.end >= dur - 0.0005 ? 0 : round3(t.end);
          if (startAt !== orig.startAt || endAt !== orig.endAt) {
            tile.startAt = startAt;
            tile.endAt = endAt;
            deps.onTrimSaved(tile);
          }
        }
        decoded.clear();
        deps.reopenTile(tile.id);
      },
    });

    function round3(v) { return Math.round(v * 1000) / 1000; }
    function round1(v) { return Math.round(v * 10) / 10; }

    function setPoint(which, v) {
      const minLen = 0.1;
      if (which === 'start') t.start = Math.max(0, Math.min(v, t.end - minLen));
      else t.end = Math.min(dur, Math.max(v, t.start + minLen));
      if (zoom !== 'all') setView(zoom, true);
      else refresh();
    }

    function setView(which, keepPeaks = false) {
      zoom = which;
      for (const [k, b] of Object.entries(zoomBtns)) b.setAttribute('aria-pressed', String(k === which));
      let v;
      if (which === 'all' || dur <= ZOOM_SECONDS * 1.5) v = [0, dur];
      else {
        const c = which === 'start' ? t.start : t.end;
        let a = c - ZOOM_SECONDS / 2;
        a = Math.max(0, Math.min(dur - ZOOM_SECONDS, a));
        v = [a, a + ZOOM_SECONDS];
      }
      // While dragging inside a zoom, only move the window if the handle leaves it.
      if (keepPeaks && peaks && view[1] > view[0]) {
        const c = which === 'start' ? t.start : t.end;
        if (c >= view[0] && c <= view[1]) { refresh(); return; }
      }
      view = v;
      peaks = null;
      refresh();
    }

    function refresh() {
      startVal.textContent = fmtPrecise(t.start);
      endVal.textContent = fmtPrecise(t.end);
      lenVal.textContent = buf ? `Plays ${fmtPrecise(t.end - t.start)} of ${fmtPrecise(dur)}` : '';
      draw();
    }

    function x2t(x) {
      const w = canvas.clientWidth || 1;
      return view[0] + (Math.max(0, Math.min(w, x)) / w) * (view[1] - view[0]);
    }
    function t2x(sec) {
      const w = canvas.clientWidth || 1;
      return ((sec - view[0]) / Math.max(1e-6, view[1] - view[0])) * w;
    }

    function draw() {
      if (!buf) return;
      const dpr = window.devicePixelRatio || 1;
      const w = canvas.clientWidth, h = canvas.clientHeight;
      if (!w || !h) return;
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
        peaks = null;
      }
      if (!peaks) peaks = computePeaks(buf, Math.round(w), view[0], view[1]);
      const g = canvas.getContext('2d');
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, w, h);
      const css = getComputedStyle(canvas);
      const colIn = css.getPropertyValue('--wave-in').trim() || '#F2B78E';
      const colOut = css.getPropertyValue('--wave-out').trim() || 'rgba(248,239,221,0.25)';
      const handle = css.getPropertyValue('--wave-handle').trim() || '#7BC47F';
      const mid = h / 2;
      const xs = t2x(t.start), xe = t2x(t.end);
      for (let i = 0; i < peaks.length; i++) {
        const amp = Math.max(1, peaks[i] * (mid - 6));
        g.fillStyle = i >= xs && i <= xe ? colIn : colOut;
        g.fillRect(i, mid - amp, 1, amp * 2);
      }
      // Dim outside the trim
      g.fillStyle = 'rgba(0,0,0,0.35)';
      if (xs > 0) g.fillRect(0, 0, Math.min(w, xs), h);
      if (xe < w) g.fillRect(Math.max(0, xe), 0, w - Math.max(0, xe), h);
      // Handles
      const drawHandle = (x, label, left) => {
        if (x < -2 || x > w + 2) return;
        g.fillStyle = handle;
        g.fillRect(x - 1.5, 0, 3, h);
        const tw = 44, th = 26;
        const tx = left ? x - tw : x;
        g.beginPath();
        g.roundRect ? g.roundRect(tx, 0, tw, th, 6) : g.rect(tx, 0, tw, th);
        g.fill();
        g.fillStyle = '#2A0810';
        g.font = '700 12px -apple-system, system-ui, sans-serif';
        g.textAlign = 'center';
        g.textBaseline = 'middle';
        g.fillText(label, tx + tw / 2, th / 2);
      };
      drawHandle(xs, 'Start', false);
      drawHandle(xe, 'End', true);
      const ph = playhead();
      if (ph != null) {
        const x = t2x(ph);
        g.fillStyle = '#FFFFFF';
        g.fillRect(x - 1, 0, 2, h);
      }
    }

    // ---- touch: drag a handle, or tap to listen from there
    let drag = null;
    canvas.addEventListener('pointerdown', (e) => {
      if (!buf) return;
      e.preventDefault();
      const r = canvas.getBoundingClientRect();
      const x = e.clientX - r.left;
      const ds = Math.abs(x - t2x(t.start)), de = Math.abs(x - t2x(t.end));
      let which = null;
      if (Math.min(ds, de) <= HANDLE_HIT) which = ds <= de ? 'start' : 'end';
      // Handles on top of each other: pick by side of the pointer.
      if (which && Math.abs(t2x(t.start) - t2x(t.end)) < 4) which = x < t2x(t.start) ? 'start' : 'end';
      drag = { which, x0: x, moved: false, id: e.pointerId };
      try { canvas.setPointerCapture(e.pointerId); } catch {}
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const r = canvas.getBoundingClientRect();
      const x = e.clientX - r.left;
      if (Math.abs(x - drag.x0) > 6) drag.moved = true;
      if (drag.which && drag.moved) {
        const v = x2t(x);
        if (drag.which === 'start') t.start = Math.max(0, Math.min(v, t.end - 0.1));
        else t.end = Math.min(dur, Math.max(v, t.start + 0.1));
        refresh();
      }
    });
    const up = (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const r = canvas.getBoundingClientRect();
      if (!drag.moved) play(x2t(e.clientX - r.left));
      drag = null;
    };
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', () => { drag = null; });

    // ---- preview through the main output
    function playhead() {
      if (!preview || !engine.ctx) return null;
      const p = preview.offset + (engine.ctx.currentTime - preview.t0);
      return p <= preview.until ? p : null;
    }

    async function play(from) {
      if (!buf) return;
      await deps.ensureAudio();
      stopPreview();
      const ctx = engine.ctx;
      from = Math.max(0, Math.min(from, dur - 0.05));
      const until = from < t.end ? t.end : dur;
      const gain = ctx.createGain();
      gain.gain.value = tile.volume ?? 1;
      gain.connect(engine.master);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(gain);
      const t0 = ctx.currentTime + 0.01;
      src.start(t0, from, Math.max(0.01, until - from));
      preview = { src, gain, t0, offset: from, until };
      src.onended = () => { if (preview && preview.src === src) stopPreview(); };
      setStartHere.disabled = false;
      setEndHere.disabled = false;
      const tick = () => { draw(); if (preview) raf = requestAnimationFrame(tick); };
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(tick);
    }

    function stopPreview() {
      if (!preview) return;
      const { src, gain } = preview;
      preview = null;
      try {
        const now = engine.ctx.currentTime;
        gain.gain.setTargetAtTime(0, now, 0.01);
        src.stop(now + 0.05);
      } catch {}
      setTimeout(() => { try { gain.disconnect(); } catch {} }, 200);
      setStartHere.disabled = true;
      setEndHere.disabled = true;
      draw();
    }

    window.addEventListener('resize', draw);

    decodeTrack(tile.trackId).then((b) => {
      buf = b;
      dur = b.duration;
      t.end = orig.endAt > 0 ? Math.min(orig.endAt, dur) : dur;
      t.start = Math.min(t.start, Math.max(0, t.end - 0.1));
      wrap.querySelector('.wave-loading').remove();
      setView('all');
    }).catch((err) => {
      wrap.querySelector('.wave-loading').textContent = 'Could not load this audio: ' + (err.message || err);
    });

    // For tests.
    return { get state() { return { start: t.start, end: t.end, dur, ready: !!buf }; }, setPoint, play, stopPreview, playhead };
  }

  // ------------------------------------------------------------ join

  function openJoin(show, firstTileId, { tileDuration }) {
    const parts = firstTileId ? [firstTileId] : [];
    let mode = 'straight';
    let seconds = 2;
    let removeOriginals = false;
    let busy = false;

    const tileOf = (id) => show.tiles.find((x) => x.id === id);
    const partsList = el('ol', { class: 'join-parts' });
    const addList = el('div', { class: 'join-add' });
    const totalNode = el('div', { class: 'muted' });
    const statusNode = el('div', { class: 'muted join-status' });
    const goBtn = el('button', { class: 'btn primary', type: 'button', onclick: () => doJoin() }, 'Join into a new cue');
    const secInput = el('input', {
      class: 'num-input', type: 'number', inputmode: 'decimal', step: '0.5', min: '0', max: '30', value: String(seconds),
      onchange: (e) => { let v = parseFloat(e.target.value); if (!isFinite(v)) v = 0; seconds = Math.max(0, Math.min(30, v)); e.target.value = String(seconds); render(); },
    });
    const modeSel = el('select', {
      class: 'text-input',
      onchange: (e) => { mode = e.target.value; render(); },
    },
    el('option', { value: 'straight' }, 'Straight on (no gap)'),
    el('option', { value: 'gap' }, 'With a gap of silence'),
    el('option', { value: 'crossfade' }, 'Crossfade (overlap)'));
    const secField = el('label', { class: 'field' }, el('span', {}, 'Seconds'), secInput);

    function render() {
      partsList.textContent = '';
      parts.forEach((id, i) => {
        const t = tileOf(id);
        const n = show.tiles.indexOf(t) + 1;
        const d = tileDuration(id);
        const trimmed = (t.startAt > 0 || t.endAt > 0) ? ' · trimmed' : '';
        partsList.append(el('li', {},
          el('span', { class: 'join-name' }, `${n}. ${t.label}`, el('small', {}, `${d != null ? deps.fmtTime(d) : '…'}${trimmed}`)),
          el('button', { class: 'btn step', type: 'button', 'aria-label': 'Move up', disabled: i === 0, onclick: () => { [parts[i - 1], parts[i]] = [parts[i], parts[i - 1]]; render(); } }, '↑'),
          el('button', { class: 'btn step', type: 'button', 'aria-label': 'Move down', disabled: i === parts.length - 1, onclick: () => { [parts[i + 1], parts[i]] = [parts[i], parts[i + 1]]; render(); } }, '↓'),
          el('button', { class: 'btn step', type: 'button', 'aria-label': 'Remove', onclick: () => { parts.splice(i, 1); render(); } }, '✕')));
      });
      if (!parts.length) partsList.append(el('li', { class: 'muted' }, 'Tap cues below to add them in order.'));
      addList.textContent = '';
      show.tiles.forEach((t, i) => {
        addList.append(el('button', {
          class: 'btn join-pick', type: 'button',
          onclick: () => { parts.push(t.id); render(); },
        }, `+ ${i + 1}. ${t.label}`));
      });
      secField.hidden = mode === 'straight';
      const durs = parts.map((id) => tileDuration(id));
      const known = durs.every((d) => d != null);
      totalNode.textContent = parts.length >= 2
        ? `New cue: about ${known ? deps.fmtTime(joinedLength(durs, mode, seconds)) : '…'} long. Each part keeps its trim and volume.`
        : 'Choose two or more cues.';
      goBtn.disabled = busy || parts.length < 2;
    }

    const body = el('div', { class: 'join' },
      el('div', { class: 'muted' }, 'Join plays the cues one after another as a single new cue. The original cues and their audio stay as they are.'),
      el('div', { class: 'field' }, el('span', {}, 'Parts, in order'), partsList),
      el('div', { class: 'field' }, el('span', {}, 'Add a cue'), addList),
      el('div', { class: 'row' }, el('label', { class: 'field' }, el('span', {}, 'Between parts'), modeSel), secField),
      el('label', { class: 'check' }, el('input', { type: 'checkbox', onchange: (e) => { removeOriginals = e.target.checked; } }), 'Take the original cues out of this show (their audio stays on the iPad)'),
      totalNode,
      el('div', { class: 'btn-row' }, goBtn),
      statusNode);

    deps.openSheet('Join cues', body);
    render();

    async function doJoin() {
      if (busy || parts.length < 2) return;
      busy = true;
      render();
      try {
        const ctx = engine.ensureContext();
        const chosen = parts.map(tileOf);
        const { blob, duration } = await joinParts(chosen.map((t) => ({
          load: () => deps.db.trackBytes(t.trackId),
          startAt: t.startAt || 0, endAt: t.endAt || 0, volume: t.volume ?? 1,
        })), {
          decode: (bytes) => ctx.decodeAudioData(bytes),
          sampleRate: ctx.sampleRate,
          mode, seconds,
          onProgress: (i, n) => { statusNode.textContent = i < n ? `Joining part ${i + 1} of ${n}…` : 'Saving…'; },
        });
        const label = chosen.map((t) => t.label).join(' + ').slice(0, 60);
        await deps.onJoined({ parts: chosen, blob, duration, label, removeOriginals });
      } catch (err) {
        console.error('Join failed', err);
        statusNode.textContent = 'Join failed: ' + (err.message || err);
        busy = false;
        render();
      }
    }
  }

  return { openTrim, openJoin };
}

