"use client";

/**
 * A printable summary of the patient's record.
 *
 * The JSON export is for another system. This is for a person — a doctor in a
 * consulting room outside this platform, at two in the morning, who needs to
 * know what you are allergic to and what you are taking before they prescribe
 * anything. So it is a *summary*, not the bundle rendered as HTML: allergies,
 * conditions, current medicines, what each consultation concluded, and the last
 * few readings. Invoices and file listings are in the download and are not
 * clinical, so they are not here.
 *
 * **Print is the PDF.** Every browser prints to PDF, which means no server-side
 * renderer, no rasteriser in the container, and a document with real selectable
 * text in whatever paper size the person is actually holding. Adding a PDF
 * library to generate a worse file would be the wrong trade.
 *
 * `record-print` is the class the print stylesheet in `globals.css` keeps
 * visible; everything else on the page, the shell included, disappears on
 * paper.
 */

import { AppShell } from "@/components/AppShell";
import { Icon } from "@/components/Icon";
import { Button, Card, ErrorState, SkeletonRows } from "@/components/ui";
import { patients } from "@/lib/api";
import type { PatientExport } from "@/lib/api";
import { useTr } from "@/lib/lang";
import { useAsync } from "@/lib/useAsync";

function formatDay(value: string | null | undefined): string {
  if (!value) return "—";
  // The API sends UTC with an explicit Z, and bare dates for days. Both parse;
  // a bare date is midnight UTC, which is the same calendar day in Pakistan.
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? "—"
    : parsed.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

/** A labelled fact in the letterhead. */
function Fact({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] font-semibold tracking-wide text-muted uppercase">{label}</dt>
      <dd className="mt-0.5 text-sm font-medium text-strong">{value || "—"}</dd>
    </div>
  );
}

/**
 * A heading that stays with what follows it.
 *
 * `break-after-avoid` is not decoration: without it a section title lands alone
 * at the bottom of a page and the medicines it names start on the next one,
 * which on a medication list is genuinely misleading.
 */
function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="mt-8 break-after-avoid border-b border-line pb-2 font-display text-base font-bold text-strong">
      {children}
    </h2>
  );
}

function Summary({ bundle }: { bundle: PatientExport }) {
  const tr = useTr();
  const active = bundle.prescriptions.filter((p) => p.active);
  const vitals = bundle.vitals.slice(0, 10);

  return (
    <div className="record-print bg-card p-8 text-ink">
      {/* Letterhead. On screen the page header above already says whose record
          this is; on paper there is nothing above, so this has to carry it. */}
      <header className="border-b-2 border-strong pb-4">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <p className="font-display text-xl font-bold text-strong">
            {tr("Patient record summary", "Mareez ke record ka khulasa")}
          </p>
          <p className="text-xs text-muted">
            {tr("Prepared", "Tayyar kiya gaya")} {formatDay(bundle.exportedAt)} ·{" "}
            {bundle.source.system}
          </p>
        </div>
        <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-4">
          <Fact label={tr("Name", "Naam")} value={bundle.patient.name} />
          <Fact label={tr("Record number", "Record number")} value={bundle.patient.medicalRecordNumber} />
          <Fact label={tr("Date of birth", "Tareekh-e-paidaish")} value={formatDay(bundle.patient.dateOfBirth)} />
          <Fact label={tr("Blood group", "Blood group")} value={bundle.patient.bloodGroup} />
        </dl>
      </header>

      {/* First, and boxed. If a reader takes one thing off this page under
          pressure, it has to be this one. */}
      <section className="mt-6 rounded-xl border-2 border-critical/40 bg-critical/5 p-4">
        <p className="flex items-center gap-2 font-display text-sm font-bold text-critical">
          <Icon name="warning" className="text-[18px]" />
          {tr("Allergies", "Allergies")}
        </p>
        <p className="mt-1 text-sm font-medium text-strong">
          {bundle.patient.allergies || tr("None recorded", "Koi darj nahi")}
        </p>
        <p className="mt-3 text-[11px] font-semibold tracking-wide text-muted uppercase">
          {tr("Ongoing conditions", "Jaari amraaz")}
        </p>
        <p className="mt-0.5 text-sm text-strong">
          {bundle.patient.chronicConditions || tr("None recorded", "Koi darj nahi")}
        </p>
      </section>

      <SectionTitle>
        {tr("Current medicines", "Maujooda dawaiyan")} ({active.length})
      </SectionTitle>
      {active.length === 0 ? (
        <p className="mt-3 text-sm text-muted">{tr("None active.", "Koi jaari nahi.")}</p>
      ) : (
        <ul className="mt-3 space-y-2">
          {active.map((p) => (
            <li key={p.id} className="break-inside-avoid text-sm">
              <span className="font-semibold text-strong">{p.medication}</span>
              <span className="text-muted">
                {" "}
                — {p.dosage}, {p.frequency}, {p.duration}
                {p.instructions ? ` · ${p.instructions}` : ""}
              </span>
              {p.doctorName && (
                <span className="text-muted"> · {tr("prescribed by", "tajweez karda")} {p.doctorName}</span>
              )}
            </li>
          ))}
        </ul>
      )}

      <SectionTitle>
        {tr("Consultations", "Consultations")} ({bundle.medicalRecords.length})
      </SectionTitle>
      {bundle.medicalRecords.length === 0 ? (
        <p className="mt-3 text-sm text-muted">{tr("None recorded.", "Koi darj nahi.")}</p>
      ) : (
        <div className="mt-3 space-y-4">
          {bundle.medicalRecords.map((record) => (
            <article key={record.id} className="break-inside-avoid border-l-2 border-line pl-4">
              <p className="text-sm font-semibold text-strong">
                {formatDay(record.createdAt)}
                {record.doctorName && <span className="text-muted"> · {record.doctorName}</span>}
                {record.specialization && (
                  <span className="text-muted"> ({record.specialization})</span>
                )}
              </p>
              {record.diagnosis && (
                <p className="mt-1 text-sm text-strong">
                  <span className="font-medium">{tr("Diagnosis", "Tashkhees")}:</span>{" "}
                  {record.diagnosis}
                </p>
              )}
              {record.symptoms && (
                <p className="mt-0.5 text-sm text-muted">
                  <span className="font-medium">{tr("Symptoms", "Alamaat")}:</span> {record.symptoms}
                </p>
              )}
              {record.treatmentPlan && (
                <p className="mt-0.5 text-sm text-muted">
                  <span className="font-medium">{tr("Plan", "Tajweez")}:</span> {record.treatmentPlan}
                </p>
              )}
              {record.followUpDate && (
                <p className="mt-0.5 text-sm text-muted">
                  <span className="font-medium">{tr("Follow-up", "Dobara mulaqat")}:</span>{" "}
                  {formatDay(record.followUpDate)}
                  {record.followUpNotes ? ` — ${record.followUpNotes}` : ""}
                </p>
              )}
            </article>
          ))}
        </div>
      )}

      {vitals.length > 0 && (
        <>
          <SectionTitle>{tr("Recent readings", "Haaliya readings")}</SectionTitle>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-sm tabular-nums">
              <thead>
                <tr className="border-b border-line text-left text-[11px] tracking-wide text-muted uppercase">
                  <th className="py-1.5 pr-4 font-semibold">{tr("Date", "Tareekh")}</th>
                  <th className="py-1.5 pr-4 font-semibold">{tr("Pulse", "Nabz")}</th>
                  <th className="py-1.5 pr-4 font-semibold">{tr("BP", "BP")}</th>
                  <th className="py-1.5 pr-4 font-semibold">SpO₂</th>
                  <th className="py-1.5 font-semibold">{tr("Temp", "Hararat")}</th>
                </tr>
              </thead>
              <tbody>
                {vitals.map((v) => (
                  <tr key={v.id} className="border-b border-line/60">
                    <td className="py-1.5 pr-4">{formatDay(v.recordedAt)}</td>
                    {/* Units, always. A row of bare numbers on a page a
                        stranger reads is how a reading gets misread. */}
                    <td className="py-1.5 pr-4">{v.heartRate ? `${v.heartRate} bpm` : "—"}</td>
                    <td className="py-1.5 pr-4">
                      {v.systolicBp && v.diastolicBp ? `${v.systolicBp}/${v.diastolicBp} mmHg` : "—"}
                    </td>
                    <td className="py-1.5 pr-4">
                      {v.oxygenSaturation ? `${v.oxygenSaturation}%` : "—"}
                    </td>
                    <td className="py-1.5">{v.temperature ? `${v.temperature} °C` : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <footer className="mt-10 border-t border-line pt-3 text-[11px] leading-relaxed text-muted">
        {tr(
          "A summary of the record held by this clinic on the date shown. Uploaded scans and reports are not reproduced here — ask the patient for the full export, or this clinic for the originals.",
          "Iss clinic ke paas mojood record ka khulasa, oopar di gayi tareekh tak. Upload ki gayi reports yahan shamil nahi — mukammal export mareez se lein, ya asal dastavezaat iss clinic se.",
        )}
      </footer>
    </div>
  );
}

export default function PatientRecordPrint() {
  const tr = useTr();
  const record = useAsync(() => patients.exportRecord(), []);

  return (
    <AppShell role="PATIENT">
      <div className="space-y-5">
        <div className="no-print flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <h1 className="font-display text-xl font-bold text-strong">
              {tr("Printable summary", "Print karne wala khulasa")}
            </h1>
            <p className="mt-1 text-sm text-muted">
              {tr(
                "For a doctor outside this hospital. Print it, or choose Save as PDF in the print dialog.",
                "Iss hospital se bahar kisi doctor ke liye. Print karein, ya print dialog mein Save as PDF chunein.",
              )}
            </p>
          </div>
          <Button onClick={() => window.print()} disabled={!record.data}>
            <Icon name="print" className="text-[20px]" />
            {tr("Print or save as PDF", "Print ya PDF save karein")}
          </Button>
        </div>

        {record.loading && (
          <Card>
            <SkeletonRows rows={6} />
          </Card>
        )}
        {record.error && <ErrorState message={record.error.message} onRetry={record.reload} />}
        {record.data && (
          <div className="overflow-hidden rounded-2xl border border-line shadow-card">
            <Summary bundle={record.data} />
          </div>
        )}
      </div>
    </AppShell>
  );
}
