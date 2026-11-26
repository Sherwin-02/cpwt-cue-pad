// Transport for the current cue, shared by the main iPad and the remote.
// The strip above the bottom bar shows the cue's name and position slider; the
// buttons under it (from start, -10s, +10s, fade in, fade out and the Fade
// switch) live in the bottom bar, with Pause and Stop all.
import { ICONS, fadeLabel } from './icons.js';

const fmt = (sec) => {
  if (sec == null || !isFinite(sec)) return '--:--';
  sec = Math.max(0, Math.floor(sec));
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
};

const $ = (s) => document.querySelector(s);

export function createTransport(root, { onSeekBy, onSeekTo, onFadeToggle, onFromStart, onFadeIn, onFadeOut }) {
  root.classList.add('transport');
  root.innerHTML = `
    <div class="tp-title" aria-live="polite"><span class="tp-tag">Now</span><span class="tp-name">Nothing playing</span></div>
    <span class="tp-time tp-pos">0:00</span>
    <input type="range" class="tp-slider" min="0" max="1" step="0.1" value="0" aria-label="Position in the current cue" disabled>
    <span class="tp-time tp-left">-0:00</span>`;
  const name = root.querySelector('.tp-name');
  const posEl = root.querySelector('.tp-pos');
  const leftEl = root.querySelector('.tp-left');
  const slider = root.querySelector('.tp-slider');
  const back = $('#back10');
  const fwd = $('#fwd10');
  const fromStart = $('#fromStart');
  const fadeIn = $('#fadeInBtn');
  const fadeOut = $('#fadeOutBtn');
  const fadeBtn = $('#fadeMode');
  back.innerHTML = ICONS.back10;
  fwd.innerHTML = ICONS.fwd10;
  fromStart.innerHTML = ICONS.fromStart;
  $('#stopAll').innerHTML = ICONS.stop;
  const pauseBtn = $('#pauseAll');
  if (!pauseBtn.firstChild) { pauseBtn.innerHTML = ICONS.pause; pauseBtn.setAttribute('aria-label', 'Pause what is playing'); }
  let dragging = false;
  let focus = null;
  let fadeSecs = null;

  const press = (btn, fn) => btn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    if (!btn.disabled) fn();
  });
  for (const b of [back, fwd]) press(b, () => { if (focus) onSeekBy(Number(b.dataset.d)); });
  press(fromStart, () => { if (focus) onFromStart(); });
  press(fadeIn, () => onFadeIn());
  press(fadeOut, () => onFadeOut());
  slider.addEventListener('pointerdown', () => { dragging = true; });
  slider.addEventListener('input', () => {
    dragging = true;
    if (focus) { posEl.textContent = fmt(+slider.value); leftEl.textContent = `-${fmt(focus.dur - slider.value)}`; }
  });
  const commit = () => {
    if (focus && dragging) onSeekTo(+slider.value);
    dragging = false;
  };
  slider.addEventListener('change', commit);
  slider.addEventListener('pointerup', () => setTimeout(commit, 0));
  slider.addEventListener('pointercancel', () => { dragging = false; });
  fadeBtn.addEventListener('click', () => onFadeToggle(fadeBtn.getAttribute('aria-pressed') !== 'true'));

  const setFadeSecs = (s) => {
    s = Number(s) || 5;
    if (s === fadeSecs) return;
    fadeSecs = s;
    const l = fadeLabel(s);
    fadeIn.innerHTML = ICONS.fadeIn(l);
    fadeOut.innerHTML = ICONS.fadeOut(l);
    fadeIn.setAttribute('aria-label', `Fade in over ${l} seconds`);
    fadeOut.setAttribute('aria-label', `Fade out over ${l} seconds`);
  };
  setFadeSecs(5);

  return {
    // f: { label, n, pos, dur, paused, loop } or null.
    // o: { fade (switch on), fadeTime (s), canFadeIn, canFadeOut }
    update(f, o = {}) {
      focus = f;
      const on = !!o.fade;
      if (fadeBtn.getAttribute('aria-pressed') !== String(on)) {
        fadeBtn.setAttribute('aria-pressed', String(on));
        fadeBtn.textContent = on ? 'Fade: On' : 'Fade: Off';
      }
      setFadeSecs(o.fadeTime);
      fadeIn.disabled = !o.canFadeIn;
      fadeOut.disabled = !o.canFadeOut;
      root.classList.toggle('idle', !f);
      slider.disabled = !f;
      back.disabled = fwd.disabled = fromStart.disabled = !f;
      if (!f) {
        if (name.textContent !== 'Nothing playing') name.textContent = 'Nothing playing';
        posEl.textContent = '0:00';
        leftEl.textContent = '-0:00';
        slider.value = 0;
        return;
      }
      const label = `${f.n}. ${f.label}${f.paused ? ' (paused)' : ''}`;
      if (name.textContent !== label) name.textContent = label;
      if (String(slider.max) !== String(f.dur)) slider.max = String(Math.max(0.1, f.dur));
      if (!dragging) {
        slider.value = String(f.pos);
        posEl.textContent = fmt(f.pos);
        leftEl.textContent = f.loop ? 'loop' : `-${fmt(f.dur - f.pos)}`;
      }
    },
    get dragging() { return dragging; },
  };
}
