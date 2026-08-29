"use client";

/**
 * The administrator's overview.
 *
 * Unreviewed break-glass grants are surfaced above everything else: the
 * post-hoc review is what makes emergency override safe to offer at all
 * (conflict C1). The rest is the hospital in numbers, each one a door.
 */

import Link from "next/link";

import { AppShell } from "@/components/AppShell";
import { Icon } from "@/components/Icon";
import { PageHeader } from "@/components/PageHeader";
import {
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
import { useAsync } from "@/lib/useAsync";

const ACTION_LABELS: Record<string, [string, string]> = {
  LOGIN_FAILED: ["Failed sign-in", "Nakam sign-in"],
  ACCESS_DENIED: ["Access denied", "Rasai se inkar"],
  EMERGENCY_ACCESS_GRANTED: ["Emergency access granted", "Emergency access di gayi"],
  EMERGENCY_ACCESS_USED: ["Emergency access used", "Emergency access istemal hui"],
  EMERGENCY_ACCESS_REVOKED: ["Emergency access revoked", "Emergency access wapas li gayi"],
  USER_STATUS_CHANGED: ["Account status changed", "Account status badla"],
  SESSION_EXPIRED: ["Session ended", "Session khatam"],
};

export default function AdminDashboard() {
  const { data, error, loading, reload } = useAsync(() => dashboard.admin());
  const tr = useTr();
  const lang = useLang();
  const locale = lang === "ur" ? "en-PK" : undefined;
  const unreviewed = data?.counts.unreviewedEmergencyGrants ?? 0;

  return (
    <AppShell role="ADMIN">
      <div id="main" className="space-y-6">
        <PageHeader
          eyebrow={tr("Admin portal", "Intezami portal")}
          title={tr("Hospital overview", "Hospital ka jaiza")}
          subtitle={tr(
            "Users, departments, activity and security events.",
            "Users, departments, sargarmi aur security ke waqiat.",
          )}
        />

        <section className="hero-navy relative overflow-hidden rounded-3xl p-6 text-white shadow-float sm:p-8">
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
          <div className="relative flex flex-wrap items-end justify-between gap-6">
            <div>
              <p className="text-sm font-medium text-white/70">
                {new Date().toLocaleDateString(locale, { weekday: "long", day: "numeric", month: "long" })}
              </p>
              <h2 className="mt-1 font-display text-3xl font-bold leading-tight sm:text-4xl">
                {tr("The hospital,", "Hospital,")}{" "}
                <span className="text-gradient-medical">{tr("at a glance", "ek nazar mein")}</span>
              </h2>
              <p className="mt-3 max-w-lg text-[15px] text-white/80">
                {data
                  ? tr(
                      `${data.counts.patients ?? 0} patients · ${data.counts.doctors ?? 0} doctors · ${data.counts.appointmentsThisWeek ?? 0} appointments this week.`,
                      `${data.counts.patients ?? 0} mareez · ${data.counts.doctors ?? 0} doctors · is hafte ${data.counts.appointmentsThisWeek ?? 0} appointments.`,
                    )
                  : tr("Loading the overview…", "Jaiza load ho raha hai…")}
              </p>
            </div>
            {unreviewed > 0 && (
              <Link
                href="/admin/emergency"
                className="pop-in inline-flex min-h-12 items-center gap-2 rounded-xl bg-critical px-5 font-semibold text-white shadow-md transition-transform hover:scale-[1.03] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
              >
                <Icon name="policy" filled className="text-[22px]" />
                {tr(
                  `Review ${unreviewed} emergency ${unreviewed === 1 ? "grant" : "grants"}`,
                  `${unreviewed} emergency ${unreviewed === 1 ? "grant" : "grants"} review karein`,
                )}
              </Link>
            )}
          </div>
        </section>

        <div className="stagger grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <QuickAction
            href="/admin/appointments"
            icon="calendar_month"
            title={tr("Appointments", "Appointments")}
            description={tr("Every booking, every doctor", "Har booking, har doctor")}
          />
          <QuickAction
            href="/admin/billing"
            icon="payments"
            tone="accent"
            title={tr("Billing", "Billing")}
            description={tr("Invoices and payments", "Invoices aur adaigiyan")}
          />
          <QuickAction
            href="/admin/emergency"
            icon="e911_emergency"
            tone={unreviewed ? "warning" : "primary"}
            title={tr("Emergency access", "Emergency access")}
            description={tr("Break-glass grants and reviews", "Break-glass grants aur reviews")}
          />
          <QuickAction
            href="/admin/audit"
            icon="policy"
            tone="accent"
            title={tr("Audit trail", "Audit trail")}
            description={tr("Who saw what, and when", "Kis ne kya dekha, aur kab")}
          />
        </div>

        {loading && (
          <>
            <SkeletonTiles count={8} />
            <SkeletonRows rows={4} />
          </>
        )}
        {error && <ErrorState message={error.message} onRetry={reload} />}

        {data && (
          <>
            {unreviewed > 0 && (
              <div
                role="alert"
                className="pop-in flex gap-3 rounded-2xl border border-critical/50 bg-critical-soft p-5"
              >
                <Icon name="warning" filled className="shrink-0 text-[24px] text-critical" />
                <div>
                  <p className="font-semibold text-critical">
                    {tr(
                      `${unreviewed} emergency access ${unreviewed === 1 ? "grant" : "grants"} awaiting review`,
                      `${unreviewed} emergency access ${unreviewed === 1 ? "grant" : "grants"} review ke muntazir`,
                    )}
                  </p>
                  <p className="mt-1 text-sm text-strong">
                    {tr(
                      "Every break-glass access must be reviewed. Unreviewed grants stay on this dashboard until someone signs them off.",
                      "Har break-glass access ka review lazmi hai. Jab tak koi sign-off na kare, yeh grants is dashboard par rehti hain.",
                    )}
                  </p>
                </div>
              </div>
            )}

            <div className="stagger grid grid-cols-2 gap-4 lg:grid-cols-4">
              <StatTile label={tr("Patients", "Mareez")} value={data.counts.patients ?? 0} icon={<Icon name="personal_injury" />} />
              <StatTile label={tr("Doctors", "Doctors")} value={data.counts.doctors ?? 0} icon={<Icon name="stethoscope" />} />
              <StatTile label={tr("Departments", "Departments")} value={data.counts.departments ?? 0} icon={<Icon name="local_hospital" />} />
              <StatTile
                label={tr("Suspended accounts", "Muattal accounts")}
                value={data.counts.suspendedAccounts ?? 0}
                tone={data.counts.suspendedAccounts ? "warning" : "neutral"}
                icon={<Icon name="person_off" />}
              />
              <StatTile
                label={tr("Appointments this week", "Is hafte ki appointments")}
                value={data.counts.appointmentsThisWeek ?? 0}
                icon={<Icon name="calendar_month" />}
                href="/admin/appointments"
              />
              <StatTile
                label={tr("Unpaid invoices", "Baqaya invoices")}
                value={data.counts.unpaidInvoices ?? 0}
                tone={data.counts.unpaidInvoices ? "warning" : "neutral"}
                icon={<Icon name="receipt_long" />}
                href="/admin/billing"
              />
              <StatTile
                label={tr("Active emergency grants", "Chalu emergency grants")}
                value={data.counts.activeEmergencyGrants ?? 0}
                tone={data.counts.activeEmergencyGrants ? "critical" : "good"}
                icon={<Icon name="e911_emergency" />}
                href="/admin/emergency"
              />
              <StatTile
                label={tr("Failed sign-ins (7d)", "Nakam sign-ins (7 din)")}
                value={data.counts.failedLoginsThisWeek ?? 0}
                tone={(data.counts.failedLoginsThisWeek ?? 0) > 20 ? "warning" : "neutral"}
                icon={<Icon name="lock" />}
                href="/admin/audit"
              />
            </div>

            <Card
              icon="security"
              title={tr("Recent security events", "Haaliya security waqiat")}
              description={tr(
                "Denied access, failed sign-ins and break-glass activity from the last 7 days.",
                "Pichle 7 din ki rasai se inkar, nakam sign-ins aur break-glass sargarmi.",
              )}
              flush
            >
              {data.recentSecurityEvents.length === 0 ? (
                <div className="p-5">
                  <EmptyState
                    icon="verified_user"
                    title={tr("Nothing to review", "Review ke liye kuchh nahi")}
                    description={tr("No security events have been recorded this week.", "Is hafte koi security waqia darj nahi hua.")}
                  />
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[560px] text-sm">
                    <thead>
                      <tr className="border-b border-line bg-sunken/60 text-left text-xs uppercase tracking-wide text-faint">
                        <th className="px-5 py-2.5 font-semibold">{tr("Event", "Waqia")}</th>
                        <th className="py-2.5 pr-4 font-semibold">{tr("Severity", "Shiddat")}</th>
                        <th className="py-2.5 pr-4 font-semibold">{tr("When", "Kab")}</th>
                        <th className="py-2.5 pr-5 font-semibold">{tr("Source", "Zariya")}</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-line">
                      {data.recentSecurityEvents.map((event) => (
                        <tr key={event.id} className="transition-colors hover:bg-sunken/50">
                          <td className="px-5 py-3 font-medium text-strong">
                            {tr(...(ACTION_LABELS[event.action] ?? [event.action, event.action]))}
                          </td>
                          <td className="py-3 pr-4">
                            <Badge tone={event.severity === "BREAK_GLASS" ? "critical" : "warning"}>
                              {event.severity.toLowerCase().replace("_", " ")}
                            </Badge>
                          </td>
                          <td className="py-3 pr-4 tabular-nums text-muted">
                            {new Date(event.timestamp).toLocaleString(locale, {
                              day: "numeric",
                              month: "short",
                              hour: "2-digit",
                              minute: "2-digit",
                            })}
                          </td>
                          <td className="py-3 pr-5 tabular-nums text-muted">{event.ipAddress ?? "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
          </>
        )}
      </div>
    </AppShell>
  );
}
