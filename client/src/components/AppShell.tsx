"use client";

import { AnimatePresence, LayoutGroup, MotionConfig, motion } from "framer-motion";
import dynamic from "next/dynamic";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { CommandPalette, type PaletteItem } from "@/components/CommandPalette";
import { Icon } from "@/components/Icon";
import { LanguageToggle } from "@/components/LanguageToggle";
import { NotificationBell } from "@/components/NotificationBell";
import { ThemeToggle } from "@/components/ThemeToggle";
import { CircuitNodes } from "@/components/brand/CircuitNodes";
import { Logo } from "@/components/brand/Logo";
import { useMotionPreference, useReadingPreferences } from "@/components/settings/preferences";
import { Avatar, Button, Loading, Unauthorized, cx } from "@/components/ui";
import { useTr } from "@/lib/lang";
import { homePathFor, useSession } from "@/lib/session";
import { doctorRequests, type Role } from "@/lib/api";
import { useAsync } from "@/lib/useAsync";

// Loaded only where it renders: the widget pulls in the whole conversation
// component, which the doctor and admin portals never need.
const AssistantWidget = dynamic(
  () => import("@/components/AssistantWidget").then((module) => module.AssistantWidget),
  { ssr: false },
);

interface NavItem {
  href: string;
  /** [English, Roman Urdu] — resolved by the language toggle at render. */
  label: [string, string];
  icon: string;
  /**
   * Names a counter this item shows as a badge. The rail fetches only the
   * counters its own role can see, so a patient's shell never asks the
   * administrator's endpoint anything.
   */
  badge?: "pendingDoctorApplications";
}

interface NavGroup {
  label: [string, string];
  items: NavItem[];
}

/**
 * Only routes that exist.
 *
 * A nav item that leads to a 404 reads as a broken product, not as a roadmap,
 * so links go in only when the page does. This table is also what the
 * breadcrumb and the command palette read: one list of destinations, three
 * places it is shown.
 *
 * The nurse entry is not an oversight. Nurses hold no standing access to
 * patient data, so there is no patient list to link to — emergency access is
 * the whole of what the role can reach (conflict C1), and there is no nurse
 * settings page to offer either.
 */
const NAV: Record<Role, NavGroup[]> = {
  PATIENT: [
    {
      label: ["Main", "Aam"],
      items: [
        { href: "/patient", label: ["Dashboard", "Dashboard"], icon: "dashboard" },
        { href: "/patient/appointments", label: ["Appointments", "Appointments"], icon: "calendar_today" },
        { href: "/patient/assistant", label: ["Health assistant", "Health assistant"], icon: "smart_toy" },
      ],
    },
    {
      label: ["Records", "Record"],
      items: [
        { href: "/patient/records", label: ["Medical records", "Medical record"], icon: "description" },
        { href: "/patient/documents", label: ["Documents", "Documents"], icon: "folder_open" },
        { href: "/patient/vitals", label: ["Vitals", "Vitals"], icon: "monitor_heart" },
      ],
    },
    {
      label: ["Account", "Account"],
      items: [
        { href: "/patient/billing", label: ["Billing", "Billing"], icon: "payments" },
        { href: "/patient/settings", label: ["Settings", "Settings"], icon: "settings" },
      ],
    },
  ],
  DOCTOR: [
    {
      label: ["Main", "Aam"],
      items: [{ href: "/doctor", label: ["Dashboard", "Dashboard"], icon: "dashboard" }],
    },
    {
      label: ["Care", "Ilaaj"],
      items: [
        { href: "/doctor/patients", label: ["My patients", "Mere mareez"], icon: "group" },
        { href: "/doctor/appointments", label: ["Appointments", "Appointments"], icon: "calendar_today" },
        { href: "/doctor/alerts", label: ["Alerts", "Alerts"], icon: "notifications_active" },
      ],
    },
    {
      label: ["Account", "Account"],
      items: [{ href: "/doctor/settings", label: ["Settings", "Settings"], icon: "settings" }],
    },
  ],
  ADMIN: [
    {
      label: ["Main", "Aam"],
      items: [{ href: "/admin", label: ["Dashboard", "Dashboard"], icon: "dashboard" }],
    },
    {
      label: ["Operations", "Intezam"],
      items: [
        { href: "/admin/appointments", label: ["Appointments", "Appointments"], icon: "calendar_today" },
        { href: "/admin/billing", label: ["Billing", "Billing"], icon: "payments" },
      ],
    },
    {
      label: ["Security", "Hifazat"],
      items: [
        {
          href: "/admin/doctor-requests",
          label: ["Doctor requests", "Doctor ki darkhwastein"],
          icon: "how_to_reg",
          badge: "pendingDoctorApplications",
        },
        { href: "/admin/emergency", label: ["Emergency access", "Emergency access"], icon: "e911_emergency" },
        { href: "/admin/audit", label: ["Audit trail", "Audit trail"], icon: "policy" },
      ],
    },
    {
      label: ["Account", "Account"],
      items: [{ href: "/admin/settings", label: ["Settings", "Settings"], icon: "settings" }],
    },
  ],
  NURSE: [
    {
      label: ["Main", "Aam"],
      items: [{ href: "/no-dashboard", label: ["Emergency access", "Emergency access"], icon: "e911_emergency" }],
    },
  ],
};

/** Where the rail's emergency button takes each role. Patients have none. */
const EMERGENCY_HREF: Partial<Record<Role, string>> = {
  NURSE: "/no-dashboard",
  DOCTOR: "/doctor/alerts",
  ADMIN: "/admin/emergency",
};

/** Roles with an account-settings screen. A nurse has none, so is offered none. */
const SETTINGS_HREF: Partial<Record<Role, string>> = {
  PATIENT: "/patient/settings",
  DOCTOR: "/doctor/settings",
  ADMIN: "/admin/settings",
};

const ROLE_LABEL: Record<Role, [string, string]> = {
  PATIENT: ["Patient", "Mareez"],
  DOCTOR: ["Doctor", "Doctor"],
  ADMIN: ["Administrator", "Admin"],
  NURSE: ["Nurse", "Nurse"],
};

/** The first crumb: whose portal this is. */
const PORTAL_LABEL: Record<Role, [string, string]> = {
  PATIENT: ["Patient portal", "Mareez ka portal"],
  DOCTOR: ["Doctor portal", "Doctor ka portal"],
  ADMIN: ["Administration", "Intezamia"],
  NURSE: ["Nurse portal", "Nurse ka portal"],
};

/**
 * One ramp, four anchors.
 *
 * Every role's active state is drawn from the same blue→azure→teal gradient;
 * what changes is where on it the role starts. A patient's portal reads teal, a
 * doctor's azure, an administrator's deep blue — so a glance at the rail says
 * which account is signed in without reading a word. Each text token carries
 * its own dark-mode value, which is what keeps the label readable on navy.
 */
const ROLE_ACCENT: Record<Role, { bar: string; text: string }> = {
  PATIENT: { bar: "bg-gradient-to-b from-accent-bright to-primary", text: "text-accent" },
  DOCTOR: { bar: "bg-gradient-to-b from-info to-accent-bright", text: "text-info dark:text-accent" },
  ADMIN: { bar: "bg-gradient-to-b from-primary to-accent-bright", text: "text-primary dark:text-accent" },
  NURSE: { bar: "bg-gradient-to-b from-primary to-accent-bright", text: "text-primary dark:text-accent" },
};

/**
 * How many doctor applications are waiting for a decision.
 *
 * Read from the list endpoint's own `meta.pending`, so the number in the rail
 * and the number on the page can never disagree. A failure resolves to zero
 * rather than throwing — a badge is not worth taking a portal down for.
 */
function usePendingDoctorApplications(role: Role): number {
  const { data } = useAsync(
    () =>
      role === "ADMIN"
        ? doctorRequests.list({ status: "SUBMITTED", limit: 1 }).catch(() => null)
        : Promise.resolve(null),
    [role],
  );
  return data?.meta.pending ?? 0;
}

const RAIL_KEY = "medisense:rail";
const SPRING = { type: "spring", stiffness: 420, damping: 34, mass: 0.8 } as const;

/** Seconds of warning the session provider gives before it signs you out. */
const WARNING_WINDOW_SECONDS = 30;

// ---------------------------------------------------------------------------
// Session time
// ---------------------------------------------------------------------------

/**
 * Warns before the server ends the session (R8).
 *
 * A courtesy, not a control — the server expires the session whether or not
 * this banner ever renders. Its job is to stop a clinician losing a
 * half-written note without warning, which is why the ring is decoration and
 * the sentence beside it is the message: the countdown has to be *read*, not
 * inferred from an arc.
 */
function InactivityWarning() {
  const { showWarning, secondsRemaining, stayAlive, signOut } = useSession();
  const tr = useTr();
  if (!showWarning || secondsRemaining === null) return null;

  const radius = 15;
  const circumference = 2 * Math.PI * radius;
  const left = Math.max(0, Math.min(1, secondsRemaining / WARNING_WINDOW_SECONDS));

  return (
    <div
      role="alertdialog"
      aria-live="assertive"
      aria-label="Session about to expire"
      className="border-b border-warning/40 bg-warning-soft px-4 py-3"
    >
      <div className="mx-auto flex max-w-[1400px] flex-wrap items-center gap-3">
        <span aria-hidden className="relative grid h-10 w-10 shrink-0 place-items-center">
          <svg viewBox="0 0 36 36" className="absolute inset-0 h-10 w-10 -rotate-90">
            <circle cx="18" cy="18" r={radius} fill="none" strokeWidth="3" className="stroke-warning/25" />
            <circle
              cx="18"
              cy="18"
              r={radius}
              fill="none"
              strokeWidth="3"
              strokeLinecap="round"
              className="stroke-warning"
              strokeDasharray={circumference}
              strokeDashoffset={circumference * (1 - left)}
              style={{ transition: "stroke-dashoffset 1s linear" }}
            />
          </svg>
          <span className="relative text-[12px] font-bold tabular-nums text-warning">
            {secondsRemaining}
          </span>
        </span>

        <p className="text-sm font-semibold text-warning">
          {tr("You will be signed out in", "Ghair-faal rehne par aap")}{" "}
          <span className="tabular-nums">{secondsRemaining}s</span>{" "}
          {tr("because of inactivity.", "mein sign out ho jayenge.")}
        </p>

        <div className="ml-auto flex gap-2">
          <Button size="md" onClick={stayAlive}>
            {tr("Stay signed in", "Signed in rahein")}
          </Button>
          <Button size="md" variant="secondary" onClick={() => void signOut()}>
            {tr("Sign out now", "Abhi sign out karein")}
          </Button>
        </div>
      </div>
    </div>
  );
}

/**
 * How much of the idle window is left, as a hairline under the header.
 *
 * Ambient rather than alarming: it is the same information the warning banner
 * gives thirty seconds before the end, shown continuously so nobody is
 * surprised by the banner either. Device classes exempt from idle expiry — a
 * ward monitor — have no window, so they get no line.
 */
function SessionMeter() {
  const { session, secondsRemaining } = useSession();
  const tr = useTr();
  const limit = session?.idleTimeoutSeconds ?? null;

  if (limit === null || limit <= 0) return null;
  // Full until the first tick lands, so the line never appears a second late
  // and nudges the whole page down two pixels.
  const left = secondsRemaining === null ? 1 : Math.max(0, Math.min(1, secondsRemaining / limit));

  return (
    <div
      aria-hidden
      title={tr("Time left in this session", "Is session mein bacha hua waqt")}
      className="h-0.5 w-full bg-line/50"
    >
      <span
        className="bg-gradient-brand block h-full transition-[width] duration-1000 ease-linear"
        style={{ width: `${left * 100}%` }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Breadcrumb
// ---------------------------------------------------------------------------

function humanise(segment: string): string {
  return segment.replace(/-/g, " ").replace(/^./, (character) => character.toUpperCase());
}

/**
 * Where you are, built from the path and named from the nav table.
 *
 * Deriving the labels from `NAV` rather than from the URL is what keeps the
 * breadcrumb bilingual and in the product's own words — "Mareez ka portal /
 * Appointments", not "patient / appointments". A segment the table does not
 * know (a record id) is shown as a detail rather than as a hash.
 */
function Breadcrumb({ role, pathname }: { role: Role; pathname: string }) {
  const tr = useTr();
  const segments = pathname.split("/").filter(Boolean);
  const flat = NAV[role]?.flatMap((group) => group.items) ?? [];
  const home = homePathFor(role);

  const crumbs: { href: string; label: string }[] = [];
  let href = "";
  for (const [index, segment] of segments.entries()) {
    href += `/${segment}`;
    if (href === home) continue; // the portal root is the first crumb already
    const known = flat.find((item) => item.href === href);
    const isIdish = index > 0 && (segment.length > 12 || /\d/.test(segment));
    crumbs.push({
      href,
      label: known ? tr(...known.label) : isIdish ? tr("Detail", "Tafseel") : humanise(segment),
    });
  }

  const here = flat.find((item) => item.href === home);

  return (
    <nav aria-label="Breadcrumb" className="hidden min-w-0 lg:block">
      <ol className="flex min-w-0 items-center gap-1.5 text-sm">
        <li className="min-w-0">
          <Link
            href={home}
            className="truncate rounded text-muted transition-colors hover:text-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
          >
            {tr(...PORTAL_LABEL[role])}
          </Link>
        </li>
        {crumbs.length === 0 && here && (
          <li className="flex min-w-0 items-center gap-1.5">
            <Icon name="chevron_right" className="text-[16px] text-faint" />
            <span aria-current="page" className="truncate font-semibold text-strong">
              {tr(...here.label)}
            </span>
          </li>
        )}
        {crumbs.map((crumb, index) => {
          const last = index === crumbs.length - 1;
          return (
            <li key={crumb.href} className="flex min-w-0 items-center gap-1.5">
              <Icon name="chevron_right" className="shrink-0 text-[16px] text-faint" />
              {last ? (
                <span aria-current="page" className="truncate font-semibold text-strong">
                  {crumb.label}
                </span>
              ) : (
                <Link
                  href={crumb.href}
                  className="truncate rounded text-muted transition-colors hover:text-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                >
                  {crumb.label}
                </Link>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

// ---------------------------------------------------------------------------
// Account menu
// ---------------------------------------------------------------------------

/**
 * The role, set in the brand ramp on its own soft ground.
 *
 * Two elements rather than one: `background-clip: text` needs the gradient to
 * be *the* background of the element it paints, so the tinted ground has to sit
 * on a parent or it is simply overwritten.
 */
function RoleChip({ role, className }: { role: Role; className?: string }) {
  const tr = useTr();
  return (
    <span className={cx("bg-gradient-soft inline-flex rounded-full px-2 py-px", className)}>
      <span className="text-gradient-brand text-[10.5px] font-bold uppercase tracking-wider">
        {tr(...ROLE_LABEL[role])}
      </span>
    </span>
  );
}

/**
 * Who you are, and the four things you can do about it.
 *
 * Not `role="menu"`: the panel holds links *and* a theme switch, and a switch
 * announced as a menu item is a switch a screen-reader user cannot operate.
 * A labelled group of real controls is both simpler and more honest — Tab
 * moves, Escape closes, and focus goes back to the trigger.
 */
function AccountMenu({
  user,
  onSignOut,
  onNavigate,
  variant,
  collapsed = false,
}: {
  user: { name: string; email: string; role: Role };
  onSignOut: () => void;
  onNavigate?: () => void;
  /** `card` is the rail's foot (opens upward); `avatar` is the header. */
  variant: "card" | "avatar";
  collapsed?: boolean;
}) {
  const tr = useTr();
  const [open, setOpen] = useState(false);
  const shell = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const settingsHref = SETTINGS_HREF[user.role];

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: globalThis.MouseEvent) => {
      if (shell.current && !shell.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      trigger.current?.focus();
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const close = () => {
    setOpen(false);
    onNavigate?.();
  };

  const itemClass =
    "flex min-h-11 w-full items-center gap-2.5 rounded-xl px-3 text-sm font-semibold text-strong transition-colors hover:bg-gradient-soft hover:text-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary";

  return (
    <div ref={shell} className="relative">
      <button
        ref={trigger}
        type="button"
        aria-haspopup="true"
        aria-expanded={open}
        aria-label={tr("Account menu", "Account menu")}
        onClick={() => setOpen((value) => !value)}
        title={collapsed ? `${user.name} · ${tr(...ROLE_LABEL[user.role])}` : undefined}
        className={cx(
          "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary",
          variant === "card"
            ? cx(
                "bg-gradient-soft hover-lift-sm flex w-full items-center gap-3 rounded-2xl border border-line/70 p-3 text-left",
                collapsed && "justify-center p-2",
              )
            : "flex items-center gap-2.5 rounded-full p-1 pr-2 transition-[background-color,transform] hover:scale-[1.02] hover:bg-gradient-soft",
        )}
      >
        {/* A 2px gradient ring: the one place the brand touches a person's own
            initials, so the card reads as *theirs* rather than as a row. */}
        <span aria-hidden className="bg-gradient-brand grid shrink-0 place-items-center rounded-full p-[2px]">
          <Avatar name={user.name} size="sm" />
        </span>

        {variant === "card" && !collapsed && (
          <span className="min-w-0">
            <span className="block truncate text-sm font-semibold text-strong">{user.name}</span>
            <RoleChip role={user.role} className="mt-0.5" />
          </span>
        )}
        {variant === "avatar" && (
          <span className="hidden text-left sm:block">
            <span className="block max-w-[10rem] truncate text-sm font-semibold text-strong">
              {user.name}
            </span>
            <span className="block text-[11px] text-faint">{tr(...ROLE_LABEL[user.role])}</span>
          </span>
        )}
        <Icon
          name="expand_more"
          className={cx(
            "text-[20px] text-faint transition-transform",
            variant === "card" ? (collapsed ? "hidden" : "ml-auto") : "hidden sm:block",
            open && "rotate-180",
          )}
        />
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            role="group"
            aria-label={tr("Account", "Account")}
            initial={{ opacity: 0, scale: 0.94, y: variant === "card" ? 6 : -6 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: variant === "card" ? 4 : -4 }}
            transition={SPRING}
            style={{ transformOrigin: variant === "card" ? "bottom left" : "top right" }}
            className={cx(
              "glass absolute z-50 w-64 rounded-2xl p-2",
              variant === "card" ? "bottom-full left-0 mb-2" : "right-0 mt-2",
            )}
          >
            <div className="bg-gradient-soft flex items-center gap-3 rounded-xl p-3">
              <Avatar name={user.name} />
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-strong">{user.name}</p>
                <p className="truncate text-xs text-muted">{user.email}</p>
                <RoleChip role={user.role} className="mt-1" />
              </div>
            </div>

            {settingsHref && (
              <>
                <Link href={`${settingsHref}#profile`} onClick={close} className={cx(itemClass, "mt-1")}>
                  <Icon name="person" className="text-[20px]" />
                  {tr("Profile", "Profile")}
                </Link>
                <Link href={settingsHref} onClick={close} className={itemClass}>
                  <Icon name="settings" className="text-[20px]" />
                  {tr("Account settings", "Account settings")}
                </Link>
              </>
            )}

            <div className="mt-1 flex min-h-11 items-center justify-between gap-2 rounded-xl px-3">
              <span className="flex items-center gap-2.5 text-sm font-semibold text-strong">
                <Icon name="contrast" className="text-[20px]" />
                {tr("Theme", "Theme")}
              </span>
              <ThemeToggle />
            </div>

            <div aria-hidden className="my-1 h-px bg-line/70" />

            <button
              type="button"
              onClick={onSignOut}
              className="flex min-h-11 w-full items-center gap-2.5 rounded-xl px-3 text-sm font-semibold text-strong transition-colors hover:bg-critical-soft hover:text-critical focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
            >
              <Icon name="logout" className="text-[20px]" />
              {tr("Sign out", "Sign out")}
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The rail
// ---------------------------------------------------------------------------

/**
 * The navigation rail.
 *
 * Light and quiet, so the content's colour space stays the content's. The
 * active item is marked three ways at once — a gradient edge, a filled icon,
 * and a tinted ground that *slides* to the new item on navigation — so it
 * survives a colour-blind reader, a bad monitor, and a glance.
 */
function Rail({
  groups,
  pathname,
  emergencyHref,
  user,
  collapsed = false,
  onToggle,
  onNavigate,
  onSignOut,
  layoutId,
  pendingApplications = 0,
}: {
  groups: NavGroup[];
  pathname: string;
  emergencyHref?: string;
  user: { name: string; email: string; role: Role };
  collapsed?: boolean;
  onToggle?: () => void;
  onNavigate?: () => void;
  onSignOut: () => void;
  layoutId: string;
  /** Fetched once by the shell; the rail renders twice and must not refetch. */
  pendingApplications?: number;
}) {
  const tr = useTr();
  const accent = ROLE_ACCENT[user.role];

  const collapseButton = onToggle && (
    <button
      type="button"
      aria-label={
        collapsed
          ? tr("Expand navigation", "Navigation kholein")
          : tr("Collapse navigation", "Navigation samait dein")
      }
      aria-expanded={!collapsed}
      onClick={onToggle}
      className={cx(
        "grid h-9 w-9 shrink-0 place-items-center rounded-full text-faint transition-colors",
        "hover:bg-gradient-soft hover:text-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary",
        collapsed && "mx-auto mb-3",
      )}
    >
      <Icon
        name="chevron_left"
        className={cx("text-[22px] transition-transform duration-300", collapsed && "rotate-180")}
      />
    </button>
  );

  return (
    // The brand link sits outside the <nav> landmark on purpose. It is chrome —
    // a way back to the public site — not one of this role's destinations.
    //
    // Not `overflow-hidden`: the collapsed tooltips and the account dropdown are
    // both wider than the rail and have to escape it. The one thing that does
    // need clipping — the circuit field — clips itself.
    <div className="relative flex h-full flex-col">
      <div className={cx("flex items-center py-5", collapsed ? "justify-center px-3" : "justify-between px-4")}>
        <Link
          href="/"
          onClick={onNavigate}
          className="rounded-lg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
        >
          <Logo variant={collapsed ? "mark" : "full"} size={collapsed ? "sm" : "md"} />
        </Link>
        {!collapsed && collapseButton}
      </div>

      {collapsed && collapseButton}

      {emergencyHref && (
        <div className={cx("mb-4", collapsed ? "px-3" : "px-4")}>
          {/* The one red thing in the rail — the fastest route to the screen
              somebody needs when there is no time to navigate. */}
          <Link
            href={emergencyHref}
            onClick={onNavigate}
            title={tr("Emergency access", "Emergency access")}
            className="group flex min-h-11 w-full items-center justify-center gap-2 rounded-xl bg-critical text-sm font-bold text-white shadow-md transition-[transform,opacity] hover:scale-[1.03] hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-critical"
          >
            <Icon name="warning" filled className="icon-wiggle text-[20px]" />
            {!collapsed && tr("Emergency access", "Emergency access")}
          </Link>
        </div>
      )}

      <nav aria-label="Main" className="relative min-h-0 flex-1 overflow-y-auto px-3">
        <LayoutGroup id={layoutId}>
          {groups.map((group) => (
            <div key={group.label[0]} className="mb-4">
              {!collapsed ? (
                <p className="mono-caps mb-1.5 px-3 text-[0.68rem] text-faint">
                  {tr(...group.label)}
                </p>
              ) : (
                <div aria-hidden className="mx-3 mb-2 h-px bg-line" />
              )}
              <ul className="space-y-0.5">
                {group.items.map((item) => {
                  const active = pathname === item.href;
                  return (
                    <li key={item.href} className="relative">
                      {active && (
                        <motion.span
                          layoutId={`${layoutId}-active`}
                          transition={SPRING}
                          aria-hidden
                          className="bg-gradient-soft absolute inset-0 rounded-xl"
                        >
                          <span
                            className={cx(
                              "absolute inset-y-1.5 left-0 w-[3px] rounded-r-full",
                              accent.bar,
                            )}
                          />
                        </motion.span>
                      )}
                      <Link
                        href={item.href}
                        aria-current={active ? "page" : undefined}
                        onClick={onNavigate}
                        title={collapsed ? tr(...item.label) : undefined}
                        className={cx(
                          "group relative flex min-h-11 items-center gap-3 rounded-xl py-2.5 text-[0.9375rem] transition-[color,background-color] duration-200",
                          "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary",
                          collapsed ? "justify-center px-0" : "px-3.5",
                          active
                            ? cx("font-semibold", accent.text)
                            : "font-medium text-muted hover:bg-sunken hover:text-strong",
                        )}
                      >
                        <Icon name={item.icon} filled={active} className="icon-wiggle text-[20px]" />
                        {!collapsed && <span className="truncate">{tr(...item.label)}</span>}
                        {item.badge === "pendingDoctorApplications" && pendingApplications > 0 && (
                          <span
                            className={cx(
                              "bg-gradient-brand ml-auto rounded-full px-2 py-0.5 text-[11px] font-bold tabular-nums text-white shadow-sm",
                              collapsed &&
                                "absolute right-1 top-1 ml-0 px-1.5 py-0 text-[10px] leading-4",
                            )}
                          >
                            {pendingApplications}
                            <span className="sr-only">
                              {" "}
                              {tr("awaiting review", "review ke muntazir")}
                            </span>
                          </span>
                        )}
                        {collapsed && (
                          // Tooltip: appears beside the icon on hover and focus.
                          <span
                            role="presentation"
                            className="pointer-events-none absolute left-full top-1/2 z-50 ml-3 -translate-y-1/2 whitespace-nowrap rounded-lg bg-strong px-2.5 py-1.5 text-xs font-semibold text-card opacity-0 shadow-overlay transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
                          >
                            {tr(...item.label)}
                          </span>
                        )}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </LayoutGroup>
      </nav>

      {/* Who is signed in, at the foot of the rail where the eye checks it
          last — the same place every desk-side terminal puts it. The circuit
          field behind is the logo's own motif, faded out upward so it never
          competes with the navigation above it. The bottom padding is for the
          dev-mode badge, which otherwise sits on top of the card. */}
      <div className={cx("relative mt-2 pb-12 pt-6", collapsed ? "px-3" : "px-4")}>
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 overflow-hidden"
          style={{
            maskImage: "linear-gradient(to top, black 40%, transparent)",
            WebkitMaskImage: "linear-gradient(to top, black 40%, transparent)",
          }}
        >
          <CircuitNodes density="low" />
        </div>

        <div className="relative">
          <AccountMenu
            user={user}
            variant="card"
            collapsed={collapsed}
            onSignOut={onSignOut}
            onNavigate={onNavigate}
          />
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The shell
// ---------------------------------------------------------------------------

/**
 * Guards a page and renders the chrome around it.
 *
 * The role check here decides what to *render*. It is not authorization — the
 * API re-checks every request server-side, and a user who edits their way past
 * this still gets a 403 (spec §34).
 */
export function AppShell({ role, children }: { role: Role; children: ReactNode }) {
  const { user, loading, signOut } = useSession();
  const tr = useTr();
  const pathname = usePathname();
  const router = useRouter();
  const motionPreference = useMotionPreference();
  // Installed here rather than in the tree below, so the stored text size holds
  // through the session check too — a reader with large text should not watch
  // the page resize under them once it finishes.
  useReadingPreferences();
  const [railOpen, setRailOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);

  useEffect(() => {
    if (!loading && !user) router.replace("/login");
  }, [loading, user, router]);

  // The remembered rail width. Read after mount so the server and the first
  // client render agree; a one-frame expand is preferable to a mismatch.
  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(RAIL_KEY);
      if (stored === "collapsed") {
        const frame = requestAnimationFrame(() => setCollapsed(true));
        return () => cancelAnimationFrame(frame);
      }
    } catch {
      // Storage blocked: the rail simply starts open.
    }
  }, []);

  // ⌘K / Ctrl-K, the shortcut every palette in every tool uses.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen((value) => !value);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const groups = useMemo(() => (user ? (NAV[user.role] ?? []) : []), [user]);
  // Hooks run before the role guard below, so this is called unconditionally
  // and only actually fetches for an administrator.
  const pendingApplications = usePendingDoctorApplications(user?.role ?? "PATIENT");
  const paletteItems = useMemo<PaletteItem[]>(
    () =>
      groups.flatMap((group) =>
        group.items.map((item) => ({
          href: item.href,
          icon: item.icon,
          label: tr(...item.label),
          section: tr(...group.label),
        })),
      ),
    [groups, tr],
  );

  const toggleRail = () => {
    setCollapsed((current) => {
      const next = !current;
      try {
        window.localStorage.setItem(RAIL_KEY, next ? "collapsed" : "open");
      } catch {
        // Not remembered, still applied.
      }
      return next;
    });
  };

  if (loading) {
    return (
      <main className="mx-auto max-w-6xl px-4 py-16">
        <Loading label={tr("Checking your session", "Aap ka session check ho raha hai")} />
      </main>
    );
  }

  if (!user) return null; // redirecting

  if (user.role !== role) {
    return (
      <main className="mx-auto max-w-2xl px-4 py-16">
        <Unauthorized
          message={tr(
            `This area is for ${role.toLowerCase()}s. Your account is signed in as ${user.role.toLowerCase()}.`,
            `Yeh hissa sirf ${role.toLowerCase()} ke liye hai. Aap ${user.role.toLowerCase()} ke taur par signed in hain.`,
          )}
        />
        <Button className="mt-4" onClick={() => router.replace(homePathFor(user.role))}>
          {tr("Go to your dashboard", "Apne dashboard par jayein")}
        </Button>
      </main>
    );
  }

  const emergencyHref = EMERGENCY_HREF[user.role];
  const searchLabel = tr("Search pages", "Safhaat mein dhoondein");

  return (
    // A person who has asked for less motion gets it from Framer too, not only
    // from the CSS: the springs in this shell are not stylesheet transitions.
    <MotionConfig reducedMotion={motionPreference === "reduced" ? "always" : "user"}>
      <div className="flex min-h-screen">
        {/* Desktop rail — sticky, so a long table never scrolls navigation out
            of reach. Its width animates rather than snapping. */}
        <motion.aside
          initial={false}
          animate={{ width: collapsed ? 84 : 264 }}
          transition={{ type: "spring", stiffness: 300, damping: 32 }}
          // `z-30`: the account card's dropdown opens out over the page, and
          // the frosted rail is its own stacking context — without this it
          // would be painted under any positioned element in the content.
          className="sticky top-0 z-30 hidden h-screen shrink-0 border-r border-line bg-card/85 shadow-card backdrop-blur-xl lg:block"
        >
          <Rail
            groups={groups}
            pathname={pathname}
            emergencyHref={emergencyHref}
            user={user}
            collapsed={collapsed}
            onToggle={toggleRail}
            onSignOut={() => void signOut()}
            layoutId="rail"
            pendingApplications={pendingApplications}
          />
        </motion.aside>

        {/* Mobile rail — a drawer, because 260px of a phone is most of it. */}
        <AnimatePresence>
          {railOpen && (
            <div className="fixed inset-0 z-50 lg:hidden">
              <motion.button
                type="button"
                aria-label="Close navigation"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="absolute inset-0 bg-[#0A1128]/55 backdrop-blur-sm"
                onClick={() => setRailOpen(false)}
              />
              <motion.aside
                initial={{ x: -280 }}
                animate={{ x: 0 }}
                exit={{ x: -280 }}
                transition={{ type: "spring", stiffness: 380, damping: 36 }}
                className="relative h-full w-[268px] max-w-[85%] bg-card shadow-overlay"
              >
                <Rail
                  groups={groups}
                  pathname={pathname}
                  emergencyHref={emergencyHref}
                  user={user}
                  onNavigate={() => setRailOpen(false)}
                  onSignOut={() => void signOut()}
                  layoutId="drawer"
                  pendingApplications={pendingApplications}
                />
              </motion.aside>
            </div>
          )}
        </AnimatePresence>

        <div className="flex min-w-0 flex-1 flex-col">
          {/* One sticky stack: the warning, the bar, and the time left. They
              share a top edge, so nothing ever slides underneath anything. */}
          <div className="sticky top-0 z-40">
            <InactivityWarning />

            <header className="glass flex h-16 items-center gap-3 rounded-none border-x-0 border-t-0 border-b border-line/80 px-4 !shadow-none sm:px-6">
              <div className="flex min-w-0 flex-1 items-center gap-3">
                <button
                  type="button"
                  aria-label="Open navigation"
                  aria-expanded={railOpen}
                  className="grid h-10 w-10 shrink-0 place-items-center rounded-full text-muted transition-colors hover:bg-gradient-soft hover:text-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary lg:hidden"
                  onClick={() => setRailOpen(true)}
                >
                  <Icon name="menu" />
                </button>
                <Link href="/" className="shrink-0 lg:hidden">
                  <Logo variant="mark" size="sm" />
                </Link>
                <Breadcrumb role={user.role} pathname={pathname} />
              </div>

              {/* Search. A button dressed as a field: there is nothing to type
                  into until the palette is open, and a field that silently
                  discards the first keystroke is worse than a button. */}
              <div className="hidden shrink-0 md:block md:w-[min(20rem,30vw)]">
                <button
                  type="button"
                  onClick={() => setPaletteOpen(true)}
                  aria-keyshortcuts="Control+K Meta+K"
                  className="flex h-9 w-full items-center gap-2 rounded-full border border-line-strong bg-sunken/60 px-3 text-sm text-faint transition-colors hover:border-primary/40 hover:text-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                >
                  <Icon name="search" className="shrink-0 text-[18px]" />
                  <span className="truncate">{searchLabel}</span>
                  <kbd className="mono-caps ml-auto shrink-0 rounded-md border border-line-strong bg-card px-1.5 py-0.5 text-[10px] text-faint">
                    ⌘K
                  </kbd>
                </button>
              </div>

              <div className="flex min-w-0 flex-1 items-center justify-end gap-1.5 sm:gap-2">
                <button
                  type="button"
                  aria-label={searchLabel}
                  onClick={() => setPaletteOpen(true)}
                  className="hidden h-10 w-10 place-items-center rounded-full text-muted transition-colors hover:bg-gradient-soft hover:text-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary sm:grid md:hidden"
                >
                  <Icon name="search" />
                </button>
                {/* Language stays on the bar at every width — it is the one
                    control a reader may need before they can read the menu that
                    would otherwise hold it. Theme is in the account menu. */}
                <div className="shrink-0">
                  <LanguageToggle />
                </div>
                <div className="hidden shrink-0 sm:block">
                  <ThemeToggle />
                </div>
                <NotificationBell role={user.role} />
                <AccountMenu user={user} variant="avatar" onSignOut={() => void signOut()} />
              </div>
            </header>

            <SessionMeter />
          </div>

          <main id="main" className="mx-auto w-full max-w-[1400px] flex-1 px-4 py-6 sm:px-8 sm:py-8">
            {children}
          </main>
        </div>

        {user.role === "PATIENT" && pathname !== "/patient/assistant" && <AssistantWidget />}

        <CommandPalette
          open={paletteOpen}
          onClose={() => setPaletteOpen(false)}
          items={paletteItems}
        />
      </div>
    </MotionConfig>
  );
}
