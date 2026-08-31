"use client";

/**
 * Where a doctor practises, as they edit it themselves.
 *
 * This sits beside the weekly hours rather than in account settings, because it
 * answers the same question those hours answer — *how does a patient reach me* —
 * and because it is the other half of being findable. Hours decide whether slots
 * exist; a city decides whether anybody browsing the directory ever sees them.
 *
 * Self-service on purpose. Licence number and department are credentialing
 * facts an administrator owns, but moving to a different clinic is an ordinary
 * Tuesday, and making a doctor wait on an administrator to correct their own
 * address is how a directory fills up with stale ones.
 *
 * The pin is optional throughout and says so. A coordinate is a convenience on
 * top of a written address, and a doctor who cannot be bothered to find theirs
 * must still end up listed, reachable, and bookable.
 */

import { useEffect, useState } from "react";

import { Icon } from "@/components/Icon";
import { useToast } from "@/components/overlays";
import { Button, Card, Field, Input, cx } from "@/components/ui";
import { ApiError, doctors, type DoctorProfile } from "@/lib/api";
import { useTr } from "@/lib/lang";

interface Draft {
  clinicName: string;
  city: string;
  addressLine: string;
  latitude: string;
  longitude: string;
}

function draftOf(profile: DoctorProfile | null): Draft {
  return {
    clinicName: profile?.clinicName ?? "",
    city: profile?.city ?? "",
    addressLine: profile?.addressLine ?? "",
    latitude: profile?.latitude?.toString() ?? "",
    longitude: profile?.longitude?.toString() ?? "",
  };
}

/** A coordinate the API will accept, or null — never NaN. */
function coordinate(raw: string, limit: number): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const value = Number(trimmed);
  if (!Number.isFinite(value) || Math.abs(value) > limit) return null;
  return value;
}

export function PracticeLocationCard() {
  const tr = useTr();
  const toast = useToast();

  const [profile, setProfile] = useState<DoctorProfile | null>(null);
  const [draft, setDraft] = useState<Draft>(draftOf(null));
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void doctors
      .me()
      .then((loaded) => {
        if (cancelled) return;
        setProfile(loaded);
        setDraft(draftOf(loaded));
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof ApiError ? cause.message : String(cause));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const patch = (change: Partial<Draft>) => setDraft((current) => ({ ...current, ...change }));

  const dirty = JSON.stringify(draft) !== JSON.stringify(draftOf(profile));
  const listed = Boolean(profile?.clinicName && profile?.city);

  // A half-entered coordinate pair is the one thing worth refusing here: one of
  // the two alone puts a pin nowhere, which is worse than no pin at all.
  const lat = coordinate(draft.latitude, 90);
  const lng = coordinate(draft.longitude, 180);
  const halfPin = Boolean(draft.latitude.trim()) !== Boolean(draft.longitude.trim());
  const badPin =
    (draft.latitude.trim() !== "" && lat === null) || (draft.longitude.trim() !== "" && lng === null);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const saved = await doctors.updateMe({
        clinicName: draft.clinicName.trim(),
        city: draft.city.trim(),
        addressLine: draft.addressLine.trim(),
        ...(lat !== null && lng !== null ? { latitude: lat, longitude: lng } : {}),
      });
      setProfile(saved);
      setDraft(draftOf(saved));
      toast.show({
        tone: "success",
        title: tr("Location saved", "Location mehfooz ho gayi"),
        body: tr(
          "Patients browsing this city will now find you.",
          "Ab is shehar mein dhoondne wale mareezon ko aap milenge.",
        ),
      });
    } catch (cause) {
      const message = cause instanceof ApiError ? cause.message : String(cause);
      setError(message);
      toast.show({
        tone: "critical",
        title: tr("That did not work", "Yeh nahi ho saka"),
        // The server's own words: it knows why it refused.
        body: message,
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card
      icon="location_on"
      title={tr("Where you practise", "Aap kahan baithte hain")}
      description={tr(
        "What a patient reads when choosing between doctors.",
        "Doctor chunte waqt mareez yahi parhta hai.",
      )}
    >
      {loading ? (
        <p className="text-sm text-muted">{tr("Loading…", "Load ho raha hai…")}</p>
      ) : (
        <div className="space-y-5">
          {/* The consequence, stated before the fields rather than after a
              failed save: a doctor with no city is not in anybody's list. */}
          {!listed && (
            <p
              role="status"
              className="flex items-start gap-2 rounded-xl border border-warning/40 bg-warning/10 p-3 text-sm text-strong"
            >
              <Icon name="info" className="mt-0.5 shrink-0 text-[18px] text-warning" />
              <span>
                {tr(
                  "Patients filtering by city will not find you until this is set.",
                  "Jab tak yeh nahi bharte, shehar se dhoondne wale mareezon ko aap nahi milenge.",
                )}
              </span>
            </p>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={tr("Clinic or hospital", "Clinic ya hospital")} htmlFor="practice-clinic">
              <Input
                id="practice-clinic"
                maxLength={160}
                value={draft.clinicName}
                onChange={(event) => patch({ clinicName: event.target.value })}
              />
            </Field>

            <Field label={tr("City", "Shehar")} htmlFor="practice-city">
              <Input
                id="practice-city"
                maxLength={80}
                autoComplete="address-level2"
                value={draft.city}
                onChange={(event) => patch({ city: event.target.value })}
              />
            </Field>

            <div className="sm:col-span-2">
              <Field label={tr("Address", "Pata")} htmlFor="practice-address">
                <Input
                  id="practice-address"
                  maxLength={300}
                  value={draft.addressLine}
                  onChange={(event) => patch({ addressLine: event.target.value })}
                />
              </Field>
            </div>
          </div>

          <div className="rounded-xl border border-line bg-sunken p-4">
            <p className="font-display text-sm font-bold text-strong">
              {tr("Map pin", "Naqshe ka pin")}
              <span className="ml-2 font-sans text-xs font-medium text-muted">
                {tr("Optional", "Ikhtiyari")}
              </span>
            </p>
            <p className="mt-1 text-sm text-muted">
              {tr(
                "Adds a map to your appointment page. Find the place on Google Maps, right-click it, and copy the two numbers.",
                "Aap ke appointment safhe par naqsha lagata hai. Google Maps par jagah dhoondein, right-click karein, aur dono number copy kar lein.",
              )}
            </p>
            <div className="mt-3 grid gap-4 sm:grid-cols-2">
              <Field label={tr("Latitude", "Latitude")} htmlFor="practice-lat">
                <Input
                  id="practice-lat"
                  inputMode="decimal"
                  className="tabular-nums"
                  placeholder="24.860966"
                  value={draft.latitude}
                  onChange={(event) => patch({ latitude: event.target.value })}
                />
              </Field>
              <Field label={tr("Longitude", "Longitude")} htmlFor="practice-lng">
                <Input
                  id="practice-lng"
                  inputMode="decimal"
                  className="tabular-nums"
                  placeholder="67.001137"
                  value={draft.longitude}
                  onChange={(event) => patch({ longitude: event.target.value })}
                />
              </Field>
            </div>
            {(halfPin || badPin) && (
              <p role="alert" className="mt-2 text-sm font-medium text-critical">
                {halfPin
                  ? tr(
                      "A pin needs both numbers. One on its own points nowhere.",
                      "Pin ke liye dono number chahiye. Akela number kahin nahi le jaata.",
                    )
                  : tr(
                      "That is not a valid coordinate.",
                      "Yeh durust coordinate nahi hai.",
                    )}
              </p>
            )}
          </div>

          {error && (
            <p role="alert" className="text-sm font-medium text-critical">
              {error}
            </p>
          )}

          <div className="flex flex-wrap items-center gap-3">
            <Button onClick={save} loading={saving} disabled={!dirty || halfPin || badPin}>
              {tr("Save location", "Location mehfooz karein")}
            </Button>
            <span className={cx("text-sm", dirty ? "text-strong" : "text-faint")}>
              {dirty
                ? tr("Unsaved changes", "Tabdeeliyan mehfooz nahi hui")
                : tr("Saved", "Mehfooz hai")}
            </span>
          </div>
        </div>
      )}
    </Card>
  );
}
