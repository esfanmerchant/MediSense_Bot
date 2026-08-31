"use client";

/**
 * The doctor's live alert queue (spec §16).
 *
 * Scoped by the API to this doctor's caseload; there is no patient filter here
 * to widen it.
 */

import { AppShell } from "@/components/AppShell";
import { Icon } from "@/components/Icon";
import { PageHeader } from "@/components/PageHeader";
import { useTr } from "@/lib/lang";
import { AlertsPanel } from "@/components/vitals";

export default function DoctorAlerts() {
  const tr = useTr();
  return (
    <AppShell role="DOCTOR">
      <div id="main" className="page-enter">
        <PageHeader
          eyebrow={tr("Doctor portal", "Doctor ka portal")}
          title={tr("Alerts", "Alerts")}
          subtitle={tr(
            "Raised the moment a reading crosses its limit.",
            "Jab reading had paar kare, alert usi waqt uthta hai.",
          )}
        />

        <div className="mt-6 space-y-4">
          <div className="stagger grid gap-3 sm:grid-cols-3">
            <Legend
              icon="emergency"
              tone="critical"
              title={tr("Critical", "Sangeen")}
              text={tr("Announced the moment it arrives. Act first.", "Aate hi elaan hota hai. Pehle isay dekhein.")}
            />
            <Legend
              icon="warning"
              tone="warning"
              title={tr("Warning", "Khabardari")}
              text={tr("Outside the configured range. Review soon.", "Muqarrar had se bahar. Jald dekhein.")}
            />
            <Legend
              icon="visibility"
              tone="info"
              title={tr("Acknowledge, then resolve", "Pehle dekhein, phir hal karein")}
              text={tr(
                "Acknowledging says someone is looking; resolving says the patient is fine.",
                "Dekhna yaani koi dekh raha hai; hal karna yaani mareez theek hai.",
              )}
            />
          </div>

          <AlertsPanel />
        </div>
      </div>
    </AppShell>
  );
}

/** A small key to the queue's colours — read once, then ignored. */
function Legend({
  icon,
  tone,
  title,
  text,
}: {
  icon: string;
  tone: "critical" | "warning" | "info";
  title: string;
  text: string;
}) {
  const tints = {
    critical: "bg-critical-soft text-critical",
    warning: "bg-warning-soft text-warning",
    info: "bg-info-soft text-info",
  } as const;
  return (
    <div className="hover-lift-sm group flex items-start gap-3 rounded-2xl border border-line bg-card p-4 shadow-card">
      <span
        aria-hidden
        className={`icon-wiggle grid h-10 w-10 shrink-0 place-items-center rounded-xl ${tints[tone]}`}
      >
        <Icon name={icon} filled className="text-[20px]" />
      </span>
      <div className="min-w-0">
        <p className="text-sm font-semibold text-strong">{title}</p>
        <p className="mt-0.5 text-xs leading-relaxed text-muted">{text}</p>
      </div>
    </div>
  );
}
