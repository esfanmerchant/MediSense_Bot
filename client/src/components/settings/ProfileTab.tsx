"use client";

/**
 * Who the account says you are.
 *
 * **The record is read-only, and it says so.** There is no endpoint that lets a
 * person edit their own name, email or phone — in a hospital those are identity
 * fields that a records office owns, and the one route that touches them is an
 * administrator changing an account's status. Rendering an editable form over a
 * Save button that cannot save would be a lie told politely, so the fields are
 * presented as what they are: a record, with a sentence saying where it is
 * changed.
 *
 * The picture is the exception, and it is a real one rather than a crack in the
 * rule: it identifies nobody and appears on no record, so it belongs to the
 * person rather than to the records office. It is the only thing on this screen
 * that can be changed from this screen.
 */

import Link from "next/link";

import { Icon } from "@/components/Icon";
import { EcgLine } from "@/components/brand/EcgLine";
import { AvatarEditor } from "@/components/settings/AvatarEditor";
import { Badge, Card, cx } from "@/components/ui";
import { useTr } from "@/lib/lang";
import { useSession } from "@/lib/session";
import type { Role } from "@/lib/api";

const ROLE_LABEL: Record<Role, [string, string]> = {
  PATIENT: ["Patient", "Mareez"],
  DOCTOR: ["Doctor", "Doctor"],
  ADMIN: ["Administrator", "Admin"],
  NURSE: ["Nurse", "Nurse"],
};

/** One field of the record: a mono-caps name, and the value under it. */
function Detail({
  label,
  value,
  missing,
  icon,
}: {
  label: string;
  value: string | null;
  /** Shown in place of a null value, in the faint tone. */
  missing: string;
  icon: string;
}) {
  return (
    <div className="flex items-start gap-3 py-3.5">
      <Icon name={icon} className="mt-0.5 shrink-0 text-[20px] text-faint" />
      <div className="min-w-0">
        <p className="mono-caps text-[0.68rem] text-faint">{label}</p>
        <p
          className={cx(
            "mt-1 break-words text-[0.9375rem]",
            value ? "font-medium text-strong" : "italic text-faint",
          )}
        >
          {value ?? missing}
        </p>
      </div>
    </div>
  );
}

export function ProfileTab({ role }: { role: Role }) {
  const tr = useTr();
  const { user, refreshUser } = useSession();
  if (!user) return null;

  const active = user.status === "ACTIVE";
  const recordId = role === "PATIENT" ? user.patientId : role === "DOCTOR" ? user.doctorId : null;

  return (
    <div className="space-y-6">
      <Card>
        <div className="flex flex-wrap items-center gap-4">
          {/* Refreshing the session rather than patching one avatar: the
              picture appears in the rail, the header and the profile menu too,
              and they should all change together or the product looks like it
              half-applied the edit. */}
          <AvatarEditor name={user.name} avatarUrl={user.avatarUrl} onChanged={refreshUser} />
          <div className="min-w-0">
            <h2 className="font-display text-xl font-bold text-strong">{user.name}</h2>
            <p className="mt-0.5 truncate text-sm text-muted">{user.email}</p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <span className="bg-gradient-soft inline-flex rounded-full px-2.5 py-0.5">
                <span className="text-gradient-brand text-[11px] font-bold uppercase tracking-wider">
                  {tr(...ROLE_LABEL[user.role])}
                </span>
              </span>
              <Badge tone={active ? "good" : "warning"}>
                <Icon name={active ? "verified" : "pause_circle"} className="text-[14px]" />
                {active ? tr("Active", "Faal") : user.status}
              </Badge>
            </div>
          </div>
        </div>

        <EcgLine height={26} speed={2.8} className="my-2 opacity-40" />

        <div className="divide-y divide-line">
          <Detail
            icon="badge"
            label={tr("Full name", "Poora naam")}
            value={user.name}
            missing={tr("Not on file", "Record par nahi")}
          />
          <Detail
            icon="mail"
            label={tr("Email", "Email")}
            value={user.email}
            missing={tr("Not on file", "Record par nahi")}
          />
          <Detail
            icon="call"
            label={tr("Phone", "Phone")}
            value={user.phone}
            missing={tr("Not on file", "Record par nahi")}
          />
          {recordId && (
            <Detail
              icon="fingerprint"
              label={
                role === "PATIENT"
                  ? tr("Patient record", "Mareez ka record")
                  : tr("Practitioner record", "Doctor ka record")
              }
              value={recordId}
              missing={tr("Not on file", "Record par nahi")}
            />
          )}
        </div>
      </Card>

      {/* The honest sentence, given its own weight rather than buried as a hint
          under a disabled input. */}
      <div role="note" className="flex items-start gap-3 rounded-2xl border border-line bg-sunken/60 p-4">
        <Icon name="lock" className="mt-0.5 shrink-0 text-[20px] text-muted" />
        <p className="text-sm leading-relaxed text-muted">
          {tr(
            "Your name, email and phone cannot be edited here. They are identity fields on a medical record, and the system offers no endpoint for changing your own — ask the records office or an administrator, who makes the change against an audited account. Your picture is yours: change or remove it from the circle above.",
            "Aap ka naam, email aur phone yahan tabdeel nahi ho saktay. Yeh medical record ki shanakht hain, aur system apne aap badalne ka koi rasta nahi deta — records office ya admin se kahein, jo audit hote account se tabdeeli karta hai. Tasveer aap ki apni hai: upar wale circle se badlein ya hata dein.",
          )}
        </p>
      </div>

      {role === "PATIENT" && (
        <Link
          href="/patient/records"
          className="hover-lift-sm group flex items-center gap-4 rounded-2xl border border-line bg-card p-5 shadow-card focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
        >
          <span
            aria-hidden
            className="bg-gradient-brand icon-bounce grid h-12 w-12 shrink-0 place-items-center rounded-2xl text-white shadow-md"
          >
            <Icon name="description" filled className="text-[24px]" />
          </span>
          <span className="min-w-0">
            <span className="block font-display text-[17px] font-bold text-strong">
              {tr("Your medical record", "Aap ka medical record")}
            </span>
            <span className="block text-sm text-muted">
              {tr(
                "Diagnoses, prescriptions and everything a clinician has written.",
                "Tashkhees, prescriptions aur jo kuch doctor ne likha.",
              )}
            </span>
          </span>
          <Icon
            name="arrow_forward"
            className="ml-auto shrink-0 text-[20px] text-faint transition-transform group-hover:translate-x-1"
          />
        </Link>
      )}
    </div>
  );
}
