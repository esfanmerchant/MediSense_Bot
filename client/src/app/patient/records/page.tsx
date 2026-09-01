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
import { Icon } from "@/components/Icon";
import { PageHeader } from "@/components/PageHeader";
import {
  PageSectionNav,
  Section,
  type Section as SectionSpec,
} from "@/components/layout/PageSectionNav";
import { PrescriptionRow, RecordTimeline } from "@/components/records";
import {
  Card,
  EmptyState,
  ErrorState,
  SkeletonRows,
  SkeletonTiles,
  StatTile,
  cx,
} from "@/components/ui";
import { prescriptions as prescriptionsApi, records } from "@/lib/api";
import { useTr } from "@/lib/lang";
import { useAsync } from "@/lib/useAsync";

const SECTIONS: SectionSpec[] = [
  { id: "active-medication", label: "Current medicines", icon: "pill" },
  { id: "consultations", label: "Consultations", icon: "clinical_notes" },
  { id: "reported", label: "What you told us", icon: "record_voice_over" },
  { id: "past-medication", label: "Past medicines", icon: "history" },
];

export default function PatientRecords() {
  const tr = useTr();
  const history = useAsync(
    () => records.list({ includePrescriptions: true, limit: 50 }),
    [],
  );
  const medication = useAsync(() => prescriptionsApi.list({ limit: 50 }), []);
  const reported = useAsync(() => records.reportedSymptoms({ limit: 30 }), []);

  const rows = useMemo(() => history.data?.data ?? [], [history.data]);
  const meds = useMemo(() => medication.data?.data ?? [], [medication.data]);
  const active = useMemo(() => meds.filter((m) => m.active), [meds]);
  const stopped = useMemo(() => meds.filter((m) => !m.active), [meds]);
  const told = useMemo(() => reported.data?.data ?? [], [reported.data]);

  return (
    <AppShell role="PATIENT">
      <div id="main" className="page-enter">
        <PageHeader
          eyebrow={tr("Patient portal", "Mareez ka portal")}
          title={tr("Medical history", "Medical history")}
          subtitle={tr(
            "Everything your care team has recorded. If something here looks wrong, raise it at your next appointment — records are written and corrected by your doctor.",
            "Jo kuchh aap ki care team ne darj kiya, sab yahan hai. Kahin ghalti lage to agli appointment par batayein — record doctor hi likhta aur durust karta hai.",
          )}
        />

        {(history.loading || medication.loading) && (
          <div role="status" aria-live="polite" className="mt-6 space-y-6">
            <span className="sr-only">{tr("Loading your records", "Record load ho raha hai")}…</span>
            <SkeletonTiles count={3} />
            <SkeletonRows rows={2} />
            <SkeletonRows rows={3} />
          </div>
        )}
        {history.error && (
          <div className="mt-6">
            <ErrorState message={history.error.message} onRetry={history.reload} />
          </div>
        )}

        {history.data && medication.data && (
          <div className="stagger mt-6 space-y-6">
            <div className="grid grid-cols-2 gap-4 lg:grid-cols-3">
              <StatTile
                label={tr("Consultations recorded", "Darj shuda consultations")}
                value={history.data.meta.total}
                icon={<Icon name="clinical_notes" filled />}
              />
              <StatTile
                label={tr("Current medication", "Maujooda dawa")}
                value={active.length}
                icon={<Icon name="pill" filled />}
                tone={active.length > 0 ? "good" : "neutral"}
              />
              <StatTile
                label={tr("Past medication", "Purani dawa")}
                value={stopped.length}
                icon={<Icon name="history" />}
              />
            </div>

            <PageSectionNav mode="jump" label="Sections" sections={SECTIONS} />

            <Section id="active-medication">
<Card
              icon="pill"
              title={tr("Current medication", "Maujooda dawa")}
              description={tr(
                "Always follow the instructions on the label. Never stop a medication without speaking to your doctor.",
                "Hamesha label ki hidayat par amal karein. Doctor se baat kiye baghair koi dawa band na karein.",
              )}
            >
              {active.length === 0 ? (
                <EmptyState
                  icon="pill_off"
                  title={tr("No active prescriptions", "Koi jari nuskha nahi")}
                  description={tr(
                    "Medication your doctor prescribes will appear here.",
                    "Doctor jo dawa likhein ge, yahan nazar aaye gi.",
                  )}
                />
              ) : (
                <ul className="stagger grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                  {active.map((prescription) => (
                    <PrescriptionRow key={prescription.id} prescription={prescription} variant="card" />
                  ))}
                </ul>
              )}
            </Card>

            
            </Section>

            <Section id="consultations">
<Card
              icon="clinical_notes"
              title={tr("Consultation history", "Consultations ki tareekh")}
              description={tr("Most recent first.", "Sab se naya pehle.")}
            >
              <RecordTimeline
                records={rows}
                emptyTitle={tr("No records yet", "Abhi koi record nahi")}
                emptyDescription={tr(
                  "Notes from your consultations will appear here.",
                  "Aap ki consultations ke notes yahan nazar aayein ge.",
                )}
              />
            </Card>

            
            </Section>

            <Section id="reported">
{told.length > 0 && (
              <Card
                icon="record_voice_over"
                title={tr("What you told the assistant", "Aap ne assistant ko kya bataya")}
                description={tr(
                  "Your own words, kept with your record. These are not a diagnosis.",
                  "Aap ke apne alfaz, aap ke record ke saath. Yeh tashkhees nahi hai.",
                )}
              >
                <ul className="space-y-2">
                  {told.map((row) => (
                    <li
                      key={row.id}
                      className="flex items-start gap-3 rounded-xl border border-line p-3"
                    >
                      <Icon
                        name={row.promotedAt ? "task_alt" : "hourglass_top"}
                        className={cx(
                          "mt-0.5 shrink-0 text-[18px]",
                          row.promotedAt ? "text-good" : "text-faint",
                        )}
                      />
                      <div className="min-w-0 flex-1">
                        <p className="font-semibold">
                          {[row.symptom, row.severity, row.duration].filter(Boolean).join(" — ")}
                        </p>
                        <p className="mt-0.5 text-sm text-muted">
                          {new Date(row.createdAt).toLocaleDateString()} ·{" "}
                          {/* Said plainly, because the difference matters to
                              the patient: one of these has been read by their
                              doctor and one is still only their own note. */}
                          {row.promotedAt
                            ? tr(
                                "A doctor has written this into your record",
                                "Doctor ne isay aap ke record mein likh diya hai",
                              )
                            : tr(
                                "Waiting for a doctor to review it",
                                "Doctor ke dekhne ka intezar",
                              )}
                        </p>
                      </div>
                    </li>
                  ))}
                </ul>
              </Card>
            )}

            
            </Section>

            <Section id="past-medication">
{stopped.length > 0 && (
              <Card
                icon="history"
                title={tr("Past medication", "Purani dawa")}
                description={tr(
                  "Medication you are no longer taking. Kept so your care team can see your full history.",
                  "Dawa jo aap ab nahi le rahe. Mehfooz hai taake care team aap ki poori tareekh dekh sake.",
                )}
              >
                <ul className="stagger grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                  {stopped.map((prescription) => (
                    <PrescriptionRow key={prescription.id} prescription={prescription} variant="card" />
                  ))}
                </ul>
              </Card>
            )}
            </Section>

            
          </div>
        )}
      </div>
    </AppShell>
  );
}
