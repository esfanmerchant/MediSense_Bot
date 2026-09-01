/**
 * MediSense service worker.
 *
 * READ THIS BEFORE ADDING A CACHE RULE.
 *
 * This worker caches the application *shell* — the JavaScript, CSS, fonts and
 * icons that make up the interface — and nothing else. It does not cache a
 * single API response, and that is not an oversight or a thing to optimise
 * later:
 *
 * 1. **Every API response here is somebody's medical record.** A cached
 *    response is a copy of a patient's chart written to the disk of whatever
 *    device it was opened on, surviving sign-out, readable by the next person
 *    to use a shared ward terminal. The session ends after two minutes of
 *    inactivity precisely so that does not happen; a cache would quietly undo
 *    it.
 * 2. **Stale clinical data is worse than no data.** A doctor shown yesterday's
 *    medication list with no indication it is yesterday's is worse off than a
 *    doctor shown an error. The application already keeps itself current on a
 *    timer; a cache that answered from disk would be lying to it.
 *
 * So: static assets are cached, navigations fall back to an offline page, and
 * anything under /api goes to the network or fails honestly.
 */

const VERSION = "medisense-v1";
const SHELL = `${VERSION}-shell`;
const OFFLINE_URL = "/offline";

/** Warmed on install so the offline page is available the first time it is
    needed rather than the second. */
const PRECACHE = [OFFLINE_URL, "/brand/icon-192.png", "/brand/icon-512.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL)
      .then((cache) => cache.addAll(PRECACHE))
      // A failed precache must not leave a worker that never installs; the
      // offline page simply arrives on first use instead.
      .catch(() => undefined)
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => !key.startsWith(VERSION)).map((key) => caches.delete(key))),
      )
      .then(() => self.clients.claim()),
  );
});

/** Whether a request is a build artefact: safe to keep, immutable, not private. */
function isShellAsset(url) {
  return (
    url.pathname.startsWith("/_next/static/") ||
    url.pathname.startsWith("/brand/") ||
    url.pathname === "/icon.svg" ||
    url.pathname === "/manifest.webmanifest"
  );
}

self.addEventListener("fetch", (event) => {
  const { request } = event;

  // Only GET. A cached POST is a repeated action, and the actions here book
  // appointments and submit payments.
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Never the API. See the note at the top of this file.
  if (url.pathname.startsWith("/api/")) return;

  if (isShellAsset(url)) {
    // Cache first: these filenames contain a content hash, so a hit is always
    // the right answer and a miss is a one-time fetch.
    event.respondWith(
      caches.match(request).then(
        (hit) =>
          hit ??
          fetch(request).then((response) => {
            if (response.ok) {
              const copy = response.clone();
              caches.open(SHELL).then((cache) => cache.put(request, copy));
            }
            return response;
          }),
      ),
    );
    return;
  }

  if (request.mode === "navigate") {
    // Network first, and the offline page only when the network is genuinely
    // gone. A page served from cache would be a portal with no data in it,
    // which reads as the account being empty rather than as being offline.
    event.respondWith(
      fetch(request).catch(() =>
        caches.match(OFFLINE_URL).then((hit) => hit ?? Response.error()),
      ),
    );
  }
});
