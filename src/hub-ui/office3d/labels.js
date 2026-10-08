// Floor-anchored labels (Final Design Spec §08): "04 Coding ●" on a 6 px
// floor ring with a 1 px leader line, at a fixed screen size. Pure layout,
// tested in Node; the scene measures the label boxes and draws the result.
//
//   LOD        more than 40 m: dot · 15–40 m: name + dot · under 15 m: name, state, task
//   Collision  greedy placement with 4 slots and priority demotion
//   Never      overlaps another label, covers the focus target or a panel
//   RTL        slot order and text side mirror
//
// Distances are measured on the spec's scale, where the fitted Overview sits
// just inside the medium band: the scene passes lodScale = 36 / overview
// distance, so a zoomed-out camera reaches "dot" and a department view
// reaches "name, state, task".

export const LOD = Object.freeze({ far: 40, near: 15 });
export const RING_PX = 6;
export const LEADER_PX = 26;
export const GAP_PX = 4;
export const EDGE_PX = 8;
export const SLOTS = Object.freeze(['up-end', 'up-start', 'down-end', 'down-start']);
const ORDER = ['full', 'name', 'dot'];

export function lodFor(distance) {
  if (distance > LOD.far) return 'dot';
  if (distance >= LOD.near) return 'name';
  return 'full';
}

// Where a label box sits for a slot. "end" is the reading direction's end:
// right in LTR, left in RTL — the box starts at the anchor and runs that way.
export function slotBox(anchor, [width, height], slot, rtl = false) {
  const up = slot.startsWith('up');
  const toEnd = slot.endsWith('end') !== rtl; // true → the box extends to the right
  const x = toEnd ? anchor.x - 10 : anchor.x + 10 - width;
  const y = up ? anchor.y - LEADER_PX - height : anchor.y + LEADER_PX * 0.6;
  return { x, y, w: width, h: height };
}

export function overlaps(a, b, gap = 0) {
  return a.x < b.x + b.w + gap && a.x + a.w + gap > b.x && a.y < b.y + b.h + gap && a.y + a.h + gap > b.y;
}

// entries: [{ key, anchor: { x, y, visible }, distance, priority, sizes: { full: [w, h], name: [w, h] } }]
// options: { width, height, avoid: [rect], focus: rect | null, rtl, lodScale }
export function layoutLabels(entries, { width, height, avoid = [], focus = null, rtl = false, lodScale = 1 } = {}) {
  const placed = [];
  const blockers = [...avoid, ...(focus ? [focus] : [])];
  const rings = entries.filter((entry) => entry.anchor?.visible).map((entry) => ({ key: entry.key, rect: { x: entry.anchor.x - RING_PX, y: entry.anchor.y - RING_PX, w: RING_PX * 2, h: RING_PX * 2 } }));
  const inView = (box) => box.x >= EDGE_PX && box.y >= EDGE_PX && box.x + box.w <= width - EDGE_PX && box.y + box.h <= height - EDGE_PX;
  const result = [];
  for (const entry of entries.toSorted((a, b) => a.priority - b.priority || a.distance - b.distance)) {
    const anchor = entry.anchor;
    const onScreen = anchor?.visible && anchor.x >= 0 && anchor.x <= width && anchor.y >= 0 && anchor.y <= height;
    if (!onScreen) { result.push({ key: entry.key, lod: 'hidden', box: null, leader: null, anchor }); continue; }
    // The ring itself must not sit under a panel either.
    if (avoid.some((rect) => overlaps({ x: anchor.x - RING_PX, y: anchor.y - RING_PX, w: RING_PX * 2, h: RING_PX * 2 }, rect))) {
      result.push({ key: entry.key, lod: 'hidden', box: null, leader: null, anchor }); continue;
    }
    let lod = lodFor(entry.distance * lodScale);
    let chosen = null;
    while (!chosen && lod !== 'dot') {
      for (const slot of SLOTS) {
        const box = slotBox(anchor, entry.sizes[lod], slot, rtl);
        if (!inView(box)) continue;
        if (placed.some((other) => overlaps(box, other, GAP_PX))) continue;
        if (blockers.some((rect) => overlaps(box, rect, 2))) continue;
        if (rings.some((ring) => ring.key !== entry.key && overlaps(box, ring.rect))) continue;
        chosen = { slot, box };
        break;
      }
      if (!chosen) lod = ORDER[ORDER.indexOf(lod) + 1];
    }
    if (chosen) placed.push(chosen.box);
    const up = chosen?.slot.startsWith('up');
    result.push({
      key: entry.key, lod, anchor, slot: chosen?.slot || null, box: chosen?.box || null,
      leader: chosen ? { x1: anchor.x, y1: anchor.y + (up ? -RING_PX / 2 : RING_PX / 2), x2: anchor.x, y2: up ? chosen.box.y + chosen.box.h : chosen.box.y } : null,
    });
  }
  return result;
}
