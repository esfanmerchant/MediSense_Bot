"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";

import { NotificationBell } from "@/components/NotificationBell";
import { Button, Loading, Unauthorized, cx } from "@/components/ui";
import { homePathFor, useSession } from "@/lib/session";
import type { Role } from "@/lib/api";

interface NavItem {
  href: string;
  label: string;
  /** Material-style glyph. Decorative — the label is what is announced. */
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
    { href: "/patient", label: "Overview", icon: "🏠" },
    { href: "/patient/appointments", label: "Appointments", icon: "📅" },
    { href: "/patient/records", label: "Medical history", icon: "📋" },
    { href: "/patient/documents", label: "Documents", icon: "📄" },
    { href: "/patient/vitals", label: "Vitals", icon: "❤️" },
    { href: "/patient/billing", label: "Billing", icon: "🧾" },
    { href: "/patient/assistant", label: "Health assistant", icon: "💬" },
  ],
  DOCTOR: [
    { href: "/doctor", label: "Overview", icon: "🏠" },
    { href: "/doctor/patients", label: "My patients", icon: "👥" },
    { href: "/doctor/appointments", label: "Appointments", icon: "📅" },
    { href: "/doctor/alerts", label: "Alerts", icon: "🔔" },
  ],
  ADMIN: [
    { href: "/admin", label: "Overview", icon: "🏠" },
    { href: "/admin/appointments", label: "Appointments", icon: "📅" },
    { href: "/admin/billing", label: "Billing", icon: "🧾" },
    { href: "/admin/emergency", label: "Emergency access", icon: "🚨" },
    { href: "/admin/audit", label: "Audit trail", icon: "🔎" },
  ],
  NURSE: [{ href: "/no-dashboard", label: "Emergency access", icon: "🚨" }],
};

/**
 * Warns before the server ends the session (R8).
 *
 * This is a courtesy, not a control — the server expires the session whether or
 * not this banner ever renders. Its job is to stop a clinician losing a
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
      <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-3">
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
 * Dark and persistent, per the design system: it is the one constant on screen,
 * so it stays out of the content's colour space entirely. Active state is a
 * teal edge marker rather than a colour swap — an outline survives a
 * colour-blind reader and a bad monitor in a way a hue change does not.
 */
function Rail({
  items,
  pathname,
  onNavigate,
}: {
  items: NavItem[];
  pathname: string;
  onNavigate?: () => void;
}) {
  return (
    // The brand link sits outside the <nav> landmark on purpose. It is chrome —
    // a way back to the public site — not one of this role's destinations, and
    // including it would make "what can a nurse reach from here" a harder
    // question to answer than it should be.
    <div className="flex h-full flex-col p-4">
      <Link
        href="/"
        className="mb-4 flex items-center gap-2.5 rounded-lg px-2 py-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        onClick={onNavigate}
      >
        <span
          aria-hidden
          className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-accent text-sm font-bold text-rail"
        >
          M
        </span>
        <span className="min-w-0">
          <span className="block truncate text-base font-semibold text-white">MediSense</span>
          <span className="block truncate text-[11px] text-on-rail/70">Healthcare System</span>
        </span>
      </Link>

      <nav aria-label="Main">
        <ul className="flex flex-col gap-1">
        {items.map((item) => {
          const active = pathname === item.href;
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                aria-current={active ? "page" : undefined}
                onClick={onNavigate}
                className={cx(
                  "relative flex min-h-11 items-center gap-3 rounded-lg px-3 text-sm font-medium transition-colors",
                    "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
                  active
                    ? "bg-rail-hover text-white"
                    : "text-on-rail hover:bg-rail-hover hover:text-white",
                )}
              >
                {active && (
                  <span
                    aria-hidden
                    className="absolute left-0 top-1/2 h-6 w-1 -translate-y-1/2 rounded-r-full bg-accent"
                  />
                )}
                <span aria-hidden className="text-base leading-none">
                  {item.icon}
                </span>
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

  return (
    <div className="min-h-screen bg-canvas">
      <InactivityWarning />

      <div className="flex">
        {/* Desktop rail — fixed, so a long table never scrolls the navigation
            out of reach. */}
        <aside className="sticky top-0 hidden h-screen w-[260px] shrink-0 bg-rail lg:block">
          <Rail items={nav} pathname={pathname} />
        </aside>

        {/* Mobile rail — a drawer, because 260px of a phone is most of it. */}
        {railOpen && (
          <div className="fixed inset-0 z-40 lg:hidden">
            <button
              type="button"
              aria-label="Close navigation"
              className="absolute inset-0 bg-black/50"
              onClick={() => setRailOpen(false)}
            />
            <aside className="relative h-full w-[260px] max-w-[80%] bg-rail shadow-overlay">
              <Rail items={nav} pathname={pathname} onNavigate={() => setRailOpen(false)} />
            </aside>
          </div>
        )}

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="sticky top-0 z-30 border-b border-line bg-card/90 backdrop-blur">
            <div className="flex items-center gap-3 px-4 py-3 sm:px-6">
              <Button
                variant="ghost"
                className="lg:hidden"
                aria-expanded={railOpen}
                aria-label="Open navigation"
                onClick={() => setRailOpen(true)}
              >
                <span aria-hidden>☰</span>
              </Button>

              <div className="ml-auto flex items-center gap-3">
                <span className="hidden text-right sm:block">
                  <span className="block text-sm font-medium text-strong">{user.name}</span>
                  <span className="block text-xs text-faint">{user.role.toLowerCase()}</span>
                </span>
                <NotificationBell role={user.role} />
                <Button variant="secondary" onClick={() => void signOut()}>
                  Sign out
                </Button>
              </div>
            </div>
          </header>

          <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 sm:px-6 sm:py-8">
            {children}
          </main>
        </div>
      </div>
    </div>
  );
}
