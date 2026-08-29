"use client";

/**
 * Break-glass access (requirement R3).
 *
 * The interface has one unusual job: it has to make a clinician comfortable
 * using this in a genuine emergency, and uncomfortable using it otherwise. Both
 * halves matter. A screen that feels like a violation to open will not be used
 * when someone is dying; one that feels like an ordinary button will be used to
 * read a colleague's chart.
 *
 * So the request form is short, obvious and fast — and it states plainly, before
 * submission rather than after, exactly what will be recorded and who will be
 * told. Nothing is hidden and nothing is dressed up.
 */

import { useState } from "react";

import { Badge, Button, Card, EmptyState, ErrorState, Field, Input, Loading } from "@/components/ui";
import {
  ApiError,
  emergency as emergencyApi,
  type EmergencyGrant,
  type GrantedAccess,
} from "@/lib/api";
import { useTr } from "@/lib/lang";
import { useAsync } from "@/lib/useAsync";

function messageOf(caught: unknown, fallback: string): string {
  return caught instanceof ApiError ? caught.message : fallback;
}

/** Server-side minimum. Mirrored so the button explains itself before a 422. */
const MIN_REASON = 15;

function when(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function minutesLeft(iso: string): number {
  return Math.max(0, Math.round((new Date(iso).getTime() - Date.now()) / 60000));
}

/**
 * What is about to be recorded, shown before the request rather than after.
 *
 * Consent theatre would be a checkbox. This is the actual list, because a
 * clinician who knows exactly what the trail will say is the one this control
 * is designed for.
 */
function WhatHappensNotice() {
  const tr = useTr();
  return (
    <div className="rounded-md border border-warning/50 bg-warning-soft p-4 text-sm">
      <p className="font-semibold text-warning">
        {tr("What happens when you do this", "Aisa karne par kya hota hai")}
      </p>
      <ul className="mt-2 list-disc space-y-1 pl-5 text-warning">
        <li>
          {tr("You get access to", "Aap ko rasai milti hai sirf")}{" "}
          <strong>{tr("this patient only", "isi ek mareez ki")}</strong>
          {tr(", not to any other record.", " — kisi aur record ki nahi.")}
        </li>
        <li>{tr("It expires automatically, and you can hand it back at any time.", "Yeh khud khatam ho jaati hai, aur aap jab chahein wapas kar sakte hain.")}</li>
        <li>{tr("Your reason is stored, and every record you open is counted and logged.", "Aap ki wajah mehfooz hoti hai, aur jo record kholein woh gina aur darj hota hai.")}</li>
        <li>{tr("The patient is told their record was opened this way.", "Mareez ko bataya jaata hai ke unka record is tarah khola gaya.")}</li>
        <li>{tr("An administrator reviews it afterwards.", "Baad mein administrator iska jaiza leta hai.")}</li>
      </ul>
    </div>
  );
}

function GrantCard({ grant, onRevoked }: { grant: EmergencyGrant; onRevoked: () => void }) {
  const tr = useTr();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const revoke = async () => {
    setBusy(true);
    setError(null);
    try {
      await emergencyApi.revoke(grant.id);
      onRevoked();
    } catch (caught) {
      setError(messageOf(caught, "Could not end the access."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="rounded-lg border border-accent/40 bg-accent-soft p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="good">{tr("Access open", "Rasai khuli hai")}</Badge>
        <span className="text-sm text-muted tabular-nums">
          {tr("expires in", "khatam hogi")} {minutesLeft(grant.expiresAt)} {tr("min", "min mein")}
        </span>
        <span className="ml-auto text-sm text-muted tabular-nums">
          {grant.accessCount}{" "}
          {tr(`record${grant.accessCount === 1 ? "" : "s"} opened`, "record khole gaye")}
        </span>
      </div>

      <p className="mt-2 text-sm text-muted">{grant.reason}</p>

      {error && (
        <p role="alert" className="mt-2 text-sm font-medium text-critical">
          {error}
        </p>
      )}

      <Button variant="secondary" className="mt-3" disabled={busy} onClick={() => void revoke()}>
        {busy ? tr("Ending…", "Khatam ho rahi hai…") : tr("I am finished — end access", "Kaam ho gaya — rasai khatam karein")}
      </Button>
    </li>
  );
}

/** Request break-glass access, and manage what is currently open. */
export function EmergencyAccessPanel() {
  const tr = useTr();
  const active = useAsync(() => emergencyApi.active(), []);
  const [patientId, setPatientId] = useState("");
  const [reason, setReason] = useState("");
  const [granted, setGranted] = useState<GrantedAccess | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await emergencyApi.request({
        patientId: patientId.trim(),
        reason: reason.trim(),
      });
      setGranted(result);
      setPatientId("");
      setReason("");
      active.reload();
    } catch (caught) {
      setError(messageOf(caught, "Could not grant emergency access."));
    } finally {
      setBusy(false);
    }
  };

  const ready = patientId.trim().length > 0 && reason.trim().length >= MIN_REASON;

  return (
    <div className="space-y-6">
      <Card
        title={tr("Emergency access", "Emergency access")}
        description={tr(
          "For a patient you are treating right now who you are not otherwise authorised to see.",
          "Us mareez ke liye jiska aap abhi ilaaj kar rahe hain magar jise dekhne ki aam ijazat aap ke paas nahi.",
        )}
      >
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <WhatHappensNotice />

          <Field
            label={tr("Patient identifier", "Mareez ki shanakht")}
            htmlFor="emergency-patient"
            hint={tr(
              "The patient's record number or id, from their wristband or the ward list.",
              "Mareez ka record number ya id — wristband ya ward list se.",
            )}
          >
            <Input
              id="emergency-patient"
              value={patientId}
              maxLength={64}
              disabled={busy}
              onChange={(event) => setPatientId(event.target.value)}
            />
          </Field>

          <Field
            label={tr("Why do you need access?", "Aap ko rasai kyun chahiye?")}
            htmlFor="emergency-reason"
            hint={
              reason.trim().length < MIN_REASON
                ? tr(
                    `A sentence, not a word — at least ${MIN_REASON} characters. This is stored and reviewed.`,
                    `Ek jumla likhein, sirf lafz nahi — kam az kam ${MIN_REASON} huroof. Yeh mehfooz hota hai aur iska jaiza hota hai.`,
                  )
                : tr(
                    "This is stored on the record and reviewed by an administrator.",
                    "Yeh record par mehfooz hota hai aur administrator iska jaiza leta hai.",
                  )
            }
          >
            <textarea
              id="emergency-reason"
              rows={3}
              maxLength={1000}
              value={reason}
              disabled={busy}
              onChange={(event) => setReason(event.target.value)}
              className="block w-full rounded-md border border-line-strong bg-card px-3 py-2.5 text-base text-strong placeholder:text-faint focus:outline-2 focus:outline-offset-0 focus:outline-primary"
            />
          </Field>

          {error && <ErrorState message={error} />}

          {granted && (
            <div
              role="status"
              className="rounded-md border border-accent/40 bg-accent-soft p-4"
            >
              <p className="font-semibold text-primary">
                {granted.created
                  ? tr("Access granted", "Rasai mil gayi")
                  : tr("You already had access to this patient", "Is mareez ki rasai aap ke paas pehle se thi")}
              </p>
              <p className="mt-1 text-sm text-primary">{granted.notice}</p>
            </div>
          )}

          {/* Not styled as a danger button. This is a legitimate clinical
              action, and making it look like a mistake discourages the very
              use it exists for. */}
          <Button type="submit" size="lg" disabled={busy || !ready}>
            {busy ? tr("Requesting…", "Darkhwast ja rahi hai…") : tr("Request emergency access", "Emergency access ki darkhwast karein")}
          </Button>
        </form>
      </Card>

      <Card
        title={tr("Access you currently hold", "Aap ke paas is waqt jo rasai hai")}
        description={tr("Hand it back as soon as you are done.", "Kaam khatam hote hi wapas kar dein.")}
      >
        {active.loading && <Loading label={tr("Checking your access", "Rasai check ho rahi hai")} />}
        {active.error && <ErrorState message={active.error.message} onRetry={active.reload} />}

        {!active.loading && !active.error && (active.data ?? []).length === 0 && (
          <EmptyState
            title={tr("No open access", "Koi khuli rasai nahi")}
            description={tr(
              "You are not currently holding emergency access to any record.",
              "Is waqt aap ke paas kisi record ki emergency rasai nahi hai.",
            )}
          />
        )}

        {(active.data ?? []).length > 0 && (
          <ul className="space-y-3">
            {(active.data ?? []).map((grant) => (
              <GrantCard key={grant.id} grant={grant} onRevoked={active.reload} />
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Administrative review
// ---------------------------------------------------------------------------

function ReviewRow({ grant, onReviewed }: { grant: EmergencyGrant; onReviewed: (next: EmergencyGrant) => void }) {
  const tr = useTr();
  const [open, setOpen] = useState(false);
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      onReviewed(await emergencyApi.review(grant.id, notes.trim()));
      setOpen(false);
      setNotes("");
    } catch (caught) {
      setError(messageOf(caught, "Could not record the review."));
    } finally {
      setBusy(false);
    }
  };

  const reviewed = Boolean(grant.reviewedAt);

  return (
    <li
      className={
        reviewed
          ? "rounded-lg border border-line bg-card p-4"
          : "rounded-lg border border-warning/50 bg-warning-soft p-4 /30"
      }
    >
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={grant.live ? "critical" : "neutral"}>
          {grant.live ? tr("Still open", "Abhi khuli hai") : grant.status.toLowerCase()}
        </Badge>
        <Badge tone={reviewed ? "good" : "warning"}>
          {reviewed ? tr("Reviewed", "Jaiza ho gaya") : tr("Awaiting review", "Jaiza baqi hai")}
        </Badge>
        <span className="text-sm text-muted">
          {grant.requesterName ?? tr("(deleted account)", "(hazf shuda account)")}
        </span>
        <span className="ml-auto text-sm text-muted tabular-nums">
          {when(grant.grantedAt)}
        </span>
      </div>

      <p className="mt-2 text-strong">{grant.reason}</p>

      <p className="mt-1 text-sm text-muted">
        {/* The count is the first thing a reviewer should weigh: one read and
            ninety reads are very different events. */}
        <span className="font-medium tabular-nums">{grant.accessCount}</span>{" "}
        {tr(`record${grant.accessCount === 1 ? "" : "s"} opened`, "record khole gaye")} ·{" "}
        {tr("patient", "mareez")}{" "}
        <span className="tabular-nums">{grant.patientId}</span>
      </p>

      {reviewed && grant.reviewNotes && (
        <p className="mt-2 rounded-md bg-sunken px-3 py-2 text-sm text-muted">
          {grant.reviewNotes}
        </p>
      )}

      {error && <ErrorState message={error} />}

      {!reviewed && !open && (
        <Button variant="secondary" className="mt-3" onClick={() => setOpen(true)}>
          {tr("Record review", "Jaiza darj karein")}
        </Button>
      )}

      {!reviewed && open && (
        <div className="mt-3 space-y-3">
          <Field
            label={tr("Review notes", "Jaize ke notes")}
            htmlFor={`review-${grant.id}`}
            hint={tr(
              "What you checked, and whether the access was appropriate.",
              "Aap ne kya jaancha, aur kya yeh rasai munasib thi.",
            )}
          >
            <Input
              id={`review-${grant.id}`}
              value={notes}
              maxLength={2000}
              onChange={(event) => setNotes(event.target.value)}
            />
          </Field>
          <div className="flex flex-wrap gap-2">
            <Button disabled={busy || notes.trim().length < 3} onClick={() => void submit()}>
              {busy ? tr("Saving…", "Save ho raha hai…") : tr("Save review", "Jaiza save karein")}
            </Button>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              {tr("Cancel", "Mansookh")}
            </Button>
          </div>
        </div>
      )}
    </li>
  );
}

/**
 * The compliance review queue.
 *
 * The outstanding count sits in the header rather than behind a filter: the
 * control this whole design rests on is that somebody looks at every one of
 * these, and a number only visible to someone who already suspected there was
 * something to see is not a control.
 */
export function EmergencyReviewPanel() {
  const tr = useTr();
  const fetched = useAsync(() => emergencyApi.list({ limit: 50 }), []);
  const [reviewed, setReviewed] = useState<Record<string, EmergencyGrant>>({});

  const rows = (fetched.data?.data ?? []).map((grant) => reviewed[grant.id] ?? grant);
  const outstanding = fetched.data?.meta.unreviewed ?? 0;

  return (
    <Card
      title={tr("Emergency access", "Emergency access")}
      description={tr(
        "Every break-glass grant, and whether it has been reviewed.",
        "Har emergency grant, aur yeh ke uska jaiza hua ya nahi.",
      )}
      action={
        <div className="text-right">
          <p className="text-xs text-muted">{tr("Awaiting review", "Jaiza baqi")}</p>
          <p
            className={
              outstanding > 0
                ? "text-lg font-semibold tabular-nums text-warning"
                : "text-lg font-semibold tabular-nums"
            }
          >
            {outstanding}
          </p>
        </div>
      }
    >
      {fetched.loading && <Loading label={tr("Loading emergency access", "Emergency access load ho raha hai")} />}
      {fetched.error && <ErrorState message={fetched.error.message} onRetry={fetched.reload} />}

      {!fetched.loading && !fetched.error && rows.length === 0 && (
        <EmptyState
          title={tr("No emergency access has been used", "Ab tak koi emergency access istemal nahi hui")}
          description={tr(
            "Break-glass grants appear here as soon as they are issued.",
            "Emergency grants jari hote hi yahan nazar aate hain.",
          )}
        />
      )}

      {rows.length > 0 && (
        <ul className="space-y-3">
          {rows.map((grant) => (
            <ReviewRow
              key={grant.id}
              grant={grant}
              onReviewed={(next) => setReviewed((current) => ({ ...current, [next.id]: next }))}
            />
          ))}
        </ul>
      )}
    </Card>
  );
}
