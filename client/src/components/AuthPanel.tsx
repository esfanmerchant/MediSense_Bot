"use client";

/**
 * The shared frame for every screen where nobody is signed in yet.
 *
 * Split panel. The left 46% is the brand ramp and carries the product's voice:
 * the mark, the circuit field drifting behind it, three promises, and the
 * assistant actually answering someone, so its manner is visible *before*
 * anyone hands over an email address. The right side carries the form.
 *
 * **The ground is layered, not flat.** A single 135° wash of the ramp put the
 * most saturated teal wherever it happened to land — often under a sentence,
 * where white text on #1A8FC7 manages 3:1 — and, beside a near-black form side,
 * read as two unrelated pages stapled together. So the ramp is still the ramp,
 * but it is anchored: navy pulled into the bottom-left corner where the words
 * are, azure and teal kept up in the top-right corner where the watermark is
 * and no words are, and a vertical scrim over the whole thing. Every sentence
 * on the panel now sits on the ramp's dark end and clears 4.5:1, and the form
 * side answers back with the same light — a mesh, a faint circuit field, the
 * ramp spilling across the seam, and a hairline of it around the card.
 *
 * On a phone the brand panel collapses to a 160px gradient header holding the
 * logo and a single line, rather than pushing the form below the fold. The
 * language pill and the theme switch sit on the form side at every width, where
 * a thumb can reach them.
 */

import Link from "next/link";
import type { CSSProperties, ReactNode } from "react";

import { Icon } from "@/components/Icon";
import { LanguageToggle } from "@/components/LanguageToggle";
import { ThemeToggle } from "@/components/ThemeToggle";
import { AssistantChatDemo } from "@/components/auth/ChatDemo";
import { AuthFieldStyles } from "@/components/auth/fieldStyles";
import { CircuitNodes } from "@/components/brand/CircuitNodes";
import { Logo, LogoMark } from "@/components/brand/Logo";
import { useTr } from "@/lib/lang";

/**
 * The brand panel's ground, top layer first.
 *
 * Nothing here is a colour the brand does not already own: #14C4C1, #1A8FC7 and
 * #0B3FA8 are the logo's ramp, and #0A2E7A is its deep end (`--ms-blue-900`).
 * The two radial glows are the light source, the navy corner is the anchor, and
 * the scrim is what keeps white type legible all the way down the panel.
 */
const BRAND_FIELD: CSSProperties = {
  backgroundImage: [
    "radial-gradient(58% 44% at 94% -6%, rgb(20 196 193 / 0.5), transparent 62%)",
    "radial-gradient(52% 48% at 106% 40%, rgb(26 143 199 / 0.45), transparent 66%)",
    "radial-gradient(88% 70% at -6% 102%, rgb(10 46 122 / 0.92), transparent 66%)",
    "linear-gradient(to bottom, rgb(10 46 122 / 0.15), rgb(10 46 122 / 0.5))",
    "linear-gradient(135deg, #0b3fa8 0%, #1a8fc7 55%, #14c4c1 100%)",
  ].join(", "),
};

/** The circuit field is decoration; it stays away from the reading column. */
const CIRCUIT_FADE: CSSProperties = {
  maskImage: "radial-gradient(72% 62% at 78% 22%, #000, transparent 78%)",
  WebkitMaskImage: "radial-gradient(72% 62% at 78% 22%, #000, transparent 78%)",
};

/** Same idea on the form side: the motif at the edges, never behind the card. */
const FORM_CIRCUIT_FADE: CSSProperties = {
  maskImage: "radial-gradient(62% 52% at 50% 50%, transparent 24%, #000 100%)",
  WebkitMaskImage: "radial-gradient(62% 52% at 50% 50%, transparent 24%, #000 100%)",
};

/** The seam: the brand panel's light, spilling a little way across. */
const SEAM: CSSProperties = {
  backgroundImage:
    "linear-gradient(to right, rgb(20 196 193 / 0.16), rgb(11 63 168 / 0.07) 40%, transparent)",
};

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
    // `overflow-x-clip` rather than `hidden`: the brand panel's decorative
    // artwork is a path whose geometry runs ten pixels past the phone's edge,
    // and while the panel already clips its own painting, the width still
    // reached the document and gave every auth page a sideways scroll. `clip`
    // stops that without creating a scroll container, which `hidden` would —
    // and a scroll container here would break the sticky header on the form
    // side.
    <main
      id="main"
      className="auth-shell grid min-h-screen overflow-x-clip lg:grid-cols-[46fr_54fr]"
    >
      <AuthFieldStyles />

      {/* --- brand panel ---------------------------------------------------- */}
      <section className="relative isolate flex h-40 flex-col justify-center overflow-hidden px-6 text-white lg:h-auto lg:justify-between lg:px-12 lg:py-10 xl:px-14 xl:py-14">
        <div aria-hidden className="absolute inset-0 -z-30" style={BRAND_FIELD} />
        {/* Night deepens the panel rather than repainting it, so the two halves
            of the page stay in the same room as each other. */}
        <div aria-hidden className="absolute inset-0 -z-20 hidden dark:block dark:bg-navy-deep/50" />

        {/* The circuit field, drifting. Decoration: it never carries meaning. */}
        <div
          aria-hidden
          className="animate-drift pointer-events-none absolute -inset-[18%] -z-10 opacity-50"
          style={CIRCUIT_FADE}
        >
          <CircuitNodes density="med" tone="white" />
        </div>

        {/* The mark itself, blown up and held at 10% — a watermark, not a logo. */}
        <LogoMark
          onDark
          className="pointer-events-none absolute -right-28 top-[38%] -z-10 hidden h-[32rem] w-auto -translate-y-1/2 opacity-10 lg:block"
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
        <p className="relative mt-2 text-sm text-white/85 lg:hidden">
          {tr("Your whole care, in one place.", "Aap ki poori dekh-bhaal, ek hi jagah.")}
        </p>

        <div className="relative hidden min-w-0 lg:block">
          <h1 className="font-display text-[32px] font-bold leading-[1.12] text-white xl:text-[42px]">
            {tr("Care that keeps", "Aisi dekh-bhaal jo")}
            <br />
            <span className="text-gradient-medical">
              {tr("its records straight.", "hisaab seedha rakhti hai.")}
            </span>
          </h1>

          <ul className="mt-6 space-y-2.5 xl:mt-7 xl:space-y-3">
            {points.map(([text, icon], index) => (
              <li
                key={icon}
                className="page-enter flex items-center gap-3 text-[14px] font-medium leading-snug text-white/90"
                style={{ animationDelay: `${150 + index * 90}ms` }}
              >
                <span
                  aria-hidden
                  className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-white/15 ring-1 ring-white/25"
                >
                  <Icon name={icon} className="text-[18px] text-white" />
                </span>
                {text}
              </li>
            ))}
          </ul>

          {/* The assistant, answering someone, on a loop. Labelled as an
              example: nothing in it is live, and none of it is a diagnosis. */}
          <div className="page-enter mt-7 max-w-md xl:mt-8" style={{ animationDelay: "440ms" }}>
            <AssistantChatDemo />
          </div>
        </div>

        <p className="relative hidden text-xs font-medium text-white/70 lg:block">
          {tr("Smart Healthcare Management System", "Smart Healthcare Management System")}
        </p>
      </section>

      {/* --- form panel ----------------------------------------------------- */}
      <section className="relative flex items-center justify-center bg-canvas px-4 pb-10 pt-20 sm:px-8 sm:py-14">
        <div aria-hidden className="mesh-light pointer-events-none absolute inset-0" />
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 opacity-40"
          style={FORM_CIRCUIT_FADE}
        >
          <CircuitNodes density="low" />
        </div>
        <div
          aria-hidden
          className="pointer-events-none absolute inset-y-0 left-0 hidden w-52 lg:block"
          style={SEAM}
        />

        <div className="absolute right-4 top-4 z-10 flex items-center gap-2 sm:right-6 sm:top-6">
          <LanguageToggle />
          <ThemeToggle />
        </div>

        {/* A hairline of the ramp around the card — the same light as the panel
            opposite, at the strength a form can carry without competing. */}
        <div className="pop-in border-gradient relative w-full max-w-[452px] rounded-2xl p-6 shadow-float sm:p-8">
          {children}
        </div>
      </section>
    </main>
  );
}
