/**
 * The five shapes the story is told in.
 *
 * Each function fills a `Float32Array(count * 3)` with one arrangement of the
 * same particles. Nothing is ever added or removed between acts — the field is
 * rearranged — because that is the claim the page makes: a spoken symptom and
 * the record a doctor reads are one piece of information, not a copy of one. A
 * scene that dissolved between five different objects would argue the opposite.
 *
 * A particle keeps its index through all five, and every function derives that
 * particle's place from the index rather than from a fresh random draw. Draw
 * again per act and the field *boils* between states instead of streaming
 * between them, which is the difference between this and a slideshow.
 */

/** Deterministic hash, so every visit composes the same picture. */
function rand(seed: number): number {
  const x = Math.sin(seed * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

/** Uniform inside a sphere — cube-root, or everything piles up at the shell. */
function inSphere(i: number, radius: number): [number, number, number] {
  const u = rand(i);
  const v = rand(i + 101);
  const w = rand(i + 202);
  const theta = u * Math.PI * 2;
  const phi = Math.acos(2 * v - 1);
  const r = radius * Math.cbrt(w);
  return [
    r * Math.sin(phi) * Math.cos(theta),
    r * Math.sin(phi) * Math.sin(theta),
    r * Math.cos(phi),
  ];
}

/**
 * The waveform the whole brand is built on: a flat line, a small P, the tall
 * QRS spike, and a low T. Stated as points on a path and sampled by arc length
 * so particles land evenly along it rather than bunching in the corners.
 */
const ECG: [number, number][] = [
  [-3.5, 0], [-2.2, 0], [-1.95, 0.12], [-1.7, 0], [-1.1, 0],
  [-0.9, -0.1], [-0.72, 0.95], [-0.54, -0.55], [-0.36, 0.06], [0.2, 0],
  [0.75, 0], [1.0, 0.3], [1.25, 0], [3.5, 0],
];

function alongEcg(t: number): [number, number] {
  // Cumulative lengths, computed once and closed over.
  const total = ecgLengths[ecgLengths.length - 1];
  const want = t * total;
  let i = 1;
  while (i < ecgLengths.length - 1 && ecgLengths[i] < want) i++;
  const span = ecgLengths[i] - ecgLengths[i - 1] || 1;
  const local = (want - ecgLengths[i - 1]) / span;
  const [ax, ay] = ECG[i - 1];
  const [bx, by] = ECG[i];
  return [ax + (bx - ax) * local, ay + (by - ay) * local];
}

const ecgLengths = (() => {
  const lengths = [0];
  for (let i = 1; i < ECG.length; i++) {
    const dx = ECG[i][0] - ECG[i - 1][0];
    const dy = ECG[i][1] - ECG[i - 1][1];
    lengths.push(lengths[i - 1] + Math.hypot(dx, dy));
  }
  return lengths;
})();

/** ACT I — one point of light. Tight enough that bloom makes it a star. */
export function dot(count: number): Float32Array {
  const out = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const [x, y, z] = inSphere(i, 0.085);
    out[i * 3] = x;
    out[i * 3 + 1] = y;
    out[i * 3 + 2] = z;
  }
  return out;
}

/**
 * ACT II — the point stretches into a trace, and something answers it.
 *
 * A fifth of the field forms a fainter echo below the line. Not decoration: the
 * act is about a second voice joining the first, and an echo is what that looks
 * like before the two merge.
 */
export function ecg(count: number): Float32Array {
  const out = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const echo = i % 5 === 0;
    const [x, y] = alongEcg(rand(i + 7));
    const spread = echo ? 0.02 : 0.035;
    out[i * 3] = x + (rand(i + 31) - 0.5) * 0.03;
    out[i * 3 + 1] = y * (echo ? 0.55 : 1) - (echo ? 0.42 : 0) + (rand(i + 57) - 0.5) * spread;
    out[i * 3 + 2] = (rand(i + 83) - 0.5) * 0.05;
  }
  return out;
}

/** Signed distance to a rounded box, in 2D. Negative inside. */
function roundedBox(x: number, y: number, w: number, h: number, r: number): number {
  const dx = Math.abs(x) - (w - r);
  const dy = Math.abs(y) - (h - r);
  const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
  return outside + Math.min(Math.max(dx, dy), 0) - r;
}

/**
 * ACT III — the trace folds into the mark.
 *
 * The logo's own geometry: two rounded bars crossed, with the ECG running
 * through as a brighter ribbon and four circuit traces leaving the right edge
 * into node clusters. Thirty per cent of the field goes on the ribbon so the
 * pulse stays legible through the solid — otherwise the cross reads as a block
 * and the one thing that identifies it disappears inside it.
 */
export function cross(count: number): Float32Array {
  const out = new Float32Array(count * 3);
  const ARM = 0.86;
  const BAR = 0.3;
  const CORNER = 0.13;

  for (let i = 0; i < count; i++) {
    const role = i % 10;

    if (role < 3) {
      // The pulse through the middle, clipped to the mark's width.
      const t = rand(i + 11);
      const [px, py] = alongEcg(t);
      const x = px * 0.34;
      out[i * 3] = x;
      out[i * 3 + 1] = py * 0.5 + (rand(i + 23) - 0.5) * 0.02;
      out[i * 3 + 2] = 0.16 + (rand(i + 41) - 0.5) * 0.04;
      continue;
    }

    if (role === 9 && rand(i + 61) > 0.55) {
      // Circuit traces: four short runs off the right edge, each ending in a
      // node. The same detail the logo carries, at the same place.
      const lane = i % 4;
      const y = (lane - 1.5) * 0.34;
      const reach = rand(i + 77);
      const node = reach > 0.82;
      out[i * 3] = ARM + 0.1 + reach * 0.72 + (node ? (rand(i + 91) - 0.5) * 0.14 : 0);
      out[i * 3 + 1] = y + (node ? (rand(i + 97) - 0.5) * 0.14 : (rand(i + 13) - 0.5) * 0.012);
      out[i * 3 + 2] = (rand(i + 29) - 0.5) * 0.08;
      continue;
    }

    // The solid, by rejection: sample the bounding box until a point lands
    // inside one of the two bars. Cheap, and it fills evenly, which a
    // parametric fill of a rounded cross does not.
    let x = 0;
    let y = 0;
    for (let attempt = 0; attempt < 24; attempt++) {
      x = (rand(i * 3 + attempt * 7 + 5) - 0.5) * 2 * ARM;
      y = (rand(i * 3 + attempt * 7 + 6) - 0.5) * 2 * ARM;
      const horizontal = roundedBox(x, y, ARM, BAR, CORNER);
      const vertical = roundedBox(x, y, BAR, ARM, CORNER);
      if (Math.min(horizontal, vertical) < 0) break;
    }
    out[i * 3] = x;
    out[i * 3 + 1] = y;
    out[i * 3 + 2] = (rand(i + 137) - 0.5) * 0.22;
  }

  return out;
}

/**
 * ACT IV — the mark opens into three views of itself.
 *
 * Borders dense, interiors sparse: a panel is recognised by its edge, and a
 * solid rectangle of particles would read as a wall. A tenth of the field
 * becomes the wires joining the three back to a small mark at the centre —
 * without them this act is three unrelated rectangles.
 */
export function portals(count: number): Float32Array {
  const out = new Float32Array(count * 3);
  const W = 0.92;
  const H = 0.58;
  const SITES: [number, number, number][] = [
    [-2.05, 0.06, -0.55],
    [0, -0.06, 0.28],
    [2.05, 0.06, -0.55],
  ];

  for (let i = 0; i < count; i++) {
    if (i % 10 === 0) {
      // A wire from one panel back to the centre, carrying the record.
      const site = SITES[i % 3];
      const along = rand(i + 151);
      out[i * 3] = site[0] * (1 - along);
      out[i * 3 + 1] = site[1] * (1 - along) + Math.sin(along * Math.PI) * 0.12;
      out[i * 3 + 2] = site[2] * (1 - along);
      continue;
    }

    const site = SITES[i % 3];
    const edge = i % 3 !== 1 ? rand(i + 163) < 0.72 : rand(i + 163) < 0.6;

    let x: number;
    let y: number;
    if (edge) {
      // Walk the perimeter, so the frame is unmistakable.
      const t = rand(i + 179) * 4;
      const local = t % 1;
      if (t < 1) { x = -W + 2 * W * local; y = H; }
      else if (t < 2) { x = W; y = H - 2 * H * local; }
      else if (t < 3) { x = W - 2 * W * local; y = -H; }
      else { x = -W; y = -H + 2 * H * local; }
      x += (rand(i + 191) - 0.5) * 0.02;
      y += (rand(i + 197) - 0.5) * 0.02;
    } else {
      x = (rand(i + 211) - 0.5) * 2 * W * 0.94;
      y = (rand(i + 223) - 0.5) * 2 * H * 0.94;
    }

    // A shallow arc: the outer panels tilt in, so the three read as one
    // arrangement facing the reader rather than as a row.
    const tilt = site[0] === 0 ? 0 : site[0] > 0 ? -0.22 : 0.22;
    out[i * 3] = site[0] + x * Math.cos(tilt);
    out[i * 3 + 1] = site[1] + y;
    out[i * 3 + 2] = site[2] + x * Math.sin(tilt);
  }

  return out;
}

/**
 * ACT V — one mark becomes every mark.
 *
 * A field of small crosses on a plane, seen from above. Each is nine particles
 * in the shape of the logo, because a field of dots is a starfield and a field
 * of *crosses* is a map of clinics. The jitter keeps it from reading as
 * graph paper.
 */
export function city(count: number): Float32Array {
  const out = new Float32Array(count * 3);
  const PER = 9;
  const blocks = Math.floor(count / PER);
  const columns = Math.ceil(Math.sqrt(blocks * 1.7));

  for (let i = 0; i < count; i++) {
    const block = Math.floor(i / PER);
    const limb = i % PER;
    const column = block % columns;
    const row = Math.floor(block / columns);

    const bx = (column / (columns - 1) - 0.5) * 23 + (rand(block + 11) - 0.5) * 0.55;
    const bz = (row / Math.max(1, Math.ceil(blocks / columns) - 1) - 0.5) * 13
      + (rand(block + 29) - 0.5) * 0.4;
    const by = (rand(block + 47) - 0.5) * 0.28;

    // A nine-point cross: centre, two along x, two along z, and four half-steps
    // so it holds its shape when the camera is low.
    const OFFSETS: [number, number][] = [
      [0, 0], [0.05, 0], [-0.05, 0], [0, 0.05], [0, -0.05],
      [0.025, 0], [-0.025, 0], [0, 0.025], [0, -0.025],
    ];
    const [ox, oz] = OFFSETS[limb];

    out[i * 3] = bx + ox;
    out[i * 3 + 1] = by;
    out[i * 3 + 2] = bz + oz;
  }

  return out;
}

export const SHAPES = [dot, ecg, cross, portals, city] as const;
