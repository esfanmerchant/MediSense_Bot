/**
 * The hospital, built out of boxes.
 *
 * Every object here is authored in code rather than loaded as a model, and that
 * is a decision rather than a shortcut. A GLB hospital with rigged staff is a
 * better-looking building and a worse *component*: several megabytes to fetch
 * before the first screen of a landing page resolves, a Blender file that has to
 * be re-exported to move a door, and an asset licence to carry. Boxes cost
 * nothing, ship with the bundle, and — the part that matters — the plan in
 * `plan.ts` stays the only place the walls are described, so the rooms and the
 * routes people walk through them cannot drift apart.
 *
 * Roles are legible by uniform, because nothing else in a scene this small reads
 * at a glance: doctors in a white coat over pale scrubs, nurses in clinical red,
 * reception in a navy tabard, patients in pastels, and the one in the ICU bed in
 * a hospital gown.
 */

import * as THREE from "three";

import { BUILDING, ENTRANCE, NODES, ROOMS, type Room } from "./plan";

export const UNIFORM = {
  doctorCoat: 0xffffff,
  doctorScrubs: 0xbdd9f2,
  nurse: 0xc0392b,
  nurseTrim: 0xf7f2ef,
  desk: 0x213a63,
  gown: 0xdcecf7,
  medic: 0xf5f7fa,
  medicStripe: 0xc0392b,
} as const;

const PATIENT_COLOURS = [0xffb08f, 0x9fd8c4, 0xf3c969, 0xa9b8e8, 0xe8b4c8, 0xf0a58f];
const SKIN = [0xf1c9a5, 0xdba97c, 0xc08552, 0xf6d5b8, 0xa9704a];

export function material(colour: number, extra: THREE.MeshStandardMaterialParameters = {}) {
  return new THREE.MeshStandardMaterial({ color: colour, roughness: 0.86, metalness: 0, ...extra });
}

export function box(
  w: number,
  h: number,
  d: number,
  colour: number,
  x = 0,
  y = 0,
  z = 0,
  extra: THREE.MeshStandardMaterialParameters = {},
) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material(colour, extra));
  mesh.position.set(x, y, z);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

function cylinder(r: number, h: number, colour: number, x = 0, y = 0, z = 0) {
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, 14), material(colour));
  mesh.position.set(x, y, z);
  mesh.castShadow = true;
  return mesh;
}

/**
 * A small canvas a screen can display.
 *
 * Every monitor in the building runs one of these. A flat emissive rectangle
 * reads as a prop; a rectangle with three moving bars on it reads as a computer
 * somebody is using, which is the whole difference between a model of a
 * hospital and a hospital that is open.
 */
export function screenTexture(draw: (ctx: CanvasRenderingContext2D, t: number) => void) {
  const canvas = document.createElement("canvas");
  canvas.width = 192;
  canvas.height = 128;
  const ctx = canvas.getContext("2d")!;
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return {
    texture,
    update(t: number) {
      draw(ctx, t);
      texture.needsUpdate = true;
    },
  };
}

export interface Person {
  group: THREE.Group;
  legs: [THREE.Mesh, THREE.Mesh];
}

/** One person: a torso, a head, two legs that swing, and their uniform. */
export function person(kind: "doctor" | "nurse" | "desk" | "patient" | "medic", seed = 0): Person {
  const group = new THREE.Group();
  const skin = SKIN[seed % SKIN.length];

  const body =
    kind === "doctor"
      ? UNIFORM.doctorScrubs
      : kind === "nurse"
        ? UNIFORM.nurse
        : kind === "desk"
          ? 0xffffff
          : kind === "medic"
            ? UNIFORM.medic
            : PATIENT_COLOURS[seed % PATIENT_COLOURS.length];

  const torso = new THREE.Mesh(new THREE.CylinderGeometry(0.115, 0.135, 0.36, 14), material(body));
  torso.position.y = 0.39;
  torso.castShadow = true;
  group.add(torso);

  if (kind === "doctor") {
    // The coat hangs open over the scrubs — two front panels and a back, rather
    // than a second cylinder, so the blue still shows down the middle.
    group.add(box(0.09, 0.34, 0.16, UNIFORM.doctorCoat, -0.1, 0.39, 0.02));
    group.add(box(0.09, 0.34, 0.16, UNIFORM.doctorCoat, 0.1, 0.39, 0.02));
    group.add(box(0.17, 0.32, 0.1, UNIFORM.doctorCoat, 0, 0.39, -0.1));
    group.add(box(0.2, 0.03, 0.03, 0x2b3a67, 0, 0.55, 0.05));
    const badge = new THREE.Mesh(
      new THREE.SphereGeometry(0.028, 8, 8),
      material(0x14c4c1, { emissive: 0x14c4c1, emissiveIntensity: 0.9 }),
    );
    badge.position.set(0.07, 0.47, 0.12);
    group.add(badge);
  }
  if (kind === "nurse") {
    group.add(box(0.24, 0.05, 0.24, UNIFORM.nurseTrim, 0, 0.56, 0));
    group.add(box(0.1, 0.04, 0.02, UNIFORM.nurseTrim, 0, 0.47, 0.13));
  }
  if (kind === "desk") {
    group.add(box(0.21, 0.28, 0.18, UNIFORM.desk, 0, 0.4, 0));
  }
  if (kind === "medic") {
    group.add(box(0.27, 0.05, 0.27, UNIFORM.medicStripe, 0, 0.44, 0));
  }

  const head = new THREE.Mesh(new THREE.SphereGeometry(0.12, 14, 14), material(skin));
  head.position.y = 0.67;
  head.castShadow = true;
  group.add(head);

  // Two dots is enough of a face at this distance; more detail reads as a doll.
  for (const side of [-0.045, 0.045]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.016, 8, 8), material(0x1a2438));
    eye.position.set(side, 0.69, 0.105);
    group.add(eye);
  }

  const legColour = kind === "patient" ? 0x3b4664 : 0x2b3a67;
  const legs: [THREE.Mesh, THREE.Mesh] = [
    box(0.07, 0.23, 0.07, legColour, -0.05, 0.115, 0),
    box(0.07, 0.23, 0.07, legColour, 0.05, 0.115, 0),
  ];
  legs.forEach((leg) => group.add(leg));

  return { group, legs };
}

export interface Built {
  world: THREE.Group;
  /** Room floors, for hover picking. */
  floors: THREE.Mesh[];
  /** The swinging half of each room's door, keyed by room. */
  doors: Map<string, THREE.Group>;
  screens: { update: (t: number) => void }[];
  icu: {
    monitor: THREE.MeshStandardMaterial;
    chest: THREE.Mesh;
    /** Switches the bedside trace, and its colour, between calm and alarmed. */
    setCritical: (on: boolean) => void;
  };
  night: {
    windows: THREE.MeshStandardMaterial[];
    lamps: THREE.PointLight[];
    signGlow: THREE.MeshStandardMaterial;
  };
  ground: THREE.MeshStandardMaterial;
  plaza: THREE.MeshStandardMaterial;
  scanner: THREE.Mesh;
  leaf: THREE.Mesh;
  ambulance: { group: THREE.Group; beacon: THREE.MeshStandardMaterial };
  rooms: THREE.Group[];
}

/**
 * A door in its frame.
 *
 * The panel is a child of a pivot sitting at the hinge, so opening it is one
 * rotation rather than a position and a rotation that have to agree.
 */
function door(width: number, key: string, doors: Map<string, THREE.Group>) {
  const group = new THREE.Group();
  const pivot = new THREE.Group();
  pivot.position.x = -width / 2;
  pivot.add(box(width, 0.86, 0.05, 0xf7f4ef, width / 2, 0.43, 0));
  group.add(pivot);
  group.add(box(0.06, 0.94, 0.1, 0xd8d0c2, -width / 2 - 0.03, 0.47, 0));
  group.add(box(0.06, 0.94, 0.1, 0xd8d0c2, width / 2 + 0.03, 0.47, 0));
  group.add(box(width + 0.12, 0.06, 0.1, 0xd8d0c2, 0, 0.94, 0));
  doors.set(key, pivot);
  return group;
}

export function buildHospital(): Built {
  const world = new THREE.Group();
  const floors: THREE.Mesh[] = [];
  const doors = new Map<string, THREE.Group>();
  const screens: Built["screens"] = [];
  const windows: THREE.MeshStandardMaterial[] = [];
  const lamps: THREE.PointLight[] = [];
  const rooms: THREE.Group[] = [];

  /* ---- ground, plaza, road -------------------------------------------- */
  const ground = box(23, 0.3, 15.5, 0xb6e6d8, 0, -0.15, 0);
  ground.castShadow = false;
  world.add(ground);
  const plaza = box(12.6, 0.06, 9.4, 0xe6ded1, 0, 0.03, 0.6);
  plaza.castShadow = false;
  world.add(plaza);
  const road = box(23, 0.05, 1.8, 0x5b6577, 0, 0.03, 6.2);
  road.castShadow = false;
  world.add(road);
  for (let x = -10.5; x < 10.5; x += 2) world.add(box(1, 0.06, 0.12, 0xfff1c2, x, 0.06, 6.2));

  for (const [x, z] of [
    [-9, -4],
    [-9.4, 1.4],
    [9, -4.6],
    [9.6, 0.6],
    [-7.4, 5],
    [7.6, 5.1],
    [-10, -1.6],
    [10, -2.2],
  ]) {
    const tree = new THREE.Group();
    tree.add(box(0.16, 0.5, 0.16, 0xa77b57, 0, 0.25, 0));
    const crown = new THREE.Mesh(new THREE.SphereGeometry(0.56, 14, 14), material(0x7fd8c0));
    crown.position.y = 0.86;
    crown.castShadow = true;
    tree.add(crown);
    tree.position.set(x, 0, z);
    world.add(tree);
  }

  /* ---- shell ----------------------------------------------------------- */
  const shell = new THREE.Group();
  world.add(shell);
  shell.add(box(BUILDING.w, 0.12, BUILDING.d, 0xf3eee6, 0, 0.12, 0));
  shell.add(box(BUILDING.w + 0.2, 0.05, BUILDING.d + 0.2, 0xd9d0c3, 0, 0.06, 0));

  const wallY = 0.18 + BUILDING.wall / 2;
  const back = -BUILDING.d / 2;
  const front = BUILDING.d / 2;
  shell.add(box(BUILDING.w, BUILDING.wall, 0.12, 0xe9e2d8, 0, wallY, back));
  shell.add(box(0.12, BUILDING.wall, BUILDING.d, 0xe9e2d8, -BUILDING.w / 2, wallY, 0));
  shell.add(box(0.12, BUILDING.wall, BUILDING.d, 0xe9e2d8, BUILDING.w / 2, wallY, 0));

  // The front wall, with the entrance cut out of the middle of it. A doorway
  // has to be a hole in a wall, not a decal on one — otherwise the first person
  // to walk in walks through render order rather than through a door.
  const sideRun = (BUILDING.w - ENTRANCE.width) / 2;
  for (const sign of [-1, 1]) {
    shell.add(
      box(
        sideRun,
        BUILDING.wall,
        0.12,
        0xe9e2d8,
        sign * (ENTRANCE.width / 2 + sideRun / 2),
        wallY,
        front,
      ),
    );
  }
  shell.add(box(ENTRANCE.width + 0.3, 0.24, 0.14, 0xe9e2d8, 0, 0.18 + BUILDING.wall - 0.12, front));
  // A canopy, kept small and low. Scaled up it stops reading as shelter over a
  // door and starts reading as a table parked on the forecourt.
  shell.add(box(ENTRANCE.width + 0.6, 0.07, 0.5, 0xf7f4ef, 0, 1.3, front + 0.24));
  for (const sign of [-1, 1]) {
    shell.add(box(0.05, 1.16, 0.05, 0xd8d0c2, sign * (ENTRANCE.width / 2 + 0.2), 0.65, front + 0.42));
  }
  // Two glass leaves, parked open against the jambs.
  for (const sign of [-1, 1]) {
    shell.add(
      box(0.05, 0.9, 0.07, 0xcfe3f2, sign * (ENTRANCE.width / 2 - 0.06), 0.63, front, {
        transparent: true,
        opacity: 0.5,
      }),
    );
  }

  shell.add(box(BUILDING.w + 0.1, 0.06, 0.16, 0xb7c7d9, 0, 0.18 + BUILDING.wall, back));
  shell.add(box(0.16, 0.06, BUILDING.d + 0.1, 0xb7c7d9, -BUILDING.w / 2, 0.18 + BUILDING.wall, 0));
  shell.add(box(0.16, 0.06, BUILDING.d + 0.1, 0xb7c7d9, BUILDING.w / 2, 0.18 + BUILDING.wall, 0));

  for (let x = -4.2; x <= 4.2; x += 1.4) {
    const pane = box(0.72, 0.5, 0.04, 0xd6e9ff, x, 0.9, back + 0.05, {
      emissive: 0xffb866,
      emissiveIntensity: 0,
    });
    shell.add(pane);
    windows.push(pane.material as THREE.MeshStandardMaterial);
  }

  /* ---- rooms ----------------------------------------------------------- */
  const partitionY = 0.18 + 0.45;
  for (const room of ROOMS) {
    const group = new THREE.Group();
    group.position.set(room.x, 0, room.z);
    rooms.push(group);

    const floor = box(room.w, 0.06, room.d, room.colour, 0, 0.21, 0);
    floor.castShadow = false;
    floor.userData.room = room;
    floors.push(floor);
    group.add(floor);

    // The wall onto the corridor, with its doorway taken out and a door hung in
    // the gap. Reception is left open, because it *is* the lobby.
    const corridorSide = room.z > 0 ? -room.d / 2 : room.d / 2;
    const gap = 0.95;
    if (room.key !== "reception") {
      const run = (room.w - gap) / 2;
      for (const sign of [-1, 1]) {
        group.add(box(run, 0.9, 0.08, 0xe9e2d8, sign * (gap / 2 + run / 2), partitionY, corridorSide));
      }
      const swing = door(gap - 0.08, room.key, doors);
      swing.position.set(0, 0.18, corridorSide);
      group.add(swing);
    }

    // The walls between neighbours in the same row.
    if (room.x < 0) group.add(box(0.08, 0.9, room.d, 0xe9e2d8, room.w / 2, partitionY, 0));
    if (room.x > 0) group.add(box(0.08, 0.9, room.d, 0xe9e2d8, -room.w / 2, partitionY, 0));

    shell.add(group);
  }

  const at = (key: Room["key"]) => rooms[ROOMS.findIndex((r) => r.key === key)];

  /* ---- reception -------------------------------------------------------- */
  {
    const g = at("reception");
    g.add(box(1.9, 0.52, 0.44, 0xffffff, 0.35, 0.5, 0.2));
    g.add(box(1.9, 0.06, 0.54, 0x9fe3dd, 0.35, 0.79, 0.2));
    for (const [x, z] of [
      [-1.15, 0.75],
      [-1.15, 0.15],
      [-1.15, -0.45],
      [-0.6, -0.78],
    ]) {
      g.add(box(0.34, 0.08, 0.34, 0x9cc6ff, x, 0.43, z));
      g.add(box(0.34, 0.34, 0.06, 0x9cc6ff, x - 0.2, 0.63, z));
    }
    g.add(cylinder(0.15, 0.28, 0xd6a27a, 1.35, 0.35, -0.82));
    const leaf = new THREE.Mesh(new THREE.SphereGeometry(0.25, 12, 12), material(0x7fd8c0));
    leaf.position.set(1.35, 0.68, -0.82);
    leaf.castShadow = true;
    g.add(leaf);
    g.add(monitor(0.75, 0.99, 0.15, screens, (ctx, t) => uiRows(ctx, t, "#1a8fc7")));
    g.userData.leaf = leaf;
  }

  /* ---- records ---------------------------------------------------------- */
  const scanner = box(0.44, 0.09, 0.32, 0x7fd8c0, 0.55, 0.79, 0.55);
  {
    const g = at("records");
    for (const x of [-1, -0.5, 0, 0.5]) {
      g.add(box(0.42, 0.92, 0.4, 0xffffff, x, 0.67, -0.75));
      for (let k = 0; k < 3; k++) g.add(box(0.34, 0.04, 0.42, 0xd9d2c5, x, 0.37 + k * 0.27, -0.75));
    }
    g.add(box(1.1, 0.06, 0.62, 0xffffff, 0.55, 0.73, 0.55));
    g.add(box(0.06, 0.5, 0.06, 0x14213d, 0.1, 0.46, 0.55));
    g.add(box(0.06, 0.5, 0.06, 0x14213d, 1, 0.46, 0.55));
    g.add(scanner);
    g.add(monitor(-0.25, 0.93, 0.5, screens, (ctx, t) => uiScan(ctx, t)));
  }

  /* ---- ICU -------------------------------------------------------------- */
  // The bedside monitor runs a trace of its own rather than glowing a flat
  // colour, and turns red with the rest of the room. A screen beside a patient
  // is the one prop in the building nobody will accept as a lit rectangle.
  let icuCritical = false;
  const icuScreen = screenTexture((ctx, t) => uiVitals(ctx, t, icuCritical));
  const icuMonitorMaterial = material(0x0f1a2e, {
    emissive: 0xffffff,
    emissiveIntensity: 0.8,
    map: icuScreen.texture,
    emissiveMap: icuScreen.texture,
  });
  const chest = box(0.54, 0.15, 0.46, UNIFORM.gown);
  {
    const g = at("icu");

    // The bed. Frame, mattress, a headrest raised about twenty-five degrees,
    // rails, a pillow — the things that make a bed read as a hospital bed
    // rather than a table with a person on it.
    const bed = new THREE.Group();
    bed.position.set(-0.5, 0, -0.15);
    bed.rotation.y = Math.PI / 2;
    bed.add(box(1.85, 0.16, 0.82, 0xf2f4f7, 0, 0.44, 0));
    bed.add(box(1.8, 0.12, 0.78, 0xdbe9f5, 0, 0.57, 0));
    const headrest = box(0.5, 0.1, 0.78, 0xdbe9f5, -0.62, 0.65, 0);
    headrest.rotation.z = -0.44;
    bed.add(headrest);
    bed.add(box(0.34, 0.09, 0.5, 0xffffff, -0.74, 0.78, 0));
    for (const side of [-1, 1]) {
      bed.add(box(0.9, 0.04, 0.03, 0xc7d3e0, 0.12, 0.71, side * 0.42));
      bed.add(box(0.04, 0.13, 0.03, 0xc7d3e0, -0.32, 0.64, side * 0.42));
      bed.add(box(0.04, 0.13, 0.03, 0xc7d3e0, 0.56, 0.64, side * 0.42));
    }
    for (const [x, z] of [
      [-0.8, 0.35],
      [-0.8, -0.35],
      [0.8, 0.35],
      [0.8, -0.35],
    ]) {
      bed.add(box(0.07, 0.36, 0.07, 0x9aa7b8, x, 0.18, z));
    }

    // The patient, lying down: head on the pillow, sheet over the legs, and a
    // chest that rises and falls. The rise is what makes them a patient rather
    // than a prop.
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.13, 14, 14), material(SKIN[2]));
    head.position.set(-0.68, 0.89, 0);
    head.castShadow = true;
    chest.position.set(-0.24, 0.72, 0);
    bed.add(head, chest, box(0.88, 0.11, 0.52, 0xb9d2e8, 0.38, 0.7, 0));
    g.add(bed);

    // Vitals on a pole at the head of the bed.
    const pole = new THREE.Group();
    pole.position.set(0.85, 0, -0.95);
    pole.add(box(0.06, 1.05, 0.06, 0x14213d, 0, 0.55, 0));
    pole.add(box(0.24, 0.06, 0.24, 0x14213d, 0, 0.04, 0));
    pole.add(box(0.56, 0.4, 0.05, 0x14213d, 0, 1.2, 0));
    const glass = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.34, 0.012), icuMonitorMaterial);
    glass.position.set(0, 1.2, 0.032);
    pole.add(glass);
    g.add(pole);

    // A drip stand, with a line running down to the arm.
    const iv = new THREE.Group();
    iv.position.set(-1.2, 0, 0.75);
    iv.add(box(0.05, 1.35, 0.05, 0xb8c2d0, 0, 0.68, 0));
    iv.add(box(0.26, 0.04, 0.26, 0xb8c2d0, 0, 0.03, 0));
    iv.add(box(0.16, 0.28, 0.09, 0xd9edda, 0.02, 1.2, 0));
    const line = box(0.02, 0.55, 0.02, 0xdfe6ee, 0.18, 0.92, 0.05);
    line.rotation.z = -0.55;
    iv.add(line);
    g.add(iv);

    g.add(box(0.5, 0.7, 0.42, 0xffffff, 1.2, 0.56, 0.85));
    g.add(box(0.5, 0.04, 0.42, 0xd9e6f2, 1.2, 0.93, 0.85));
  }

  /* ---- consultation ------------------------------------------------------ */
  {
    const g = at("consultation");
    g.add(box(1.5, 0.06, 0.72, 0xd6e9ff, -0.15, 0.77, -0.6));
    g.add(box(0.06, 0.56, 0.06, 0x14213d, -0.8, 0.46, -0.6));
    g.add(box(0.06, 0.56, 0.06, 0x14213d, 0.5, 0.46, -0.6));
    g.add(monitor(-0.15, 1, -0.72, screens, (ctx, t) => uiChart(ctx, t)));
    for (const [x, z] of [
      [-0.15, 0.1],
      [0.55, 0.1],
    ]) {
      g.add(box(0.36, 0.08, 0.36, 0xe6e0ff, x, 0.42, z));
      g.add(box(0.36, 0.32, 0.06, 0xe6e0ff, x, 0.62, z + 0.16));
    }
    // An examination couch along the side wall.
    g.add(box(0.62, 0.14, 1.4, 0xf2f4f7, 1.15, 0.5, 0.35));
    g.add(box(0.58, 0.1, 1.36, 0xdbe9f5, 1.15, 0.61, 0.35));
    for (const [x, z] of [
      [0.9, -0.25],
      [0.9, 0.95],
      [1.4, -0.25],
      [1.4, 0.95],
    ]) {
      g.add(box(0.07, 0.4, 0.07, 0x9aa7b8, x, 0.2, z));
    }
  }

  /* ---- pharmacy ---------------------------------------------------------- */
  {
    const g = at("pharmacy");
    for (const x of [-0.95, 0.05, 1]) {
      g.add(box(0.72, 1, 0.36, 0xffffff, x, 0.7, -0.85));
      for (let k = 0; k < 3; k++) {
        g.add(box(0.62, 0.03, 0.37, 0xd9d2c5, x, 0.42 + k * 0.28, -0.85));
        for (let j = 0; j < 3; j++) {
          g.add(
            box(
              0.12,
              0.17,
              0.12,
              [0x14c4c1, 0x1a8fc7, 0xf5a524][(j + k) % 3],
              x - 0.2 + j * 0.2,
              0.53 + k * 0.28,
              -0.85,
            ),
          );
        }
      }
    }
    g.add(box(2.3, 0.52, 0.42, 0xffffff, 0, 0.5, 0.62));
    g.add(box(2.3, 0.06, 0.52, 0x9fe3dd, 0, 0.79, 0.62));
    g.add(monitor(-0.8, 0.99, 0.57, screens, (ctx, t) => uiRows(ctx, t, "#14c4c1")));
  }

  /* ---- admin -------------------------------------------------------------- */
  {
    const g = at("admin");
    g.add(box(2.3, 0.06, 0.72, 0xd6e9ff, 0, 0.77, -0.55));
    g.add(box(0.06, 0.56, 0.06, 0x14213d, -1.05, 0.46, -0.55));
    g.add(box(0.06, 0.56, 0.06, 0x14213d, 1.05, 0.46, -0.55));
    g.add(monitor(-0.55, 1, -0.67, screens, (ctx, t) => uiRows(ctx, t, "#0b3fa8")));
    g.add(monitor(0.55, 1, -0.67, screens, (ctx, t) => uiRows(ctx, t, "#1a8fc7")));
    g.add(box(1.5, 0.86, 0.05, 0x14213d, 0, 1.06, -1.36));
    const audit = screenTexture((ctx, t) => uiAudit(ctx, t));
    const wallGlass = new THREE.Mesh(
      new THREE.BoxGeometry(1.38, 0.74, 0.012),
      material(0x0f1a2e, {
        emissive: 0xffffff,
        emissiveIntensity: 0.7,
        map: audit.texture,
        emissiveMap: audit.texture,
      }),
    );
    wallGlass.position.set(0, 1.06, -1.33);
    g.add(wallGlass);
    screens.push({ update: audit.update });
  }

  /* ---- sign and lamps ------------------------------------------------------ */
  const sign = new THREE.Group();
  sign.position.set(-6.4, 0, 3.9);
  sign.add(box(0.08, 2.6, 0.08, 0x14213d, 0, 1.3, 0));
  sign.add(box(0.92, 0.92, 0.12, 0xffffff, 0, 2.7, 0));
  const signGlow = material(0x14c4c1, { emissive: 0x14c4c1, emissiveIntensity: 0 });
  const crossA = new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.17, 0.14), signGlow);
  crossA.position.set(0, 2.7, 0.02);
  const crossB = new THREE.Mesh(new THREE.BoxGeometry(0.17, 0.52, 0.14), signGlow);
  crossB.position.set(0, 2.7, 0.02);
  sign.add(crossA, crossB);
  world.add(sign);

  for (const [x, z] of [
    [-3.45, -1.85],
    [0, 2.05],
    [3.45, -1.85],
    [0, -1.85],
  ]) {
    const lamp = new THREE.PointLight(0xffb866, 0, 6, 2);
    lamp.position.set(x, 1.5, z);
    world.add(lamp);
    lamps.push(lamp);
  }

  /* ---- ambulance ------------------------------------------------------------ */
  const ambulance = new THREE.Group();
  ambulance.add(box(1.35, 0.55, 0.62, 0xffffff, 0, 0.42, 0));
  ambulance.add(box(0.5, 0.38, 0.58, 0xffffff, -0.85, 0.33, 0));
  ambulance.add(box(0.34, 0.11, 0.63, 0xe5484d, 0.12, 0.55, 0));
  ambulance.add(box(0.11, 0.34, 0.63, 0xe5484d, 0.12, 0.55, 0));
  for (const [x, z] of [
    [-0.68, 0.28],
    [-0.68, -0.28],
    [0.45, 0.28],
    [0.45, -0.28],
  ]) {
    const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.14, 0.1, 12), material(0x14213d));
    wheel.rotation.x = Math.PI / 2;
    wheel.position.set(x, 0.14, z);
    ambulance.add(wheel);
  }
  const beaconMaterial = material(0xe5484d, { emissive: 0xe5484d, emissiveIntensity: 0.6 });
  const beacon = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.08, 0.22), beaconMaterial);
  beacon.position.set(-0.24, 0.73, 0);
  ambulance.add(beacon);
  ambulance.position.set(-13, 0, 6.2);
  world.add(ambulance);

  const leaf = at("reception").userData.leaf as THREE.Mesh;

  screens.push({ update: icuScreen.update });

  return {
    world,
    floors,
    doors,
    screens,
    icu: {
      monitor: icuMonitorMaterial,
      chest,
      setCritical(on: boolean) {
        icuCritical = on;
      },
    },
    night: { windows, lamps, signGlow },
    ground: ground.material as THREE.MeshStandardMaterial,
    plaza: plaza.material as THREE.MeshStandardMaterial,
    scanner,
    leaf,
    ambulance: { group: ambulance, beacon: beaconMaterial },
    rooms,
  };
}

/** A desk monitor whose screen shows a small live interface. */
function monitor(
  x: number,
  y: number,
  z: number,
  screens: Built["screens"],
  draw: (ctx: CanvasRenderingContext2D, t: number) => void,
) {
  const group = new THREE.Group();
  group.position.set(x, y, z);
  group.add(box(0.5, 0.34, 0.04, 0x14213d));
  const painted = screenTexture(draw);
  const glass = new THREE.Mesh(
    new THREE.BoxGeometry(0.44, 0.28, 0.012),
    material(0x0f1a2e, {
      emissive: 0xffffff,
      emissiveIntensity: 0.75,
      map: painted.texture,
      emissiveMap: painted.texture,
    }),
  );
  glass.position.z = 0.028;
  group.add(glass);
  group.add(box(0.06, 0.18, 0.06, 0x14213d, 0, -0.25, 0));
  screens.push({ update: painted.update });
  return group;
}

/* -- the little interfaces the screens show -------------------------------- */

function ground2d(ctx: CanvasRenderingContext2D) {
  ctx.fillStyle = "#0d1730";
  ctx.fillRect(0, 0, 192, 128);
}

function uiRows(ctx: CanvasRenderingContext2D, t: number, accent: string) {
  ground2d(ctx);
  ctx.fillStyle = accent;
  ctx.fillRect(12, 12, 60, 8);
  ctx.fillStyle = "#31415f";
  for (let i = 0; i < 5; i++) ctx.fillRect(12, 34 + i * 16, 118 + Math.sin(t + i) * 22, 7);
  ctx.fillStyle = accent;
  ctx.fillRect(12, 112, 20 + (Math.sin(t * 1.2) * 0.5 + 0.5) * 88, 7);
}

function uiScan(ctx: CanvasRenderingContext2D, t: number) {
  ground2d(ctx);
  ctx.fillStyle = "#1c2a49";
  ctx.fillRect(14, 14, 74, 100);
  ctx.fillStyle = "#3d5party".slice(0, 7);
  for (let i = 0; i < 6; i++) ctx.fillRect(20, 24 + i * 15, 40 + ((i * 13) % 24), 6);
  ctx.fillStyle = "#14c4c1";
  ctx.fillRect(14, 14 + ((t * 40) % 100), 74, 3);
  ctx.fillStyle = "#8fb6ff";
  for (let i = 0; i < 4; i++) ctx.fillRect(100, 26 + i * 22, 66, 12);
}

function uiChart(ctx: CanvasRenderingContext2D, t: number) {
  ground2d(ctx);
  ctx.strokeStyle = "#3fd6d3";
  ctx.lineWidth = 2;
  ctx.beginPath();
  for (let x = 0; x < 192; x++) {
    const phase = (x / 60 + t * 0.6) % 1;
    let y = 62;
    if (phase < 0.08) y = 62 - Math.sin((phase / 0.08) * Math.PI) ** 2 * 30;
    else if (phase < 0.14) y = 62 + Math.sin(((phase - 0.08) / 0.06) * Math.PI) * 12;
    if (x === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
  ctx.fillStyle = "#8fb6ff";
  ctx.fillRect(12, 96, 90, 8);
  ctx.fillRect(12, 110, 54, 8);
}

function uiVitals(ctx: CanvasRenderingContext2D, t: number, critical: boolean) {
  ground2d(ctx);
  ctx.strokeStyle = critical ? "#ff6b6b" : "#3fd6d3";
  ctx.lineWidth = 2;
  ctx.beginPath();
  for (let x = 0; x < 192; x++) {
    const phase = (x / (critical ? 34 : 52) + t * (critical ? 1.5 : 0.9)) % 1;
    let y = 46;
    if (phase < 0.08) y = 46 - Math.sin((phase / 0.08) * Math.PI) ** 2 * 26;
    else if (phase < 0.14) y = 46 + Math.sin(((phase - 0.08) / 0.06) * Math.PI) * 10;
    if (x === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
  ctx.fillStyle = critical ? "#ff9a9a" : "#7fe5c6";
  ctx.font = "bold 26px monospace";
  ctx.fillText(critical ? "112" : "72", 14, 108);
  ctx.fillText(critical ? "91%" : "98%", 104, 108);
}

function uiAudit(ctx: CanvasRenderingContext2D, t: number) {
  ground2d(ctx);
  ctx.fillStyle = "#14c4c1";
  ctx.fillRect(12, 10, 70, 8);
  const offset = (t * 12) % 20;
  for (let i = 0; i < 6; i++) {
    const y = 28 + i * 20 - offset;
    if (y < 22 || y > 116) continue;
    ctx.fillStyle = "#2c3d5e";
    ctx.fillRect(12, y, 130, 9);
    ctx.fillStyle = "#5eead4";
    ctx.fillRect(150, y, 9, 9);
  }
}

export { NODES };
