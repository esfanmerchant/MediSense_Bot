/**
 * Enrolling this browser for push notifications.
 *
 * Three rules shape everything here.
 *
 * **Never prompt on load.** A permission dialog nobody asked for is denied,
 * and a denial is close to permanent — the browser stops asking, and the only
 * way back is through settings most people never open. So `enable()` is only
 * ever called from a button somebody pressed.
 *
 * **Re-post silently on every load.** A push service may rotate an endpoint
 * underneath the page, and a subscription the server has forgotten is a
 * reminder that never arrives. `sync()` re-sends what the browser already has,
 * without prompting, whenever permission is already granted.
 *
 * **Failure is quiet.** Every path here degrades to "no push", because the
 * portal has to work in a browser that has never supported any of it.
 */

import { notifications } from "@/lib/api";

/**
 * The VAPID key travels as base64url; `subscribe` wants raw bytes.
 *
 * Backed by an explicit `ArrayBuffer` rather than the plain constructor: a
 * `Uint8Array` may sit on a `SharedArrayBuffer`, which `BufferSource` does not
 * accept, and the two are only distinguishable at the type level.
 */
function applicationServerKey(base64: string): Uint8Array<ArrayBuffer> {
  const padded = (base64 + "=".repeat((4 - (base64.length % 4)) % 4))
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  const raw = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

export type PushState =
  /** This browser cannot do push at all, or the server has no keys. */
  | "unsupported"
  /** Available, not yet asked for. */
  | "prompt"
  | "granted"
  /** Refused. Nothing in the page can undo this; only browser settings can. */
  | "denied";

export function isSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

/** The registration, once it is actually controlling the page. */
async function worker(): Promise<ServiceWorkerRegistration | null> {
  if (!isSupported()) return null;
  try {
    return await navigator.serviceWorker.ready;
  } catch {
    return null;
  }
}

function toPayload(subscription: PushSubscription) {
  // `toJSON` is what carries the keys; the object itself does not expose them.
  const json = subscription.toJSON() as {
    endpoint?: string;
    keys?: { p256dh?: string; auth?: string };
  };
  if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) return null;
  return {
    endpoint: json.endpoint,
    keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
  };
}

/**
 * Where this browser stands, without asking it for anything.
 *
 * Checks the server too: a deployment with no VAPID keys should show nothing
 * about notifications rather than a switch that silently does nothing.
 */
export async function status(): Promise<{ state: PushState; devices: number }> {
  if (!isSupported()) return { state: "unsupported", devices: 0 };

  try {
    const server = await notifications.pushStatus();
    if (!server.enabled || !server.publicKey) return { state: "unsupported", devices: 0 };
    return { state: Notification.permission as PushState, devices: server.devices };
  } catch {
    return { state: "unsupported", devices: 0 };
  }
}

/**
 * Re-register what the browser already holds. Never prompts.
 *
 * Safe to call on every page load: with permission granted it is one cheap
 * POST that keeps the endpoint fresh, and with anything else it does nothing.
 */
export async function sync(): Promise<void> {
  if (!isSupported() || Notification.permission !== "granted") return;

  const registration = await worker();
  if (!registration) return;

  try {
    const existing = await registration.pushManager.getSubscription();
    if (!existing) {
      // Permission is granted but the subscription is gone — a cleared site,
      // or a rotated endpoint. Re-subscribing needs no prompt at this point.
      await enable();
      return;
    }
    const payload = toPayload(existing);
    if (payload) await notifications.subscribePush(payload);
  } catch {
    // Offline, or the push service is unreachable. The next load tries again.
  }
}

/**
 * Ask for permission and enrol. Call only from a click.
 *
 * Returns the state it ended in, so the caller can say something true — a
 * "denied" needs different words from a network failure.
 */
export async function enable(): Promise<PushState> {
  if (!isSupported()) return "unsupported";

  const server = await notifications.pushStatus().catch(() => null);
  if (!server?.enabled || !server.publicKey) return "unsupported";

  const permission =
    Notification.permission === "default"
      ? await Notification.requestPermission()
      : Notification.permission;
  if (permission !== "granted") return permission as PushState;

  const registration = await worker();
  if (!registration) return "unsupported";

  try {
    const subscription =
      (await registration.pushManager.getSubscription()) ??
      (await registration.pushManager.subscribe({
        // Required by every browser that implements this: a push must be
        // shown, not used to run code quietly in the background.
        userVisibleOnly: true,
        applicationServerKey: applicationServerKey(server.publicKey),
      }));

    const payload = toPayload(subscription);
    if (!payload) return "unsupported";
    await notifications.subscribePush(payload);
    return "granted";
  } catch {
    return "unsupported";
  }
}

/**
 * Stop notifications on this device.
 *
 * Both halves, in this order: the browser drops the subscription and the
 * server forgets the address. Doing only the first would leave the server
 * pushing into a void until the push service reported it gone.
 */
export async function disable(): Promise<void> {
  const registration = await worker();
  if (!registration) return;

  try {
    const subscription = await registration.pushManager.getSubscription();
    if (!subscription) return;
    const endpoint = subscription.endpoint;
    await subscription.unsubscribe();
    await notifications.unsubscribePush(endpoint);
  } catch {
    // Nothing useful to say. The switch will read its real state on next load.
  }
}
