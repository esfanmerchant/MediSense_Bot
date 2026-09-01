"use client";

/**
 * Four shapes, one object. Scroll is the only clock.
 *
 * The first version of this scene was a cloud of points, and a cloud of points
 * is not a concept — it is confetti with a colour scheme. At every moment of a
 * story like this the reader should be able to say *what they are looking at*
 * without reading the caption, so this is built out of **line segments** and
 * every act is a silhouette somebody recognises on sight:
 *
 *   I    a waveform     — vertical bars, a voice being spoken
 *   II   a document     — the bars lie down into ruled lines on a sheet
 *   III  two panels     — the sheet divides, and a beam carries it across
 *   IV   a network      — the panels open into a lattice of linked clinics
 *
 * It is the *same* six hundred segments in all four. Nothing is added and
 * nothing is thrown away, because that is the claim the page is making: a
 * spoken symptom and the record a doctor reads are one piece of information,
 * not a copy of one. A scene that dissolved between four different objects
 * would be arguing the opposite.
 *
 * **Metal, not glow.** The palette is one blue — #00194D — lit rather than
 * coloured. A specular band travels across the object every few seconds and
 * brightens whatever it crosses, which is the whole of the metallic read: a
 * surface that is dark until light lands on it. Colours are recomputed per
 * segment per frame, which sounds expensive and is roughly two thousand float
 * writes — less than the cost of one shadow.
 *
 * **Raw three.js, deliberately.** This project already has one hand-written
 * WebGL surface carrying the failure handling a clinical product needs — no
 * context, reduced motion, hidden tab, disposal, capped pixel ratio. Adding a
 * renderer framework to copy an idiom would mean two integrations and two
 * copies of that discipline for one page.
 *
 * **React never re-renders for the scroll.** Progress arrives through a ref the
 * loop reads, and the loop damps it further. That damping is the whole
 * difference between camera work and scrubbing.
 */

import { useEffect, useRef } from "react";
import * as THREE from "three";

/** Segments in the object. Enough to draw a legible lattice, few enough that
    recolouring all of them every frame is free. */
const SEGMENTS = 600;

/**
 * The metal.
 *
 * Four stops from the ground colour to a near-white highlight. A segment's
 * place on this ramp is not fixed — it is how much light is currently falling
 * on it, so the object reads as one material rather than as a gradient someone
 * painted on.
 */
const STEEL: [number, number][] = [
  [0.0, 0x00194d],
  [0.42, 0x1e5aa8],
  [0.76, 0x5ec8e6],
  [1.0, 0xdcefff],
];

const stopA = new THREE.Color();
const stopB = new THREE.Color();

function steelAt(t: number, target: THREE.Color) {
  const clamped = Math.min(1, Math.max(0, t));
  for (let i = 1; i < STEEL.length; i++) {
    const [t1, c1] = STEEL[i];
    if (clamped <= t1 || i === STEEL.length - 1) {
      const [t0, c0] = STEEL[i - 1];
      const local = t1 === t0 ? 0 : (clamped - t0) / (t1 - t0);
      stopA.setHex(c0, THREE.SRGBColorSpace);
      stopB.setHex(c1, THREE.SRGBColorSpace);
      return target.copy(stopA).lerp(stopB, local);
    }
  }
  return target.setHex(0x1e5aa8, THREE.SRGBColorSpace);
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const clamp01 = (t: number) => (t < 0 ? 0 : t > 1 ? 1 : t);

function smoothstep(min: number, max: number, t: number) {
  const x = clamp01((t - min) / (max - min));
  return x * x * (3 - 2 * x);
}

/** Deterministic, so every visit composes the same picture. */
function rand(seed: number) {
  const x = Math.sin(seed * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

/**
 * The four arrangements, built once.
 *
 * Layout is `[act][segment][endpoint][xyz]`, flattened. A segment keeps its
 * index through all four acts, so the bar on the left of the waveform is the
 * rule on the left of the sheet and the link on the left of the network. Give
 * each act its own random assignment and the object boils between states
 * instead of moving through them.
 */
function buildTargets(): Float32Array {
  const stride = SEGMENTS * 6;
  const targets = new Float32Array(4 * stride);

  const put = (
    act: number,
    i: number,
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
  ) => {
    const at = act * stride + i * 6;
    targets[at] = ax; targets[at + 1] = ay; targets[at + 2] = az;
    targets[at + 3] = bx; targets[at + 4] = by; targets[at + 5] = bz;
  };

  for (let i = 0; i < SEGMENTS; i++) {
    const across = i / (SEGMENTS - 1);
    const jitter = rand(i);

    // ---- I. A waveform -----------------------------------------------------
    // Vertical bars along a centre line, tallest in the middle, with the
    // roughness of a real utterance rather than a smooth envelope.
    const x = (across - 0.5) * 5.4;
    const envelope = Math.cos((across - 0.5) * Math.PI) ** 1.6;
    const height = envelope * (0.28 + Math.abs(Math.sin(i * 1.7)) * 0.95) * (0.55 + jitter * 0.6);
    put(0, i, x, -height, 0, x, height, 0);

    // ---- II. A document ----------------------------------------------------
    // The bars lie down. Ruled lines on a sheet, indented like a paragraph,
    // with a few short ones so it reads as written text and not as a grid.
    const rules = 26;
    const line = i % rules;
    const column = Math.floor(i / rules);
    const width = 0.42 + rand(i + 900) * 0.42;
    const left = -1.35 + column * 0.06;
    const ly = 1.05 - (line / (rules - 1)) * 2.1;
    put(1, i, left, ly, 0, left + width * 2.2, ly, 0);

    // ---- III. Two panels, and the beam between them -------------------------
    // Every twelfth segment becomes the link. The rest split left and right —
    // the same sheet, now in two places at once, which is the point of the act.
    if (i % 12 === 0) {
      const along = rand(i + 1700);
      const nextAlong = Math.min(1, along + 0.06);
      const arc = (a: number) => Math.sin(a * Math.PI) * 0.62;
      put(
        2, i,
        lerp(-1.55, 1.55, along), arc(along), 0,
        lerp(-1.55, 1.55, nextAlong), arc(nextAlong), 0,
      );
    } else {
      const right = i % 2 === 0;
      const side = right ? 1.75 : -1.75;
      put(
        2, i,
        side + left * 0.6, ly * 0.62, 0,
        side + (left + width * 1.5) * 0.6, ly * 0.62, 0,
      );
    }

    // ---- IV. A network ------------------------------------------------------
    // Nine sites on a plane, each a small cluster, joined to the site beside
    // them. Seen from above and slightly to the side.
    const site = i % 9;
    const sx = ((site % 3) - 1) * 3.05;
    const sz = (Math.floor(site / 3) - 1) * 2.35;
    const spoke = i % 7 === 0;
    if (spoke) {
      // A link between neighbouring sites: the part that makes it a network
      // rather than nine unrelated diagrams.
      const to = (site + 1) % 9;
      const tx = ((to % 3) - 1) * 3.05;
      const tz = (Math.floor(to / 3) - 1) * 2.35;
      put(3, i, sx, 0, sz, tx, 0, tz);
    } else {
      const angle = rand(i + 2600) * Math.PI * 2;
      const reach = 0.34 + rand(i + 3300) * 0.62;
      put(
        3, i,
        sx, 0, sz,
        sx + Math.cos(angle) * reach,
        (rand(i + 4100) - 0.5) * 0.5,
        sz + Math.sin(angle) * reach,
      );
    }
  }

  return targets;
}

export function StoryScene({
  /** 0 → 1 across the pinned section. Read every frame; never React state. */
  progress,
  /** Told `false` when there is no WebGL, so the caller keeps its fallback. */
  onReady,
}: {
  progress: React.RefObject<number>;
  onReady?: (ok: boolean) => void;
}) {
  const mount = useRef<HTMLDivElement | null>(null);

  // In a ref, not a dependency: a new callback identity must never tear down
  // and rebuild a WebGL context.
  const ready = useRef(onReady);
  useEffect(() => {
    ready.current = onReady;
  }, [onReady]);

  useEffect(() => {
    const host = mount.current;
    if (!host) return;

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({
        alpha: true,
        antialias: true,
        powerPreference: "high-performance",
      });
    } catch {
      ready.current?.(false);
      return;
    }

    const width = () => host.clientWidth || 1;
    const height = () => host.clientHeight || 1;

    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
    renderer.setSize(width(), height(), false);
    renderer.domElement.style.width = "100%";
    renderer.domElement.style.height = "100%";
    renderer.domElement.style.display = "block";
    host.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(48, width() / height(), 0.1, 60);

    const targets = buildTargets();
    const stride = SEGMENTS * 6;
    const positions = new Float32Array(stride);
    const colors = new Float32Array(stride);
    positions.set(targets.subarray(0, stride));

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));

    const material = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.95,
      // Additive, so crossing lines brighten where the object is dense — which
      // is what gives a lattice of thin lines the weight of a solid surface.
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });

    const lines = new THREE.LineSegments(geometry, material);
    scene.add(lines);

    const position = geometry.getAttribute("position") as THREE.BufferAttribute;
    const color = geometry.getAttribute("color") as THREE.BufferAttribute;
    const tint = new THREE.Color();

    let eased = 0;
    let camZ = 3.4;
    let camY = 0;

    let frame = 0;
    let running = true;
    let last = performance.now();

    const draw = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;

      const target = clamp01(progress.current ?? 0);
      eased += (target - eased) * (1 - Math.exp(-dt * 5.5));
      const t = eased;

      const span = t * 3;
      const from = Math.min(2, Math.floor(span));
      const blend = smoothstep(0, 1, span - from);
      const a0 = from * stride;
      const a1 = (from + 1) * stride;

      // Only the waveform moves on its own. Once the object is a document it
      // holds still, because a record that shimmers is a record nobody trusts.
      const speaking = 1 - smoothstep(0.02, 0.24, t);
      const phase = now / 190;

      // The specular band: where the light is, right now, in object x.
      const sweep = ((now / 2600) % 1) * 9 - 4.5;

      for (let i = 0; i < SEGMENTS; i++) {
        const at = i * 6;
        let brightest = 0;

        for (let e = 0; e < 2; e++) {
          const o = at + e * 3;
          const x = lerp(targets[a0 + o], targets[a1 + o], blend);
          let y = lerp(targets[a0 + o + 1], targets[a1 + o + 1], blend);
          const z = lerp(targets[a0 + o + 2], targets[a1 + o + 2], blend);

          // The bars breathe while the voice is still being spoken.
          if (speaking > 0.001) {
            y *= 1 + Math.sin(phase + i * 0.6) * 0.42 * speaking;
          }

          positions[o] = x;
          positions[o + 1] = y;
          positions[o + 2] = z;

          // Light falls off with distance from the band, and a little with
          // depth, so the far side of the lattice sits behind the near side.
          const lit = Math.max(0, 1 - Math.abs(x - sweep) / 2.1) ** 2;
          const depth = clamp01(0.5 + z * 0.35);
          brightest = Math.max(brightest, lit * 0.85 + depth * 0.22);
        }

        steelAt(0.16 + brightest, tint);
        for (let e = 0; e < 2; e++) {
          const o = at + e * 3;
          colors[o] = tint.r;
          colors[o + 1] = tint.g;
          colors[o + 2] = tint.b;
        }
      }

      position.needsUpdate = true;
      color.needsUpdate = true;

      // The camera walks back through the story: close enough to hear one
      // person, far enough to see the system they are part of.
      const wantZ = lerp(3.4, 9.6, smoothstep(0, 1, t));
      const wantY = lerp(0, 2.7, smoothstep(0.62, 1, t));
      const k = 1 - Math.exp(-dt * 4);
      camZ += (wantZ - camZ) * k;
      camY += (wantY - camY) * k;
      camera.position.set(0, camY, camZ);
      camera.lookAt(0, lerp(0, -0.7, smoothstep(0.62, 1, t)), 0);

      // Flat while it is a waveform and a sheet — both are things you read
      // face-on — and turning only once it becomes a network, which is the one
      // act that has a shape worth walking around.
      lines.rotation.y = smoothstep(0.6, 1, t) * 0.42 + now / 42000;
      lines.rotation.x = smoothstep(0.68, 1, t) * 0.22;

      material.opacity = 0.55 + 0.4 * smoothstep(0.02, 0.2, t);

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

    window.addEventListener("resize", onResize);
    document.addEventListener("visibilitychange", onVisibility);
    frame = requestAnimationFrame(draw);
    ready.current?.(true);

    return () => {
      running = false;
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", onResize);
      document.removeEventListener("visibilitychange", onVisibility);
      geometry.dispose();
      material.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [progress]);

  return <div ref={mount} aria-hidden className="absolute inset-0" />;
}
