// Inline SVG icons for the control buttons. SVG (not Unicode symbols) so they
// look the same on every device and never turn into emoji on iOS.

const svg = (body, label = '') =>
  `<svg class="ico" viewBox="0 0 48 48" aria-hidden="true" focusable="false">${body}</svg>${label ? `<span class="ico-label">${label}</span>` : ''}`;

// A circle with a gap at the lower left and an arrowhead at the upper left,
// with "10" inside (mirrored for forward).
const skipArc = '<path d="M11.3 35.2 A17 17 0 1 0 11.6 12.6" fill="none" stroke="currentColor" stroke-width="3.4" stroke-linecap="round"/>'
  + '<path d="M11.2 4.8 L11.2 12.8 L19.2 12.8" fill="none" stroke="currentColor" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"/>';
const ten = '<text x="24.5" y="30.6" text-anchor="middle" font-size="16" font-weight="800" fill="currentColor" font-family="-apple-system, BlinkMacSystemFont, \'Segoe UI\', Roboto, Arial, sans-serif">10</text>';

export const ICONS = {
  back10: svg(skipArc + ten),
  fwd10: svg(`<g transform="translate(48 0) scale(-1 1)">${skipArc}</g>` + ten),
  pause: svg('<rect x="12" y="10" width="8.5" height="28" rx="2" fill="currentColor"/><rect x="27.5" y="10" width="8.5" height="28" rx="2" fill="currentColor"/>'),
  play: svg('<path d="M15 9.5 L38 24 L15 38.5 Z" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>'),
  stop: svg('<rect x="11" y="11" width="26" height="26" rx="3" fill="currentColor"/>'),
  fromStart: svg('<rect x="9" y="10" width="5" height="28" rx="1.5" fill="currentColor"/><path d="M39 10 L17 24 L39 38 Z" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>'),
  fadeIn: (secs) => svg('<path d="M6 38 L42 38 L42 10 Z" fill="currentColor" opacity="0.9"/>', `In ${secs}s`),
  fadeOut: (secs) => svg('<path d="M6 10 L6 38 L42 38 Z" fill="currentColor" opacity="0.9"/>', `Out ${secs}s`),
};

// Formats a fade time for a button label: 5 -> "5", 2.5 -> "2.5".
export const fadeLabel = (s) => String(Math.round(s * 10) / 10);
