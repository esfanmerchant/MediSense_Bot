"use client";

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
import {
  useEffect,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from "react";

import { Icon } from "@/components/Icon";

export function cx(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(" ");
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

/**
 * A light perspective tilt that follows the cursor — for cards that *do*
 * something. Static information never tilts: movement under a reading is a
 * distraction, movement under a button is an invitation.
 */
function useTilt(ref: React.RefObject<HTMLElement | null>, enabled: boolean, maxDegrees = 4) {
  const onMove = (event: MouseEvent<HTMLElement>) => {
    const element = ref.current;
    if (!enabled || !element || prefersReducedMotion()) return;
    const rect = element.getBoundingClientRect();
    const x = (event.clientX - rect.left) / rect.width - 0.5;
    const y = (event.clientY - rect.top) / rect.height - 0.5;
    element.style.transform = `perspective(900px) rotateX(${(-y * maxDegrees).toFixed(2)}deg) rotateY(${(x * maxDegrees).toFixed(2)}deg) translateY(-4px)`;
  };
  const onLeave = () => {
    const element = ref.current;
    if (element) element.style.transform = "";
  };

  return { onMove, onLeave };
}

export function Card({
  title,
  description,
  action,
  icon,
  children,
  className,
  flush = false,
  variant = "default",
  interactive = false,
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
  /** `glass` floats over content; `featured` wears the brand gradient border. */
  variant?: "default" | "glass" | "featured";
  /** Lifts and tilts under the cursor. Only for cards that lead somewhere. */
  interactive?: boolean;
}) {
  const shell = useRef<HTMLElement | null>(null);
  const tilt = useTilt(shell, interactive);
  const shells = {
    default: "border border-line bg-card shadow-card",
    glass: "glass",
    featured: "border-gradient shadow-card",
  } as const;

  return (
    <section
      ref={shell}
      onMouseMove={interactive ? tilt.onMove : undefined}
      onMouseLeave={interactive ? tilt.onLeave : undefined}
      className={cx("rounded-2xl", shells[variant], interactive && "tilt", className)}
    >
      {(title || action) && (
        <header className="flex flex-wrap items-center gap-3 border-b border-line px-6 py-5">
          {icon && (
            <span
              aria-hidden
              className="bg-gradient-soft grid h-11 w-11 shrink-0 place-items-center rounded-xl text-primary"
            >
              <Icon name={icon} className="text-[22px]" />
            </span>
          )}
          <div className="min-w-0">
            {title && <h2 className="font-display text-lg font-bold text-strong">{title}</h2>}
            {description && <p className="mt-1 text-sm text-muted">{description}</p>}
          </div>
          {action && <div className="ml-auto">{action}</div>}
        </header>
      )}
      <div className={flush ? undefined : "p-6"}>{children}</div>
    </section>
  );
}

/**
 * A number that counts up to its value on mount and whenever it changes.
 *
 * Reduced motion, the test environment, or no window all land on the same
 * honest fallback: the final number, immediately.
 */
export function CountUp({ value, duration = 1100 }: { value: number; duration?: number }) {
  const instant = prefersReducedMotion() || process.env.NODE_ENV === "test";
  const [shown, setShown] = useState(instant ? value : 0);
  const from = useRef(0);

  useEffect(() => {
    if (instant) return;
    const start = performance.now();
    const origin = from.current;
    let frame = 0;
    const tick = (now: number) => {
      const progress = Math.min(1, (now - start) / duration);
      // Ease-out: the last digits settle slowly, which is what the eye reads.
      const eased = 1 - Math.pow(1 - progress, 3);
      const next = Math.round(origin + (value - origin) * eased);
      setShown(next);
      if (progress < 1) frame = requestAnimationFrame(tick);
      else from.current = value;
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [value, duration, instant]);

  return <>{instant ? value : shown}</>;
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
  trend,
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
  /** Change against the previous period, when one is known. */
  trend?: { delta: number; label?: string };
}) {
  const tones = {
    neutral: "text-strong",
    good: "text-stable",
    warning: "text-warning",
    critical: "text-critical",
  } as const;
  const iconTones = {
    neutral: "bg-gradient-soft text-primary",
    good: "bg-stable-soft text-stable",
    warning: "bg-warning-soft text-warning",
    critical: "bg-critical-soft text-critical",
  } as const;

  const body = (
    <>
      <div className="relative mb-5 flex items-start justify-between gap-3">
        <span className="text-[12px] font-semibold uppercase tracking-wider text-muted">
          {label}
        </span>
        {icon && (
          <span
            aria-hidden
            className={cx(
              "icon-bounce grid h-11 w-11 shrink-0 place-items-center rounded-xl text-[22px] leading-none shadow-sm",
              iconTones[tone],
            )}
          >
            {icon}
          </span>
        )}
      </div>

      <div className="relative flex items-end gap-2">
        <span className={cx("font-display text-[40px] font-bold leading-none tabular-nums", tones[tone])}>
          {typeof value === "number" ? <CountUp value={value} /> : value}
        </span>
        {unit && <span className="mb-1 text-sm text-muted">{unit}</span>}
        {trend && (
          <span
            className={cx(
              "pop-in mb-1 ml-auto inline-flex items-center gap-0.5 rounded-full px-2 py-0.5 text-xs font-semibold tabular-nums",
              trend.delta >= 0 ? "bg-stable-soft text-stable" : "bg-critical-soft text-critical",
            )}
          >
            <Icon name={trend.delta >= 0 ? "trending_up" : "trending_down"} className="text-[14px]" />
            {Math.abs(trend.delta)}%{trend.label ? ` ${trend.label}` : ""}
          </span>
        )}
      </div>

      {hint && <p className="relative mt-2 text-xs text-faint">{hint}</p>}
      {footer && <div className="relative mt-auto pt-4">{footer}</div>}
      {href && (
        <span
          aria-hidden
          className="absolute right-5 bottom-5 text-faint opacity-0 transition-opacity group-hover:opacity-100"
        >
          <Icon name="arrow_forward" className="text-[20px]" />
        </span>
      )}
    </>
  );

  const frame =
    "blob-corner group relative flex flex-col overflow-hidden rounded-2xl border border-line bg-card p-6 shadow-card hover-lift-sm";

  if (href) {
    return (
      <Link
        href={href}
        className={cx(frame, "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary")}
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
 * Icon-forward, on its own soft tint, so a row of four reads as a set of
 * doors rather than a list of links.
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
  tone?: "primary" | "accent" | "warning" | "info";
}) {
  const tints = {
    primary: "from-[#1B4FE0]/12 to-[#1B4FE0]/4 text-primary",
    accent: "from-[#14C7C0]/18 to-[#14C7C0]/5 text-accent",
    warning: "from-[#F5A524]/18 to-[#F5A524]/5 text-warning",
    info: "from-[#3B82F6]/14 to-[#3B82F6]/4 text-info",
  } as const;
  const tiles = {
    primary: "bg-gradient-brand text-white",
    accent: "bg-gradient-to-br from-[#14C7C0] to-[#5EEAD4] text-[#053b38]",
    warning: "bg-gradient-to-br from-[#F5A524] to-[#fbd27a] text-[#4a2d00]",
    info: "bg-gradient-to-br from-[#3B82F6] to-[#8fb6ff] text-white",
  } as const;
  const shell = useRef<HTMLAnchorElement | null>(null);
  const tilt = useTilt(shell, true);

  return (
    <Link
      href={href}
      ref={shell}
      onMouseMove={tilt.onMove}
      onMouseLeave={tilt.onLeave}
      className={cx(
        "tilt group flex items-center gap-4 rounded-2xl border border-line bg-gradient-to-br bg-card p-5 shadow-card",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary",
        tints[tone],
      )}
    >
      <span
        aria-hidden
        className={cx(
          "icon-bounce grid h-14 w-14 shrink-0 place-items-center rounded-2xl shadow-md",
          tiles[tone],
        )}
      >
        <Icon name={icon} filled className="text-[28px]" />
      </span>
      <span className="min-w-0">
        <span className="block font-display text-[17px] font-bold text-strong">{title}</span>
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
  ring,
  className,
}: {
  name: string;
  size?: "sm" | "md" | "lg";
  /** A status ring: green for active, grey for inactive. */
  ring?: "active" | "inactive";
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
  const rings = {
    active: "ring-2 ring-stable ring-offset-2 ring-offset-card",
    inactive: "ring-2 ring-line-strong ring-offset-2 ring-offset-card",
  } as const;

  return (
    <span
      aria-hidden
      className={cx(
        "grid shrink-0 place-items-center rounded-full font-bold",
        palettes[hash % palettes.length],
        sizes[size],
        ring && rings[ring],
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

/** Three bars taking turns — the loading blip, on brand. */
export function EkgBars({ className }: { className?: string }) {
  return (
    <span aria-hidden className={cx("ekg-bars", className)}>
      <span />
      <span />
      <span />
    </span>
  );
}

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
  /** Shows the pulse-line in place of the label and disables the button. */
  loading?: boolean;
}) {
  const variants = {
    primary: "btn-gradient text-white disabled:opacity-60",
    // Outlined in the gradient: for actions that report rather than commit.
    secondary: "btn-outline",
    danger: "bg-critical text-white shadow-sm hover:opacity-90 hover:scale-[1.02] active:scale-[0.98] disabled:opacity-50",
    ghost: "text-primary hover:bg-gradient-soft",
  } as const;

  // Minimum 44px height: the accessible touch-target size.
  const sizes = { md: "min-h-11 px-4 text-base", lg: "min-h-14 px-6 text-lg" } as const;

  return (
    <button
      className={cx(
        "relative inline-flex items-center justify-center gap-2 rounded-xl font-semibold transition-[background-color,box-shadow,transform,opacity] duration-200 ease-out",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary",
        "disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:scale-100",
        variants[variant],
        sizes[size],
        className,
      )}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {loading ? (
        <>
          <EkgBars />
          {/* The label stays for assistive technology; the bars are for eyes. */}
          <span className="sr-only">{children}</span>
        </>
      ) : (
        children
      )}
    </button>
  );
}

/** A round button holding one icon. The label is for screen readers. */
export function IconButton({
  label,
  icon,
  filled = false,
  tone = "neutral",
  size = "md",
  className,
  ...props
}: Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "children"> & {
  label: string;
  icon: string;
  filled?: boolean;
  tone?: "neutral" | "primary" | "danger";
  size?: "sm" | "md";
}) {
  const tones = {
    neutral: "text-muted hover:bg-gradient-soft hover:text-primary",
    primary: "btn-gradient text-white",
    danger: "bg-critical text-white hover:opacity-90",
  } as const;
  const sizes = { sm: "h-9 w-9 text-[20px]", md: "h-11 w-11 text-[22px]" } as const;
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={cx(
        "relative grid shrink-0 place-items-center rounded-full transition-[background-color,color,transform,box-shadow] duration-200 ease-out hover:scale-105 active:scale-95",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary",
        "disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:scale-100",
        tones[tone],
        sizes[size],
        className,
      )}
      {...props}
    >
      <Icon name={icon} filled={filled} className="text-[inherit]" />
    </button>
  );
}

/**
 * A labelled field with a floating label.
 *
 * The label sits inside the control until it is focused or filled, then
 * rises to a small caption above the value. It is still a real `<label>`
 * bound by `htmlFor`, so assistive technology and tests read it exactly as
 * before — the float is purely visual.
 */
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
    <div className={cx("space-y-1.5", error && "field-invalid")}>
      <div className="field-shell">
        {children}
        <label htmlFor={htmlFor} className="field-label">
          {label}
        </label>
      </div>
      {hint && !error && (
        <p id={`${htmlFor}-hint`} className="px-1 text-sm text-muted">
          {hint}
        </p>
      )}
      {error && (
        // role="alert" so a screen reader announces the problem immediately.
        <p
          id={`${htmlFor}-error`}
          role="alert"
          className="pop-in flex items-start gap-1 px-1 text-sm font-medium text-critical"
        >
          <Icon name="error" className="mt-px text-[16px]" />
          {error}
        </p>
      )}
    </div>
  );
}

const CONTROL =
  "input-base block w-full rounded-xl border bg-card px-3.5 py-2.5 text-base text-strong placeholder:text-faint hover:border-faint";

export function Input({
  className,
  invalid,
  placeholder,
  ...props
}: React.InputHTMLAttributes<HTMLInputElement> & {
  invalid?: boolean;
  /** React 19 passes refs as props; declaring it lets a form focus this field. */
  ref?: React.Ref<HTMLInputElement>;
}) {
  return (
    <input
      aria-invalid={invalid || undefined}
      // A single space keeps :placeholder-shown meaningful, which is what
      // the floating label listens to.
      placeholder={placeholder ?? " "}
      className={cx(
        CONTROL,
        "min-h-11",
        invalid ? "border-critical" : "border-line-strong",
        className,
      )}
      {...props}
    />
  );
}

export function Textarea({
  className,
  invalid,
  placeholder,
  ...props
}: React.TextareaHTMLAttributes<HTMLTextAreaElement> & {
  invalid?: boolean;
  ref?: React.Ref<HTMLTextAreaElement>;
}) {
  return (
    <textarea
      aria-invalid={invalid || undefined}
      placeholder={placeholder ?? " "}
      className={cx(CONTROL, invalid ? "border-critical" : "border-line-strong", className)}
      {...props}
    />
  );
}

/** A native select with the brand's chevron. Keyboard and screen-reader
    behaviour stay the browser's own — that is the point of keeping it native. */
export function Select({
  className,
  invalid,
  children,
  ...props
}: React.SelectHTMLAttributes<HTMLSelectElement> & {
  invalid?: boolean;
  ref?: React.Ref<HTMLSelectElement>;
}) {
  return (
    <span className="relative block">
      <select
        aria-invalid={invalid || undefined}
        className={cx(
          CONTROL,
          "min-h-11 appearance-none pr-10",
          invalid ? "border-critical" : "border-line-strong",
          className,
        )}
        {...props}
      >
        {children}
      </select>
      <Icon
        name="expand_more"
        className="select-chevron pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[22px] text-muted"
      />
    </span>
  );
}

/** A checkbox that fills with the gradient and draws its tick. */
export function Checkbox({
  label,
  className,
  ...props
}: Omit<React.InputHTMLAttributes<HTMLInputElement>, "type"> & { label: ReactNode }) {
  return (
    <label className={cx("group inline-flex cursor-pointer items-start gap-3", className)}>
      <input type="checkbox" className="peer sr-only" {...props} />
      <span
        aria-hidden
        className="check-box mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-md border-2 border-line-strong bg-card transition-[border-color,background-color,box-shadow] duration-200 peer-checked:border-transparent peer-checked:bg-gradient-brand peer-focus-visible:shadow-focus group-hover:border-primary"
      >
        <svg viewBox="0 0 20 20" className="h-3.5 w-3.5" fill="none">
          <path
            d="M4 10.5 8.2 14.5 16 6.5"
            className="check-mark"
            stroke="#fff"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </span>
      <span className="text-sm text-strong">{label}</span>
    </label>
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
    info: "bg-info-soft text-info",
  } as const;

  return (
    // Pill-shaped, to distinguish a status from a clickable button.
    <span
      className={cx(
        "inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-semibold",
        tones[tone],
      )}
    >
      {children}
    </span>
  );
}

/** Segmented pill control — time ranges, filters, "24H / 7D / 30D". */
export function PillGroup<T extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (next: T) => void;
  label: string;
}) {
  return (
    <div role="group" aria-label={label} className="inline-flex rounded-full border border-line bg-sunken p-0.5">
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(option.value)}
            className={cx(
              "min-h-8 rounded-full px-3 text-xs font-semibold transition-[background-color,color,box-shadow] duration-200",
              "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary",
              active ? "bg-gradient-brand text-white shadow-sm" : "text-muted hover:text-strong",
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
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
          className="ecg-sweep stroke-accent-bright motion-reduce:hidden"
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
        <div key={index} className="rounded-2xl border border-line bg-card p-6 shadow-card">
          <div className="mb-5 flex items-start justify-between">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-11 w-11 rounded-xl" />
          </div>
          <Skeleton className="h-10 w-16" />
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
        <div className="border-b border-line px-6 py-5">
          <Skeleton className="h-5 w-40" />
          <Skeleton className="mt-2 h-3 w-64" />
        </div>
      )}
      <div className="divide-y divide-line px-6">
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

/** Table rows while they load — avatar circle and text bars, like the real thing. */
export function SkeletonTable({ rows = 5, columns = 4 }: { rows?: number; columns?: number }) {
  return (
    <div className="space-y-1 p-2" aria-hidden>
      <Skeleton className="h-9 w-full rounded-xl" />
      {Array.from({ length: rows }, (_, row) => (
        <div key={row} className="flex items-center gap-4 px-3 py-3">
          <Skeleton className="h-9 w-9 rounded-full" />
          {Array.from({ length: columns }, (_, column) => (
            <Skeleton key={column} className={cx("h-3.5", column === 0 ? "w-1/4" : "w-1/6")} />
          ))}
        </div>
      ))}
    </div>
  );
}

export function EmptyState({
  title,
  description,
  icon = "inbox",
  action,
}: {
  title: string;
  description?: string;
  /** A Material Symbol name. */
  icon?: string;
  action?: ReactNode;
}) {
  return (
    <div className="py-12 text-center">
      <span
        aria-hidden
        className="bg-gradient-soft animate-float mx-auto mb-4 grid h-16 w-16 place-items-center rounded-2xl text-primary"
      >
        <Icon name={icon} className="text-[32px]" />
      </span>
      <p className="font-display text-base font-bold text-strong">{title}</p>
      {description && (
        <p className="mx-auto mt-1 max-w-sm text-sm text-muted">{description}</p>
      )}
      {action && <div className="mt-5 flex justify-center">{action}</div>}
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
    <div role="alert" className="flex gap-3 rounded-2xl border border-critical/40 bg-critical-soft p-5">
      <Icon name="error" filled className="mt-0.5 shrink-0 text-[24px] text-critical" />
      <div>
        <p className="font-semibold text-critical">{title}</p>
        <p className="mt-1 text-sm text-strong">{message}</p>
        {onRetry && (
          <Button variant="secondary" className="mt-3" onClick={onRetry}>
            Try again
          </Button>
        )}
      </div>
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
