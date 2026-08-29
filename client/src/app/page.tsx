"use client";

/**
 * The front door.
 *
 * Most healthcare software sells to procurement: uptime, compliance badges,
 * charts going up. The person actually arriving here is usually worried about
 * something, and what works on them is not excitement — it is *relief*.
 *
 * So the page is loud where loudness helps and quiet where it would hurt. The
 * hero is a deep navy field with the product's real interface floating in it,
 * because the strongest thing this project has to show is the interface itself.
 * Everything below it lowers effort and uncertainty: one action repeated, the
 * three objections that stop a signup answered in the order they occur, and the
 * AI introduced with its limits attached rather than oversold.
 *
 * The one deliberate risk: the hero shows the assistant *refusing to reassure*
 * someone with chest pain. Leading with a product's most cautious moment is not
 * the obvious sales choice — but it is the single most convincing thing this
 * system does, and a health product that oversells its intelligence loses trust
 * the first time it is wrong.
 */

import Link from "next/link";
import type { ReactNode } from "react";

import { Icon } from "@/components/Icon";
import { homePathFor, useSession } from "@/lib/session";

function Wordmark({ onDark = false }: { onDark?: boolean }) {
  return (
    <span className="flex items-center gap-2.5">
      <span
        aria-hidden
        className={
          onDark
            ? "grid h-9 w-9 place-items-center rounded-lg bg-white/10 ring-1 ring-white/20"
            : "grid h-9 w-9 place-items-center rounded-lg bg-primary"
        }
      >
        <Icon
          name="health_and_safety"
          filled
          className={onDark ? "text-[20px] text-accent-bright" : "text-[20px] text-white"}
        />
      </span>
      <span className={onDark ? "text-lg font-bold text-white" : "text-lg font-bold text-strong"}>
        MediSense
      </span>
    </span>
  );
}

function Cta({
  href,
  children,
  variant = "solid",
}: {
  href: string;
  children: ReactNode;
  variant?: "solid" | "onDark" | "quiet";
}) {
  const styles = {
    solid:
      "bg-primary text-white shadow-card hover:bg-primary-hover focus-visible:outline-primary",
    onDark:
      "bg-accent-bright text-[#00201c] shadow-overlay hover:brightness-105 focus-visible:outline-white",
    quiet:
      "border border-white/25 text-white hover:bg-white/10 focus-visible:outline-white",
  } as const;

  return (
    <Link
      href={href}
      className={`inline-flex min-h-12 items-center justify-center gap-2 rounded-lg px-6 text-base font-semibold transition-all focus-visible:outline-2 focus-visible:outline-offset-2 ${styles[variant]}`}
    >
      {children}
    </Link>
  );
}

/** A vital tile, exactly as it appears inside the product. */
function HeroVital({
  label,
  value,
  unit,
  icon,
  tone,
}: {
  label: string;
  value: string;
  unit: string;
  icon: string;
  tone: "stable" | "critical";
}) {
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.07] p-4 backdrop-blur">
      <div className="flex items-start justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-white/60">
          {label}
        </span>
        <Icon
          name={icon}
          filled
          className={tone === "critical" ? "text-[18px] text-[#ffb4ab]" : "text-[18px] text-accent-bright"}
        />
      </div>
      <p className="mt-3 flex items-end gap-1.5">
        <span
          className={`text-3xl font-bold leading-none tabular-nums ${
            tone === "critical" ? "text-[#ffb4ab]" : "text-white"
          }`}
        >
          {value}
        </span>
        <span className="mb-0.5 text-xs text-white/50">{unit}</span>
      </p>
    </div>
  );
}

const PORTALS = [
  {
    who: "Patients",
    icon: "person",
    line: "Book a visit, read your own history, ask a question at 2am.",
    points: ["Appointments and reminders", "Records, prescriptions, invoices", "Health assistant with voice input"],
  },
  {
    who: "Doctors",
    icon: "stethoscope",
    line: "Your patients, your alerts, your notes — one screen, not six.",
    points: ["Live vital alerts as they happen", "Charts, prescribing, consultation notes", "Document reading with review"],
  },
  {
    who: "Administrators",
    icon: "admin_panel_settings",
    line: "Run the hospital without reading anyone's diagnosis.",
    points: ["Scheduling and staff", "Billing, invoices, credit notes", "Audit trail and break-glass review"],
  },
];

const CAPABILITIES = [
  ["monitor_heart", "Live vital monitoring", "Readings are checked against configurable thresholds the moment they arrive, and the responsible doctor is told."],
  ["smart_toy", "AI health assistant", "Grounded in your own prescriptions and appointments. It escalates rather than reassures when something sounds serious."],
  ["mic", "Speak your symptoms", "Speech becomes text on your device. You correct it before anything is stored."],
  ["document_scanner", "Reads your documents", "Prescriptions and reports are read automatically — and a doctor confirms every value before it counts."],
  ["receipt_long", "Billing that just happens", "An invoice is created the moment a consultation is completed. Exactly one, however many times it retries."],
  ["policy", "A trail nobody can edit", "Every access is hash-chained. Tampering is detectable, and the check is one button."],
];

export default function Home() {
  const { user, loading } = useSession();
  const primaryHref = user ? homePathFor(user.role) : "/login";
  const primaryLabel = user ? "Go to your dashboard" : "Get started — free";

  return (
    <div className="min-h-screen bg-canvas">
      {/* ================= HERO ================= */}
      <div className="relative overflow-hidden bg-[#003178]">
        {/* Depth without decoration: two soft light sources and a fine grid,
            so the navy reads as a lit space rather than a flat fill. */}
        <div
          aria-hidden
          className="pointer-events-none absolute -left-40 -top-40 h-[36rem] w-[36rem] rounded-full bg-[#0d47a1] opacity-60 blur-[120px]"
        />
        <div
          aria-hidden
          className="pointer-events-none absolute -right-32 top-20 h-[30rem] w-[30rem] rounded-full bg-[#006b5f] opacity-40 blur-[120px]"
        />
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 opacity-[0.07]"
          style={{
            backgroundImage:
              "linear-gradient(to right, #fff 1px, transparent 1px), linear-gradient(to bottom, #fff 1px, transparent 1px)",
            backgroundSize: "56px 56px",
          }}
        />

        <header className="relative">
          <div className="mx-auto flex max-w-[1200px] items-center gap-4 px-5 py-5">
            <Wordmark onDark />
            <nav aria-label="Primary" className="ml-auto flex items-center gap-2">
              {!loading && !user && (
                <Link
                  href="/login"
                  className="hidden min-h-11 items-center rounded-lg px-4 text-sm font-medium text-white/80 hover:bg-white/10 hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white sm:inline-flex"
                >
                  Sign in
                </Link>
              )}
              <Cta href={primaryHref} variant="onDark">
                {loading ? "…" : user ? "Dashboard" : "Get started"}
              </Cta>
            </nav>
          </div>
        </header>

        <section className="relative mx-auto grid max-w-[1200px] gap-12 px-5 pb-24 pt-14 lg:grid-cols-[1.05fr_1fr] lg:items-center lg:pb-32 lg:pt-20">
          <div>
            <p className="inline-flex items-center gap-2 rounded-full border border-accent-bright/30 bg-accent-bright/10 px-3 py-1.5 text-[11px] font-bold uppercase tracking-[0.14em] text-accent-bright">
              <span aria-hidden className="h-1.5 w-1.5 animate-breathe rounded-full bg-accent-bright" />
              Smart Healthcare Management
            </p>

            <h1 className="mt-6 text-[2.75rem] font-black leading-[1.05] text-white sm:text-6xl">
              Your health,
              <br />
              <span className="text-accent-bright">finally in one place.</span>
            </h1>

            <p className="mt-6 max-w-xl text-lg leading-relaxed text-white/75">
              Appointments, records, prescriptions, vitals and bills — with an assistant that
              answers in plain language and knows when to send you to a doctor instead.
            </p>

            <div className="mt-9 flex flex-wrap items-center gap-3">
              <Cta href={primaryHref} variant="onDark">
                {primaryLabel}
                <Icon name="arrow_forward" className="text-[20px]" />
              </Cta>
              <Cta href="#what" variant="quiet">
                See what it does
              </Cta>
            </div>

            {/* The three objections that stop a signup, in the order they
                occur to someone hovering over the button. */}
            <ul className="mt-8 flex flex-wrap gap-x-6 gap-y-2 text-sm text-white/60">
              {["No card needed", "No phone calls", "Your data stays yours"].map((item) => (
                <li key={item} className="flex items-center gap-1.5">
                  <Icon name="check_circle" filled className="text-[16px] text-accent-bright" />
                  {item}
                </li>
              ))}
            </ul>
          </div>

          {/* The product, not a stock photo. */}
          <div className="relative">
            <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-5 shadow-overlay backdrop-blur-sm">
              <div className="flex items-center gap-2 pb-4">
                <span aria-hidden className="h-2.5 w-2.5 rounded-full bg-white/20" />
                <span aria-hidden className="h-2.5 w-2.5 rounded-full bg-white/20" />
                <span aria-hidden className="h-2.5 w-2.5 rounded-full bg-white/20" />
                <span className="ml-2 text-xs text-white/40">Patient dashboard</span>
                <span className="ml-auto flex items-center gap-1.5 text-[11px] font-semibold text-accent-bright">
                  <span aria-hidden className="h-1.5 w-1.5 animate-breathe rounded-full bg-accent-bright" />
                  LIVE
                </span>
              </div>

              <div className="grid grid-cols-3 gap-3">
                <HeroVital label="Heart rate" value="72" unit="bpm" icon="favorite" tone="stable" />
                <HeroVital label="SpO₂" value="98" unit="%" icon="pulmonology" tone="stable" />
                <HeroVital label="Temp" value="36.8" unit="°C" icon="thermostat" tone="stable" />
              </div>

              {/* The assistant refusing to reassure. This is the most
                  convincing thing the product does, so it leads. */}
              <div className="mt-4 rounded-xl border border-white/10 bg-[#001945]/60 p-4">
                <p className="ml-auto w-fit max-w-[80%] rounded-2xl rounded-br-md bg-white/10 px-4 py-2.5 text-sm text-white">
                  I have chest pain going down my left arm
                </p>
                <div className="mt-3 rounded-lg border-2 border-[#ffb4ab] bg-[#ffb4ab]/10 px-4 py-3">
                  <p className="flex items-center gap-2 text-sm font-bold text-[#ffb4ab]">
                    <Icon name="emergency" filled className="text-[18px]" />
                    This may need emergency care
                  </p>
                  <p className="mt-1.5 text-sm leading-relaxed text-white/80">
                    Do not wait for a reply here. Call your local emergency number or go to the
                    nearest emergency department.
                  </p>
                </div>
                <p className="mt-3 border-t border-white/10 pt-3 text-[11px] leading-relaxed text-white/45">
                  This information is for preliminary guidance only and does not replace evaluation
                  by a licensed healthcare professional.
                </p>
              </div>
            </div>
          </div>
        </section>
      </div>

      <main id="main">
        {/* ================= PORTALS ================= */}
        <section className="mx-auto max-w-[1200px] px-5 py-20">
          <div className="max-w-2xl">
            <h2 className="text-3xl font-bold text-strong sm:text-4xl">One system, three doors</h2>
            <p className="mt-3 text-[17px] leading-relaxed text-muted">
              Everyone sees exactly what their job needs and nothing more. That is not a setting —
              it is how the system is built.
            </p>
          </div>

          <div className="mt-10 grid gap-5 md:grid-cols-3">
            {PORTALS.map((portal) => (
              <div
                key={portal.who}
                className="group rounded-xl border border-line bg-card p-6 shadow-card transition-shadow hover:shadow-overlay"
              >
                <span
                  aria-hidden
                  className="grid h-12 w-12 place-items-center rounded-xl bg-primary-soft"
                >
                  <Icon name={portal.icon} filled className="text-[24px] text-primary" />
                </span>
                <h3 className="mt-5 text-xl font-bold text-strong">{portal.who}</h3>
                <p className="mt-2 text-[15px] leading-relaxed text-muted">{portal.line}</p>
                <ul className="mt-5 space-y-2.5 border-t border-line pt-5">
                  {portal.points.map((point) => (
                    <li key={point} className="flex items-start gap-2.5 text-sm text-muted">
                      <Icon name="check" className="mt-0.5 text-[16px] text-accent" />
                      {point}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </section>

        {/* ================= CAPABILITIES ================= */}
        <section id="what" className="scroll-mt-4 border-y border-line bg-card">
          <div className="mx-auto max-w-[1200px] px-5 py-20">
            <div className="max-w-2xl">
              <h2 className="text-3xl font-bold text-strong sm:text-4xl">
                Everything a visit touches
              </h2>
              <p className="mt-3 text-[17px] leading-relaxed text-muted">
                Not a folder of features — one path a patient actually walks, from booking to
                paying, with the clinical safety built into each step rather than bolted on.
              </p>
            </div>

            <div className="mt-10 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
              {CAPABILITIES.map(([icon, title, body]) => (
                <div key={title} className="rounded-xl border border-line bg-canvas p-6">
                  <Icon name={icon} className="text-[26px] text-primary" />
                  <h3 className="mt-4 text-base font-bold text-strong">{title}</h3>
                  <p className="mt-2 text-[15px] leading-relaxed text-muted">{body}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ================= TRUST ================= */}
        <section className="mx-auto max-w-[1200px] px-5 py-20">
          <div className="grid gap-10 lg:grid-cols-[1fr_1.1fr] lg:items-center">
            <div>
              <h2 className="text-3xl font-bold text-strong sm:text-4xl">
                Built to be trusted with this
              </h2>
              <p className="mt-3 text-[17px] leading-relaxed text-muted">
                Specifics, because &ldquo;bank-grade security&rdquo; means nothing. Each of these
                is a property the system can be tested against, not a promise.
              </p>
              <div className="mt-7">
                <Cta href={primaryHref}>{primaryLabel}</Cta>
              </div>
            </div>

            <ul className="grid gap-4 sm:grid-cols-2">
              {[
                ["verified_user", "Only your care team", "A doctor sees your record because they treat you — not because they are a doctor."],
                ["fact_check", "Every access is logged", "The trail is append-only and hash-chained. Nobody can edit it, including us."],
                ["e911_emergency", "Emergencies are controlled", "Break-glass opens one chart, expires on a clock, and tells you it happened."],
                ["timer", "Signed out automatically", "On a shared hospital terminal, two minutes of inactivity ends the session."],
              ].map(([icon, title, body]) => (
                <li key={title} className="rounded-xl border border-line bg-card p-5 shadow-card">
                  <Icon name={icon} filled className="text-[22px] text-accent" />
                  <h3 className="mt-3 text-[15px] font-bold text-strong">{title}</h3>
                  <p className="mt-1.5 text-sm leading-relaxed text-muted">{body}</p>
                </li>
              ))}
            </ul>
          </div>
        </section>

        {/* ================= CLOSE ================= */}
        <section className="mx-auto max-w-[1200px] px-5 pb-24">
          <div className="relative overflow-hidden rounded-2xl bg-[#003178] px-8 py-16 text-center">
            <div
              aria-hidden
              className="pointer-events-none absolute -right-20 -top-20 h-72 w-72 rounded-full bg-[#006b5f] opacity-40 blur-[100px]"
            />
            <div
              aria-hidden
              className="pointer-events-none absolute -bottom-24 -left-16 h-72 w-72 rounded-full bg-[#0d47a1] opacity-60 blur-[100px]"
            />
            <div className="relative">
              <h2 className="text-3xl font-bold text-white sm:text-4xl">Ready when you are</h2>
              <p className="mx-auto mt-4 max-w-md text-[17px] leading-relaxed text-white/70">
                Takes about a minute. You can book your first appointment straight after.
              </p>
              <div className="mt-9 flex justify-center">
                <Cta href={primaryHref} variant="onDark">
                  {user ? "Go to your dashboard" : "Create your account"}
                  <Icon name="arrow_forward" className="text-[20px]" />
                </Cta>
              </div>
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t border-line bg-card">
        <div className="mx-auto flex max-w-[1200px] flex-wrap items-center gap-4 px-5 py-8">
          <Wordmark />
          <p className="text-sm text-faint">Smart Healthcare Management System</p>
          <Link
            href="/login"
            className="ml-auto text-sm font-semibold text-primary hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
          >
            Sign in
          </Link>
        </div>
      </footer>
    </div>
  );
}
