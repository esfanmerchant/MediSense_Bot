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
import { Logo, LogoMark } from "@/components/Logo";
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
  ];

  return (
    <main id="main" className="grid min-h-screen lg:grid-cols-[1.05fr_1fr]">
      {/* --- brand panel ---------------------------------------------------- */}
      <section className="hero-navy relative overflow-hidden px-6 py-8 lg:flex lg:flex-col lg:justify-between lg:px-12 lg:py-12">
        <div
          aria-hidden
          className="animate-drift pointer-events-none absolute -left-32 -top-32 h-[28rem] w-[28rem] rounded-full bg-[#3B6BF0] opacity-60 blur-[110px]"
        />
        <div
          aria-hidden
          className="animate-drift-late pointer-events-none absolute -bottom-24 -right-24 h-[24rem] w-[24rem] rounded-full bg-[#0E9E98] opacity-40 blur-[110px]"
        />
        <svg
          aria-hidden
          viewBox="0 0 640 60"
          preserveAspectRatio="none"
          className="pointer-events-none absolute inset-x-0 bottom-24 hidden h-16 w-full opacity-25 lg:block"
          fill="none"
          stroke="#5EEAD4"
          strokeWidth="1.5"
          strokeLinejoin="round"
        >
          <path
            className="animate-ecg"
            d="M0 40 H140 L152 40 L160 14 L172 54 L182 40 H300 L308 30 L316 40 H440 L452 40 L460 12 L472 56 L482 40 H640"
          />
        </svg>

        <div className="relative flex items-center justify-between gap-4">
          <Link
            href="/"
            className="flex items-center gap-2.5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
          >
            <Logo onDark size="md" />
          </Link>
          <LanguageToggle onDark />
        </div>

        <div className="relative hidden lg:block">
          <h1 className="font-display text-4xl font-bold leading-[1.1] text-white xl:text-5xl">
            {tr("Care that keeps", "Aisi dekh-bhaal jo")}
            <br />
            <span className="text-gradient-medical">{tr("its records straight.", "hisaab seedha rakhti hai.")}</span>
          </h1>

          <ul className="mt-10 space-y-4">
            {points.map(([text, icon], index) => (
              <li
                key={icon}
                className="page-enter flex items-start gap-3 text-[15px] leading-relaxed text-white/80"
                style={{ animationDelay: `${150 + index * 90}ms` }}
              >
                <span
                  aria-hidden
                  className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-white/10 ring-1 ring-white/15"
                >
                  <Icon name={icon} className="text-[20px] text-accent-bright" />
                </span>
                {text}
              </li>
            ))}
          </ul>

          {/* A sample exchange, so the assistant's manner is visible before
              anyone signs in. Labelled as an example: nothing here is live. */}
          <div
            className="glass-dark page-enter mt-10 max-w-md rounded-2xl p-4"
            style={{ animationDelay: "480ms" }}
            aria-label={tr("Example conversation", "Misali baat-cheet")}
          >
            <p className="mb-3 text-[11px] font-bold uppercase tracking-[0.14em] text-white/50">
              {tr("Example", "Misal")}
            </p>
            <p className="ml-auto w-fit max-w-[85%] rounded-2xl rounded-br-md bg-white/15 px-3.5 py-2 text-sm text-white">
              {tr("What is my blood pressure tablet for?", "Meri blood pressure ki goli kis liye hai?")}
            </p>
            <div className="mt-3 flex items-start gap-2.5">
              <span
                aria-hidden
                className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-white/90"
              >
                <LogoMark className="h-4 w-auto" />
              </span>
              <div className="rounded-2xl rounded-tl-md bg-white/10 px-3.5 py-2.5 text-sm leading-relaxed text-white/90">
                {tr(
                  "Amlodipine 5 mg, on your record since March, relaxes blood vessels so your pressure stays lower through the day. Take it at the same time each day — and if you get swollen ankles, mention it at your visit on the 12th.",
                  "Amlodipine 5 mg, jo March se aap ke record par hai, khoon ki naliyon ko dheela karti hai taake din bhar pressure kam rahe. Roz ek hi waqt par lein — aur agar takhnay soojein to 12 tareekh ki visit par zikr karein.",
                )}
                <span className="mt-2 block text-[11px] text-white/50">
                  {tr("Guidance, not a diagnosis.", "Rehnumai, tashkhees nahi.")}
                </span>
              </div>
            </div>
          </div>
        </div>

        <p className="relative hidden text-xs text-white/40 lg:block">
          {tr("Smart Healthcare Management System", "Smart Healthcare Management System")}
        </p>
      </section>

      {/* --- form panel ----------------------------------------------------- */}
      <section className="flex items-center justify-center px-4 py-12 sm:px-8">
        <div className="glass page-enter w-full max-w-md rounded-3xl p-6 !shadow-float sm:p-9">
          {children}
        </div>
      </section>
    </main>
  );
}
