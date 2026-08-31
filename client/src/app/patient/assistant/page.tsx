"use client";

/**
 * The patient's health assistant.
 *
 * There is no patient id in this route and no way to supply one: the API scopes
 * everything here to the signed-in patient's own record.
 *
 * `?q=` seeds the composer — the dashboard's "ask" box lands here with the
 * question already typed, so the person finishes a thought rather than
 * starting one over.
 */

import { useSearchParams } from "next/navigation";
import { Suspense } from "react";

import { AppShell } from "@/components/AppShell";
import { PageHeader } from "@/components/PageHeader";
import { Loading } from "@/components/ui";
import { useTr } from "@/lib/lang";
import { AssistantPanels } from "@/components/assistant";

function Workspace() {
  const params = useSearchParams();
  const prefill = (params.get("q") ?? "").slice(0, 2000);
  return <AssistantPanels prefill={prefill} />;
}

export default function PatientAssistant() {
  const tr = useTr();
  return (
    <AppShell role="PATIENT">
      <div id="main">
        <PageHeader
          eyebrow={tr("Patient portal", "Mareez ka portal")}
          title={tr("Health assistant", "Health assistant")}
          subtitle={tr(
            "Ask about your prescriptions, appointments or a report. It does not diagnose.",
            "Apne nuskhon, appointments ya report ke baare mein poochein. Yeh tashkhees nahi karta.",
          )}
        />

        <div className="mt-5">
          <Suspense fallback={<Loading />}>
            <Workspace />
          </Suspense>
        </div>
      </div>
    </AppShell>
  );
}
