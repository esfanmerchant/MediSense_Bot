"use client";

/**
 * Three preferences the browser cannot express for us: text size, motion, and
 * whether pages keep themselves current.
 *
 * `prefers-reduced-motion` and the browser's own zoom already exist, and this
 * does not replace either — it exists because a person reading a vital sign on
 * a ward terminal they do not own cannot change the OS setting, and because
 * zooming the whole browser re-flows a table into uselessness while scaling the
 * root font size does not.
 *
 * **Both are one attribute on `<html>` and nothing else.** The rules that act
 * on them are installed once, from here, rather than living in `globals.css`:
 * the preference and the CSS that honours it stay in the same file, which is
 * what stops one being changed without the other. Everything in the design
 * system is sized in `rem`, so a root font size is the whole of the text
 * control.
 *
 * The store is module-level with `useSyncExternalStore`, mirroring
 * `lib/lang.ts`: the server snapshot is always the default, so prerendered HTML
 * and the first client render agree and React swaps in the stored choice
 * immediately afterwards. A held preference costs one frame, never a hydration
 * error.
 */

import { useEffect, useSyncExternalStore } from "react";

export type FontScale = "base" | "large" | "larger";
export type MotionPreference = "full" | "reduced";

export const FONT_SCALES: readonly FontScale[] = ["base", "large", "larger"];
export const MOTION_PREFERENCES: readonly MotionPreference[] = ["full", "reduced"];

const FONT_KEY = "medisense:font-scale";
const MOTION_KEY = "medisense:motion";
const LIVE_KEY = "medisense:live-updates";
const STYLE_ID = "medisense-reading-preferences";

/**
 * The rules the two attributes switch on.
 *
 * The reduced-motion block is the same one `globals.css` runs under the media
 * query, applied by choice instead of by system setting. Framer Motion reads
 * the media query rather than the DOM, so the shell also passes the preference
 * to a `MotionConfig` — CSS alone would leave the springs running.
 */
const CSS = `
:root[data-font-scale="large"] { font-size: 17.5px; }
:root[data-font-scale="larger"] { font-size: 19px; }

:root[data-motion="reduced"] *,
:root[data-motion="reduced"] *::before,
:root[data-motion="reduced"] *::after {
  animation-duration: 0.01ms !important;
  animation-iteration-count: 1 !important;
  transition-duration: 0.01ms !important;
  scroll-behavior: auto !important;
}
`;

let fontScale: FontScale | null = null;
let motionPreference: MotionPreference | null = null;
let liveUpdates: boolean | null = null;
const listeners = new Set<() => void>();

function readStored<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const stored = window.localStorage.getItem(key);
    return allowed.includes(stored as T) ? (stored as T) : fallback;
  } catch {
    // Private mode, or storage blocked. A default is an answer, not an error.
    return fallback;
  }
}

function persist(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Not remembered for next time, still applied for this one.
  }
}

export function getFontScale(): FontScale {
  if (fontScale === null) fontScale = readStored(FONT_KEY, FONT_SCALES, "base");
  return fontScale;
}

export function getMotionPreference(): MotionPreference {
  if (motionPreference === null) {
    motionPreference = readStored(MOTION_KEY, MOTION_PREFERENCES, "full");
  }
  return motionPreference;
}

/**
 * Whether pages re-ask the server on their own.
 *
 * On by default, because the alternative is what people were doing instead:
 * pressing refresh, losing their place, and reading a screen they cannot tell
 * is stale. It is a preference rather than a fixed behaviour because a metered
 * connection is a real thing, and because somebody comparing two numbers wants
 * the screen to hold still while they do it.
 *
 * "off" is stored explicitly rather than by absence — an unset key has to mean
 * the default, and the default is on.
 */
export function getLiveUpdates(): boolean {
  if (liveUpdates === null) liveUpdates = readStored(LIVE_KEY, ["on", "off"], "on") === "on";
  return liveUpdates;
}

/** Writes both preferences onto `<html>`, where the CSS above can see them. */
function apply(): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.dataset.fontScale = getFontScale();
  root.dataset.motion = getMotionPreference();
}

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function setFontScale(next: FontScale): void {
  fontScale = next;
  persist(FONT_KEY, next);
  apply();
  emit();
}

export function setMotionPreference(next: MotionPreference): void {
  motionPreference = next;
  persist(MOTION_KEY, next);
  apply();
  emit();
}

export function setLiveUpdates(next: boolean): void {
  liveUpdates = next;
  persist(LIVE_KEY, next ? "on" : "off");
  // No `apply()`: this one writes no attribute and has no stylesheet. It is
  // read by useAsync, which re-subscribes on the change emitted below — so
  // turning it off stops every timer on the page at once rather than at each
  // page's next navigation.
  emit();
}

export function useFontScale(): FontScale {
  return useSyncExternalStore(subscribe, getFontScale, () => "base" as FontScale);
}

export function useMotionPreference(): MotionPreference {
  return useSyncExternalStore(subscribe, getMotionPreference, () => "full" as MotionPreference);
}

/**
 * The server snapshot is `true`, matching the default. Prerendered HTML and the
 * first client render therefore agree, and somebody who has turned this off
 * loses one frame of a timer that is cleaned up on the very next render.
 */
export function useLiveUpdates(): boolean {
  return useSyncExternalStore(subscribe, getLiveUpdates, () => true);
}

/**
 * Installs the stylesheet and applies the stored choice.
 *
 * A hook rather than a component, so the shell can call it once at the top and
 * have it hold for every branch it renders — including the second the session
 * is still being checked, which is exactly when somebody with large text would
 * otherwise watch the page resize under them.
 *
 * It runs after mount rather than during render because reading `localStorage`
 * in render is what a hydration mismatch is made of.
 */
export function useReadingPreferences(): void {
  useEffect(() => {
    if (!document.getElementById(STYLE_ID)) {
      const style = document.createElement("style");
      style.id = STYLE_ID;
      style.textContent = CSS;
      document.head.append(style);
    }
    apply();
  }, []);
}
