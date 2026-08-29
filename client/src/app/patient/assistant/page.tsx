"use client";

/**
 * The patient's health assistant.
 *
 * There is no patient id in this route and no way to supply one: the API scopes
 * everything here to the signed-in patient's own record.
 */

import { AppShell } from "@/components/AppShell";
import { PageHeader } from "@/components/PageHeader";
import { useTr } from "@/lib/lang";
import { AssistantPanels } from "@/components/assistant";

export default function PatientAssistant() {
  const tr = useTr();
  return (
    <AppShell role="PATIENT">
      <div id="main">
        <PageHeader
          eyebrow={tr("Patient portal", "Mareez ka portal")}
          title={tr("Health assistant", "Health assistant")}
          subtitle={tr(
            "Ask about your prescriptions and appointments, or describe how you are feeling. The assistant gives general guidance to help you decide what to do next — it does not diagnose, and it does not replace your doctor.",
            "Apne nuskhon ya appointments ke baare mein poochein, ya bata dein ke tabiyat kaisi hai. Assistant aam rehnumai deta hai taake aap agla qadam tay kar sakein — yeh tashkhees nahi karta, aur doctor ki jagah nahi leta.",
          )}
        />

        <div className="mt-6">
          <AssistantPanels />
        </div>
      </div>
    </AppShell>
  );
}
