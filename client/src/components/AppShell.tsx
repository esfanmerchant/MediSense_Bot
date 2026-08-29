"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";

import { Icon } from "@/components/Icon";
import { NotificationBell } from "@/components/NotificationBell";
import { Button, Loading, Unauthorized, cx } from "@/components/ui";
import { homePathFor, useSession } from "@/lib/session";
import type { Role } from "@/lib/api";

interface NavItem {
  href: string;
  label: string;
  icon: string;
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
const NAV: Record<Role, NavItem[]> = {
  PATIENT: [
    { href: "/patient", label: "Dashboard", icon: "dashboard" },
    { href: "/patient/appointments", label: "Appointments", icon: "calendar_today" },
    { href: "/patient/records", label: "Medical records", icon: "description" },
    { href: "/patient/documents", label: "Documents", icon: "folder_open" },
    { href: "/patient/vitals", label: "Vitals", icon: "monitor_heart" },
    { href: "/patient/billing", label: "Billing", icon: "payments" },
    { href: "/patient/assistant", label: "Health assistant", icon: "smart_toy" },
  ],
  DOCTOR: [
    { href: "/doctor", label: "Dashboard", icon: "dashboard" },
    { href: "/doctor/patients", label: "My patients", icon: "group" },
    { href: "/doctor/appointments", label: "Appointments", icon: "calendar_today" },
    { href: "/doctor/alerts", label: "Alerts", icon: "notifications_active" },
  ],
  ADMIN: [
    { href: "/admin", label: "Dashboard", icon: "dashboard" },
    { href: "/admin/appointments", label: "Appointments", icon: "calendar_today" },
    { href: "/admin/billing", label: "Billing", icon: "payments" },
    { href: "/admin/emergency", label: "Emergency access", icon: "e911_emergency" },
    { href: "/admin/audit", label: "Audit trail", icon: "policy" },
  ],
  NURSE: [{ href: "/no-dashboard", label: "Emergency access", icon: "e911_emergency" }],
};

/** Where the rail's emergency button takes each role. Patients have none. */
const EMERGENCY_HREF: Partial<Record<Role, string>> = {
  NURSE: "/no-dashboard",
  DOCTOR: "/doctor/alerts",
  ADMIN: "/admin/emergency",
};

/**
 * Warns before the server ends the session (R8).
 *
 * A courtesy, not a control — the server expires the session whether or not
 * this banner ever renders. Its job is to stop a clinician losing a
 * half-written note without warning.
 */
function InactivityWarning() {
  const { showWarning, secondsRemaining, stayAlive, signOut } = useSession();
  if (!showWarning || secondsRemaining === null) return null;

  return (
    <div
      role="alertdialog"
      aria-live="assertive"
      aria-label="Session about to expire"
      className="sticky top-0 z-50 border-b-2 border-warning bg-warning-soft px-4 py-3"
    >
      <div className="mx-auto flex max-w-[1400px] flex-wrap items-center gap-3">
        <Icon name="timer" className="text-[20px] text-warning" />
        <p className="text-sm font-semibold text-warning">
          You will be signed out in <span className="tabular-nums">{secondsRemaining}s</span>{" "}
          because of inactivity.
        </p>
        <div className="ml-auto flex gap-2">
          <Button size="md" onClick={stayAlive}>
            Stay signed in
          </Button>
          <Button size="md" variant="secondary" onClick={() => void signOut()}>
            Sign out now
          </Button>
        </div>
      </div>
    </div>
  );
}

/**
 * The navigation rail.
 *
 * Deep navy and persistent, per the design system: the one constant on screen,
 * kept out of the content's colour space entirely. The active item is marked
 * three ways at once — a teal left edge, a filled icon, and a lighter ground —
 * so it survives a colour-blind reader, a bad monitor, and a glance.
 */
function Rail({
  items,
  pathname,
  emergencyHref,
  onNavigate,
}: {
  items: NavItem[];
  pathname: string;
  emergencyHref?: string;
  onNavigate?: () => void;
}) {
  return (
    // The brand link sits outside the <nav> landmark on purpose. It is chrome —
    // a way back to the public site — not one of this role's destinations.
    <div className="flex h-full flex-col py-6">
      <Link
        href="/"
        onClick={onNavigate}
        className="mb-8 flex items-center gap-3 px-6 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-bright"
      >
        <span
          aria-hidden
          className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-white/10 ring-1 ring-white/20"
        >
          <Icon name="health_and_safety" filled className="text-[22px] text-accent-bright" />
        </span>
        <span className="min-w-0">
          <span className="block truncate text-lg font-bold tracking-tight text-white">
            MediSense
          </span>
          <span className="block truncate text-[11px] text-white/60">Healthcare System</span>
        </span>
      </Link>

      {emergencyHref && (
        <div className="mb-8 px-6">
          {/* The one red thing in the rail — the fastest route to the screen
              somebody needs when there is no time to navigate. */}
          <Link
            href={emergencyHref}
            onClick={onNavigate}
            className="flex min-h-11 w-full items-center justify-center gap-2 rounded-lg bg-critical text-sm font-bold text-white shadow-sm transition-opacity hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
          >
            <Icon name="warning" filled className="text-[20px]" />
            Emergency access
          </Link>
        </div>
      )}

      <nav aria-label="Main" className="flex-1 px-4">
        <ul className="space-y-1">
          {items.map((item) => {
            const active = pathname === item.href;
            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  onClick={onNavigate}
                  className={cx(
                    "flex min-h-11 items-center gap-3 rounded-r-full border-l-4 px-4 py-2.5 text-sm transition-colors",
                    "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-bright",
                    active
                      ? "border-accent-bright bg-primary-active font-bold text-accent-bright"
                      : "border-transparent font-medium text-white/70 hover:bg-white/10 hover:text-white",
                  )}
                >
                  <Icon name={item.icon} filled={active} className="text-[20px]" />
                  <span className="truncate">{item.label}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
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
  const pathname = usePathname();
  const router = useRouter();
  const [railOpen, setRailOpen] = useState(false);

  useEffect(() => {
    if (!loading && !user) router.replace("/login");
  }, [loading, user, router]);

  if (loading) {
    return (
      <main className="mx-auto max-w-6xl px-4 py-16">
        <Loading label="Checking your session" />
      </main>
    );
  }

  if (!user) return null; // redirecting

  if (user.role !== role) {
    return (
      <main className="mx-auto max-w-2xl px-4 py-16">
        <Unauthorized
          message={`This area is for ${role.toLowerCase()}s. Your account is signed in as ${user.role.toLowerCase()}.`}
        />
        <Button className="mt-4" onClick={() => router.replace(homePathFor(user.role))}>
          Go to your dashboard
        </Button>
      </main>
    );
  }

  const nav = NAV[user.role] ?? [];
  const emergencyHref = EMERGENCY_HREF[user.role];

  return (
    <div className="flex min-h-screen bg-canvas">
      {/* Desktop rail — sticky, so a long table never scrolls navigation out of
          reach. */}
      <aside className="sticky top-0 hidden h-screen w-[260px] shrink-0 bg-rail shadow-overlay lg:block">
        <Rail items={nav} pathname={pathname} emergencyHref={emergencyHref} />
      </aside>

      {/* Mobile rail — a drawer, because 260px of a phone is most of it. */}
      {railOpen && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <button
            type="button"
            aria-label="Close navigation"
            className="absolute inset-0 bg-black/50"
            onClick={() => setRailOpen(false)}
          />
          <aside className="relative h-full w-[260px] max-w-[85%] bg-rail shadow-overlay">
            <Rail
              items={nav}
              pathname={pathname}
              emergencyHref={emergencyHref}
              onNavigate={() => setRailOpen(false)}
            />
          </aside>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <InactivityWarning />

        <header className="sticky top-0 z-30 flex h-16 items-center gap-3 border-b border-line bg-canvas/95 px-4 backdrop-blur sm:px-8">
          <button
            type="button"
            aria-label="Open navigation"
            aria-expanded={railOpen}
            className="rounded-full p-2 text-muted transition-colors hover:bg-raised focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary lg:hidden"
            onClick={() => setRailOpen(true)}
          >
            <Icon name="menu" />
          </button>

          <div className="ml-auto flex items-center gap-2">
            <span className="mr-1 hidden text-right sm:block">
              <span className="block text-sm font-semibold text-strong">{user.name}</span>
              <span className="block text-xs capitalize text-faint">
                {user.role.toLowerCase()}
              </span>
            </span>
            <NotificationBell role={user.role} />
            <Button variant="secondary" onClick={() => void signOut()}>
              <Icon name="logout" className="text-[18px]" />
              <span className="hidden sm:inline">Sign out</span>
            </Button>
          </div>
        </header>

        <main className="mx-auto w-full max-w-[1400px] flex-1 px-4 py-6 sm:px-8 sm:py-8">
          {children}
        </main>
      </div>
    </div>
  );
}
