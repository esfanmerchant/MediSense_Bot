/**
 * The doctor's account settings.
 *
 * A wrapper and nothing else: the settings body is one component shared by all
 * three portals, because the account a doctor holds is the same kind of
 * account everyone else holds. What is role-specific — the record a patient can
 * open, the notifications this role actually receives — is decided from the
 * role passed in.
 */

import { AppShell } from "@/components/AppShell";
import { AccountSettings } from "@/components/settings/AccountSettings";

export default function DoctorSettingsPage() {
  return (
    <AppShell role="DOCTOR">
      <AccountSettings role="DOCTOR" />
    </AppShell>
  );
}
