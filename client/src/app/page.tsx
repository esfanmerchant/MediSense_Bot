"use client";

/**
 * The front door.
 *
 * Most healthcare software sells to procurement: uptime, compliance badges,
 * charts going up. The person actually arriving here is usually worried about
 * something, and the psychology that works on them is not excitement — it is
 * *relief*. So the page is built around lowering effort and uncertainty:
 *
 * - the headline names their situation, not our capabilities;
 * - one primary action, repeated, never competing with a second;
 * - concrete answers to "what will this cost me" — no card, no calls, minutes;
 * - the AI is introduced with its limits attached, because a health product
 *   that oversells its intelligence loses trust the first time it is wrong.
 *
 * Warmth comes from space and rounding rather than illustration. A hospital
 * product that looks like a toy is not reassuring; one that looks like a
 * spreadsheet is not either.
 */

import Link from "next/link";
import type { ReactNode } from "react";

import { Loading } from "@/components/ui";
import { homePathFor, useSession } from "@/lib/session";

function Logo() {
  return (
    <span className="flex items-center gap-2">
      <span
        aria-hidden
        className="grid h-8 w-8 place-items-center rounded-lg bg-primary text-sm font-bold text-primary-on"
      >
        M
      </span>
      <span className="text-lg font-semibold tracking-tight text-strong">MediSense</span>
    </span>
  );
}

/** The one action on the page. Everything else is a link. */
function PrimaryAction({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link
      href={href}
      className="inline-flex min-h-12 items-center justify-center rounded-lg bg-primary px-6 text-base font-semibold text-primary-on shadow-card transition-colors hover:bg-primary-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
    >
      {children}
    </Link>
  );
}

function Card({
  title,
  children,
  accent,
}: {
  title: string;
  children: ReactNode;
  accent?: boolean;
}) {
  return (
    <div
      className={`rounded-2xl border p-6 shadow-card ${
 accent ? "border-accent/30 bg-accent-soft/30" : "border-line bg-card"
      }`}
    >
      <h3 className="text-base font-semibold text-strong">{title}</h3>
      <p className="mt-2 text-[15px] leading-relaxed text-muted">{children}</p>
    </div>
  );
}

const AUDIENCES = [
  {
    who: "Patients",
    line: "Book a visit, read your own history, ask a question at 2am.",
    points: ["Appointments and reminders", "Records, prescriptions, invoices", "Health assistant"],
  },
  {
    who: "Doctors",
    line: "Your patients, your alerts, your notes — one screen, not six.",
    points: ["Live vital alerts", "Charts and prescribing", "Consultation notes"],
  },
  {
    who: "Administrators",
    line: "Run the hospital without reading anyone's diagnosis.",
    points: ["Scheduling and staff", "Billing and invoices", "Audit trail"],
  },
];

export default function Home() {
  const { user, loading } = useSession();

  return (
    <div className="min-h-screen bg-canvas">
      {/* --- Top bar ------------------------------------------------------ */}
      <header className="border-b border-line bg-card/80 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center gap-4 px-5 py-4">
          <Logo />
          <nav aria-label="Primary" className="ml-auto flex items-center gap-2">
            {loading ? (
              <span className="text-sm text-faint">…</span>
            ) : user ? (
              <PrimaryAction href={homePathFor(user.role)}>Go to your dashboard</PrimaryAction>
            ) : (
              <>
                <Link
                  href="/login"
                  className="inline-flex min-h-11 items-center rounded-lg px-4 text-sm font-medium text-muted hover:bg-sunken focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                >
                  Sign in
                </Link>
                <PrimaryAction href="/login">Get started</PrimaryAction>
              </>
            )}
          </nav>
        </div>
      </header>

      <main id="main">
        {/* --- Hero ------------------------------------------------------- */}
        <section className="mx-auto max-w-6xl px-5 pb-16 pt-20 sm:pt-28">
          <div className="max-w-2xl">
            <p className="inline-flex items-center gap-2 rounded-full bg-accent-soft px-3 py-1 text-xs font-semibold tracking-wide text-accent-strong">
              <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-accent-strong" />
              SMART HEALTHCARE MANAGEMENT
            </p>

            {/* Their situation, not our feature list. */}
            <h1 className="mt-6 text-4xl font-bold leading-[1.1] text-strong sm:text-5xl">
              Your health records, appointments and answers — in one calm place.
            </h1>

            <p className="mt-5 text-lg leading-relaxed text-muted">
              No phone queues. No paper folders. Book a visit in under a minute, see everything your
              care team sees about you, and get a straight answer when something worries you.
            </p>

            <div className="mt-8 flex flex-wrap items-center gap-3">
              <PrimaryAction href="/login">
                {user ? "Go to your dashboard" : "Get started — it's free"}
              </PrimaryAction>
              <a
                href="#how"
                className="inline-flex min-h-12 items-center rounded-lg px-5 text-base font-medium text-muted hover:bg-sunken focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
              >
                See how it works
              </a>
            </div>

            {/* Answers the three objections that stop someone signing up, in
                the order they occur to them. */}
            <p className="mt-5 text-sm text-faint">
              No card needed · No phone calls · Your data stays yours
            </p>
          </div>
        </section>

        {/* --- The three portals ------------------------------------------ */}
        <section className="border-y border-line bg-card">
          <div className="mx-auto max-w-6xl px-5 py-16">
            <h2 className="text-2xl font-bold text-strong">One system, three doors</h2>
            <p className="mt-2 max-w-2xl text-[15px] leading-relaxed text-muted">
              Everyone sees exactly what their job needs and nothing more. That is not a setting —
              it is how the system is built.
            </p>

            <div className="mt-8 grid gap-5 md:grid-cols-3">
              {AUDIENCES.map((audience) => (
                <div
                  key={audience.who}
                  className="rounded-2xl border border-line bg-canvas p-6 shadow-card"
                >
                  <h3 className="text-lg font-semibold text-strong">{audience.who}</h3>
                  <p className="mt-1.5 text-[15px] leading-relaxed text-muted">{audience.line}</p>
                  <ul className="mt-4 space-y-2">
                    {audience.points.map((point) => (
                      <li key={point} className="flex items-start gap-2 text-sm text-muted">
                        <span aria-hidden className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
                        {point}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* --- How it works ----------------------------------------------- */}
        <section id="how" className="mx-auto max-w-6xl scroll-mt-8 px-5 py-16">
          <h2 className="text-2xl font-bold text-strong">Three steps, then you are done</h2>

          <ol className="mt-8 grid gap-5 md:grid-cols-3">
            {[
              ["Create your account", "Name, email, a password. Nothing else, and nothing sold."],
              ["Pick a time that suits you", "Real availability from real calendars — no double bookings, no callbacks."],
              ["Everything follows you", "Notes, prescriptions, results and invoices land in one place as they happen."],
            ].map(([title, body], index) => (
              <li key={title} className="rounded-2xl border border-line bg-card p-6 shadow-card">
                {/* Numbered because this genuinely is a sequence — the reader
                    needs to know there are only three and where they are. */}
                <span
                  aria-hidden
                  className="grid h-8 w-8 place-items-center rounded-full bg-primary-soft text-sm font-bold text-primary"
                >
                  {index + 1}
                </span>
                <h3 className="mt-4 text-base font-semibold text-strong">{title}</h3>
                <p className="mt-2 text-[15px] leading-relaxed text-muted">{body}</p>
              </li>
            ))}
          </ol>
        </section>

        {/* --- The assistant, sold honestly -------------------------------- */}
        <section className="border-y border-line bg-card">
          <div className="mx-auto grid max-w-6xl gap-8 px-5 py-16 md:grid-cols-2 md:items-center">
            <div>
              <h2 className="text-2xl font-bold text-strong">
                An assistant that knows when to stop talking
              </h2>
              <p className="mt-3 text-[15px] leading-relaxed text-muted">
                Ask what a tablet is for, which department to see, or whether something can wait. It
                answers in plain language using your own prescriptions and appointments.
              </p>
              <p className="mt-3 text-[15px] leading-relaxed text-muted">
                And when what you describe sounds serious, it stops being helpful and tells you to
                get seen — immediately, before anything else.
              </p>
              <p className="mt-4 text-sm text-faint">
                It does not diagnose, and it never replaces your doctor.
              </p>
            </div>

            {/* A worked example rather than a claim. Showing the escalation is
                more persuasive than promising it, and it sets the expectation
                the product actually meets. */}
            <div className="rounded-2xl border border-line bg-canvas p-5 shadow-card">
              <p className="ml-auto w-fit max-w-[85%] rounded-2xl bg-primary-soft px-4 py-2.5 text-[15px] text-strong">
                I have chest pain going down my left arm
              </p>
              <div className="mt-3 rounded-xl border-2 border-critical bg-critical-soft px-4 py-3">
                <p className="text-sm font-semibold text-critical">This may need emergency care</p>
                <p className="mt-1 text-sm text-strong">
                  Do not wait for a reply here. Call your local emergency number or go to the
                  nearest emergency department.
                </p>
              </div>
              <p className="mt-3 border-t border-line pt-3 text-xs text-faint">
                This information is for preliminary guidance only and does not replace evaluation by
                a licensed healthcare professional.
              </p>
            </div>
          </div>
        </section>

        {/* --- Trust ------------------------------------------------------- */}
        <section className="mx-auto max-w-6xl px-5 py-16">
          <h2 className="text-2xl font-bold text-strong">Built to be trusted with this</h2>
          <p className="mt-2 max-w-2xl text-[15px] leading-relaxed text-muted">
            Specifics, because &ldquo;bank-grade security&rdquo; means nothing.
          </p>

          <div className="mt-8 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
            <Card title="Only your care team">
              A doctor sees your record because they treat you — not because they are a doctor.
            </Card>
            <Card title="Every access is logged">
              The trail is append-only and tamper-evident. Nobody can edit it, including us.
            </Card>
            <Card title="Emergencies are controlled">
              Break-glass access opens one chart, expires on a clock, and tells you it happened.
            </Card>
            <Card title="Signed out automatically" accent>
              On a shared hospital terminal, two minutes of inactivity ends the session.
            </Card>
          </div>
        </section>

        {/* --- Close ------------------------------------------------------- */}
        <section className="mx-auto max-w-6xl px-5 pb-24">
          <div className="rounded-3xl bg-primary px-8 py-14 text-center shadow-overlay">
            <h2 className="text-3xl font-bold text-primary-on">Ready when you are</h2>
            <p className="mx-auto mt-3 max-w-lg text-[15px] leading-relaxed text-primary-on/85">
              Takes about a minute. You can book your first appointment straight after.
            </p>
            <div className="mt-8">
              <Link
                href="/login"
                className="inline-flex min-h-12 items-center justify-center rounded-lg bg-card px-7 text-base font-semibold text-primary shadow-card transition-transform hover:scale-[1.02] focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-primary-on"
              >
                {user ? "Go to your dashboard" : "Create your account"}
              </Link>
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t border-line bg-card">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-4 px-5 py-8">
          <Logo />
          <p className="text-sm text-faint">Smart Healthcare Management System</p>
          <Link
            href="/login"
            className="ml-auto text-sm font-medium text-primary hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
          >
            Sign in
          </Link>
        </div>
      </footer>

      {/* Only while the session is resolving — the page is fully readable
          without it, so it never blocks the content behind a spinner. */}
      {loading && (
        <div className="sr-only">
          <Loading label="Checking your session" />
        </div>
      )}
    </div>
  );
}
