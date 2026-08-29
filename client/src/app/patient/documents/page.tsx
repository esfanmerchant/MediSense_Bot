"use client";

/**
 * The patient's own documents.
 *
 * The patient id comes from the session, never from the page — a patient can
 * only ever reach their own file here, and the API would refuse anything else
 * regardless.
 */

import { AppShell } from "@/components/AppShell";
import { PageHeader } from "@/components/PageHeader";
import { DocumentsCard } from "@/components/DocumentsCard";
import { ErrorState, SkeletonRows } from "@/components/ui";
import { useTr } from "@/lib/lang";
import { useSession } from "@/lib/session";

export default function PatientDocuments() {
  const { user, loading } = useSession();
  const tr = useTr();

  return (
    <AppShell role="PATIENT">
      <div id="main" className="page-enter">
        <PageHeader
          eyebrow={tr("Patient portal", "Mareez ka portal")}
          title={tr("Documents", "Documents")}
          subtitle={tr(
            "Upload reports, prescriptions and scans so your care team can see them. Files are private — they open through a link that expires, and only your care team can read them.",
            "Reports, nuskhe aur scans upload karein taake aap ki care team dekh sake. Files nijji hain — mukhtasar muddat ke link se khulti hain, aur sirf aap ki care team parh sakti hai.",
          )}
        />

        {loading && (
          <div role="status" aria-live="polite" className="mt-6">
            <span className="sr-only">{tr("Loading your documents", "Documents load ho rahe hain")}…</span>
            <SkeletonRows rows={3} />
          </div>
        )}

        {!loading && !user?.patientId && (
          <div className="mt-6">
            <ErrorState
              title={tr("No patient record", "Mareez ka record nahi")}
              message={tr(
                "This account is not linked to a patient record. Contact an administrator.",
                "Yeh account kisi mareez ke record se juda nahi. Administrator se rabta karein.",
              )}
            />
          </div>
        )}

        {user?.patientId && (
          <div className="pop-in mt-6">
            <DocumentsCard
              patientId={user.patientId}
              title={tr("Your documents", "Aap ki documents")}
              description={tr(
                "Anything you upload is visible to the doctors treating you.",
                "Jo kuchh aap upload karein, aap ka ilaaj karne wale doctors dekh sakte hain.",
              )}
            />
          </div>
        )}
      </div>
    </AppShell>
  );
}
