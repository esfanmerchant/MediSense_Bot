"use client";

import { AppShell } from "@/components/AppShell";
import { Badge, Card, EmptyState, ErrorState, Loading, StatTile } from "@/components/ui";
import { dashboard } from "@/lib/api";
import { useAsync } from "@/lib/useAsync";

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function PatientDashboard() {
  const { data, error, loading, reload } = useAsync(() => dashboard.patient());

  return (
    <AppShell role="PATIENT">
      <div id="main">
        <h1 className="text-2xl font-semibold text-strong">Your health</h1>
        <p className="mt-1 text-muted">
          Appointments, prescriptions, reports and billing — all in one place.
        </p>

        {loading && <Loading label="Loading your dashboard" />}
        {error && <ErrorState message={error.message} onRetry={reload} />}

        {data && (
          <div className="mt-6 space-y-6">
            <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
              <StatTile
                label="Upcoming appointments"
                value={data.counts.upcomingAppointments ?? 0}
                icon="📅"
              />
              <StatTile
                label="Active prescriptions"
                value={data.counts.activePrescriptions ?? 0}
                icon="💊"
              />
              <StatTile label="Documents" value={data.counts.documents ?? 0} icon="📄" />
              <StatTile
                label="Unpaid invoices"
                value={data.counts.unpaidInvoices ?? 0}
                tone={data.counts.unpaidInvoices ? "warning" : "neutral"}
                icon="🧾"
              />
            </div>

            <Card
              title="Next appointments"
              description="Your confirmed and requested visits."
            >
              {data.upcomingAppointments.length === 0 ? (
                <EmptyState
                  title="No upcoming appointments"
                  description="When you book a visit it will appear here."
                />
              ) : (
                <ul className="divide-y divide-line">
                  {data.upcomingAppointments.map((appointment) => (
                    <li key={appointment.id} className="flex flex-wrap items-center gap-3 py-3">
                      <div className="min-w-0">
                        <p className="font-medium text-strong">
                          {appointment.doctor.name}
                        </p>
                        <p className="text-sm text-muted">
                          {appointment.doctor.specialization}
                          {appointment.reason ? ` · ${appointment.reason}` : ""}
                        </p>
                      </div>
                      <div className="ml-auto text-right">
                        <p className="text-sm font-medium text-strong tabular-nums">
                          {formatDateTime(appointment.startTime)}
                        </p>
                        <Badge tone={appointment.status === "CONFIRMED" ? "good" : "info"}>
                          {appointment.status.toLowerCase()}
                        </Badge>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            <Card
              title="Current medication"
              description="Prescribed by your care team. Always follow the instructions on the label."
            >
              {data.activePrescriptions.length === 0 ? (
                <EmptyState title="No active prescriptions" />
              ) : (
                <ul className="divide-y divide-line">
                  {data.activePrescriptions.map((prescription) => (
                    <li key={prescription.id} className="py-3">
                      <p className="font-medium text-strong">
                        {prescription.medication} · {prescription.dosage}
                      </p>
                      <p className="text-sm text-muted">
                        {prescription.frequency} for {prescription.duration} · prescribed by{" "}
                        {prescription.prescribedBy}
                      </p>
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
