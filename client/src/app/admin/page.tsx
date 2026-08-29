"use client";

import { AppShell } from "@/components/AppShell";
import { PageHeader } from "@/components/PageHeader";
import { Badge, Card, EmptyState, ErrorState, Loading, StatTile } from "@/components/ui";
import { dashboard } from "@/lib/api";
import { useTr } from "@/lib/lang";
import { useAsync } from "@/lib/useAsync";

const ACTION_LABELS: Record<string, string> = {
  LOGIN_FAILED: "Failed sign-in",
  ACCESS_DENIED: "Access denied",
  EMERGENCY_ACCESS_GRANTED: "Emergency access granted",
  EMERGENCY_ACCESS_USED: "Emergency access used",
  EMERGENCY_ACCESS_REVOKED: "Emergency access revoked",
  USER_STATUS_CHANGED: "Account status changed",
  SESSION_EXPIRED: "Session ended",
};

export default function AdminDashboard() {
  const { data, error, loading, reload } = useAsync(() => dashboard.admin());
  const tr = useTr();
  const unreviewed = data?.counts.unreviewedEmergencyGrants ?? 0;

  return (
    <AppShell role="ADMIN">
      <div id="main">
        <PageHeader
          eyebrow={tr("Admin portal", "Intezami portal")}
          title={tr("Hospital overview", "Hospital ka jaiza")}
          subtitle={tr(
            "Users, departments, activity and security events.",
            "Users, departments, sargarmi aur security ke waqiat.",
          )}
        />

        {loading && <Loading label={tr("Loading the overview", "Jaiza load ho raha hai")} />}
        {error && <ErrorState message={error.message} onRetry={reload} />}

        {data && (
          <div className="mt-6 space-y-6">
            {/* Unreviewed break-glass grants are surfaced above everything else:
                the post-hoc review is what makes emergency override safe to
                offer at all (conflict C1). */}
            {unreviewed > 0 && (
              <div
                role="alert"
                className="rounded-lg border border-critical/50 bg-critical-soft p-5"
              >
                <p className="font-medium text-critical">
                  {unreviewed} emergency access {unreviewed === 1 ? "grant" : "grants"} awaiting
                  review
                </p>
                <p className="mt-1 text-sm text-strong">
                  Every break-glass access must be reviewed. Unreviewed grants stay on this
                  dashboard until someone signs them off.
                </p>
              </div>
            )}

            <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
              <StatTile label="Patients" value={data.counts.patients ?? 0} icon="👤" />
              <StatTile label="Doctors" value={data.counts.doctors ?? 0} icon="🩺" />
              <StatTile label="Departments" value={data.counts.departments ?? 0} icon="🏥" />
              <StatTile
                label="Suspended accounts"
                value={data.counts.suspendedAccounts ?? 0}
                tone={data.counts.suspendedAccounts ? "warning" : "neutral"}
                icon="🚫"
              />
              <StatTile label="Appointments this week" value={data.counts.appointmentsThisWeek ?? 0} icon="📅" />
              <StatTile
                label="Unpaid invoices"
                value={data.counts.unpaidInvoices ?? 0}
                tone={data.counts.unpaidInvoices ? "warning" : "neutral"}
                icon="🧾"
              />
              <StatTile
                label="Active emergency grants"
                value={data.counts.activeEmergencyGrants ?? 0}
                tone={data.counts.activeEmergencyGrants ? "critical" : "good"}
                icon="🚨"
              />
              <StatTile
                label="Failed sign-ins (7d)"
                value={data.counts.failedLoginsThisWeek ?? 0}
                tone={(data.counts.failedLoginsThisWeek ?? 0) > 20 ? "warning" : "neutral"}
              />
            </div>

            <Card
              title="Recent security events"
              description="Denied access, failed sign-ins and break-glass activity from the last 7 days."
            >
              {data.recentSecurityEvents.length === 0 ? (
                <EmptyState
                  title="Nothing to review"
                  description="No security events have been recorded this week."
                />
              ) : (
                <div className="-mx-5 overflow-x-auto px-5">
                  <table className="w-full min-w-[560px] text-sm">
                    <thead>
                      <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-faint">
                        <th className="py-2 pr-4 font-medium">Event</th>
                        <th className="py-2 pr-4 font-medium">Severity</th>
                        <th className="py-2 pr-4 font-medium">When</th>
                        <th className="py-2 font-medium">Source</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-line">
                      {data.recentSecurityEvents.map((event) => (
                        <tr key={event.id}>
                          <td className="py-2.5 pr-4 text-strong">
                            {ACTION_LABELS[event.action] ?? event.action}
                          </td>
                          <td className="py-2.5 pr-4">
                            <Badge tone={event.severity === "BREAK_GLASS" ? "critical" : "warning"}>
                              {event.severity.toLowerCase().replace("_", " ")}
                            </Badge>
                          </td>
                          <td className="py-2.5 pr-4 tabular-nums text-muted">
                            {new Date(event.timestamp).toLocaleString(undefined, {
                              day: "numeric",
                              month: "short",
                              hour: "2-digit",
                              minute: "2-digit",
                            })}
                          </td>
                          <td className="py-2.5 tabular-nums text-muted">
                            {event.ipAddress ?? "—"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
          </div>
        )}
      </div>
    </AppShell>
  );
}
