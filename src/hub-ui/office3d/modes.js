// Light · Immersive · Auto (Final Design Spec §10). Modes change LIGHTING
// only: sky, sun, artificial levels, screen brightness, reflections and the
// overlay's palette. Geometry and materials never change; only the
// travertine's roughness shifts at night (0.55 → 0.4).
//
//   Light      — the Daylight Atrium at 10:30 (sun 5600 K, fin stripes, screens 70 %)
//   Immersive  — Night Operations at 21:30 (city, cove, underlights, bloom)
//   Auto       — real local time through 07:00 · 12:00 · 17:00 · 18:30 · 20:00
//
// The overlay crossfades between frosted (day) and smoked (night) surfaces
// at 18:30 and 05:30. Pure: the caller passes the clock; tested in Node.
// Rendering capability (3D or the simplified fallback) is decided elsewhere
// (office-presentation.js → officeRenderer) and never by these modes.

export const LIGHT_MODES = Object.freeze(['light', 'immersive', 'auto']);
export const MODE_MINUTES = Object.freeze({ light: 10 * 60 + 30, immersive: 21 * 60 + 30 });
export const UI_NIGHT_FROM = 18 * 60 + 30;
export const UI_DAY_FROM = 5 * 60 + 30;
export const MODE_TRANSITION_MS = 1200;

const NIGHT = { sunElevation: -12, sunAzimuth: 300, sunKelvin: 3200, sun: 0, sky: 0.16, hemi: 0.05, exposure: 1.0, artificial: 1, screens: 1, bloom: 1, roughness: 0.4, backdrop: ['#0a1220', '#1a2234'], horizon: '#26324a' };
// Keyframes over the day, in minutes. 10:30 is the Light preset, 21:30 the
// Immersive one; Auto interpolates between neighbours.
export const KEYFRAMES = Object.freeze([
  [0, NIGHT],
  [5 * 60 + 30, { ...NIGHT, sky: 0.22, artificial: 0.85, bloom: 0.6, backdrop: ['#1c2638', '#3a3a48'], horizon: '#4a4652' }],
  [7 * 60, { sunElevation: 9, sunAzimuth: 100, sunKelvin: 4300, sun: 2.1, sky: 0.55, hemi: 0.12, exposure: 1.0, artificial: 0.25, screens: 0.75, bloom: 0, roughness: 0.53, backdrop: ['#c9d3dc', '#efe2cf'], horizon: '#f2dcc0' }],
  [10 * 60 + 30, { sunElevation: 46, sunAzimuth: 128, sunKelvin: 5600, sun: 3.0, sky: 0.85, hemi: 0.16, exposure: 1.0, artificial: 0, screens: 0.7, bloom: 0, roughness: 0.55, backdrop: ['#cfd8de', '#eee6da'], horizon: '#efe7dc' }],
  [12 * 60, { sunElevation: 66, sunAzimuth: 175, sunKelvin: 5800, sun: 3.2, sky: 0.9, hemi: 0.17, exposure: 1.0, artificial: 0, screens: 0.7, bloom: 0, roughness: 0.55, backdrop: ['#cdd8e0', '#eee7dc'], horizon: '#efe8de' }],
  [17 * 60, { sunElevation: 20, sunAzimuth: 252, sunKelvin: 4400, sun: 2.5, sky: 0.7, hemi: 0.14, exposure: 1.0, artificial: 0.2, screens: 0.75, bloom: 0, roughness: 0.54, backdrop: ['#c7cfd8', '#ecd9c0'], horizon: '#efd3ae' }],
  [18 * 60 + 30, { sunElevation: 2, sunAzimuth: 287, sunKelvin: 2900, sun: 0.7, sky: 0.34, hemi: 0.09, exposure: 1.0, artificial: 0.85, screens: 0.9, bloom: 0.55, roughness: 0.46, backdrop: ['#3a4560', '#c58a5c'], horizon: '#d9946a' }],
  [20 * 60, NIGHT],
  [21 * 60 + 30, NIGHT],
  [24 * 60, NIGHT],
].map(([minute, preset]) => Object.freeze([minute, Object.freeze(preset)])));

export function minutesOf(date) {
  return date.getHours() * 60 + date.getMinutes() + date.getSeconds() / 60;
}

// Which minute of the day a mode shows. Auto reads the caller's clock.
export function modeMinutes(mode, now = new Date()) {
  if (mode === 'light' || mode === 'immersive') return MODE_MINUTES[mode];
  return minutesOf(now);
}

export function uiPhase(minutes) {
  return minutes >= UI_NIGHT_FROM || minutes < UI_DAY_FROM ? 'night' : 'day';
}

// The lighting preset at a minute of the day (interpolated keyframes).
export function lightingAt(minutes) {
  const m = ((minutes % 1440) + 1440) % 1440;
  let index = 0;
  while (index < KEYFRAMES.length - 2 && KEYFRAMES[index + 1][0] <= m) index += 1;
  const [startMinute, start] = KEYFRAMES[index];
  const [endMinute, end] = KEYFRAMES[index + 1];
  const t = endMinute === startMinute ? 0 : (m - startMinute) / (endMinute - startMinute);
  return blendPreset(start, end, smooth(t));
}

// Everything the scene and the overlay need for a mode at a moment.
export function resolveMode(mode, now = new Date()) {
  const chosen = LIGHT_MODES.includes(mode) ? mode : 'auto';
  const minutes = modeMinutes(chosen, now);
  const preset = lightingAt(minutes);
  return { mode: chosen, minutes, phase: uiPhase(minutes), preset, sun: sunDirection(preset), sunColor: kelvinToHex(preset.sunKelvin) };
}

// The direction toward the sun: compass azimuth (0 north, 90 east, 180
// south) and elevation in degrees → a unit vector in Office coordinates.
export function sunDirection({ sunElevation, sunAzimuth }) {
  const el = (sunElevation * Math.PI) / 180;
  const az = (sunAzimuth * Math.PI) / 180;
  return [round(Math.sin(az) * Math.cos(el)), round(Math.sin(el)), round(-Math.cos(az) * Math.cos(el))];
}

export function blendPreset(a, b, t) {
  const k = Math.max(0, Math.min(1, t));
  const out = {};
  for (const key of Object.keys(a)) {
    const [x, y] = [a[key], b[key]];
    if (typeof x === 'number') out[key] = round(x + (y - x) * k);
    else if (Array.isArray(x)) out[key] = x.map((value, index) => mixHex(value, y[index], k));
    else out[key] = mixHex(x, y, k);
  }
  return out;
}

const smooth = (t) => t * t * (3 - 2 * t);
const round = (value) => Math.round(value * 10000) / 10000;

export function mixHex(a, b, t) {
  const pa = parseHex(a); const pb = parseHex(b);
  return toHex(pa.map((value, index) => value + (pb[index] - value) * t));
}
function parseHex(hex) { const value = parseInt(String(hex).slice(1), 16); return [(value >> 16) & 255, (value >> 8) & 255, value & 255]; }
function toHex(rgb) { return `#${rgb.map((value) => Math.round(Math.max(0, Math.min(255, value))).toString(16).padStart(2, '0')).join('')}`; }

// Colour temperature → sRGB (Tanner Helland's fit), for the sun, the task
// lamps (2700 K) and each department's light shift.
export function kelvinToHex(kelvin) {
  const t = Math.max(1000, Math.min(40000, kelvin)) / 100;
  const r = t <= 66 ? 255 : 329.698727446 * (t - 60) ** -0.1332047592;
  const g = t <= 66 ? 99.4708025861 * Math.log(t) - 161.1195681661 : 288.1221695283 * (t - 60) ** -0.0755148492;
  const b = t >= 66 ? 255 : t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  return toHex([r, g, b]);
}

// Lamps: 2700 K when an employee works; departments shift their own
// ambient light (Coding −200 K, Legal +200 K) around 3500 K.
export const LAMP_KELVIN = 2700;
export const AMBIENT_KELVIN = 3500;
