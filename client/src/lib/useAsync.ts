"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { ApiError } from "@/lib/api";

/**
 * How often a page re-asks the server on its own.
 *
 * These exist so the cadence is one decision rather than a number pasted into
 * every page. A queue is work waiting for a person, and the person is looking at
 * it *because* they are waiting for the next item, so it moves faster. A list
 * somebody is reading moves slower — nothing is gained by refetching a
 * consultation history four times a minute.
 */
export const QUEUE_REFRESH_MS = 30_000;
export const PAGE_REFRESH_MS = 90_000;

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
 * Pass `refreshMs` and the page keeps itself current, which is why no screen
 * carries a Refresh button. A background refresh is deliberately *quiet*: it
 * never raises the loading flag, so the page does not blink back to a skeleton
 * every half minute while somebody is reading it, and it never replaces good
 * data with an error, because one poll failing on a train is not a reason to
 * throw away the answer already on screen. It also stops while the tab is
 * hidden and asks once on the way back, so returning to a queue shows what is
 * there now rather than what was there when you left.
 */
export function useAsync<T>(
  fetcher: () => Promise<T>,
  deps: unknown[] = [],
  options: { refreshMs?: number } = {},
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

  // The interval must call whatever the newest render would have called, and
  // the fetcher is a fresh closure every render. Writing the ref in an effect
  // rather than during render keeps the render itself pure.
  const latest = useRef(fetcher);
  useEffect(() => {
    latest.current = fetcher;
  });

  const { refreshMs } = options;
  useEffect(() => {
    if (!refreshMs) return;
    let cancelled = false;

    const ask = async () => {
      if (document.hidden) return;
      try {
        const result = await latest.current();
        if (!cancelled) setState({ data: result, error: null, loading: false });
      } catch {
        // Deliberately silent — see the note above.
      }
    };

    const timer = window.setInterval(() => void ask(), refreshMs);
    const onVisibilityChange = () => {
      if (!document.hidden) void ask();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshMs, ...deps]);

  return { ...state, reload };
}
