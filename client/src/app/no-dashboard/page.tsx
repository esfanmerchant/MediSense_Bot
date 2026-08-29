"use client";

/**
 * Landing page for NURSE accounts.
 *
 * Nurses hold no standing access to patient data — their only patient-facing
 * capability is requesting time-boxed break-glass access during an emergency
 * (R3, conflict C1). So this is not a dashboard with nothing on it; it is the
 * one screen the role actually needs, and it says why there is nothing else.
 */

import { AppShell } from "@/components/AppShell";
import { Icon } from "@/components/Icon";
import { PageHeader } from "@/components/PageHeader";
import { EmergencyAccessPanel } from "@/components/emergency";
import { Card } from "@/components/ui";
import { useTr } from "@/lib/lang";
import { useSession } from "@/lib/session";

export default function NoDashboardPage() {
  const { user } = useSession();
  const tr = useTr();

  return (
    <AppShell role="NURSE">
      <div id="main" className="page-enter">
        <PageHeader
          eyebrow={tr("Nursing", "Nursing")}
          title={tr("Emergency access", "Emergency access")}
          subtitle={
            (user
              ? tr(`You are signed in as ${user.name}. `, `Aap ${user.name} ke taur par signed in hain. `)
              : "") +
            tr(
              "Nursing accounts do not hold standing access to patient records — you can open one patient's chart when you are treating them and need it.",
              "Nursing account ke paas mareez ke record ki mustaqil rasai nahi hoti — jis mareez ka aap ilaaj kar rahe hon, zaroorat par sirf usi ki file khol sakte hain.",
            )
          }
        />

        <div className="mt-6 space-y-6">
          <EmergencyAccessPanel />

          <Card
            icon="shield_person"
            className="blob-corner relative overflow-hidden"
            title={tr("Why you have no patient list", "Aap ke paas mareezon ki list kyun nahi")}
          >
            <div className="relative grid gap-4 sm:grid-cols-2">
              <p className="flex gap-3 text-muted">
                <Icon name="diversity_1" className="mt-0.5 shrink-0 text-[22px] text-accent" />
                <span>
                  {tr(
                    "Access here is decided by the relationship to a patient, not by the role on the account. A doctor sees the patients they treat; you see the patient in front of you, for as long as you are treating them.",
                    "Yahan rasai mareez se taalluq par tay hoti hai, account ke role par nahi. Doctor apne ilaaj wale mareez dekhta hai; aap apne saamne wale mareez ko, jab tak aap unka ilaaj kar rahe hain.",
                  )}
                </span>
              </p>
              <p className="flex gap-3 text-muted">
                <Icon name="verified_user" className="mt-0.5 shrink-0 text-[22px] text-accent" />
                <span>
                  {tr(
                    "That is deliberate. A standing list of every patient would be a standing risk, and the emergency route gives you the same information when you actually need it — with a record of why.",
                    "Yeh jaan boojh kar hai. Har mareez ki mustaqil list ek mustaqil khatra hoti; emergency raasta aap ko zaroorat ke waqt wahi maloomat deta hai — aur saath mein wajah ka record.",
                  )}
                </span>
              </p>
            </div>
          </Card>
        </div>
      </div>
    </AppShell>
  );
}
