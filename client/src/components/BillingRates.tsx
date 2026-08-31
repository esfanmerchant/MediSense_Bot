"use client";

/**
 * The rates an administrator owns.
 *
 * The tax rate used to be an environment variable, which put the number a
 * hospital administrator is accountable for behind a redeployment by whoever
 * holds the server. It sits here now, beside two figures that did not exist at
 * all: a platform fee, and what a bill costs if it is paid late.
 *
 * **Each figure can be a flat amount or a share of the bill.** Tax is normally
 * a percentage and a platform fee normally a flat charge, but clinics exist
 * that do the opposite, and a screen that hard-codes which is which forces them
 * to misdescribe their own pricing. So all three carry the same switch, and the
 * hint underneath changes to say what the number now means.
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
import { ApiError, billingSettings, type BillingSettings, type FeeMode } from "@/lib/api";
import { useTr } from "@/lib/lang";

/** One editable figure: what was typed, and how to read it. */
interface Entry {
  value: string;
  mode: FeeMode;
}

interface Draft {
  tax: Entry;
  platform: Entry;
  late: Entry;
}

function draftOf(settings: BillingSettings | null): Draft {
  return {
    tax: { value: settings?.taxPercent ?? "", mode: settings?.taxMode ?? "PERCENT" },
    platform: {
      value: settings?.platformFee ?? "",
      mode: settings?.platformFeeMode ?? "FIXED",
    },
    late: { value: settings?.lateFee ?? "", mode: settings?.lateFeeMode ?? "FIXED" },
  };
}

/**
 * The number somebody meant, out of what they actually typed.
 *
 * People type `15%` into a box labelled "percent" and `PKR 500` or `1,500` into
 * one labelled with a currency, because that is how those quantities are
 * written down everywhere else. Refusing them — which this screen did — is a
 * disabled Save button next to a field that looks perfectly filled in, with a
 * message that does not say what is wrong. The symbols say the same thing the
 * label already says, so they are simply removed.
 *
 * Returns null only when what is left is genuinely not a number.
 */
function parseAmount(raw: string): number | null {
  const cleaned = raw
    .replace(/%/g, "")
    .replace(/,/g, "")
    .replace(/[A-Za-z\s]/g, "")
    .trim();
  if (cleaned === "") return null;
  const value = Number(cleaned);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function ModeSwitch({
  value,
  onChange,
  currency,
  label,
}: {
  value: FeeMode;
  onChange: (mode: FeeMode) => void;
  currency: string;
  /**
   * Names what this switches, for anyone not seeing the layout.
   *
   * Not simply the figure's name: that is already the label on the box beside
   * it, and two controls answering to "Tax" is ambiguous to anybody navigating
   * by label — and was, to the tests.
   */
  label: string;
}) {
  const options: Array<{ mode: FeeMode; text: string }> = [
    { mode: "FIXED", text: currency },
    { mode: "PERCENT", text: "%" },
  ];

  return (
    <div role="group" aria-label={label} className="inline-flex rounded-lg border border-line p-0.5">
      {options.map((option) => (
        <button
          key={option.mode}
          type="button"
          // `aria-pressed` rather than a radio: this toggles how the field
          // beside it is read, it is not a value on the form.
          aria-pressed={value === option.mode}
          onClick={() => onChange(option.mode)}
          className={cx(
            "min-h-8 rounded-md px-3 text-xs font-bold transition-colors",
            "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary",
            value === option.mode
              ? "bg-primary text-primary-on"
              : "text-muted hover:text-strong",
          )}
        >
          {option.text}
        </button>
      ))}
    </div>
  );
}

function RateField({
  id,
  label,
  entry,
  onChange,
  currency,
  fixedHint,
  percentHint,
  error,
  switchLabel,
}: {
  id: string;
  label: string;
  entry: Entry;
  onChange: (entry: Entry) => void;
  currency: string;
  fixedHint: string;
  percentHint: string;
  error?: string;
  /** How the mode switch names itself; see `ModeSwitch`. */
  switchLabel: string;
}) {
  return (
    <div>
      {/* The switch sits above the box rather than beside a heading of its
          own: `Field` is a floating-label shell, so the name of the figure is
          already inside the input, and repeating it here would print it twice.
          The switch names what it controls through `aria-label` instead. */}
      <div className="mb-1.5 flex justify-end">
        <ModeSwitch
          label={switchLabel}
          value={entry.mode}
          currency={currency}
          onChange={(mode) => onChange({ ...entry, mode })}
        />
      </div>
      <Field
        label={label}
        htmlFor={id}
        hint={entry.mode === "PERCENT" ? percentHint : fixedHint}
        error={error}
      >
        <Input
          id={id}
          inputMode="decimal"
          className="tabular-nums"
          value={entry.value}
          onChange={(event) => onChange({ ...entry, value: event.target.value })}
        />
      </Field>
    </div>
  );
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

  const currency = settings?.currency ?? "PKR";

  /** The refusal for one figure, or undefined if it is fine. */
  function problem(entry: Entry): string | undefined {
    const value = parseAmount(entry.value);
    if (value === null) return tr("Enter a number.", "Number likhein.");
    if (entry.mode === "PERCENT" && value > 100) {
      // A share of a bill cannot exceed the bill. Only checkable here, because
      // the same box holds a flat 500 quite legitimately.
      return tr("A percentage cannot be over 100.", "Feesad 100 se zyada nahi ho sakta.");
    }
    return undefined;
  }

  const problems = {
    tax: problem(draft.tax),
    platform: problem(draft.platform),
    late: problem(draft.late),
  };
  const valid = !problems.tax && !problems.platform && !problems.late;
  const dirty = JSON.stringify(draft) !== JSON.stringify(draftOf(settings));

  async function save() {
    if (!valid) return;
    setSaving(true);
    try {
      const saved = await billingSettings.update({
        // Sent as the parsed number, not as what was typed: `15%` reaches the
        // API as `15`.
        taxPercent: String(parseAmount(draft.tax.value)),
        taxMode: draft.tax.mode,
        platformFee: String(parseAmount(draft.platform.value)),
        platformFeeMode: draft.platform.mode,
        lateFee: String(parseAmount(draft.late.value)),
        lateFeeMode: draft.late.mode,
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

  return (
    <Card
      icon="percent"
      title={tr("Rates and fees", "Rates aur fees")}
      description={tr(
        "What a new invoice charges on top of the consultation fee. Each one can be an amount or a percentage.",
        "Naye invoice mein consultation fee ke ilawa kya lagta hai. Har ek raqam ya feesad ho sakta hai.",
      )}
    >
      {loading ? (
        <p className="text-sm text-muted">{tr("Loading…", "Load ho raha hai…")}</p>
      ) : (
        <div className="space-y-5">
          <div className="grid gap-5 sm:grid-cols-3">
            <RateField
              id="rate-tax"
              label={tr("Tax", "Tax")}
              switchLabel={tr(
                "Tax: amount or percentage",
                "Tax: raqam ya feesad",
              )}
              entry={draft.tax}
              error={problems.tax}
              currency={currency}
              onChange={(tax) => setDraft((d) => ({ ...d, tax }))}
              percentHint={tr(
                "Of the fee and the platform fee.",
                "Fee aur platform fee dono par.",
              )}
              fixedHint={tr(`Flat ${currency} on every invoice.`, `Har invoice par ${currency}.`)}
            />

            <RateField
              id="rate-platform"
              label={tr("Platform fee", "Platform fee")}
              switchLabel={tr(
                "Platform fee: amount or percentage",
                "Platform fee: raqam ya feesad",
              )}
              entry={draft.platform}
              error={problems.platform}
              currency={currency}
              onChange={(platform) => setDraft((d) => ({ ...d, platform }))}
              percentHint={tr("Of the consultation fee.", "Consultation fee ka feesad.")}
              fixedHint={tr(`${currency}, per invoice.`, `${currency}, har invoice par.`)}
            />

            <RateField
              id="rate-late"
              label={tr("Late payment charge", "Der ka charge")}
              switchLabel={tr(
                "Late payment charge: amount or percentage",
                "Der ka charge: raqam ya feesad",
              )}
              entry={draft.late}
              error={problems.late}
              currency={currency}
              onChange={(late) => setDraft((d) => ({ ...d, late }))}
              percentHint={tr("Of the invoice total.", "Invoice ke total ka feesad.")}
              fixedHint={tr(`${currency}, added once.`, `${currency}, ek baar.`)}
            />
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
              {dirty
                ? tr("Unsaved changes", "Tabdeeliyan mehfooz nahi hui")
                : tr("Saved", "Mehfooz hai")}
            </span>
          </div>
        </div>
      )}
    </Card>
  );
}
