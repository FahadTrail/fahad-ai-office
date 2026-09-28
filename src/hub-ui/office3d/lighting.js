// Time of day for the immersive Office: DAY, EVENING, NIGHT. Pure data and
// blending, so the scene only applies numbers and tests can check them.
// Nothing here reads a clock, a location or the weather: the Office follows
// the theme (light → day, dark → night) unless Fahad picks one in the Office
// view options.
//
// Every preset sets the same keys:
//   sky / ground / hemi      ambient sky light
//   sun / sunColor / sunPos  the key light (daylight, low evening sun, a soft
//                            cool night key)
//   fill / fillColor         the opposite side
//   env                      image-based reflections (wood, metal, glass)
//   exposure                 tone-mapping exposure
//   windows                  daylight patches on the floor by the facades
//   lamps                    task lamps and pendants (emissive)
//   pools                    warm pools of light under lamps and pendants
//   glow                     cool screen glow in front of wall displays
//   washes                   wall washes and coves
//   accents                  department accent strips
//   screens                  screen brightness (never glaring by day)
//   backdrop / backdropDark  the stage's CSS sky → ground gradient in the
//                            light and dark themes (the page around it keeps
//                            its theme)

export const TIMES = Object.freeze(['day', 'evening', 'night']);

export const LIGHTING = Object.freeze({
  day: Object.freeze({
    sky: '#eef3fb', ground: '#cdbfab', hemi: 0.48,
    sun: 2.8, sunColor: '#fff0d8', sunPos: [-30, 30, -6],
    fill: 0.32, fillColor: '#d6e3f7',
    env: 0.36, exposure: 0.82,
    windows: 0.5, lamps: 0, pools: 0, glow: 0, washes: 0, accents: 0.25, screens: 0.86,
    backdrop: ['#f4f5f7', '#e4e0da'], backdropDark: ['#2b2e36', '#1c1d22'],
  }),
  evening: Object.freeze({
    sky: '#c9c1d6', ground: '#4a3a2c', hemi: 0.42,
    sun: 1.55, sunColor: '#ffbf85', sunPos: [-34, 12, 4],
    fill: 0.3, fillColor: '#9fb0d8',
    env: 0.32, exposure: 1.0,
    windows: 0.3, lamps: 0.65, pools: 0.6, glow: 0.45, washes: 0.55, accents: 0.6, screens: 1,
    backdrop: ['#e9dccd', '#b9a795'], backdropDark: ['#2e2723', '#1a1613'],
  }),
  night: Object.freeze({
    sky: '#8393b6', ground: '#2a211a', hemi: 0.46,
    sun: 0.55, sunColor: '#a9b9dc', sunPos: [-16, 30, 16],
    fill: 0.2, fillColor: '#7f8fbf',
    env: 0.26, exposure: 1.2,
    windows: 0, lamps: 1, pools: 1, glow: 1, washes: 1, accents: 1, screens: 1.05,
    backdrop: ['#e3e2e6', '#c9c6c2'], backdropDark: ['#1f2129', '#121317'],
  }),
});

// Auto follows the theme; a saved choice wins.
export function resolveTime(preference, dark) {
  if (TIMES.includes(preference)) return preference;
  return dark ? 'night' : 'day';
}

const hex = (value) => {
  const clean = String(value).replace('#', '');
  return [0, 2, 4].map((index) => parseInt(clean.slice(index, index + 2), 16));
};
const toHex = (rgb) => `#${rgb.map((channel) => Math.round(Math.max(0, Math.min(255, channel))).toString(16).padStart(2, '0')).join('')}`;
const mix = (a, b, t) => a + (b - a) * t;

// Blends two presets (t = 0 → a, 1 → b); colours in sRGB, numbers linearly.
export function blendLighting(a, b, t) {
  const k = Math.max(0, Math.min(1, t));
  const out = {};
  for (const key of Object.keys(a)) {
    const from = a[key]; const to = b[key];
    if (typeof from === 'number') out[key] = mix(from, to, k);
    else if (typeof from === 'string' && from.startsWith('#')) out[key] = toHex(hex(from).map((channel, index) => mix(channel, hex(to)[index], k)));
    else if (Array.isArray(from) && typeof from[0] === 'number') out[key] = from.map((value, index) => mix(value, to[index], k));
    else if (Array.isArray(from)) out[key] = from.map((value, index) => toHex(hex(value).map((channel, i) => mix(channel, hex(to[index])[i], k))));
    else out[key] = k < 0.5 ? from : to;
  }
  return out;
}

// Smooth, calm easing for the transition (no overshoot).
export const easeLight = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
export const TRANSITION_MS = 2200;
