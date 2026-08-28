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

import { Badge, Button, Card, ErrorState, Field, Input, Loading, cx } from "@/components/ui";
import {
  ApiError,
  ocr as ocrApi,
  type ConfirmedMedication,
  type OcrMedication,
  type OcrState,
  type OcrStructured,
} from "@/lib/api";
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
  const fetched = useAsync(() => ocrApi.get(documentId), [documentId]);

  // Written only from event handlers, never from an effect: seeding state off
  // async data is the cascading-render pattern React 19 rejects. The edits map
  // keeps the reviewer's typing without ever copying the server's response into
  // state.
  const [override, setOverride] = useState<OcrState | null>(null);
  const [edits, setEdits] = useState<Record<number, Partial<Draft>>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const state = override ?? fetched.data;

  const base = useMemo(() => draftsFrom(state?.structured), [state]);
  const drafts = useMemo(
    () => base.map((draft, index) => ({ ...draft, ...edits[index] })),
    [base, edits],
  );

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      setOverride(await ocrApi.run(documentId));
      setEdits({});
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Could not read the document.");
    } finally {
      setBusy(false);
    }
  };

  const confirm = async () => {
    setBusy(true);
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
    }
  };

  const update = (index: number, patch: Partial<Draft>) =>
    setEdits((current) => ({ ...current, [index]: { ...current[index], ...patch } }));

  const complete = drafts.length > 0 && drafts.every((d) => d.medication && d.dosage && d.frequency);
  const confirmed = state?.status === "CONFIRMED";
  const loading = fetched.loading && !override;

  return (
    <Card
      title="Extracted details"
      description={`Read automatically from ${fileName}.`}
      action={
        state?.status !== "CONFIRMED" && (
          <Button variant="secondary" disabled={busy} onClick={() => void run()}>
            {busy ? "Reading…" : state?.status === "EXTRACTED" ? "Read again" : "Read document"}
          </Button>
        )
      }
    >
      {loading && <Loading label="Loading the extraction" />}
      {error && <ErrorState message={error} onRetry={fetched.reload} />}
      {!error && fetched.error && !override && (
        <ErrorState message={fetched.error.message} onRetry={fetched.reload} />
      )}

      {state && !loading && (
        <div className="space-y-4">
          <StatusLine state={state} />

          {state.status === "SKIPPED" && (
            <p className="text-sm text-slate-600 dark:text-slate-400">
              This file type cannot be read automatically. You can still open it.
            </p>
          )}

          {state.status === "FAILED" && state.error && (
            <p role="alert" className="text-sm font-medium text-red-700 dark:text-red-400">
              {state.error}
            </p>
          )}

          {drafts.length > 0 && (
            <>
              <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
                {confirmed
                  ? "A clinician has checked these details against the document."
                  : "Read automatically and not yet verified. Check every field against the original before confirming — a misread dose changes the medication."}
              </p>

              <ol className="space-y-5">
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
                <div className="flex flex-wrap items-center gap-3">
                  <Button size="lg" disabled={!complete || busy} onClick={() => void confirm()}>
                    {busy ? "Saving…" : "Confirm this reading"}
                  </Button>
                  <p className="text-sm text-slate-600 dark:text-slate-400">
                    Confirming records what the document says. It does not prescribe anything.
                  </p>
                </div>
              )}

              {!canConfirm && !confirmed && (
                <p className="text-sm text-slate-600 dark:text-slate-400">
                  Your doctor will check these details at your next appointment.
                </p>
              )}
            </>
          )}

          {state.extractedText && (
            <details className="rounded-md border border-slate-200 p-3 dark:border-slate-700">
              <summary className="cursor-pointer text-sm font-medium text-slate-800 dark:text-slate-200">
                Show the full text that was read
              </summary>
              <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap text-sm text-slate-700 dark:text-slate-300">
                {state.extractedText}
              </pre>
            </details>
          )}
        </div>
      )}
    </Card>
  );
}

function StatusLine({ state }: { state: OcrState }) {
  const tone =
    state.status === "CONFIRMED"
      ? "good"
      : state.status === "FAILED"
        ? "critical"
        : state.status === "EXTRACTED"
          ? "warning"
          : "neutral";

  const label = {
    PENDING: "Not read yet",
    PROCESSING: "Reading…",
    EXTRACTED: "Awaiting review",
    CONFIRMED: "Checked by a clinician",
    FAILED: "Could not be read",
    SKIPPED: "Not machine-readable",
  }[state.status];

  return (
    <div className="flex flex-wrap items-center gap-3">
      <Badge tone={tone}>{label}</Badge>
      {state.confidence !== null && (
        <span className="text-sm tabular-nums text-slate-600 dark:text-slate-400">
          Engine confidence {(state.confidence * 100).toFixed(0)}%
        </span>
      )}
      {state.engine && (
        <span className="text-xs text-slate-500 dark:text-slate-500">{state.engine}</span>
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
  return (
    <div
      className={cx(
        "rounded-md border p-4",
        draft.needsReview
          ? "border-amber-300 bg-amber-50/50 dark:border-amber-800 dark:bg-amber-950/20"
          : "border-slate-200 dark:border-slate-700",
      )}
    >
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="text-sm font-semibold text-slate-800 dark:text-slate-200">
          Medication {index + 1}
        </span>
        {draft.needsReview && <Badge tone="warning">Check this one</Badge>}
      </div>

      {draft.sourceText && (
        <p className="mb-3 rounded bg-slate-100 px-2 py-1 font-mono text-xs text-slate-700 dark:bg-slate-800 dark:text-slate-300">
          Read as: {draft.sourceText}
        </p>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Medication" htmlFor={`med-${index}`}>
          <Input
            id={`med-${index}`}
            value={draft.medication}
            readOnly={readOnly}
            invalid={!draft.medication}
            onChange={(event) => onChange({ medication: event.target.value })}
          />
        </Field>
        <Field label="Dosage" htmlFor={`dose-${index}`}>
          <Input
            id={`dose-${index}`}
            value={draft.dosage}
            readOnly={readOnly}
            invalid={!draft.dosage}
            onChange={(event) => onChange({ dosage: event.target.value })}
          />
        </Field>
        <Field label="Frequency" htmlFor={`freq-${index}`}>
          <Input
            id={`freq-${index}`}
            value={draft.frequency}
            readOnly={readOnly}
            invalid={!draft.frequency}
            onChange={(event) => onChange({ frequency: event.target.value })}
          />
        </Field>
        <Field label="Duration" htmlFor={`dur-${index}`}>
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
