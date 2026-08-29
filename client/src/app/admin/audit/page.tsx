"use client";

/**
 * The audit trail.
 *
 * Read-only by design, not by omission: there is no endpoint to add, edit or
 * remove an entry, because a log somebody can write to is a log somebody can
 * forge (R6).
 */

import { AppShell } from "@/components/AppShell";
import { AuditPanel } from "@/components/audit";

export default function AdminAudit() {
  return (
    <AppShell role="ADMIN">
      <div id="main">
        <h1 className="text-2xl font-semibold text-strong">Audit trail</h1>
        <p className="mt-1 max-w-2xl text-muted">
          Every sensitive action, in order, hash-chained so tampering is detectable. Opening this
          page is itself recorded.
        </p>

        <div className="mt-6">
          <AuditPanel />
        </div>
      </div>
    </AppShell>
  );
}
