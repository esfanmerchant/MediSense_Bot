"use client";

/**
 * The rates an administrator owns.
 *
 * The tax rate used to be an environment variable, which put the number a
 * hospital administrator is accountable for behind a redeployment by whoever
 * holds the server. It sits here now, beside two figures that did not exist at
 * all: a platform fee, and what a bill costs if it is paid late.
 *
 * **The one thing this screen has to be honest about** is which invoices a
 * change reaches. Every invoice stores the rates it charged, so changing a
 * number here touches nothing already issued — a bill a patient has been sent
 * must not quietly grow because somebody corrected a percentage this morning.
 * That is said on the screen rather than left to be discovered, because the
 * opposite assumption is the reasonable one to make.
 */

import { useEffect, useState } from "react";

import { Icon } from "@/components/Icon";
import { useToast } from "@/components/overlays";
import { Button, Card, Field, Input, cx } from "@/components/ui";
import { ApiError, billingSettings, type BillingSettings } from "@/lib/api";
import { useTr } from "@/lib/lang";

interface Draft {
  taxPercent: string;
  platformFee: string;
  lateFee: string;
}

function draftOf(settings: BillingSettings | null): Draft {
  return {
    taxPercent: settings?.taxPercent ?? "",
    platformFee: settings?.platformFee ?? "",
    lateFee: settings?.lateFee ?? "",
  };
}

/** A money or percentage value the API will take, or null if it will not. */
function numeric(raw: string, max: number): number | null {
  const value = Number(raw.trim());
  if (raw.trim() === "" || !Number.isFinite(value) || value < 0 || value > max) return null;
  return value;
}

export function BillingRates() {
  const tr = useTr();
  const toast = useToast();

  const [settings, setSettings] = useState<BillingSettings | null>(null);
  const [draft, setDraft] = useState<Draft>(draftOf(null));
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void billingSettings
      .read()
      .then((loaded) => {
        if (cancelled) return;
        setSettings(loaded);
        setDraft(draftOf(loaded));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const patch = (change: Partial<Draft>) => setDraft((current) => ({ ...current, ...change }));

  const tax = numeric(draft.taxPercent, 100);
  const platform = numeric(draft.platformFee, 1_000_000);
  const late = numeric(draft.lateFee, 1_000_000);
  const valid = tax !== null && platform !== null && late !== null;
  const dirty = JSON.stringify(draft) !== JSON.stringify(draftOf(settings));

  async function save() {
    if (!valid) return;
    setSaving(true);
    try {
      const saved = await billingSettings.update({
        taxPercent: String(tax),
        platformFee: String(platform),
        lateFee: String(late),
      });
      setSettings(saved);
      setDraft(draftOf(saved));
      toast.show({
        tone: "success",
        title: tr("Rates updated", "Rates tabdeel ho gaye"),
        body: tr(
          "Invoices issued from now on will use them. Existing invoices are unchanged.",
          "Ab se banne wale invoices inhi par honge. Purane invoices waise hi rahenge.",
        ),
      });
    } catch (cause) {
      toast.show({
        tone: "critical",
        title: tr("Not saved", "Mehfooz nahi hua"),
        body: cause instanceof ApiError ? cause.message : String(cause),
      });
    } finally {
      setSaving(false);
    }
  }

  const currency = settings?.currency ?? "PKR";

  return (
    <Card
      icon="percent"
      title={tr("Rates and fees", "Rates aur fees")}
      description={tr(
        "What a new invoice charges on top of the consultation fee.",
        "Naye invoice mein consultation fee ke ilawa kya lagta hai.",
      )}
    >
      {loading ? (
        <p className="text-sm text-muted">{tr("Loading…", "Load ho raha hai…")}</p>
      ) : (
        <div className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-3">
            <Field
              label={tr("Tax", "Tax")}
              htmlFor="rate-tax"
              hint={tr(
                "Percent, on the fee and the platform fee.",
                "Feesad — fee aur platform fee dono par.",
              )}
            >
              <Input
                id="rate-tax"
                inputMode="decimal"
                className="tabular-nums"
                value={draft.taxPercent}
                onChange={(event) => patch({ taxPercent: event.target.value })}
              />
            </Field>

            <Field
              label={tr("Platform fee", "Platform fee")}
              htmlFor="rate-platform"
              hint={tr(`${currency}, per invoice.`, `${currency}, har invoice par.`)}
            >
              <Input
                id="rate-platform"
                inputMode="decimal"
                className="tabular-nums"
                value={draft.platformFee}
                onChange={(event) => patch({ platformFee: event.target.value })}
              />
            </Field>

            <Field
              label={tr("Late payment charge", "Der ka charge")}
              htmlFor="rate-late"
              hint={tr(
                `${currency}, added once after the due date.`,
                `${currency}, aakhri tareekh ke baad ek baar.`,
              )}
            >
              <Input
                id="rate-late"
                inputMode="decimal"
                className="tabular-nums"
                value={draft.lateFee}
                onChange={(event) => patch({ lateFee: event.target.value })}
              />
            </Field>
          </div>

          {/* The two facts somebody would otherwise have to guess, and would
              probably guess the wrong way round. */}
          <div className="space-y-2 rounded-xl border border-line bg-sunken p-4 text-sm text-muted">
            <p className="flex items-start gap-2">
              <Icon name="history" className="mt-0.5 shrink-0 text-[18px] text-primary" />
              <span>
                {tr(
                  "These apply to invoices issued from now on. Invoices already issued keep the rates they were charged at.",
                  "Yeh sirf aage banne wale invoices par lagenge. Jo invoices ban chuke hain, un ke rates wahi rahenge.",
                )}
              </span>
            </p>
            <p className="flex items-start gap-2">
              <Icon name="event" className="mt-0.5 shrink-0 text-[18px] text-primary" />
              <span>
                {tr(
                  `A patient has ${settings?.paymentTermsDays ?? 3} days to pay. After that the late charge is added once — never per day.`,
                  `Mareez ke paas ${settings?.paymentTermsDays ?? 3} din hain. Us ke baad der ka charge ek hi baar lagta hai — rozana nahi.`,
                )}
              </span>
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <Button onClick={save} loading={saving} disabled={!dirty || !valid}>
              {tr("Save rates", "Rates mehfooz karein")}
            </Button>
            <span className={cx("text-sm", dirty ? "text-strong" : "text-faint")}>
              {!valid
                ? tr("Enter a number in each box.", "Har khane mein number likhein.")
                : dirty
                  ? tr("Unsaved changes", "Tabdeeliyan mehfooz nahi hui")
                  : tr("Saved", "Mehfooz hai")}
            </span>
          </div>
        </div>
      )}
    </Card>
  );
}
