"use client";

/**
 * Picking a time of day, without the browser's own dropdown.
 *
 * `<input type="time">` renders whatever the browser feels like — on Chrome a
 * grey three-column scroll wheel that ignores every token this interface uses
 * and, on a dark page, arrives lit like a torch. It is also the wrong shape for
 * the question: setting a medication reminder is choosing an hour of the day,
 * not typing a timestamp, and a wheel of sixty minutes to find `:00` is work
 * nobody asked for.
 *
 * So this offers the hours as a grid and the minutes as the four a person
 * actually says out loud — o'clock, quarter past, half past, quarter to. Any
 * other minute is still reachable by typing, because "twenty past eight with
 * food" is a real instruction and a picker that cannot express it would send
 * somebody back to the keyboard anyway.
 *
 * **Morning and evening are one press apart.** Twice-daily is the commonest
 * prescription there is, and the second dose is nearly always the first one
 * twelve hours later — so am/pm is a toggle beside the hour, not a third
 * column to scroll.
 *
 * **The panel is rendered into `document.body`.** Absolutely positioned, it
 * was clipped to 66 of its 307 pixels by the `overflow: hidden` on the
 * prescription card it opens inside — and a dropdown that lives inside a card
 * will meet that again wherever it is used next. A portal cannot be clipped by
 * an ancestor that does not contain it, so it is placed from the trigger's
 * measured position instead of inherited from it.
 */

import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { Icon } from "@/components/Icon";
import { cx } from "@/components/ui";
import { useTr } from "@/lib/lang";

/** The minutes people name. Anything else is typed. */
const MINUTES = [0, 15, 30, 45];

function parse(value: string): { hour: number; minute: number } | null {
  const [h, m] = value.split(":").map(Number);
  if (!Number.isInteger(h) || !Number.isInteger(m)) return null;
  if (h < 0 || h > 23 || m < 0 || m > 59) return null;
  return { hour: h, minute: m };
}

const pad = (n: number) => String(n).padStart(2, "0");

/** 13 -> "01 pm", which is how somebody would read it back. */
function human(hour: number, minute: number, tr: (a: string, b: string) => string): string {
  const suffix = hour < 12 ? tr("am", "subah") : tr("pm", "shaam");
  const twelve = hour % 12 === 0 ? 12 : hour % 12;
  return `${pad(twelve)}:${pad(minute)} ${suffix}`;
}

export function TimePicker({
  value,
  onChange,
  onCommit,
  label,
  disabled = false,
}: {
  /** "HH:MM", or "" for nothing chosen yet. */
  value: string;
  onChange: (next: string) => void;
  /** Enter, or a full choice from the grid. Lets the caller add on one press. */
  onCommit?: (next: string) => void;
  label: string;
  disabled?: boolean;
}) {
  const tr = useTr();
  const fieldId = useId();
  const [open, setOpen] = useState(false);
  const shell = useRef<HTMLDivElement | null>(null);
  const panel = useRef<HTMLDivElement | null>(null);

  const trigger = useRef<HTMLButtonElement | null>(null);
  const [at, setAt] = useState<{ top: number; left: number } | null>(null);

  /**
   * Put the panel under the button, flipping above it when there is no room.
   *
   * Measured every time it opens rather than once: the card it sits in is in a
   * scrolling page, and a position captured on mount is wrong by the time
   * anybody presses anything.
   */
  const place = useCallback(() => {
    const box = trigger.current?.getBoundingClientRect();
    if (!box) return;
    const PANEL = 320;
    const below = window.innerHeight - box.bottom;
    setAt({
      top: below < PANEL && box.top > PANEL ? box.top - PANEL - 8 : box.bottom + 8,
      // Kept on screen at either edge — a panel half off the side of a phone
      // is the same bug as one clipped by a card.
      left: Math.max(8, Math.min(box.left, window.innerWidth - 280)),
    });
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    place();
    // A scroll moves the button out from under it, so it follows or closes.
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [open, place]);

  const parsed = useMemo(() => parse(value), [value]);
  const hour = parsed?.hour ?? 8;
  const minute = parsed?.minute ?? 0;
  const isPm = hour >= 12;

  // Close on a click elsewhere or on Escape. A panel that stays open behind the
  // next thing you press is a panel you have to dismiss twice.
  useEffect(() => {
    if (!open) return;
    const away = (event: MouseEvent) => {
      const target = event.target as Node;
      // The panel is no longer inside `shell` — it is in the body — so both
      // have to be asked before this counts as a click elsewhere.
      if (shell.current?.contains(target)) return;
      if (panel.current?.contains(target)) return;
      setOpen(false);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", key);
    };
  }, [open]);

  const set = (h: number, m: number) => onChange(`${pad(h)}:${pad(m)}`);

  /** The twelve on the face, in the half the toggle is on. */
  const hours = Array.from({ length: 12 }, (_, i) => (i === 0 ? 12 : i));

  return (
    <div ref={shell} className="relative">
      <label htmlFor={fieldId} className="block text-xs font-medium text-muted">
        {label}
      </label>

      <button
        id={fieldId}
        ref={trigger}
        type="button"
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={cx(
          "mt-1 inline-flex min-h-11 w-[9.5rem] items-center justify-between gap-2 rounded-xl px-3",
          "border border-line bg-card text-sm font-semibold tabular-nums text-strong",
          "transition-colors hover:border-primary/60 disabled:opacity-60",
          "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary",
          open && "border-primary",
        )}
      >
        <span className={parsed ? undefined : "font-normal text-faint"}>
          {parsed ? human(hour, minute, tr) : tr("Pick a time", "Waqt chunein")}
        </span>
        <Icon name="schedule" className="shrink-0 text-[18px] text-primary" />
      </button>

      {open &&
        at !== null &&
        createPortal(
          <div
            ref={panel}
            role="dialog"
            aria-label={label}
            style={{ top: at.top, left: at.left }}
            className={cx(
              "fixed z-[80] w-[17rem] rounded-2xl border border-line",
              "bg-card p-3 shadow-float",
            )}
          >
          {/* Which half of the day. Twice-daily is the commonest prescription
              there is, and its second dose is the first one twelve hours on. */}
          <div className="flex rounded-xl border border-line bg-sunken p-0.5">
            {([
              [false, tr("Morning", "Subah"), tr("am", "am")],
              [true, tr("Evening", "Shaam"), tr("pm", "pm")],
            ] as const).map(([pm, name, short]) => (
              <button
                key={short}
                type="button"
                aria-pressed={isPm === pm}
                onClick={() => set((hour % 12) + (pm ? 12 : 0), minute)}
                className={cx(
                  "min-h-9 flex-1 rounded-lg text-xs font-bold transition-colors",
                  isPm === pm
                    ? "bg-gradient-brand text-white shadow-sm"
                    : "text-muted hover:text-strong",
                )}
              >
                {name}
              </button>
            ))}
          </div>

          <p className="mono-caps mt-3 text-[10px] text-faint">{tr("Hour", "Ghanta")}</p>
          <div className="mt-1.5 grid grid-cols-6 gap-1">
            {hours.map((h) => {
              const asDay = (h % 12) + (isPm ? 12 : 0);
              const active = asDay === hour;
              return (
                <button
                  key={h}
                  type="button"
                  onClick={() => set(asDay, minute)}
                  className={cx(
                    "min-h-9 rounded-lg text-sm font-semibold tabular-nums transition-colors",
                    active
                      ? "bg-primary text-primary-on"
                      : "text-strong hover:bg-gradient-soft hover:text-primary",
                  )}
                >
                  {h}
                </button>
              );
            })}
          </div>

          <p className="mono-caps mt-3 text-[10px] text-faint">{tr("Minutes", "Minute")}</p>
          <div className="mt-1.5 grid grid-cols-4 gap-1">
            {MINUTES.map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => {
                  set(hour, m);
                  // A full choice is a finished one: close, and let the caller
                  // act on it, so adding a reminder is two presses and not four.
                  setOpen(false);
                  onCommit?.(`${pad(hour)}:${pad(m)}`);
                }}
                className={cx(
                  "min-h-9 rounded-lg text-sm font-semibold tabular-nums transition-colors",
                  m === minute
                    ? "bg-primary text-primary-on"
                    : "text-strong hover:bg-gradient-soft hover:text-primary",
                )}
              >
                :{pad(m)}
              </button>
            ))}
          </div>

          {/* Any other minute. "Twenty past eight with food" is a real
              instruction, and a picker that cannot say it is a picker somebody
              works around. */}
          <div className="mt-3 flex items-center gap-2 border-t border-line pt-3">
            <span className="mono-caps shrink-0 text-[10px] text-faint">
              {tr("Or type", "Ya likhein")}
            </span>
            <input
              type="text"
              inputMode="numeric"
              placeholder="HH:MM"
              defaultValue={parsed ? `${pad(hour)}:${pad(minute)}` : ""}
              onChange={(event) => {
                const next = parse(event.target.value);
                if (next) set(next.hour, next.minute);
              }}
              onKeyDown={(event) => {
                if (event.key !== "Enter") return;
                event.preventDefault();
                const next = parse((event.target as HTMLInputElement).value);
                if (!next) return;
                setOpen(false);
                onCommit?.(`${pad(next.hour)}:${pad(next.minute)}`);
              }}
              className={cx(
                "min-h-9 w-full rounded-lg border border-line bg-sunken px-2.5",
                "font-mono text-sm tabular-nums text-strong",
                "focus:border-primary focus:outline-none",
              )}
            />
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
