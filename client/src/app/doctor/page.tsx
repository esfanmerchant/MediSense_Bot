"use client";

/**
 * The doctor's day.
 *
 * Alerts before anything else: a threshold breach is the one thing on this
 * page that is time-critical (R1). The clinic list follows, and the numbers
 * across the top are doors to the pages behind them.
 */

import Link from "next/link";
import { useEffect, useState } from "react";

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
  cx,
} from "@/components/ui";
import { dashboard } from "@/lib/api";
import { useLang, useTr } from "@/lib/lang";
import { useSession } from "@/lib/session";
import { useAsync } from "@/lib/useAsync";

const VITAL_LABELS: Record<string, [string, string]> = {
  HEART_RATE: ["Heart rate", "Dil ki raftar"],
  SYSTOLIC_BP: ["Systolic BP", "Systolic BP"],
  DIASTOLIC_BP: ["Diastolic BP", "Diastolic BP"],
  OXYGEN_SATURATION: ["Oxygen saturation", "Oxygen saturation"],
  TEMPERATURE: ["Temperature", "Bukhar / temperature"],
  RESPIRATORY_RATE: ["Respiratory rate", "Saans ki raftar"],
};

function severityTone(severity: string) {
  if (severity === "CRITICAL") return "critical" as const;
  if (severity === "WARNING") return "warning" as const;
  return "info" as const;
}

/**
 * A small trace that keeps moving beside a reading — visually alive, not a
 * measurement. Purely decorative and hidden from assistive technology.
 */
function LiveWave({ critical }: { critical: boolean }) {
  const trace = "M0 12 H14 L18 12 L21 4 L25 20 L28 12 H40 L43 8 L46 12 H60";
  const stroke = critical ? "#E5484D" : "#14C7C0";
  return (
    <svg aria-hidden viewBox="0 0 60 24" className="h-6 w-16 shrink-0 overflow-hidden" fill="none">
      <g className="wave-live" style={{ willChange: "transform" }}>
        <path d={trace} stroke={stroke} strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round" />
        <path
          d={trace}
          transform="translate(60 0)"
          stroke={stroke}
          strokeWidth="1.8"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      </g>
    </svg>
  );
}

/** The current minute, ticking, for the "now" line in the clinic list. */
function useNow(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

function NowLine({ label, time }: { label: string; time: string }) {
  return (
    <div aria-hidden className="pop-in relative flex items-center gap-2 py-1">
      <span className="pulse-dot absolute -left-[1.65rem] h-2.5 w-2.5 rounded-full bg-critical" />
      <span className="h-px flex-1 bg-critical/60" />
      <span className="rounded-full bg-critical px-2 py-px text-[10.5px] font-bold uppercase tracking-wider text-white">
        {label} · {time}
      </span>
    </div>
  );
}

function greeting(tr: (en: string, ur: string) => string): string {
  const hour = new Date().getHours();
  if (hour < 12) return tr("Good morning", "Subah bakhair");
  if (hour < 17) return tr("Good afternoon", "Dopahar bakhair");
  return tr("Good evening", "Shaam bakhair");
}

export default function DoctorDashboard() {
  const { data, error, loading, reload } = useAsync(() => dashboard.doctor());
  const { user } = useSession();
  const tr = useTr();
  const lang = useLang();
  const locale = lang === "ur" ? "en-PK" : undefined;

  const today = data?.counts.appointmentsToday ?? 0;
  const alerts = data?.counts.openAlerts ?? 0;
  const now = useNow();
  const nowLabel = now.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });

  // Critical breaches float to the top; within a severity, newest first —
  // the order a clinician scans in.
  const sortedAlerts = [...(data?.openAlerts ?? [])].sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === "CRITICAL" ? -1 : 1;
    return b.createdAt.localeCompare(a.createdAt);
  });
  // The "now" line sits after the last appointment already begun.
  const clinic = data?.todaysAppointments ?? [];
  const nowIndex = clinic.filter((appointment) => new Date(appointment.startTime) <= now).length;

  return (
    <AppShell role="DOCTOR">
      <div id="main" className="space-y-6">
        <PageHeader
          eyebrow={tr("Doctor portal", "Doctor ka portal")}
          title={tr("Today", "Aaj ka din")}
          subtitle={tr(
            "Your caseload, your clinic list, and anything needing attention now.",
            "Aap ke mareez, aaj ki clinic list, aur jo cheez abhi tawajjo maangti hai.",
          )}
        />

        {user && (
          <section className="hero-navy relative overflow-hidden rounded-3xl p-6 text-white shadow-float sm:p-8">
            <svg
              aria-hidden
              viewBox="0 0 640 60"
              preserveAspectRatio="none"
              className="pointer-events-none absolute inset-x-0 bottom-0 h-14 w-full opacity-30"
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
            <div className="relative flex flex-wrap items-end justify-between gap-6">
              <div>
                <p className="text-sm font-medium text-white/70">
                  {new Date().toLocaleDateString(locale, { weekday: "long", day: "numeric", month: "long" })}
                </p>
                <h2 className="mt-1 font-display text-3xl font-bold leading-tight sm:text-4xl">
                  {greeting(tr)}, <span className="text-gradient-medical">Dr. {user.name.split(/\s+/)[0]}</span>
                </h2>
                <p className="mt-3 max-w-lg text-[15px] text-white/80">
                  {data
                    ? tr(
                        `${today} ${today === 1 ? "appointment" : "appointments"} today · ${alerts} open ${alerts === 1 ? "alert" : "alerts"}.`,
                        `Aaj ${today} ${today === 1 ? "appointment" : "appointments"} · ${alerts} khuli ${alerts === 1 ? "alert" : "alerts"}.`,
                      )
                    : tr("Loading your day…", "Aap ka din load ho raha hai…")}
                </p>
              </div>
              {alerts > 0 && (
                <Link
                  href="/doctor/alerts"
                  className="pop-in inline-flex min-h-12 items-center gap-2 rounded-xl bg-critical px-5 font-semibold text-white shadow-md transition-transform hover:scale-[1.03] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
                >
                  <Icon name="notifications_active" filled className="text-[22px]" />
                  {tr(`Review ${alerts} ${alerts === 1 ? "alert" : "alerts"}`, `${alerts} ${alerts === 1 ? "alert" : "alerts"} dekhein`)}
                </Link>
              )}
            </div>
          </section>
        )}

        <div className="stagger grid gap-3 sm:grid-cols-3">
          <QuickAction
            href="/doctor/patients"
            icon="group"
            title={tr("My patients", "Mere mareez")}
            description={tr("Charts, vitals and notes", "Charts, vitals aur notes")}
          />
          <QuickAction
            href="/doctor/appointments"
            icon="calendar_month"
            tone="accent"
            title={tr("Appointments", "Appointments")}
            description={tr("Confirm, complete, reschedule", "Confirm, mukammal, reschedule")}
          />
          <QuickAction
            href="/doctor/alerts"
            icon="notifications_active"
            tone={alerts ? "warning" : "primary"}
            title={tr("Alerts", "Alerts")}
            description={tr("Threshold breaches to acknowledge", "Had paar readings jo acknowledge karni hain")}
          />
        </div>

        {loading && (
          <>
            <SkeletonTiles />
            <SkeletonRows />
            <SkeletonRows />
          </>
        )}
        {error && <ErrorState message={error.message} onRetry={reload} />}

        {data && (
          <>
            <div className="stagger grid grid-cols-2 gap-4 lg:grid-cols-4">
              <StatTile
                label={tr("Assigned patients", "Mere mareez")}
                value={data.counts.assignedPatients ?? 0}
                icon={<Icon name="group" />}
                href="/doctor/patients"
              />
              <StatTile
                label={tr("Appointments today", "Aaj ki appointments")}
                value={today}
                icon={<Icon name="calendar_today" />}
                href="/doctor/appointments"
              />
              <StatTile
                label={tr("Open alerts", "Khuli alerts")}
                value={alerts}
                tone={alerts ? "critical" : "good"}
                hint={alerts ? tr("Needs acknowledgement", "Acknowledge karna baqi hai") : tr("Nothing outstanding", "Kuchh baqi nahi")}
                icon={<Icon name="notifications_active" />}
                href="/doctor/alerts"
              />
              <StatTile
                label={tr("In progress", "Jari")}
                value={data.counts.pendingConsultations ?? 0}
                hint={tr("Consultations not yet completed", "Consultations jo abhi mukammal nahi")}
                icon={<Icon name="stethoscope" />}
              />
            </div>

            <Card
              icon="monitor_heart"
              title={tr("Vital alerts", "Vital alerts")}
              description={tr("Threshold breaches on your patients, newest first.", "Aap ke mareezon ki had paar readings, nayi pehle.")}
            >
              {data.openAlerts.length === 0 ? (
                <EmptyState
                  icon="check_circle"
                  title={tr("No open alerts", "Koi khuli alert nahi")}
                  description={tr(
                    "You will be notified here when a patient's readings cross a threshold.",
                    "Jab kisi mareez ki reading had paar kare to yahan ittila milegi.",
                  )}
                />
              ) : (
                <ul className="stagger space-y-2">
                  {sortedAlerts.map((alert) => (
                    <li
                      key={alert.id}
                      className={cx(
                        "flex flex-wrap items-start gap-3 rounded-xl border border-line border-l-4 p-3 transition-colors",
                        alert.severity === "CRITICAL"
                          ? "glow-critical border-l-critical bg-critical-soft/50"
                          : "border-l-warning bg-card",
                      )}
                    >
                      <Avatar name={alert.patient.name} size="sm" className="mt-0.5" />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <Link
                            href={`/doctor/patients/${alert.patient.id}`}
                            className="font-semibold text-strong underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                          >
                            {alert.patient.name}
                          </Link>
                          <Badge tone={severityTone(alert.severity)}>{alert.severity.toLowerCase()}</Badge>
                        </div>
                        <p className="mt-0.5 text-sm text-muted">
                          {tr(...(VITAL_LABELS[alert.vitalType] ?? [alert.vitalType, alert.vitalType]))}:{" "}
                          <span className="font-semibold tabular-nums text-strong">{alert.measuredValue}</span>{" "}
                          — {alert.message}
                        </p>
                      </div>
                      <div className="flex items-center gap-3">
                        <LiveWave critical={alert.severity === "CRITICAL"} />
                        <p className="text-sm tabular-nums text-faint">
                          {new Date(alert.createdAt).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" })}
                        </p>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            <Card
              icon="calendar_clock"
              title={tr("Clinic list", "Clinic list")}
              description={tr("Your next appointments.", "Aap ki agli appointments.")}
              action={
                <Link
                  href="/doctor/appointments"
                  className="inline-flex min-h-10 items-center gap-1 text-sm font-semibold text-primary hover:underline"
                >
                  {tr("All appointments", "Sab appointments")}
                  <Icon name="arrow_forward" className="text-[18px]" />
                </Link>
              }
            >
              {data.todaysAppointments.length === 0 ? (
                <EmptyState icon="event_available" title={tr("Nothing scheduled", "Kuchh schedule nahi")} />
              ) : (
                <ul className="timeline stagger space-y-1">
                  {clinic.map((appointment, index) => (
                    <li key={appointment.id} className="relative">
                      {index === nowIndex && <NowLine label={tr("Now", "Abhi")} time={nowLabel} />}
                      <span
                        aria-hidden
                        className={cx("timeline-node", index < nowIndex && "is-accent")}
                        style={index === nowIndex ? { top: "2.6rem" } : undefined}
                      />
                      <div className="flex items-center gap-4 rounded-xl px-2 py-2.5 transition-colors hover:bg-sunken/60">
                      <span className="w-14 shrink-0 rounded-lg bg-primary-soft py-1.5 text-center text-sm font-bold tabular-nums text-primary">
                        {new Date(appointment.startTime).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" })}
                      </span>
                      <Avatar name={appointment.patient.name} size="sm" />
                      <div className="min-w-0 flex-1">
                        <Link
                          href={`/doctor/patients/${appointment.patient.id}`}
                          className="font-semibold text-strong underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                        >
                          {appointment.patient.name}
                        </Link>
                        <p className="truncate text-sm text-muted">
                          {appointment.patient.medicalRecordNumber}
                          {appointment.reason ? ` · ${appointment.reason}` : ""}
                        </p>
                      </div>
                      <Badge tone={appointment.status === "CONFIRMED" ? "good" : "info"}>
                        {appointment.status.toLowerCase().replace("_", " ")}
                      </Badge>
                      </div>
                    </li>
                  ))}
                  {nowIndex === clinic.length && clinic.length > 0 && (
                    <li className="relative">
                      <NowLine label={tr("Now", "Abhi")} time={nowLabel} />
                    </li>
                  )}
                </ul>
              )}
            </Card>
          </>
        )}
      </div>
    </AppShell>
  );
}
