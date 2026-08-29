"use client";

/**
 * The shared frame for sign-in and registration.
 *
 * Split-panel: a navy brand side that carries the product's voice, and a plain
 * form side that carries none at all. The decoration all lives on the left so
 * the right half stays what a form should be — quiet, obvious, fast. On phones
 * the brand panel collapses to a slim header rather than pushing the form below
 * the fold.
 */

import Link from "next/link";
import type { ReactNode } from "react";

import { Icon } from "@/components/Icon";
import { LanguageToggle } from "@/components/LanguageToggle";
import { useTr } from "@/lib/lang";

export function AuthPanel({ children }: { children: ReactNode }) {
  const tr = useTr();

  const points: [string, string][] = [
    [
      tr("Everything from booking to billing, in one record", "Booking se billing tak sab kuchh, ek hi record mein"),
      "event_available",
    ],
    [
      tr("An assistant that escalates instead of guessing", "Aisa assistant jo andaza nahi lagata — doctor tak pahunchata hai"),
      "smart_toy",
    ],
    [
      tr("Every access to your file is logged, permanently", "Aap ki file ki har rasai hamesha ke liye darj hoti hai"),
      "policy",
    ],
  ].map(([text, icon]) => [text, icon] as [string, string]);

  return (
    <main id="main" className="grid min-h-screen lg:grid-cols-[1.05fr_1fr]">
      {/* --- brand panel ---------------------------------------------------- */}
      <section className="relative overflow-hidden bg-[#002050] px-6 py-8 lg:flex lg:flex-col lg:justify-between lg:px-12 lg:py-12">
        <div
          aria-hidden
          className="animate-drift pointer-events-none absolute -left-32 -top-32 h-[28rem] w-[28rem] rounded-full bg-[#0d47a1] opacity-60 blur-[110px]"
        />
        <div
          aria-hidden
          className="animate-drift-late pointer-events-none absolute -bottom-24 -right-24 h-[24rem] w-[24rem] rounded-full bg-[#006b5f] opacity-40 blur-[110px]"
        />

        <div className="relative flex items-center justify-between gap-4">
          <Link
            href="/"
            className="flex items-center gap-2.5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
          >
            <span
              aria-hidden
              className="grid h-9 w-9 place-items-center rounded-lg bg-white/10 ring-1 ring-white/20"
            >
              <Icon name="health_and_safety" filled className="text-[20px] text-accent-bright" />
            </span>
            <span className="font-display text-lg font-bold text-white">MediSense</span>
          </Link>
          <LanguageToggle onDark />
        </div>

        <div className="relative hidden lg:block">
          <h1 className="font-display text-4xl font-bold leading-[1.1] text-white">
            {tr("Care that keeps", "Aisi dekh-bhaal jo")}
            <br />
            <span className="text-gradient-medical">{tr("its records straight.", "hisaab seedha rakhti hai.")}</span>
          </h1>
          <ul className="mt-10 space-y-5">
            {points.map(([text, icon]) => (
              <li key={icon} className="flex items-start gap-3 text-[15px] leading-relaxed text-white/75">
                <span
                  aria-hidden
                  className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-white/10"
                >
                  <Icon name={icon} className="text-[20px] text-accent-bright" />
                </span>
                {text}
              </li>
            ))}
          </ul>
        </div>

        <p className="relative hidden text-xs text-white/40 lg:block">
          {tr("Smart Healthcare Management System", "Smart Healthcare Management System")}
        </p>
      </section>

      {/* --- form panel ----------------------------------------------------- */}
      <section className="flex items-center justify-center px-4 py-12 sm:px-8">
        {children}
      </section>
    </main>
  );
}
