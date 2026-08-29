"use client";

/**
 * The pieces every auth screen repeats.
 *
 * Sign-in, registration, verification, the second factor and both halves of a
 * password reset all open the same way — a badge, a title, a line of
 * explanation — and all of them have to say something went wrong without
 * losing the person. Keeping those two shapes in one place is what stops six
 * screens drifting into six different apologies.
 */

import type { ReactNode } from "react";
import { useId, useState } from "react";

import { Icon } from "@/components/Icon";
import { Logo } from "@/components/brand/Logo";
import { Field, Input, cx } from "@/components/ui";
import { useTr } from "@/lib/lang";

/** The link style used for every inline link on an auth screen. */
export const AUTH_LINK =
  "font-semibold text-primary underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary";

/** The mark, in a soft gradient square. For the screens that are about you. */
export function MarkBadge() {
  return (
    <span
      aria-hidden
      className="bg-gradient-soft grid h-12 w-12 place-items-center rounded-2xl ring-1 ring-line"
    >
      <Logo variant="mark" size="sm" />
    </span>
  );
}

/** A Material Symbol in a full-ramp square. For the screens that are about a step. */
export function IconBadge({ name }: { name: string }) {
  return (
    <span
      aria-hidden
      className="bg-gradient-brand grid h-12 w-12 place-items-center rounded-2xl text-white shadow-glow"
    >
      <Icon name={name} filled className="text-[24px]" />
    </span>
  );
}

export function AuthHeading({
  badge,
  title,
  subtitle,
}: {
  badge: ReactNode;
  title: string;
  subtitle?: ReactNode;
}) {
  return (
    <div className="mb-7">
      <div className="mb-4">{badge}</div>
      <h1 className="font-display text-3xl font-bold text-strong">{title}</h1>
      {subtitle && <p className="mt-1.5 text-muted">{subtitle}</p>}
    </div>
  );
}

const NOTICE_TONES = {
  critical: "border-critical/50 bg-critical-soft text-critical",
  warning: "border-warning/50 bg-warning-soft text-warning",
  info: "border-info/50 bg-info-soft text-info",
  success: "border-stable/50 bg-stable-soft text-stable",
} as const;

const NOTICE_ICONS = {
  critical: "error",
  warning: "warning",
  info: "info",
  success: "check_circle",
} as const;

/**
 * A banner inside the card, for something the person has to read before they
 * can go on.
 *
 * `live` decides how it reaches assistive technology, and the two are not
 * interchangeable: a refusal is an `alert` and interrupts, a confirmation is a
 * `status` and waits its turn. `action` is what makes a gated error useful —
 * "your email is not verified" is a dead end without the button that fixes it.
 */
export function AuthNotice({
  tone = "critical",
  live = "alert",
  icon,
  title,
  children,
  action,
  className,
}: {
  tone?: keyof typeof NOTICE_TONES;
  live?: "alert" | "status";
  icon?: string;
  title?: string;
  children?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      role={live}
      className={cx(
        "pop-in mb-5 rounded-xl border px-4 py-3 text-sm",
        NOTICE_TONES[tone],
        className,
      )}
    >
      <div className="flex items-start gap-2">
        <Icon name={icon ?? NOTICE_ICONS[tone]} className="mt-px shrink-0 text-[18px]" />
        <div className="min-w-0 flex-1">
          {title && <p className="font-semibold">{title}</p>}
          {children && <div className={cx("font-medium", title && "mt-0.5")}>{children}</div>}
          {action && <div className="mt-2.5 flex flex-wrap gap-2">{action}</div>}
        </div>
      </div>
    </div>
  );
}

/**
 * A password box with the eye that reveals it.
 *
 * The reveal is a real toggle button rather than a checkbox styled as one, and
 * it carries `aria-pressed` — a screen-reader user has to be able to tell
 * whether their password is currently on screen.
 */
export function PasswordField({
  id,
  label,
  value,
  onChange,
  error,
  hint,
  autoComplete = "current-password",
  required = true,
  autoFocus = false,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (next: string) => void;
  error?: string;
  hint?: string;
  autoComplete?: string;
  required?: boolean;
  autoFocus?: boolean;
}) {
  const tr = useTr();
  const [shown, setShown] = useState(false);

  return (
    <Field label={label} htmlFor={id} error={error} hint={hint}>
      <Input
        id={id}
        name={id}
        type={shown ? "text" : "password"}
        autoComplete={autoComplete}
        required={required}
        autoFocus={autoFocus}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        invalid={Boolean(error)}
        className="pr-12"
      />
      <button
        type="button"
        aria-label={
          shown ? tr("Hide password", "Password chhupayein") : tr("Show password", "Password dikhayein")
        }
        aria-pressed={shown}
        onClick={() => setShown((current) => !current)}
        className="absolute right-2 top-1/2 grid h-9 w-9 -translate-y-1/2 place-items-center rounded-lg text-muted transition-colors hover:bg-sunken hover:text-strong focus-visible:outline-2 focus-visible:outline-primary"
      >
        <Icon name={shown ? "visibility_off" : "visibility"} className="text-[20px]" />
      </button>
    </Field>
  );
}

/**
 * A phone box that shows the country code it is going to prepend.
 *
 * The prefix appears only once the floating label has risen out of its way —
 * otherwise "+92" and "Phone" occupy the same corner of the box.
 */
export function PhoneField({
  id,
  label,
  hint,
  value,
  onChange,
  error,
}: {
  id: string;
  label: string;
  hint?: string;
  /** Digits only, without the country code. */
  value: string;
  onChange: (next: string) => void;
  error?: string;
}) {
  const [focused, setFocused] = useState(false);
  const showPrefix = focused || value.length > 0;

  return (
    <Field label={label} htmlFor={id} error={error} hint={hint}>
      <Input
        id={id}
        name={id}
        type="tel"
        inputMode="numeric"
        autoComplete="tel-national"
        value={value}
        // Digits only: the country code is fixed and the server wants no spaces.
        onChange={(event) => onChange(event.target.value.replace(/\D/g, "").slice(0, 11))}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        invalid={Boolean(error)}
        className="pl-14"
      />
      <span
        aria-hidden
        className={cx(
          "pointer-events-none absolute bottom-2 left-3.5 font-mono text-base transition-opacity duration-200",
          showPrefix ? "text-muted opacity-100" : "opacity-0",
        )}
      >
        +92
      </span>
    </Field>
  );
}

/**
 * A single monospaced box for a backup code — the escape hatch when the phone
 * with the codes on it is the thing that is missing.
 */
export function BackupCodeField({
  value,
  onChange,
  invalid,
  disabled,
}: {
  value: string;
  onChange: (next: string) => void;
  invalid?: boolean;
  disabled?: boolean;
}) {
  const tr = useTr();
  const id = `backup-${useId().replace(/[^a-zA-Z0-9]/g, "")}`;

  return (
    <Field label={tr("Backup code", "Backup code")} htmlFor={id}>
      <Input
        id={id}
        name="backupCode"
        autoComplete="one-time-code"
        autoFocus
        spellCheck={false}
        autoCapitalize="off"
        value={value}
        onChange={(event) => onChange(event.target.value.toUpperCase().slice(0, 20))}
        invalid={invalid}
        disabled={disabled}
        className={cx("text-center font-mono text-lg tracking-[0.25em]", invalid && "shake")}
      />
    </Field>
  );
}
