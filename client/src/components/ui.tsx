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

import Link from "next/link";
import type { ReactNode } from "react";

import { Icon } from "@/components/Icon";

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
  icon,
  children,
  className,
  flush = false,
}: {
  title?: string;
  description?: string;
  action?: ReactNode;
  /** A Material Symbol name, shown in a tinted square beside the title. */
  icon?: string;
  children: ReactNode;
  className?: string;
  /** No body padding — for content that draws its own edges, like a table. */
  flush?: boolean;
}) {
  return (
    <section
      className={cx("rounded-2xl border border-line bg-card shadow-card", className)}
    >
      {(title || action) && (
        <header className="flex flex-wrap items-center gap-3 border-b border-line px-5 py-4">
          {icon && (
            <span
              aria-hidden
              className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-primary-soft text-primary"
            >
              <Icon name={icon} className="text-[22px]" />
            </span>
          )}
          <div className="min-w-0">
            {title && <h2 className="font-display text-lg font-bold text-strong">{title}</h2>}
            {description && <p className="mt-0.5 text-sm text-muted">{description}</p>}
          </div>
          {action && <div className="ml-auto">{action}</div>}
        </header>
      )}
      <div className={flush ? undefined : "p-5"}>{children}</div>
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
  unit,
  hint,
  tone = "neutral",
  icon,
  footer,
  href,
}: {
  label: string;
  value: number | string;
  /** Rendered smaller and baseline-aligned, the way a chart labels an axis. */
  unit?: string;
  hint?: string;
  tone?: "neutral" | "good" | "warning" | "critical";
  /** Decorative. The label is what carries the meaning. */
  icon?: ReactNode;
  /** A status pill, a sparkline — whatever qualifies the number. */
  footer?: ReactNode;
  /** Makes the whole tile the way to the detail page. */
  href?: string;
}) {
  const tones = {
    neutral: "text-strong",
    good: "text-stable",
    warning: "text-warning",
    critical: "text-critical",
  } as const;
  const iconTones = {
    neutral: "bg-primary-soft text-primary",
    good: "bg-stable-soft text-stable",
    warning: "bg-warning-soft text-warning",
    critical: "bg-critical-soft text-critical",
  } as const;

  const body = (
    <>
      <div className="mb-4 flex items-start justify-between gap-3">
        {/* Uppercase and tracked, per the design system's label style: it reads
            as a field name rather than as prose, which is what lets the number
            below it be the thing the eye lands on. */}
        <span className="text-[12px] font-semibold uppercase tracking-wider text-muted">
          {label}
        </span>
        {icon && (
          <span
            aria-hidden
            className={cx(
              "grid h-10 w-10 shrink-0 place-items-center rounded-xl text-[22px] leading-none",
              iconTones[tone],
            )}
          >
            {icon}
          </span>
        )}
      </div>

      <div className="flex items-end gap-2">
        <span className={cx("font-display text-[38px] font-bold leading-none tabular-nums", tones[tone])}>
          {value}
        </span>
        {unit && <span className="mb-1 text-sm text-muted">{unit}</span>}
      </div>

      {hint && <p className="mt-2 text-xs text-faint">{hint}</p>}
      {footer && <div className="mt-auto pt-4">{footer}</div>}
      {href && (
        <span
          aria-hidden
          className="absolute right-4 bottom-4 text-faint opacity-0 transition-opacity group-hover:opacity-100"
        >
          <Icon name="arrow_forward" className="text-[20px]" />
        </span>
      )}
    </>
  );

  const frame = "group relative flex flex-col rounded-2xl border border-line bg-card p-5 shadow-card";

  if (href) {
    return (
      <Link
        href={href}
        className={cx(
          frame,
          "hover-lift-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary",
        )}
      >
        {body}
      </Link>
    );
  }
  return <div className={frame}>{body}</div>;
}

/**
 * A shortcut card: one thing the person came here to do, one tap away.
 *
 * The icon sits on a gradient tile so a row of four reads as a set of doors
 * rather than a list of links.
 */
export function QuickAction({
  href,
  icon,
  title,
  description,
  tone = "primary",
}: {
  href: string;
  icon: string;
  title: string;
  description: string;
  tone?: "primary" | "accent" | "warning";
}) {
  const tiles = {
    primary: "from-[#003178] to-[#0d47a1] text-white",
    accent: "from-[#006b5f] to-[#00a08b] text-white",
    warning: "from-[#8a5300] to-[#c47f14] text-white",
  } as const;

  return (
    <Link
      href={href}
      className="hover-lift-sm group flex items-center gap-4 rounded-2xl border border-line bg-card p-4 shadow-card focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
    >
      <span
        aria-hidden
        className={cx(
          "grid h-12 w-12 shrink-0 place-items-center rounded-xl bg-gradient-to-br shadow-md",
          tiles[tone],
        )}
      >
        <Icon name={icon} filled className="text-[24px]" />
      </span>
      <span className="min-w-0">
        <span className="block font-semibold text-strong">{title}</span>
        <span className="block truncate text-sm text-muted">{description}</span>
      </span>
      <Icon
        name="arrow_forward"
        className="ml-auto text-[20px] text-faint transition-transform group-hover:translate-x-1"
      />
    </Link>
  );
}

/** Initials in a tinted circle. The tint is derived from the name, so one
    person is always the same colour — recognisable in a list at a glance. */
export function Avatar({
  name,
  size = "md",
  className,
}: {
  name: string;
  size?: "sm" | "md" | "lg";
  className?: string;
}) {
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
  const palettes = [
    "bg-primary-soft text-primary",
    "bg-accent-soft text-accent",
    "bg-warning-soft text-warning",
    "bg-[#ece4ff] text-[#4a2fa3]",
    "bg-[#ffe3f1] text-[#8c1d5a]",
  ];
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  const sizes = { sm: "h-8 w-8 text-xs", md: "h-10 w-10 text-sm", lg: "h-14 w-14 text-lg" };

  return (
    <span
      aria-hidden
      className={cx(
        "grid shrink-0 place-items-center rounded-full font-bold",
        palettes[hash % palettes.length],
        sizes[size],
        className,
      )}
    >
      {initials || "?"}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

export function Button({
  variant = "primary",
  size = "md",
  loading = false,
  className,
  children,
  disabled,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "danger" | "ghost";
  size?: "md" | "lg";
  /** Shows a spinner beside the label and disables the button. */
  loading?: boolean;
}) {
  const variants = {
    primary:
      "bg-primary text-primary-on shadow-sm hover:bg-primary-strong hover:shadow-md active:translate-y-px disabled:bg-primary/50",
    // Outlined accent: the design system's secondary, for actions that report
    // rather than commit.
    secondary: "border border-line-strong bg-card text-strong hover:bg-sunken hover:border-faint",
    danger: "bg-critical text-white hover:opacity-90 disabled:opacity-50",
    ghost: "text-muted hover:bg-sunken hover:text-strong",
  } as const;

  // Minimum 44px height: the accessible touch-target size.
  const sizes = { md: "min-h-11 px-4 text-base", lg: "min-h-14 px-6 text-lg" } as const;

  return (
    <button
      className={cx(
        "inline-flex items-center justify-center gap-2 rounded-lg font-medium transition-[background-color,box-shadow,transform,opacity] duration-200",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary",
        "disabled:cursor-not-allowed disabled:opacity-60",
        variants[variant],
        sizes[size],
        className,
      )}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {loading && (
        <span
          aria-hidden
          className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent opacity-80 motion-reduce:animate-none"
        />
      )}
      {children}
    </button>
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
        "block min-h-11 w-full rounded-lg border bg-card px-3 py-2.5 text-base text-strong transition-[border-color,box-shadow] duration-200",
        "placeholder:text-faint hover:border-faint focus:outline-2 focus:outline-offset-0 focus:outline-primary",
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

/**
 * Waiting, drawn as a heartbeat.
 *
 * A bright segment sweeps along a still ECG trace. It says "alive and
 * working" in the visual language of the building it runs in, and it is
 * quiet enough to sit beside real content. Announced through `role="status"`
 * so the label — not the picture — is what assistive technology hears.
 */
export function Loading({ label = "Loading" }: { label?: string }) {
  return (
    <div role="status" aria-live="polite" className="flex items-center gap-4 py-8 text-muted">
      <svg
        aria-hidden
        viewBox="0 0 120 40"
        className="h-8 w-24 shrink-0 overflow-visible"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path
          d="M0 22 H28 L34 22 L39 8 L46 36 L52 22 H70 L74 15 L78 22 H120"
          className="stroke-line-strong"
          strokeWidth="2"
        />
        <path
          d="M0 22 H28 L34 22 L39 8 L46 36 L52 22 H70 L74 15 L78 22 H120"
          className="ecg-sweep stroke-accent motion-reduce:hidden"
          strokeWidth="2.5"
        />
      </svg>
      <span className="text-sm font-medium">{label}…</span>
    </div>
  );
}

/** A shimmering placeholder the exact size of what is on its way. */
export function Skeleton({ className }: { className?: string }) {
  return <span aria-hidden className={cx("skeleton block", className)} />;
}

/** The dashboard's stat row while it loads. */
export function SkeletonTiles({ count = 4 }: { count?: number }) {
  return (
    <div className="grid grid-cols-2 gap-4 lg:grid-cols-4" aria-hidden>
      {Array.from({ length: count }, (_, index) => (
        <div key={index} className="rounded-2xl border border-line bg-card p-5 shadow-card">
          <div className="mb-5 flex items-start justify-between">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-10 w-10 rounded-xl" />
          </div>
          <Skeleton className="h-9 w-16" />
        </div>
      ))}
    </div>
  );
}

/** A list card while it loads. */
export function SkeletonRows({ rows = 3, title = true }: { rows?: number; title?: boolean }) {
  return (
    <div className="rounded-2xl border border-line bg-card shadow-card" aria-hidden>
      {title && (
        <div className="border-b border-line px-5 py-4">
          <Skeleton className="h-5 w-40" />
          <Skeleton className="mt-2 h-3 w-64" />
        </div>
      )}
      <div className="divide-y divide-line px-5">
        {Array.from({ length: rows }, (_, index) => (
          <div key={index} className="flex items-center gap-4 py-4">
            <Skeleton className="h-10 w-10 rounded-full" />
            <div className="flex-1">
              <Skeleton className="h-4 w-1/3" />
              <Skeleton className="mt-2 h-3 w-1/2" />
            </div>
            <Skeleton className="h-6 w-20 rounded-full" />
          </div>
        ))}
      </div>
    </div>
  );
}

export function EmptyState({
  title,
  description,
  icon,
  action,
}: {
  title: string;
  description?: string;
  /** A Material Symbol name. */
  icon?: string;
  action?: ReactNode;
}) {
  return (
    <div className="py-10 text-center">
      {icon && (
        <span
          aria-hidden
          className="mx-auto mb-4 grid h-14 w-14 place-items-center rounded-2xl bg-sunken text-faint"
        >
          <Icon name={icon} className="text-[28px]" />
        </span>
      )}
      <p className="text-base font-semibold text-strong">{title}</p>
      {description && (
        <p className="mx-auto mt-1 max-w-sm text-sm text-muted">{description}</p>
      )}
      {action && <div className="mt-4 flex justify-center">{action}</div>}
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
