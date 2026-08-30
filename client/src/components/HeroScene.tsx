"use client";

/**
 * The hero's living background: the logo's circuit field, given depth.
 *
 * Three.js is allowed on exactly one surface — this one. The landing page is
 * marketing; the portals are clinical, and a WebGL context has no business
 * competing with a vitals table for GPU or attention. The component is loaded
 * with `next/dynamic` and `ssr: false`, so its ~150KB never rides along to any
 * portal route, and the hero renders its CSS field first either way.
 *
 * **Why a lattice and not an object.** The previous version of this file drew
 * an ECG waveform in additive-blended particles on navy. It was written for a
 * dark hero and it cannot survive a light one: additive blending on `#f6f9fc`
 * washes white on white. More to the point, a *shape* in a hero has to be
 * aimed — it has a top, a centre and an orientation, all of which land wrong
 * at the one breakpoint nobody opened. A field has none of those. This is the
 * same motif the SVG `CircuitNodes` already draws in the hero's right-hand
 * frame — nodes joined by routed traces — lifted into three dimensions and
 * given parallax, so the canvas occupies exactly the box the flat decoration
 * occupied and cannot collide with the headline or the card in front of it.
 *
 * The palette is the brand ramp and only the brand ramp: `#0B3FA8` at the top
 * left through `#1A8FC7` to `#14C4C1` at the bottom right, the same 135° run
 * as `--ms-gradient`, sampled per node from its own position. Travelling
 * pulses ride the traces the way a monitor's cursor rides a trace.
 *
 * Failure and cost handling, because a hero must never cost the page:
 * - WebGL unavailable → `onReady(false)`, and the caller keeps the SVG field.
 * - `prefers-reduced-motion` → one composed frame, no loop, no listeners.
 * - Tab hidden or hero scrolled away → the loop stops.
 * - Theme flips → materials are re-tuned in place; nothing is rebuilt.
 * - Pixel ratio capped at 1.75; every geometry, material, texture and the
 *   renderer itself disposed on unmount.
 * - `pointer-events: none` and `aria-hidden`: decorative, full stop.
 */

import { useEffect, useRef } from "react";
import * as THREE from "three";

/* ------------------------------------------------------------------ */
/* The ramp                                                            */
/* ------------------------------------------------------------------ */

const RAMP: [number, number][] = [
  [0.0, 0x0b3fa8],
  [0.55, 0x1a8fc7],
  [1.0, 0x14c4c1],
];

const scratch = new THREE.Color();
const stopA = new THREE.Color();
const stopB = new THREE.Color();

/** The 135° brand gradient, sampled at `t` and written into `target`. */
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

/* ------------------------------------------------------------------ */
/* The lattice                                                         */
/* ------------------------------------------------------------------ */

const COLS = 6;
const ROWS = 10;
const LAYERS = 3;
const STEP_X = 3.0;
const STEP_Y = 2.2;
const STEP_Z = 2.4;

/** A soft round sprite, so a "node" is a dot and not a screen-aligned square. */
function makeSprite(): THREE.Texture {
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d");
  if (context) {
    const gradient = context.createRadialGradient(
      size / 2,
      size / 2,
      0,
      size / 2,
      size / 2,
      size / 2,
    );
    gradient.addColorStop(0, "rgba(255,255,255,1)");
    gradient.addColorStop(0.45, "rgba(255,255,255,0.85)");
    gradient.addColorStop(1, "rgba(255,255,255,0)");
    context.fillStyle = gradient;
    context.fillRect(0, 0, size, size);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

export function HeroScene({
  /** Told `false` when there is no WebGL, so the caller can keep its fallback. */
  onReady,
}: {
  onReady?: (ok: boolean) => void;
}) {
  const mount = useRef<HTMLDivElement | null>(null);

  // Kept in a ref rather than in the scene effect's dependencies: a new
  // callback identity must never tear down and rebuild a WebGL context.
  const ready = useRef(onReady);
  useEffect(() => {
    ready.current = onReady;
  }, [onReady]);

  useEffect(() => {
    const host = mount.current;
    if (!host) return;

    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, powerPreference: "low-power" });
    } catch {
      ready.current?.(false);
      return; // No WebGL. The SVG circuit field behind this element carries the frame.
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
    const camera = new THREE.PerspectiveCamera(46, width() / height(), 0.1, 120);
    camera.position.set(0, 0, 17);

    const group = new THREE.Group();
    scene.add(group);

    /* --- nodes ---------------------------------------------------- */

    // Deterministic jitter: a reload must not reshuffle the background, and a
    // lattice with no jitter at all is graph paper.
    let seed = 20260830;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };

    const count = COLS * ROWS * LAYERS;
    const base = new Float32Array(count * 3);
    const phase = new Float32Array(count);
    const nodePositions = new Float32Array(count * 3);
    const nodeColors = new Float32Array(count * 3);
    const nodeIndex = (c: number, r: number, l: number) => (l * ROWS + r) * COLS + c;

    for (let l = 0; l < LAYERS; l++) {
      for (let r = 0; r < ROWS; r++) {
        for (let c = 0; c < COLS; c++) {
          const i = nodeIndex(c, r, l);
          const x = (c - (COLS - 1) / 2) * STEP_X + (random() - 0.5) * STEP_X * 0.42;
          const y = ((ROWS - 1) / 2 - r) * STEP_Y + (random() - 0.5) * STEP_Y * 0.42;
          const z = (l - (LAYERS - 1) / 2) * STEP_Z + (random() - 0.5) * STEP_Z * 0.3;
          base[i * 3] = x;
          base[i * 3 + 1] = y;
          base[i * 3 + 2] = z;
          phase[i] = random() * Math.PI * 2;

          // The ramp reads 135°: royal blue top-left, teal bottom-right.
          const t = (c / (COLS - 1) + r / (ROWS - 1)) / 2;
          rampAt(t, scratch);
          scratch.convertSRGBToLinear();
          nodeColors[i * 3] = scratch.r;
          nodeColors[i * 3 + 1] = scratch.g;
          nodeColors[i * 3 + 2] = scratch.b;
        }
      }
    }
    nodePositions.set(base);

    const nodeGeometry = new THREE.BufferGeometry();
    nodeGeometry.setAttribute("position", new THREE.BufferAttribute(nodePositions, 3));
    nodeGeometry.setAttribute("color", new THREE.BufferAttribute(nodeColors, 3));

    const sprite = makeSprite();
    const nodeMaterial = new THREE.PointsMaterial({
      size: 0.34,
      map: sprite,
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      sizeAttenuation: true,
    });
    const nodes = new THREE.Points(nodeGeometry, nodeMaterial);
    group.add(nodes);

    /* --- traces --------------------------------------------------- */

    // Routed like a board: mostly right and down, occasionally into depth.
    const edges: [number, number][] = [];
    for (let l = 0; l < LAYERS; l++) {
      for (let r = 0; r < ROWS; r++) {
        for (let c = 0; c < COLS; c++) {
          const a = nodeIndex(c, r, l);
          if (c + 1 < COLS && random() > 0.42) edges.push([a, nodeIndex(c + 1, r, l)]);
          if (r + 1 < ROWS && random() > 0.46) edges.push([a, nodeIndex(c, r + 1, l)]);
          if (l + 1 < LAYERS && random() > 0.82) edges.push([a, nodeIndex(c, r, l + 1)]);
        }
      }
    }

    const edgePositions = new Float32Array(edges.length * 6);
    const edgeColors = new Float32Array(edges.length * 6);
    for (let e = 0; e < edges.length; e++) {
      const [a, b] = edges[e];
      for (let k = 0; k < 3; k++) {
        edgeColors[e * 6 + k] = nodeColors[a * 3 + k];
        edgeColors[e * 6 + 3 + k] = nodeColors[b * 3 + k];
      }
    }
    const edgeGeometry = new THREE.BufferGeometry();
    edgeGeometry.setAttribute("position", new THREE.BufferAttribute(edgePositions, 3));
    edgeGeometry.setAttribute("color", new THREE.BufferAttribute(edgeColors, 3));
    const edgeMaterial = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      depthWrite: false,
    });
    const traces = new THREE.LineSegments(edgeGeometry, edgeMaterial);
    group.add(traces);

    /** Copy node positions into the trace buffer, so traces stay attached. */
    const layTraces = () => {
      for (let e = 0; e < edges.length; e++) {
        const [a, b] = edges[e];
        for (let k = 0; k < 3; k++) {
          edgePositions[e * 6 + k] = nodePositions[a * 3 + k];
          edgePositions[e * 6 + 3 + k] = nodePositions[b * 3 + k];
        }
      }
      edgeGeometry.attributes.position.needsUpdate = true;
    };

    /* --- pulses --------------------------------------------------- */

    const PULSES = 7;
    const pulsePositions = new Float32Array(PULSES * 3);
    const pulseEdge = new Int32Array(PULSES);
    const pulseAt = new Float32Array(PULSES);
    const pulseSpeed = new Float32Array(PULSES);
    for (let p = 0; p < PULSES; p++) {
      pulseEdge[p] = Math.floor(random() * edges.length);
      pulseAt[p] = random();
      pulseSpeed[p] = 0.16 + random() * 0.22;
    }
    const pulseGeometry = new THREE.BufferGeometry();
    pulseGeometry.setAttribute("position", new THREE.BufferAttribute(pulsePositions, 3));
    const pulseMaterial = new THREE.PointsMaterial({
      size: 0.62,
      map: sprite,
      transparent: true,
      depthWrite: false,
      sizeAttenuation: true,
    });
    const pulses = new THREE.Points(pulseGeometry, pulseMaterial);
    group.add(pulses);

    const layPulses = (delta: number) => {
      for (let p = 0; p < PULSES; p++) {
        pulseAt[p] += pulseSpeed[p] * delta;
        if (pulseAt[p] > 1) {
          pulseAt[p] = 0;
          pulseEdge[p] = Math.floor(Math.random() * edges.length);
        }
        const [a, b] = edges[pulseEdge[p]] ?? edges[0];
        const t = pulseAt[p];
        for (let k = 0; k < 3; k++) {
          pulsePositions[p * 3 + k] =
            nodePositions[a * 3 + k] + (nodePositions[b * 3 + k] - nodePositions[a * 3 + k]) * t;
        }
      }
      pulseGeometry.attributes.position.needsUpdate = true;
    };

    /* --- theme ----------------------------------------------------- */

    // On white the field is drawn, not lit: normal blending, so royal blue
    // reads as ink. On navy it is lit: additive, so the same ramp glows.
    const applyTheme = () => {
      const dark = document.documentElement.classList.contains("dark");
      nodeMaterial.blending = dark ? THREE.AdditiveBlending : THREE.NormalBlending;
      nodeMaterial.opacity = dark ? 0.9 : 0.85;
      nodeMaterial.size = dark ? 0.4 : 0.34;
      nodeMaterial.needsUpdate = true;

      edgeMaterial.blending = dark ? THREE.AdditiveBlending : THREE.NormalBlending;
      edgeMaterial.opacity = dark ? 0.42 : 0.3;
      edgeMaterial.needsUpdate = true;

      pulseMaterial.blending = dark ? THREE.AdditiveBlending : THREE.NormalBlending;
      pulseMaterial.opacity = dark ? 1 : 0.95;
      pulseMaterial.color
        .setHex(dark ? 0x8ff5e6 : 0x14c4c1, THREE.SRGBColorSpace)
        .convertSRGBToLinear();
      pulseMaterial.needsUpdate = true;
    };
    applyTheme();

    const themeObserver = new MutationObserver(() => {
      applyTheme();
      if (!running) renderer.render(scene, camera);
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });

    /* --- the loop -------------------------------------------------- */

    const pointer = { x: 0, y: 0 };
    const lean = { x: 0, y: 0 };
    const onPointer = (event: PointerEvent) => {
      pointer.x = (event.clientX / window.innerWidth) * 2 - 1;
      pointer.y = (event.clientY / window.innerHeight) * 2 - 1;
    };

    const fit = () => {
      camera.aspect = width() / height();
      // A narrow column has to pull the camera back or the lattice crops to a
      // stripe; a wide one must not push it so far that the field goes to dust.
      camera.position.z = THREE.MathUtils.clamp(17 / Math.max(camera.aspect, 0.45), 15, 26);
      camera.updateProjectionMatrix();
      renderer.setSize(width(), height(), false);
    };
    fit();

    let frame = 0;
    let running = false;
    let elapsed = 0;
    const clock = new THREE.Clock();

    const draw = (elapsed: number, delta: number) => {
      // The lattice breathes: nodes drift in depth, traces follow them.
      for (let i = 0; i < count; i++) {
        nodePositions[i * 3] = base[i * 3] + Math.sin(elapsed * 0.24 + phase[i]) * 0.12;
        nodePositions[i * 3 + 1] = base[i * 3 + 1] + Math.cos(elapsed * 0.19 + phase[i]) * 0.12;
        nodePositions[i * 3 + 2] = base[i * 3 + 2] + Math.sin(elapsed * 0.31 + phase[i]) * 0.34;
      }
      nodeGeometry.attributes.position.needsUpdate = true;
      layTraces();
      layPulses(delta);

      // Parallax as a lean, not a pan: the field stays where the composition
      // put it, and only tilts toward the cursor.
      lean.x += (pointer.x - lean.x) * 0.04;
      lean.y += (pointer.y - lean.y) * 0.04;
      group.rotation.y = Math.sin(elapsed * 0.13) * 0.24 + lean.x * 0.2;
      group.rotation.x = Math.sin(elapsed * 0.1) * 0.09 - lean.y * 0.12;

      renderer.render(scene, camera);
    };

    const loop = () => {
      if (!running) return;
      // `getDelta` only, never `getElapsedTime`: the latter consumes the same
      // delta internally, and calling both leaves the second one reading zero.
      const delta = Math.min(clock.getDelta(), 0.05);
      elapsed += delta;
      draw(elapsed, delta);
      frame = requestAnimationFrame(loop);
    };

    const start = () => {
      if (running || reduceMotion) return;
      running = true;
      clock.getDelta(); // Drop the time spent paused.
      loop();
    };
    const stop = () => {
      running = false;
      cancelAnimationFrame(frame);
    };

    if (reduceMotion) {
      // One composed frame: the field is the point, the motion is the flourish.
      layTraces();
      layPulses(0.4);
      group.rotation.y = 0.18;
      group.rotation.x = 0.05;
      renderer.render(scene, camera);
    } else {
      window.addEventListener("pointermove", onPointer, { passive: true });
    }

    ready.current?.(true);

    const onVisibility = () => {
      if (document.hidden) stop();
      else start();
    };
    document.addEventListener("visibilitychange", onVisibility);

    // Only run while the hero is on screen. Below the fold it is a dead cost.
    const intersection = new IntersectionObserver(([entry]) => {
      if (entry?.isIntersecting && !document.hidden) start();
      else stop();
    });
    intersection.observe(host);

    const resize = new ResizeObserver(() => {
      fit();
      if (!running) renderer.render(scene, camera);
    });
    resize.observe(host);

    return () => {
      stop();
      intersection.disconnect();
      resize.disconnect();
      themeObserver.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pointermove", onPointer);
      nodeGeometry.dispose();
      nodeMaterial.dispose();
      edgeGeometry.dispose();
      edgeMaterial.dispose();
      pulseGeometry.dispose();
      pulseMaterial.dispose();
      sprite.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, []);

  return <div ref={mount} aria-hidden className="pointer-events-none absolute inset-0" />;
}

export default HeroScene;
