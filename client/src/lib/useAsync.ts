"use client";

import { useCallback, useEffect, useState } from "react";

import { ApiError } from "@/lib/api";

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
 */
export function useAsync<T>(fetcher: () => Promise<T>, deps: unknown[] = []): AsyncState<T> {
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

  return { ...state, reload };
}
