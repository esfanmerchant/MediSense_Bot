/**
 * Pages that keep themselves current.
 *
 * This behaviour is on by default for every screen in the application, which
 * makes its failure modes broad and quiet: a refresh that raises the loading
 * flag blinks every list back to a skeleton under whoever is reading it, and a
 * refresh that surfaces a transient error throws away a good answer because one
 * request failed. Neither shows up as an exception — the page simply becomes
 * unpleasant — so both are pinned here.
 *
 * Real timers are not used. `vi.useFakeTimers` lets a minute pass in a
 * millisecond, and a test that actually waited sixty seconds would be a test
 * nobody runs.
 */

import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setLiveUpdates } from "@/components/settings/preferences";
import { ApiError } from "@/lib/api";
import { LIVE_REFRESH_MS, useAsync } from "@/lib/useAsync";

function Probe({
  fetcher,
  options,
}: {
  fetcher: () => Promise<string>;
  options?: Parameters<typeof useAsync>[2];
}) {
  const { data, error, loading } = useAsync(fetcher, [], options);
  return (
    <div>
      <span data-testid="data">{data ?? "—"}</span>
      <span data-testid="error">{error?.message ?? "—"}</span>
      <span data-testid="loading">{loading ? "yes" : "no"}</span>
    </div>
  );
}

/** Lets the interval fire and the promise it started settle. */
async function advance(ms: number) {
  await act(async () => {
    vi.advanceTimersByTime(ms);
    // The fetch resolves in a microtask after the timer callback runs. Without
    // draining it inside `act`, the state update lands outside and React warns
    // — and a suite that warns on every passing test is a suite whose output
    // nobody reads.
    await Promise.resolve();
  });
}

/** Somebody switching back to this window, and the refresh it triggers. */
async function comeBack(events: readonly ["focus" | "visibilitychange", ...string[]] | string[]) {
  await act(async () => {
    for (const name of events) {
      if (name === "visibilitychange") document.dispatchEvent(new Event(name));
      else window.dispatchEvent(new Event(name));
    }
    await Promise.resolve();
  });
}

beforeEach(() => {
  // `shouldAdvanceTime` keeps the clock moving in real time as well as on
  // demand. Testing Library's `waitFor` polls on a timer of its own, and under
  // a frozen clock it waits forever for something that already happened.
  vi.useFakeTimers({ shouldAdvanceTime: true });
  setLiveUpdates(true);
});

afterEach(() => {
  vi.useRealTimers();
});

// The preference is reset in `beforeEach` above rather than here on purpose:
// this file's afterEach runs before the shared `cleanup()`, so writing to the
// store at this point re-renders a component that is still mounted and React
// says so. localStorage is never cleared either — under this Node/jsdom
// combination the global is Node's experimental shim whose methods are not
// callable (see vitest.setup.ts), and the store keeps the value in module state
// regardless, treating storage as best-effort.

describe("refreshing on its own", () => {
  it("re-asks the server without being told to", async () => {
    let answer = "first";
    const fetcher = vi.fn(() => Promise.resolve(answer));
    render(<Probe fetcher={fetcher} />);

    await waitFor(() => expect(screen.getByTestId("data")).toHaveTextContent("first"));

    answer = "second";
    await advance(LIVE_REFRESH_MS);

    expect(screen.getByTestId("data")).toHaveTextContent("second");
  });

  it("never blinks back to loading while somebody is reading", async () => {
    // The whole reason the refresh is quiet. A page that drops to a skeleton
    // every minute is worse than one that is a minute stale.
    const fetcher = vi.fn(() => Promise.resolve("rows"));
    render(<Probe fetcher={fetcher} />);
    await waitFor(() => expect(screen.getByTestId("loading")).toHaveTextContent("no"));

    await advance(LIVE_REFRESH_MS);

    expect(screen.getByTestId("loading")).toHaveTextContent("no");
  });

  it("keeps the last good answer when a refresh fails", async () => {
    // One request failing on a train is not a reason to replace a working
    // screen with an error.
    let fail = false;
    const fetcher = vi.fn(() =>
      fail
        ? Promise.reject(new ApiError("INTERNAL_ERROR", "Network is down.", 500))
        : Promise.resolve("rows"),
    );
    render(<Probe fetcher={fetcher} />);
    await waitFor(() => expect(screen.getByTestId("data")).toHaveTextContent("rows"));

    fail = true;
    await advance(LIVE_REFRESH_MS);

    expect(screen.getByTestId("data")).toHaveTextContent("rows");
    expect(screen.getByTestId("error")).toHaveTextContent("—");
  });

  it("stops asking while the tab is hidden", async () => {
    // Nobody is looking, and a phone in a pocket should not be talking to the
    // server every minute.
    const fetcher = vi.fn(() => Promise.resolve("rows"));
    render(<Probe fetcher={fetcher} />);
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));

    vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    await advance(LIVE_REFRESH_MS * 3);

    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("catches up when the reader comes back to the window", async () => {
    const fetcher = vi.fn(() => Promise.resolve("rows"));
    render(<Probe fetcher={fetcher} />);
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));

    // Past the throttle, so this counts as a return rather than a duplicate of
    // the event that fired a moment ago.
    await advance(20_000);
    const before = fetcher.mock.calls.length;

    await comeBack(["focus"]);

    expect(fetcher.mock.calls.length).toBeGreaterThan(before);
  });

  it("does not fire twice for one glance at the screen", async () => {
    // Switching windows raises both visibilitychange and focus. Without a floor
    // between them, one look costs two identical requests.
    const fetcher = vi.fn(() => Promise.resolve("rows"));
    render(<Probe fetcher={fetcher} />);
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    await advance(20_000);

    await comeBack(["focus", "visibilitychange"]);

    // The interval has not run in this window, so every call beyond the first
    // came from those two events.
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});

describe("reads that are not free", () => {
  it('"on-return" never runs on a timer', async () => {
    // Opening a chart is written to the audit trail. A timer would record
    // accesses no person made, which is a record that says something untrue.
    const fetcher = vi.fn(() => Promise.resolve("chart"));
    render(<Probe fetcher={fetcher} options={{ live: "on-return" }} />);
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));

    await advance(LIVE_REFRESH_MS * 5);

    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('"on-return" still catches up when somebody looks again', async () => {
    // Coming back to the window is a person really looking, so the audit entry
    // it produces is true.
    const fetcher = vi.fn(() => Promise.resolve("chart"));
    render(<Probe fetcher={fetcher} options={{ live: "on-return" }} />);
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    await advance(20_000);

    await comeBack(["focus"]);

    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("false does neither", async () => {
    const fetcher = vi.fn(() => Promise.resolve("once"));
    render(<Probe fetcher={fetcher} options={{ live: false }} />);
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));

    await advance(LIVE_REFRESH_MS * 3);
    await comeBack(["focus"]);

    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe("the reader's preference", () => {
  it("turning it off stops the timer", async () => {
    const fetcher = vi.fn(() => Promise.resolve("rows"));
    render(<Probe fetcher={fetcher} />);
    // Waiting on the rendered value rather than the call count: the count
    // reaches one the moment the request is made, which is before the state it
    // produces has landed.
    await waitFor(() => expect(screen.getByTestId("data")).toHaveTextContent("rows"));

    await act(async () => {
      setLiveUpdates(false);
    });
    await advance(LIVE_REFRESH_MS * 3);

    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("turning it off also stops the refresh on return", async () => {
    // Off means off. Somebody who turned this off to compare two figures does
    // not want the numbers moving when they click back into the window.
    const fetcher = vi.fn(() => Promise.resolve("rows"));
    render(<Probe fetcher={fetcher} />);
    await waitFor(() => expect(screen.getByTestId("data")).toHaveTextContent("rows"));

    await act(async () => {
      setLiveUpdates(false);
    });
    await advance(20_000);
    await comeBack(["focus"]);

    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("turning it back on resumes without a remount", async () => {
    // The preference is read through the store, so every mounted page picks up
    // the change — somebody who switches it back on does not have to navigate
    // away and return to get their screens moving again.
    const fetcher = vi.fn(() => Promise.resolve("rows"));
    render(<Probe fetcher={fetcher} />);
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));

    await act(async () => {
      setLiveUpdates(false);
    });
    await advance(LIVE_REFRESH_MS * 2);
    expect(fetcher).toHaveBeenCalledTimes(1);

    await act(async () => {
      setLiveUpdates(true);
    });
    await advance(LIVE_REFRESH_MS);

    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
