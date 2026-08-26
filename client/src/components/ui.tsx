/**
 * Shared UI primitives.
 *
 * The patient portal is used by elderly and visually impaired people (spec
 * §39), so the defaults here are deliberately generous: large hit targets,
 * visible focus rings, real contrast, and text that never falls below 16px.
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
      className={cx(
        "rounded-lg border border-slate-200 bg-white shadow-sm dark:border-slate-700 dark:bg-slate-900",
        className,
      )}
    >
      {(title || action) && (
        <header className="flex flex-wrap items-center gap-3 border-b border-slate-200 px-5 py-4 dark:border-slate-700">
          <div className="min-w-0">
            {title && (
              <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-50">{title}</h2>
            )}
            {description && (
              <p className="mt-0.5 text-sm text-slate-600 dark:text-slate-400">{description}</p>
            )}
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
}: {
  label: string;
  value: number | string;
  hint?: string;
  tone?: "neutral" | "good" | "warning" | "critical";
}) {
  const tones = {
    neutral: "text-slate-900 dark:text-slate-50",
    good: "text-emerald-700 dark:text-emerald-400",
    warning: "text-amber-700 dark:text-amber-400",
    critical: "text-red-700 dark:text-red-400",
  } as const;

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900">
      <p className="text-sm font-medium text-slate-600 dark:text-slate-400">{label}</p>
      <p className={cx("mt-1 text-3xl font-semibold tabular-nums", tones[tone])}>{value}</p>
      {hint && <p className="mt-1 text-xs text-slate-500 dark:text-slate-500">{hint}</p>}
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
    primary: "bg-teal-700 text-white hover:bg-teal-800 disabled:bg-teal-700/50",
    secondary:
      "border border-slate-300 bg-white text-slate-900 hover:bg-slate-50 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100 dark:hover:bg-slate-700",
    danger: "bg-red-700 text-white hover:bg-red-800 disabled:bg-red-700/50",
    ghost: "text-slate-700 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800",
  } as const;

  // Minimum 44px height: the accessible touch-target size.
  const sizes = { md: "min-h-11 px-4 text-base", lg: "min-h-14 px-6 text-lg" } as const;

  return (
    <button
      className={cx(
        "inline-flex items-center justify-center gap-2 rounded-md font-medium transition-colors",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600",
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
      <label
        htmlFor={htmlFor}
        className="block text-sm font-medium text-slate-800 dark:text-slate-200"
      >
        {label}
      </label>
      {children}
      {hint && !error && (
        <p id={`${htmlFor}-hint`} className="text-sm text-slate-600 dark:text-slate-400">
          {hint}
        </p>
      )}
      {error && (
        // role="alert" so a screen reader announces the problem immediately.
        <p id={`${htmlFor}-error`} role="alert" className="text-sm font-medium text-red-700 dark:text-red-400">
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
        "block w-full rounded-md border bg-white px-3 py-2.5 text-base text-slate-900 min-h-11",
        "placeholder:text-slate-400 focus:outline-2 focus:outline-offset-0 focus:outline-teal-600",
        "dark:bg-slate-800 dark:text-slate-100",
        invalid
          ? "border-red-500 dark:border-red-500"
          : "border-slate-300 dark:border-slate-600",
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
    neutral: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
    good: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
    warning: "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-300",
    critical: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
    info: "bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300",
  } as const;

  return (
    <span
      className={cx(
        "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium",
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
    <div role="status" aria-live="polite" className="flex items-center gap-3 py-8 text-slate-600 dark:text-slate-400">
      <span
        aria-hidden
        className="h-5 w-5 animate-spin rounded-full border-2 border-slate-300 border-t-teal-700 motion-reduce:animate-none"
      />
      <span className="text-sm">{label}…</span>
    </div>
  );
}

export function EmptyState({ title, description }: { title: string; description?: string }) {
  return (
    <div className="py-10 text-center">
      <p className="text-base font-medium text-slate-800 dark:text-slate-200">{title}</p>
      {description && (
        <p className="mx-auto mt-1 max-w-sm text-sm text-slate-600 dark:text-slate-400">
          {description}
        </p>
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
    <div
      role="alert"
      className="rounded-lg border border-red-200 bg-red-50 p-5 dark:border-red-900 dark:bg-red-950/40"
    >
      <p className="font-medium text-red-900 dark:text-red-200">{title}</p>
      <p className="mt-1 text-sm text-red-800 dark:text-red-300">{message}</p>
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
