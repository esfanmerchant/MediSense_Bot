"use client";

/**
 * Five shapes, one field of particles. Scroll is the only clock.
 *
 *   I    a point        — one heartbeat, alone in the dark
 *   II   a trace        — it stretches into an ECG, and an echo answers it
 *   III  the mark       — the trace folds into the MediSense cross: a record
 *   IV   three panels   — the mark opens into patient, doctor and administrator
 *   V    a field        — one mark becomes a clinic on every block of a city
 *
 * The same particles throughout. Nothing is added between acts and nothing is
 * thrown away, because that is the argument: a spoken symptom and the record a
 * doctor reads are one piece of information, not a copy of one. A scene that
 * dissolved between five different objects would be arguing the opposite.
 *
 * **The morph runs on the GPU, and it staggers.** Every particle carries both
 * its current shape and its next one as attributes; a single uniform says how
 * far between them the scroll has travelled, and each particle offsets that by
 * its own seed. So the field *streams* from one shape into the next instead of
 * every point setting off at once — which is the whole difference between a
 * transformation and a cross-fade. Doing this on the CPU would cap the count at
 * a few thousand; on the GPU twenty-four thousand costs one uniform write.
 *
 * **Metal, not neon.** One blue — #00194D — lit rather than coloured. A
 * specular band travels across the field and brightens whatever it crosses,
 * which is the whole of the metallic read: a surface that is dark until light
 * lands on it.
 *
 * **Raw three.js, deliberately.** This project already has one hand-written
 * WebGL surface carrying the failure handling a clinical product needs — no
 * context, reduced motion, hidden tab, disposal, capped pixel ratio. Six
 * rendering and scroll libraries to express the same behaviour would mean two
 * integrations, two copies of that discipline, and something close to a
 * megabyte for one page.
 *
 * **React never re-renders for the scroll.** Progress arrives through a ref the
 * loop reads, and the loop damps it further. That damping is the difference
 * between camera work and scrubbing.
 */

import { useEffect, useRef } from "react";
import * as THREE from "three";

import { SHAPES } from "@/components/landing/storyTargets";

/** Particles. Halved where the device says it cannot afford them. */
const FULL = 24_000;
const LIGHT = 9_000;

/** Where the camera stands for each act, and what it looks at. */
const CAMERA: { position: [number, number, number]; target: [number, number, number] }[] = [
  { position: [0, 0, 3.4], target: [0, 0, 0] },
  { position: [0, 0, 5.2], target: [0, 0, 0] },
  { position: [0, 0.12, 3.9], target: [0, 0, 0] },
  { position: [0, 0.2, 4.6], target: [0, 0, 0] },
  { position: [0, 4.6, 10.5], target: [0, 0, -1.6] },
];

const clamp01 = (t: number) => (t < 0 ? 0 : t > 1 ? 1 : t);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

function smoothstep(t: number) {
  const x = clamp01(t);
  return x * x * (3 - 2 * x);
}

const VERTEX = /* glsl */ `
  attribute vec3 aFrom;
  attribute vec3 aTo;
  attribute float aSeed;

  uniform float uMix;
  uniform float uPulse;
  uniform float uSize;
  uniform float uSweep;
  uniform float uScale;

  varying float vLit;

  void main() {
    // Each particle starts a quarter of the way behind the one ahead of it, so
    // the field streams into its next shape rather than jumping into it.
    float staggered = clamp((uMix - aSeed * 0.28) / 0.72, 0.0, 1.0);
    float eased = staggered * staggered * (3.0 - 2.0 * staggered);

    vec3 here = mix(aFrom, aTo, eased) * uScale;

    // The heartbeat, felt only while the field is still one point.
    here *= 1.0 + uPulse * 0.16;

    vec4 view = modelViewMatrix * vec4(here, 1.0);
    gl_Position = projectionMatrix * view;

    // Light falls off with distance from the travelling band, plus a little
    // from depth, so the far side of the field sits behind the near side.
    float band = 1.0 - clamp(abs(here.x - uSweep) / 2.6, 0.0, 1.0);
    vLit = band * band * 0.9 + clamp(0.5 + here.z * 0.3, 0.0, 1.0) * 0.28 + uPulse * 0.35;

    gl_PointSize = uSize * (1.0 + vLit * 0.7) * (300.0 / -view.z);
  }
`;

const FRAGMENT = /* glsl */ `
  precision mediump float;

  uniform float uOpacity;
  varying float vLit;

  // The steel: ground, mid, sky, highlight. A particle's place on this ramp is
  // how much light is on it, not where it sits — so the field reads as one
  // material rather than as a gradient somebody painted on.
  vec3 steel(float t) {
    vec3 ground = vec3(0.000, 0.098, 0.302);
    vec3 mid    = vec3(0.118, 0.353, 0.659);
    vec3 sky    = vec3(0.369, 0.784, 0.902);
    vec3 hot    = vec3(0.863, 0.937, 1.000);
    if (t < 0.42) return mix(ground, mid, t / 0.42);
    if (t < 0.76) return mix(mid, sky, (t - 0.42) / 0.34);
    return mix(sky, hot, clamp((t - 0.76) / 0.24, 0.0, 1.0));
  }

  void main() {
    // A round, soft point. Discarding the corners is what stops 24,000 squares
    // reading as static.
    vec2 offset = gl_PointCoord - vec2(0.5);
    float d = dot(offset, offset);
    if (d > 0.25) discard;
    float falloff = 1.0 - smoothstep(0.06, 0.25, d);

    gl_FragColor = vec4(steel(0.14 + vLit), falloff * uOpacity);
  }
`;

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

    // What the machine says it can afford. `deviceMemory` is Chromium-only and
    // absent elsewhere, which is why its absence is not treated as "low".
    const cores = navigator.hardwareConcurrency ?? 8;
    const memory = (navigator as { deviceMemory?: number }).deviceMemory ?? 8;
    const count = cores < 4 || memory < 4 || window.innerWidth < 1024 ? LIGHT : FULL;

    const width = () => host.clientWidth || 1;
    const height = () => host.clientHeight || 1;

    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    renderer.setSize(width(), height(), false);
    renderer.domElement.style.width = "100%";
    renderer.domElement.style.height = "100%";
    renderer.domElement.style.display = "block";
    host.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(42, width() / height(), 0.1, 80);

    // All five arrangements, built once. Roughly three megabytes at full count
    // and a few milliseconds — cheap enough to do up front, which is what keeps
    // an act boundary from stuttering while it computes the shape it is
    // already halfway into.
    const shapes = SHAPES.map((build) => build(count));

    const from = new THREE.BufferAttribute(new Float32Array(shapes[0]), 3);
    const to = new THREE.BufferAttribute(new Float32Array(shapes[1]), 3);
    const seeds = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      const x = Math.sin(i * 91.7 + 13.1) * 43758.5453;
      seeds[i] = x - Math.floor(x);
    }

    const geometry = new THREE.BufferGeometry();
    // `position` is required by three even though the shader ignores it.
    geometry.setAttribute("position", from);
    geometry.setAttribute("aFrom", from);
    geometry.setAttribute("aTo", to);
    geometry.setAttribute("aSeed", new THREE.BufferAttribute(seeds, 1));
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 30);

    const uniforms = {
      uMix: { value: 0 },
      uPulse: { value: 0 },
      uSize: { value: 1.7 },
      uSweep: { value: -4 },
      uScale: { value: 1 },
      uOpacity: { value: 0.9 },
    };

    const material = new THREE.ShaderMaterial({
      uniforms,
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      transparent: true,
      depthWrite: false,
      // Additive, so where the field is dense it brightens — which is what
      // gives a cloud of points the weight of a lit surface.
      blending: THREE.AdditiveBlending,
    });

    const points = new THREE.Points(geometry, material);
    scene.add(points);

    /** Which pair of shapes the attributes currently hold. */
    let loaded = 0;
    const swapTo = (pair: number) => {
      if (pair === loaded) return;
      (from.array as Float32Array).set(shapes[pair]);
      (to.array as Float32Array).set(shapes[Math.min(shapes.length - 1, pair + 1)]);
      from.needsUpdate = true;
      to.needsUpdate = true;
      loaded = pair;
    };

    let eased = 0;
    const eye = new THREE.Vector3(...CAMERA[0].position);
    const look = new THREE.Vector3(...CAMERA[0].target);
    const wantEye = new THREE.Vector3();
    const wantLook = new THREE.Vector3();

    let frame = 0;
    let running = true;
    let last = performance.now();

    const draw = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;

      const target = clamp01(progress.current ?? 0);
      eased += (target - eased) * (1 - Math.exp(-dt * 5.5));
      const t = eased;

      // Four transitions across five acts.
      const span = t * (shapes.length - 1);
      const pair = Math.min(shapes.length - 2, Math.floor(span));
      swapTo(pair);
      uniforms.uMix.value = clamp01(span - pair);

      // Sixty beats a minute, and only while the field is still one point.
      // A record that throbs is a record nobody trusts.
      const alive = 1 - smoothstep(t / 0.16);
      const beat = Math.max(0, Math.sin((now / 1000) * Math.PI)) ** 6;
      uniforms.uPulse.value = beat * alive;

      uniforms.uSweep.value = ((now / 3400) % 1) * 24 - 12;
      uniforms.uSize.value = lerp(2.6, 1.25, smoothstep(t * 1.4));
      uniforms.uOpacity.value = 0.55 + 0.4 * smoothstep(t / 0.12);

      // The camera walks the story: close enough to hear one person, far
      // enough to see the system they are part of.
      const cam = t * (CAMERA.length - 1);
      const step = Math.min(CAMERA.length - 2, Math.floor(cam));
      const between = smoothstep(cam - step);
      const a = CAMERA[step];
      const b = CAMERA[step + 1];
      wantEye.set(
        lerp(a.position[0], b.position[0], between),
        lerp(a.position[1], b.position[1], between),
        lerp(a.position[2], b.position[2], between),
      );
      wantLook.set(
        lerp(a.target[0], b.target[0], between),
        lerp(a.target[1], b.target[1], between),
        lerp(a.target[2], b.target[2], between),
      );

      const k = 1 - Math.exp(-dt * 4);
      eye.lerp(wantEye, k);
      look.lerp(wantLook, k);
      camera.position.copy(eye);
      camera.lookAt(look);

      // Flat while it is something you read face-on — a trace and a mark are
      // read square — and turning only once it becomes a place.
      points.rotation.y = smoothstep((t - 0.62) / 0.38) * 0.3 + now / 60000;

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
