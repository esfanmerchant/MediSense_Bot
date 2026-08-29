"use client";

/**
 * The patient's own documents.
 *
 * The patient id comes from the session, never from the page — a patient can
 * only ever reach their own file here, and the API would refuse anything else
 * regardless.
 */

import { AppShell } from "@/components/AppShell";
import { DocumentsCard } from "@/components/DocumentsCard";
import { ErrorState, Loading } from "@/components/ui";
import { useSession } from "@/lib/session";

export default function PatientDocuments() {
  const { user, loading } = useSession();

  return (
    <AppShell role="PATIENT">
      <div id="main">
        <h1 className="text-2xl font-semibold text-strong">Documents</h1>
        <p className="mt-1 text-muted">
          Upload reports, prescriptions and scans so your care team can see them. Files are
          private — they open through a link that expires, and only your care team can read them.
        </p>

        {loading && <Loading label="Loading your documents" />}

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
