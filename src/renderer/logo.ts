/**
 * Stylised "M" mark with a subtle pulse dot evoking a microphone capsule.
 * Pure inline SVG, no external assets. Drawn in the overlay's ink and highlighter colours; the
 * repository's logo.svg is the same mark on an ink tile for the README, package and window icon.
 */
export const LOGO_SVG = `
<svg viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <path
    d="M5 24 V10 a1.5 1.5 0 0 1 2.7 -0.9 L13.5 17 a1 1 0 0 0 1.6 0 L17 14 a1 1 0 0 1 1.6 0 L20.5 17 a1 1 0 0 0 1.6 0 L24.3 9.1 A1.5 1.5 0 0 1 27 10 V24"
    fill="none"
    stroke="#e9edef"
    stroke-width="2.6"
    stroke-linecap="round"
    stroke-linejoin="round"
  />
  <circle cx="16" cy="22" r="1.9" fill="#ffd93d"/>
</svg>`.trim();
