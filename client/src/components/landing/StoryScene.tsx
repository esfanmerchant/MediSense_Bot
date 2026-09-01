"use client";

/**
 * The four acts, in three dimensions. Scroll is the only clock.
 *
 * One field of particles that never grows or shrinks — it is *rearranged*. Each
 * particle carries four positions, one per act, and the scroll position says
 * how far between two of them it currently sits. That is the whole trick, and
 * it is the reason the scene reads as one thing becoming another rather than as
 * four scenes cutting between each other:
 *
 *   I    a voice        — a loose shell of points, breathing, alone
 *   II   a record       — the same points settle into a flat lattice
 *   III  a doctor       — the lattice splits in two and a trace joins them
 *   IV   a system       — the two become a field of clinics, all connected
 *
 * Nothing is added between acts, which is the argument the page is making: the
 * symptom a patient speaks at eight in the morning and the record on a doctor's
 * screen at half past ten are *the same information*, not a copy of it.
 *
 * **Raw three.js, and deliberately so.** The obvious way to write this is
 * react-three-fiber with drei, and the obvious way is wrong here: this project
 * already has one hand-written WebGL surface with the failure handling a
 * clinical product needs — no context, reduced motion, hidden tab, disposal on
 * unmount, capped pixel ratio — and adding a renderer framework to copy an
 * idiom would mean two integrations, two sets of that discipline, and a couple
 * of hundred kilobytes for one page. The behaviour is what matters; the API is
 * not.
 *
 * **React never re-renders for the scroll.** Progress arrives through a ref
 * that the animation loop reads. A component that re-rendered on every scroll
 * frame would drop frames on exactly the phone this is meant to impress.
 */

import { useEffect, useRef } from "react";
import * as THREE from "three";

/** How many points make the field. Enough to read as a surface, few enough to
    stay well inside a mid-range phone's fill rate. */
const COUNT = 1100;

/** The brand ramp, sampled per particle so the field carries the identity. */
const RAMP: [number, number][] = [
  [0.0, 0x0b3fa8],
  [0.55, 0x1a8fc7],
  [1.0, 0x14c4c1],
];

const stopA = new THREE.Color();
const stopB = new THREE.Color();

function rampAt(t: number, target: THREE.Color) {
  const clamped = Math.min(1, Math.max(0, t));
  for (let i = 1; i < RAMP.length; i++) {
    const [t1, c1] = RAMP[i];
    if (clamped <= t1 || i === RAMP.length - 1) {
      const [t0, c0] = RAMP[i - 1];
      const local = t1 === t0 ? 0 : (clamped - t0) / (t1 - t0);
      stopA.setHex(c0, THREE.SRGBColorSpace);
      stopB.setHex(c1, THREE.SRGBColorSpace);
      return target.copy(stopA).lerp(stopB, local);
    }
  }
  return target.setHex(0x1a8fc7, THREE.SRGBColorSpace);
}

/** A soft round dot. Drawn once into a canvas rather than fetched, so the
    scene has no network dependency and cannot flash un-textured. */
function makeSprite(): THREE.Texture {
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, "rgba(255,255,255,1)");
  gradient.addColorStop(0.35, "rgba(255,255,255,0.85)");
  gradient.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const clamp01 = (t: number) => (t < 0 ? 0 : t > 1 ? 1 : t);

/** Eases the ends of a range so nothing starts or stops abruptly. */
function smoothstep(min: number, max: number, t: number) {
  const x = clamp01((t - min) / (max - min));
  return x * x * (3 - 2 * x);
}

/**
 * The four arrangements, built once.
 *
 * Returns a flat array of 4 × COUNT × 3 floats. Deterministic per particle: the
 * same index keeps the same "role" through all four acts, so a point on the
 * left of the record is on the left of the clinic it becomes. Randomising per
 * act would make the field boil between states instead of moving through them.
 */
function buildTargets(): Float32Array {
  const targets = new Float32Array(4 * COUNT * 3);
  const write = (act: number, i: number, x: number, y: number, z: number) => {
    const at = (act * COUNT + i) * 3;
    targets[at] = x;
    targets[at + 1] = y;
    targets[at + 2] = z;
  };

  // A cheap deterministic hash, so every reload composes the same picture.
  const rand = (seed: number) => {
    const x = Math.sin(seed * 127.1 + 311.7) * 43758.5453;
    return x - Math.floor(x);
  };

  for (let i = 0; i < COUNT; i++) {
    const a = rand(i);
    const b = rand(i + 1000);
    const c = rand(i + 2000);

    // I — a voice. A hollow shell, thicker near the equator, so it reads as
    // something sounding outward rather than as a solid ball.
    const phi = Math.acos(2 * a - 1);
    const theta = 2 * Math.PI * b;
    const radius = 0.72 + c * 0.5;
    write(
      0,
      i,
      radius * Math.sin(phi) * Math.cos(theta),
      radius * Math.cos(phi) * 0.55,
      radius * Math.sin(phi) * Math.sin(theta),
    );

    // II — a record. The same points flatten into a lattice: rows and columns
    // on a card, with a little depth so it is a page and not a texture.
    const columns = 34;
    const row = Math.floor(i / columns);
    const column = i % columns;
    write(
      1,
      i,
      (column / (columns - 1) - 0.5) * 2.6,
      (0.5 - row / (COUNT / columns - 1)) * 1.7,
      (c - 0.5) * 0.12,
    );

    // III — a doctor. The lattice splits: two cards, and a tenth of the points
    // strung along the trace between them, which is the handover itself.
    const bridge = i % 10 === 0;
    if (bridge) {
      const along = rand(i + 3000);
      write(2, i, lerp(-1.85, 1.85, along), Math.sin(along * Math.PI) * 0.42, (c - 0.5) * 0.1);
    } else {
      const right = i % 2 === 0;
      write(
        2,
        i,
        (right ? 1.85 : -1.85) + (column / (columns - 1) - 0.5) * 1.25,
        (0.5 - row / (COUNT / columns - 1)) * 1.15,
        (c - 0.5) * 0.14,
      );
    }

    // IV — a system. Nine clinics across a wide plane, each a small cluster,
    // seen from above and slightly to the side.
    const clinic = i % 9;
    const cx = ((clinic % 3) - 1) * 3.1;
    const cz = (Math.floor(clinic / 3) - 1) * 2.5;
    write(
      3,
      i,
      cx + (a - 0.5) * 1.5,
      (b - 0.5) * 0.75,
      cz + (c - 0.5) * 1.3,
    );
  }

  return targets;
}

export function StoryScene({
  /** 0 → 1 across the pinned section. Read every frame; never a React state. */
  progress,
  /** Told `false` when there is no WebGL, so the caller keeps its fallback. */
  onReady,
}: {
  progress: React.RefObject<number>;
  onReady?: (ok: boolean) => void;
}) {
  const mount = useRef<HTMLDivElement | null>(null);

  // In a ref rather than an effect dependency: a new callback identity must
  // never tear down and rebuild a WebGL context.
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
      // No WebGL. The caller's static telling of the same story stands.
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
    const positions = new Float32Array(COUNT * 3);
    const colors = new Float32Array(COUNT * 3);
    const scratch = new THREE.Color();

    for (let i = 0; i < COUNT; i++) {
      positions[i * 3] = targets[i * 3];
      positions[i * 3 + 1] = targets[i * 3 + 1];
      positions[i * 3 + 2] = targets[i * 3 + 2];
      rampAt(i / COUNT, scratch);
      colors[i * 3] = scratch.r;
      colors[i * 3 + 1] = scratch.g;
      colors[i * 3 + 2] = scratch.b;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));

    const sprite = makeSprite();
    const material = new THREE.PointsMaterial({
      size: 0.075,
      map: sprite,
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      // Additive so overlapping points bloom where the field is dense, which is
      // what makes the record read as a lit surface rather than a grid of dots.
      blending: THREE.AdditiveBlending,
    });

    const points = new THREE.Points(geometry, material);
    scene.add(points);

    /**
     * The trace between patient and doctor, drawn only while it means
     * something. A line that is always present is decoration; one that appears
     * exactly when the record moves is the sentence the act is making.
     */
    const traceGeometry = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(-1.85, 0, 0),
      new THREE.Vector3(0, 0.42, 0),
      new THREE.Vector3(1.85, 0, 0),
    ]);
    const traceMaterial = new THREE.LineBasicMaterial({
      color: 0x14c4c1,
      transparent: true,
      opacity: 0,
    });
    const trace = new THREE.Line(traceGeometry, traceMaterial);
    scene.add(trace);

    const position = geometry.getAttribute("position") as THREE.BufferAttribute;

    // Damped, so the field trails the scroll slightly instead of snapping to
    // it. This is the whole difference between "cinematic" and "scrubbing".
    let eased = 0;
    let camZ = 3.1;
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

      // Which pair of arrangements we are between, and how far.
      const span = t * 3;
      const from = Math.min(2, Math.floor(span));
      const blend = smoothstep(0, 1, span - from);
      const a0 = from * COUNT * 3;
      const a1 = (from + 1) * COUNT * 3;

      const breathe = Math.sin(now / 900) * 0.06 * (1 - smoothstep(0, 0.28, t));
      for (let i = 0; i < COUNT * 3; i += 3) {
        positions[i] = lerp(targets[a0 + i], targets[a1 + i], blend);
        // The shell keeps breathing while it is still only a voice; once it is
        // a record it holds still, because a record that shimmers is a record
        // nobody trusts.
        positions[i + 1] = lerp(targets[a0 + i + 1], targets[a1 + i + 1], blend) + breathe;
        positions[i + 2] = lerp(targets[a0 + i + 2], targets[a1 + i + 2], blend);
      }
      position.needsUpdate = true;

      // The camera walks back through the story: close enough to hear one
      // person, far enough to see the system they are part of.
      const wantZ = lerp(3.1, 9.4, smoothstep(0, 1, t));
      const wantY = lerp(0, 2.6, smoothstep(0.62, 1, t));
      const k = 1 - Math.exp(-dt * 4);
      camZ += (wantZ - camZ) * k;
      camY += (wantY - camY) * k;
      camera.position.set(0, camY, camZ);
      camera.lookAt(0, lerp(0, -0.7, smoothstep(0.62, 1, t)), 0);

      // A slow turn, so the field has volume without anybody being asked to
      // notice it turning.
      points.rotation.y = lerp(0, 0.5, t) + now / 26000;

      traceMaterial.opacity = smoothstep(0.42, 0.56, t) * (1 - smoothstep(0.66, 0.78, t)) * 0.8;
      material.size = lerp(0.075, 0.052, smoothstep(0.5, 1, t));
      material.opacity = 0.55 + 0.45 * (1 - smoothstep(0.8, 1, t));

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
      traceGeometry.dispose();
      material.dispose();
      traceMaterial.dispose();
      sprite.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [progress]);

  return <div ref={mount} aria-hidden className="absolute inset-0" />;
}
