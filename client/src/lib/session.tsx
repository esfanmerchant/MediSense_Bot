"use client";

/**
 * Session context and the client half of the inactivity rule.
 *
 * The server is what actually ends an expired session (R8) — this timer exists
 * so the user gets a warning and a clean redirect instead of a surprise 401
 * mid-form. If this code were removed entirely, security would be unchanged.
 */

import { useRouter } from "next/navigation";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";

import {
  ApiError,
  SESSION_ENDED_EVENT,
  auth,
  type AuthUser,
  type DeviceClass,
  type SessionInfo,
} from "@/lib/api";

/** Seconds of remaining idle time at which the warning appears. */
const WARNING_AT_SECONDS = 30;

/** Events that count as activity, matching what the server counts. */
const ACTIVITY_EVENTS = ["mousemove", "keydown", "click", "touchstart", "scroll"] as const;

const DEVICE_CLASS_KEY = "medisense.deviceClass";

interface SessionState {
  user: AuthUser | null;
  session: SessionInfo | null;
  loading: boolean;
  /** Seconds until automatic sign-out, or null when the tier is exempt. */
  secondsRemaining: number | null;
  showWarning: boolean;
  signIn: (email: string, password: string, deviceClass: DeviceClass) => Promise<AuthUser>;
  signOut: (reason?: string) => Promise<void>;
  stayAlive: () => void;
  refreshUser: () => Promise<void>;
}

const SessionContext = createContext<SessionState | null>(null);

export function homePathFor(role: AuthUser["role"]): string {
  switch (role) {
    case "ADMIN":
      return "/admin";
    case "DOCTOR":
      return "/doctor";
    case "PATIENT":
      return "/patient";
    default:
      // NURSE has no dashboard yet — emergency access only.
      return "/no-dashboard";
  }
}

/**
 * Reads the remembered device class without an effect.
 *
 * ``useSyncExternalStore`` is the right tool for a value that lives outside
 * React: it returns the server snapshot during prerender, so there is no
 * hydration mismatch and no setState-in-effect to trigger a second render.
 */
const noopSubscribe = () => () => {};

export function useStoredDeviceClass(): DeviceClass {
  return useSyncExternalStore(
    noopSubscribe,
    readStoredDeviceClass,
    () => "PERSONAL" as DeviceClass,
  );
}

export function readStoredDeviceClass(): DeviceClass {
  if (typeof window === "undefined") return "PERSONAL";
  try {
    const stored = window.localStorage.getItem(DEVICE_CLASS_KEY);
    if (stored === "SHARED_TERMINAL" || stored === "PERSONAL" || stored === "MONITOR") {
      return stored;
    }
  } catch {
    // Private browsing can throw on access; the default is the safe answer.
  }
  return "PERSONAL";
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [user, setUser] = useState<AuthUser | null>(null);
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [secondsRemaining, setSecondsRemaining] = useState<number | null>(null);

  // Seeded on mount rather than at render: reading the clock during render is
  // impure and makes the component non-deterministic.
  const lastActivity = useRef<number>(0);
  const idleLimit = session?.idleTimeoutSeconds ?? null;

  const signOut = useCallback(
    async (reason?: string) => {
      try {
        await auth.logout();
      } catch {
        // Logging out is best-effort: the cookies are cleared either way.
      }
      setUser(null);
      setSession(null);
      setSecondsRemaining(null);
      router.replace(reason ? `/login?reason=${reason}` : "/login");
    },
    [router],
  );

  const refreshUser = useCallback(async () => {
    try {
      const { user: current } = await auth.me();
      setUser(current);
    } catch (error) {
      if (error instanceof ApiError && error.isAuthFailure) setUser(null);
    }
  }, []);

  // Restore an existing session on first load, so a refresh does not sign out.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { user: current } = await auth.me();
        if (cancelled) return;
        setUser(current);
        setSession({
          sessionId: "restored",
          idleTimeoutSeconds:
            readStoredDeviceClass() === "SHARED_TERMINAL"
              ? 120
              : readStoredDeviceClass() === "MONITOR"
                ? null
                : 900,
          accessTokenExpiresInSeconds: 120,
        });
      } catch {
        if (!cancelled) setUser(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // A 401 from anywhere in the app ends the session exactly once.
  useEffect(() => {
    const handler = (event: Event) => {
      const code = (event as CustomEvent<{ code: string }>).detail?.code;
      if (!user) return;
      void signOut(code === "SESSION_EXPIRED" ? "expired" : "signed-out");
    };
    window.addEventListener(SESSION_ENDED_EVENT, handler);
    return () => window.removeEventListener(SESSION_ENDED_EVENT, handler);
  }, [signOut, user]);

  const stayAlive = useCallback(() => {
    lastActivity.current = Date.now();
    if (idleLimit !== null) setSecondsRemaining(idleLimit);
  }, [idleLimit]);

  // Track activity.
  useEffect(() => {
    if (!user || idleLimit === null) return;

    const onActivity = () => {
      lastActivity.current = Date.now();
    };
    for (const event of ACTIVITY_EVENTS) {
      window.addEventListener(event, onActivity, { passive: true });
    }
    return () => {
      for (const event of ACTIVITY_EVENTS) window.removeEventListener(event, onActivity);
    };
  }, [user, idleLimit]);

  // Count down, and sign out when the window closes.
  useEffect(() => {
    // No timer for a signed-out user or an exempt tier. The value exposed to
    // consumers is derived below rather than written here, so this effect never
    // calls setState synchronously.
    if (!user || idleLimit === null) return;

    lastActivity.current = Date.now();

    // The countdown is seeded by the first tick rather than synchronously here:
    // a setState in the effect body would re-render immediately on every mount.
    const interval = window.setInterval(() => {
      const elapsed = (Date.now() - lastActivity.current) / 1000;
      const remaining = Math.max(0, Math.ceil(idleLimit - elapsed));
      setSecondsRemaining(remaining);
      if (remaining <= 0) {
        window.clearInterval(interval);
        void signOut("expired");
      }
    }, 1000);

    return () => window.clearInterval(interval);
  }, [user, idleLimit, signOut]);

  const signIn = useCallback(
    async (email: string, password: string, deviceClass: DeviceClass) => {
      const result = await auth.login(email, password, deviceClass);
      try {
        window.localStorage.setItem(DEVICE_CLASS_KEY, deviceClass);
      } catch {
        // Not being able to remember the choice is harmless.
      }
      setUser(result.user);
      setSession(result.session);
      lastActivity.current = Date.now();
      return result.user;
    },
    [],
  );

  // Derived, not stored: a signed-out user or an exempt device class has no
  // countdown regardless of what the last tick happened to leave behind.
  const effectiveRemaining = user && idleLimit !== null ? secondsRemaining : null;

  const value = useMemo<SessionState>(
    () => ({
      user,
      session,
      loading,
      secondsRemaining: effectiveRemaining,
      showWarning:
        effectiveRemaining !== null &&
        effectiveRemaining <= WARNING_AT_SECONDS &&
        effectiveRemaining > 0,
      signIn,
      signOut,
      stayAlive,
      refreshUser,
    }),
    [user, session, loading, secondsRemaining, signIn, signOut, stayAlive, refreshUser],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionState {
  const context = useContext(SessionContext);
  if (!context) throw new Error("useSession must be used inside a SessionProvider");
  return context;
}
