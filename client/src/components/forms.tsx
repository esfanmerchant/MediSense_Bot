"use client";

/**
 * Form parts that more than one flow needs: a one-time-code field, a segmented
 * control, a switch, a stepper, and a password strength meter.
 *
 * They live apart from `ui.tsx` because they are compositions rather than
 * primitives, and because several screens land on them at once — sign-up,
 * verification, two-factor, onboarding.
 */

import { motion, useReducedMotion } from "framer-motion";
import {
  useEffect,
  useId,
  useRef,
  type ClipboardEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";

import { Icon } from "@/components/Icon";
import { cx } from "@/components/ui";

// ---------------------------------------------------------------------------
// One-time code
// ---------------------------------------------------------------------------

/**
 * The six boxes people type an emailed code into.
 *
 * Everything here exists because of how the code actually arrives: it is read
 * off a phone one digit at a time, or pasted whole from an email. So typing
 * advances, backspace retreats, arrows move, and a paste of "123456" fills
 * every box at once no matter which one was focused.
 *
 * One hidden truth: `value` is the single source. The boxes are views of it,
 * which is what lets a paste, a backspace and an autofill all behave.
 */
export function OtpInput({
  value,
  onChange,
  onComplete,
  length = 6,
  invalid = false,
  disabled = false,
  label,
  autoFocus = true,
}: {
  value: string;
  onChange: (next: string) => void;
  /** Fired once the last box is filled — usually submits the form. */
  onComplete?: (code: string) => void;
  length?: number;
  invalid?: boolean;
  disabled?: boolean;
  /** Describes the group to assistive technology. */
  label: string;
  autoFocus?: boolean;
}) {
  const boxes = useRef<(HTMLInputElement | null)[]>([]);
  const digits = value.padEnd(length, " ").slice(0, length).split("");
  const groupId = useId();

  useEffect(() => {
    if (autoFocus) boxes.current[0]?.focus();
  }, [autoFocus]);

  const write = (next: string) => {
    const cleaned = next.replace(/\D/g, "").slice(0, length);
    onChange(cleaned);
    if (cleaned.length === length) onComplete?.(cleaned);
    return cleaned;
  };

  const onDigit = (index: number, raw: string) => {
    const typed = raw.replace(/\D/g, "");
    if (!typed) return;
    // Take the last character so overtyping a filled box replaces it.
    const characters = value.split("");
    characters[index] = typed[typed.length - 1];
    const next = write(characters.join("").slice(0, length));
    const target = Math.min(index + typed.length, length - 1);
    if (next.length < length) boxes.current[target]?.focus();
  };

  const onKey = (index: number, event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Backspace") {
      event.preventDefault();
      const characters = value.split("");
      if (characters[index]) {
        characters[index] = "";
        onChange(characters.join("").trimEnd());
      } else if (index > 0) {
        characters[index - 1] = "";
        onChange(characters.slice(0, index - 1).join(""));
        boxes.current[index - 1]?.focus();
      }
      return;
    }
    if (event.key === "ArrowLeft" && index > 0) boxes.current[index - 1]?.focus();
    if (event.key === "ArrowRight" && index < length - 1) boxes.current[index + 1]?.focus();
  };

  const onPaste = (event: ClipboardEvent<HTMLInputElement>) => {
    event.preventDefault();
    const next = write(event.clipboardData.getData("text"));
    boxes.current[Math.min(next.length, length - 1)]?.focus();
  };

  return (
    <div
      role="group"
      aria-label={label}
      className={cx("flex justify-center gap-2 sm:gap-3", invalid && "shake")}
    >
      {Array.from({ length }, (_, index) => (
        <input
          key={index}
          ref={(element) => {
            boxes.current[index] = element;
          }}
          id={`${groupId}-${index}`}
          type="text"
          inputMode="numeric"
          autoComplete={index === 0 ? "one-time-code" : "off"}
          aria-label={`${label} — ${index + 1}`}
          maxLength={1}
          disabled={disabled}
          value={digits[index]?.trim() ?? ""}
          onChange={(event) => onDigit(index, event.target.value)}
          onKeyDown={(event) => onKey(index, event)}
          onPaste={onPaste}
          onFocus={(event) => event.target.select()}
          className={cx(
            "input-base h-14 w-11 rounded-xl border-2 bg-card text-center font-mono text-2xl font-bold text-strong sm:w-14",
            "disabled:opacity-60",
            invalid ? "border-critical" : "border-line-strong",
          )}
        />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Segmented control
// ---------------------------------------------------------------------------

/** Two to four exclusive choices, with the indicator sliding between them. */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
  size = "md",
  className,
}: {
  options: { value: T; label: string; icon?: string }[];
  value: T;
  onChange: (next: T) => void;
  label: string;
  size?: "sm" | "md";
  className?: string;
}) {
  const reduced = useReducedMotion();
  const layoutId = useId();
  const sizes = { sm: "min-h-9 px-3 text-xs", md: "min-h-11 px-4 text-sm" } as const;

  return (
    <div
      role="tablist"
      aria-label={label}
      className={cx("inline-flex rounded-xl border border-line bg-sunken p-1", className)}
    >
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(option.value)}
            className={cx(
              "relative flex flex-1 items-center justify-center gap-1.5 rounded-lg font-semibold transition-colors",
              "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary",
              sizes[size],
              active ? "text-white" : "text-muted hover:text-strong",
            )}
          >
            {active && (
              <motion.span
                layoutId={layoutId}
                aria-hidden
                transition={reduced ? { duration: 0 } : { type: "spring", stiffness: 460, damping: 34 }}
                className="bg-gradient-brand absolute inset-0 rounded-lg shadow-sm"
              />
            )}
            <span className="relative z-10 flex items-center gap-1.5">
              {option.icon && <Icon name={option.icon} filled={active} className="text-[18px]" />}
              {option.label}
            </span>
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Switch
// ---------------------------------------------------------------------------

export function Switch({
  checked,
  onChange,
  label,
  description,
  disabled = false,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  description?: string;
  disabled?: boolean;
}) {
  const reduced = useReducedMotion();
  return (
    <label
      className={cx(
        "flex cursor-pointer items-start gap-3",
        disabled && "cursor-not-allowed opacity-60",
      )}
    >
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cx(
          "relative mt-0.5 h-6 w-11 shrink-0 rounded-full transition-colors",
          "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary",
          checked ? "bg-primary" : "bg-line-strong",
        )}
      >
        <motion.span
          layout
          aria-hidden
          transition={reduced ? { duration: 0 } : { type: "spring", stiffness: 500, damping: 32 }}
          className={cx(
            "absolute top-1 h-4 w-4 rounded-full bg-white shadow-sm",
            checked ? "right-1" : "left-1",
          )}
        />
      </button>
      <span className="min-w-0">
        <span className="block text-sm font-semibold text-strong">{label}</span>
        {description && <span className="block text-sm text-muted">{description}</span>}
      </span>
    </label>
  );
}

// ---------------------------------------------------------------------------
// Stepper
// ---------------------------------------------------------------------------

export interface Step {
  label: string;
  /** Optional caption under the label, on the vertical layout. */
  hint?: string;
}

/**
 * Where you are in a multi-step flow.
 *
 * The connector fills as you advance and the current circle glows. Completed
 * steps are buttons when `onJump` is given — going back must never be a
 * side-effecting action, so the caller decides whether it is allowed.
 */
export function Stepper({
  steps,
  current,
  onJump,
  orientation = "horizontal",
  className,
}: {
  steps: Step[];
  /** Zero-based index of the active step. */
  current: number;
  onJump?: (index: number) => void;
  orientation?: "horizontal" | "vertical";
  className?: string;
}) {
  const reduced = useReducedMotion();
  const vertical = orientation === "vertical";

  return (
    <ol
      className={cx(
        vertical ? "flex flex-col gap-1" : "flex items-start gap-1 sm:gap-2",
        className,
      )}
    >
      {steps.map((step, index) => {
        const done = index < current;
        const active = index === current;
        const reachable = Boolean(onJump) && index < current;
        const Circle = reachable ? "button" : "div";

        return (
          <li
            key={step.label}
            className={cx(
              "relative flex min-w-0",
              vertical ? "flex-row items-start gap-3 pb-6 last:pb-0" : "flex-1 flex-col items-center",
            )}
            aria-current={active ? "step" : undefined}
          >
            {/* the connector */}
            {index > 0 && (
              <span
                aria-hidden
                className={cx(
                  "absolute bg-line",
                  vertical
                    ? "left-[0.9rem] -top-6 h-6 w-0.5"
                    : "left-[calc(-50%+1.25rem)] right-[calc(50%+1.25rem)] top-[1.15rem] h-0.5",
                )}
              >
                <motion.span
                  initial={false}
                  animate={
                    vertical
                      ? { scaleY: index <= current ? 1 : 0 }
                      : { scaleX: index <= current ? 1 : 0 }
                  }
                  transition={reduced ? { duration: 0 } : { duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
                  className={cx(
                    "bg-gradient-brand block h-full w-full",
                    vertical ? "origin-top" : "origin-left",
                  )}
                />
              </span>
            )}

            <Circle
              {...(reachable
                ? { type: "button" as const, onClick: () => onJump?.(index) }
                : {})}
              className={cx(
                "relative z-10 grid h-9 w-9 shrink-0 place-items-center rounded-full border-2 text-sm font-bold transition-colors",
                reachable &&
                  "cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary",
                // Solid, not the ramp: see the note on `checkFill` in ui.tsx.
                done && "border-transparent bg-primary text-primary-on",
                active && "border-transparent bg-primary text-primary-on shadow-glow",
                !done && !active && "border-line-strong bg-card text-faint",
              )}
            >
              {done ? <Icon name="check" className="text-[20px]" /> : index + 1}
              {active && (
                <span aria-hidden className="animate-halo absolute inset-0 rounded-full" />
              )}
            </Circle>

            <div className={cx("min-w-0", vertical ? "pt-1" : "mt-2 text-center")}>
              <span
                className={cx(
                  "block truncate text-xs font-semibold sm:text-sm",
                  active ? "text-primary" : done ? "text-strong" : "text-faint",
                )}
              >
                {step.label}
              </span>
              {step.hint && vertical && (
                <span className="block text-xs text-muted">{step.hint}</span>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

// ---------------------------------------------------------------------------
// Password strength
// ---------------------------------------------------------------------------

/**
 * Four segments that fill as a password gets harder to guess.
 *
 * Scored on the things that actually matter — length first, then variety — and
 * deliberately not a promise: the server's own policy is what accepts or
 * rejects, and this only tells someone which way they are heading.
 */
export function PasswordStrength({
  value,
  labels,
}: {
  value: string;
  /** [weak, fair, good, strong], already translated by the caller. */
  labels: [string, string, string, string];
}) {
  const score = strengthOf(value);
  const tones = ["bg-critical", "bg-warning", "bg-info", "bg-stable"] as const;
  const texts = ["text-critical", "text-warning", "text-info", "text-stable"] as const;

  return (
    <div className="space-y-1.5" aria-live="polite">
      <div className="flex gap-1.5">
        {[0, 1, 2, 3].map((index) => (
          <span
            key={index}
            aria-hidden
            className={cx(
              "h-1.5 flex-1 rounded-full transition-colors duration-300",
              value && index <= score ? tones[score] : "bg-line",
            )}
          />
        ))}
      </div>
      {value && (
        <p className={cx("text-xs font-semibold", texts[score])}>{labels[score]}</p>
      )}
    </div>
  );
}

export function strengthOf(password: string): 0 | 1 | 2 | 3 {
  if (!password) return 0;
  // The server's floor is ten characters with an upper, a lower and a digit.
  // Anything short of that cannot be accepted, so it cannot be "Fair" — a
  // meter that reads Fair on a password the next screen rejects is worse than
  // no meter, because it was consulted and it lied.
  const variety =
    Number(/[a-z]/.test(password)) +
    Number(/[A-Z]/.test(password)) +
    Number(/\d/.test(password)) +
    Number(/[^\w\s]/.test(password));
  const accepted =
    password.length >= 10 && /[a-z]/.test(password) && /[A-Z]/.test(password) && /\d/.test(password);
  if (!accepted) return 0;

  let score = 1;
  if (password.length >= 14) score += 1;
  if (variety === 4 && password.length >= 12) score += 1;
  return Math.min(3, score) as 0 | 1 | 2 | 3;
}

// ---------------------------------------------------------------------------
// A moment worth marking
// ---------------------------------------------------------------------------

/** The ECG line drawing itself into a checkmark: a save, a booking, a submit. */
export function SuccessMark({ size = 72, className }: { size?: number; className?: string }) {
  return (
    <span
      aria-hidden
      className={cx("pop-scale bg-gradient-brand grid place-items-center rounded-full text-white shadow-glow", className)}
      style={{ width: size, height: size }}
    >
      <svg viewBox="0 0 48 48" style={{ width: size * 0.55, height: size * 0.55 }} fill="none">
        <path
          d="M10 25 L20 34 L38 15"
          stroke="currentColor"
          strokeWidth="4"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="draw-stroke"
        />
      </svg>
    </span>
  );
}

/** A labelled success panel — the state a flow lands on after it commits. */
export function SuccessPanel({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children?: ReactNode;
}) {
  return (
    <div role="status" className="flex flex-col items-center gap-4 py-8 text-center">
      <SuccessMark />
      <div>
        <p className="font-display text-xl font-bold text-strong">{title}</p>
        {description && <p className="mt-1 max-w-sm text-sm text-muted">{description}</p>}
      </div>
      {children}
    </div>
  );
}
