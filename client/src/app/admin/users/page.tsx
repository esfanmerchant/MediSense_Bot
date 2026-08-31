"use client";

/**
 * Everybody on the platform, and taking somebody off it.
 *
 * **Suspend, never delete.** A patient has a medical record and a doctor has
 * consultations behind them; removing the row would either fail on a foreign
 * key or orphan real clinical history, and a hospital that can make a person's
 * treatment disappear is worse than one that cannot. Suspension ends the
 * access — every live session is revoked server-side the moment it is applied,
 * so somebody being removed for breaking the rules stops working immediately
 * rather than when their token happens to expire.
 *
 * **A reason is required here even though the API allows none.** This screen
 * exists for terms-of-service enforcement, and "why was this account closed"
 * is the first question anybody asks afterwards — of the administrator who did
 * it, who by then will not remember. The reason goes into the audit trail with
 * the actor and the timestamp.
 */

import { useCallback, useState } from "react";

import { AppShell } from "@/components/AppShell";
import { Icon } from "@/components/Icon";
import { PageHeader } from "@/components/PageHeader";
import { useToast } from "@/components/overlays";
import {
  Avatar,
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Field,
  Input,
  SkeletonRows,
  cx,
} from "@/components/ui";
import { ApiError, users, type Role } from "@/lib/api";
import { useTr } from "@/lib/lang";
import { useAsync } from "@/lib/useAsync";

type Row = {
  id: string;
  name: string;
  email: string;
  role: Role;
  status: string;
  lastLoginAt: string | null;
  createdAt: string;
};

const ROLES: Array<{ value: Role | ""; label: [string, string] }> = [
  { value: "", label: ["Everyone", "Sab"] },
  { value: "PATIENT", label: ["Patients", "Mareez"] },
  { value: "DOCTOR", label: ["Doctors", "Doctors"] },
  { value: "ADMIN", label: ["Admins", "Admins"] },
];

function Person({ row, onChanged }: { row: Row; onChanged: () => void }) {
  const tr = useTr();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [suspending, setSuspending] = useState(false);
  const [reason, setReason] = useState("");

  const active = row.status === "ACTIVE";

  async function change(status: "ACTIVE" | "SUSPENDED") {
    setBusy(true);
    try {
      await users.setStatus(row.id, status, status === "SUSPENDED" ? reason.trim() : undefined);
      toast.show({
        tone: "success",
        title:
          status === "SUSPENDED"
            ? tr("Account suspended", "Account mo'attal kar diya")
            : tr("Account restored", "Account bahaal kar diya"),
        body:
          status === "SUSPENDED"
            ? tr(
                `${row.name} has been signed out everywhere and cannot sign in.`,
                `${row.name} har jagah se sign out ho gaya aur ab andar nahi aa sakta.`,
              )
            : tr(`${row.name} can sign in again.`, `${row.name} dobara sign in kar sakta hai.`),
      });
      setSuspending(false);
      setReason("");
      onChanged();
    } catch (cause) {
      toast.show({
        tone: "critical",
        title: tr("That did not work", "Yeh nahi ho saka"),
        body: cause instanceof ApiError ? cause.message : String(cause),
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <li
      className={cx(
        "rounded-2xl border border-line bg-card p-4 shadow-card",
        !active && "opacity-80",
      )}
    >
      <div className="flex flex-wrap items-center gap-3">
        <Avatar name={row.name} />
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-2">
            <span className="font-display text-base font-bold text-strong">{row.name}</span>
            <Badge tone="neutral">{row.role}</Badge>
            {!active && <Badge tone="critical">{row.status}</Badge>}
          </p>
          <p className="truncate text-sm text-muted">{row.email}</p>
        </div>

        {active ? (
          <Button variant="ghost" onClick={() => setSuspending((open) => !open)}>
            {tr("Suspend", "Mo'attal karein")}
          </Button>
        ) : (
          <Button variant="secondary" loading={busy} onClick={() => change("ACTIVE")}>
            {tr("Restore", "Bahaal karein")}
          </Button>
        )}
      </div>

      {suspending && (
        <div className="mt-4 space-y-3 rounded-xl border border-critical/40 bg-critical-soft p-3">
          <p className="flex items-start gap-2 text-sm text-strong">
            <Icon name="warning" className="mt-0.5 shrink-0 text-[18px] text-critical" />
            <span>
              {tr(
                "They will be signed out everywhere immediately and will not be able to sign in. Their records stay — nothing is deleted.",
                "Woh foran har jagah se sign out ho jayenge aur andar nahi aa sakenge. Un ka record wahi rahega — kuch mitta nahi.",
              )}
            </span>
          </p>

          <Field
            label={tr("Why is this account being suspended?", "Yeh account kyun mo'attal ho raha hai?")}
            htmlFor={`reason-${row.id}`}
            hint={tr(
              "Recorded in the audit trail against your name.",
              "Audit trail mein aap ke naam ke saath darj hoga.",
            )}
          >
            <Input
              id={`reason-${row.id}`}
              maxLength={300}
              autoFocus
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          </Field>

          <div className="flex flex-wrap gap-2">
            <Button
              variant="danger"
              loading={busy}
              disabled={reason.trim().length < 3}
              onClick={() => change("SUSPENDED")}
            >
              {tr("Suspend account", "Account mo'attal karein")}
            </Button>
            <Button variant="ghost" onClick={() => setSuspending(false)}>
              {tr("Cancel", "Cancel")}
            </Button>
          </div>
        </div>
      )}
    </li>
  );
}

export default function AdminUsers() {
  const tr = useTr();
  const [role, setRole] = useState<Role | "">("");
  const [search, setSearch] = useState("");
  const [refresh, setRefresh] = useState(0);
  const reload = useCallback(() => setRefresh((n) => n + 1), []);

  const list = useAsync(
    () => users.list({ role: role || undefined, search: search || undefined, limit: 50 }),
    [role, search, refresh],
  );

  const rows = (list.data?.data ?? []) as Row[];

  return (
    <AppShell role="ADMIN">
      <div id="main" className="page-enter space-y-6">
        <PageHeader
          eyebrow={tr("Admin portal", "Intezami portal")}
          title={tr("People", "Log")}
          subtitle={tr(
            "Everybody on the platform, and who may still use it.",
            "Platform par sab log, aur kaun ab bhi istemal kar sakta hai.",
          )}
        />

        <Card>
          <div className="flex flex-wrap items-center gap-3">
            <div
              role="group"
              aria-label={tr("Role", "Kirdar")}
              className="inline-flex rounded-lg border border-line p-0.5"
            >
              {ROLES.map((option) => (
                <button
                  key={option.value || "all"}
                  type="button"
                  aria-pressed={role === option.value}
                  onClick={() => setRole(option.value)}
                  className={cx(
                    "min-h-9 rounded-md px-3 text-xs font-bold transition-colors",
                    "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary",
                    role === option.value
                      ? "bg-primary text-primary-on"
                      : "text-muted hover:text-strong",
                  )}
                >
                  {tr(...option.label)}
                </button>
              ))}
            </div>

            <div className="min-w-[14rem] flex-1">
              <Field label={tr("Search", "Talash")} htmlFor="people-search">
                <Input
                  id="people-search"
                  value={search}
                  maxLength={100}
                  onChange={(event) => setSearch(event.target.value)}
                />
              </Field>
            </div>
          </div>
        </Card>

        <Card icon="group" title={tr("Accounts", "Accounts")}>
          {list.loading && <SkeletonRows rows={4} />}
          {list.error && <ErrorState message={list.error.message} onRetry={list.reload} />}
          {list.data && rows.length === 0 && (
            <EmptyState
              icon="person_search"
              title={tr("Nobody matches", "Koi nahi mila")}
              description={tr("Try a different search.", "Koi aur talash karein.")}
            />
          )}
          {rows.length > 0 && (
            <ul className="space-y-3">
              {rows.map((row) => (
                <Person key={row.id} row={row} onChanged={reload} />
              ))}
            </ul>
          )}
        </Card>
      </div>
    </AppShell>
  );
}
