"use client";

/**
 * The terms, on their own page.
 *
 * Reachable without signing in — a terms page you need an account to read is
 * not terms anybody could have consented to — and linked from every portal's
 * footer so somebody who agreed months ago can find them again.
 */

import Link from "next/link";

import { Logo } from "@/components/brand/Logo";
import { TermsBody, useTerms } from "@/components/Terms";
import { ErrorState } from "@/components/ui";
import { useTr } from "@/lib/lang";

export default function TermsPage() {
  const tr = useTr();
  const { terms, failed } = useTerms();

  return (
    <div className="min-h-screen bg-canvas">
      <header className="border-b border-line bg-card">
        <div className="mx-auto flex w-full max-w-[52rem] items-center justify-between px-5 py-4">
          <Link href="/" className="rounded-lg focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-primary">
            <Logo size="sm" />
          </Link>
          <Link
            href="/patient/assistant"
            className="text-sm font-semibold text-primary hover:underline"
          >
            {tr("Ask the assistant", "Assistant se poochein")}
          </Link>
        </div>
      </header>

      <main id="main" className="mx-auto w-full max-w-[52rem] px-5 py-10">
        <h1 className="font-display text-3xl font-bold text-strong">
          {tr("Terms and community guidelines", "Shara-it aur community guidelines")}
        </h1>
        <p className="mt-2 text-[15px] text-muted">
          {tr(
            "What MediSense does, what it does not, and what we ask of you.",
            "MediSense kya karta hai, kya nahi, aur aap se kya chahta hai.",
          )}
        </p>

        <div className="mt-8">
          {failed && (
            <ErrorState
              message={tr(
                "The terms could not be loaded. Please try again.",
                "Shara-it load nahi ho sakeen. Dobara koshish karein.",
              )}
            />
          )}
          {terms && <TermsBody terms={terms} />}
        </div>
      </main>
    </div>
  );
}
