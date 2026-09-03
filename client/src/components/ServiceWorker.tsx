"use client";

/**
 * Registers the service worker, once, after the page is interactive.
 *
 * Deliberately not during render and deliberately not before load: registering
 * a worker kicks off a fetch and an install, and doing that while the first
 * screen is still painting spends bandwidth the person is waiting on.
 *
 * **Development registers it too, with caching off.** It used to be skipped
 * entirely — and push notifications are delivered *to a service worker*, so
 * with none registered `navigator.serviceWorker.ready` never resolved and the
 * "Turn on notifications" button sat there doing nothing, with no error to
 * explain it. Nobody could enrol a device, so nothing was ever pushed.
 *
 * The reason it was skipped still stands: a worker that caches a dev build
 * serves yesterday's JavaScript after a rebuild. So the dev registration
 * carries `?dev=1`, and the worker reads that and passes every fetch straight
 * through — present for push, invisible to the network.
 */

import { useEffect } from "react";

export function ServiceWorker() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;

    // Same worker, told not to cache. A different script URL is a different
    // registration, so a production build replaces the development one rather
    // than the two fighting over the scope.
    const script = process.env.NODE_ENV === "production" ? "/sw.js" : "/sw.js?dev=1";

    const register = () => {
      void navigator.serviceWorker.register(script).catch(() => {
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
