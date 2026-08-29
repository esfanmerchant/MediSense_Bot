"use client";

/**
 * The shared frame for every screen where nobody is signed in yet.
 *
 * Split panel. The left 45% is the brand ramp and carries the product's voice:
 * the mark, the circuit field drifting behind it, three promises, and a sample
 * exchange so the assistant's manner is visible *before* anyone hands over an
 * email address. The right side carries none of that — a plain canvas, a faint
 * mesh, and one card. A form is easier to finish when nothing on it is trying
 * to sell.
 *
 * On a phone the brand panel collapses to a 160px gradient header holding the
 * logo and a single line, rather than pushing the form below the fold. The
 * language pill and the theme switch sit on the form side at every width, where
 * a thumb can reach them.
 */

import Link from "next/link";
import type { ReactNode } from "react";

import { Icon } from "@/components/Icon";
import { LanguageToggle } from "@/components/LanguageToggle";
import { ThemeToggle } from "@/components/ThemeToggle";
import { CircuitNodes } from "@/components/brand/CircuitNodes";
import { Logo, LogoMark } from "@/components/brand/Logo";
import { useTr } from "@/lib/lang";

export function AuthPanel({ children }: { children: ReactNode }) {
  const tr = useTr();

  const points: [string, string][] = [
    [
      tr(
        "Everything from booking to billing, in one record",
        "Booking se billing tak sab kuchh, ek hi record mein",
      ),
      "event_available",
    ],
    [
      tr(
        "An assistant that escalates instead of guessing",
        "Aisa assistant jo andaza nahi lagata — doctor tak pahunchata hai",
      ),
      "smart_toy",
    ],
    [
      tr(
        "Every access to your file is logged, permanently",
        "Aap ki file ki har rasai hamesha ke liye darj hoti hai",
      ),
      "policy",
    ],
  ];

  return (
    <main id="main" className="grid min-h-screen lg:grid-cols-[45fr_55fr]">
      {/* --- brand panel ---------------------------------------------------- */}
      <section className="brand-panel relative isolate flex h-40 flex-col justify-center overflow-hidden px-6 text-white lg:h-auto lg:justify-between lg:px-12 lg:py-14">
        {/* The circuit field, drifting. Decoration: it never carries meaning. */}
        <div aria-hidden className="animate-drift pointer-events-none absolute -inset-[18%]">
          <CircuitNodes density="med" tone="white" />
        </div>

        {/* The mark itself, blown up and held at 12% — a watermark, not a logo. */}
        <LogoMark
          onDark
          className="pointer-events-none absolute -right-24 top-1/2 hidden h-[36rem] w-auto -translate-y-1/2 opacity-[0.12] lg:block"
        />

        <div className="relative flex items-center justify-between gap-4">
          <Link
            href="/"
            className="rounded-lg focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-white"
          >
            <Logo variant="white" size="md" />
          </Link>
        </div>

        {/* The one line a phone gets. */}
        <p className="relative mt-2 text-sm text-white/75 lg:hidden">
          {tr(
            "Your whole care, in one place.",
            "Aap ki poori dekh-bhaal, ek hi jagah.",
          )}
        </p>

        <div className="relative hidden lg:block">
          <h1 className="font-display text-4xl font-bold leading-[1.1] text-white xl:text-5xl">
            {tr("Care that keeps", "Aisi dekh-bhaal jo")}
            <br />
            <span className="text-gradient-medical">
              {tr("its records straight.", "hisaab seedha rakhti hai.")}
            </span>
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
                  className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-white/15 ring-1 ring-white/20"
                >
                  <Icon name={icon} className="text-[20px] text-white" />
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
            <p className="mono-caps mb-3 text-[11px] text-white/50">
              {tr("Example", "Misal")}
            </p>
            <p className="ml-auto w-fit max-w-[85%] rounded-2xl rounded-br-md bg-white/15 px-3.5 py-2 text-sm text-white">
              {tr(
                "What is my blood pressure tablet for?",
                "Meri blood pressure ki goli kis liye hai?",
              )}
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
      <section className="mesh-light relative flex items-center justify-center bg-canvas px-4 py-10 sm:px-8 sm:py-14">
        <div className="absolute right-4 top-4 z-10 flex items-center gap-2 sm:right-6 sm:top-6">
          <LanguageToggle />
          <ThemeToggle />
        </div>

        <div className="pop-in w-full max-w-[440px] rounded-2xl border border-line bg-card p-6 shadow-float sm:p-8">
          {children}
        </div>
      </section>
    </main>
  );
}
