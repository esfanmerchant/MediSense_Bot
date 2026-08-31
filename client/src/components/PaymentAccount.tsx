"use client";

/**
 * The account patients are told to send money to.
 *
 * Its own card rather than another row in the rates editor: rates decide what a
 * bill *says*, and this decides where the money *goes*. Getting one wrong
 * misprices an invoice; getting this wrong sends a patient's transfer to a
 * stranger, and the two do not belong under one Save button.
 *
 * Nothing here is a secret — it is published to every patient with a bill — so
 * it lives in the database rather than in server configuration, where the
 * administrator whose account it is could not reach it.
 */

import { useEffect, useState } from "react";

import { Icon } from "@/components/Icon";
import { useToast } from "@/components/overlays";
import { Button, Card, Field, Input, cx } from "@/components/ui";
import { ApiError, billingSettings, type BillingSettings } from "@/lib/api";
import { useTr } from "@/lib/lang";

interface Draft {
  payeeName: string;
  nayapayNumber: string;
  easypaisaNumber: string;
  paymentNote: string;
}

function draftOf(settings: BillingSettings | null): Draft {
  return {
    payeeName: settings?.payeeName ?? "",
    nayapayNumber: settings?.nayapayNumber ?? "",
    easypaisaNumber: settings?.easypaisaNumber ?? "",
    paymentNote: settings?.paymentNote ?? "",
  };
}

export function PaymentAccount() {
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
  const dirty = JSON.stringify(draft) !== JSON.stringify(draftOf(settings));
  const anyAccount = Boolean(draft.nayapayNumber.trim() || draft.easypaisaNumber.trim());

  async function save() {
    setSaving(true);
    try {
      const saved = await billingSettings.update({
        payeeName: draft.payeeName.trim(),
        nayapayNumber: draft.nayapayNumber.trim(),
        easypaisaNumber: draft.easypaisaNumber.trim(),
        paymentNote: draft.paymentNote.trim(),
      });
      setSettings(saved);
      setDraft(draftOf(saved));
      toast.show({
        tone: "success",
        title: tr("Account saved", "Account mehfooz ho gaya"),
        body: tr(
          "Patients paying a bill will see these details.",
          "Bill ada karne wale mareezon ko yeh tafseelat dikhengi.",
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
      icon="account_balance_wallet"
      title={tr("Where patients pay", "Mareez kahan ada karein")}
      description={tr(
        "The wallet a patient transfers into, shown on every bill.",
        "Woh wallet jahan mareez raqam bhejta hai — har bill par dikhta hai.",
      )}
    >
      {loading ? (
        <p className="text-sm text-muted">{tr("Loading…", "Load ho raha hai…")}</p>
      ) : (
        <div className="space-y-5">
          {/* Said before the fields, not after a failed save: with no account
              entered, the Pay button on every bill has nothing to show. */}
          {!anyAccount && (
            <p
              role="status"
              className="flex items-start gap-2 rounded-xl border border-warning/40 bg-warning/10 p-3 text-sm text-strong"
            >
              <Icon name="info" className="mt-0.5 shrink-0 text-[18px] text-warning" />
              <span>
                {tr(
                  "Until one of these is filled in, patients are told online payment is unavailable and to pay at the desk.",
                  "Jab tak in mein se ek nahi bharte, mareezon ko likha aayega ke online adaigi mojood nahi aur desk par ada karein.",
                )}
              </span>
            </p>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <Field
                label={tr("Account holder name", "Account holder ka naam")}
                htmlFor="pay-name"
                hint={tr(
                  "Shown so a patient can check it before sending.",
                  "Taake mareez bhejne se pehle mila sake.",
                )}
              >
                <Input
                  id="pay-name"
                  maxLength={160}
                  value={draft.payeeName}
                  onChange={(event) => patch({ payeeName: event.target.value })}
                />
              </Field>
            </div>

            <Field label={tr("NayaPay number", "NayaPay number")} htmlFor="pay-nayapay">
              <Input
                id="pay-nayapay"
                inputMode="tel"
                maxLength={32}
                className="tabular-nums"
                value={draft.nayapayNumber}
                onChange={(event) => patch({ nayapayNumber: event.target.value })}
              />
            </Field>

            <Field label={tr("EasyPaisa number", "EasyPaisa number")} htmlFor="pay-easypaisa">
              <Input
                id="pay-easypaisa"
                inputMode="tel"
                maxLength={32}
                className="tabular-nums"
                value={draft.easypaisaNumber}
                onChange={(event) => patch({ easypaisaNumber: event.target.value })}
              />
            </Field>

            <div className="sm:col-span-2">
              <Field
                label={tr("Note for patients", "Mareezon ke liye note")}
                htmlFor="pay-note"
                hint={tr("Optional. Anything else they need to know.", "Ikhtiyari. Aur koi baat.")}
              >
                <Input
                  id="pay-note"
                  maxLength={500}
                  value={draft.paymentNote}
                  onChange={(event) => patch({ paymentNote: event.target.value })}
                />
              </Field>
            </div>
          </div>

          <p className="flex items-start gap-2 rounded-xl border border-line bg-sunken p-4 text-sm text-muted">
            <Icon name="qr_code_2" className="mt-0.5 shrink-0 text-[18px] text-primary" />
            <span>
              {tr(
                "The QR code shown beside these comes from client/public/brand/nayapay-qr.png. If that file is absent the numbers are shown on their own.",
                "In ke saath dikhne wala QR code client/public/brand/nayapay-qr.png se aata hai. File na ho to sirf numbers dikhte hain.",
              )}
            </span>
          </p>

          <div className="flex flex-wrap items-center gap-3">
            <Button onClick={save} loading={saving} disabled={!dirty}>
              {tr("Save account", "Account mehfooz karein")}
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
