"use client";

import { AnimatePresence, LayoutGroup, motion } from "framer-motion";
import dynamic from "next/dynamic";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { Icon } from "@/components/Icon";
import { LanguageToggle } from "@/components/LanguageToggle";
import { Logo, LogoMark } from "@/components/Logo";
import { NotificationBell } from "@/components/NotificationBell";
import { Avatar, Button, Loading, Unauthorized, cx } from "@/components/ui";
import { useTr } from "@/lib/lang";
import { homePathFor, useSession } from "@/lib/session";
import type { Role } from "@/lib/api";

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
}

interface NavGroup {
  label: [string, string];
  items: NavItem[];
}

/**
 * Only routes that exist.
 *
 * A nav item that leads to a 404 reads as a broken product, not as a roadmap,
 * so links go in only when the page does.
 *
 * The nurse entry is not an oversight. Nurses hold no standing access to
 * patient data, so there is no patient list to link to — emergency access is
 * the whole of what the role can reach (conflict C1).
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
      items: [{ href: "/patient/billing", label: ["Billing", "Billing"], icon: "payments" }],
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
        { href: "/admin/emergency", label: ["Emergency access", "Emergency access"], icon: "e911_emergency" },
        { href: "/admin/audit", label: ["Audit trail", "Audit trail"], icon: "policy" },
      ],
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

const ROLE_LABEL: Record<Role, [string, string]> = {
  PATIENT: ["Patient", "Mareez"],
  DOCTOR: ["Doctor", "Doctor"],
  ADMIN: ["Administrator", "Admin"],
  NURSE: ["Nurse", "Nurse"],
};

/** Each role wears its own tint, so who is signed in reads at a glance. */
const ROLE_TINT: Record<Role, string> = {
  PATIENT: "bg-gradient-to-r from-[#14C7C0]/20 to-[#5EEAD4]/20 text-accent",
  DOCTOR: "bg-gradient-to-r from-[#1B4FE0]/15 to-[#3B82F6]/15 text-primary",
  ADMIN: "bg-gradient-to-r from-[#F5A524]/20 to-[#fbd27a]/20 text-warning",
  NURSE: "bg-gradient-to-r from-[#E5484D]/15 to-[#ff9a9e]/15 text-critical",
};

const RAIL_KEY = "medisense:rail";
const SPRING = { type: "spring", stiffness: 420, damping: 34, mass: 0.8 } as const;

/**
 * Warns before the server ends the session (R8).
 *
 * A courtesy, not a control — the server expires the session whether or not
 * this banner ever renders. Its job is to stop a clinician losing a
 * half-written note without warning.
 */
function InactivityWarning() {
  const { showWarning, secondsRemaining, stayAlive, signOut } = useSession();
  const tr = useTr();
  if (!showWarning || secondsRemaining === null) return null;

  return (
    <div
      role="alertdialog"
      aria-live="assertive"
      aria-label="Session about to expire"
      className="edge-pulse sticky top-0 z-50 border-b border-warning/40 bg-warning-soft px-4 py-3"
    >
      <div className="mx-auto flex max-w-[1400px] flex-wrap items-center gap-3">
        <Icon name="timer" className="text-[20px] text-warning" />
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
  layoutId,
}: {
  groups: NavGroup[];
  pathname: string;
  emergencyHref?: string;
  user: { name: string; role: Role };
  collapsed?: boolean;
  onToggle?: () => void;
  onNavigate?: () => void;
  layoutId: string;
}) {
  const tr = useTr();
  return (
    // The brand link sits outside the <nav> landmark on purpose. It is chrome —
    // a way back to the public site — not one of this role's destinations.
    <div className="relative flex h-full flex-col overflow-hidden">
      <div aria-hidden className="circuit-pattern-light pointer-events-none absolute inset-x-0 bottom-0 h-64" />

      <div className={cx("flex items-center py-5", collapsed ? "justify-center px-3" : "justify-between px-5")}>
        <Link
          href="/"
          onClick={onNavigate}
          className="rounded-lg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
        >
          {collapsed ? <LogoMark className="h-8 w-auto" /> : <Logo size="md" />}
        </Link>
        {onToggle && !collapsed && (
          <button
            type="button"
            aria-label={tr("Collapse navigation", "Navigation samait dein")}
            onClick={onToggle}
            className="grid h-9 w-9 place-items-center rounded-full text-faint transition-colors hover:bg-gradient-soft hover:text-primary focus-visible:outline-2 focus-visible:outline-primary"
          >
            <Icon name="left_panel_close" className="text-[20px]" />
          </button>
        )}
      </div>

      {onToggle && collapsed && (
        <button
          type="button"
          aria-label={tr("Expand navigation", "Navigation kholein")}
          onClick={onToggle}
          className="mx-auto mb-3 grid h-9 w-9 place-items-center rounded-full text-faint transition-colors hover:bg-gradient-soft hover:text-primary focus-visible:outline-2 focus-visible:outline-primary"
        >
          <Icon name="left_panel_open" className="text-[20px]" />
        </button>
      )}

      {emergencyHref && (
        <div className={cx("mb-4", collapsed ? "px-3" : "px-4")}>
          {/* The one red thing in the rail — the fastest route to the screen
              somebody needs when there is no time to navigate. */}
          <Link
            href={emergencyHref}
            onClick={onNavigate}
            title={tr("Emergency access", "Emergency access")}
            className={cx(
              "group flex min-h-11 w-full items-center justify-center gap-2 rounded-xl bg-critical text-sm font-bold text-white shadow-md transition-[transform,opacity] hover:scale-[1.03] hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-critical",
            )}
          >
            <Icon name="warning" filled className="icon-wiggle text-[20px]" />
            {!collapsed && tr("Emergency access", "Emergency access")}
          </Link>
        </div>
      )}

      <nav aria-label="Main" className={cx("relative min-h-0 flex-1 overflow-y-auto", collapsed ? "px-3" : "px-3")}>
        <LayoutGroup id={layoutId}>
          {groups.map((group) => (
            <div key={group.label[0]} className="mb-4">
              {!collapsed ? (
                <p className="mb-1.5 px-3 text-[10.5px] font-bold uppercase tracking-[0.16em] text-faint">
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
                          <span className="bg-gradient-brand absolute bottom-2 left-0 top-2 w-1 rounded-r-full" />
                        </motion.span>
                      )}
                      <Link
                        href={item.href}
                        aria-current={active ? "page" : undefined}
                        onClick={onNavigate}
                        title={collapsed ? tr(...item.label) : undefined}
                        className={cx(
                          "group relative flex min-h-11 items-center gap-3 rounded-xl py-2.5 text-sm transition-[color,background-color] duration-200",
                          "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary",
                          collapsed ? "justify-center px-0" : "px-3.5",
                          active
                            ? "font-bold text-primary"
                            : "font-medium text-muted hover:bg-sunken/70 hover:text-strong",
                        )}
                      >
                        <Icon name={item.icon} filled={active} className="icon-wiggle text-[21px]" />
                        {!collapsed && <span className="truncate">{tr(...item.label)}</span>}
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
          last — the same place every desk-side terminal puts it. */}
      <div className={cx("relative mt-2 mb-4", collapsed ? "px-3" : "px-4")}>
        <div
          className={cx(
            "bg-gradient-soft flex items-center gap-3 rounded-2xl border border-line/70 p-3",
            collapsed && "justify-center p-2",
          )}
          title={collapsed ? `${user.name} · ${tr(...ROLE_LABEL[user.role])}` : undefined}
        >
          <Avatar name={user.name} size="sm" />
          {!collapsed && (
            <span className="min-w-0">
              <span className="block truncate text-sm font-semibold text-strong">{user.name}</span>
              <span
                className={cx(
                  "mt-0.5 inline-block rounded-full px-2 py-px text-[10.5px] font-bold uppercase tracking-wider",
                  ROLE_TINT[user.role],
                )}
              >
                {tr(...ROLE_LABEL[user.role])}
              </span>
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

/** The avatar menu in the header: who you are, and the way out. */
function ProfileMenu({
  user,
  onSignOut,
}: {
  user: { name: string; email: string; role: Role };
  onSignOut: () => void;
}) {
  const tr = useTr();
  const [open, setOpen] = useState(false);
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: globalThis.MouseEvent) => {
      if (panel.current && !panel.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={panel} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={tr("Account menu", "Account menu")}
        onClick={() => setOpen((value) => !value)}
        className="flex items-center gap-2.5 rounded-full p-1 pr-2 transition-[background-color,transform] hover:bg-gradient-soft hover:scale-[1.02] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
      >
        <Avatar name={user.name} size="sm" />
        <span className="hidden text-left sm:block">
          <span className="block max-w-[10rem] truncate text-sm font-semibold text-strong">{user.name}</span>
          <span className="block text-[11px] text-faint">{tr(...ROLE_LABEL[user.role])}</span>
        </span>
        <Icon
          name="expand_more"
          className={cx("hidden text-[20px] text-faint transition-transform sm:block", open && "rotate-180")}
        />
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            role="menu"
            initial={{ opacity: 0, scale: 0.92, y: -6 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: -4 }}
            transition={SPRING}
            style={{ transformOrigin: "top right" }}
            className="glass absolute right-0 z-50 mt-2 w-64 rounded-2xl p-2"
          >
            <div className="flex items-center gap-3 rounded-xl bg-gradient-soft p-3">
              <Avatar name={user.name} />
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-strong">{user.name}</p>
                <p className="truncate text-xs text-muted">{user.email}</p>
                <span
                  className={cx(
                    "mt-1 inline-block rounded-full px-2 py-px text-[10.5px] font-bold uppercase tracking-wider",
                    ROLE_TINT[user.role],
                  )}
                >
                  {tr(...ROLE_LABEL[user.role])}
                </span>
              </div>
            </div>
            <button
              type="button"
              role="menuitem"
              onClick={onSignOut}
              className="mt-1 flex min-h-11 w-full items-center gap-2 rounded-xl px-3 text-sm font-semibold text-strong transition-colors hover:bg-critical-soft hover:text-critical focus-visible:outline-2 focus-visible:outline-primary"
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
  const [railOpen, setRailOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);

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

  const groups = NAV[user.role] ?? [];
  const emergencyHref = EMERGENCY_HREF[user.role];

  return (
    <div className="flex min-h-screen">
      {/* Desktop rail — sticky, so a long table never scrolls navigation out of
          reach. Its width animates rather than snapping. */}
      <motion.aside
        initial={false}
        animate={{ width: collapsed ? 84 : 264 }}
        transition={{ type: "spring", stiffness: 300, damping: 32 }}
        className="sticky top-0 hidden h-screen shrink-0 border-r border-line bg-card/85 shadow-card backdrop-blur-xl lg:block"
      >
        <Rail
          groups={groups}
          pathname={pathname}
          emergencyHref={emergencyHref}
          user={user}
          collapsed={collapsed}
          onToggle={toggleRail}
          layoutId="rail"
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
                layoutId="drawer"
              />
            </motion.aside>
          </div>
        )}
      </AnimatePresence>

      <div className="flex min-w-0 flex-1 flex-col">
        <InactivityWarning />

        <header className="glass sticky top-0 z-30 flex h-16 items-center gap-3 rounded-none border-x-0 border-t-0 border-b border-line/80 px-4 !shadow-none sm:px-8">
          <button
            type="button"
            aria-label="Open navigation"
            aria-expanded={railOpen}
            className="grid h-10 w-10 place-items-center rounded-full text-muted transition-colors hover:bg-gradient-soft hover:text-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary lg:hidden"
            onClick={() => setRailOpen(true)}
          >
            <Icon name="menu" />
          </button>
          <Link href="/" className="lg:hidden">
            <Logo size="sm" />
          </Link>

          <div className="ml-auto flex items-center gap-1.5 sm:gap-2">
            <LanguageToggle />
            <NotificationBell role={user.role} />
            <ProfileMenu user={user} onSignOut={() => void signOut()} />
          </div>
        </header>

        <main className="mx-auto w-full max-w-[1400px] flex-1 px-4 py-6 sm:px-8 sm:py-8">
          {children}
        </main>
      </div>

      {user.role === "PATIENT" && pathname !== "/patient/assistant" && <AssistantWidget />}
    </div>
  );
}
