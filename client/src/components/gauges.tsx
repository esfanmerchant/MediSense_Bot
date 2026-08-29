"use client";

/**
 * Vital-sign gauges and trend charts, drawn in plain SVG.
 *
 * No chart library: a reading is a number, a threshold is a line, and a trend
 * is a path. Everything here is presentational — the values, the thresholds
 * and the decision about what alerts all come from the server, and nothing in
 * this file changes them.
 *
 * **Colour carries proximity, words carry meaning.** A gauge's arc warms from
 * green through amber to red as the reading approaches its threshold, but the
 * pill beneath it says "In range" / "Near limit" / "Out of range" in words,
 * because a colour-blind clinician and a screen reader both need the same
 * answer.
 */

import { motion, useReducedMotion } from "framer-motion";
import { useEffect, useId, useMemo, useRef, useState } from "react";

import { Icon } from "@/components/Icon";
import { Badge, PillGroup, cx } from "@/components/ui";
import type { Vital, VitalThreshold, VitalType } from "@/lib/api";
import { useTr } from "@/lib/lang";

// ---------------------------------------------------------------------------
// Shared vocabulary
// ---------------------------------------------------------------------------

/** Which field of a reading each vital type lives in. Mirrors the server. */
export const VITAL_KEY: Record<VitalType, keyof Vital> = {
  HEART_RATE: "heartRate",
  SYSTOLIC_BP: "systolicBp",
  DIASTOLIC_BP: "diastolicBp",
  OXYGEN_SATURATION: "oxygenSaturation",
  TEMPERATURE: "temperature",
  RESPIRATORY_RATE: "respiratoryRate",
};

/** A Material Symbol for each vital. Decorative; the label carries the name. */
export const VITAL_ICON: Record<VitalType, string> = {
  HEART_RATE: "favorite",
  SYSTOLIC_BP: "blood_pressure",
  DIASTOLIC_BP: "blood_pressure",
  OXYGEN_SATURATION: "spo2",
  TEMPERATURE: "thermometer",
  RESPIRATORY_RATE: "pulmonology",
};

/**
 * The span a gauge shows when a threshold is one-sided or missing. Display
 * only — wide enough that any plausible reading lands on the dial.
 */
const TYPICAL_SPAN: Record<VitalType, [number, number]> = {
  HEART_RATE: [40, 160],
  SYSTOLIC_BP: [70, 200],
  DIASTOLIC_BP: [40, 130],
  OXYGEN_SATURATION: [70, 100],
  TEMPERATURE: [34, 41],
  RESPIRATORY_RATE: [6, 40],
};

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

function formatValue(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

type Proximity =
  | { kind: "unknown" }
  | { kind: "outside" }
  /** `warmth` runs 0 (comfortably inside) → 1 (touching the limit). */
  | { kind: "inside"; warmth: number };

/**
 * How close a value sits to its limits.
 *
 * Half the threshold span is "comfortable"; the warmth only begins to climb
 * in the outer half, and turns towards red in the last fifth. A normal
 * heart rate of 72 against 50–120 stays green rather than nervously yellow.
 */
function proximity(
  value: number,
  type: VitalType,
  min: number | null,
  max: number | null,
): Proximity {
  if (min === null && max === null) return { kind: "unknown" };
  if ((min !== null && value < min) || (max !== null && value > max)) return { kind: "outside" };

  const typical = TYPICAL_SPAN[type];
  const span = min !== null && max !== null ? max - min : typical[1] - typical[0];
  const half = Math.max(span / 2, 1e-6);
  const distances = [min, max]
    .filter((edge): edge is number => edge !== null)
    .map((edge) => Math.abs(value - edge));
  const ratio = clamp(Math.min(...distances) / half, 0, 1);

  let warmth: number;
  if (ratio >= 0.5) warmth = 0;
  else if (ratio >= 0.2) warmth = ((0.5 - ratio) / 0.3) * 0.5;
  else warmth = 0.5 + ((0.2 - ratio) / 0.2) * 0.5;
  return { kind: "inside", warmth };
}

/** The arc colour, mixed between the status tokens so it follows the theme. */
function arcColor(state: Proximity): string {
  if (state.kind === "unknown") return "var(--brand-primary)";
  if (state.kind === "outside") return "var(--status-critical)";
  const { warmth } = state;
  if (warmth <= 0.5) {
    return `color-mix(in oklab, var(--status-stable), var(--status-warning) ${Math.round(warmth * 200)}%)`;
  }
  return `color-mix(in oklab, var(--status-warning), var(--status-critical) ${Math.round((warmth - 0.5) * 200)}%)`;
}

// ---------------------------------------------------------------------------
// Gauge
// ---------------------------------------------------------------------------

const GAUGE = { size: 120, cx: 60, cy: 60, r: 46, stroke: 9, start: 135, sweep: 270 } as const;

function polar(angleDeg: number, radius: number = GAUGE.r): [number, number] {
  const rad = (angleDeg * Math.PI) / 180;
  return [GAUGE.cx + radius * Math.cos(rad), GAUGE.cy + radius * Math.sin(rad)];
}

/** The 270° track, open at the bottom, as one arc command. */
const TRACK_PATH = (() => {
  const [sx, sy] = polar(GAUGE.start);
  const [ex, ey] = polar(GAUGE.start + GAUGE.sweep);
  return `M ${sx.toFixed(2)} ${sy.toFixed(2)} A ${GAUGE.r} ${GAUGE.r} 0 1 1 ${ex.toFixed(2)} ${ey.toFixed(2)}`;
})();

/**
 * One reading on a dial, coloured by how close it sits to its threshold.
 *
 * The dial's range is the typical span for that vital, widened to include the
 * thresholds and the reading itself, so nothing ever falls off the end. Small
 * ticks mark where the limits are.
 */
export function VitalGauge({
  type,
  label,
  value,
  unit,
  min = null,
  max = null,
  recordedAt,
  className,
}: {
  type: VitalType;
  label: string;
  value: number;
  unit: string;
  min?: number | null;
  max?: number | null;
  /** Shown as a caption when given, so an old reading is not mistaken for now. */
  recordedAt?: string;
  className?: string;
}) {
  const tr = useTr();
  const reduceMotion = useReducedMotion();
  const state = proximity(value, type, min, max);
  const color = arcColor(state);

  const [low, high] = useMemo(() => {
    const typical = TYPICAL_SPAN[type];
    const lo = Math.min(typical[0], min ?? Infinity, value);
    const hi = Math.max(typical[1], max ?? -Infinity, value);
    const pad = Math.max((hi - lo) * 0.05, 0.5);
    return [lo - pad, hi + pad];
  }, [type, min, max, value]);

  const fractionOf = (v: number) => clamp((v - low) / (high - low), 0, 1);
  const target = fractionOf(value);

  // Starts empty and sweeps to the reading; the CSS transition does the work,
  // and reduced motion collapses it globally.
  const [fraction, setFraction] = useState(0);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setFraction(target));
    return () => cancelAnimationFrame(frame);
  }, [target]);

  const tick = (v: number) => {
    const angle = GAUGE.start + GAUGE.sweep * fractionOf(v);
    const [x1, y1] = polar(angle, GAUGE.r - GAUGE.stroke / 2 - 3);
    const [x2, y2] = polar(angle, GAUGE.r + GAUGE.stroke / 2 + 3);
    return { x1, y1, x2, y2 };
  };

  const pill =
    state.kind === "outside"
      ? { tone: "critical" as const, text: tr("Out of range", "Had se bahar") }
      : state.kind === "unknown"
        ? { tone: "neutral" as const, text: tr("No threshold", "Koi had nahi") }
        : state.warmth >= 0.5
          ? { tone: "warning" as const, text: tr("Near limit", "Had ke qareeb") }
          : { tone: "good" as const, text: tr("In range", "Had ke andar") };

  // A heart-rate dial beats at the reading's own tempo — gently.
  const pulse =
    type === "HEART_RATE" && !reduceMotion
      ? {
          animate: { scale: [1, 1.035, 1] },
          transition: {
            duration: clamp(60 / Math.max(value, 1), 0.5, 1.6),
            repeat: Infinity,
            ease: "easeInOut" as const,
          },
        }
      : {};

  return (
    <div className={cx("flex flex-col items-center gap-2 text-center", className)}>
      <motion.div {...pulse} className="relative w-full max-w-[9.5rem]">
        <svg
          viewBox={`0 0 ${GAUGE.size} ${GAUGE.size}`}
          className="h-auto w-full overflow-visible"
          role="img"
          aria-label={`${label}: ${formatValue(value)} ${unit}, ${pill.text}`}
        >
          <path
            d={TRACK_PATH}
            fill="none"
            stroke="var(--line)"
            strokeWidth={GAUGE.stroke}
            strokeLinecap="round"
          />
          <path
            d={TRACK_PATH}
            fill="none"
            stroke={color}
            strokeWidth={GAUGE.stroke}
            strokeLinecap="round"
            pathLength={1}
            strokeDasharray="1 1"
            strokeDashoffset={1 - fraction}
            style={{
              transition: "stroke-dashoffset 0.9s var(--ease-out-soft), stroke 0.4s ease",
              filter: `drop-shadow(0 0 6px color-mix(in oklab, ${color} 45%, transparent))`,
            }}
          />
          {[min, max]
            .filter((edge): edge is number => edge !== null)
            .map((edge) => (
              <line
                key={edge}
                {...tick(edge)}
                stroke="var(--text-faint)"
                strokeWidth={1.5}
                strokeLinecap="round"
                opacity={0.8}
              />
            ))}
          <foreignObject x={22} y={26} width={76} height={68}>
            <div className="flex h-full flex-col items-center justify-center leading-none">
              {/* The icon takes the arc's colour so the centre and the dial agree. */}
              <span style={{ color }} className="leading-none">
                <Icon name={VITAL_ICON[type]} filled className="text-[16px]" />
              </span>
              <span className="mt-1.5 font-display text-[26px] font-bold tabular-nums text-strong">
                {formatValue(value)}
              </span>
              <span className="mt-1 text-[11px] font-semibold text-muted">{unit}</span>
            </div>
          </foreignObject>
        </svg>
      </motion.div>

      <p className="text-sm font-semibold text-strong">{label}</p>
      <Badge tone={pill.tone}>{pill.text}</Badge>
      {recordedAt && (
        <p className="text-[11px] tabular-nums text-faint">
          {new Date(recordedAt).toLocaleString(undefined, {
            day: "2-digit",
            month: "short",
            hour: "2-digit",
            minute: "2-digit",
          })}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Chart
// ---------------------------------------------------------------------------

type Range = "24h" | "7d" | "30d" | "all";

const RANGE_HOURS: Record<Range, number> = {
  "24h": 24,
  "7d": 24 * 7,
  "30d": 24 * 30,
  all: Infinity,
};

const CHART = { w: 640, h: 240, l: 48, r: 20, t: 18, b: 30 } as const;

interface Point {
  x: number;
  y: number;
  value: number;
  at: string;
  flagged: boolean;
}

/** Catmull-Rom through the points, emitted as cubic Béziers. */
function smoothPath(points: Point[]): string {
  if (points.length === 0) return "";
  if (points.length === 1) return `M ${points[0].x} ${points[0].y}`;
  let d = `M ${points[0].x.toFixed(1)} ${points[0].y.toFixed(1)}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[Math.max(i - 1, 0)];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[Math.min(i + 2, points.length - 1)];
    const c1x = p1.x + (p2.x - p0.x) / 6;
    const c1y = p1.y + (p2.y - p0.y) / 6;
    const c2x = p2.x - (p3.x - p1.x) / 6;
    const c2y = p2.y - (p3.y - p1.y) / 6;
    d += ` C ${c1x.toFixed(1)} ${c1y.toFixed(1)}, ${c2x.toFixed(1)} ${c2y.toFixed(1)}, ${p2.x.toFixed(1)} ${p2.y.toFixed(1)}`;
  }
  return d;
}

function formatTick(value: number, span: number): string {
  return span < 10 ? value.toFixed(1) : String(Math.round(value));
}

function formatStamp(iso: string, range: Range): string {
  const date = new Date(iso);
  if (range === "24h") {
    return date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  }
  return date.toLocaleString(undefined, {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function windowOf<T extends { at: string }>(series: T[], range: Range, now: number): T[] {
  return series.filter((point) => Date.parse(point.at) >= now - RANGE_HOURS[range] * 3_600_000);
}

/**
 * One vital over time: a smooth line, its threshold limits as dashed rules,
 * and a tooltip that follows the cursor to the nearest reading.
 */
export function VitalChart({
  readings,
  type,
  label,
  unit,
  threshold,
  className,
}: {
  readings: Vital[];
  type: VitalType;
  label: string;
  unit: string;
  threshold?: VitalThreshold;
  className?: string;
}) {
  const tr = useTr();
  const gradientId = useId();
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [hover, setHover] = useState<number | null>(null);

  const key = VITAL_KEY[type];
  const min = threshold?.enabled ? threshold.minValue : null;
  const max = threshold?.enabled ? threshold.maxValue : null;

  // Oldest first, and only readings that carry this vital.
  const series = useMemo(
    () =>
      readings
        .filter((reading) => reading[key] !== null)
        .map((reading) => ({ at: reading.recordedAt, value: reading[key] as number }))
        .sort((a, b) => Date.parse(a.at) - Date.parse(b.at)),
    [readings, key],
  );

  // "Now" is read when the chart mounts and whenever the range is changed —
  // from an event, never mid-render.
  const [now, setNow] = useState(() => Date.now());

  // Opens on the tightest window that still shows a trend, so a sparse chart
  // is never empty on arrival.
  const [range, setRange] = useState<Range>(
    () => (["24h", "7d", "30d"] as Range[]).find((r) => windowOf(series, r, now).length >= 2) ?? "all",
  );

  const { points, domain } = useMemo(() => {
    const visible = windowOf(series, range, now);
    if (visible.length === 0) return { points: [] as Point[], domain: null };
    const times = visible.map((point) => Date.parse(point.at));
    const t0 = Math.min(...times);
    const t1 = Math.max(...times);
    const values = visible.map((point) => point.value);
    const lo = Math.min(...values, min ?? Infinity, max ?? Infinity);
    const hi = Math.max(...values, min ?? -Infinity, max ?? -Infinity);
    const pad = hi === lo ? Math.max(Math.abs(hi) * 0.05, 1) : (hi - lo) * 0.12;
    const y0 = lo - pad;
    const y1 = hi + pad;
    const innerW = CHART.w - CHART.l - CHART.r;
    const innerH = CHART.h - CHART.t - CHART.b;
    const yOf = (v: number) => CHART.t + (1 - (v - y0) / (y1 - y0)) * innerH;
    const points: Point[] = visible.map((point, index) => ({
      x: t1 === t0 ? CHART.l + innerW / 2 : CHART.l + ((times[index] - t0) / (t1 - t0)) * innerW,
      y: yOf(point.value),
      value: point.value,
      at: point.at,
      flagged: (min !== null && point.value < min) || (max !== null && point.value > max),
    }));
    return { points, domain: { y0, y1, yOf, span: y1 - y0 } };
  }, [series, range, now, min, max]);

  const line = useMemo(() => smoothPath(points), [points]);
  const baseline = CHART.h - CHART.b;
  const area =
    points.length > 1
      ? `${line} L ${points[points.length - 1].x.toFixed(1)} ${baseline} L ${points[0].x.toFixed(1)} ${baseline} Z`
      : "";

  const onMove = (event: React.MouseEvent<SVGSVGElement>) => {
    const svg = svgRef.current;
    if (!svg || points.length === 0) return;
    const rect = svg.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width) * CHART.w;
    let nearest = 0;
    for (let i = 1; i < points.length; i++) {
      if (Math.abs(points[i].x - x) < Math.abs(points[nearest].x - x)) nearest = i;
    }
    setHover(nearest);
  };

  const active = hover !== null ? points[hover] : null;
  const ticks = domain ? [0, 1, 2, 3, 4].map((i) => domain.y0 + (i * domain.span) / 4) : [];
  const rangeLabel: Record<Range, string> = {
    "24h": tr("the last 24 hours", "pichhle 24 ghanton"),
    "7d": tr("the last 7 days", "pichhle 7 dinon"),
    "30d": tr("the last 30 days", "pichhle 30 dinon"),
    all: tr("this period", "is muddat"),
  };

  return (
    <div className={cx("space-y-3", className)}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span
            aria-hidden
            className="bg-gradient-soft grid h-9 w-9 place-items-center rounded-lg text-primary"
          >
            <Icon name={VITAL_ICON[type]} filled className="text-[20px]" />
          </span>
          <div>
            <p className="text-sm font-semibold text-strong">{label}</p>
            <p className="text-xs text-muted">
              {tr("Trend", "Rujhan")} · {unit}
            </p>
          </div>
        </div>
        <PillGroup<Range>
          label={tr("Time range", "Waqt ki muddat")}
          value={range}
          onChange={(next) => {
            setHover(null);
            setNow(Date.now());
            setRange(next);
          }}
          options={[
            { value: "24h", label: "24H" },
            { value: "7d", label: "7D" },
            { value: "30d", label: "30D" },
            { value: "all", label: tr("All", "Sab") },
          ]}
        />
      </div>

      {points.length === 0 || !domain ? (
        <p className="rounded-xl bg-sunken px-4 py-6 text-center text-sm text-muted">
          {tr("No readings in", "Koi reading nahi")} {rangeLabel[range]}.
        </p>
      ) : (
        <div className="relative">
          <svg
            ref={svgRef}
            viewBox={`0 0 ${CHART.w} ${CHART.h}`}
            className="h-auto w-full overflow-visible"
            role="img"
            aria-label={`${label}, ${points.length} ${tr("readings over", "readings")} ${rangeLabel[range]}`}
            onMouseMove={onMove}
            onMouseLeave={() => setHover(null)}
          >
            <defs>
              <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--brand-primary)" stopOpacity={0.28} />
                <stop offset="100%" stopColor="var(--brand-accent-bright)" stopOpacity={0} />
              </linearGradient>
            </defs>

            {ticks.map((value) => (
              <g key={value}>
                <line
                  x1={CHART.l}
                  x2={CHART.w - CHART.r}
                  y1={domain.yOf(value)}
                  y2={domain.yOf(value)}
                  stroke="var(--line)"
                  strokeWidth={1}
                />
                <text
                  x={CHART.l - 8}
                  y={domain.yOf(value)}
                  textAnchor="end"
                  dominantBaseline="middle"
                  className="fill-faint text-[11px] tabular-nums"
                >
                  {formatTick(value, domain.span)}
                </text>
              </g>
            ))}

            {[
              { edge: max, name: tr("max", "zyada se zyada") },
              { edge: min, name: tr("min", "kam se kam") },
            ]
              .filter((rule): rule is { edge: number; name: string } => rule.edge !== null)
              .map((rule) => (
                <g key={rule.name}>
                  <line
                    x1={CHART.l}
                    x2={CHART.w - CHART.r}
                    y1={domain.yOf(rule.edge)}
                    y2={domain.yOf(rule.edge)}
                    stroke="var(--status-warning)"
                    strokeWidth={1.5}
                    strokeDasharray="6 5"
                    opacity={0.8}
                  />
                  <text
                    x={CHART.w - CHART.r}
                    y={domain.yOf(rule.edge) - 5}
                    textAnchor="end"
                    className="fill-warning text-[10px] font-semibold tabular-nums"
                  >
                    {rule.name} {formatValue(rule.edge)}
                  </text>
                </g>
              ))}

            {area && <path d={area} fill={`url(#${gradientId})`} />}
            <path
              d={line}
              fill="none"
              stroke="var(--brand-primary)"
              strokeWidth={2.5}
              strokeLinecap="round"
              strokeLinejoin="round"
            />

            {active && (
              <line
                x1={active.x}
                x2={active.x}
                y1={CHART.t}
                y2={baseline}
                stroke="var(--text-faint)"
                strokeWidth={1}
                strokeDasharray="3 4"
              />
            )}

            {points.map((point, index) => (
              <circle
                key={point.at + index}
                cx={point.x}
                cy={point.y}
                r={hover === index ? 6 : 3.5}
                fill={point.flagged ? "var(--status-critical)" : "var(--surface-card)"}
                stroke={point.flagged ? "var(--status-critical)" : "var(--brand-primary)"}
                strokeWidth={2}
                style={{ transition: "r 0.15s ease" }}
              />
            ))}

            {points.length > 1 &&
              [points[0], points[points.length - 1]].map((point, index) => (
                <text
                  key={point.at + "-axis"}
                  x={point.x}
                  y={CHART.h - 8}
                  textAnchor={index === 0 ? "start" : "end"}
                  className="fill-faint text-[11px] tabular-nums"
                >
                  {formatStamp(point.at, range)}
                </text>
              ))}
          </svg>

          {active && (
            <div
              role="tooltip"
              className="glass pointer-events-none absolute z-10 rounded-xl px-3 py-2 text-xs"
              style={{
                left: `${(active.x / CHART.w) * 100}%`,
                top: `${(active.y / CHART.h) * 100}%`,
                transform: "translate(-50%, calc(-100% - 12px))",
                transition: "left 0.12s ease, top 0.12s ease",
              }}
            >
              <p
                className={cx(
                  "font-display text-base font-bold tabular-nums",
                  active.flagged ? "text-critical" : "text-strong",
                )}
              >
                {formatValue(active.value)} <span className="text-xs font-semibold text-muted">{unit}</span>
              </p>
              <p className="whitespace-nowrap tabular-nums text-muted">{formatStamp(active.at, "7d")}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
