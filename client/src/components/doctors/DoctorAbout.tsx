"use client";

/**
 * Everything about one doctor, on the screen where somebody is choosing.
 *
 * The card in the list was carrying five facts at once — specialization,
 * clinic, city, qualifications, years, department — and a grid of those is
 * unreadable at exactly the moment it matters. So the card keeps the two things
 * a person scans by, the name and the field, and everything else moves here,
 * behind one button they press when a name is worth a second look.
 *
 * This is also where the map belongs. On the confirmation step it answered a
 * question already settled; here it answers the one being asked — *can I
 * actually get to this person* — which is half of choosing a doctor and the
 * reason the location work exists at all.
 *
 * The panel books. A patient who has just read why this is the right doctor
 * should not have to close a dialog, find the card again and press it: the
 * action belongs where the decision is made.
 */

import { Dialog } from "@/components/overlays";
import { Avatar, Badge, Button } from "@/components/ui";
import { Icon } from "@/components/Icon";
import { ClinicMap } from "@/components/doctors/ClinicMap";
import { useTr } from "@/lib/lang";

/** The directory row. Structural, so this cannot drift from what is listed. */
export interface DirectoryDoctor {
  id: string;
  name: string;
  avatarUrl: string | null;
  specialization: string;
  qualifications: string | null;
  yearsExperience: number | null;
  consultationFee: number;
  acceptingPatients: boolean;
  clinicName: string | null;
  city: string | null;
  addressLine: string | null;
  latitude: number | null;
  longitude: number | null;
  department: { id: string; name: string; code: string } | null;
}

function Fact({
  icon,
  label,
  children,
}: {
  icon: string;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-3">
      <span
        aria-hidden
        className="bg-gradient-soft mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-lg text-primary"
      >
        <Icon name={icon} className="text-[18px]" />
      </span>
      <div className="min-w-0">
        <dt className="text-[11px] font-bold uppercase tracking-wider text-faint">{label}</dt>
        <dd className="text-sm text-strong">{children}</dd>
      </div>
    </div>
  );
}

export function DoctorAbout({
  doctor,
  open,
  onClose,
  onBook,
}: {
  doctor: DirectoryDoctor | null;
  open: boolean;
  onClose: () => void;
  /** Chooses this doctor and moves the booking on. */
  onBook: (id: string) => void;
}) {
  const tr = useTr();
  if (!doctor) return null;

  const fee = new Intl.NumberFormat("en-PK", {
    style: "currency",
    currency: "PKR",
    maximumFractionDigits: 0,
  }).format(doctor.consultationFee);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      title={doctor.name}
      description={doctor.specialization}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {tr("Back", "Wapas")}
          </Button>
          <Button
            onClick={() => onBook(doctor.id)}
            // A doctor who is not taking patients has no slots to offer, and a
            // button that leads to an empty calendar is worse than one that is
            // plainly unavailable.
            disabled={!doctor.acceptingPatients}
          >
            <Icon name="calendar_add_on" className="text-[20px]" />
            {doctor.acceptingPatients
              ? tr("Book with this doctor", "Is doctor se appointment lein")
              : tr("Not taking patients", "Naye mareez nahi le rahe")}
          </Button>
        </>
      }
    >
      <div className="space-y-6">
        <div className="flex items-center gap-4">
          <Avatar name={doctor.name} src={doctor.avatarUrl} size="lg" />
          <div className="min-w-0">
            <p className="font-display text-lg font-bold text-strong">{doctor.name}</p>
            <p className="text-sm text-muted">{doctor.specialization}</p>
            <div className="mt-1.5 flex flex-wrap gap-2">
              {doctor.acceptingPatients ? (
                <Badge tone="good">{tr("Taking patients", "Naye mareez le rahe hain")}</Badge>
              ) : (
                <Badge tone="neutral">{tr("Not taking patients", "Naye mareez nahi le rahe")}</Badge>
              )}
              {doctor.department && <Badge tone="neutral">{doctor.department.name}</Badge>}
            </div>
          </div>
        </div>

        <dl className="grid gap-5 sm:grid-cols-2">
          {doctor.qualifications && (
            <Fact icon="school" label={tr("Qualifications", "Taleem")}>
              {doctor.qualifications}
            </Fact>
          )}

          {doctor.yearsExperience !== null && (
            <Fact icon="workspace_premium" label={tr("Experience", "Tajurba")}>
              {doctor.yearsExperience === 1
                ? tr("1 year", "1 saal")
                : tr(`${doctor.yearsExperience} years`, `${doctor.yearsExperience} saal`)}
            </Fact>
          )}

          <Fact icon="payments" label={tr("Consultation fee", "Consultation fee")}>
            <span className="tabular-nums">{fee}</span>
            <span className="text-muted"> {tr("per visit", "har visit")}</span>
          </Fact>

          {doctor.department && (
            <Fact icon="domain" label={tr("Department", "Department")}>
              {doctor.department.name}
            </Fact>
          )}
        </dl>

        {/* Where. Its own block rather than a fact in the grid, because it is
            the one thing here that decides whether the rest matters. */}
        {(doctor.clinicName || doctor.city) && (
          <div className="rounded-2xl border border-line bg-sunken p-4">
            <p className="text-[11px] font-bold uppercase tracking-wider text-faint">
              {tr("Where they practise", "Kahan baithte hain")}
            </p>
            <p className="mt-1.5 flex items-start gap-2 text-sm">
              <Icon name="location_on" className="mt-0.5 shrink-0 text-[18px] text-primary" />
              <span>
                {doctor.clinicName && (
                  <span className="block font-semibold text-strong">{doctor.clinicName}</span>
                )}
                {doctor.addressLine && (
                  <span className="block text-muted">{doctor.addressLine}</span>
                )}
                {doctor.city && <span className="block text-muted">{doctor.city}</span>}
              </span>
            </p>
            {/* Renders nothing without a pin, a key, or a reachable Google —
                and the address above has already answered the question. */}
            <ClinicMap
              className="mt-3"
              latitude={doctor.latitude}
              longitude={doctor.longitude}
              label={doctor.clinicName ?? doctor.name}
            />
          </div>
        )}
      </div>
    </Dialog>
  );
}
