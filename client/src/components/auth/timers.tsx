"use client";

/**
 * The two clocks an emailed code needs: how long it is still good for, and how
 * long before another one may be asked for.
 *
 * Both are driven from a *deadline* rather than a decrementing counter. A tab
 * that is backgrounded stops receiving timer callbacks at anything like one a
 * second, so a counter that subtracts one per tick drifts — and a code that
 * claims four minutes of life when it has none is worse than no clock at all.
 *
 * The remaining seconds are seeded from the argument rather than the wall
 * clock, so the server's first render and the browser's hydration agree on the
 * same string before a single tick has happened.
 */

import { useCallback, useEffect, useState } from "react";

import { Icon } from "@/components/Icon";
import { cx } from "@/components/ui";

export interface Countdown {
  /** Whole seconds left, never below zero. */
  remaining: number;
  /** Starts again from `next` seconds — after a resend, or a new code. */
  restart: (next: number) => void;
}

export function useCountdown(from: number): Countdown {
  const [deadline, setDeadline] = useState(() => Date.now() + from * 1000);
  const [remaining, setRemaining] = useState(from);

  useEffect(() => {
    // Twice a second: fast enough that the displayed value is never a second
    // stale, cheap enough to be invisible. The interval stops itself at zero
    // rather than depending on `remaining`, which would tear it down and
    // rebuild it on every tick.
    const id = window.setInterval(() => {
      const left = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      setRemaining(left);
      if (left <= 0) window.clearInterval(id);
    }, 500);
    return () => window.clearInterval(id);
  }, [deadline]);

  const restart = useCallback((next: number) => {
    setDeadline(Date.now() + next * 1000);
    setRemaining(Math.max(0, Math.round(next)));
  }, []);

  return { remaining, restart };
}

/** `mm:ss`, zero-padded, the way a code's expiry is read aloud. */
export function formatClock(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(safe / 60);
  return `${String(minutes).padStart(2, "0")}:${String(safe % 60).padStart(2, "0")}`;
}

const RADIUS = 7;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/** A small ring that empties as the wait runs down. */
export function CountdownRing({ remaining, total }: { remaining: number; total: number }) {
  const left = total > 0 ? Math.min(1, Math.max(0, remaining / total)) : 0;
  return (
    <svg aria-hidden viewBox="0 0 18 18" className="h-4 w-4 shrink-0 -rotate-90">
      <circle cx="9" cy="9" r={RADIUS} fill="none" strokeWidth="2" className="stroke-line" />
      <circle
        cx="9"
        cy="9"
        r={RADIUS}
        fill="none"
        strokeWidth="2"
        strokeLinecap="round"
        className="stroke-primary transition-[stroke-dashoffset] duration-500 ease-linear"
        strokeDasharray={CIRCUMFERENCE}
        strokeDashoffset={CIRCUMFERENCE * (1 - left)}
      />
    </svg>
  );
}

/**
 * "Send it again" — a link while it is allowed, a ring and a number while it
 * is not. Disabled rather than hidden, so the wait is visible and nobody hunts
 * for a control that went away.
 */
export function ResendControl({
  remaining,
  total,
  busy = false,
  label,
  waitingLabel,
  onResend,
}: {
  remaining: number;
  total: number;
  busy?: boolean;
  label: string;
  /** Shown while the wait runs; receives the seconds left. */
  waitingLabel: (seconds: number) => string;
  onResend: () => void;
}) {
  const waiting = remaining > 0;
  return (
    // Deliberately not a live region: the label changes once a second, and a
    // screen reader reading "59… 58… 57…" over the top of the page is worse
    // than silence. The button announces itself when it is reached.
    <button
      type="button"
      onClick={onResend}
      disabled={waiting || busy}
      className={cx(
        "inline-flex items-center gap-2 rounded-lg px-1 py-1 text-sm font-semibold transition-colors",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary",
        waiting || busy
          ? "cursor-not-allowed text-faint"
          : "text-primary underline underline-offset-2 hover:text-primary-hover",
      )}
    >
      {waiting ? (
        <CountdownRing remaining={remaining} total={total} />
      ) : (
        <Icon name="refresh" className="text-[18px]" />
      )}
      {waiting ? waitingLabel(remaining) : label}
    </button>
  );
}
