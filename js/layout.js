// Shared layout helpers: square tile grid, the Pause button, and the
// landscape guard for the main iPad.


// Lays out `count` square tiles. Picks the largest square size that fits every
// tile on screen without scrolling; if even minSide doesn't fit, it fills the
// width and lets the grid scroll. Returns { fits, side, cols }.
export function squareGrid(grid, count, { minSide = 96, maxSide = 200 } = {}) {
  const rect = grid.getBoundingClientRect();
  // Read the real padding and gap, which are smaller on phones.
  const cs = getComputedStyle(grid);
  const px = (v) => parseFloat(v) || 0;
  const GAP = px(cs.rowGap) || 10;
  const w = rect.width - px(cs.paddingLeft) - px(cs.paddingRight);
  const h = rect.height - px(cs.paddingTop) - px(cs.paddingBottom);
  let best = null;
  if (count > 0 && w > 0 && h > 0) {
    for (let cols = 1; cols <= 14; cols++) {
      const rows = Math.ceil(count / cols);
      const side = Math.min((w - GAP * (cols - 1)) / cols, (h - GAP * (rows - 1)) / rows, maxSide);
      if (side < minSide) continue;
      if (!best || side > best.side) best = { cols, side, fits: true };
    }
  }
  if (!best) {
    const cols = Math.max(1, Math.floor((w + GAP) / (minSide + GAP)));
    const side = Math.min(maxSide, (w - GAP * (cols - 1)) / cols);
    best = { cols, side: Math.max(60, side), fits: count === 0 };
  }
  const side = Math.floor(best.side);
  grid.style.setProperty('--cols', best.cols);
  grid.style.setProperty('--tile', `${side}px`);
  grid.style.setProperty('--row-h', `${side}px`);
  const size = Math.max(13, Math.min(20, side * 0.12));
  grid.style.setProperty('--label-size', `${size.toFixed(1)}px`);
  const lines = Math.floor((side - 58) / (size * 1.15));
  grid.style.setProperty('--label-lines', Math.max(1, Math.min(4, lines)));
  return { ...best, side };
}

// state: 'pause' (something is playing), 'resume' (only paused cues), 'idle'.
export function renderPauseBtn(btn, state) {
  if (!btn || btn.dataset.state === state) return;
  btn.dataset.state = state;
  btn.textContent = state === 'resume' ? '▶ Resume' : '❚❚ Pause';
  btn.disabled = state === 'idle';
  btn.classList.toggle('resume', state === 'resume');
  btn.setAttribute('aria-label', state === 'resume' ? 'Resume paused cues' : 'Pause what is playing');
}

// The main iPad is laid out for landscape. On a tablet held upright, show a
// "turn sideways" screen that still offers Stop all, so audio can always be
// silenced whatever the orientation.
export function setupOrientationGuard({ onStopAll }) {
  const overlay = document.getElementById('rotateOverlay');
  if (!overlay) return;
  overlay.querySelector('.rotate-stop').addEventListener('pointerdown', (e) => {
    e.preventDefault();
    onStopAll();
  });
  const check = () => {
    const tablet = Math.min(screen.width, screen.height) >= 600;
    const portrait = window.innerHeight > window.innerWidth;
    overlay.hidden = !(tablet && portrait);
  };
  window.addEventListener('resize', check);
  window.addEventListener('orientationchange', check);
  check();
  try {
    // Locks where the platform allows it (installed apps on some devices).
    if (screen.orientation && screen.orientation.lock) screen.orientation.lock('landscape').catch(() => {});
  } catch {}
}
