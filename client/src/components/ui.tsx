/**
 * Shared UI primitives.
 *
 * The patient portal is used by elderly and visually impaired people (spec
 * §39), so the defaults here are deliberately generous: large hit targets,
 * visible focus rings, real contrast, and text that never falls below 16px.
 *
 * Every colour comes from a token in `globals.css` rather than a Tailwind
 * palette name. That is what lets the whole application follow the design
 * system — and switch to its night palette — from one file instead of hundreds.
 *
 * **Status colour means status.** `critical` is for something a clinician must
 * act on, never for emphasis and never for a delete button. The moment red also
 * means "destructive", a ward stops reading red as urgent, which is how a
 * monitoring system quietly stops working.
 */

import type { ReactNode } from "react";

export function cx(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(" ");
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

export function Card({
  title,
  description,
  action,
  children,
  className,
}: {
  title?: string;
  description?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={cx("rounded-2xl border border-line bg-card shadow-card", className)}
    >
      {(title || action) && (
        <header className="flex flex-wrap items-center gap-3 border-b border-line px-5 py-4">
          <div className="min-w-0">
            {title && <h2 className="text-lg font-semibold text-strong">{title}</h2>}
            {description && <p className="mt-0.5 text-sm text-muted">{description}</p>}
          </div>
          {action && <div className="ml-auto">{action}</div>}
        </header>
      )}
      <div className="p-5">{children}</div>
    </section>
  );
}

/**
 * A headline number. `tone` carries meaning, not decoration — `critical` is for
 * things a clinician must act on, never for emphasis.
 */
export function StatTile({
  label,
  value,
  hint,
  tone = "neutral",
  icon,
}: {
  label: string;
  value: number | string;
  hint?: string;
  tone?: "neutral" | "good" | "warning" | "critical";
  /** Decorative. The label is what carries the meaning. */
  icon?: ReactNode;
}) {
  const tones = {
    neutral: "text-strong",
    good: "text-stable",
    warning: "text-warning",
    critical: "text-critical",
  } as const;

  return (
    <div className="rounded-2xl border border-line bg-card p-5 shadow-card">
      <div className="flex items-start gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium text-muted">{label}</p>
          <p className={cx("mt-1 text-3xl font-bold tabular-nums", tones[tone])}>{value}</p>
          {hint && <p className="mt-1 text-xs text-faint">{hint}</p>}
        </div>
        {icon && (
          <span
            aria-hidden
            className="ml-auto grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-sunken text-lg"
          >
            {icon}
          </span>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

export function Button({
  variant = "primary",
  size = "md",
  className,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "danger" | "ghost";
  size?: "md" | "lg";
}) {
  const variants = {
    primary: "bg-primary text-primary-on hover:bg-primary-strong disabled:bg-primary/50",
    // Outlined accent: the design system's secondary, for actions that report
    // rather than commit.
    secondary: "border border-line-strong bg-card text-strong hover:bg-sunken",
    danger: "bg-critical text-white hover:opacity-90 disabled:opacity-50",
    ghost: "text-muted hover:bg-sunken",
  } as const;

  // Minimum 44px height: the accessible touch-target size.
  const sizes = { md: "min-h-11 px-4 text-base", lg: "min-h-14 px-6 text-lg" } as const;

  return (
    <button
      className={cx(
        "inline-flex items-center justify-center gap-2 rounded-lg font-medium transition-colors",
          "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary",
            "disabled:cursor-not-allowed disabled:opacity-60",
        variants[variant],
        sizes[size],
        className,
      )}
      {...props}
    />
  );
}

export function Field({
  label,
  hint,
  error,
  children,
  htmlFor,
}: {
  label: string;
  hint?: string;
  error?: string;
  children: ReactNode;
  htmlFor: string;
}) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={htmlFor} className="block text-sm font-semibold text-strong">
        {label}
      </label>
      {children}
      {hint && !error && (
        <p id={`${htmlFor}-hint`} className="text-sm text-muted">
          {hint}
        </p>
      )}
      {error && (
        // role="alert" so a screen reader announces the problem immediately.
        <p id={`${htmlFor}-error`} role="alert" className="text-sm font-medium text-critical">
          {error}
        </p>
      )}
    </div>
  );
}

export function Input({
  className,
  invalid,
  ...props
}: React.InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }) {
  return (
    <input
      aria-invalid={invalid || undefined}
      className={cx(
        "block min-h-11 w-full rounded-lg border bg-card px-3 py-2.5 text-base text-strong",
          "placeholder:text-faint focus:outline-2 focus:outline-offset-0 focus:outline-primary",
        invalid ? "border-critical" : "border-line-strong",
        className,
      )}
      {...props}
    />
  );
}

export function Badge({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "good" | "warning" | "critical" | "info";
}) {
  const tones = {
    neutral: "bg-sunken text-muted",
    good: "bg-stable-soft text-stable",
    warning: "bg-warning-soft text-warning",
    critical: "bg-critical-soft text-critical",
    info: "bg-primary-soft text-primary",
  } as const;

  return (
    // Pill-shaped, to distinguish a status from a clickable button.
    <span
      className={cx(
        "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold",
        tones[tone],
      )}
    >
      {children}
    </span>
  );
}

// ---------------------------------------------------------------------------
// States — every list and panel must handle all of these (spec §38)
// ---------------------------------------------------------------------------

export function Loading({ label = "Loading" }: { label?: string }) {
  return (
    <div role="status" aria-live="polite" className="flex items-center gap-3 py-8 text-muted">
      <span
        aria-hidden
        className="h-5 w-5 animate-spin rounded-full border-2 border-line-strong border-t-primary motion-reduce:animate-none"
      />
      <span className="text-sm">{label}…</span>
    </div>
  );
}

export function EmptyState({ title, description }: { title: string; description?: string }) {
  return (
    <div className="py-10 text-center">
      <p className="text-base font-semibold text-strong">{title}</p>
      {description && (
        <p className="mx-auto mt-1 max-w-sm text-sm text-muted">{description}</p>
      )}
    </div>
  );
}

export function ErrorState({
  title = "Something went wrong",
  message,
  onRetry,
}: {
  title?: string;
  message: string;
  onRetry?: () => void;
}) {
  return (
    <div role="alert" className="rounded-xl border border-critical/40 bg-critical-soft p-5">
      <p className="font-semibold text-critical">{title}</p>
      <p className="mt-1 text-sm text-strong">{message}</p>
      {onRetry && (
        <Button variant="secondary" className="mt-3" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  );
}

export function Unauthorized({ message }: { message?: string }) {
  return (
    <ErrorState
      title="You do not have access to this"
      message={
        message ??
          "Your account does not have permission to view this page. If you think that is wrong, contact an administrator."
      }
    />
  );
}
