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
 *
 * The trail is drawn as a timeline rather than a table: one node per entry on
 * a spine, newest at the top, with a lock on every card. The lock is not
 * decoration — it is the one visual promise this screen makes, and it is kept
 * by the tamper check above it.
 */

import { AnimatePresence, motion } from "framer-motion";
import { Fragment, useState, type ReactNode } from "react";

import { Icon } from "@/components/Icon";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  PillGroup,
  SkeletonRows,
  cx,
} from "@/components/ui";
import {
  ApiError,
  audit as auditApi,
  type AuditEntry,
  type AuditSeverity,
  type ChainVerification,
} from "@/lib/api";
import { useTr } from "@/lib/lang";
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

/** An icon for the kind of thing that was done. Decorative only. */
function iconFor(action: string, severity: AuditSeverity): string {
  if (severity === "BREAK_GLASS") return "e911_emergency";
  if (severity === "SECURITY") return "gpp_maybe";
  const key = action.toLowerCase();
  if (key.includes("login") || key.includes("logout") || key.includes("session")) return "login";
  if (key.includes("delete") || key.includes("remove")) return "delete";
  if (key.includes("create") || key.includes("add")) return "add_circle";
  if (key.includes("update") || key.includes("edit") || key.includes("change")) return "edit";
  if (key.includes("export") || key.includes("download")) return "download";
  if (key.includes("view") || key.includes("read") || key.includes("open")) return "visibility";
  if (key.includes("invoice") || key.includes("payment")) return "receipt_long";
  if (key.includes("appointment")) return "calendar_today";
  return "history";
}

// ---------------------------------------------------------------------------
// Metadata, lightly coloured
// ---------------------------------------------------------------------------

/** One JSON value, coloured by kind. Status colours are not used here: a red
    `false` in a metadata block would read as an alarm, and it is not one. */
function coloured(token: string): ReactNode {
  const trailing = token.endsWith(",") ? "," : "";
  const core = trailing ? token.slice(0, -1) : token;
  let tone = "text-muted";
  if (core.startsWith('"')) tone = "text-accent";
  else if (/^-?\d/.test(core)) tone = "text-warning";
  else if (core === "true" || core === "false" || core === "null") tone = "text-info";
  return (
    <>
      <span className={tone}>{core}</span>
      {trailing && <span className="text-faint">,</span>}
    </>
  );
}

function colourLine(line: string): ReactNode {
  const keyed = /^(\s*)("(?:[^"\\]|\\.)*")(\s*:\s*)(.*)$/.exec(line);
  if (keyed) {
    const [, indent, key, colon, rest] = keyed;
    return (
      <>
        {indent}
        <span className="font-semibold text-primary">{key}</span>
        <span className="text-faint">{colon}</span>
        {coloured(rest)}
      </>
    );
  }
  const indent = /^\s*/.exec(line)?.[0] ?? "";
  return (
    <>
      {indent}
      {coloured(line.trim())}
    </>
  );
}

/** Pre-formatted JSON with keys, strings and numbers told apart by colour. */
function JsonBlock({ value }: { value: unknown }) {
  const text = JSON.stringify(value, null, 2) ?? "null";
  return (
    <pre className="overflow-x-auto rounded-xl border border-line bg-sunken p-4 font-mono text-xs leading-relaxed text-strong">
      {text.split("\n").map((line, index) => (
        <Fragment key={index}>
          {colourLine(line)}
          {"\n"}
        </Fragment>
      ))}
    </pre>
  );
}

// ---------------------------------------------------------------------------
// Tamper check
// ---------------------------------------------------------------------------

function ChainStatus() {
  const tr = useTr();
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
      icon="verified_user"
      title={tr("Tamper check", "Cherh-chharh ki jaanch")}
      description={tr(
        "Recomputes the hash chain over the stored entries and reports whether it still holds.",
        "Mehfooz entries par hash chain dobara banata hai aur batata hai ke woh salamat hai ya nahi.",
      )}
      action={
        <Button variant="secondary" disabled={busy} loading={busy} onClick={() => void verify()}>
          {busy ? tr("Checking…", "Jaanch ho rahi hai…") : tr("Verify chain", "Chain verify karein")}
        </Button>
      }
    >
      {error && <ErrorState message={error} />}

      {!result && !error && (
        <p className="text-sm leading-relaxed text-muted">
          {tr(
            "Each entry is hashed together with the one before it, so an entry altered or removed directly in the database no longer verifies. This is what makes “append-only” checkable rather than merely stated.",
            "Har entry apni pichhli entry ke saath hash hoti hai — database mein seedha badli ya hataayi gayi entry verify nahi hoti. Yehi cheez “append-only” ko sirf daawa nahi, jaanchne ke qabil banati hai.",
          )}
        </p>
      )}

      {result && (
        <div
          // A broken chain means the table has been tampered with. It is
          // announced, not just coloured.
          role={result.valid ? "status" : "alert"}
          className={cx(
            "pop-in flex items-start gap-4 rounded-2xl border p-5",
            result.valid ? "border-stable/40 bg-stable-soft" : "border-critical/60 bg-critical-soft glow-critical",
          )}
        >
          <span
            aria-hidden
            className={cx(
              "pop-scale grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-card shadow-sm",
              result.valid ? "text-stable" : "text-critical",
            )}
          >
            <Icon name={result.valid ? "verified_user" : "gpp_bad"} filled className="text-[24px]" />
          </span>
          <div className="min-w-0">
            <p className={cx("font-display font-bold", result.valid ? "text-stable" : "text-critical")}>
              {result.detail}
            </p>
            <p className={cx("mt-1 text-sm tabular-nums", result.valid ? "text-stable" : "text-strong")}>
              {result.checked} {tr("entries checked", "entries jaanchi gayin")}
              {result.brokenAt && ` · ${tr("first break at entry", "pehla tor is entry par:")} ${result.brokenAt}`}
            </p>
          </div>
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Timeline
// ---------------------------------------------------------------------------

function Reference({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] font-bold uppercase tracking-wider text-faint">{label}</dt>
      <dd className={cx("mt-0.5 truncate text-sm tabular-nums", value ? "text-strong" : "text-faint")}>
        {value ?? "—"}
      </dd>
    </div>
  );
}

function EntryNode({ entry }: { entry: AuditEntry }) {
  const tr = useTr();
  const [open, setOpen] = useState(false);
  const alerting = ALERTING.includes(entry.severity);
  const nodeTone = alerting
    ? "is-critical"
    : entry.severity === "WARNING"
      ? undefined
      : "is-accent";
  const hasMetadata = entry.metadata !== null && Object.keys(entry.metadata).length > 0;
  const panelId = `audit-entry-${entry.id}`;

  return (
    <li className="relative">
      {/* The node sits on the spine, outside the list's padding. Inline because
          the utility would lose to the unlayered `.timeline-node` rule. */}
      <span aria-hidden className={cx("timeline-node", nodeTone)} style={{ left: "-2rem" }} />

      <p className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold tabular-nums text-faint">
        <Icon name="schedule" className="text-[14px]" />
        {when(entry.timestamp)}
      </p>

      <div
        className={cx(
          "hover-lift-sm overflow-hidden rounded-2xl border bg-card shadow-card",
          alerting ? "border-critical/40" : "border-line",
        )}
      >
        <button
          type="button"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen((value) => !value)}
          className={cx(
            "group flex w-full items-start gap-4 p-4 text-left transition-colors duration-200",
            "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary",
            alerting ? "bg-critical-soft/40 hover:bg-critical-soft/70" : "hover:bg-gradient-soft",
          )}
        >
          <span
            aria-hidden
            className={cx(
              "icon-wiggle grid h-10 w-10 shrink-0 place-items-center rounded-xl",
              alerting ? "bg-critical-soft text-critical" : "bg-gradient-soft text-primary",
            )}
          >
            <Icon name={iconFor(entry.action, entry.severity)} filled={alerting} className="text-[20px]" />
          </span>

          <span className="min-w-0 flex-1">
            <span className="flex flex-wrap items-center gap-2">
              <span className="font-semibold text-strong">{humanise(entry.action)}</span>
              {alerting && (
                <Badge tone={SEVERITY_TONE[entry.severity]}>{humanise(entry.severity)}</Badge>
              )}
              {entry.entityType && <Badge>{entry.entityType}</Badge>}
            </span>
            <span className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted">
              <span className="inline-flex items-center gap-1">
                <Icon name="person" className="text-[16px] text-faint" />
                {/* Null when the account has since been deleted. `userId` is
                    deliberately not a foreign key — the trail outlives its subject. */}
                {entry.actorName ?? (
                  <span className="italic text-faint">{tr("(deleted account)", "(hazf shuda account)")}</span>
                )}
                {entry.actorRole && (
                  <span className="text-xs text-faint">· {entry.actorRole.toLowerCase()}</span>
                )}
              </span>
              {entry.ipAddress && (
                <span className="inline-flex items-center gap-1 text-xs tabular-nums text-faint">
                  <Icon name="lan" className="text-[14px]" />
                  {entry.ipAddress}
                </span>
              )}
            </span>
          </span>

          <span className="flex shrink-0 items-center gap-2 self-center">
            <span
              title={tr("Sealed — this entry cannot be edited or removed", "Mohr-band — yeh entry na badli ja sakti hai, na hataayi")}
              className="inline-flex items-center gap-1 rounded-full bg-sunken px-2 py-0.5 text-[11px] font-bold uppercase tracking-wider text-faint"
            >
              <Icon name="lock" filled className="text-[13px]" />
              <span className="hidden sm:inline">{tr("Sealed", "Mohr-band")}</span>
            </span>
            <Icon
              name="expand_more"
              className={cx(
                "text-[22px] text-faint transition-transform duration-300",
                open && "rotate-180 text-primary",
              )}
            />
          </span>
        </button>

        <AnimatePresence initial={false}>
          {open && (
            <motion.div
              id={panelId}
              key="detail"
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
              className="overflow-hidden"
            >
              <div className="space-y-4 border-t border-line px-4 pb-4 pt-4">
                <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3 lg:grid-cols-6">
                  <Reference label={tr("Entity", "Cheez")} value={entry.entityType} />
                  <Reference label={tr("Entity id", "Cheez ki id")} value={entry.entityId} />
                  <Reference label={tr("Patient", "Mareez")} value={entry.patientId} />
                  <Reference label={tr("Actor id", "Amal karne wale ki id")} value={entry.userId} />
                  <Reference label={tr("Request", "Darkhwast")} value={entry.requestId} />
                  <Reference label={tr("Emergency grant", "Emergency grant")} value={entry.emergencyAccessId} />
                </dl>

                <div>
                  <p className="mb-2 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-faint">
                    <Icon name="data_object" className="text-[14px]" />
                    {tr("Recorded detail", "Darj tafseel")}
                  </p>
                  {hasMetadata ? (
                    <JsonBlock value={entry.metadata} />
                  ) : (
                    <p className="rounded-xl border border-dashed border-line px-4 py-3 text-sm text-faint">
                      {tr(
                        "Nothing beyond the references above was recorded for this entry.",
                        "Is entry ke liye upar diye hawalon ke ilawa kuchh darj nahi hua.",
                      )}
                    </p>
                  )}
                </div>

                <p className="flex items-center gap-1.5 text-xs text-faint">
                  <Icon name="verified_user" className="text-[14px] text-accent" />
                  {tr(
                    "References only — field names, ids and counts. Clinical values are never written to the trail.",
                    "Sirf hawale — field ke naam, ids aur ginti. Clinical values kabhi trail mein nahi likhi jaatin.",
                  )}
                </p>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </li>
  );
}

export function AuditPanel() {
  const tr = useTr();
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
        icon="history"
        title={tr("Audit trail", "Audit trail")}
        description={tr(
          "Every sensitive action, newest first. Entries cannot be edited or removed.",
          "Har hassas amal, naya pehle. Entries na badli ja sakti hain, na hataayi.",
        )}
        action={
          <div className="flex flex-wrap items-center gap-4">
            <div
              className={cx(
                "flex items-center gap-2.5 rounded-xl border px-3 py-1.5",
                securityEvents > 0 ? "border-critical/40 bg-critical-soft" : "border-line bg-sunken",
              )}
            >
              <Icon
                name={securityEvents > 0 ? "gpp_maybe" : "gpp_good"}
                filled
                className={cx("text-[20px]", securityEvents > 0 ? "text-critical" : "text-stable")}
              />
              <div className="leading-tight">
                <p className="text-[11px] font-bold uppercase tracking-wider text-faint">
                  {tr("Security events", "Security ke waqiat")}
                </p>
                <p
                  className={cx(
                    "font-display text-lg font-bold tabular-nums",
                    securityEvents > 0 ? "text-critical" : "text-strong",
                  )}
                >
                  {securityEvents}
                </p>
              </div>
            </div>
            <PillGroup
              label={tr("Filter the audit trail", "Audit trail filter karein")}
              value={securityOnly ? "security" : "all"}
              onChange={(next) => setSecurityOnly(next === "security")}
              options={[
                { value: "all", label: tr("Show all", "Sab dikhayein") },
                { value: "security", label: tr("Security only", "Sirf security") },
              ]}
            />
          </div>
        }
      >
        {fetched.loading && (
          <div role="status" aria-live="polite">
            <span className="sr-only">{tr("Loading the audit trail", "Audit trail load ho raha hai")}…</span>
            <SkeletonRows rows={5} title={false} />
          </div>
        )}
        {fetched.error && <ErrorState message={fetched.error.message} onRetry={fetched.reload} />}

        {!fetched.loading && !fetched.error && rows.length === 0 && (
          <EmptyState
            icon={securityOnly ? "gpp_good" : "history"}
            title={
              securityOnly
                ? tr("No security events", "Koi security waqia nahi")
                : tr("No entries", "Koi entry nahi")
            }
            description={
              securityOnly
                ? tr(
                    "No denied access or break-glass use has been recorded.",
                    "Na koi rasai roki gayi, na emergency access istemal hui.",
                  )
                : tr(
                    "Sensitive actions are recorded here as they happen.",
                    "Hassas amal hote hi yahan darj ho jate hain.",
                  )
            }
            action={
              securityOnly ? (
                <Button variant="secondary" onClick={() => setSecurityOnly(false)}>
                  {tr("Show all", "Sab dikhayein")}
                </Button>
              ) : undefined
            }
          />
        )}

        {rows.length > 0 && (
          <ol className="timeline stagger space-y-5" aria-label={tr("Audit trail, newest first", "Audit trail, naya pehle")}>
            {rows.map((entry) => (
              <EntryNode key={entry.id} entry={entry} />
            ))}
          </ol>
        )}
      </Card>
    </div>
  );
}
