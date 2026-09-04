"use client";

/**
 * Account settings, one body for all three portals.
 *
 * A patient, a doctor and an administrator hold the same kind of account — the
 * same password, the same second factor, the same devices — so they get the
 * same screen. What differs is small and passed in: the record a patient can
 * link to, and which notifications the role actually receives.
 *
 * **The open tab lives in the URL fragment, not in React state.** That is what
 * lets the account menu offer "Profile" and "Account settings" as two entries
 * without lying about them being different pages, what makes a link to the
 * security tab something a person can send, and what makes clicking "Profile"
 * work while you are already looking at the security tab.
 */

import { useCallback, useSyncExternalStore } from "react";

import { PageHeader } from "@/components/PageHeader";
import { Segmented } from "@/components/forms";
import { AppearanceTab } from "@/components/settings/AppearanceTab";
import { DataTab } from "@/components/settings/DataTab";
import { NotificationsTab } from "@/components/settings/NotificationsTab";
import { ProfileTab } from "@/components/settings/ProfileTab";
import { SecurityTab } from "@/components/settings/SecurityTab";
import { useTr } from "@/lib/lang";
import type { Role } from "@/lib/api";

const TABS = ["profile", "security", "notifications", "appearance", "data"] as const;
type Tab = (typeof TABS)[number];

/**
 * Which sections this account actually has.
 *
 * `data` is a patient's own clinical history, so it exists only for a patient.
 * A doctor's account holds no chart of its own, and an administrator taking a
 * copy of somebody else's is not an export — it is access, and it goes through
 * the chart, where it is recorded as such.
 */
export function tabsFor(role: Role): readonly Tab[] {
  return role === "PATIENT" ? TABS : TABS.filter((tab) => tab !== "data");
}

function isTab(value: string): value is Tab {
  return (TABS as readonly string[]).includes(value);
}

function readHash(): Tab {
  const value = window.location.hash.replace("#", "");
  return isTab(value) ? value : "profile";
}

/**
 * The fragment as an external store.
 *
 * `replaceState` does not fire `hashchange`, so writers ring the bell
 * themselves; a real navigation to another fragment still arrives through the
 * browser's event. The server snapshot is the first tab, which is what a link
 * with no fragment lands on anyway — so there is nothing to correct after
 * hydration.
 */
const hashListeners = new Set<() => void>();

function subscribeHash(listener: () => void): () => void {
  hashListeners.add(listener);
  window.addEventListener("hashchange", listener);
  return () => {
    hashListeners.delete(listener);
    window.removeEventListener("hashchange", listener);
  };
}

function useTabFromHash(): [Tab, (next: Tab) => void] {
  const tab = useSyncExternalStore(subscribeHash, readHash, () => "profile" as Tab);
  const choose = useCallback((next: Tab) => {
    try {
      // `replace`, not `push`: switching tabs is not a place in history that
      // the back button should have to walk out of.
      window.history.replaceState(null, "", `#${next}`);
    } catch {
      // A browser that refuses the fragment still gets the tab below.
    }
    for (const listener of hashListeners) listener();
  }, []);
  return [tab, choose];
}

export function AccountSettings({ role }: { role: Role }) {
  const tr = useTr();
  const [fragment, choose] = useTabFromHash();
  const available = tabsFor(role);
  // A doctor following a patient's `#data` link lands on Profile rather than an
  // empty panel. The fragment is public, so it cannot be trusted to name a tab
  // this account has.
  const tab = available.includes(fragment) ? fragment : "profile";

  const labels: Record<Tab, [string, string]> = {
    profile: ["Profile", "Profile"],
    security: ["Security", "Hifazat"],
    notifications: ["Notifications", "Ittilaat"],
    appearance: ["Appearance", "Shakl o surat"],
    data: ["Your record", "Aap ka record"],
  };

  const icons: Record<Tab, string> = {
    profile: "person",
    security: "encrypted",
    notifications: "notifications",
    appearance: "palette",
    data: "download",
  };

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={tr("Account", "Account")}
        title={tr("Settings", "Settings")}
        subtitle={tr(
          "Your details, how you sign in, what you are told about, and how it all looks.",
          "Aap ki tafseelat, sign-in ka tareeqa, kis cheez ki ittila milti hai, aur yeh sab dikhta kaisa hai.",
        )}
      />

      <div className="-mx-1 overflow-x-auto px-1 pb-1">
        <Segmented
          label={tr("Settings sections", "Settings ke hisse")}
          value={tab}
          onChange={choose}
          size="sm"
          className="w-max min-w-full"
          options={available.map((value) => ({
            value,
            label: tr(...labels[value]),
            icon: icons[value],
          }))}
        />
      </div>

      {/* Keyed on the tab so the panel replays its entrance: the content
          changing under a stationary heading is otherwise easy to miss. */}
      <div key={tab} role="tabpanel" aria-label={tr(...labels[tab])} className="pop-in">
        {tab === "profile" && <ProfileTab role={role} />}
        {tab === "security" && <SecurityTab />}
        {tab === "notifications" && <NotificationsTab role={role} />}
        {tab === "appearance" && <AppearanceTab />}
        {tab === "data" && <DataTab />}
      </div>
    </div>
  );
}
