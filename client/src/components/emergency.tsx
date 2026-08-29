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

import { AnimatePresence, motion } from "framer-motion";
import { useState } from "react";

import { Icon } from "@/components/Icon";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Field,
  Input,
  SkeletonRows,
  Textarea,
  cx,
} from "@/components/ui";
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

/** The expanding-panel motion shared by every disclosure on this screen. */
const EXPAND = {
  initial: { height: 0, opacity: 0 },
  animate: { height: "auto", opacity: 1 },
  exit: { height: 0, opacity: 0 },
  transition: { duration: 0.28, ease: [0.16, 1, 0.3, 1] as [number, number, number, number] },
};

/**
 * What is about to be recorded, shown before the request rather than after.
 *
 * Consent theatre would be a checkbox. This is the actual list, because a
 * clinician who knows exactly what the trail will say is the one this control
 * is designed for.
 */
function WhatHappensNotice() {
  const tr = useTr();
  const points: Array<[string, React.ReactNode]> = [
    [
      "person_search",
      <>
        {tr("You get access to", "Aap ko rasai milti hai sirf")}{" "}
        <strong>{tr("this patient only", "isi ek mareez ki")}</strong>
        {tr(", not to any other record.", " — kisi aur record ki nahi.")}
      </>,
    ],
    ["timer", tr("It expires automatically, and you can hand it back at any time.", "Yeh khud khatam ho jaati hai, aur aap jab chahein wapas kar sakte hain.")],
    ["history", tr("Your reason is stored, and every record you open is counted and logged.", "Aap ki wajah mehfooz hoti hai, aur jo record kholein woh gina aur darj hota hai.")],
    ["notifications_active", tr("The patient is told their record was opened this way.", "Mareez ko bataya jaata hai ke unka record is tarah khola gaya.")],
    ["fact_check", tr("An administrator reviews it afterwards.", "Baad mein administrator iska jaiza leta hai.")],
  ];

  return (
    <div className="rounded-2xl border border-warning/40 bg-warning-soft p-5 text-sm">
      <p className="flex items-center gap-2 font-display font-bold text-warning">
        <Icon name="gavel" filled className="text-[20px]" />
        {tr("What happens when you do this", "Aisa karne par kya hota hai")}
      </p>
      <ul className="mt-3 space-y-2 text-warning">
        {points.map(([icon, text], index) => (
          <li key={index} className="flex items-start gap-2.5">
            <Icon name={icon} className="mt-px shrink-0 text-[18px] opacity-80" />
            <span>{text}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Access the clinician holds right now. Pinned and pulsing, because an open
 * grant is something to act on — hand it back — rather than something to
 * admire.
 */
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
    <li className="edge-pulse pop-in flex flex-wrap items-start gap-4 rounded-2xl border border-critical/40 bg-critical-soft p-5 pl-6">
      <span
        aria-hidden
        className="animate-breathe grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-card text-critical shadow-sm"
      >
        <Icon name="e911_emergency" filled className="text-[24px]" />
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="critical">
            <Icon name="lock_open" filled className="text-[14px]" />
            {tr("Access open", "Rasai khuli hai")}
          </Badge>
          <span className="inline-flex items-center gap-1 rounded-full bg-card px-2.5 py-0.5 text-xs font-semibold tabular-nums text-strong shadow-sm">
            <Icon name="timer" className="text-[14px] text-critical" />
            {tr("expires in", "khatam hogi")} {minutesLeft(grant.expiresAt)} {tr("min", "min mein")}
          </span>
          <span className="inline-flex items-center gap-1 rounded-full bg-card px-2.5 py-0.5 text-xs font-semibold tabular-nums text-strong shadow-sm">
            <Icon name="visibility" className="text-[14px] text-faint" />
            {grant.accessCount}{" "}
            {tr(`record${grant.accessCount === 1 ? "" : "s"} opened`, "record khole gaye")}
          </span>
          <span className="ml-auto text-xs tabular-nums text-muted">
            {tr("patient", "mareez")} {grant.patientId}
          </span>
        </div>

        <p className="mt-2 text-sm text-strong">{grant.reason}</p>

        {error && (
          <p role="alert" className="mt-2 text-sm font-medium text-critical">
            {error}
          </p>
        )}
      </div>

      <Button
        variant="primary"
        className="w-full sm:w-auto"
        disabled={busy}
        loading={busy}
        onClick={() => void revoke()}
      >
        <Icon name="lock" className="text-[20px]" />
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
  const remaining = Math.max(0, MIN_REASON - reason.trim().length);
  const held = active.data ?? [];

  return (
    <div className="space-y-6">
      <Card
        icon="e911_emergency"
        title={tr("Emergency access", "Emergency access")}
        description={tr(
          "For a patient you are treating right now who you are not otherwise authorised to see.",
          "Us mareez ke liye jiska aap abhi ilaaj kar rahe hain magar jise dekhne ki aam ijazat aap ke paas nahi.",
        )}
      >
        <form
          className="space-y-5"
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
            <Textarea
              id="emergency-reason"
              rows={3}
              maxLength={1000}
              value={reason}
              disabled={busy}
              onChange={(event) => setReason(event.target.value)}
            />
          </Field>

          {/* A quiet progress line: the reason filling up towards the minimum. */}
          <div aria-hidden className="-mt-2 flex items-center gap-3 px-1">
            <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-sunken">
              <span
                className={cx(
                  "block h-full rounded-full transition-[width,background-color] duration-300 ease-out",
                  remaining === 0 ? "bg-stable" : "bg-gradient-brand",
                )}
                style={{ width: `${Math.min(100, (reason.trim().length / MIN_REASON) * 100)}%` }}
              />
            </span>
            <span className="text-xs tabular-nums text-faint">
              {remaining === 0
                ? tr("Long enough", "Kaafi hai")
                : `${remaining} ${tr("more", "aur")}`}
            </span>
          </div>

          {error && <ErrorState message={error} />}

          <AnimatePresence initial={false}>
            {granted && (
              <motion.div key="granted" {...EXPAND} className="overflow-hidden">
                <div
                  role="status"
                  className="flex items-start gap-4 rounded-2xl border border-accent/40 bg-accent-soft p-5"
                >
                  <span
                    aria-hidden
                    className="pop-scale grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-card text-accent shadow-sm"
                  >
                    <Icon name="verified_user" filled className="text-[24px]" />
                  </span>
                  <div className="min-w-0">
                    <p className="font-display font-bold text-primary">
                      {granted.created
                        ? tr("Access granted", "Rasai mil gayi")
                        : tr("You already had access to this patient", "Is mareez ki rasai aap ke paas pehle se thi")}
                    </p>
                    <p className="mt-1 text-sm text-primary">{granted.notice}</p>
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Not styled as a danger button. This is a legitimate clinical
              action, and making it look like a mistake discourages the very
              use it exists for. */}
          <Button type="submit" size="lg" className="w-full sm:w-auto" disabled={busy || !ready} loading={busy}>
            <Icon name="e911_emergency" className="text-[22px]" />
            {busy ? tr("Requesting…", "Darkhwast ja rahi hai…") : tr("Request emergency access", "Emergency access ki darkhwast karein")}
          </Button>
        </form>
      </Card>

      <Card
        icon="key"
        title={tr("Access you currently hold", "Aap ke paas is waqt jo rasai hai")}
        description={tr("Hand it back as soon as you are done.", "Kaam khatam hote hi wapas kar dein.")}
        action={
          held.length > 0 ? (
            <Badge tone="critical">
              <span className="pulse-dot h-2 w-2 rounded-full bg-critical" />
              {held.length} {tr("open", "khuli")}
            </Badge>
          ) : undefined
        }
      >
        {active.loading && (
          <div role="status" aria-live="polite">
            <span className="sr-only">{tr("Checking your access", "Rasai check ho rahi hai")}…</span>
            <SkeletonRows rows={1} title={false} />
          </div>
        )}
        {active.error && <ErrorState message={active.error.message} onRetry={active.reload} />}

        {!active.loading && !active.error && held.length === 0 && (
          <EmptyState
            icon="lock"
            title={tr("No open access", "Koi khuli rasai nahi")}
            description={tr(
              "You are not currently holding emergency access to any record.",
              "Is waqt aap ke paas kisi record ki emergency rasai nahi hai.",
            )}
          />
        )}

        {held.length > 0 && (
          <ul className="space-y-3">
            {held.map((grant) => (
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
  const requester = grant.requesterName ?? tr("(deleted account)", "(hazf shuda account)");
  const initials = (grant.requesterName ?? "?")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");

  return (
    <li
      id={`review-${grant.id}`}
      className={cx(
        "rounded-2xl border p-5 transition-[box-shadow,background-color] duration-300 hover:shadow-overlay",
        reviewed
          ? "border-line bg-card shadow-card"
          : "border-warning/40 bg-warning-soft/60 shadow-card",
        grant.live && !reviewed && "edge-pulse pl-6",
      )}
    >
      <div className="flex flex-wrap items-start gap-4">
        <span
          aria-hidden
          className={cx(
            "grid h-11 w-11 shrink-0 place-items-center rounded-full text-sm font-bold",
            reviewed ? "bg-sunken text-muted" : "bg-card text-warning shadow-sm",
          )}
        >
          {initials || "?"}
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold text-strong">{requester}</span>
            <Badge tone={grant.live ? "critical" : "neutral"}>
              {grant.live && <span className="pulse-dot h-1.5 w-1.5 rounded-full bg-critical" />}
              {grant.live ? tr("Still open", "Abhi khuli hai") : grant.status.toLowerCase()}
            </Badge>
            <Badge tone={reviewed ? "good" : "warning"}>
              <Icon name={reviewed ? "task_alt" : "pending"} filled className="text-[14px]" />
              {reviewed ? tr("Reviewed", "Jaiza ho gaya") : tr("Awaiting review", "Jaiza baqi hai")}
            </Badge>
            <span className="ml-auto inline-flex items-center gap-1 text-xs tabular-nums text-muted">
              <Icon name="schedule" className="text-[14px]" />
              {when(grant.grantedAt)}
            </span>
          </div>

          <p className="mt-2 text-strong">{grant.reason}</p>

          <p className="mt-2 flex flex-wrap items-center gap-x-1.5 text-sm text-muted">
            {/* The count is the first thing a reviewer should weigh: one read and
                ninety reads are very different events. */}
            <Icon name="visibility" className="text-[16px] text-faint" />
            <span
              className={cx(
                "rounded-md px-1.5 font-display font-bold tabular-nums",
                grant.accessCount >= 20 ? "bg-critical-soft text-critical" : "bg-sunken text-strong",
              )}
            >
              {grant.accessCount}
            </span>{" "}
            {tr(`record${grant.accessCount === 1 ? "" : "s"} opened`, "record khole gaye")} ·{" "}
            {tr("patient", "mareez")}{" "}
            <span className="tabular-nums">{grant.patientId}</span>
          </p>

          {reviewed && grant.reviewNotes && (
            <p className="mt-3 flex items-start gap-2 rounded-xl bg-sunken px-3.5 py-2.5 text-sm text-muted">
              <Icon name="rate_review" className="mt-px shrink-0 text-[18px] text-faint" />
              {grant.reviewNotes}
            </p>
          )}

          {error && (
            <div className="mt-3">
              <ErrorState message={error} />
            </div>
          )}

          {!reviewed && !open && (
            <div className="mt-4">
              <Button variant="secondary" onClick={() => setOpen(true)}>
                <Icon name="rate_review" className="text-[20px]" />
                {tr("Record review", "Jaiza darj karein")}
              </Button>
            </div>
          )}

          {!reviewed && (
            <AnimatePresence initial={false}>
              {open && (
                <motion.div key="form" {...EXPAND} className="overflow-hidden">
                  <div className="mt-4 space-y-3 rounded-2xl border border-line bg-card p-4 shadow-card">
                    <Field
                      label={tr("Review notes", "Jaize ke notes")}
                      htmlFor={`review-notes-${grant.id}`}
                      hint={tr(
                        "What you checked, and whether the access was appropriate.",
                        "Aap ne kya jaancha, aur kya yeh rasai munasib thi.",
                      )}
                    >
                      <Input
                        id={`review-notes-${grant.id}`}
                        value={notes}
                        maxLength={2000}
                        autoFocus
                        onChange={(event) => setNotes(event.target.value)}
                      />
                    </Field>
                    <div className="flex flex-wrap justify-end gap-2">
                      <Button variant="ghost" onClick={() => setOpen(false)}>
                        {tr("Cancel", "Mansookh")}
                      </Button>
                      <Button disabled={busy || notes.trim().length < 3} onClick={() => void submit()}>
                        {busy ? tr("Saving…", "Save ho raha hai…") : tr("Save review", "Jaiza save karein")}
                      </Button>
                    </div>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          )}
        </div>
      </div>
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
  const firstUnreviewed = rows.find((grant) => !grant.reviewedAt);

  return (
    <Card
      icon="fact_check"
      title={tr("Emergency access", "Emergency access")}
      description={tr(
        "Every break-glass grant, and whether it has been reviewed.",
        "Har emergency grant, aur yeh ke uska jaiza hua ya nahi.",
      )}
      action={
        <div
          className={cx(
            "flex items-center gap-2.5 rounded-xl border px-3 py-1.5",
            outstanding > 0 ? "border-warning/40 bg-warning-soft" : "border-line bg-sunken",
          )}
        >
          <Icon
            name={outstanding > 0 ? "pending_actions" : "task_alt"}
            filled
            className={cx("text-[20px]", outstanding > 0 ? "text-warning" : "text-stable")}
          />
          <div className="leading-tight">
            <p className="text-[11px] font-bold uppercase tracking-wider text-faint">
              {tr("Awaiting review", "Jaiza baqi")}
            </p>
            <p
              className={cx(
                "font-display text-lg font-bold tabular-nums",
                outstanding > 0 ? "text-warning" : "text-strong",
              )}
            >
              {outstanding}
            </p>
          </div>
        </div>
      }
    >
      {fetched.loading && (
        <div role="status" aria-live="polite">
          <span className="sr-only">{tr("Loading emergency access", "Emergency access load ho raha hai")}…</span>
          <SkeletonRows rows={3} title={false} />
        </div>
      )}
      {fetched.error && <ErrorState message={fetched.error.message} onRetry={fetched.reload} />}

      {!fetched.loading && !fetched.error && rows.length === 0 && (
        <EmptyState
          icon="verified_user"
          title={tr("No emergency access has been used", "Ab tak koi emergency access istemal nahi hui")}
          description={tr(
            "Break-glass grants appear here as soon as they are issued.",
            "Emergency grants jari hote hi yahan nazar aate hain.",
          )}
        />
      )}

      {rows.length > 0 && (
        <div className="space-y-4">
          <AnimatePresence initial={false}>
            {outstanding > 0 && (
              <motion.div key="backlog" {...EXPAND} className="overflow-hidden">
                <div className="edge-pulse flex flex-wrap items-center gap-4 rounded-2xl border border-critical/40 bg-critical-soft p-4 pl-5">
                  <span
                    aria-hidden
                    className="animate-breathe grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-card text-critical shadow-sm"
                  >
                    <Icon name="e911_emergency" filled className="text-[24px]" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="font-display font-bold text-critical">
                      <span className="tabular-nums">{outstanding}</span>{" "}
                      {outstanding === 1
                        ? tr("grant has not been reviewed yet", "grant ka jaiza abhi baqi hai")
                        : tr("grants have not been reviewed yet", "grants ka jaiza abhi baqi hai")}
                    </p>
                    <p className="mt-0.5 text-sm text-strong">
                      {tr(
                        "Nothing here is closed until someone has read it.",
                        "Jab tak koi parh na le, yahan kuchh band nahi hota.",
                      )}
                    </p>
                  </div>
                  {firstUnreviewed && (
                    <a
                      href={`#review-${firstUnreviewed.id}`}
                      className="btn-gradient inline-flex min-h-11 items-center justify-center gap-2 rounded-xl px-4 font-semibold text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                    >
                      <Icon name="arrow_downward" className="text-[20px]" />
                      {tr("Go to the first one", "Pehle wale par jayein")}
                    </a>
                  )}
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          <ul className="stagger space-y-3">
            {rows.map((grant) => (
              <ReviewRow
                key={grant.id}
                grant={grant}
                onReviewed={(next) => setReviewed((current) => ({ ...current, [next.id]: next }))}
              />
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}
