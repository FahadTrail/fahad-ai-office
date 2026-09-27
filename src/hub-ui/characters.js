// Character assets for the Live Office — ART ONLY.
//
// Layers are kept apart so each can be replaced without touching the others:
//   agent logic  → the Hub API (real states from task/session rows)
//   character    → this file: one station illustration per role (desk, screen
//                  content, a stylised seated figure), no names, no faces
//   animation    → office.css, keyed on data-state (never on fake activity)
//   UI           → office.js (layout, handoffs, drawer, timeline)
//
// To swap in final artwork later, replace STATION_ART entries (or return an
// <img>/<svg> for the role) — the rest of the Office keeps working.
// Every colour is a CSS variable, so light/dark themes apply automatically.

// Role screen content, drawn inside the monitor (origin 0,0; 112 × 66).
const SCREENS = {
  chief: `
    <rect class="ink-soft" x="8" y="8" width="30" height="20" rx="3"/><rect class="ink-soft" x="41" y="8" width="30" height="20" rx="3"/><rect class="ink-soft" x="74" y="8" width="30" height="20" rx="3"/>
    <rect class="ink scr-bar" x="12" y="20" width="14" height="3" rx="1.5"/><rect class="ink scr-bar d2" x="45" y="20" width="20" height="3" rx="1.5"/><rect class="ink scr-bar d3" x="78" y="20" width="10" height="3" rx="1.5"/>
    <polyline class="ink-line scr-draw" points="8,56 24,48 40,51 56,40 72,43 88,33 104,36"/>`,
  research: `
    <circle class="ink-line" cx="20" cy="22" r="9"/><line class="ink-line" x1="27" y1="29" x2="33" y2="35"/>
    <rect class="ink-soft" x="42" y="12" width="60" height="3" rx="1.5"/><rect class="ink-soft" x="42" y="20" width="48" height="3" rx="1.5"/><rect class="ink-soft" x="42" y="28" width="54" height="3" rx="1.5"/>
    <rect class="ink scr-bar" x="8" y="44" width="40" height="3" rx="1.5"/><rect class="ink-soft" x="8" y="51" width="70" height="3" rx="1.5"/>
    <circle class="ink scr-blink" cx="96" cy="50" r="3"/><circle class="ink-soft" cx="86" cy="50" r="3"/>`,
  creative: `
    <rect class="swatch s1" x="8" y="8" width="44" height="26" rx="4"/><rect class="swatch s2" x="56" y="8" width="22" height="26" rx="4"/><rect class="swatch s3" x="82" y="8" width="22" height="26" rx="4"/>
    <circle class="ink scr-blink" cx="20" cy="50" r="7"/><circle class="swatch s2" cx="38" cy="50" r="7"/><circle class="swatch s3" cx="56" cy="50" r="7"/>
    <rect class="ink-soft" x="72" y="44" width="32" height="3" rx="1.5"/><rect class="ink-soft" x="72" y="52" width="22" height="3" rx="1.5"/>`,
  product: `
    <rect class="ink-soft" x="8" y="8" width="30" height="50" rx="3"/><rect class="ink-soft" x="41" y="8" width="30" height="50" rx="3"/><rect class="ink-soft" x="74" y="8" width="30" height="50" rx="3"/>
    <rect class="ink scr-bar" x="11" y="13" width="24" height="8" rx="2"/><rect class="ink-line-fill" x="11" y="24" width="24" height="8" rx="2"/>
    <rect class="ink scr-bar d2" x="44" y="13" width="24" height="8" rx="2"/><rect class="ink-line-fill" x="77" y="13" width="24" height="8" rx="2"/><rect class="ink-line-fill" x="77" y="24" width="24" height="8" rx="2"/>`,
  finance: `
    <rect class="ink scr-grow" x="12" y="36" width="10" height="22" rx="2"/><rect class="ink scr-grow d2" x="28" y="28" width="10" height="30" rx="2"/>
    <rect class="ink scr-grow d3" x="44" y="40" width="10" height="18" rx="2"/><rect class="ink scr-grow d4" x="60" y="20" width="10" height="38" rx="2"/>
    <polyline class="ink-line" points="76,44 86,34 96,38 106,24"/><rect class="ink-soft" x="76" y="50" width="28" height="3" rx="1.5"/>
    <rect class="ink-soft" x="8" y="8" width="40" height="4" rx="2"/>`,
  coding: `
    <rect class="ink-soft" x="8" y="9" width="36" height="3" rx="1.5"/><rect class="ink" x="16" y="16" width="44" height="3" rx="1.5"/><rect class="ink-soft" x="16" y="23" width="30" height="3" rx="1.5"/>
    <rect class="ink-soft" x="24" y="30" width="52" height="3" rx="1.5"/><rect class="ink" x="24" y="37" width="24" height="3" rx="1.5"/><rect class="ink-soft" x="8" y="44" width="20" height="3" rx="1.5"/>
    <rect class="ink scr-caret" x="30" y="43" width="2" height="6"/>
    <rect class="ink-soft" x="8" y="55" width="96" height="4" rx="2"/><rect class="ok scr-progress" x="8" y="55" width="60" height="4" rx="2"/>`,
  audit: `
    <rect class="ink-soft" x="8" y="10" width="8" height="8" rx="2"/><rect class="ink-soft" x="20" y="12" width="50" height="3" rx="1.5"/><path class="ok-line" d="M9.5 14 l2 2 l3.5 -4"/>
    <rect class="ink-soft" x="8" y="24" width="8" height="8" rx="2"/><rect class="ink-soft" x="20" y="26" width="42" height="3" rx="1.5"/><path class="ok-line" d="M9.5 28 l2 2 l3.5 -4"/>
    <rect class="ink-soft" x="8" y="38" width="8" height="8" rx="2"/><rect class="ink-soft" x="20" y="40" width="46" height="3" rx="1.5"/><circle class="warn scr-blink" cx="12" cy="42" r="2"/>
    <path class="ink-line" d="M88 12 l14 5 v10 c0 9 -6 14 -14 17 c-8 -3 -14 -8 -14 -17 v-10 z"/>`,
  social: `
    ${[0, 1, 2, 3, 4, 5, 6].map((column) => [0, 1, 2].map((row) => `<rect class="${(column + row * 3) % 5 === 1 ? 'ink scr-blink' : (column + row) % 4 === 0 ? 'swatch s3' : 'ink-soft'}" x="${8 + column * 11}" y="${10 + row * 13}" width="9" height="10" rx="2"/>`).join('')).join('')}
    <rect class="ink-line-fill" x="88" y="10" width="18" height="44" rx="4"/><rect class="ink" x="92" y="16" width="10" height="14" rx="2"/><rect class="ink-soft" x="92" y="34" width="10" height="3" rx="1.5"/>`,
  legal: `
    <rect class="ink-line-fill" x="10" y="6" width="44" height="54" rx="3"/>
    <rect class="ink-soft" x="16" y="13" width="32" height="3" rx="1.5"/><rect class="ink-soft" x="16" y="20" width="28" height="3" rx="1.5"/><rect class="ink-soft" x="16" y="27" width="32" height="3" rx="1.5"/>
    <rect class="ink scr-bar" x="16" y="34" width="20" height="3" rx="1.5"/><rect class="ink-soft" x="16" y="41" width="30" height="3" rx="1.5"/>
    <line class="ink-line" x1="82" y1="14" x2="82" y2="50"/><line class="ink-line" x1="68" y1="20" x2="96" y2="20"/>
    <path class="ink-line" d="M68 20 l-6 14 h12 z"/><path class="ink-line" d="M96 20 l-6 14 h12 z"/><rect class="ink-soft" x="74" y="50" width="16" height="4" rx="2"/>`,
};

// A seated, stylised figure facing its screen: posture only, no face, no
// gender, no skin tone — the role colour carries the identity.
const FIGURE = `
  <rect class="chair" x="46" y="56" width="46" height="60" rx="16"/>
  <path class="torso" d="M56 116 C56 96 60 84 76 82 C92 84 98 96 98 116 Z"/>
  <path class="arm" d="M92 96 C104 100 112 106 120 110" />
  <circle class="head" cx="77" cy="67" r="12.5"/>
  <circle class="thinking t1" cx="95" cy="46" r="2.4"/><circle class="thinking t2" cx="102" cy="40" r="3"/><circle class="thinking t3" cx="110" cy="33" r="3.6"/>`;

export function stationArt(role, label = '') {
  const screen = SCREENS[role] || SCREENS.chief;
  return `<svg class="station-art" viewBox="0 0 280 170" role="img" aria-label="${label} workstation">
    <ellipse class="floor-shadow" cx="140" cy="146" rx="118" ry="16"/>
    <path class="desk-top" d="M34 112 H246 L262 128 H18 Z"/>
    <rect class="desk-front" x="18" y="128" width="244" height="9" rx="2"/>
    <rect class="desk-leg" x="30" y="137" width="6" height="16" rx="2"/><rect class="desk-leg" x="244" y="137" width="6" height="16" rx="2"/>
    <rect class="keyboard" x="112" y="114" width="44" height="6" rx="2"/>
    <rect class="monitor-stand" x="182" y="104" width="8" height="10" rx="2"/><rect class="monitor-base" x="170" y="112" width="32" height="4" rx="2"/>
    <g class="monitor" transform="translate(130 38)">
      <rect class="monitor-frame" x="-3" y="-3" width="118" height="72" rx="8"/>
      <rect class="screen" x="0" y="0" width="112" height="66" rx="6"/>
      <g class="screen-content">${screen}</g>
      <rect class="screen-glare" x="0" y="0" width="112" height="66" rx="6"/>
    </g>
    ${FIGURE}
    <g class="badge-done" transform="translate(236 22)"><circle r="11"/><path d="M-4.5 0.5 l3 3 l6 -7"/></g>
    <g class="badge-wait" transform="translate(236 22)"><circle r="11"/><path d="M0 -5 v5 l3.5 2.5"/></g>
    <g class="badge-alert" transform="translate(236 22)"><circle r="11"/><path d="M0 -5.5 v6.5 M0 4.5 v0.5"/></g>
  </svg>`;
}

// A small round mark for lists, the drawer and mobile cards.
export function roleMark(role, label = '') {
  const letter = String(label || role || '?').slice(0, 1).toUpperCase();
  return `<span class="role-mark" data-role="${role}" aria-hidden="true"><svg viewBox="0 0 40 40"><circle class="rm-bg" cx="20" cy="20" r="20"/><path class="rm-torso" d="M9 38 C9 29 13 25 20 24 C27 25 31 29 31 38 Z"/><circle class="rm-head" cx="20" cy="16" r="6.5"/></svg><span class="rm-letter">${letter}</span></span>`;
}

export const STATION_ROLES = Object.freeze(Object.keys(SCREENS));
