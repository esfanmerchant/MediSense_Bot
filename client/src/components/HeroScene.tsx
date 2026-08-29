"use client";

/**
 * The hero's living background: a heartbeat drawn in particles.
 *
 * Three.js is allowed on exactly one surface — this one. The landing page is
 * marketing; the portals are clinical, and a WebGL context has no business
 * competing with a vitals table for GPU or attention. The component is loaded
 * with `next/dynamic`, so its ~150KB never rides along to any portal route.
 *
 * The scene is thematic rather than generic: ~1,400 points trace a repeating
 * ECG waveform through space, a bright pulse travels the trace the way a
 * monitor's cursor does, and a sparse ambient field gives it depth. Palette is
 * the design system's — teal `#5EEAD4` and periwinkle `#b0c6ff` on the hero's
 * navy — so the 3D layer reads as the product's own light, not a stock effect.
 *
 * Failure and cost handling, because a hero must never cost the page:
 * - WebGL unavailable → render nothing; the CSS gradient behind stays.
 * - `prefers-reduced-motion` → one static frame, no animation loop.
 * - Tab hidden or hero scrolled away → the loop pauses.
 * - Pixel ratio capped at 1.75; everything disposed on unmount.
 * - `pointer-events: none` and `aria-hidden`: decorative, full stop.
 */

import { useEffect, useRef } from "react";
import * as THREE from "three";

/** One heartbeat of an ECG, period 1: flatline, P, QRS spike, T, flatline. */
function ecg(t: number): number {
  const x = ((t % 1) + 1) % 1;
  // P wave
  if (x > 0.14 && x < 0.22) return 0.14 * Math.sin(((x - 0.14) / 0.08) * Math.PI);
  // QRS complex
  if (x > 0.3 && x < 0.34) return -0.22 * Math.sin(((x - 0.3) / 0.04) * Math.PI);
  if (x >= 0.34 && x < 0.4) return 1.05 * Math.sin(((x - 0.34) / 0.06) * Math.PI);
  if (x >= 0.4 && x < 0.44) return -0.32 * Math.sin(((x - 0.4) / 0.04) * Math.PI);
  // T wave
  if (x > 0.55 && x < 0.68) return 0.24 * Math.sin(((x - 0.55) / 0.13) * Math.PI);
  return 0;
}

const TRACE_POINTS = 900;
const FIELD_POINTS = 500;
const SPAN = 22; // world units of trace shown

export function HeroScene() {
  const mount = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const host = mount.current;
    if (!host) return;

    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
    } catch {
      return; // No WebGL. The gradient behind this element carries the hero.
    }

    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
    renderer.setSize(host.clientWidth, host.clientHeight);
    host.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(
      55,
      host.clientWidth / host.clientHeight,
      0.1,
      100,
    );
    camera.position.set(0, 0.4, 9);

    // --- the ECG trace, twice: teal in front, blue echo behind -------------
    const makeTrace = (color: number, size: number, zOffset: number, dim: number) => {
      const positions = new Float32Array(TRACE_POINTS * 3);
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
      const material = new THREE.PointsMaterial({
        color,
        size,
        transparent: true,
        opacity: dim,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        sizeAttenuation: true,
      });
      const points = new THREE.Points(geometry, material);
      points.position.z = zOffset;
      scene.add(points);
      return { geometry, material, positions };
    };

    const teal = makeTrace(0x5eead4, 0.055, 0, 0.9);
    const blue = makeTrace(0x8aa4ff, 0.045, -1.6, 0.45);

    // --- ambient field ------------------------------------------------------
    const fieldPositions = new Float32Array(FIELD_POINTS * 3);
    for (let i = 0; i < FIELD_POINTS; i++) {
      fieldPositions[i * 3] = (Math.random() - 0.5) * 26;
      fieldPositions[i * 3 + 1] = (Math.random() - 0.5) * 14;
      fieldPositions[i * 3 + 2] = -2 - Math.random() * 8;
    }
    const fieldGeometry = new THREE.BufferGeometry();
    fieldGeometry.setAttribute("position", new THREE.BufferAttribute(fieldPositions, 3));
    const fieldMaterial = new THREE.PointsMaterial({
      color: 0x8aa4ff,
      size: 0.035,
      transparent: true,
      opacity: 0.35,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const field = new THREE.Points(fieldGeometry, fieldMaterial);
    scene.add(field);

    // --- the travelling pulse ----------------------------------------------
    const pulseGeometry = new THREE.BufferGeometry();
    pulseGeometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(3), 3));
    const pulseMaterial = new THREE.PointsMaterial({
      color: 0xffffff,
      size: 0.34,
      transparent: true,
      opacity: 0.95,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const pulse = new THREE.Points(pulseGeometry, pulseMaterial);
    scene.add(pulse);

    /** Lay the trace for a given time offset; returns y at parameter `at`. */
    const layTrace = (positions: Float32Array, phase: number, wobble: number) => {
      for (let i = 0; i < TRACE_POINTS; i++) {
        const t = i / TRACE_POINTS;
        const x = (t - 0.5) * SPAN;
        const beat = ecg(t * 3 + phase); // three beats across the span
        positions[i * 3] = x;
        positions[i * 3 + 1] = beat * 2.1 + Math.sin(t * 14 + wobble) * 0.05;
        positions[i * 3 + 2] = Math.sin(t * 6.28 + wobble) * 0.4;
      }
    };

    const pointer = { x: 0, y: 0 };
    const onPointer = (event: PointerEvent) => {
      pointer.x = (event.clientX / window.innerWidth) * 2 - 1;
      pointer.y = (event.clientY / window.innerHeight) * 2 - 1;
    };

    const onResize = () => {
      const { clientWidth, clientHeight } = host;
      camera.aspect = clientWidth / clientHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(clientWidth, clientHeight);
    };

    let frame = 0;
    let running = true;
    const clock = new THREE.Clock();

    const draw = () => {
      const elapsed = clock.getElapsedTime();

      layTrace(teal.positions, elapsed * 0.22, elapsed * 0.4);
      layTrace(blue.positions, elapsed * 0.22 + 0.12, elapsed * 0.4 + 2);
      teal.geometry.attributes.position.needsUpdate = true;
      blue.geometry.attributes.position.needsUpdate = true;

      // The pulse rides the teal trace.
      const pt = (elapsed * 0.11) % 1;
      const px = (pt - 0.5) * SPAN;
      const py = ecg(pt * 3 + elapsed * 0.22) * 2.1;
      pulseGeometry.attributes.position.setXYZ(0, px, py, 0.05);
      pulseGeometry.attributes.position.needsUpdate = true;

      field.rotation.y = elapsed * 0.015;

      // Parallax: the camera leans toward the cursor, never snaps to it.
      camera.position.x += (pointer.x * 0.9 - camera.position.x) * 0.03;
      camera.position.y += (-pointer.y * 0.5 + 0.4 - camera.position.y) * 0.03;
      camera.lookAt(0, 0.2, 0);

      renderer.render(scene, camera);
    };

    const loop = () => {
      if (!running) return;
      draw();
      frame = requestAnimationFrame(loop);
    };

    // Static scene for reduced motion: one composed frame, no loop, no pulse.
    if (reduceMotion) {
      layTrace(teal.positions, 0.35, 0);
      layTrace(blue.positions, 0.47, 2);
      teal.geometry.attributes.position.needsUpdate = true;
      blue.geometry.attributes.position.needsUpdate = true;
      pulseMaterial.opacity = 0;
      renderer.render(scene, camera);
    } else {
      window.addEventListener("pointermove", onPointer, { passive: true });
      loop();
    }

    // Pause when nobody can see it: hidden tab, or hero scrolled away.
    const onVisibility = () => {
      const shouldRun = !document.hidden;
      if (shouldRun && !running && !reduceMotion) {
        running = true;
        clock.start();
        loop();
      } else if (!shouldRun) {
        running = false;
        cancelAnimationFrame(frame);
      }
    };
    document.addEventListener("visibilitychange", onVisibility);

    const intersection = new IntersectionObserver(([entry]) => {
      if (reduceMotion) return;
      if (entry.isIntersecting && !running) {
        running = true;
        clock.start();
        loop();
      } else if (!entry.isIntersecting && running) {
        running = false;
        cancelAnimationFrame(frame);
      }
    });
    intersection.observe(host);

    window.addEventListener("resize", onResize);

    return () => {
      running = false;
      cancelAnimationFrame(frame);
      intersection.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pointermove", onPointer);
      window.removeEventListener("resize", onResize);
      teal.geometry.dispose();
      teal.material.dispose();
      blue.geometry.dispose();
      blue.material.dispose();
      fieldGeometry.dispose();
      fieldMaterial.dispose();
      pulseGeometry.dispose();
      pulseMaterial.dispose();
      renderer.dispose();
      host.removeChild(renderer.domElement);
    };
  }, []);

  return <div ref={mount} aria-hidden className="pointer-events-none absolute inset-0" />;
}

export default HeroScene;
