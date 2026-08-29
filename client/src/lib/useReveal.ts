"use client";

/**
 * Reveal-on-scroll, built so that failure means "no animation", never
 * "no content".
 *
 * The classic implementation hides elements in CSS and un-hides them from an
 * IntersectionObserver — which leaves the page blank for anyone whose
 * JavaScript failed, and permanently hidden if the observer never fires. Here
 * the hiding itself only happens *from JavaScript, after mount*: server-rendered
 * HTML is fully visible, a crawler sees everything, and a broken script costs
 * the fade, not the page.
 *
 * `prefers-reduced-motion` skips the whole mechanism — the hook simply never
 * hides anything.
 */

import { useEffect, useRef } from "react";

export function useReveal<T extends HTMLElement = HTMLDivElement>(delayMs = 0) {
  const ref = useRef<T | null>(null);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    if (!("IntersectionObserver" in window)) return;

    element.style.transitionDelay = `${delayMs}ms`;
    element.classList.add("reveal-start");

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            element.classList.add("reveal-in");
            observer.disconnect();
          }
        }
      },
      { threshold: 0.15, rootMargin: "0px 0px -40px 0px" },
    );
    observer.observe(element);

    return () => observer.disconnect();
  }, [delayMs]);

  return ref;
}
