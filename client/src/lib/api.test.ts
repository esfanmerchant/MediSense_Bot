/**
 * The access token renews itself, and does it exactly once.
 *
 * These cover the bug where an actively used session died on a wall clock: the
 * token's life is `min(idle window, 15 minutes)`, nothing renewed it, and the
 * first request made after it lapsed threw the person back to the landing page
 * mid-task. The retry is easy to get subtly wrong in three ways — a stampede
 * when a dashboard fires several requests at once, an endless loop when the
 * session really is gone, and a refresh attempted behind a rejected sign-in —
 * so each is pinned here rather than left to inspection.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError, SESSION_ENDED_EVENT, apiList, apiRequest } from "@/lib/api";

const API = "http://localhost:4000/api";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const expired = () =>
  jsonResponse(
    { success: false, error: { code: "SESSION_EXPIRED", message: "Your session has ended." } },
    401,
  );

const payload = (data: unknown) => jsonResponse({ success: true, data });

/** Every URL the mocked fetch was called with, in order. */
function calls(mock: ReturnType<typeof vi.fn>): string[] {
  return mock.mock.calls.map(([url]) => String(url));
}

describe("renewing an expired access token", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let sessionEnded: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    sessionEnded = vi.fn();
    window.addEventListener(SESSION_ENDED_EVENT, sessionEnded);
  });

  afterEach(() => {
    window.removeEventListener(SESSION_ENDED_EVENT, sessionEnded);
    vi.unstubAllGlobals();
  });

  it("renews and repeats the request, and the caller never learns it happened", async () => {
    fetchMock
      .mockResolvedValueOnce(expired())
      .mockResolvedValueOnce(payload({ session: { expiresIn: 900 } }))
      .mockResolvedValueOnce(payload({ id: "p1", name: "Ali" }));

    await expect(apiRequest("/patients/me")).resolves.toEqual({ id: "p1", name: "Ali" });

    expect(calls(fetchMock)).toEqual([
      `${API}/patients/me`,
      `${API}/auth/refresh`,
      `${API}/patients/me`,
    ]);
    // The whole point: a renewed session must not look like an ended one.
    expect(sessionEnded).not.toHaveBeenCalled();
  });

  it("gives up after one retry when the session is genuinely gone", async () => {
    fetchMock
      .mockResolvedValueOnce(expired())
      .mockResolvedValueOnce(payload({ session: {} }))
      .mockResolvedValueOnce(expired());

    await expect(apiRequest("/patients/me")).rejects.toBeInstanceOf(ApiError);

    // Three calls, not a loop: request, refresh, request. The second failure is
    // reported rather than refreshed again.
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(sessionEnded).toHaveBeenCalledTimes(1);
  });

  it("reports the failure when the refresh itself is refused", async () => {
    fetchMock.mockResolvedValueOnce(expired()).mockResolvedValueOnce(expired());

    await expect(apiRequest("/patients/me")).rejects.toMatchObject({
      code: "SESSION_EXPIRED",
    });

    // No replay: the refresh was refused, so there is nothing to replay with.
    expect(calls(fetchMock)).toEqual([`${API}/patients/me`, `${API}/auth/refresh`]);
    expect(sessionEnded).toHaveBeenCalledTimes(1);
  });

  it("refreshes once for a whole dashboard's worth of simultaneous 401s", async () => {
    // A page opening fires several requests together. Each would start its own
    // refresh, and because refreshing rotates the refresh token, the first to
    // land would invalidate the token the others were still holding — the
    // session dying from the mechanism meant to save it.
    fetchMock.mockImplementation((url: string) => {
      if (String(url).endsWith("/auth/refresh")) return Promise.resolve(payload({ session: {} }));
      return Promise.resolve(
        fetchMock.mock.calls.filter(([u]) => u === url).length > 1
          ? payload({ ok: true })
          : expired(),
      );
    });

    await Promise.all([
      apiRequest("/dashboard/patient"),
      apiRequest("/appointments"),
      apiRequest("/vitals"),
    ]);

    const refreshes = calls(fetchMock).filter((url) => url.endsWith("/auth/refresh"));
    expect(refreshes).toHaveLength(1);
    expect(sessionEnded).not.toHaveBeenCalled();
  });

  it("never refreshes behind a rejected sign-in", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        { success: false, error: { code: "UNAUTHENTICATED", message: "Wrong password." } },
        401,
      ),
    );

    await expect(
      apiRequest("/auth/login", { method: "POST", body: { email: "a@b.c", password: "no" } }),
    ).rejects.toMatchObject({ code: "UNAUTHENTICATED" });

    // Minting a token behind a refused sign-in would replay the attempt against
    // a session the person was just told they do not have.
    expect(calls(fetchMock)).toEqual([`${API}/auth/login`]);
  });

  it("renews for a paginated list too, not only plain requests", async () => {
    fetchMock
      .mockResolvedValueOnce(expired())
      .mockResolvedValueOnce(payload({ session: {} }))
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          data: [{ id: "d1" }],
          meta: { total: 1, limit: 25, offset: 0, hasMore: false },
        }),
      );

    const result = await apiList<{ id: string }>("/doctors");

    expect(result.data).toEqual([{ id: "d1" }]);
    expect(sessionEnded).not.toHaveBeenCalled();
  });
});
