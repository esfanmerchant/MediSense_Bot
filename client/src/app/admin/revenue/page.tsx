"use client";

/**
 * What the platform has taken, and what of it is actually the platform's.
 *
 * The page leads with the flattering number because that is the one people ask
 * for — and then immediately splits it, because most of it was never MediSense's
 * money. It passed through on the way to a doctor or to the tax authority, and a
 * dashboard that lets "total revenue" stand unqualified is one somebody
 * eventually has to explain to an accountant.
 *
 * So the tiles are ordered as an argument: handled, then out to doctors, then
 * held for tax, then what is left — which is the only figure here that is
 * income. The amount still owed to doctors sits beside them as a debt.
 */

import { useState } from "react";

import { AppShell } from "@/components/AppShell";
import { Icon } from "@/components/Icon";
import { PageHeader } from "@/components/PageHeader";
import {
  PageSectionNav,
  Section,
  type Section as SectionSpec,
} from "@/components/layout/PageSectionNav";
import { CategoryBars, TimeBars, type Bar } from "@/components/charts";
import { Card, ErrorState, SkeletonRows, cx } from "@/components/ui";
import { revenue, type RevenueGrain } from "@/lib/api";
import { useTr } from "@/lib/lang";
import { useAsync } from "@/lib/useAsync";

const GRAINS: Array<{ value: RevenueGrain; label: [string, string] }> = [
  { value: "day", label: ["Daily", "Rozana"] },
  { value: "week", label: ["Weekly", "Haftawar"] },
  { value: "month", label: ["Monthly", "Mahana"] },
];

function amount(value: string, currency: string): string {
  return `${currency} ${new Intl.NumberFormat("en-PK", { maximumFractionDigits: 0 }).format(
    Number(value) || 0,
  )}`;
}

function Tile({
  label,
  value,
  hint,
  emphasis,
}: {
  label: string;
  value: string;
  hint: string;
  /** The one figure on the row that is actually income. */
  emphasis?: boolean;
}) {
  return (
    <div
      className={cx(
        "rounded-2xl border p-4",
        emphasis ? "border-gradient-thick" : "border-line bg-card",
      )}
    >
      <p className="text-[11px] font-bold uppercase tracking-wider text-faint">{label}</p>
      <p className="mt-1 font-display text-2xl font-bold tabular-nums text-strong">{value}</p>
      <p className="mt-1 text-xs text-muted">{hint}</p>
    </div>
  );
}

/** How a period reads on a chart axis, at the grain being shown. */
function periodLabel(iso: string, grain: RevenueGrain): string {
  const date = new Date(iso);
  if (grain === "month") {
    return date.toLocaleDateString(undefined, { month: "short", year: "2-digit" });
  }
  return date.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

const SECTIONS: SectionSpec[] = [
  { id: "totals", label: "Totals", icon: "payments" },
  { id: "over-time", label: "Over time", icon: "bar_chart" },
  { id: "by-speciality", label: "By speciality", icon: "pie_chart" },
];

export default function AdminRevenue() {
  const tr = useTr();
  const [grain, setGrain] = useState<RevenueGrain>("month");

  const summary = useAsync(() => revenue.summary(), []);
  const series = useAsync(() => revenue.series(grain), [grain]);

  const totals = summary.data;
  const currency = totals?.currency ?? "PKR";

  const bars: Bar[] = (series.data?.points ?? []).map((point) => ({
    label: periodLabel(point.period, grain),
    value: point.handled,
    detail: `${periodLabel(point.period, grain)} · ${point.invoices} ${
      point.invoices === 1 ? "invoice" : "invoices"
    }`,
  }));

  const specialities: Bar[] = (series.data?.bySpeciality ?? []).map((row) => ({
    label: row.label,
    value: row.amount,
  }));

  return (
    <AppShell role="ADMIN">
      <div id="main" className="page-enter space-y-6">
        <PageHeader
          eyebrow={tr("Admin portal", "Intezami portal")}
          title={tr("Revenue", "Aamdani")}
          subtitle={tr(
            "Money that has actually been paid, and whose it is.",
            "Woh raqam jo waqai ada ho chuki, aur woh kis ki hai.",
          )}
        />

        {summary.loading && <SkeletonRows rows={2} />}
        {summary.error && <ErrorState message={summary.error.message} onRetry={summary.reload} />}

        {totals && (
          <>
            <PageSectionNav mode="jump" label="Sections" sections={SECTIONS} />

            <Section id="totals">
<Card>
              <p className="text-[11px] font-bold uppercase tracking-wider text-faint">
                {tr("Handled all time", "Ab tak kul raqam")}
              </p>
              <p className="font-display text-5xl font-bold tabular-nums text-strong">
                {amount(totals.allTime.handled, currency)}
              </p>
              <p className="mt-1 text-sm text-muted">
                {tr(
                  `Across ${totals.allTime.invoices} paid invoices · ${amount(totals.thisMonth.handled, currency)} this month`,
                  `${totals.allTime.invoices} ada shuda invoices · is mahine ${amount(totals.thisMonth.handled, currency)}`,
                )}
              </p>

              {/* Ordered as an argument: what came in, what left, what stayed. */}
              <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                <Tile
                  label={tr("Paid to doctors", "Doctors ko gaya")}
                  value={amount(totals.allTime.toDoctors, currency)}
                  hint={tr("Consultation fees — never ours.", "Consultation fees — kabhi hamari nahi.")}
                />
                <Tile
                  label={tr("Held for tax", "Tax ke liye roka")}
                  value={amount(totals.allTime.tax, currency)}
                  hint={tr(
                    "Collected for the state, not income.",
                    "Riyasat ke liye jama, aamdani nahi.",
                  )}
                />
                <Tile
                  emphasis
                  label={tr("MediSense earned", "MediSense ki kamai")}
                  value={amount(totals.allTime.earned, currency)}
                  hint={tr(
                    "Platform fees and late charges.",
                    "Platform fees aur der ke charges.",
                  )}
                />
                <Tile
                  label={tr("Owed to doctors", "Doctors ko dena hai")}
                  value={amount(totals.owedToDoctors, currency)}
                  hint={tr(
                    "Credited but not yet withdrawn.",
                    "Credit ho chuka, abhi nikala nahi.",
                  )}
                />
              </div>
            </Card>

            
            </Section>

            <Section id="over-time">
<Card
              icon="bar_chart"
              title={tr("Over time", "Waqt ke saath")}
              action={
                // One row of filters above the chart.
                <div
                  role="group"
                  aria-label={tr("Period", "Muddat")}
                  className="inline-flex rounded-lg border border-line p-0.5"
                >
                  {GRAINS.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      aria-pressed={grain === option.value}
                      onClick={() => setGrain(option.value)}
                      className={cx(
                        "min-h-8 rounded-md px-3 text-xs font-bold transition-colors",
                        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary",
                        grain === option.value
                          ? "bg-primary text-primary-on"
                          : "text-muted hover:text-strong",
                      )}
                    >
                      {tr(...option.label)}
                    </button>
                  ))}
                </div>
              }
            >
              {series.loading && <SkeletonRows rows={2} />}
              {series.error && (
                <ErrorState message={series.error.message} onRetry={series.reload} />
              )}
              {series.data && (
                <TimeBars
                  bars={bars}
                  currency={currency}
                  label={tr(
                    "Money paid, by period",
                    "Ada shuda raqam, muddat ke hisaab se",
                  )}
                />
              )}
            </Card>

            </Section>

            <Section id="by-speciality">
            {specialities.length > 0 && (
              <Card icon="pie_chart" title={tr("By speciality", "Speciality ke hisaab se")}>
                <CategoryBars
                  bars={specialities}
                  currency={currency}
                  label={tr(
                    "Where the money came from",
                    "Raqam kahan se aayi",
                  )}
                />
                <p className="mt-4 flex items-start gap-2 text-xs text-muted">
                  <Icon name="info" className="mt-0.5 shrink-0 text-[15px]" />
                  {tr(
                    "Grouped by each doctor's current speciality, so a doctor who changes speciality takes their past income with them.",
                    "Har doctor ki maujooda speciality ke hisaab se — speciality badalne par purani aamdani bhi saath chali jaati hai.",
                  )}
                </p>
              </Card>
            )}
              </Section>

              
          </>
        )}
      </div>
    </AppShell>
  );
}
