// Always-visible vertical master volume slider, shared by the main iPad and
// the remote. It moves only when dragged (relative to where the finger lands),
// so an accidental tap or brush never jumps the volume mid-show.

export function createVolumeRail(container, { value = 1, onChange }) {
  container.classList.add('vol');
  container.innerHTML = `
    <div class="vol-label">Vol</div>
    <div class="vol-value" aria-hidden="true"></div>
    <div class="vol-track" role="slider" tabindex="0" aria-label="Master volume" aria-orientation="vertical" aria-valuemin="0" aria-valuemax="100">
      <div class="vol-fill"></div>
      <div class="vol-thumb"></div>
    </div>`;
  const track = container.querySelector('.vol-track');
  const fill = container.querySelector('.vol-fill');
  const thumb = container.querySelector('.vol-thumb');
  const label = container.querySelector('.vol-value');
  let current = clamp(value);
  let drag = null;
  let lastUserChange = 0;

  function clamp(v) { return Math.min(1, Math.max(0, Number(v) || 0)); }

  function paint() {
    const pct = Math.round(current * 100);
    fill.style.height = `${current * 100}%`;
    thumb.style.bottom = `${current * 100}%`;
    label.textContent = pct === 0 ? 'Mute' : `${pct}%`;
    container.classList.toggle('muted', pct === 0);
    track.setAttribute('aria-valuenow', String(pct));
    track.setAttribute('aria-valuetext', pct === 0 ? 'Muted' : `${pct} percent`);
  }

  function setFromUser(v) {
    const next = Math.round(clamp(v) * 100) / 100;
    if (next === current) return;
    current = next;
    lastUserChange = performance.now();
    paint();
    onChange(current);
  }

  track.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    track.setPointerCapture(e.pointerId);
    drag = { id: e.pointerId, y: e.clientY, start: current, h: track.getBoundingClientRect().height };
    container.classList.add('dragging');
  });
  track.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    setFromUser(drag.start + (drag.y - e.clientY) / Math.max(40, drag.h));
  });
  const end = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    drag = null;
    lastUserChange = performance.now();
    container.classList.remove('dragging');
  };
  track.addEventListener('pointerup', end);
  track.addEventListener('pointercancel', end);
  track.addEventListener('keydown', (e) => {
    const step = { ArrowUp: 0.05, ArrowRight: 0.05, ArrowDown: -0.05, ArrowLeft: -0.05 }[e.key];
    if (step) { e.preventDefault(); setFromUser(current + step); }
  });

  paint();
  return {
    get value() { return current; },
    // External updates (e.g. from the other device) are ignored while the
    // user is dragging here, so the thumb doesn't fight their finger.
    set(v) {
      if (drag || performance.now() - lastUserChange < 600) return;
      const next = clamp(v);
      if (next === current) return;
      current = next;
      paint();
    },
  };
}

// Perceptual curve: slider position -> gain.
export const toGain = (v) => v * v;
