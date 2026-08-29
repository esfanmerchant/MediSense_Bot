"use client";

/**
 * The patient's health assistant.
 *
 * There is no patient id in this route and no way to supply one: the API scopes
 * everything here to the signed-in patient's own record.
 */

import { AppShell } from "@/components/AppShell";
import { AssistantPanels } from "@/components/assistant";

export default function PatientAssistant() {
  return (
    <AppShell role="PATIENT">
      <div id="main">
        <h1 className="text-2xl font-semibold text-strong">
          Health assistant
        </h1>
        <p className="mt-1 max-w-2xl text-muted">
          Ask about your prescriptions and appointments, or describe how you are feeling. The
          assistant gives general guidance to help you decide what to do next — it does not
          diagnose, and it does not replace your doctor.
        </p>

        <div className="mt-6">
          <AssistantPanels />
        </div>
      </div>
    </AppShell>
  );
}
