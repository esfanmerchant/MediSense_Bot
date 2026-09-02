/**
 * The floor plan, and the graph people are allowed to walk on.
 *
 * The demo this grew out of moved its characters by interpolating straight
 * lines between hand-typed coordinates, which is why they strolled through
 * walls. A straight line does not know a wall is there, and no amount of
 * nudging the coordinates fixes that — the next room you add breaks it again.
 *
 * So the building has an actual plan: a front row of rooms, a back row, and a
 * corridor between them, with one door per room. And movement is a *graph*.
 * Every place a person can stand is a node; every pair of nodes you can walk
 * between without crossing a wall is an edge. Characters are given a
 * destination, not a route: `route()` finds the way. A person can only ever be
 * on an edge, so walking through a wall stops being a bug you fix and becomes a
 * thing the model cannot express.
 *
 * The building faces +z. The road runs along z = 6.2; the entrance is the
 * double door at the middle of the front wall.
 */

export interface Room {
  id: number;
  key: "reception" | "records" | "icu" | "consultation" | "pharmacy" | "admin";
  /** Centre of the room's floor. */
  x: number;
  z: number;
  w: number;
  d: number;
  /** Floor tint, and the swatch on the room's chip. */
  colour: number;
  /** The waypoint just outside its door, and the one just inside. */
  door: string;
  inside: string;
}

export const BUILDING = { w: 10.4, d: 7.2, wall: 1.25 };

/** Where the front wall is, and how wide the entrance opening is. */
export const ENTRANCE = { z: 3.6, width: 1.9 };

/** The corridor runs the width of the building between the two rows. */
export const CORRIDOR = { z: 0, halfDepth: 0.55 };

export const ROOMS: Room[] = [
  {
    id: 1,
    key: "reception",
    x: 0,
    z: 2.05,
    w: 3.2,
    d: 2.5,
    colour: 0xffd9c7,
    door: "lobby",
    inside: "desk",
  },
  {
    id: 2,
    key: "records",
    x: -3.45,
    z: 2.05,
    w: 3.0,
    d: 2.5,
    colour: 0xfff1c2,
    door: "d.records",
    inside: "in.records",
  },
  {
    id: 3,
    key: "icu",
    x: -3.45,
    z: -1.85,
    w: 3.0,
    d: 2.9,
    colour: 0xd6e9ff,
    door: "d.icu",
    inside: "in.icu",
  },
  {
    id: 4,
    key: "consultation",
    x: 0,
    z: -1.85,
    w: 3.2,
    d: 2.9,
    colour: 0xe6e0ff,
    door: "d.consult",
    inside: "in.consult",
  },
  {
    id: 5,
    key: "pharmacy",
    x: 3.45,
    z: 2.05,
    w: 3.0,
    d: 2.5,
    colour: 0xcff3ea,
    door: "d.pharmacy",
    inside: "in.pharmacy",
  },
  {
    id: 6,
    key: "admin",
    x: 3.45,
    z: -1.85,
    w: 3.0,
    d: 2.9,
    colour: 0xd6e9ff,
    door: "d.admin",
    inside: "in.admin",
  },
];

export interface Node {
  x: number;
  z: number;
  /** True where a door swings — used to open the door as somebody passes. */
  door?: Room["key"];
}

/**
 * Every place a person can stand.
 *
 * The names are the plan read aloud: `d.` is a doorway, `in.` is inside a room,
 * `c.` is a point in the corridor. Anything a character is told to walk to is
 * one of these strings.
 */
export const NODES: Record<string, Node> = {
  "road.w": { x: -13, z: 6.2 },
  "road.e": { x: 13, z: 6.2 },
  gate: { x: 0, z: 4.8 },
  entrance: { x: 0, z: 3.62, door: "reception" },
  lobby: { x: 0, z: 2.95 },
  desk: { x: 0.35, z: 2.25 },
  "wait.a": { x: -1.15, z: 2.75 },
  "wait.b": { x: -1.15, z: 2.15 },

  // The lobby opens onto the corridor through the middle of the plan.
  "c.mid": { x: 0, z: CORRIDOR.z },
  "c.midleft": { x: -1.75, z: CORRIDOR.z },
  "c.midright": { x: 1.75, z: CORRIDOR.z },
  "c.left": { x: -3.45, z: CORRIDOR.z },
  "c.right": { x: 3.45, z: CORRIDOR.z },

  "d.records": { x: -3.45, z: 0.72, door: "records" },
  "d.pharmacy": { x: 3.45, z: 0.72, door: "pharmacy" },
  "d.icu": { x: -3.45, z: -0.42, door: "icu" },
  "d.consult": { x: 0, z: -0.42, door: "consultation" },
  "d.admin": { x: 3.45, z: -0.42, door: "admin" },

  "in.records": { x: -3.45, z: 1.6 },
  "in.pharmacy": { x: 3.3, z: 1.35 },
  "in.icu": { x: -2.75, z: -1.45 },
  "in.consult": { x: -0.15, z: -1.15 },
  "in.admin": { x: 3.3, z: -1.25 },
};

/**
 * Which nodes you can walk between.
 *
 * Written one line per corridor run rather than as a big pair list, because
 * this is the part that has to be *read* against the plan when a room moves.
 */
const LINKS: [string, string][] = [
  ["road.w", "gate"],
  ["gate", "road.e"],
  ["gate", "entrance"],
  ["entrance", "lobby"],
  ["lobby", "desk"],
  ["lobby", "wait.a"],
  ["wait.a", "wait.b"],
  ["lobby", "c.mid"],

  ["c.mid", "c.midleft"],
  ["c.midleft", "c.left"],
  ["c.mid", "c.midright"],
  ["c.midright", "c.right"],

  ["c.left", "d.records"],
  ["d.records", "in.records"],
  ["c.right", "d.pharmacy"],
  ["d.pharmacy", "in.pharmacy"],
  ["c.left", "d.icu"],
  ["d.icu", "in.icu"],
  ["c.mid", "d.consult"],
  ["d.consult", "in.consult"],
  ["c.right", "d.admin"],
  ["d.admin", "in.admin"],
];

const NEIGHBOURS: Record<string, string[]> = (() => {
  const map: Record<string, string[]> = {};
  for (const name of Object.keys(NODES)) map[name] = [];
  for (const [a, b] of LINKS) {
    map[a].push(b);
    map[b].push(a);
  }
  return map;
})();

/**
 * The shortest walk from one node to another, as a list of node names.
 *
 * Breadth-first, because the graph is twenty-five nodes and every edge is a
 * short walk down a corridor — the cheapest correct answer is the right one,
 * and A* here would be arithmetic nobody can check by eye.
 *
 * Routes are computed once at startup and reused, so the cost is irrelevant;
 * what matters is that a route is *only* ever a sequence of real edges.
 */
export function route(from: string, to: string): string[] {
  if (from === to) return [from];
  const previous: Record<string, string | null> = { [from]: null };
  const queue = [from];

  while (queue.length > 0) {
    const at = queue.shift()!;
    for (const next of NEIGHBOURS[at] ?? []) {
      if (next in previous) continue;
      previous[next] = at;
      if (next === to) {
        const path = [to];
        let step: string | null = at;
        while (step !== null) {
          path.unshift(step);
          step = previous[step];
        }
        return path;
      }
      queue.push(next);
    }
  }
  // Unreachable in a connected plan; returning the start rather than throwing
  // keeps a typo in an itinerary from taking the whole hero down.
  return [from];
}

/** A full itinerary expanded into every node it actually passes through. */
export function walkThrough(stops: string[]): string[] {
  const full: string[] = [stops[0]];
  for (let i = 1; i < stops.length; i++) {
    const leg = route(stops[i - 1], stops[i]);
    full.push(...leg.slice(1));
  }
  return full;
}
