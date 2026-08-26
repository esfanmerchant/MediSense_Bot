"use client";

import { Button, Card } from "@/components/ui";
import { useSession } from "@/lib/session";

/**
 * Landing page for NURSE accounts.
 *
 * Nurses hold no standing access to patient data — their only patient-facing
 * capability is requesting time-boxed break-glass access during a declared
 * emergency (R3). That flow arrives in a later phase; until then this page
 * states the position plainly rather than showing an empty dashboard.
 */
export default function NoDashboardPage() {
  const { user, signOut } = useSession();

  return (
    <main id="main" className="mx-auto flex min-h-screen max-w-2xl items-center px-4 py-12">
      <Card title="Emergency access only">
        <p className="text-slate-700 dark:text-slate-300">
          {user ? `You are signed in as ${user.name}. ` : ""}
          Nursing accounts do not hold standing access to patient records.
        </p>
        <p className="mt-3 text-slate-700 dark:text-slate-300">
          During a declared emergency you can request temporary access to a single patient&rsquo;s
          critical information. That access is time-limited, notifies the patient&rsquo;s doctor and
          the duty administrator, and every record it opens is logged and reviewed afterwards.
        </p>
        <p className="mt-3 text-sm text-slate-600 dark:text-slate-400">
          The emergency access request flow is not available yet.
        </p>
        <Button variant="secondary" className="mt-5" onClick={() => void signOut()}>
          Sign out
        </Button>
      </Card>
    </main>
  );
}
