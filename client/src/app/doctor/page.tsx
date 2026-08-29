"use client";

import { AppShell } from "@/components/AppShell";
import { Badge, Card, EmptyState, ErrorState, Loading, StatTile } from "@/components/ui";
import { dashboard } from "@/lib/api";
import { useAsync } from "@/lib/useAsync";

const VITAL_LABELS: Record<string, string> = {
  HEART_RATE: "Heart rate",
  SYSTOLIC_BP: "Systolic BP",
  DIASTOLIC_BP: "Diastolic BP",
  OXYGEN_SATURATION: "Oxygen saturation",
  TEMPERATURE: "Temperature",
  RESPIRATORY_RATE: "Respiratory rate",
};

function severityTone(severity: string) {
  if (severity === "CRITICAL") return "critical" as const;
  if (severity === "WARNING") return "warning" as const;
  return "info" as const;
}

export default function DoctorDashboard() {
  const { data, error, loading, reload } = useAsync(() => dashboard.doctor());

  return (
    <AppShell role="DOCTOR">
      <div id="main">
        <h1 className="text-2xl font-semibold text-strong">Today</h1>
        <p className="mt-1 text-muted">
          Your caseload, your clinic list, and anything needing attention now.
        </p>

        {loading && <Loading label="Loading your dashboard" />}
        {error && <ErrorState message={error.message} onRetry={reload} />}

        {data && (
          <div className="mt-6 space-y-6">
            <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
              <StatTile label="Assigned patients" value={data.counts.assignedPatients ?? 0} icon="👥" />
              <StatTile label="Appointments today" value={data.counts.appointmentsToday ?? 0} icon="📅" />
              <StatTile
                label="Open alerts"
                value={data.counts.openAlerts ?? 0}
                tone={data.counts.openAlerts ? "critical" : "good"}
                hint={data.counts.openAlerts ? "Needs acknowledgement" : "Nothing outstanding"}
                icon="🔔"
              />
              <StatTile
                label="In progress"
                value={data.counts.pendingConsultations ?? 0}
                hint="Consultations not yet completed"
                icon="🩺"
              />
            </div>

            {/* Alerts come first: a threshold breach is the one thing on this
                page that is time-critical (R1). */}
            <Card
              title="Vital alerts"
              description="Threshold breaches on your patients, newest first."
            >
              {data.openAlerts.length === 0 ? (
                <EmptyState
                  title="No open alerts"
                  description="You will be notified here when a patient's readings cross a threshold."
                />
              ) : (
                <ul className="divide-y divide-line">
                  {data.openAlerts.map((alert) => (
                    <li key={alert.id} className="flex flex-wrap items-start gap-3 py-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="font-medium text-strong">
                            {alert.patient.name}
                          </p>
                          <Badge tone={severityTone(alert.severity)}>
                            {alert.severity.toLowerCase()}
                          </Badge>
                        </div>
                        <p className="mt-0.5 text-sm text-muted">
                          {VITAL_LABELS[alert.vitalType] ?? alert.vitalType}:{" "}
                          <span className="font-medium tabular-nums">{alert.measuredValue}</span>{" "}
                          — {alert.message}
                        </p>
                      </div>
                      <p className="text-sm text-faint tabular-nums">
                        {new Date(alert.createdAt).toLocaleTimeString(undefined, {
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            <Card title="Clinic list" description="Your next appointments.">
              {data.todaysAppointments.length === 0 ? (
                <EmptyState title="Nothing scheduled" />
              ) : (
                <ul className="divide-y divide-line">
                  {data.todaysAppointments.map((appointment) => (
                    <li key={appointment.id} className="flex flex-wrap items-center gap-3 py-3">
                      <div className="min-w-0">
                        <p className="font-medium text-strong">
                          {appointment.patient.name}
                        </p>
                        <p className="text-sm text-muted">
                          {appointment.patient.medicalRecordNumber}
                          {appointment.reason ? ` · ${appointment.reason}` : ""}
                        </p>
                      </div>
                      <div className="ml-auto text-right">
                        <p className="text-sm font-medium tabular-nums text-strong">
                          {new Date(appointment.startTime).toLocaleTimeString(undefined, {
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </p>
                        <Badge tone={appointment.status === "CONFIRMED" ? "good" : "info"}>
                          {appointment.status.toLowerCase().replace("_", " ")}
                        </Badge>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>
        )}
      </div>
    </AppShell>
  );
}
