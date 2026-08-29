"use client";

/**
 * The audit trail (requirement R6).
 *
 * Read-only, and visibly so — there is no edit control anywhere in this file
 * because there is no endpoint behind one. The log is append-only, and an
 * interface that implied otherwise would misrepresent the guarantee it is
 * displaying.
 *
 * Two design choices carry the screen:
 *
 * - **Security events are surfaced, not filtered to.** Denied access and
 *   break-glass use are what an administrator is here for; a count only visible
 *   to someone who already suspected something is not a control.
 * - **Chain verification is a button with a real answer.** "Immutable" is a
 *   claim; recomputing the hashes and saying whether they still agree is
 *   evidence.
 */

import { useState } from "react";

import { Badge, Button, Card, EmptyState, ErrorState, Loading, cx } from "@/components/ui";
import {
  ApiError,
  audit as auditApi,
  type AuditEntry,
  type AuditSeverity,
  type ChainVerification,
} from "@/lib/api";
import { useAsync } from "@/lib/useAsync";

const SEVERITY_TONE: Record<AuditSeverity, "critical" | "warning" | "info" | "neutral"> = {
  SECURITY: "critical",
  BREAK_GLASS: "critical",
  WARNING: "warning",
  NOTICE: "info",
  INFO: "neutral",
};

/** Severities worth pulling out of the stream. */
const ALERTING: AuditSeverity[] = ["SECURITY", "BREAK_GLASS"];

function when(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/** "PATIENT_RECORD_VIEW" reads badly in a table; "Patient record view" does. */
function humanise(action: string): string {
  const words = action.toLowerCase().replaceAll("_", " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function ChainStatus() {
  const [result, setResult] = useState<ChainVerification | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const verify = async () => {
    setBusy(true);
    setError(null);
    try {
      setResult(await auditApi.verify(1000));
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Could not verify the chain.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      title="Tamper check"
      description="Recomputes the hash chain over the stored entries and reports whether it still holds."
      action={
        <Button variant="secondary" disabled={busy} onClick={() => void verify()}>
          {busy ? "Checking…" : "Verify chain"}
        </Button>
      }
    >
      {error && <ErrorState message={error} />}

      {!result && !error && (
        <p className="text-sm text-muted">
          Each entry is hashed together with the one before it, so an entry altered or removed
          directly in the database no longer verifies. This is what makes &ldquo;append-only&rdquo;
          checkable rather than merely stated.
        </p>
      )}

      {result && (
        <div
          // A broken chain means the table has been tampered with. It is
          // announced, not just coloured.
          role={result.valid ? "status" : "alert"}
          className={cx(
            "rounded-md border p-4",
            result.valid
              ? "border-stable/50 bg-stable-soft"
              : "border-critical bg-critical-soft",
          )}
        >
          <p
            className={cx(
              "font-semibold",
              result.valid
                ? "text-stable"
                : "text-critical",
            )}
          >
            {result.detail}
          </p>
          <p
            className={cx(
              "mt-1 text-sm tabular-nums",
              result.valid
                ? "text-stable"
                : "text-strong",
            )}
          >
            {result.checked} entries checked
            {result.brokenAt && ` · first break at entry ${result.brokenAt}`}
          </p>
        </div>
      )}
    </Card>
  );
}

function EntryRow({ entry }: { entry: AuditEntry }) {
  const alerting = ALERTING.includes(entry.severity);

  return (
    <tr
      className={cx(
        "border-b border-line align-top",
        alerting && "bg-critical-soft/50",
      )}
    >
      <td className="py-2 pr-4 whitespace-nowrap tabular-nums text-muted">
        {when(entry.timestamp)}
      </td>
      <td className="py-2 pr-4">
        <span className="font-medium">{humanise(entry.action)}</span>
        {alerting && (
          <div className="mt-1">
            <Badge tone={SEVERITY_TONE[entry.severity]}>{humanise(entry.severity)}</Badge>
          </div>
        )}
      </td>
      <td className="py-2 pr-4">
        {/* Null when the account has since been deleted. `userId` is
            deliberately not a foreign key — the trail outlives its subject. */}
        {entry.actorName ?? <span className="italic text-faint">(deleted account)</span>}
        {entry.actorRole && (
          <div className="text-xs text-faint">{entry.actorRole.toLowerCase()}</div>
        )}
      </td>
      <td className="py-2 pr-4 text-muted">
        {entry.entityType ?? "—"}
      </td>
      <td className="py-2 text-xs text-faint">
        {entry.ipAddress ?? "—"}
      </td>
    </tr>
  );
}

export function AuditPanel() {
  const [securityOnly, setSecurityOnly] = useState(false);
  const fetched = useAsync(
    () =>
      auditApi.list(securityOnly ? { severity: "SECURITY", limit: 50 } : { limit: 50 }),
    [securityOnly],
  );

  const rows = fetched.data?.data ?? [];
  const securityEvents = fetched.data?.meta.securityEvents ?? 0;

  return (
    <div className="space-y-6">
      <ChainStatus />

      <Card
        title="Audit trail"
        description="Every sensitive action, newest first. Entries cannot be edited or removed."
        action={
          <div className="flex items-center gap-3">
            <div className="text-right">
              <p className="text-xs text-muted">Security events</p>
              <p
                className={cx(
                  "text-lg font-semibold tabular-nums",
                  securityEvents > 0 && "text-critical",
                )}
              >
                {securityEvents}
              </p>
            </div>
            <Button variant="secondary" onClick={() => setSecurityOnly((value) => !value)}>
              {securityOnly ? "Show all" : "Security only"}
            </Button>
          </div>
        }
      >
        {fetched.loading && <Loading label="Loading the audit trail" />}
        {fetched.error && <ErrorState message={fetched.error.message} onRetry={fetched.reload} />}

        {!fetched.loading && !fetched.error && rows.length === 0 && (
          <EmptyState
            title={securityOnly ? "No security events" : "No entries"}
            description={
              securityOnly
                ? "No denied access or break-glass use has been recorded."
                : "Sensitive actions are recorded here as they happen."
            }
          />
        )}

        {rows.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[42rem] text-sm">
              <caption className="sr-only">Audit trail, newest first</caption>
              <thead>
                <tr className="border-b border-line text-left">
                  <th scope="col" className="py-2 pr-4 font-medium">When</th>
                  <th scope="col" className="py-2 pr-4 font-medium">Action</th>
                  <th scope="col" className="py-2 pr-4 font-medium">Who</th>
                  <th scope="col" className="py-2 pr-4 font-medium">Entity</th>
                  <th scope="col" className="py-2 font-medium">From</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((entry) => (
                  <EntryRow key={entry.id} entry={entry} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
