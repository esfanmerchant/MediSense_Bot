"use client";

/**
 * Registers the service worker, once, after the page is interactive.
 *
 * Deliberately not during render and deliberately not before load: registering
 * a worker kicks off a fetch and an install, and doing that while the first
 * screen is still painting spends bandwidth the person is waiting on.
 *
 * Development is excluded. A worker that caches a dev build serves yesterday's
 * JavaScript after a rebuild, and the hour spent working out why is an hour
 * nobody gets back.
 */

import { useEffect } from "react";

export function ServiceWorker() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    if (!("serviceWorker" in navigator)) return;

    const register = () => {
      void navigator.serviceWorker.register("/sw.js").catch(() => {
        // An unregistered worker costs the install prompt and offline page.
        // It must never cost the application, so this is silent by design.
      });
    };

    if (document.readyState === "complete") register();
    else window.addEventListener("load", register, { once: true });

    return () => window.removeEventListener("load", register);
  }, []);

  return null;
}
