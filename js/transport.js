// Transport strip above the bottom bar, shared by the main iPad and the
// remote: the current cue's position slider, -10s / +10s, and the Fade switch.

const fmt = (sec) => {
  if (sec == null || !isFinite(sec)) return '--:--';
  sec = Math.max(0, Math.floor(sec));
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
};

export function createTransport(root, { onSeekBy, onSeekTo, onFadeToggle }) {
  root.classList.add('transport');
  root.innerHTML = `
    <div class="tp-title" aria-live="polite"><span class="tp-tag">Now</span><span class="tp-name">Nothing playing</span></div>
    <button type="button" class="btn tp-skip" data-d="-10" aria-label="Back 10 seconds">−10s</button>
    <span class="tp-time tp-pos">0:00</span>
    <input type="range" class="tp-slider" min="0" max="1" step="0.1" value="0" aria-label="Position in the current cue" disabled>
    <span class="tp-time tp-left">-0:00</span>
    <button type="button" class="btn tp-skip" data-d="10" aria-label="Forward 10 seconds">+10s</button>
    <button type="button" class="btn tp-fade" aria-pressed="false">Fade: Off</button>`;
  const name = root.querySelector('.tp-name');
  const posEl = root.querySelector('.tp-pos');
  const leftEl = root.querySelector('.tp-left');
  const slider = root.querySelector('.tp-slider');
  const skips = root.querySelectorAll('.tp-skip');
  const fadeBtn = root.querySelector('.tp-fade');
  let dragging = false;
  let focus = null;

  for (const b of skips) {
    b.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      if (focus) onSeekBy(Number(b.dataset.d));
    });
  }
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

  return {
    // f: { label, n, pos, dur, paused, loop } or null; fade: boolean
    update(f, fade) {
      focus = f;
      const on = !!fade;
      if (fadeBtn.getAttribute('aria-pressed') !== String(on)) {
        fadeBtn.setAttribute('aria-pressed', String(on));
        fadeBtn.textContent = on ? 'Fade: On' : 'Fade: Off';
      }
      root.classList.toggle('idle', !f);
      slider.disabled = !f;
      skips.forEach((b) => { b.disabled = !f; });
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
