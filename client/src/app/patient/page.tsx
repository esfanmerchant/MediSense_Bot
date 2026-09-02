"use client";

/**
 * The patient's front door.
 *
 * Ordered by what a person opens the portal to find out: is anything coming
 * up, what am I taking, and — one box away — a question they have been
 * carrying. Everything else is a door, not a wall of data.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";

import { AppShell } from "@/components/AppShell";
import { CircuitNodes } from "@/components/brand/CircuitNodes";
import { Icon } from "@/components/Icon";
import { PageHeader } from "@/components/PageHeader";
import { Section } from "@/components/layout/PageSectionNav";
import {
  Avatar,
  Badge,
  Button,
  Card,
  Checkbox,
  EmptyState,
  ErrorState,
  QuickAction,
  SkeletonRows,
  SkeletonTiles,
  StatTile,
  cx,
} from "@/components/ui";
import { VitalGauge } from "@/components/gauges";
import {
  dashboard,
  documents,
  vitals,
  type MedicalDocument,
  type Vital,
  type VitalThreshold,
  type VitalType,
} from "@/lib/api";
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

/**
 * How long until an appointment, counted down live.
 *
 * Starts empty and fills in from an effect: the first paint happens on the
 * server, where "in 3 hours" would be three hours out of date by the time
 * anyone read it, and a mismatched first render is a hydration error.
 *
 * Minutes are the smallest unit shown. A visit is not a rocket launch, and a
 * second-by-second counter next to a doctor's name reads as an alarm.
 */
function useCountdown(iso: string): string | null {
  const tr = useTr();
  const [label, setLabel] = useState<string | null>(null);

  useEffect(() => {
    const tick = () => {
      const minutes = Math.round((new Date(iso).getTime() - Date.now()) / 60_000);
      if (Number.isNaN(minutes)) return setLabel(null);
      if (minutes <= 0) return setLabel(tr("Now", "Abhi"));
      if (minutes < 60) return setLabel(tr(`In ${minutes} min`, `${minutes} minute mein`));
      const hours = Math.floor(minutes / 60);
      if (hours < 24) {
        const rest = minutes % 60;
        return setLabel(
          rest
            ? tr(`In ${hours}h ${rest}m`, `${hours} ghante ${rest} minute mein`)
            : tr(`In ${hours}h`, `${hours} ghante mein`),
        );
      }
      const days = Math.floor(hours / 24);
      return setLabel(
        tr(`In ${days}d ${hours % 24}h`, `${days} din ${hours % 24} ghante mein`),
      );
    };
    tick();
    const timer = window.setInterval(tick, 30_000);
    return () => window.clearInterval(timer);
  }, [iso, tr]);

  return label;
}

const VITALS: { key: keyof Vital; type: VitalType; unit: string; name: [string, string] }[] = [
  { key: "heartRate", type: "HEART_RATE", unit: "bpm", name: ["Heart rate", "Dil ki raftar"] },
  { key: "systolicBp", type: "SYSTOLIC_BP", unit: "mmHg", name: ["Systolic", "Systolic"] },
  { key: "diastolicBp", type: "DIASTOLIC_BP", unit: "mmHg", name: ["Diastolic", "Diastolic"] },
  { key: "oxygenSaturation", type: "OXYGEN_SATURATION", unit: "%", name: ["Oxygen", "Oxygen"] },
  { key: "temperature", type: "TEMPERATURE", unit: "°C", name: ["Temperature", "Bukhar"] },
  { key: "respiratoryRate", type: "RESPIRATORY_RATE", unit: "/min", name: ["Breathing", "Saans"] },
];

/**
 * The patient's latest readings as friendly dials, against the thresholds
 * that actually govern them. Rendered only when there is something to show:
 * a row of empty gauges would be a row of worries.
 */
function HealthSnapshot({ patientId }: { patientId: string }) {
  const tr = useTr();
  // Audited on the server as a record access, so it catches up when the reader
  // comes back rather than on a timer. See the note in lib/useAsync.ts.
  const readings = useAsync(() => vitals.list(patientId, { limit: 30 }), [patientId], {
    live: "on-return",
  });
  const thresholds = useAsync(() => vitals.thresholds(patientId), [patientId]);

  if (readings.loading || thresholds.loading) {
    return <SkeletonRows rows={2} />;
  }
  const rows = readings.data?.data ?? [];
  const rules = new Map<VitalType, VitalThreshold>(
    (thresholds.data?.thresholds ?? []).map((rule) => [rule.vitalType, rule]),
  );
  const latest = VITALS.flatMap((vital) => {
    const reading = rows.find((row) => row[vital.key] !== null);
    return reading
      ? [{ vital, value: reading[vital.key] as number, recordedAt: reading.recordedAt }]
      : [];
  });
  if (latest.length === 0) return null;

  return (
    <Card
      icon="monitor_heart"
      title={tr("Health snapshot", "Sehat ka khulasa")}
      description={tr(
        "Your latest readings, recorded by your care team.",
        "Aap ki taaza readings, care team ki darj ki hui.",
      )}
      action={
        <Link
          href="/patient/vitals"
          className="inline-flex min-h-10 items-center gap-1 text-sm font-semibold text-primary hover:underline"
        >
          {tr("All readings", "Sab readings")}
          <Icon name="arrow_forward" className="text-[18px]" />
        </Link>
      }
    >
      <div className="stagger grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
        {latest.map(({ vital, value, recordedAt }) => {
          const rule = rules.get(vital.type);
          return (
            <VitalGauge
              key={vital.type}
              type={vital.type}
              label={tr(...vital.name)}
              value={value}
              unit={vital.unit}
              min={rule?.minValue ?? null}
              max={rule?.maxValue ?? null}
              recordedAt={recordedAt}
            />
          );
        })}
      </div>
    </Card>
  );
}

type UpcomingAppointment = {
  id: string;
  startTime: string;
  status: string;
  reason: string | null;
  doctor: { id: string; name: string; specialization: string };
};

/**
 * The very next visit, pulled out of the list and given the gradient border.
 *
 * One appointment is the answer to the question most people open this page
 * with, and a row in a list of four is not an answer. The countdown beside it
 * is the part a date alone cannot say: whether to leave now.
 */
function NextVisit({
  appointment,
  locale,
}: {
  appointment: UpcomingAppointment;
  locale: string | undefined;
}) {
  const tr = useTr();
  const countdown = useCountdown(appointment.startTime);

  return (
    <div className="border-gradient rounded-2xl p-4 shadow-card sm:p-5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="mono-caps text-[10px] text-faint">{tr("Next visit", "Agli visit")}</span>
        <span className="bg-gradient-brand inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-bold text-white shadow-sm">
          <Icon name="schedule" className="text-[13px]" />
          {countdown ?? relativeDay(appointment.startTime, tr)}
        </span>
        <span className="ml-auto">
          <Badge tone={appointment.status === "CONFIRMED" ? "good" : "info"}>
            {appointment.status === "CONFIRMED"
              ? tr("confirmed", "confirmed")
              : tr("requested", "requested")}
          </Badge>
        </span>
      </div>

      <div className="mt-3 flex items-center gap-4">
        <Avatar name={appointment.doctor.name} size="lg" ring="active" />
        <div className="min-w-0 flex-1">
          <p className="font-display text-lg font-bold text-strong">{appointment.doctor.name}</p>
          <p className="truncate text-sm text-muted">
            {appointment.doctor.specialization}
            {appointment.reason ? ` · ${appointment.reason}` : ""}
          </p>
          <p className="mt-1 text-sm font-semibold tabular-nums text-strong">
            {formatDateTime(appointment.startTime, locale)}
          </p>
        </div>
      </div>
    </div>
  );
}

/**
 * The latest uploaded report, with one button on it: ask what it says.
 *
 * The question is composed here and carried to the assistant as `?q=`, so the
 * patient lands on the composer with it already typed rather than having to
 * describe the document they were just looking at.
 */
function ExplainLatestReport({ patientId }: { patientId: string }) {
  const tr = useTr();
  const lang = useLang();
  const list = useAsync(() => documents.list({ patientId, limit: 10 }), [patientId]);

  const latest: MedicalDocument | undefined = (list.data?.data ?? []).find(
    (document) => document.documentType !== "PROFILE_IMAGE",
  );
  if (list.loading || !latest) return null;

  const name = latest.title ?? latest.fileName;
  const question =
    lang === "ur"
      ? `Meri report "${name}" mein kya likha hai? Aasan alfaz mein samjhayein.`
      : `What does my report "${name}" say? Please explain it in plain words.`;

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-line bg-card p-3 shadow-card">
      <span
        aria-hidden
        className="bg-gradient-soft grid h-10 w-10 shrink-0 place-items-center rounded-xl text-primary"
      >
        <Icon name="description" className="text-[22px]" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="mono-caps text-[10px] text-faint">{tr("Latest report", "Taaza report")}</p>
        <p className="truncate text-sm font-semibold text-strong">{name}</p>
      </div>
      <Link
        href={`/patient/assistant?q=${encodeURIComponent(question)}`}
        className="btn-outline inline-flex min-h-10 shrink-0 items-center gap-1.5 rounded-xl px-3.5 text-sm font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
      >
        <Icon name="auto_awesome" className="text-[18px]" />
        {tr("Explain", "Samjhayein")}
      </Link>
    </div>
  );
}

type ActivePrescription = {
  id: string;
  medication: string;
  dosage: string;
  frequency: string;
  duration: string;
  prescribedBy: string;
};

/**
 * Today's medication, with a box to tick beside each one.
 *
 * **The ticks are a reminder, not a record.** Nothing is sent anywhere, nothing
 * is stored, and they are gone on reload — so the panel says exactly that above
 * the list. A checkbox in a medical portal that silently looked like adherence
 * data would be worse than no checkbox: a doctor could read it as evidence a
 * dose was taken, when all it ever was is a person keeping their place.
 */
function MedicationChecklist({ prescriptions }: { prescriptions: ActivePrescription[] }) {
  const tr = useTr();
  const [taken, setTaken] = useState<string[]>([]);

  const toggle = (id: string) =>
    setTaken((current) =>
      current.includes(id) ? current.filter((value) => value !== id) : [...current, id],
    );

  return (
    <>
      <p className="mb-3 flex items-start gap-1.5 rounded-xl bg-sunken/70 px-3 py-2 text-xs text-muted">
        <Icon name="lock" className="mt-px shrink-0 text-[14px] text-faint" />
        {tr(
          `Tick these off as you go — a checklist for you alone. Nothing is sent or saved, and it clears when you leave. ${taken.length} of ${prescriptions.length} ticked today.`,
          `Jaise jaise lein, tick karte jayein — yeh sirf aap ke liye hai. Kuchh bheja ya save nahi hota, aur page chhorte hi khali ho jata hai. Aaj ${prescriptions.length} mein se ${taken.length} tick hue.`,
        )}
      </p>
      <ul className="stagger space-y-3">
        {prescriptions.map((prescription) => {
          const ticked = taken.includes(prescription.id);
          return (
            <li
              key={prescription.id}
              className={cx(
                "flex items-start gap-3 rounded-xl border p-3 transition-[background-color,border-color,opacity] duration-200",
                ticked ? "border-stable/40 bg-stable-soft/50" : "border-line bg-sunken/60",
              )}
            >
              <span
                aria-hidden
                className={cx(
                  "grid h-10 w-10 shrink-0 place-items-center rounded-xl transition-colors",
                  ticked ? "bg-stable-soft text-stable" : "bg-accent-soft text-accent",
                )}
              >
                <Icon name={ticked ? "check" : "medication"} filled className="text-[22px]" />
              </span>
              <div className={cx("min-w-0 flex-1", ticked && "opacity-70")}>
                <Checkbox
                  checked={ticked}
                  onChange={() => toggle(prescription.id)}
                  label={
                    <span className={cx("font-semibold text-strong", ticked && "line-through")}>
                      {prescription.medication}{" "}
                      <span className="font-normal text-muted">· {prescription.dosage}</span>
                    </span>
                  }
                />
                <p className="mt-0.5 pl-8 text-sm text-muted">
                  {prescription.frequency} · {prescription.duration}
                </p>
                <p className="mt-0.5 pl-8 text-xs text-faint">
                  {tr("Prescribed by", "Tajweez kardah")} {prescription.prescribedBy}
                </p>
              </div>
            </li>
          );
        })}
      </ul>
    </>
  );
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
    <section className="bg-gradient-brand relative overflow-hidden rounded-3xl p-6 text-white shadow-float sm:p-8">
      {/* The logo's circuit traces, faint, fading out of the top-right corner:
          an accent on the brand ground, not wallpaper across it. */}
      <CircuitNodes
        density="low"
        tone="white"
        className="[mask-image:radial-gradient(65%_70%_at_88%_12%,black,transparent)]"
      />

      {/* A quiet ECG trace along the bottom edge — the building's own pulse. */}
      <svg
        aria-hidden
        viewBox="0 0 640 60"
        preserveAspectRatio="none"
        className="pointer-events-none absolute inset-x-0 bottom-0 h-14 w-full opacity-30"
        fill="none"
        stroke="#FFFFFF"
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
            {greeting(tr)}, <span className="text-gradient-medical">{firstName}</span>{" "}
            <span aria-hidden className="animate-wave">👋</span>
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
              className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-accent-bright text-[#053B38] transition-transform hover:scale-105 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
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


        <Section id="welcome">
          {user && <Welcome name={user.name} next={next} />}
        </Section>

        <Section id="quick-actions" className="stagger grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
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
            description={tr("Prescriptions, reports, history", "Nuskhe, reports, tareekh")}
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
        </Section>

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
            <Section
              id="at-a-glance"
              className="stagger grid grid-cols-2 gap-4 lg:grid-cols-4"
            >
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
            </Section>

            <Section id="snapshot">
              {user?.patientId && <HealthSnapshot patientId={user.patientId} />}
            </Section>
            <Section id="latest-report">
              {user?.patientId && <ExplainLatestReport patientId={user.patientId} />}
            </Section>

            <div className="grid gap-6 lg:grid-cols-2">
              <Section id="appointments">
              <Card
                icon="event_upcoming"
                variant={data.upcomingAppointments.length > 0 ? "featured" : "default"}
                title={tr("Next appointments", "Agli appointments")}
                description={tr("Your confirmed and requested visits.", "Aap ki confirm aur requested visits.")}
              >
                {data.upcomingAppointments.length === 0 ? (
                  <EmptyState
                    icon="event_available"
                    title={tr("No upcoming appointments", "Koi aane wali appointment nahi")}
                    description={tr("When you book a visit it will appear here.", "Jab aap visit book karenge to yahan nazar aayegi.")}
                    action={
                      <Link href="/patient/appointments">
                        <Button>
                          <Icon name="calendar_add_on" className="text-[20px]" />
                          {tr("Book your first appointment", "Apni pehli appointment book karein")}
                        </Button>
                      </Link>
                    }
                  />
                ) : (
                  <div className="space-y-4">
                    <NextVisit appointment={data.upcomingAppointments[0]} locale={locale} />

                    {data.upcomingAppointments.length > 1 && (
                      <ul className="stagger divide-y divide-line border-t border-line">
                        {data.upcomingAppointments.slice(1).map((appointment) => (
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
                  </div>
                )}
              </Card>
              </Section>

              <Section id="medication">
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
                  <MedicationChecklist prescriptions={data.activePrescriptions} />
                )}
              </Card>
              </Section>
            </div>
          </>
        )}
      </div>
    </AppShell>
  );
}
