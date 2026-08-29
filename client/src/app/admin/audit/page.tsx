"use client";

/**
 * The audit trail.
 *
 * Read-only by design, not by omission: there is no endpoint to add, edit or
 * remove an entry, because a log somebody can write to is a log somebody can
 * forge (R6).
 */

import { AppShell } from "@/components/AppShell";
import { PageHeader } from "@/components/PageHeader";
import { useTr } from "@/lib/lang";
import { AuditPanel } from "@/components/audit";

export default function AdminAudit() {
  const tr = useTr();
  return (
    <AppShell role="ADMIN">
      <div id="main">
        <PageHeader
          eyebrow={tr("Admin portal", "Intezami portal")}
          title={tr("Audit trail", "Audit trail")}
          subtitle={tr(
            "Every sensitive action, in order, hash-chained so tampering is detectable. Opening this page is itself recorded.",
            "Har hassas amal, tarteeb se, hash-chain mein — cherh-chharh pakri ja sakti hai. Yeh safha kholna bhi darj hota hai.",
          )}
        />

        <div className="mt-6">
          <AuditPanel />
        </div>
      </div>
    </AppShell>
  );
}
