"use client";

/**
 * Vitals, alerts and the live feed (spec §16-17).
 *
 * This is a monitoring surface, not a document, so the information design does
 * the work that typography does elsewhere:
 *
 * - **Severity is never colour alone.** Every alert carries a word — critical,
 *   warning — and `role="alert"` on the critical ones, because a red border is
 *   invisible to a screen reader and ambiguous to a colour-blind clinician.
 * - **A breaching value is marked in the table**, so a trend can be scanned
 *   without reading every number against a remembered threshold.
 * - **Live updates arrive over SSE**, and the spec is explicit that a frontend
 *   timer is not an acceptable substitute. The connection state is shown, so a
 *   dead feed reads as "not updating" rather than as "nothing is wrong".
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Badge, Button, Card, EmptyState, ErrorState, Field, Input, Loading, cx } from "@/components/ui";
import {
  ApiError,
  alerts as alertsApi,
  vitals as vitalsApi,
  type Alert,
  type AlertSeverity,
  type Vital,
  type VitalThreshold,
  type VitalType,
} from "@/lib/api";
import { useAsync } from "@/lib/useAsync";

function messageOf(caught: unknown, fallback: string): string {
  return caught instanceof ApiError ? caught.message : fallback;
}

const SEVERITY_TONE: Record<AlertSeverity, "critical" | "warning" | "info"> = {
  CRITICAL: "critical",
  WARNING: "warning",
  INFO: "info",
};

const SEVERITY_LABEL: Record<AlertSeverity, string> = {
  CRITICAL: "Critical",
  WARNING: "Warning",
  INFO: "Information",
};

/** Column order and presentation for a reading. Mirrors the server's mapping. */
const COLUMNS: { key: keyof Vital; type: VitalType; label: string; unit: string }[] = [
  { key: "heartRate", type: "HEART_RATE", label: "HR", unit: "bpm" },
  { key: "systolicBp", type: "SYSTOLIC_BP", label: "Sys", unit: "mmHg" },
  { key: "diastolicBp", type: "DIASTOLIC_BP", label: "Dia", unit: "mmHg" },
  { key: "oxygenSaturation", type: "OXYGEN_SATURATION", label: "SpO₂", unit: "%" },
  { key: "temperature", type: "TEMPERATURE", label: "Temp", unit: "°C" },
  { key: "respiratoryRate", type: "RESPIRATORY_RATE", label: "RR", unit: "/min" },
];

function when(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Whether a value sits outside its governing rule.
 *
 * Presentation only. The server decides what actually alerts — this just marks
 * the cell so a reader can scan a column instead of comparing every number
 * against a threshold they are holding in their head.
 */
function outsideRange(value: number | null, rule: VitalThreshold | undefined): boolean {
  if (value === null || !rule || !rule.enabled) return false;
  if (rule.minValue !== null && value < rule.minValue) return true;
  return rule.maxValue !== null && value > rule.maxValue;
}

// ---------------------------------------------------------------------------
// Live feed
// ---------------------------------------------------------------------------

type FeedState = "connecting" | "live" | "offline";

/**
 * Subscribes to the server's event stream.
 *
 * `EventSource` reconnects on its own, so the hook does not retry; it reports
 * state and lets the page say so. `onAlert` is held in a ref so an inline
 * callback does not tear the connection down on every render.
 */
function useAlertStream(onAlert: (alert: Alert) => void, onVital?: (vital: Vital) => void) {
  const [state, setState] = useState<FeedState>("connecting");
  const alertHandler = useRef(onAlert);
  const vitalHandler = useRef(onVital);

  useEffect(() => {
    alertHandler.current = onAlert;
    vitalHandler.current = onVital;
  });

  useEffect(() => {
    // withCredentials: the API is a different origin in development and the
    // session lives in a cookie, so the stream is anonymous without it.
    const source = new EventSource(alertsApi.streamUrl(), { withCredentials: true });

    source.onopen = () => setState("live");
    source.onerror = () => setState("offline");
    source.addEventListener("alert", (event) => {
      try {
        alertHandler.current(JSON.parse((event as MessageEvent).data) as Alert);
      } catch {
        // A malformed frame must not take the feed down with it.
      }
    });
    source.addEventListener("vital", (event) => {
      try {
        vitalHandler.current?.(JSON.parse((event as MessageEvent).data) as Vital);
      } catch {
        /* as above */
      }
    });

    return () => source.close();
  }, []);

  return state;
}

function FeedIndicator({ state }: { state: FeedState }) {
  const copy: Record<FeedState, string> = {
    connecting: "Connecting to live updates",
    live: "Live",
    offline: "Live updates disconnected — reload to reconnect",
  };
  const tone: Record<FeedState, "good" | "neutral" | "warning"> = {
    connecting: "neutral",
    live: "good",
    offline: "warning",
  };
  return (
    <span role="status" aria-live="polite">
      <Badge tone={tone[state]}>{copy[state]}</Badge>
    </span>
  );
}

// ---------------------------------------------------------------------------
// Alerts
// ---------------------------------------------------------------------------

function AlertRow({
  alert,
  onChanged,
}: {
  alert: Alert;
  onChanged: (next: Alert) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const act = async (action: "acknowledge" | "resolve") => {
    setBusy(true);
    setError(null);
    try {
      onChanged(
        action === "acknowledge"
          ? await alertsApi.acknowledge(alert.id)
          : await alertsApi.resolve(alert.id),
      );
    } catch (caught) {
      setError(messageOf(caught, "Could not update the alert."));
    } finally {
      setBusy(false);
    }
  };

  const settled = alert.status === "RESOLVED";

  return (
    <li
      // Announced, not merely coloured: a critical alert has to reach someone
      // who is not looking at this panel.
      role={alert.severity === "CRITICAL" && !settled ? "alert" : undefined}
      className={cx(
        "rounded-lg border p-4",
        settled
          ? "border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900"
          : alert.severity === "CRITICAL"
            ? "border-red-300 bg-red-50 dark:border-red-800 dark:bg-red-950/40"
            : "border-amber-300 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/30",
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={SEVERITY_TONE[alert.severity]}>{SEVERITY_LABEL[alert.severity]}</Badge>
        <Badge tone={settled ? "good" : "neutral"}>{alert.status.toLowerCase()}</Badge>
        {alert.escalationLevel > 0 && <Badge tone="critical">escalated</Badge>}
        <span className="ml-auto text-sm text-slate-600 tabular-nums dark:text-slate-400">
          {when(alert.createdAt)}
        </span>
      </div>

      <p className="mt-2 text-slate-900 dark:text-slate-100">{alert.message}</p>

      {error && (
        <p role="alert" className="mt-2 text-sm font-medium text-red-700 dark:text-red-400">
          {error}
        </p>
      )}

      {!settled && (
        <div className="mt-3 flex flex-wrap gap-2">
          {alert.status === "OPEN" && (
            <Button variant="secondary" disabled={busy} onClick={() => void act("acknowledge")}>
              I am looking at this
            </Button>
          )}
          <Button disabled={busy} onClick={() => void act("resolve")}>
            Resolve
          </Button>
        </div>
      )}
    </li>
  );
}

/**
 * The doctor's alert queue, updated live.
 *
 * Open alerts are listed first regardless of age: an unhandled critical from an
 * hour ago matters more than an acknowledged one from a minute ago, and sorting
 * purely by time would bury it.
 */
export function AlertsPanel() {
  const fetched = useAsync(() => alertsApi.list({ limit: 50 }), []);
  const [live, setLive] = useState<Record<string, Alert>>({});
  const [showResolved, setShowResolved] = useState(false);

  // Written only from the stream callback and event handlers — never from an
  // effect seeded with server data.
  const upsert = useCallback((alert: Alert) => {
    setLive((current) => ({ ...current, [alert.id]: alert }));
  }, []);

  const feed = useAlertStream(upsert);

  const rows = useMemo(() => {
    const byId = new Map<string, Alert>();
    for (const alert of fetched.data?.data ?? []) byId.set(alert.id, alert);
    for (const alert of Object.values(live)) byId.set(alert.id, alert);

    const rank = (alert: Alert) => (alert.status === "RESOLVED" ? 1 : 0);
    return [...byId.values()]
      .filter((alert) => showResolved || alert.status !== "RESOLVED")
      .sort(
        (a, b) =>
          rank(a) - rank(b) || new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      );
  }, [fetched.data, live, showResolved]);

  const openCount = rows.filter((alert) => alert.status !== "RESOLVED").length;

  return (
    <Card
      title="Vital alerts"
      description="Raised automatically when a reading crosses its configured threshold."
      action={
        <div className="flex items-center gap-3">
          <FeedIndicator state={feed} />
          <Button variant="secondary" onClick={() => setShowResolved((value) => !value)}>
            {showResolved ? "Hide resolved" : "Show resolved"}
          </Button>
        </div>
      }
    >
      {fetched.loading && <Loading label="Loading alerts" />}
      {fetched.error && <ErrorState message={fetched.error.message} onRetry={fetched.reload} />}

      {!fetched.loading && !fetched.error && rows.length === 0 && (
        <EmptyState
          title={showResolved ? "No alerts" : "No open alerts"}
          description="Readings that cross a threshold will appear here as they are recorded."
        />
      )}

      {rows.length > 0 && (
        <>
          <p className="mb-3 text-sm text-slate-600 dark:text-slate-400">
            <span className="font-medium tabular-nums">{openCount}</span> needing attention
          </p>
          <ul className="space-y-3">
            {rows.map((alert) => (
              <AlertRow key={alert.id} alert={alert} onChanged={upsert} />
            ))}
          </ul>
        </>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Readings
// ---------------------------------------------------------------------------

/** One patient's readings, with values outside their rules marked. */
export function VitalsTable({ patientId }: { patientId: string }) {
  const readings = useAsync(() => vitalsApi.list(patientId, { limit: 50 }), [patientId]);
  const rules = useAsync(() => vitalsApi.thresholds(patientId), [patientId]);

  const byType = useMemo(() => {
    const map = new Map<VitalType, VitalThreshold>();
    for (const rule of rules.data?.thresholds ?? []) map.set(rule.vitalType, rule);
    return map;
  }, [rules.data]);

  const rows = readings.data?.data ?? [];

  return (
    <Card title="Recent readings" description="Newest first. Values outside range are marked.">
      {readings.loading && <Loading label="Loading readings" />}
      {readings.error && (
        <ErrorState message={readings.error.message} onRetry={readings.reload} />
      )}

      {!readings.loading && !readings.error && rows.length === 0 && (
        <EmptyState title="No readings yet" description="Recorded observations appear here." />
      )}

      {rows.length > 0 && (
        // The table scrolls inside its own container so the page never scrolls
        // sideways on a phone.
        <div className="overflow-x-auto">
          <table className="w-full min-w-[36rem] text-sm">
            <caption className="sr-only">Recent vital readings, newest first</caption>
            <thead>
              <tr className="border-b border-slate-200 text-left dark:border-slate-700">
                <th scope="col" className="py-2 pr-4 font-medium">
                  Recorded
                </th>
                {COLUMNS.map((column) => (
                  <th key={column.key} scope="col" className="py-2 pr-4 font-medium">
                    {column.label}
                    <span className="ml-1 font-normal text-slate-500">{column.unit}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((reading) => (
                <tr key={reading.id} className="border-b border-slate-100 dark:border-slate-800">
                  <td className="py-2 pr-4 whitespace-nowrap tabular-nums text-slate-600 dark:text-slate-400">
                    {when(reading.recordedAt)}
                  </td>
                  {COLUMNS.map((column) => {
                    const value = reading[column.key] as number | null;
                    const flagged = outsideRange(value, byType.get(column.type));
                    return (
                      <td key={column.key} className="py-2 pr-4 tabular-nums">
                        {value === null ? (
                          <span className="text-slate-400">—</span>
                        ) : (
                          <span
                            className={cx(
                              flagged &&
                                "rounded bg-red-100 px-1.5 py-0.5 font-semibold text-red-900 dark:bg-red-950 dark:text-red-200",
                            )}
                          >
                            {value}
                            {/* Spelled out, so the mark is not colour-only. */}
                            {flagged && <span className="sr-only"> (outside range)</span>}
                          </span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {rules.data && rules.data.unconfigured.length > 0 && (
        <p className="mt-4 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
          No threshold is configured for {rules.data.unconfigured.join(", ").toLowerCase()}, so
          those readings will never raise an alert.
        </p>
      )}
    </Card>
  );
}

interface ReadingDraft {
  heartRate: string;
  systolicBp: string;
  diastolicBp: string;
  oxygenSaturation: string;
  temperature: string;
  respiratoryRate: string;
}

const EMPTY_DRAFT: ReadingDraft = {
  heartRate: "",
  systolicBp: "",
  diastolicBp: "",
  oxygenSaturation: "",
  temperature: "",
  respiratoryRate: "",
};

const FIELDS: { key: keyof ReadingDraft; label: string; unit: string; step?: string }[] = [
  { key: "heartRate", label: "Heart rate", unit: "bpm" },
  { key: "systolicBp", label: "Systolic", unit: "mmHg" },
  { key: "diastolicBp", label: "Diastolic", unit: "mmHg" },
  { key: "oxygenSaturation", label: "Oxygen saturation", unit: "%", step: "0.1" },
  { key: "temperature", label: "Temperature", unit: "°C", step: "0.1" },
  { key: "respiratoryRate", label: "Respiratory rate", unit: "/min" },
];

/**
 * Record a set of observations.
 *
 * Every field is optional — a set of obs is whatever was actually measured, and
 * forcing a full set would invite made-up numbers. The server refuses an empty
 * submission, and this disables the button rather than letting one be sent.
 */
export function RecordVitals({
  patientId,
  onRecorded,
}: {
  patientId: string;
  onRecorded?: () => void;
}) {
  const [draft, setDraft] = useState<ReadingDraft>(EMPTY_DRAFT);
  const [raised, setRaised] = useState<Alert[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const anyValue = Object.values(draft).some((value) => value.trim() !== "");

  const submit = async () => {
    setBusy(true);
    setError(null);
    setRaised([]);
    try {
      const body: Record<string, number> = {};
      for (const [key, value] of Object.entries(draft)) {
        if (value.trim() === "") continue;
        const parsed = Number(value);
        if (Number.isNaN(parsed)) {
          setError("Every value must be a number.");
          setBusy(false);
          return;
        }
        body[key] = parsed;
      }

      const result = await vitalsApi.record({ patientId, ...body });
      setDraft(EMPTY_DRAFT);
      setRaised(result.alerts);
      onRecorded?.();
    } catch (caught) {
      setError(messageOf(caught, "Could not save the reading."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      title="Record observations"
      description="Fill in whatever was measured. Blank fields are not recorded."
    >
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {FIELDS.map((field) => (
            <Field key={field.key} label={`${field.label} (${field.unit})`} htmlFor={field.key}>
              <Input
                id={field.key}
                type="number"
                inputMode="decimal"
                step={field.step ?? "1"}
                value={draft[field.key]}
                disabled={busy}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, [field.key]: event.target.value }))
                }
              />
            </Field>
          ))}
        </div>

        {error && <ErrorState message={error} />}

        {raised.length > 0 && (
          <div
            role="alert"
            className="rounded-md border-2 border-red-400 bg-red-50 p-4 dark:border-red-700 dark:bg-red-950/50"
          >
            <p className="font-semibold text-red-900 dark:text-red-200">
              {raised.length === 1 ? "An alert was raised" : `${raised.length} alerts were raised`}
            </p>
            <ul className="mt-2 space-y-1 text-sm text-red-800 dark:text-red-300">
              {raised.map((alert) => (
                <li key={alert.id}>{alert.message}</li>
              ))}
            </ul>
            <p className="mt-2 text-sm text-red-800 dark:text-red-300">
              The responsible doctor has been notified.
            </p>
          </div>
        )}

        {raised.length === 0 && !error && !busy && !anyValue && (
          <p className="text-sm text-slate-600 dark:text-slate-400">
            Enter at least one measurement to save.
          </p>
        )}

        <Button type="submit" disabled={busy || !anyValue}>
          {busy ? "Saving…" : "Save reading"}
        </Button>
      </form>
    </Card>
  );
}

/**
 * The rules governing one patient, and where each came from.
 *
 * Scope is shown per row on purpose: "why did nobody get alerted" is answerable
 * only if a reader can see whether this patient has their own limit or is
 * falling back to the hospital's.
 */
export function ThresholdsPanel({ patientId }: { patientId: string }) {
  const fetched = useAsync(() => vitalsApi.thresholds(patientId), [patientId]);

  return (
    <Card
      title="Alert thresholds"
      description="A rule set for this patient overrides the hospital default."
    >
      {fetched.loading && <Loading label="Loading thresholds" />}
      {fetched.error && <ErrorState message={fetched.error.message} onRetry={fetched.reload} />}

      {fetched.data && (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[30rem] text-sm">
            <caption className="sr-only">Thresholds governing this patient</caption>
            <thead>
              <tr className="border-b border-slate-200 text-left dark:border-slate-700">
                <th scope="col" className="py-2 pr-4 font-medium">Vital</th>
                <th scope="col" className="py-2 pr-4 font-medium">Range</th>
                <th scope="col" className="py-2 pr-4 font-medium">Severity</th>
                <th scope="col" className="py-2 pr-4 font-medium">Applies from</th>
              </tr>
            </thead>
            <tbody>
              {fetched.data.thresholds.map((rule) => (
                <tr key={rule.id} className="border-b border-slate-100 dark:border-slate-800">
                  <td className="py-2 pr-4">{rule.label}</td>
                  <td className="py-2 pr-4 tabular-nums">
                    {rule.minValue ?? "—"} to {rule.maxValue ?? "—"} {rule.unit}
                    {rule.sustainedReadings > 1 && (
                      <span className="ml-2 text-slate-500">
                        after {rule.sustainedReadings} readings
                      </span>
                    )}
                  </td>
                  <td className="py-2 pr-4">
                    <Badge tone={SEVERITY_TONE[rule.severity]}>
                      {SEVERITY_LABEL[rule.severity]}
                    </Badge>
                  </td>
                  <td className="py-2 pr-4">
                    <Badge tone={rule.scope === "PATIENT" ? "info" : "neutral"}>
                      {rule.scope === "PATIENT" ? "This patient" : "Hospital default"}
                    </Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
