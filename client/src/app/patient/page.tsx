"use client";

/**
 * The patient's front door.
 *
 * Ordered by what a person opens the portal to find out: is anything coming
 * up, what am I taking, and — one box away — a question they have been
 * carrying. Everything else is a door, not a wall of data.
 */

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import { AppShell } from "@/components/AppShell";
import { Icon } from "@/components/Icon";
import { PageHeader } from "@/components/PageHeader";
import {
  Avatar,
  Badge,
  Card,
  EmptyState,
  ErrorState,
  QuickAction,
  SkeletonRows,
  SkeletonTiles,
  StatTile,
} from "@/components/ui";
import { dashboard } from "@/lib/api";
import { useLang, useTr } from "@/lib/lang";
import { useSession } from "@/lib/session";
import { useAsync } from "@/lib/useAsync";

const DAY_MS = 86_400_000;

function formatDateTime(iso: string, locale: string | undefined): string {
  return new Date(iso).toLocaleString(locale, {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** "Today", "Tomorrow", "in 4 days" — the way people actually think about it. */
function relativeDay(iso: string, tr: (en: string, ur: string) => string): string {
  const start = new Date(iso);
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const days = Math.floor((start.getTime() - startOfToday.getTime()) / DAY_MS);
  if (days <= 0) return tr("Today", "Aaj");
  if (days === 1) return tr("Tomorrow", "Kal");
  return tr(`In ${days} days`, `${days} din mein`);
}

function greeting(tr: (en: string, ur: string) => string): string {
  const hour = new Date().getHours();
  if (hour < 12) return tr("Good morning", "Subah bakhair");
  if (hour < 17) return tr("Good afternoon", "Dopahar bakhair");
  return tr("Good evening", "Shaam bakhair");
}

/** The welcome strip: who, when, what is next, and a box to ask a question. */
function Welcome({
  name,
  next,
}: {
  name: string;
  next: { startTime: string; doctor: string } | null;
}) {
  const tr = useTr();
  const lang = useLang();
  const router = useRouter();
  const [question, setQuestion] = useState("");
  const firstName = name.split(/\s+/)[0] ?? name;

  const ask = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = question.trim();
    router.push(trimmed ? `/patient/assistant?q=${encodeURIComponent(trimmed)}` : "/patient/assistant");
  };

  return (
    <section className="hero-navy relative overflow-hidden rounded-3xl p-6 text-white shadow-float sm:p-8">
      {/* A quiet ECG trace along the bottom edge — the building's own pulse. */}
      <svg
        aria-hidden
        viewBox="0 0 640 60"
        preserveAspectRatio="none"
        className="pointer-events-none absolute inset-x-0 bottom-0 h-14 w-full opacity-30"
        fill="none"
        stroke="#8df5e4"
        strokeWidth="1.5"
        strokeLinejoin="round"
      >
        <path
          className="animate-ecg"
          d="M0 40 H140 L152 40 L160 14 L172 54 L182 40 H300 L308 30 L316 40 H440 L452 40 L460 12 L472 56 L482 40 H640"
        />
      </svg>

      <div className="relative grid gap-6 lg:grid-cols-[1.3fr_1fr] lg:items-center">
        <div>
          <p className="text-sm font-medium text-white/70">
            {new Date().toLocaleDateString(lang === "ur" ? "en-PK" : undefined, {
              weekday: "long",
              day: "numeric",
              month: "long",
            })}
          </p>
          <h2 className="mt-1 font-display text-3xl font-bold leading-tight sm:text-4xl">
            {greeting(tr)}, <span className="text-gradient-medical">{firstName}</span>
          </h2>
          <p className="mt-3 max-w-lg text-[15px] leading-relaxed text-white/80">
            {next
              ? tr(
                  `Your next visit is ${relativeDay(next.startTime, tr).toLowerCase()} with ${next.doctor}.`,
                  `Aap ki agli visit ${relativeDay(next.startTime, tr).toLowerCase()} ${next.doctor} ke saath hai.`,
                )
              : tr(
                  "Nothing is booked right now. When something needs looking at, booking takes a minute.",
                  "Filhaal kuchh book nahi hai. Jab kuchh dikhana ho to booking ek minute ka kaam hai.",
                )}
          </p>
        </div>

        <form onSubmit={ask} className="glass-dark rounded-2xl p-4">
          <label htmlFor="dashboard-ask" className="flex items-center gap-2 text-sm font-semibold">
            <Icon name="auto_awesome" className="text-[18px] text-accent-bright" />
            {tr("Ask the health assistant", "Health assistant se poochein")}
          </label>
          <div className="mt-2.5 flex gap-2">
            <input
              id="dashboard-ask"
              value={question}
              maxLength={2000}
              onChange={(event) => setQuestion(event.target.value)}
              placeholder={tr("What is my tablet for?", "Meri goli kis liye hai?")}
              className="min-h-11 min-w-0 flex-1 rounded-xl border border-white/20 bg-white/10 px-3 text-base text-white placeholder:text-white/50 focus:border-accent-bright focus:outline-none"
            />
            <button
              type="submit"
              aria-label={tr("Ask", "Poochein")}
              className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-accent-bright text-[#00201c] transition-transform hover:scale-105 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
            >
              <Icon name="arrow_forward" className="text-[22px]" />
            </button>
          </div>
          <p className="mt-2 text-[11px] text-white/55">
            {tr("Guidance, not a diagnosis. You can also attach a photo of a report.", "Rehnumai, tashkhees nahi. Report ki tasveer bhi laga sakte hain.")}
          </p>
        </form>
      </div>
    </section>
  );
}

export default function PatientDashboard() {
  const { data, error, loading, reload } = useAsync(() => dashboard.patient());
  const { user } = useSession();
  const tr = useTr();
  const lang = useLang();
  const locale = lang === "ur" ? "en-PK" : undefined;

  const next = data?.upcomingAppointments[0]
    ? { startTime: data.upcomingAppointments[0].startTime, doctor: data.upcomingAppointments[0].doctor.name }
    : null;

  return (
    <AppShell role="PATIENT">
      <div id="main" className="space-y-6">
        <PageHeader
          eyebrow={tr("Patient portal", "Mareez ka portal")}
          title={tr("Your health", "Aap ki sehat")}
          subtitle={tr(
            "Appointments, prescriptions, reports and billing — all in one place.",
            "Appointments, nuskhe, reports aur billing — sab kuchh ek jagah.",
          )}
        />

        {user && <Welcome name={user.name} next={next} />}

        <div className="stagger grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <QuickAction
            href="/patient/appointments"
            icon="calendar_add_on"
            title={tr("Book a visit", "Visit book karein")}
            description={tr("Pick a doctor and a time", "Doctor aur waqt chunein")}
          />
          <QuickAction
            href="/patient/assistant"
            icon="smart_toy"
            tone="accent"
            title={tr("Ask the assistant", "Assistant se poochein")}
            description={tr("Prescriptions, reports, departments", "Nuskhe, reports, departments")}
          />
          <QuickAction
            href="/patient/documents"
            icon="upload_file"
            title={tr("Upload a report", "Report upload karein")}
            description={tr("Keep every result in one file", "Har nateeja ek file mein")}
          />
          <QuickAction
            href="/patient/vitals"
            icon="monitor_heart"
            tone="accent"
            title={tr("See your vitals", "Apne vitals dekhein")}
            description={tr("Readings from your care team", "Care team ki readings")}
          />
        </div>

        {loading && (
          <>
            <SkeletonTiles />
            <div className="grid gap-6 lg:grid-cols-2">
              <SkeletonRows />
              <SkeletonRows />
            </div>
          </>
        )}
        {error && <ErrorState message={error.message} onRetry={reload} />}

        {data && (
          <>
            <div className="stagger grid grid-cols-2 gap-4 lg:grid-cols-4">
              <StatTile
                label={tr("Upcoming appointments", "Aane wali appointments")}
                value={data.counts.upcomingAppointments ?? 0}
                icon={<Icon name="calendar_today" />}
                href="/patient/appointments"
              />
              <StatTile
                label={tr("Active prescriptions", "Chalu nuskhe")}
                value={data.counts.activePrescriptions ?? 0}
                icon={<Icon name="pill" />}
                href="/patient/records"
              />
              <StatTile
                label={tr("Documents", "Documents")}
                value={data.counts.documents ?? 0}
                icon={<Icon name="folder_open" />}
                href="/patient/documents"
              />
              <StatTile
                label={tr("Unpaid invoices", "Baqaya invoices")}
                value={data.counts.unpaidInvoices ?? 0}
                tone={data.counts.unpaidInvoices ? "warning" : "neutral"}
                icon={<Icon name="receipt_long" />}
                href="/patient/billing"
              />
            </div>

            <div className="grid gap-6 lg:grid-cols-2">
              <Card
                icon="event_upcoming"
                title={tr("Next appointments", "Agli appointments")}
                description={tr("Your confirmed and requested visits.", "Aap ki confirm aur requested visits.")}
              >
                {data.upcomingAppointments.length === 0 ? (
                  <EmptyState
                    icon="event_available"
                    title={tr("No upcoming appointments", "Koi aane wali appointment nahi")}
                    description={tr("When you book a visit it will appear here.", "Jab aap visit book karenge to yahan nazar aayegi.")}
                  />
                ) : (
                  <ul className="stagger divide-y divide-line">
                    {data.upcomingAppointments.map((appointment, index) => (
                      <li key={appointment.id} className="flex items-center gap-4 py-3.5">
                        <Avatar name={appointment.doctor.name} />
                        <div className="min-w-0 flex-1">
                          <p className="font-semibold text-strong">{appointment.doctor.name}</p>
                          <p className="truncate text-sm text-muted">
                            {appointment.doctor.specialization}
                            {appointment.reason ? ` · ${appointment.reason}` : ""}
                          </p>
                        </div>
                        <div className="shrink-0 text-right">
                          <p className="text-sm font-semibold tabular-nums text-strong">
                            {formatDateTime(appointment.startTime, locale)}
                          </p>
                          <div className="mt-1 flex items-center justify-end gap-1.5">
                            {index === 0 && (
                              <span className="text-xs font-semibold text-accent">
                                {relativeDay(appointment.startTime, tr)}
                              </span>
                            )}
                            <Badge tone={appointment.status === "CONFIRMED" ? "good" : "info"}>
                              {appointment.status === "CONFIRMED"
                                ? tr("confirmed", "confirmed")
                                : tr("requested", "requested")}
                            </Badge>
                          </div>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>

              <Card
                icon="pill"
                title={tr("Current medication", "Maujooda dawa")}
                description={tr(
                  "Prescribed by your care team. Always follow the instructions on the label.",
                  "Aap ki care team ki tajweez kardah. Hamesha label ki hidayat par amal karein.",
                )}
              >
                {data.activePrescriptions.length === 0 ? (
                  <EmptyState
                    icon="pill_off"
                    title={tr("No active prescriptions", "Koi chalu nuskha nahi")}
                  />
                ) : (
                  <ul className="stagger space-y-3">
                    {data.activePrescriptions.map((prescription) => (
                      <li
                        key={prescription.id}
                        className="flex items-start gap-3 rounded-xl border border-line bg-sunken/60 p-3"
                      >
                        <span
                          aria-hidden
                          className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-accent-soft text-accent"
                        >
                          <Icon name="medication" filled className="text-[22px]" />
                        </span>
                        <div className="min-w-0">
                          <p className="font-semibold text-strong">
                            {prescription.medication}{" "}
                            <span className="font-normal text-muted">· {prescription.dosage}</span>
                          </p>
                          <p className="mt-0.5 text-sm text-muted">
                            {prescription.frequency} · {prescription.duration}
                          </p>
                          <p className="mt-0.5 text-xs text-faint">
                            {tr("Prescribed by", "Tajweez kardah")} {prescription.prescribedBy}
                          </p>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            </div>
          </>
        )}
      </div>
    </AppShell>
  );
}
