/**
 * The patient's account settings.
 *
 * A wrapper and nothing else: the settings body is one component shared by all
 * three portals, because the account a patient holds is the same kind of
 * account everyone else holds. What is role-specific — the record a patient can
 * open, the notifications this role actually receives — is decided from the
 * role passed in.
 */

import { AppShell } from "@/components/AppShell";
import { AccountSettings } from "@/components/settings/AccountSettings";

export default function PatientSettingsPage() {
  return (
    <AppShell role="PATIENT">
      <AccountSettings role="PATIENT" />
    </AppShell>
  );
}
