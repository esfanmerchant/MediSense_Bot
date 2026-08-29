"use client";

/**
 * The patient's own medical history — read-only, by design.
 *
 * There is no edit control anywhere on this page because there is no endpoint
 * behind one: patients hold no `record:write` permission, so a record is
 * something they read, question at their next appointment, and never alter
 * (spec §13).
 */

import { useMemo } from "react";

import { AppShell } from "@/components/AppShell";
import { PageHeader } from "@/components/PageHeader";
import { PrescriptionRow, RecordTimeline } from "@/components/records";
import { Card, EmptyState, ErrorState, Loading, StatTile } from "@/components/ui";
import { prescriptions as prescriptionsApi, records } from "@/lib/api";
import { useTr } from "@/lib/lang";
import { useAsync } from "@/lib/useAsync";

export default function PatientRecords() {
  const tr = useTr();
  const history = useAsync(
    () => records.list({ includePrescriptions: true, limit: 50 }),
    [],
  );
  const medication = useAsync(() => prescriptionsApi.list({ limit: 50 }), []);

  const rows = useMemo(() => history.data?.data ?? [], [history.data]);
  const meds = useMemo(() => medication.data?.data ?? [], [medication.data]);
  const active = useMemo(() => meds.filter((m) => m.active), [meds]);
  const stopped = useMemo(() => meds.filter((m) => !m.active), [meds]);

  return (
    <AppShell role="PATIENT">
      <div id="main">
        <PageHeader
          eyebrow={tr("Patient portal", "Mareez ka portal")}
          title={tr("Medical history", "Medical history")}
          subtitle={tr(
            "Everything your care team has recorded. If something here looks wrong, raise it at your next appointment — records are written and corrected by your doctor.",
            "Jo kuchh aap ki care team ne darj kiya, sab yahan hai. Kahin ghalti lage to agli appointment par batayein — record doctor hi likhta aur durust karta hai.",
          )}
        />

        {(history.loading || medication.loading) && <Loading label={tr("Loading your records", "Record load ho raha hai")} />}
        {history.error && <ErrorState message={history.error.message} onRetry={history.reload} />}

        {history.data && medication.data && (
          <div className="mt-6 space-y-6">
            <div className="grid grid-cols-2 gap-4 lg:grid-cols-3">
              <StatTile label="Consultations recorded" value={history.data.meta.total} />
              <StatTile label="Current medication" value={active.length} />
              <StatTile label="Past medication" value={stopped.length} />
            </div>

            <Card
              title="Current medication"
              description="Always follow the instructions on the label. Never stop a medication without speaking to your doctor."
            >
              {active.length === 0 ? (
                <EmptyState title="No active prescriptions" />
              ) : (
                <ul className="divide-y divide-line">
                  {active.map((prescription) => (
                    <PrescriptionRow key={prescription.id} prescription={prescription} />
                  ))}
                </ul>
              )}
            </Card>

            <Card title="Consultation history">
              <RecordTimeline
                records={rows}
                emptyTitle="No records yet"
                emptyDescription="Notes from your consultations will appear here."
              />
            </Card>

            {stopped.length > 0 && (
              <Card
                title="Past medication"
                description="Medication you are no longer taking. Kept so your care team can see your full history."
              >
                <ul className="divide-y divide-line">
                  {stopped.map((prescription) => (
                    <PrescriptionRow key={prescription.id} prescription={prescription} />
                  ))}
                </ul>
              </Card>
            )}
          </div>
        )}
      </div>
    </AppShell>
  );
}
