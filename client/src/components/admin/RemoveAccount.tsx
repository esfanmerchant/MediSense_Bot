"use client";

/**
 * Removing an account, with the consequences on screen before the button works.
 *
 * **This is the only irreversible action in the product.** Suspension can be
 * undone in one press; this destroys a person's medical history and cannot be
 * taken back. So the panel is built the other way round from every other
 * confirmation: it fetches the real counts first, shows what will be deleted
 * *and* what will outlive the removal, and only then offers the button.
 *
 * **Typing the address, not a checkbox.** A tickbox next to a warning is
 * clicked without reading; copying an email address requires looking at which
 * account this is. It is also the exact thing that becomes reusable
 * afterwards, so the confirmation and the outcome are the same string.
 *
 * The server refuses independently and recomputes its own plan — nothing here
 * is a security control. It is here so an administrator is never surprised by
 * what they just did.
 */

import { useEffect, useState } from "react";

import { Icon } from "@/components/Icon";
import { useToast } from "@/components/overlays";
import { Button, Field, Input, Loading } from "@/components/ui";
import { ApiError, users } from "@/lib/api";
import type { RemovalPlan } from "@/lib/api";
import { useTr } from "@/lib/lang";

/**
 * Plain names for the counts the API returns.
 *
 * The keys are table-shaped because the server counts rows; an administrator
 * deciding whether to erase somebody should read "consultation notes", not
 * `consultationNotes`. Anything unmapped falls back to its key rather than
 * disappearing — a count nobody named is still a count that matters.
 */
const LABELS: Record<string, [string, string]> = {
  appointments: ["appointments", "appointments"],
  consultationNotes: ["consultation notes", "consultation ke notes"],
  prescriptions: ["prescriptions", "nuskhe"],
  vitalReadings: ["vital readings", "vitals ki readings"],
  reportedSymptoms: ["reported symptoms", "batayi gayi alamaat"],
  medicationReminders: ["medication reminders", "dawa ke reminders"],
  documents: ["uploaded documents", "upload kiye documents"],
  emergencyGrants: ["emergency access grants", "emergency access"],
  assistantConversations: ["assistant conversations", "assistant ki guftagu"],
  unpaidInvoices: ["unpaid invoices", "bina ada shuda invoices"],
  signedInSessions: ["signed-in sessions", "chalu sessions"],
  enrolledDevices: ["trusted devices", "trusted devices"],
  pushSubscriptions: ["notification devices", "notification devices"],
  notifications: ["notifications", "ittilaat"],
  doctorApplications: ["registration applications", "registration ki darkhwastein"],
  credentialFiles: ["credential files", "credential files"],
  timeOff: ["time-off entries", "chhutti ke entries"],
  settledInvoices: ["settled invoices", "ada shuda invoices"],
  consultationNotesWritten: ["consultation notes they wrote", "un ke likhe consultation notes"],
  prescriptionsWritten: ["prescriptions they wrote", "un ke likhe nuskhe"],
  appointmentsSeen: ["appointments they saw", "un ke dekhe appointments"],
  earningsEntries: ["earnings entries", "kamai ke entries"],
  withdrawals: ["withdrawals", "withdrawals"],
  documentsUploaded: ["documents they uploaded", "un ke upload kiye documents"],
  emergencyAccessUsed: ["emergency accesses they used", "un ke liye gaye emergency access"],
};

function Counts({
  entries,
  tone,
}: {
  entries: Array<[string, number]>;
  tone: "delete" | "keep";
}) {
  const tr = useTr();
  return (
    <ul className="mt-2 grid gap-1 sm:grid-cols-2">
      {entries.map(([key, count]) => {
        const label = LABELS[key];
        return (
          <li key={key} className="flex items-baseline gap-2 text-sm">
            <Icon
              name={tone === "delete" ? "close" : "lock"}
              className={tone === "delete" ? "text-[15px] text-critical" : "text-[15px] text-muted"}
            />
            <span className="tabular-nums font-semibold text-strong">{count}</span>
            <span className="text-muted">{label ? tr(label[0], label[1]) : key}</span>
          </li>
        );
      })}
    </ul>
  );
}

export function RemoveAccount({
  userId,
  name,
  onDone,
  onCancel,
}: {
  userId: string;
  name: string;
  onDone: () => void;
  onCancel: () => void;
}) {
  const tr = useTr();
  const toast = useToast();
  const [plan, setPlan] = useState<RemovalPlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    users
      .removalPreview(userId)
      .then((result) => live && setPlan(result))
      .catch((cause) => live && setError(cause instanceof ApiError ? cause.message : String(cause)));
    return () => {
      live = false;
    };
  }, [userId]);

  const deletes = plan ? Object.entries(plan.deletes) : [];
  const keeps = plan ? Object.entries(plan.keeps) : [];
  // Case-insensitive: an address is not case-sensitive in practice, and
  // refusing "Ali@..." for "ali@..." teaches nothing and helps nobody.
  const confirmed = plan ? typed.trim().toLowerCase() === plan.email.toLowerCase() : false;

  async function remove() {
    setBusy(true);
    try {
      const result = await users.remove(userId);
      toast.show({
        tone: "success",
        title: tr("Account removed", "Account hata diya gaya"),
        body: tr(
          `${result.emailFreed} can be registered again.`,
          `${result.emailFreed} dobara register ho sakta hai.`,
        ),
      });
      if (result.filesFailed > 0) {
        // Said out loud rather than swallowed: files left in a bucket are the
        // one part of "completely deleted" that can quietly not be true.
        toast.show({
          tone: "warning",
          title: tr("Some files were not deleted", "Kuch files delete nahi hui"),
          body: tr(
            `${result.filesFailed} file(s) are still in storage. Tell whoever runs the server.`,
            `${result.filesFailed} file abhi storage mein hain. Server chalane wale ko batayein.`,
          ),
        });
      }
      onDone();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-4 space-y-3 rounded-xl border-2 border-critical/50 bg-critical-soft p-4">
      <p className="flex items-start gap-2 font-display text-sm font-bold text-critical">
        <Icon name="delete" className="mt-0.5 shrink-0 text-[18px]" />
        {tr(`Remove ${name} permanently`, `${name} ko hamesha ke liye hata dein`)}
      </p>

      {!plan && !error && <Loading label={tr("Counting", "Gin raha hai")} />}

      {error && (
        <p role="alert" className="text-sm font-medium text-critical">
          {error}
        </p>
      )}

      {plan && (
        <>
          {plan.blockers.length > 0 ? (
            <ul className="space-y-1">
              {plan.blockers.map((blocker) => (
                <li key={blocker} className="flex items-start gap-2 text-sm text-strong">
                  <Icon name="block" className="mt-0.5 shrink-0 text-[16px] text-critical" />
                  {blocker}
                </li>
              ))}
            </ul>
          ) : (
            <>
              <div>
                <p className="mono-caps text-[11px] text-critical">
                  {tr("Deleted for ever", "Hamesha ke liye delete")}
                </p>
                {deletes.length > 0 ? (
                  <Counts entries={deletes} tone="delete" />
                ) : (
                  <p className="mt-1 text-sm text-muted">
                    {tr("This account holds no data.", "Iss account mein koi data nahi hai.")}
                  </p>
                )}
                {plan.files > 0 && (
                  <p className="mt-2 text-sm text-muted">
                    {tr(
                      `${plan.files} uploaded file(s) will be deleted from storage too.`,
                      `${plan.files} upload ki gayi file storage se bhi delete hongi.`,
                    )}
                  </p>
                )}
              </div>

              {keeps.length > 0 && (
                <div className="border-t border-critical/25 pt-3">
                  <p className="mono-caps text-[11px] text-muted">
                    {tr("Kept, with their name removed", "Rakha jayega, naam ke baghair")}
                  </p>
                  <Counts entries={keeps} tone="keep" />
                  <p className="mt-2 text-sm text-muted">
                    {plan.mode === "ANONYMISE"
                      ? tr(
                          "These are other people's records. They keep an author so a patient's chart is not left without a clinician — but nothing identifying this person survives anywhere.",
                          "Yeh doosron ke records hain. In ka author baaqi rehta hai taake kisi mareez ka chart bina doctor ke na reh jaye — magar iss shaks ki koi shanakht kahin nahi bachti.",
                        )
                      : tr(
                          "Money that actually changed hands stays in the hospital's books, without a patient attached.",
                          "Jo paisa waqai mila, wo hospital ke hisaab mein rehta hai — bina kisi mareez ke naam ke.",
                        )}
                  </p>
                </div>
              )}

              <p className="border-t border-critical/25 pt-3 text-sm text-strong">
                {tr(
                  `Afterwards ${plan.email} and their CNIC can be registered again as a new account.`,
                  `Iss ke baad ${plan.email} aur un ka CNIC naye account ke tor par dobara register ho sakte hain.`,
                )}
              </p>

              <Field
                label={tr(
                  "Type their email address to confirm",
                  "Tasdeeq ke liye un ka email address likhein",
                )}
                htmlFor={`confirm-${userId}`}
                hint={plan.email}
              >
                <Input
                  id={`confirm-${userId}`}
                  autoComplete="off"
                  spellCheck={false}
                  value={typed}
                  onChange={(event) => setTyped(event.target.value)}
                />
              </Field>

              <div className="flex flex-wrap gap-2">
                <Button
                  variant="danger"
                  loading={busy}
                  disabled={!confirmed}
                  onClick={() => void remove()}
                >
                  {tr("Remove permanently", "Hamesha ke liye hatayein")}
                </Button>
                <Button variant="ghost" onClick={onCancel}>
                  {tr("Cancel", "Cancel")}
                </Button>
              </div>
            </>
          )}

          {plan.blockers.length > 0 && (
            <Button variant="ghost" onClick={onCancel}>
              {tr("Close", "Band karein")}
            </Button>
          )}
        </>
      )}
    </div>
  );
}
