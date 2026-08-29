"use client";

/**
 * Bilingual text: Roman Urdu by default, English on demand.
 *
 * The site is written in Roman Urdu first — the language its users actually
 * type in — with a one-tap switch to English in the navigation. Both strings
 * live side by side at every call site:
 *
 *     tr("Book a visit", "Appointment book karein")
 *
 * That inline shape is deliberate. A key-based dictionary hides one language
 * from whoever is reading the code, and with two languages and hundreds of
 * strings, "the translation is right next to the English" is worth more than
 * indirection. It also makes a missing translation impossible: the second
 * argument is not optional.
 *
 * **What the toggle cannot translate:** content the server composed — an
 * assistant answer, an alert message, a notification body, the AI disclaimer.
 * Those are data, not chrome, and rewriting clinical text client-side would be
 * a safety problem, not a feature. They render exactly as the server sent them.
 *
 * The store is module-level with `useSyncExternalStore`, not a context: no
 * provider to forget, and the server snapshot is always the default language so
 * hydration never mismatches — React swaps to the visitor's stored choice in
 * the first client render.
 */

import { useCallback, useSyncExternalStore } from "react";

export type Lang = "ur" | "en";

const STORAGE_KEY = "medisense:lang";
const DEFAULT_LANG: Lang = "ur";

let current: Lang | null = null;
const listeners = new Set<() => void>();

function read(): Lang {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return stored === "en" || stored === "ur" ? stored : DEFAULT_LANG;
  } catch {
    // Private mode, or storage blocked. The default is a language, not an error.
    return DEFAULT_LANG;
  }
}

export function getLang(): Lang {
  if (current === null) current = read();
  return current;
}

export function setLang(next: Lang): void {
  current = next;
  try {
    window.localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // The choice still applies for this visit.
  }
  // `lang` is what a screen reader picks its voice from. Roman Urdu is Urdu in
  // Latin script, which BCP-47 writes as ur-Latn.
  document.documentElement.lang = next === "ur" ? "ur-Latn" : "en";
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useLang(): Lang {
  // The server snapshot is the default language, always: prerendered HTML is
  // Roman Urdu, and a visitor who chose English is switched in the first
  // client render — a brief flash, never a hydration error.
  return useSyncExternalStore(subscribe, getLang, () => DEFAULT_LANG);
}

/** The translation function. `tr(english, romanUrdu)` picks by current language. */
export function useTr(): (en: string, ur: string) => string {
  const lang = useLang();
  return useCallback((en: string, ur: string) => (lang === "ur" ? ur : en), [lang]);
}
