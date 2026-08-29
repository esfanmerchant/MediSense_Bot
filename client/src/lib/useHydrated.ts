"use client";

import { useSyncExternalStore } from "react";

/**
 * False while rendering on the server and during hydration, true afterwards.
 *
 * The obvious version of this is `useState(false)` plus an effect that sets it
 * true — which React 19 rightly flags, because a synchronous setState in an
 * effect is a second render for something that was never really state.
 * `useSyncExternalStore` answers the same question honestly: the server
 * snapshot is `false`, the client snapshot is `true`, and nothing subscribes
 * because the value never changes again.
 *
 * Use it for anything that cannot exist until the document does — a portal, a
 * stored theme, a value read from `window`.
 */
const neverChanges = () => () => {};

export function useHydrated(): boolean {
  return useSyncExternalStore(
    neverChanges,
    () => true,
    () => false,
  );
}
