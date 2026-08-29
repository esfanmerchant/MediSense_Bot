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
  return (
    <div className="rounded-md border border-warning/50 bg-warning-soft p-4 text-sm">
      <p className="font-semibold text-warning">
        What happens when you do this
      </p>
      <ul className="mt-2 list-disc space-y-1 pl-5 text-warning">
        <li>You get access to <strong>this patient only</strong>, not to any other record.</li>
        <li>It expires automatically, and you can hand it back at any time.</li>
        <li>Your reason is stored, and every record you open is counted and logged.</li>
        <li>The patient is told their record was opened this way.</li>
        <li>An administrator reviews it afterwards.</li>
      </ul>
    </div>
  );
}

function GrantCard({ grant, onRevoked }: { grant: EmergencyGrant; onRevoked: () => void }) {
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
        <Badge tone="good">Access open</Badge>
        <span className="text-sm text-muted tabular-nums">
          expires in {minutesLeft(grant.expiresAt)} min
        </span>
        <span className="ml-auto text-sm text-muted tabular-nums">
          {grant.accessCount} record{grant.accessCount === 1 ? "" : "s"} opened
        </span>
      </div>

      <p className="mt-2 text-sm text-muted">{grant.reason}</p>

      {error && (
        <p role="alert" className="mt-2 text-sm font-medium text-critical">
          {error}
        </p>
      )}

      <Button variant="secondary" className="mt-3" disabled={busy} onClick={() => void revoke()}>
        {busy ? "Ending…" : "I am finished — end access"}
      </Button>
    </li>
  );
}

/** Request break-glass access, and manage what is currently open. */
export function EmergencyAccessPanel() {
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
        title="Emergency access"
        description="For a patient you are treating right now who you are not otherwise authorised to see."
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
            label="Patient identifier"
            htmlFor="emergency-patient"
            hint="The patient's record number or id, from their wristband or the ward list."
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
            label="Why do you need access?"
            htmlFor="emergency-reason"
            hint={
              reason.trim().length < MIN_REASON
                ? `A sentence, not a word — at least ${MIN_REASON} characters. This is stored and reviewed.`
                : "This is stored on the record and reviewed by an administrator."
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
                  ? "Access granted"
                  : "You already had access to this patient"}
              </p>
              <p className="mt-1 text-sm text-primary">{granted.notice}</p>
            </div>
          )}

          {/* Not styled as a danger button. This is a legitimate clinical
              action, and making it look like a mistake discourages the very
              use it exists for. */}
          <Button type="submit" size="lg" disabled={busy || !ready}>
            {busy ? "Requesting…" : "Request emergency access"}
          </Button>
        </form>
      </Card>

      <Card title="Access you currently hold" description="Hand it back as soon as you are done.">
        {active.loading && <Loading label="Checking your access" />}
        {active.error && <ErrorState message={active.error.message} onRetry={active.reload} />}

        {!active.loading && !active.error && (active.data ?? []).length === 0 && (
          <EmptyState
            title="No open access"
            description="You are not currently holding emergency access to any record."
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
          {grant.live ? "Still open" : grant.status.toLowerCase()}
        </Badge>
        <Badge tone={reviewed ? "good" : "warning"}>
          {reviewed ? "Reviewed" : "Awaiting review"}
        </Badge>
        <span className="text-sm text-muted">
          {grant.requesterName ?? "(deleted account)"}
        </span>
        <span className="ml-auto text-sm text-muted tabular-nums">
          {when(grant.grantedAt)}
        </span>
      </div>

      <p className="mt-2 text-strong">{grant.reason}</p>

      <p className="mt-1 text-sm text-muted">
        {/* The count is the first thing a reviewer should weigh: one read and
            ninety reads are very different events. */}
        <span className="font-medium tabular-nums">{grant.accessCount}</span> record
        {grant.accessCount === 1 ? "" : "s"} opened · patient{" "}
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
          Record review
        </Button>
      )}

      {!reviewed && open && (
        <div className="mt-3 space-y-3">
          <Field
            label="Review notes"
            htmlFor={`review-${grant.id}`}
            hint="What you checked, and whether the access was appropriate."
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
              {busy ? "Saving…" : "Save review"}
            </Button>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
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
  const fetched = useAsync(() => emergencyApi.list({ limit: 50 }), []);
  const [reviewed, setReviewed] = useState<Record<string, EmergencyGrant>>({});

  const rows = (fetched.data?.data ?? []).map((grant) => reviewed[grant.id] ?? grant);
  const outstanding = fetched.data?.meta.unreviewed ?? 0;

  return (
    <Card
      title="Emergency access"
      description="Every break-glass grant, and whether it has been reviewed."
      action={
        <div className="text-right">
          <p className="text-xs text-muted">Awaiting review</p>
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
      {fetched.loading && <Loading label="Loading emergency access" />}
      {fetched.error && <ErrorState message={fetched.error.message} onRetry={fetched.reload} />}

      {!fetched.loading && !fetched.error && rows.length === 0 && (
        <EmptyState
          title="No emergency access has been used"
          description="Break-glass grants appear here as soon as they are issued."
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
