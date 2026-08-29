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

import { VitalChart, VitalGauge } from "@/components/gauges";
import { Icon } from "@/components/Icon";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Field,
  Input,
  Skeleton,
  SkeletonRows,
  SkeletonTable,
  cx,
} from "@/components/ui";
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
import { useTr } from "@/lib/lang";
import { useAsync } from "@/lib/useAsync";

function messageOf(caught: unknown, fallback: string): string {
  return caught instanceof ApiError ? caught.message : fallback;
}

const SEVERITY_TONE: Record<AlertSeverity, "critical" | "warning" | "info"> = {
  CRITICAL: "critical",
  WARNING: "warning",
  INFO: "info",
};

const SEVERITY_LABEL: Record<AlertSeverity, [string, string]> = {
  CRITICAL: ["Critical", "Sangeen"],
  WARNING: ["Warning", "Khabardari"],
  INFO: ["Information", "Ittila"],
};

const SEVERITY_ICON: Record<AlertSeverity, string> = {
  CRITICAL: "emergency",
  WARNING: "warning",
  INFO: "info",
};

/** Column order and presentation for a reading. Mirrors the server's mapping. */
const COLUMNS: {
  key: keyof Vital;
  type: VitalType;
  label: string;
  unit: string;
  name: [string, string];
}[] = [
  { key: "heartRate", type: "HEART_RATE", label: "HR", unit: "bpm", name: ["Heart rate", "Dil ki raftar"] },
  { key: "systolicBp", type: "SYSTOLIC_BP", label: "Sys", unit: "mmHg", name: ["Systolic", "Systolic"] },
  { key: "diastolicBp", type: "DIASTOLIC_BP", label: "Dia", unit: "mmHg", name: ["Diastolic", "Diastolic"] },
  { key: "oxygenSaturation", type: "OXYGEN_SATURATION", label: "SpO₂", unit: "%", name: ["Oxygen", "Oxygen"] },
  { key: "temperature", type: "TEMPERATURE", label: "Temp", unit: "°C", name: ["Temperature", "Bukhar"] },
  { key: "respiratoryRate", type: "RESPIRATORY_RATE", label: "RR", unit: "/min", name: ["Breathing", "Saans"] },
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
  const tr = useTr();
  const copy: Record<FeedState, string> = {
    connecting: tr("Connecting to live updates", "Live updates se jur rahe hain"),
    live: tr("Live", "Live"),
    offline: tr(
      "Live updates disconnected — reload to reconnect",
      "Live updates mungqata — dobara jorne ke liye reload karein",
    ),
  };
  const tone: Record<FeedState, "good" | "neutral" | "warning"> = {
    connecting: "neutral",
    live: "good",
    offline: "warning",
  };
  return (
    <span role="status" aria-live="polite">
      <Badge tone={tone[state]}>
        <span
          aria-hidden
          className={cx(
            "h-1.5 w-1.5 rounded-full bg-current",
            state === "live" && "animate-breathe",
          )}
        />
        {copy[state]}
      </Badge>
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
  const tr = useTr();
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
  const critical = alert.severity === "CRITICAL";

  return (
    <li
      // Announced, not merely coloured: a critical alert has to reach someone
      // who is not looking at this panel.
      role={critical && !settled ? "alert" : undefined}
      className={cx(
        "pop-in relative overflow-hidden rounded-2xl border p-4 pl-5 transition-[box-shadow,opacity] duration-300",
        settled
          ? "border-line bg-card opacity-80"
          : critical
            ? "glow-critical border-critical/40 bg-critical-soft"
            : "border-warning/40 bg-warning-soft/40",
      )}
    >
      <span
        aria-hidden
        className={cx(
          "absolute inset-y-0 left-0 w-1",
          settled ? "bg-line-strong" : critical ? "bg-critical" : "bg-warning",
        )}
      />

      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={SEVERITY_TONE[alert.severity]}>
          <Icon name={SEVERITY_ICON[alert.severity]} filled className="text-[14px]" />
          {tr(...SEVERITY_LABEL[alert.severity])}
        </Badge>
        <Badge tone={settled ? "good" : "neutral"}>{alert.status.toLowerCase()}</Badge>
        {alert.escalationLevel > 0 && <Badge tone="critical">{tr("escalated", "shiddat barhi")}</Badge>}
        <span className="ml-auto inline-flex items-center gap-1 text-xs tabular-nums text-muted">
          <Icon name="schedule" className="text-[14px]" />
          {when(alert.createdAt)}
        </span>
      </div>

      <p className="mt-2.5 text-[15px] leading-snug text-strong">{alert.message}</p>

      {(alert.thresholdMin !== null || alert.thresholdMax !== null) && (
        <p className="mt-1.5 text-xs tabular-nums text-muted">
          {tr("Measured", "Napa gaya")}{" "}
          <span className="font-semibold text-strong">{alert.measuredValue}</span>
          {" · "}
          {tr("limit", "had")} {alert.thresholdMin ?? "—"}–{alert.thresholdMax ?? "—"}
        </p>
      )}

      {error && (
        <p role="alert" className="mt-2 text-sm font-medium text-critical">
          {error}
        </p>
      )}

      {!settled && (
        <div className="mt-3 flex flex-wrap gap-2">
          {alert.status === "OPEN" && (
            <Button variant="secondary" disabled={busy} onClick={() => void act("acknowledge")}>
              <Icon name="visibility" className="text-[20px]" />
              {tr("I am looking at this", "Main isay dekh raha hoon")}
            </Button>
          )}
          <Button disabled={busy} onClick={() => void act("resolve")}>
            <Icon name="check_circle" className="text-[20px]" />
            {tr("Resolve", "Hal karein")}
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
  const tr = useTr();
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
      title={tr("Vital alerts", "Vitals ke alerts")}
      description={tr(
        "Raised automatically when a reading crosses its configured threshold.",
        "Jab koi reading muqarrar had paar karti hai to alert khud uthta hai.",
      )}
      icon="notifications_active"
      action={
        <div className="flex flex-wrap items-center gap-3">
          <FeedIndicator state={feed} />
          <Button variant="secondary" onClick={() => setShowResolved((value) => !value)}>
            <Icon name={showResolved ? "visibility_off" : "history"} className="text-[20px]" />
            {showResolved
              ? tr("Hide resolved", "Hal shuda chhupayein")
              : tr("Show resolved", "Hal shuda dikhayein")}
          </Button>
        </div>
      }
    >
      {fetched.loading && (
        <div aria-busy>
          <span className="sr-only">{tr("Loading alerts", "Alerts load ho rahe hain")}…</span>
          <SkeletonRows rows={3} title={false} />
        </div>
      )}
      {fetched.error && <ErrorState message={fetched.error.message} onRetry={fetched.reload} />}

      {!fetched.loading && !fetched.error && rows.length === 0 && (
        <EmptyState
          icon="verified_user"
          title={
            showResolved ? tr("No alerts", "Koi alert nahi") : tr("No open alerts", "Koi khula alert nahi")
          }
          description={tr(
            "Readings that cross a threshold will appear here as they are recorded.",
            "Had paar karne wali readings yahan usi waqt zahir hongi.",
          )}
        />
      )}

      {rows.length > 0 && (
        <>
          <p className="mb-4 flex items-center gap-2 text-sm text-muted">
            <span
              className={cx(
                "inline-flex min-w-7 items-center justify-center rounded-full px-2 py-0.5 font-display text-sm font-bold tabular-nums",
                openCount > 0 ? "bg-critical-soft text-critical" : "bg-stable-soft text-stable",
              )}
            >
              {openCount}
            </span>{" "}
            {tr("needing attention", "tawajjo talab")}
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

/**
 * The latest value of each vital as a dial, and one vital's trend beneath.
 *
 * Presentational: it takes the same readings and rules the table already
 * fetched, so the snapshot and the table can never disagree with each other.
 */
function VitalsSnapshot({
  readings,
  rules,
  loading,
}: {
  readings: Vital[];
  rules: Map<VitalType, VitalThreshold>;
  loading: boolean;
}) {
  const tr = useTr();
  const [selected, setSelected] = useState<VitalType | null>(null);

  // Readings arrive newest first, so the first non-null value is the latest.
  const latest = useMemo(
    () =>
      COLUMNS.flatMap((column) => {
        const reading = readings.find((row) => row[column.key] !== null);
        return reading
          ? [{ column, value: reading[column.key] as number, recordedAt: reading.recordedAt }]
          : [];
      }),
    [readings],
  );

  const chartType = selected ?? latest[0]?.column.type ?? null;
  const chartColumn = COLUMNS.find((column) => column.type === chartType);

  if (loading) {
    return (
      <Card
        title={tr("Health snapshot", "Sehat ka khulasa")}
        description={tr(
          "Latest reading of each vital, against its alert thresholds.",
          "Har vital ki taaza reading, alert ki hadon ke muqable mein.",
        )}
        icon="monitor_heart"
      >
        <div aria-hidden className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
          {Array.from({ length: 6 }, (_, index) => (
            <div key={index} className="flex flex-col items-center gap-3 rounded-2xl border border-line p-4">
              <Skeleton className="h-24 w-24 rounded-full" />
              <Skeleton className="h-3 w-16" />
              <Skeleton className="h-5 w-20 rounded-full" />
            </div>
          ))}
        </div>
        <Skeleton className="mt-6 h-48 w-full rounded-xl" />
      </Card>
    );
  }

  if (latest.length === 0) return null;

  return (
    <Card
      title={tr("Health snapshot", "Sehat ka khulasa")}
      description={tr(
        "Latest reading of each vital, against its alert thresholds.",
        "Har vital ki taaza reading, alert ki hadon ke muqable mein.",
      )}
      icon="monitor_heart"
      action={
        <Badge tone="neutral">
          <Icon name="schedule" className="text-[14px]" />
          {tr("Latest", "Taaza")} · {when(readings[0].recordedAt)}
        </Badge>
      }
    >
      <div className="stagger grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
        {latest.map((entry) => {
          const rule = rules.get(entry.column.type);
          const active = entry.column.type === chartType;
          return (
            <button
              key={entry.column.type}
              type="button"
              aria-pressed={active}
              onClick={() => setSelected(entry.column.type)}
              className={cx(
                "hover-lift-sm rounded-2xl p-4 shadow-card",
                "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary",
                active ? "border-gradient-thick" : "border border-line bg-card",
              )}
            >
              <VitalGauge
                type={entry.column.type}
                label={tr(...entry.column.name)}
                value={entry.value}
                unit={entry.column.unit}
                min={rule?.enabled ? rule.minValue : null}
                max={rule?.enabled ? rule.maxValue : null}
                recordedAt={entry.recordedAt}
              />
            </button>
          );
        })}
      </div>

      {chartType && chartColumn && (
        <div className="mt-6 border-t border-line pt-5">
          <VitalChart
            readings={readings}
            type={chartType}
            label={tr(...chartColumn.name)}
            unit={chartColumn.unit}
            threshold={rules.get(chartType)}
          />
        </div>
      )}
    </Card>
  );
}

/**
 * One patient's readings, with values outside their rules marked.
 *
 * `snapshot` adds the gauges and trend chart above the table, fed from the
 * same fetch.
 */
export function VitalsTable({ patientId, snapshot = false }: { patientId: string; snapshot?: boolean }) {
  const tr = useTr();
  const readings = useAsync(() => vitalsApi.list(patientId, { limit: 50 }), [patientId]);
  const rules = useAsync(() => vitalsApi.thresholds(patientId), [patientId]);

  const byType = useMemo(() => {
    const map = new Map<VitalType, VitalThreshold>();
    for (const rule of rules.data?.thresholds ?? []) map.set(rule.vitalType, rule);
    return map;
  }, [rules.data]);

  const rows = useMemo(() => readings.data?.data ?? [], [readings.data]);

  return (
    <>
      {snapshot && !readings.error && (
        <VitalsSnapshot readings={rows} rules={byType} loading={readings.loading || rules.loading} />
      )}

      <Card
        title={tr("Recent readings", "Taaza readings")}
        description={tr(
          "Newest first. Values outside range are marked.",
          "Sab se nayi pehle. Had se bahar values nishan-zadah hain.",
        )}
        icon="vital_signs"
        flush
      >
        <div className="p-4">
          {readings.loading && (
            <div role="status" aria-live="polite">
              <span className="sr-only">{tr("Loading readings", "Readings load ho rahi hain")}…</span>
              <SkeletonTable rows={4} columns={6} />
            </div>
          )}
          {readings.error && (
            <ErrorState message={readings.error.message} onRetry={readings.reload} />
          )}

          {!readings.loading && !readings.error && rows.length === 0 && (
            <EmptyState
              icon="monitor_heart"
              title={tr("No readings yet", "Abhi koi reading nahi")}
              description={tr("Recorded observations appear here.", "Darj shuda readings yahan nazar aati hain.")}
            />
          )}

          {rows.length > 0 && (
            // The table scrolls inside its own container so the page never scrolls
            // sideways on a phone.
            <div className="overflow-x-auto">
              <table className="table-modern min-w-[36rem]">
                <caption className="sr-only">Recent vital readings, newest first</caption>
                <thead>
                  <tr>
                    <th scope="col">{tr("Recorded", "Darj hui")}</th>
                    {COLUMNS.map((column) => (
                      <th key={column.key} scope="col">
                        {column.label}
                        <span className="ml-1 font-medium normal-case tracking-normal text-faint">
                          {column.unit}
                        </span>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((reading) => (
                    <tr key={reading.id}>
                      <td className="whitespace-nowrap tabular-nums text-muted">
                        {when(reading.recordedAt)}
                      </td>
                      {COLUMNS.map((column) => {
                        const value = reading[column.key] as number | null;
                        const flagged = outsideRange(value, byType.get(column.type));
                        return (
                          <td key={column.key} className="tabular-nums">
                            {value === null ? (
                              <span className="text-faint">—</span>
                            ) : (
                              <span
                                className={cx(
                                  "inline-block",
                                  flagged &&
                                    "rounded-full bg-critical-soft px-2 py-0.5 font-semibold text-critical ring-1 ring-critical/30",
                                )}
                              >
                                {value}
                                {/* Spelled out, so the mark is not colour-only. English in both
                                    locales: the tests assert it, and a screen reader set to
                                    English is the common case on ward hardware. */}
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
            <p className="mt-4 flex items-start gap-2 rounded-xl border border-warning/40 bg-warning-soft px-4 py-3 text-sm text-warning">
              <Icon name="warning" filled className="mt-px shrink-0 text-[18px]" />
              {tr("No threshold is configured for", "In ke liye koi had muqarrar nahi:")}{" "}
              {rules.data.unconfigured.join(", ").toLowerCase()}
              {tr(", so those readings will never raise an alert.", " — is liye yeh readings kabhi alert nahi uthayengi.")}
            </p>
          )}
        </div>
      </Card>
    </>
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
  const tr = useTr();
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
      title={tr("Record observations", "Readings darj karein")}
      description={tr(
        "Fill in whatever was measured. Blank fields are not recorded.",
        "Jo napa gaya wahi bharein. Khali khane darj nahi hote.",
      )}
      icon="stethoscope"
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
            className="edge-pulse flex gap-3 rounded-2xl border border-critical/50 bg-critical-soft p-5"
          >
            <Icon name="emergency" filled className="mt-0.5 shrink-0 text-[24px] text-critical" />
            <div>
              <p className="font-display font-bold text-critical">
                {raised.length === 1
                  ? tr("An alert was raised", "Ek alert uth gaya hai")
                  : tr(`${raised.length} alerts were raised`, `${raised.length} alerts uth gaye hain`)}
              </p>
              <ul className="mt-2 space-y-1 text-sm text-strong">
                {raised.map((alert) => (
                  <li key={alert.id}>{alert.message}</li>
                ))}
              </ul>
              <p className="mt-2 text-sm text-strong">
                {tr("The responsible doctor has been notified.", "Zimmedar doctor ko ittila de di gayi hai.")}
              </p>
            </div>
          </div>
        )}

        {raised.length === 0 && !error && !busy && !anyValue && (
          <p className="flex items-center gap-1.5 text-sm text-muted">
            <Icon name="info" className="text-[16px]" />
            {tr("Enter at least one measurement to save.", "Save karne ke liye kam az kam ek reading likhein.")}
          </p>
        )}

        <Button type="submit" disabled={busy || !anyValue} loading={busy}>
          {busy ? tr("Saving…", "Save ho raha hai…") : tr("Save reading", "Reading save karein")}
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
  const tr = useTr();
  const fetched = useAsync(() => vitalsApi.thresholds(patientId), [patientId]);

  return (
    <Card
      title={tr("Alert thresholds", "Alert ki hadein")}
      description={tr(
        "A rule set for this patient overrides the hospital default.",
        "Is mareez ke liye banaya gaya usool hospital ke aam usool par foqiyat rakhta hai.",
      )}
      icon="tune"
      flush
    >
      <div className="p-4">
        {fetched.loading && (
          <div role="status" aria-live="polite">
            <span className="sr-only">{tr("Loading thresholds", "Hadein load ho rahi hain")}…</span>
            <SkeletonTable rows={4} columns={4} />
          </div>
        )}
        {fetched.error && <ErrorState message={fetched.error.message} onRetry={fetched.reload} />}

        {fetched.data && (
          <div className="overflow-x-auto">
            <table className="table-modern min-w-[30rem]">
              <caption className="sr-only">Thresholds governing this patient</caption>
              <thead>
                <tr>
                  <th scope="col">{tr("Vital", "Vital")}</th>
                  <th scope="col">{tr("Range", "Had")}</th>
                  <th scope="col">{tr("Severity", "Shiddat")}</th>
                  <th scope="col">{tr("Applies from", "Kahan se laagu")}</th>
                </tr>
              </thead>
              <tbody>
                {fetched.data.thresholds.map((rule) => (
                  <tr key={rule.id}>
                    <td className="font-medium text-strong">{rule.label}</td>
                    <td className="tabular-nums">
                      {rule.minValue ?? "—"} to {rule.maxValue ?? "—"} {rule.unit}
                      {rule.sustainedReadings > 1 && (
                        <span className="ml-2 text-faint">
                          {tr(`after ${rule.sustainedReadings} readings`, `${rule.sustainedReadings} readings ke baad`)}
                        </span>
                      )}
                    </td>
                    <td>
                      <Badge tone={SEVERITY_TONE[rule.severity]}>
                        {tr(...SEVERITY_LABEL[rule.severity])}
                      </Badge>
                    </td>
                    <td>
                      <Badge tone={rule.scope === "PATIENT" ? "info" : "neutral"}>
                        <Icon
                          name={rule.scope === "PATIENT" ? "person" : "local_hospital"}
                          className="text-[14px]"
                        />
                        {rule.scope === "PATIENT"
                          ? tr("This patient", "Yeh mareez")
                          : tr("Hospital default", "Hospital ka aam usool")}
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Card>
  );
}
