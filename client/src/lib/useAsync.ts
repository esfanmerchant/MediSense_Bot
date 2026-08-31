"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { useLiveUpdates } from "@/components/settings/preferences";
import { ApiError } from "@/lib/api";

/**
 * How often a page re-asks the server on its own.
 *
 * These exist so the cadence is one decision rather than a number pasted into
 * every page. A queue is work waiting for a person, and the person is looking at
 * it *because* they are waiting for the next item, so it moves faster. A list
 * somebody is reading moves slower — nothing is gained by refetching a
 * consultation history four times a minute. Everything else takes the middle
 * value without having to think about it.
 */
export const QUEUE_REFRESH_MS = 30_000;
export const LIVE_REFRESH_MS = 60_000;
export const PAGE_REFRESH_MS = 90_000;

/**
 * The shortest gap between two refreshes triggered by coming back to the page.
 *
 * Switching windows fires both `visibilitychange` and `focus`, and somebody
 * alt-tabbing between a banking app and this one does it repeatedly. Without a
 * floor, that is a burst of identical requests for one glance at the screen.
 */
const RETURN_THROTTLE_MS = 10_000;

interface AsyncState<T> {
  data: T | null;
  error: ApiError | null;
  loading: boolean;
  reload: () => void;
}

interface InternalState<T> {
  data: T | null;
  error: ApiError | null;
  loading: boolean;
}

interface Options {
  /** How often to re-ask, in milliseconds. Defaults to `LIVE_REFRESH_MS`. */
  refreshMs?: number;
  /**
   * When this may refresh itself.
   *
   * `true` (the default) is a timer plus a refresh whenever the reader comes
   * back to the window. `false` is neither.
   *
   * `"on-return"` is for reads that are not free. Several `GET`s in this API
   * write to the audit trail — opening a patient's chart, their vitals, the
   * security summary on the administrator's dashboard — because looking at
   * those things is itself an event somebody may later have to account for. A
   * timer would fill that trail with accesses no person made, which is worse
   * than a stale screen: it is a record that says something untrue. Coming back
   * to the window is different in exactly the way that matters — a person
   * really did just look at it again — so those screens still catch up when
   * somebody returns to them, and never while nobody is there.
   */
  live?: boolean | "on-return";
}

/**
 * Runs a request on mount and exposes the states every panel must handle:
 * loading, success, empty (the caller checks the data) and error (spec §38).
 *
 * State is held as one object and only written from the async continuation, so
 * nothing calls setState synchronously inside the effect body — that pattern
 * triggers a cascading re-render on every mount.
 *
 * A 401 is deliberately not surfaced as an error: the API client raises a
 * session-ended event and SessionProvider redirects, so pages do not each need
 * to reason about expiry.
 *
 * **Pages keep themselves current by default**, which is why no screen carries a
 * Refresh button. That default is the point: making it opt-in meant most screens
 * never opted in, and people went back to pressing refresh — losing their place,
 * and reading screens they had no way to tell were stale.
 *
 * A background refresh is deliberately *quiet*. It never raises the loading
 * flag, so the page does not blink back to a skeleton under somebody mid-row.
 * It never replaces good data with an error, because one request failing on a
 * train is not a reason to throw away the answer already on screen. It stops
 * while the tab is hidden and asks once on the way back, so returning to a
 * screen shows what is there now rather than what was there when you left. And
 * it stops entirely when the reader has turned live updates off.
 */
export function useAsync<T>(
  fetcher: () => Promise<T>,
  deps: unknown[] = [],
  options: Options = {},
): AsyncState<T> {
  const [state, setState] = useState<InternalState<T>>({
    data: null,
    error: null,
    loading: true,
  });
  const [nonce, setNonce] = useState(0);

  // Called from an event handler, where setState is the right thing to do.
  const reload = useCallback(() => {
    setState((previous) => ({ ...previous, loading: true, error: null }));
    setNonce((value) => value + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;

    const run = async () => {
      try {
        const result = await fetcher();
        if (!cancelled) setState({ data: result, error: null, loading: false });
      } catch (caught: unknown) {
        if (cancelled) return;
        if (caught instanceof ApiError && caught.isAuthFailure) {
          // Handled globally by SessionProvider; stop the spinner and let the
          // redirect happen.
          setState((previous) => ({ ...previous, loading: false }));
          return;
        }
        setState({
          data: null,
          error:
            caught instanceof ApiError
              ? caught
              : new ApiError("INTERNAL_ERROR", "Something went wrong.", 500),
          loading: false,
        });
      }
    };

    void run();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  // The timer must call whatever the newest render would have called, and the
  // fetcher is a fresh closure every render. Writing the ref in an effect rather
  // than during render keeps the render itself pure.
  const latest = useRef(fetcher);
  useEffect(() => {
    latest.current = fetcher;
  });

  const enabled = useLiveUpdates();
  const { refreshMs = LIVE_REFRESH_MS, live: mode = true } = options;
  const on = enabled && mode !== false && refreshMs > 0;
  const onTimer = on && mode !== "on-return";

  useEffect(() => {
    if (!on) return;
    let cancelled = false;
    let lastAsked = Date.now();

    const ask = async () => {
      if (document.hidden) return;
      lastAsked = Date.now();
      try {
        const result = await latest.current();
        if (!cancelled) setState({ data: result, error: null, loading: false });
      } catch {
        // Deliberately silent — see the note above.
      }
    };

    const askOnReturn = () => {
      if (document.hidden) return;
      if (Date.now() - lastAsked < RETURN_THROTTLE_MS) return;
      void ask();
    };

    const timer = onTimer ? window.setInterval(() => void ask(), refreshMs) : undefined;
    // Both events, because they answer different questions. `visibilitychange`
    // fires when the tab is switched away from; `focus` fires when the whole
    // window is, which is the case somebody transferring money in their banking
    // app and coming back is actually in.
    document.addEventListener("visibilitychange", askOnReturn);
    window.addEventListener("focus", askOnReturn);

    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearInterval(timer);
      document.removeEventListener("visibilitychange", askOnReturn);
      window.removeEventListener("focus", askOnReturn);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [on, onTimer, refreshMs, ...deps]);

  return { ...state, reload };
}
