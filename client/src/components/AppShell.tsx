"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, type ReactNode } from "react";

import { NotificationBell } from "@/components/NotificationBell";
import { Button, Loading, Unauthorized, cx } from "@/components/ui";
import { homePathFor, useSession } from "@/lib/session";
import type { Role } from "@/lib/api";

interface NavItem {
  href: string;
  label: string;
}

/**
 * Only routes that exist.
 *
 * Later phases add the admin user and audit screens; their links go in when the
 * pages do. A nav item that leads to a 404 reads as a broken product, not as a
 * roadmap.
 */
const NAV: Record<Role, NavItem[]> = {
  PATIENT: [
    { href: "/patient", label: "Overview" },
    { href: "/patient/appointments", label: "Appointments" },
    { href: "/patient/records", label: "Medical history" },
    { href: "/patient/documents", label: "Documents" },
    { href: "/patient/vitals", label: "Vitals" },
    { href: "/patient/billing", label: "Billing" },
    { href: "/patient/assistant", label: "Health assistant" },
  ],
  DOCTOR: [
    { href: "/doctor", label: "Overview" },
    { href: "/doctor/patients", label: "My patients" },
    { href: "/doctor/appointments", label: "Appointments" },
    { href: "/doctor/alerts", label: "Alerts" },
  ],
  ADMIN: [
    { href: "/admin", label: "Overview" },
    { href: "/admin/appointments", label: "Appointments" },
    { href: "/admin/billing", label: "Billing" },
  ],
  NURSE: [{ href: "/no-dashboard", label: "Emergency access" }],
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
      className="sticky top-0 z-50 border-b border-amber-300 bg-amber-50 px-4 py-3 dark:border-amber-800 dark:bg-amber-950"
    >
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-3">
        <p className="text-sm font-medium text-amber-900 dark:text-amber-200">
          You will be signed out in{" "}
          <span className="tabular-nums">{secondsRemaining}s</span> because of inactivity.
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
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950">
      <InactivityWarning />

      <header className="border-b border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-4 px-4 py-3">
          <Link
            href={homePathFor(user.role)}
            className="text-lg font-semibold text-teal-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600 dark:text-teal-300"
          >
            MediSense
          </Link>

          <div className="ml-auto flex items-center gap-3">
            <span className="hidden text-sm text-slate-600 sm:inline dark:text-slate-400">
              {user.name} · {user.role.toLowerCase()}
            </span>
            <NotificationBell role={user.role} />
            <Button variant="secondary" onClick={() => void signOut()}>
              Sign out
            </Button>
          </div>
        </div>

        <nav aria-label="Main" className="mx-auto max-w-6xl overflow-x-auto px-4">
          <ul className="flex gap-1 pb-2">
            {nav.map((item) => {
              const active = pathname === item.href;
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    aria-current={active ? "page" : undefined}
                    className={cx(
                      "inline-flex min-h-11 items-center whitespace-nowrap rounded-md px-3 text-sm font-medium",
                      "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600",
                      active
                        ? "bg-teal-50 text-teal-900 dark:bg-teal-950 dark:text-teal-200"
                        : "text-slate-700 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800",
                    )}
                  >
                    {item.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-6">{children}</main>
    </div>
  );
}
