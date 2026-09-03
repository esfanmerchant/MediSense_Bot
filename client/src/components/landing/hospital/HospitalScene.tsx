"use client";

/**
 * A hospital that is open, seen from the corner of the roof.
 *
 * Scroll walks the camera through it — overview, then each room in the order a
 * patient meets them, then back out. Meanwhile the building runs on its own:
 * patients arrive off the road, check in, wait, are seen, collect medicine and
 * leave; a nurse does her rounds; an ambulance calls; and every so often the
 * ICU monitor goes critical and the doctor walks there and back.
 *
 * **Nobody walks through a wall.** Movement is a route over the waypoint graph
 * in `plan.ts`, so a character can only ever be on an edge between two places
 * that are actually connected — through the entrance, along the corridor, and
 * in at a door. Doors swing as somebody reaches them, which is both nice to
 * watch and a running check that the route really did go through the doorway.
 *
 * **Raw three.js, not react-three-fiber.** The rest of the application's WebGL
 * is written this way and carries the failure handling a clinical product needs
 * — no context, reduced motion, hidden tab, disposal on unmount, capped pixel
 * ratio. Adding a renderer framework, a scroll library and a state library to
 * express the same scene would be some hundreds of kilobytes on the one page
 * that has to open fastest, and a second set of that discipline to maintain.
 *
 * **React never re-renders for the scroll or for the clock.** Progress arrives
 * through a ref the animation loop reads; the only thing that crosses back into
 * React is the stop the reader is on and the ICU's alert state, which the words
 * beside the scene need.
 */

import { useEffect, useRef } from "react";
import * as THREE from "three";

import { buildHospital, person, type Person } from "./build";
import { NODES, ROOMS, walkThrough, type Room } from "./plan";

/**
 * Where the camera stands for each stop, and what it looks at.
 *
 * The words live over the left third of the screen, so every shot is aimed to
 * put the building right of centre. Moving the *look-at* does that rather than
 * moving the camera: shifting the target along screen-left slides the subject
 * screen-right without changing the angle you see it from, which is the part
 * that makes the building read as a building.
 *
 * Screen-right, from this fixed three-quarter angle, is roughly +x −z. So the
 * offset below is its opposite, scaled by how far the subject has to clear the
 * text.
 */
const SHIFT_RIGHT = { x: -0.76, z: 0.65 };

function aimed(eye: readonly [number, number, number], at: readonly [number, number, number], clear: number) {
  return {
    eye,
    look: [at[0] + SHIFT_RIGHT.x * clear, at[1], at[2] + SHIFT_RIGHT.z * clear] as const,
  };
}

const OVERVIEW = aimed([22.5, 18.2, 23.5], [0.2, 0.9, -0.9], 2.2);

/**
 * Close enough to read the room, far enough to see it *is* a room.
 *
 * The first pass framed each stop from about eight units away and put the
 * camera inside the furniture: a desk filled the screen and nothing said which
 * room it belonged to. This stands back far enough that the walls and the door
 * are both in shot, which is the whole point of having built them.
 */
function roomShot(room: Room) {
  return aimed([room.x + 6.2, 6.7, room.z + 7.2], [room.x - 0.2, 0.5, room.z + 0.1], 1.85);
}

export const STOPS = [
  OVERVIEW,
  ...ROOMS.map(roomShot),
  aimed([21.5, 17.4, 22.5], [0.2, 0.9, -0.6], 2.2),
];

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
/** Eases both ends of a 0..1 run, so nothing starts or stops abruptly. */
const smoothstep = (t: number) => t * t * (3 - 2 * t);
const damp = (a: number, b: number, lambda: number, dt: number) =>
  a + (b - a) * (1 - Math.exp(-lambda * dt));

/** Arms swing against the legs, from the shoulder rather than the elbow. */
function swingArms(body: Person, angle: number) {
  body.arms[0].parent!.rotation.x = -angle;
  body.arms[1].parent!.rotation.x = angle;
}

/** A character walking a fixed loop over the graph. */
interface Walker {
  body: Person;
  /** Every node of the loop, already expanded through the corridor. */
  path: string[];
  at: number;
  /** 0..1 along the current edge. */
  along: number;
  speed: number;
  /** Seconds still to wait at the node just reached. */
  pause: number;
  /** Nodes where this character stops for a while, and for how long. */
  waits: Record<string, number>;
}

function makeWalker(
  kind: Parameters<typeof person>[0],
  stops: string[],
  speed: number,
  waits: Record<string, number>,
  seed: number,
  start = 0,
): Walker {
  return {
    body: person(kind, seed),
    path: walkThrough(stops),
    at: start,
    along: 0,
    speed,
    pause: 0,
    waits,
  };
}

export function HospitalScene({
  progress,
  stops,
  onStop,
  onHover,
  onAlert,
  onRoomClick,
  onUnsupported,
  dark,
}: {
  /** 0 → 1 across the pinned hero. Read every frame. */
  progress: React.RefObject<number>;
  stops: number;
  onStop: (index: number) => void;
  onHover: (room: Room | null) => void;
  onAlert: (critical: boolean) => void;
  onRoomClick: (room: Room) => void;
  /** Called when this machine cannot render the scene at a watchable rate. */
  onUnsupported: () => void;
  dark: boolean;
}) {
  const mount = useRef<HTMLDivElement | null>(null);

  // Callbacks and the theme live in refs, because a new function identity or a
  // flipped theme must never tear down and rebuild a WebGL context. Written
  // from an effect rather than during render: React 19 forbids the latter, and
  // is right to — a ref written mid-render is a value that disagrees with
  // itself if the render is thrown away.
  const handlers = useRef({ onStop, onHover, onAlert, onRoomClick, onUnsupported });
  useEffect(() => {
    handlers.current = { onStop, onHover, onAlert, onRoomClick, onUnsupported };
  }, [onStop, onHover, onAlert, onRoomClick, onUnsupported]);

  const night = useRef(dark);
  useEffect(() => {
    night.current = dark;
  }, [dark]);

  useEffect(() => {
    const host = mount.current;
    if (!host) return;

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, powerPreference: "high-performance" });
    } catch {
      // No WebGL at all. The caller shows the rendered still instead.
      handlers.current.onUnsupported();
      return;
    }

    /**
     * Machines that cannot really do this get the picture instead.
     *
     * Not a performance trick — a correctness one. Where WebGL falls back to a
     * software rasteriser (SwiftShader, llvmpipe, a VM with no GPU) every frame
     * of this scene costs over a tenth of a second, and what the visitor gets
     * is not an animated hospital but a locked browser tab with a slideshow in
     * it. A still render of the same building is strictly better, and it is the
     * same building, because it was rendered from this scene.
     *
     * Checked twice: by name up front, because the known-bad ones say so; and
     * by measuring, because the list of slow machines is not knowable.
     */
    const debugInfo = renderer.getContext().getExtension("WEBGL_debug_renderer_info");
    const rendererName = debugInfo
      ? String(renderer.getContext().getParameter(debugInfo.UNMASKED_RENDERER_WEBGL))
      : "";

    // `?hero=force` runs the scene anyway, and exists for one job: the still in
    // `public/hero/` is a screenshot *of this scene*, so regenerating it means
    // running the scene on whatever machine is doing the regenerating — which
    // is usually a build box with no GPU, exactly the machine this check turns
    // the scene off on. Without the override the picture could never be
    // remade, and a fallback that cannot be regenerated goes stale the first
    // time a room moves.
    const forced =
      typeof window !== "undefined" && window.location.search.includes("hero=force");

    if (!forced && /swiftshader|llvmpipe|software|basic render/i.test(rendererName)) {
      renderer.dispose();
      handlers.current.onUnsupported();
      return;
    }

    const width = () => host.clientWidth || 1;
    const height = () => host.clientHeight || 1;

    // 1.25 rather than 1.5, and a plain PCF shadow rather than a soft one.
    // Flat-shaded boxes gain almost nothing from either, and both are paid for
    // on every frame of the one page that has to open fastest.
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.25));
    renderer.setSize(width(), height(), false);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.domElement.style.width = "100%";
    renderer.domElement.style.height = "100%";
    renderer.domElement.style.display = "block";
    host.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    // 30°, and the wide shots stand far enough back that the whole building
    // fits with air around it. A hero that crops its own subject is worse than
    // one that shows it small.
    const camera = new THREE.PerspectiveCamera(30, width() / height(), 0.1, 140);

    const sun = new THREE.DirectionalLight(0xfff4e6, 1.45);
    sun.position.set(7, 11, 5);
    sun.castShadow = true;
    sun.shadow.mapSize.set(512, 512);
    Object.assign(sun.shadow.camera, {
      left: -13,
      right: 13,
      top: 13,
      bottom: -13,
      near: 1,
      far: 42,
    });
    sun.shadow.bias = -0.0006;
    const hemi = new THREE.HemisphereLight(0xd6e9ff, 0xffd9c7, 0.55);
    scene.add(sun, hemi);

    const built = buildHospital();
    scene.add(built.world);

    /* ---- who is in the building ---------------------------------------- */

    // A patient's day, named as places rather than coordinates. The graph turns
    // this into a route that goes through the front door and down the corridor.
    const patientDay = [
      "road.w",
      "gate",
      "entrance",
      "desk",
      "wait.a",
      "in.consult",
      "in.pharmacy",
      "entrance",
      "gate",
      "road.e",
    ];
    const patientWaits = { desk: 2.6, "wait.a": 5, "in.consult": 6.5, "in.pharmacy": 3.4 };

    const walkers: Walker[] = [];
    for (let i = 0; i < 4; i++) {
      const w = makeWalker("patient", patientDay, 1.15, patientWaits, i + 1, 0);
      // Stagger them along the loop so the place is busy but never crowded.
      w.at = Math.floor((w.path.length * i) / 4);
      walkers.push(w);
    }

    const nurse = makeWalker(
      "nurse",
      ["in.records", "desk", "in.admin", "in.icu", "in.records"],
      1.05,
      { "in.records": 3, desk: 2.4, "in.admin": 2.6, "in.icu": 3.2 },
      2,
    );
    walkers.push(nurse);

    // The receptionist stands at the desk and stays there.
    const receptionist = person("desk", 4);
    receptionist.group.position.set(NODES.desk.x, 0, NODES.desk.z - 0.62);
    receptionist.group.rotation.y = Math.PI;
    built.world.add(receptionist.group);

    // The doctor sits at the consultation desk and walks to the ICU on alert.
    const doctor = person("doctor", 0);
    const doctorHome = new THREE.Vector3(NODES["in.consult"].x, 0, NODES["in.consult"].z - 0.55);
    doctor.group.position.copy(doctorHome);
    built.world.add(doctor.group);
    const doctorRoute = walkThrough(["in.consult", "in.icu"]);
    let doctorLeg = 0;
    let doctorAlong = 0;
    let doctorGoing = false;

    for (const walker of walkers) built.world.add(walker.body.group);

    /* ---- doors ----------------------------------------------------------- */

    // A door opens when anybody is within a stride of its threshold, and falls
    // shut behind them. Because the only way to reach a threshold is to walk
    // the edge that leads to it, a door that never opens is a route that never
    // went through it — which is the check, not the decoration.
    const doorOpen = new Map<string, number>();
    for (const key of built.doors.keys()) doorOpen.set(key, 0);

    /* ---- the ICU's alert cycle -------------------------------------------- */
    let alertPhase: 0 | 1 | 2 | 3 = 0;
    let alertClock = 0;
    let announced = false;

    /* ---- the ambulance ----------------------------------------------------- */
    let ambulanceClock = 0;

    /* ---- interaction -------------------------------------------------------- */
    const ray = new THREE.Raycaster();
    const pointer = new THREE.Vector2(0, 0);
    let pointerLive = false;
    let hovered: Room | null = null;

    const onPointerMove = (event: PointerEvent) => {
      const rect = host.getBoundingClientRect();
      pointerLive = true;
      pointer.set(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        -((event.clientY - rect.top) / rect.height) * 2 + 1,
      );
    };
    const onPointerLeave = () => {
      pointerLive = false;
      if (hovered) {
        hovered = null;
        handlers.current.onHover(null);
      }
    };
    const onClick = () => {
      if (hovered) handlers.current.onRoomClick(hovered);
    };
    host.addEventListener("pointermove", onPointerMove);
    host.addEventListener("pointerleave", onPointerLeave);
    host.addEventListener("click", onClick);

    /* ---- the loop ------------------------------------------------------------ */
    const eye = new THREE.Vector3(...STOPS[0].eye);
    const look = new THREE.Vector3(...STOPS[0].look);
    let darkness = night.current ? 1 : 0;
    let reportedStop = -1;

    const sunDay = new THREE.Color(0xfff4e6);
    const sunNight = new THREE.Color(0x7fa2ff);
    const skyDay = new THREE.Color(0xd6e9ff);
    const skyNight = new THREE.Color(0x1e2f4a);
    const soilDay = new THREE.Color(0xffd9c7);
    const soilNight = new THREE.Color(0x12172a);
    const grassDay = new THREE.Color(0xb6e6d8);
    const grassNight = new THREE.Color(0x1f3f3a);
    const paveDay = new THREE.Color(0xe6ded1);
    const paveNight = new THREE.Color(0x2a3150);

    let frame = 0;
    let running = true;
    let last = performance.now();
    let lastPaint = 0;

    // The machine is timed, but not from the first frame.
    //
    // The opening frames of any WebGL scene are the most expensive it will ever
    // draw — shaders compile, textures upload, the shadow map fills for the
    // first time — so judging on those would demote a perfectly good laptop for
    // being slow at the one moment everything is slow. Twenty frames of warm-up
    // are thrown away, then forty are measured, and the bar is about thirty a
    // second: below that this is a slideshow, and the still is honestly better.
    const WARM_UP = 20;
    const SAMPLE = 40;
    const samples: number[] = [];
    let seenFrames = 0;
    let judged = false;

    const draw = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      if (!judged) {
        seenFrames += 1;
        if (seenFrames > WARM_UP) samples.push(now - last);
        if (samples.length === SAMPLE) {
          judged = true;
          const median = samples.slice().sort((a, b) => a - b)[SAMPLE / 2];
          if (!forced && median > 32) {
            running = false;
            cancelAnimationFrame(frame);
            handlers.current.onUnsupported();
            return;
          }
        }
      }
      last = now;
      const t = now / 1000;

      /* -- where the reader is -- */
      const p = clamp01(progress.current ?? 0);
      const position = p * (stops - 1);
      const stop = Math.min(stops - 1, Math.round(position));
      if (stop !== reportedStop) {
        reportedStop = stop;
        handlers.current.onStop(stop);
      }

      /* -- camera --
         The shot is interpolated between the two stops the reader is between,
         not snapped to the nearer one. Snapping is what made this feel steppy:
         the target jumped the moment the scroll crossed a midpoint, and the
         damping then chased it, so the camera was always either still or
         catching up — never simply moving with the page.

         The blend holds at each end and travels in the middle, so a stop still
         *settles* on its room instead of drifting through it. Damping stays on
         top, but only to take the jitter out of the scroll. */
      const leg = Math.min(STOPS.length - 2, Math.floor(position));
      const along = clamp01(position - leg);
      const glide = smoothstep(clamp01((along - 0.16) / 0.68));
      const a = STOPS[leg];
      const b = STOPS[leg + 1];
      const blend = (from: number, to: number) => from + (to - from) * glide;

      /* No arc between rooms.
         ---------------------
         The camera used to rise and pull back over every leg and set down
         again. It was there in case sliding between rooms passed through the
         walls — but every room shot sits at y 6.7 and the walls are 1.25 tall,
         so it never could. What it actually did was zoom out and back in six
         times in a row, which reads as the camera being unsure rather than as
         a camera being carried.

         All six room shots share one height and one offset, so what is left is
         the only move the tour needs: descend once into the first room, track
         sideways along the row, and climb back out at the end. The zoom now
         happens twice, where the shot genuinely changes, instead of at every
         stop. */
      eye.x = damp(eye.x, blend(a.eye[0], b.eye[0]), 5.5, dt);
      eye.y = damp(eye.y, blend(a.eye[1], b.eye[1]), 5.5, dt);
      eye.z = damp(eye.z, blend(a.eye[2], b.eye[2]), 5.5, dt);
      look.x = damp(look.x, blend(a.look[0], b.look[0]), 5.5, dt);
      look.y = damp(look.y, blend(a.look[1], b.look[1]), 5.5, dt);
      look.z = damp(look.z, blend(a.look[2], b.look[2]), 5.5, dt);
      camera.position.copy(eye);
      if (pointerLive) {
        camera.position.x += pointer.x * 0.35;
        camera.position.y += pointer.y * 0.2;
      }
      camera.lookAt(look);
      // Only the two wide shots sway; inside a room it would read as a wobble.
      built.world.rotation.y =
        stop === 0 || stop === stops - 1 ? Math.sin(t * 0.12) * 0.05 : damp(built.world.rotation.y, 0, 3, dt);

      /* -- hover -- */
      if (pointerLive) {
        ray.setFromCamera(pointer, camera);
        const hit = ray.intersectObjects(built.floors)[0];
        const room = (hit?.object.userData.room as Room | undefined) ?? null;
        if (room !== hovered) {
          hovered = room;
          handlers.current.onHover(room);
        }
      }
      host.style.cursor = hovered ? "pointer" : "";

      // The active room, and any room under the cursor, lifts off the slab.
      built.rooms.forEach((group, index) => {
        const room = ROOMS[index];
        const wanted = stop === room.id ? 0.22 : hovered === room ? 0.16 : 0;
        group.position.y = damp(group.position.y, wanted, 8, dt);
      });

      /* -- people -- */
      for (const walker of walkers) {
        const here = NODES[walker.path[walker.at]];
        const nextIndex = (walker.at + 1) % walker.path.length;
        const next = NODES[walker.path[nextIndex]];

        if (walker.pause > 0) {
          walker.pause -= dt;
          walker.body.legs[0].rotation.x = 0;
          walker.body.legs[1].rotation.x = 0;
          swingArms(walker.body, 0);
        } else {
          const span = Math.hypot(next.x - here.x, next.z - here.z) || 0.001;
          walker.along += (dt * walker.speed) / span;
          while (walker.along >= 1) {
            walker.along -= 1;
            walker.at = (walker.at + 1) % walker.path.length;
            const arrived = walker.path[walker.at];
            walker.pause = walker.waits[arrived] ?? 0;
          }
          walker.body.legs[0].rotation.x = Math.sin(t * 11) * 0.5;
          walker.body.legs[1].rotation.x = -Math.sin(t * 11) * 0.5;
          swingArms(walker.body, Math.sin(t * 11) * 0.42);
        }

        const from = NODES[walker.path[walker.at]];
        const to = NODES[walker.path[(walker.at + 1) % walker.path.length]];
        const u = walker.pause > 0 ? 0 : walker.along;
        walker.body.group.position.set(
          from.x + (to.x - from.x) * u,
          0,
          from.z + (to.z - from.z) * u,
        );
        if (walker.pause <= 0) {
          walker.body.group.rotation.y = Math.atan2(to.x - from.x, to.z - from.z);
        }

        // Hold the door for whoever is near it.
        for (const [key, pivot] of built.doors) {
          void pivot;
          const node = Object.values(NODES).find((n) => n.door === key);
          if (!node) continue;
          const near =
            Math.hypot(walker.body.group.position.x - node.x, walker.body.group.position.z - node.z) < 0.85;
          if (near) doorOpen.set(key, 1);
        }
      }

      /* -- the ICU alert cycle -- */
      alertClock += dt;
      if (alertPhase === 0 && alertClock > 10) {
        alertPhase = 1;
        alertClock = 0;
        announced = true;
        handlers.current.onAlert(true);
      }
      if (alertPhase === 1 && alertClock > 1.1) {
        alertPhase = 2;
        alertClock = 0;
        doctorGoing = true;
      }
      if (alertPhase === 2 && alertClock > 3.5) {
        alertPhase = 3;
        alertClock = 0;
        doctorGoing = false;
        if (announced) {
          announced = false;
          handlers.current.onAlert(false);
        }
      }
      if (alertPhase === 3 && alertClock > 3) {
        alertPhase = 0;
        alertClock = 0;
      }
      const critical = alertPhase === 1 || alertPhase === 2;

      built.icu.setCritical(critical);
      built.icu.monitor.emissiveIntensity = critical ? 0.9 + Math.sin(t * 10) * 0.4 : 0.8;
      // The patient in the bed keeps breathing either way, faster when the
      // monitor is unhappy.
      built.icu.chest.scale.y = 1 + Math.sin(t * (critical ? 4.2 : 2.1)) * 0.11;

      /* -- the doctor walks there and back, through the corridor -- */
      {
        const forward = doctorGoing;
        const target = forward ? doctorRoute.length - 1 : 0;
        if (doctorLeg !== target || doctorAlong !== 0) {
          const step = forward ? 1 : -1;
          const fromNode = NODES[doctorRoute[doctorLeg]];
          const toIndex = Math.min(doctorRoute.length - 1, Math.max(0, doctorLeg + step));
          const toNode = NODES[doctorRoute[toIndex]];
          const span = Math.hypot(toNode.x - fromNode.x, toNode.z - fromNode.z) || 0.001;
          if (doctorLeg !== target) {
            doctorAlong += (dt * 1.5) / span;
            if (doctorAlong >= 1) {
              doctorAlong = 0;
              doctorLeg = toIndex;
            }
          }
          const u = doctorLeg === target ? 0 : doctorAlong;
          doctor.group.position.set(
            fromNode.x + (toNode.x - fromNode.x) * u,
            0,
            fromNode.z + (toNode.z - fromNode.z) * u,
          );
          if (doctorLeg !== target) {
            doctor.group.rotation.y = Math.atan2(toNode.x - fromNode.x, toNode.z - fromNode.z);
            doctor.legs[0].rotation.x = Math.sin(t * 12) * 0.5;
            doctor.legs[1].rotation.x = -Math.sin(t * 12) * 0.5;
            swingArms(doctor, Math.sin(t * 12) * 0.42);
            for (const [key] of built.doors) {
              const node = Object.values(NODES).find((n) => n.door === key);
              if (!node) continue;
              if (Math.hypot(doctor.group.position.x - node.x, doctor.group.position.z - node.z) < 0.85) {
                doorOpen.set(key, 1);
              }
            }
          } else {
            doctor.legs[0].rotation.x = 0;
            doctor.legs[1].rotation.x = 0;
            swingArms(doctor, 0);
            if (!forward) doctor.group.position.copy(doctorHome);
          }
        }
      }

      /* -- doors settle shut -- */
      for (const [key, pivot] of built.doors) {
        const wanted = doorOpen.get(key) ?? 0;
        pivot.rotation.y = damp(pivot.rotation.y, wanted * -1.2, 6, dt);
        doorOpen.set(key, Math.max(0, wanted - dt * 1.4));
      }

      /* -- the ambulance calls -- */
      ambulanceClock += dt;
      const amb = built.ambulance.group;
      if (ambulanceClock < 6) amb.position.x = -13 + (ambulanceClock / 6) * 13.6;
      else if (ambulanceClock < 9) amb.position.x = 0.6;
      else if (ambulanceClock < 15) amb.position.x = 0.6 + ((ambulanceClock - 9) / 6) * 13;
      else if (ambulanceClock > 45) ambulanceClock = 0;
      else amb.position.x = 14;
      built.ambulance.beacon.emissiveIntensity =
        ambulanceClock < 9 ? 0.4 + Math.abs(Math.sin(t * 8)) * 0.9 : 0.2;

      /* -- small life -- */
      built.scanner.position.z = 0.55 + Math.sin(t * 3) * 0.06;
      built.leaf.rotation.z = Math.sin(t * 1.1) * 0.07;

      // The nine little screens redraw ten times a second, not sixty. Each one
      // is a canvas repaint plus a texture upload to the GPU, and at sixty a
      // second that is the largest avoidable cost in the whole scene — for
      // bars and traces nobody can tell apart at either rate.
      if (now - lastPaint > 100) {
        lastPaint = now;
        for (const screen of built.screens) screen.update(t);
      }

      /* -- day and night -- */
      darkness = damp(darkness, night.current ? 1 : 0, 3, dt);
      sun.color.copy(sunDay).lerp(sunNight, darkness);
      sun.intensity = 1.45 - darkness * 1.05;
      hemi.color.copy(skyDay).lerp(skyNight, darkness);
      hemi.groundColor.copy(soilDay).lerp(soilNight, darkness);
      hemi.intensity = 0.55 - darkness * 0.2;
      built.ground.color.copy(grassDay).lerp(grassNight, darkness);
      built.plaza.color.copy(paveDay).lerp(paveNight, darkness);
      for (const pane of built.night.windows) pane.emissiveIntensity = darkness * 1.1;
      for (const lamp of built.night.lamps) lamp.intensity = darkness * 1.7;
      built.night.signGlow.emissiveIntensity = darkness * 0.7;

      renderer.render(scene, camera);
      if (running) frame = requestAnimationFrame(draw);
    };

    const onResize = () => {
      renderer.setSize(width(), height(), false);
      camera.aspect = width() / height();
      camera.updateProjectionMatrix();
    };

    /** Nobody is looking; nothing should be drawn. */
    const onVisibility = () => {
      if (document.hidden) {
        running = false;
        cancelAnimationFrame(frame);
      } else if (!running) {
        running = true;
        last = performance.now();
        frame = requestAnimationFrame(draw);
      }
    };

    // The hero is four screens tall and the page is much longer than that;
    // rendering a hospital nobody can see is the most expensive thing this
    // component could do.
    const watcher = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          if (!running && !document.hidden) {
            running = true;
            last = performance.now();
            frame = requestAnimationFrame(draw);
          }
        } else {
          running = false;
          cancelAnimationFrame(frame);
        }
      },
      { threshold: 0 },
    );
    watcher.observe(host);

    window.addEventListener("resize", onResize);
    document.addEventListener("visibilitychange", onVisibility);

    // The building waits for the page to finish arriving. Starting the loop
    // during hydration means the first thing a visitor's main thread does is
    // render a hospital, and the headline they came to read waits behind it.
    let start = 0;
    const begin = () => {
      if (running && !document.hidden) frame = requestAnimationFrame(draw);
    };
    if (document.readyState === "complete") start = window.setTimeout(begin, 0);
    else window.addEventListener("load", begin, { once: true });

    return () => {
      running = false;
      cancelAnimationFrame(frame);
      window.clearTimeout(start);
      window.removeEventListener("load", begin);
      watcher.disconnect();
      window.removeEventListener("resize", onResize);
      document.removeEventListener("visibilitychange", onVisibility);
      host.removeEventListener("pointermove", onPointerMove);
      host.removeEventListener("pointerleave", onPointerLeave);
      host.removeEventListener("click", onClick);
      scene.traverse((object) => {
        const mesh = object as THREE.Mesh;
        if (mesh.geometry) mesh.geometry.dispose();
        const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
        else mat?.dispose();
      });
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [progress, stops]);

  return <div ref={mount} aria-hidden className="absolute inset-0" />;
}
