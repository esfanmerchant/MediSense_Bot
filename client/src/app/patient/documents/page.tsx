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
import { ErrorState, Loading } from "@/components/ui";
import { useTr } from "@/lib/lang";
import { useSession } from "@/lib/session";

export default function PatientDocuments() {
  const { user, loading } = useSession();
  const tr = useTr();

  return (
    <AppShell role="PATIENT">
      <div id="main">
        <PageHeader
          eyebrow={tr("Patient portal", "Mareez ka portal")}
          title={tr("Documents", "Documents")}
          subtitle={tr(
            "Upload reports, prescriptions and scans so your care team can see them. Files are private — they open through a link that expires, and only your care team can read them.",
            "Reports, nuskhe aur scans upload karein taake aap ki care team dekh sake. Files nijji hain — mukhtasar muddat ke link se khulti hain, aur sirf aap ki care team parh sakti hai.",
          )}
        />

        {loading && <Loading label={tr("Loading your documents", "Documents load ho rahe hain")} />}

        {!loading && !user?.patientId && (
          <ErrorState
            title="No patient record"
            message="This account is not linked to a patient record. Contact an administrator."
          />
        )}

        {user?.patientId && (
          <div className="mt-6">
            <DocumentsCard
              patientId={user.patientId}
              title="Your documents"
              description="Anything you upload is visible to the doctors treating you."
            />
          </div>
        )}
      </div>
    </AppShell>
  );
}
