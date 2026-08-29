"use client";

/**
 * The review screen from spec §24: "Is this information correct? [Edit] [Confirm]"
 *
 * Every design choice here pushes against the temptation to trust the machine:
 *
 * - Fields are **editable inputs from the start**, not read-only text with an
 *   edit button. Reviewing means reading the original and typing what it says;
 *   a screen that shows finished-looking values invites clicking Confirm.
 * - Low-confidence fields are marked, and the line the text came from is shown
 *   beside them, so a reviewer can compare against the document.
 * - Confirm is disabled until every required field has a value. A blank dose
 *   cannot be confirmed by accident.
 * - The disclaimer is not dismissible.
 */

import { useMemo, useState } from "react";

import { Icon } from "@/components/Icon";
import { Badge, Button, Card, EmptyState, ErrorState, Field, Input, Loading, cx } from "@/components/ui";
import {
  ApiError,
  ocr as ocrApi,
  type ConfirmedMedication,
  type OcrMedication,
  type OcrState,
  type OcrStructured,
} from "@/lib/api";
import { useTr } from "@/lib/lang";
import { useAsync } from "@/lib/useAsync";

interface Draft {
  medication: string;
  dosage: string;
  frequency: string;
  duration: string;
  instructions: string;
  sourceText: string;
  needsReview: boolean;
}

interface ConfirmedShape {
  confirmed?: { medications?: ConfirmedMedication[] };
  proposed?: OcrStructured;
}

function isStructured(value: unknown): value is OcrStructured {
  return Boolean(value) && Array.isArray((value as OcrStructured).medications);
}

function toDraft(item: OcrMedication): Draft {
  return {
    medication: item.medication.value ?? "",
    dosage: item.dosage.value ?? "",
    frequency: item.frequency.value ?? "",
    duration: item.duration.value ?? "",
    instructions: "",
    sourceText: item.sourceText,
    needsReview: item.needsReview,
  };
}

/**
 * `structured` has two shapes: the engine's proposal before confirmation, and
 * `{proposed, confirmed}` after — the machine's reading is kept beside the
 * corrected one. Both must render, or confirming would blank the very list the
 * clinician just checked.
 */
function draftsFrom(structured: unknown): Draft[] {
  if (isStructured(structured)) return structured.medications.map(toDraft);

  const settled = (structured as ConfirmedShape | null)?.confirmed?.medications;
  if (Array.isArray(settled)) {
    return settled.map((item) => ({
      medication: item.medication,
      dosage: item.dosage,
      frequency: item.frequency,
      duration: item.duration ?? "",
      instructions: item.instructions ?? "",
      sourceText: "",
      needsReview: false,
    }));
  }
  return [];
}

export function OcrReview({
  documentId,
  fileName,
  canConfirm,
  onConfirmed,
}: {
  documentId: string;
  fileName: string;
  /** Only a doctor may confirm — a misread dose is a clinical judgement. */
  canConfirm: boolean;
  onConfirmed?: (medications: ConfirmedMedication[]) => void;
}) {
  const tr = useTr();
  const fetched = useAsync(() => ocrApi.get(documentId), [documentId]);

  // Written only from event handlers, never from an effect: seeding state off
  // async data is the cascading-render pattern React 19 rejects. The edits map
  // keeps the reviewer's typing without ever copying the server's response into
  // state.
  const [override, setOverride] = useState<OcrState | null>(null);
  const [edits, setEdits] = useState<Record<number, Partial<Draft>>>({});
  const [busy, setBusy] = useState(false);
  // Which of the two actions is in flight — the scan animation is for reading only.
  const [activity, setActivity] = useState<"read" | "confirm" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const state = override ?? fetched.data;

  const base = useMemo(() => draftsFrom(state?.structured), [state]);
  const drafts = useMemo(
    () => base.map((draft, index) => ({ ...draft, ...edits[index] })),
    [base, edits],
  );

  const run = async () => {
    setBusy(true);
    setActivity("read");
    setError(null);
    try {
      setOverride(await ocrApi.run(documentId));
      setEdits({});
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Could not read the document.");
    } finally {
      setBusy(false);
      setActivity(null);
    }
  };

  const confirm = async () => {
    setBusy(true);
    setActivity("confirm");
    setError(null);
    try {
      const medications: ConfirmedMedication[] = drafts.map((draft) => ({
        medication: draft.medication.trim(),
        dosage: draft.dosage.trim(),
        frequency: draft.frequency.trim(),
        duration: draft.duration.trim() || undefined,
        instructions: draft.instructions.trim() || undefined,
      }));
      setOverride(await ocrApi.confirm(documentId, medications));
      onConfirmed?.(medications);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Could not confirm the reading.");
    } finally {
      setBusy(false);
      setActivity(null);
    }
  };

  const update = (index: number, patch: Partial<Draft>) =>
    setEdits((current) => ({ ...current, [index]: { ...current[index], ...patch } }));

  const complete = drafts.length > 0 && drafts.every((d) => d.medication && d.dosage && d.frequency);
  const confirmed = state?.status === "CONFIRMED";
  const loading = fetched.loading && !override;
  const reading = activity === "read" || state?.status === "PROCESSING";

  return (
    <Card
      icon="document_scanner"
      title={tr("Extracted details", "Nikali gayi tafseelat")}
      description={tr(`Read automatically from ${fileName}.`, `${fileName} se khud-ba-khud parhi gayin.`)}
      action={
        state?.status !== "CONFIRMED" && (
          <Button variant="secondary" disabled={busy} onClick={() => void run()}>
            <Icon name={state?.status === "EXTRACTED" ? "refresh" : "document_scanner"} className="text-[20px]" />
            {busy
              ? tr("Reading…", "Parh raha hai…")
              : state?.status === "EXTRACTED"
                ? tr("Read again", "Dobara parhein")
                : tr("Read document", "Document parhein")}
          </Button>
        )
      }
    >
      {loading && <Loading label={tr("Loading the extraction", "Extraction load ho rahi hai")} />}
      {error && <ErrorState message={error} onRetry={fetched.reload} />}
      {!error && fetched.error && !override && (
        <ErrorState message={fetched.error.message} onRetry={fetched.reload} />
      )}

      {reading && !loading && <ScanPanel fileName={fileName} />}

      {state && !loading && !reading && (
        <div className="space-y-5">
          <StatusLine state={state} />

          {state.status === "SKIPPED" && (
            <p className="flex items-start gap-2 rounded-xl bg-sunken px-4 py-3 text-sm text-muted">
              <Icon name="info" className="mt-px shrink-0 text-[18px]" />
              {tr(
                "This file type cannot be read automatically. You can still open it.",
                "Yeh file type khud-ba-khud nahi parhi ja sakti. Aap isay phir bhi khol sakte hain.",
              )}
            </p>
          )}

          {state.status === "FAILED" && state.error && (
            <p
              role="alert"
              className="flex items-start gap-2 rounded-xl border border-critical/50 bg-critical-soft px-4 py-3 text-sm font-medium text-critical"
            >
              <Icon name="error" className="mt-px shrink-0 text-[18px]" />
              {state.error}
            </p>
          )}

          {state.status === "PENDING" && drafts.length === 0 && (
            <EmptyState
              icon="document_scanner"
              title={tr("Not read yet", "Abhi parhi nahi gayi")}
              description={tr(
                "Press “Read document” and the medication lines will be picked out for review.",
                "“Document parhein” dabayein, dawa ki lines review ke liye nikal aayein gi.",
              )}
            />
          )}

          {drafts.length > 0 && (
            <>
              <p
                className={cx(
                  "flex items-start gap-2 rounded-xl border px-4 py-3 text-sm",
                  confirmed
                    ? "border-stable/40 bg-stable-soft text-stable"
                    : "border-warning/50 bg-warning-soft text-warning",
                )}
              >
                <Icon name={confirmed ? "verified" : "warning"} filled className="mt-px shrink-0 text-[18px]" />
                {confirmed
                  ? tr(
                      "A clinician has checked these details against the document.",
                      "Ek clinician ne yeh tafseelat document se mila kar jaanch li hain.",
                    )
                  : tr(
                      "Read automatically and not yet verified. Check every field against the original before confirming — a misread dose changes the medication.",
                      "Khud-ba-khud parhi gayi, abhi tasdeeq nahi hui. Tasdeeq se pehle har field asal se milayein — ghalat parhi khuraak dawa badal deti hai.",
                    )}
              </p>

              {/* Re-keyed on every fresh reading so the fields pop in again. */}
              <ol key={`${state.status}-${state.confirmedAt ?? ""}-${base.length}`} className="stagger space-y-4">
                {drafts.map((draft, index) => (
                  <li key={`${draft.sourceText}-${index}`}>
                    <MedicationDraft
                      draft={draft}
                      index={index}
                      readOnly={confirmed || !canConfirm}
                      onChange={(patch) => update(index, patch)}
                    />
                  </li>
                ))}
              </ol>

              {!confirmed && canConfirm && (
                <div className="flex flex-wrap items-center gap-4 rounded-2xl bg-sunken p-4">
                  <Button size="lg" disabled={!complete || busy} loading={busy} onClick={() => void confirm()}>
                    {busy ? tr("Saving…", "Save ho raha hai…") : tr("Confirm this reading", "Is reading ki tasdeeq karein")}
                    {!busy && <Icon name="check" className="text-[22px]" />}
                  </Button>
                  <p className="text-sm text-muted">
                    {tr(
                      "Confirming records what the document says. It does not prescribe anything.",
                      "Tasdeeq sirf yeh darj karti hai ke document kya kehta hai. Yeh koi dawa tajweez nahi karti.",
                    )}
                  </p>
                </div>
              )}

              {!canConfirm && !confirmed && (
                <p className="flex items-start gap-2 text-sm text-muted">
                  <Icon name="stethoscope" className="mt-px shrink-0 text-[18px]" />
                  {tr(
                    "Your doctor will check these details at your next appointment.",
                    "Aap ka doctor agli appointment par yeh tafseelat jaanch le ga.",
                  )}
                </p>
              )}
            </>
          )}

          {state.extractedText && (
            <details className="group rounded-xl border border-line bg-card">
              <summary className="flex cursor-pointer items-center gap-2 px-4 py-3 text-sm font-semibold text-strong transition-colors hover:text-primary [&::-webkit-details-marker]:hidden">
                <Icon
                  name="expand_more"
                  className="text-[20px] text-faint transition-transform duration-300 group-open:rotate-180"
                />
                {tr("Show the full text that was read", "Poora parha gaya matn dikhayein")}
              </summary>
              <pre className="max-h-64 overflow-auto whitespace-pre-wrap border-t border-line bg-sunken px-4 py-3 font-mono text-xs leading-relaxed text-muted">
                {state.extractedText}
              </pre>
            </details>
          )}
        </div>
      )}
    </Card>
  );
}

/** A page being swept by the reader: a placeholder document under a scan line. */
function ScanPanel({ fileName }: { fileName: string }) {
  const tr = useTr();
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex flex-col items-center gap-5 py-6 sm:flex-row sm:justify-center sm:gap-10"
    >
      <div
        aria-hidden
        className="relative h-44 w-32 shrink-0 overflow-hidden rounded-xl border border-line bg-card shadow-card"
      >
        <div className="absolute inset-x-4 top-4 space-y-2.5">
          <span className="block h-2 w-3/4 rounded-full bg-raised" />
          <span className="block h-2 w-full rounded-full bg-sunken" />
          <span className="block h-2 w-5/6 rounded-full bg-sunken" />
          <span className="block h-2 w-2/3 rounded-full bg-sunken" />
          <span className="mt-4 block h-2 w-full rounded-full bg-sunken" />
          <span className="block h-2 w-4/5 rounded-full bg-sunken" />
          <span className="block h-2 w-1/2 rounded-full bg-sunken" />
        </div>
        <span className="scan-line" />
      </div>
      <div className="text-center sm:text-left">
        <p className="font-display text-lg font-bold text-strong">
          {tr("Reading document…", "Document parha ja raha hai…")}
        </p>
        <p className="mt-1 text-sm text-muted">{fileName}</p>
        <p className="mt-3 text-xs text-faint">
          {tr("Medication lines are picked out for you to check.", "Dawa ki lines jaanch ke liye nikali ja rahi hain.")}
        </p>
      </div>
    </div>
  );
}

function StatusLine({ state }: { state: OcrState }) {
  const tr = useTr();
  const tone =
    state.status === "CONFIRMED"
      ? "good"
      : state.status === "FAILED"
        ? "critical"
        : state.status === "EXTRACTED"
          ? "warning"
          : "neutral";

  const label = {
    PENDING: tr("Not read yet", "Abhi parhi nahi gayi"),
    PROCESSING: tr("Reading…", "Parh raha hai…"),
    EXTRACTED: tr("Awaiting review", "Review ka intezar"),
    CONFIRMED: tr("Checked by a clinician", "Clinician ne jaanch li"),
    FAILED: tr("Could not be read", "Parhi nahi ja saki"),
    SKIPPED: tr("Not machine-readable", "Machine se parhne ke qabil nahi"),
  }[state.status];

  return (
    <div className="flex flex-wrap items-center gap-3">
      <Badge tone={tone}>{label}</Badge>
      {state.confidence !== null && (
        <span className="inline-flex items-center gap-1.5 text-sm tabular-nums text-muted">
          <span
            aria-hidden
            className="h-1.5 w-20 overflow-hidden rounded-full bg-sunken"
          >
            <span
              className="bg-gradient-brand block h-full rounded-full transition-[width] duration-700 ease-out"
              style={{ width: `${Math.round(state.confidence * 100)}%` }}
            />
          </span>
          {tr(`Engine confidence ${(state.confidence * 100).toFixed(0)}%`, `Engine ka aitmaad ${(state.confidence * 100).toFixed(0)}%`)}
        </span>
      )}
      {state.engine && (
        <span className="text-xs text-faint">{state.engine}</span>
      )}
    </div>
  );
}

function MedicationDraft({
  draft,
  index,
  readOnly,
  onChange,
}: {
  draft: Draft;
  index: number;
  readOnly: boolean;
  onChange: (patch: Partial<Draft>) => void;
}) {
  const tr = useTr();
  return (
    <div
      className={cx(
        "rounded-2xl border p-5 shadow-card transition-[border-color,box-shadow] duration-200",
        draft.needsReview
          ? "border-warning/50 bg-warning-soft/40"
          : "border-line bg-card",
      )}
    >
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <span
          aria-hidden
          className={cx(
            "grid h-8 w-8 place-items-center rounded-lg text-sm font-bold tabular-nums",
            draft.needsReview ? "bg-warning-soft text-warning" : "bg-gradient-soft text-primary",
          )}
        >
          {index + 1}
        </span>
        <span className="font-display text-base font-bold text-strong">
          {tr("Medication", "Dawa")} {index + 1}
        </span>
        {draft.needsReview && <Badge tone="warning">{tr("Check this one", "Isay zaroor jaanchein")}</Badge>}
      </div>

      {draft.sourceText && (
        <p className="mb-4 flex items-start gap-2 rounded-xl bg-sunken px-3 py-2 font-mono text-xs text-muted">
          <Icon name="format_quote" className="mt-px shrink-0 text-[16px] text-faint" />
          <span>
            {tr("Read as:", "Aisa parha gaya:")} {draft.sourceText}
          </span>
        </p>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={tr("Medication", "Dawa")} htmlFor={`med-${index}`}>
          <Input
            id={`med-${index}`}
            value={draft.medication}
            readOnly={readOnly}
            invalid={!draft.medication}
            onChange={(event) => onChange({ medication: event.target.value })}
          />
        </Field>
        <Field label={tr("Dosage", "Khuraak")} htmlFor={`dose-${index}`}>
          <Input
            id={`dose-${index}`}
            value={draft.dosage}
            readOnly={readOnly}
            invalid={!draft.dosage}
            onChange={(event) => onChange({ dosage: event.target.value })}
          />
        </Field>
        <Field label={tr("Frequency", "Kitni baar")} htmlFor={`freq-${index}`}>
          <Input
            id={`freq-${index}`}
            value={draft.frequency}
            readOnly={readOnly}
            invalid={!draft.frequency}
            onChange={(event) => onChange({ frequency: event.target.value })}
          />
        </Field>
        <Field label={tr("Duration", "Kitne din")} htmlFor={`dur-${index}`}>
          <Input
            id={`dur-${index}`}
            value={draft.duration}
            readOnly={readOnly}
            onChange={(event) => onChange({ duration: event.target.value })}
          />
        </Field>
      </div>
    </div>
  );
}
