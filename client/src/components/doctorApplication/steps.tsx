"use client";

/**
 * The four data-entry steps of the doctor's application, and the review that
 * closes it.
 *
 * Each step is a pure view of one shared `FormState`: it renders what is there
 * and calls `patch` with what changed. Nothing here fetches, saves, or knows
 * that an auto-save exists — that belongs to the page, which owns the state and
 * decides when a copy of it goes to the server.
 */

import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import type { ReactNode } from "react";

import { Icon } from "@/components/Icon";
import {
  Button,
  Checkbox,
  EmptyState,
  Field,
  IconButton,
  Input,
  Select,
  Textarea,
  cx,
} from "@/components/ui";
import type { DoctorApplicationDraft } from "@/lib/api";
import { useTr } from "@/lib/lang";

import {
  KIND_META,
  SummaryField,
  type DepartmentOption,
} from "@/components/doctorApplication/shared";
import type { ApplicationDocument } from "@/lib/api";

// ---------------------------------------------------------------------------
// The form's own shape
// ---------------------------------------------------------------------------

/**
 * A qualification row carries an id the API never sees.
 *
 * Keying the rows by array index would make a removal animate the wrong row
 * out — React would reuse the element and only the text would change. An id
 * per row is what lets `AnimatePresence` collapse the row that actually left.
 */
export interface Qualification {
  id: string;
  value: string;
}

let qualificationSeq = 0;
export function newQualification(value = ""): Qualification {
  qualificationSeq += 1;
  return { id: `q${qualificationSeq}`, value };
}

/**
 * Numbers are held as strings while they are being typed.
 *
 * A half-typed "1" in a number field is not the number 1 — it is a person in
 * the middle of typing 15 — so the conversion happens once, on the way out.
 */
export interface FormState {
  fullName: string;
  phone: string;
  nationalId: string;
  address: string;
  registrationNumber: string;
  specialization: string;
  departmentId: string;
  yearsExperience: string;
  previousHospital: string;
  consultationFee: string;
  qualifications: Qualification[];
  /**
   * Carried, never edited. No step in this flow collects availability, and a
   * PUT that omitted it would quietly erase whatever is stored.
   */
  availability: DoctorApplicationDraft["availability"];
}

export function emptyForm(): FormState {
  return {
    fullName: "",
    phone: "",
    nationalId: "",
    address: "",
    registrationNumber: "",
    specialization: "",
    departmentId: "",
    yearsExperience: "",
    previousHospital: "",
    consultationFee: "",
    qualifications: [],
    availability: undefined,
  };
}

export function formFrom(draft: DoctorApplicationDraft): FormState {
  return {
    fullName: draft.fullName ?? "",
    phone: draft.phone ?? "",
    nationalId: draft.nationalId ?? "",
    address: draft.address ?? "",
    registrationNumber: draft.registrationNumber ?? "",
    specialization: draft.specialization ?? "",
    departmentId: draft.departmentId ?? "",
    yearsExperience:
      draft.yearsExperience === null || draft.yearsExperience === undefined
        ? ""
        : String(draft.yearsExperience),
    previousHospital: draft.previousHospital ?? "",
    consultationFee:
      draft.consultationFee === null || draft.consultationFee === undefined
        ? ""
        : String(draft.consultationFee),
    qualifications: (draft.qualifications ?? []).map((value) => newQualification(value)),
    availability: draft.availability,
  };
}

/**
 * An empty field is absent, not an empty string.
 *
 * The server describes a name, a registration number and a specialization as
 * "two characters or more, or nothing at all". Sending `""` satisfies neither,
 * so every autosave from a half-filled form came back 422 — which is exactly
 * what a draft save must never do, since the whole point is that the form is
 * incomplete while you are filling it in.
 */
function textOrNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function numberOrNull(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

export function toDraft(form: FormState): DoctorApplicationDraft {
  return {
    fullName: textOrNull(form.fullName),
    phone: textOrNull(form.phone),
    nationalId: textOrNull(form.nationalId),
    address: textOrNull(form.address),
    registrationNumber: textOrNull(form.registrationNumber),
    specialization: textOrNull(form.specialization),
    departmentId: textOrNull(form.departmentId),
    qualifications: form.qualifications
      .map((item) => item.value.trim())
      .filter((value) => value.length > 0),
    yearsExperience: numberOrNull(form.yearsExperience),
    previousHospital: textOrNull(form.previousHospital),
    consultationFee: numberOrNull(form.consultationFee),
    availability: form.availability,
  };
}

/**
 * What is still blank, and which step to go and fill it in on.
 *
 * Advisory, not a gate: the server owns what "complete" means, and the review
 * step shows this list rather than disabling the button, so nobody is left
 * guessing at a control that will not press.
 */
export function missingFields(form: FormState): Array<{ step: number; label: [string, string] }> {
  const missing: Array<{ step: number; label: [string, string] }> = [];
  if (!form.fullName.trim()) missing.push({ step: 0, label: ["Full name", "Poora naam"] });
  if (!form.phone.trim()) missing.push({ step: 0, label: ["Phone number", "Phone number"] });
  if (!form.nationalId.trim())
    missing.push({ step: 0, label: ["National ID (CNIC)", "Shanakhti card (CNIC)"] });
  if (!form.registrationNumber.trim())
    missing.push({ step: 1, label: ["Registration number", "Registration number"] });
  if (!form.specialization.trim())
    missing.push({ step: 1, label: ["Specialization", "Specialization"] });
  return missing;
}

// ---------------------------------------------------------------------------
// Shared step furniture
// ---------------------------------------------------------------------------

export function StepHeading({
  step,
  title,
  description,
  icon,
}: {
  step: number;
  title: string;
  description: string;
  icon: string;
}) {
  return (
    <header className="mb-6 flex items-start gap-3">
      <span
        aria-hidden
        className="bg-gradient-soft grid h-11 w-11 shrink-0 place-items-center rounded-xl text-primary"
      >
        <Icon name={icon} filled className="text-[22px]" />
      </span>
      <div className="min-w-0">
        <p className="mono-caps text-[10px] text-faint">
          {`0${step + 1}`.slice(-2)} / 05
        </p>
        <h2 className="font-display text-xl font-bold text-strong">{title}</h2>
        <p className="mt-1 text-sm text-muted">{description}</p>
      </div>
    </header>
  );
}

export interface StepProps {
  form: FormState;
  patch: (changes: Partial<FormState>) => void;
}

// ---------------------------------------------------------------------------
// 1 — Zaati maloomat
// ---------------------------------------------------------------------------

export function StepIdentity({ form, patch }: StepProps) {
  const tr = useTr();
  return (
    <div>
      <StepHeading
        step={0}
        icon="badge"
        title={tr("Personal details", "Zaati maloomat")}
        description={tr(
          "Your name exactly as it appears on your national ID.",
          "Aap ka naam bilkul waise jaise shanakhti card par hai.",
        )}
      />
      <div className="grid gap-5 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <Field
            label={tr("Full name", "Poora naam")}
            htmlFor="application-full-name"
            hint={tr("As printed on your CNIC.", "Jaise CNIC par likha hai.")}
          >
            <Input
              id="application-full-name"
              autoComplete="name"
              maxLength={120}
              value={form.fullName}
              onChange={(event) => patch({ fullName: event.target.value })}
            />
          </Field>
        </div>

        <Field
          label={tr("Phone number", "Phone number")}
          htmlFor="application-phone"
          hint={tr("We call this number about your visit times.", "Visit ke waqt ke liye isi par raabta hoga.")}
        >
          <Input
            id="application-phone"
            type="tel"
            autoComplete="tel"
            maxLength={32}
            placeholder="+92 300 1234567"
            value={form.phone}
            onChange={(event) => patch({ phone: event.target.value })}
          />
        </Field>

        <Field
          label={tr("National ID (CNIC)", "Shanakhti card (CNIC)")}
          htmlFor="application-national-id"
          hint={tr("13 digits, with or without dashes.", "13 ka adad, dashes ke saath ya baghair.")}
        >
          <Input
            id="application-national-id"
            inputMode="numeric"
            maxLength={20}
            placeholder="42101-1234567-1"
            className="font-mono"
            value={form.nationalId}
            onChange={(event) => patch({ nationalId: event.target.value })}
          />
        </Field>

        <div className="sm:col-span-2">
          <Field label={tr("Address", "Pata")} htmlFor="application-address">
            <Textarea
              id="application-address"
              rows={3}
              maxLength={400}
              autoComplete="street-address"
              value={form.address}
              onChange={(event) => patch({ address: event.target.value })}
            />
          </Field>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 2 — Professional details
// ---------------------------------------------------------------------------

export function StepProfessional({
  form,
  patch,
  departmentList,
  departmentsLoading,
}: StepProps & { departmentList: DepartmentOption[]; departmentsLoading: boolean }) {
  const tr = useTr();
  return (
    <div>
      <StepHeading
        step={1}
        icon="medical_information"
        title={tr("Professional details", "Professional details")}
        description={tr(
          "How you practise, and the registration an administrator will check.",
          "Aap ki practice, aur woh registration jo admin check karega.",
        )}
      />
      <div className="grid gap-5 sm:grid-cols-2">
        <Field
          label={tr("Registration number", "Registration number")}
          htmlFor="application-registration"
          hint={tr("Your council registration number.", "Aap ka council registration number.")}
        >
          <Input
            id="application-registration"
            maxLength={60}
            className="font-mono"
            value={form.registrationNumber}
            onChange={(event) => patch({ registrationNumber: event.target.value })}
          />
        </Field>

        <Field
          label={tr("Specialization", "Specialization")}
          htmlFor="application-specialization"
          hint={tr("For example, Cardiology.", "Maslan, Cardiology.")}
        >
          <Input
            id="application-specialization"
            maxLength={80}
            value={form.specialization}
            onChange={(event) => patch({ specialization: event.target.value })}
          />
        </Field>

        <Field
          label={tr("Department", "Department")}
          htmlFor="application-department"
          hint={
            departmentsLoading
              ? tr("Loading departments…", "Departments aa rahe hain…")
              : tr("An administrator can move you later.", "Admin baad mein badal sakta hai.")
          }
        >
          <Select
            id="application-department"
            value={form.departmentId}
            disabled={departmentsLoading}
            onChange={(event) => patch({ departmentId: event.target.value })}
          >
            <option value="">{tr("Not decided yet", "Abhi tay nahi")}</option>
            {departmentList.map((department) => (
              <option key={department.id} value={department.id}>
                {department.name}
              </option>
            ))}
          </Select>
        </Field>

        <Field label={tr("Years of experience", "Tajurbe ke saal")} htmlFor="application-years">
          <Input
            id="application-years"
            inputMode="numeric"
            maxLength={2}
            className="tabular-nums"
            value={form.yearsExperience}
            onChange={(event) =>
              patch({ yearsExperience: event.target.value.replace(/[^\d]/g, "") })
            }
          />
        </Field>

        <Field label={tr("Previous hospital", "Pichhla hospital")} htmlFor="application-hospital">
          <Input
            id="application-hospital"
            maxLength={120}
            value={form.previousHospital}
            onChange={(event) => patch({ previousHospital: event.target.value })}
          />
        </Field>

        <Field
          label={tr("Consultation fee", "Consultation fee")}
          htmlFor="application-fee"
          hint={tr("Per visit.", "Har visit ke liye.")}
        >
          <Input
            id="application-fee"
            inputMode="decimal"
            maxLength={9}
            className="tabular-nums"
            value={form.consultationFee}
            onChange={(event) =>
              patch({ consultationFee: event.target.value.replace(/[^\d.]/g, "") })
            }
          />
        </Field>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 3 — Qualifications
// ---------------------------------------------------------------------------

export function StepQualifications({ form, patch }: StepProps) {
  const tr = useTr();
  const reduced = useReducedMotion();
  const rows = form.qualifications;

  const add = () => {
    const created = newQualification();
    patch({ qualifications: [...rows, created] });
    // Focus lands on the new row once it has finished growing, so a keyboard
    // user keeps typing instead of hunting for the field that just appeared.
    // By id rather than by ref: `Input` is a plain function component and does
    // not forward one.
    window.setTimeout(() => {
      window.document.getElementById(`application-qualification-${created.id}`)?.focus();
    }, reduced ? 0 : 280);
  };

  const update = (id: string, value: string) => {
    patch({
      qualifications: rows.map((row) => (row.id === id ? { ...row, value } : row)),
    });
  };

  const remove = (id: string) => {
    patch({ qualifications: rows.filter((row) => row.id !== id) });
  };

  const filled = rows.filter((row) => row.value.trim().length > 0);

  return (
    <div>
      <StepHeading
        step={2}
        icon="school"
        title={tr("Qualifications", "Qualifications")}
        description={tr(
          "One per line — degrees, fellowships, certifications.",
          "Har line par ek — degrees, fellowships, certifications.",
        )}
      />

      {rows.length === 0 && (
        <EmptyState
          icon="school"
          title={tr("Nothing added yet", "Abhi kuchh nahi")}
          description={tr(
            "Add your MBBS first, then anything after it.",
            "Pehle apni MBBS likhein, phir us ke baad ki cheezein.",
          )}
        />
      )}

      <ul className="space-y-2">
        <AnimatePresence initial={false}>
          {rows.map((row, index) => (
            <motion.li
              key={row.id}
              initial={reduced ? { opacity: 0 } : { height: 0, opacity: 0 }}
              animate={reduced ? { opacity: 1 } : { height: "auto", opacity: 1 }}
              exit={reduced ? { opacity: 0 } : { height: 0, opacity: 0 }}
              transition={{ duration: reduced ? 0 : 0.25, ease: [0.16, 1, 0.3, 1] }}
              className="overflow-hidden"
            >
              <div className="flex items-center gap-2 pb-1">
                <span
                  aria-hidden
                  className="bg-gradient-soft grid h-9 w-9 shrink-0 place-items-center rounded-lg font-mono text-xs font-bold text-primary"
                >
                  {index + 1}
                </span>
                <Field
                  label={tr(`Qualification ${index + 1}`, `Qualification ${index + 1}`)}
                  htmlFor={`application-qualification-${row.id}`}
                >
                  <Input
                    id={`application-qualification-${row.id}`}
                    maxLength={120}
                    value={row.value}
                    onChange={(event) => update(row.id, event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        add();
                      }
                    }}
                  />
                </Field>
                <IconButton
                  label={tr(`Remove qualification ${index + 1}`, `Qualification ${index + 1} hatayein`)}
                  icon="close"
                  size="sm"
                  onClick={() => remove(row.id)}
                />
              </div>
            </motion.li>
          ))}
        </AnimatePresence>
      </ul>

      <Button variant="secondary" className="mt-4" onClick={add}>
        <Icon name="add" className="text-[20px]" />
        {tr("Add a qualification", "Qualification shamil karein")}
      </Button>

      {filled.length > 0 && (
        <div className="mt-6 border-t border-line pt-5">
          <p className="mono-caps mb-2 text-[10px] text-faint">
            {tr("How it will read", "Kaise nazar aayega")}
          </p>
          <ul className="flex flex-wrap gap-2">
            <AnimatePresence initial={false}>
              {filled.map((row) => (
                <motion.li
                  key={row.id}
                  layout={!reduced}
                  initial={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.9 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.9 }}
                  transition={{ duration: reduced ? 0 : 0.2 }}
                  className="border-gradient-fill rounded-full px-3 py-1 text-xs font-semibold text-strong"
                >
                  {row.value.trim()}
                </motion.li>
              ))}
            </AnimatePresence>
          </ul>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 5 — Review and submit
// ---------------------------------------------------------------------------

function SummarySection({
  title,
  icon,
  onEdit,
  editLabel,
  children,
}: {
  title: string;
  icon: string;
  onEdit: () => void;
  editLabel: string;
  children: ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-line bg-sunken/50 p-5">
      <header className="mb-4 flex items-center gap-2">
        <Icon name={icon} filled className="text-[20px] text-primary" />
        <h3 className="font-display text-base font-bold text-strong">{title}</h3>
        <button
          type="button"
          onClick={onEdit}
          className="ml-auto inline-flex min-h-9 items-center gap-1 rounded-full px-3 text-sm font-semibold text-primary transition-colors hover:bg-gradient-soft focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
        >
          <Icon name="edit" className="text-[17px]" />
          {editLabel}
        </button>
      </header>
      {children}
    </section>
  );
}

export function StepReview({
  form,
  documents,
  departmentName,
  consent,
  onConsentChange,
  onJump,
  submitting,
  onSubmit,
  submitError,
}: {
  form: FormState;
  documents: ApplicationDocument[];
  departmentName: string | null;
  consent: boolean;
  onConsentChange: (next: boolean) => void;
  onJump: (step: number) => void;
  submitting: boolean;
  onSubmit: () => void;
  submitError: ReactNode;
}) {
  const tr = useTr();
  const edit = tr("Edit", "Tabdeel");
  const missing = missingFields(form);
  const qualifications = form.qualifications
    .map((row) => row.value.trim())
    .filter((value) => value.length > 0);

  return (
    <div>
      <StepHeading
        step={4}
        icon="fact_check"
        title={tr("Review & submit", "Dekh kar bhejein")}
        description={tr(
          "Read it once. After you send it, an administrator reviews it.",
          "Ek baar parh lein. Bhejne ke baad admin ise review karega.",
        )}
      />

      {missing.length > 0 && (
        <div
          role="status"
          className="mb-5 rounded-2xl border border-warning/40 bg-warning-soft p-4 text-sm"
        >
          <p className="flex items-center gap-2 font-semibold text-warning">
            <Icon name="warning" filled className="text-[20px]" />
            {tr("Some things are still blank", "Kuchh cheezein abhi khaali hain")}
          </p>
          <ul className="mt-2 flex flex-wrap gap-2">
            {missing.map((item) => (
              <li key={item.label[0]}>
                <button
                  type="button"
                  onClick={() => onJump(item.step)}
                  className="rounded-full border border-warning/40 bg-card px-3 py-1 text-xs font-semibold text-strong transition-colors hover:border-warning focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                >
                  {tr(...item.label)}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="space-y-4">
        <SummarySection
          title={tr("Personal details", "Zaati maloomat")}
          icon="badge"
          onEdit={() => onJump(0)}
          editLabel={edit}
        >
          <dl className="grid gap-4 sm:grid-cols-2">
            <SummaryField label={tr("Full name", "Poora naam")} value={form.fullName.trim()} />
            <SummaryField label={tr("Phone", "Phone")} value={form.phone.trim()} mono />
            <SummaryField
              label={tr("National ID", "Shanakhti card")}
              value={form.nationalId.trim()}
              mono
            />
            <SummaryField label={tr("Address", "Pata")} value={form.address.trim()} />
          </dl>
        </SummarySection>

        <SummarySection
          title={tr("Professional details", "Professional details")}
          icon="medical_information"
          onEdit={() => onJump(1)}
          editLabel={edit}
        >
          <dl className="grid gap-4 sm:grid-cols-2">
            <SummaryField
              label={tr("Registration number", "Registration number")}
              value={form.registrationNumber.trim()}
              mono
            />
            <SummaryField
              label={tr("Specialization", "Specialization")}
              value={form.specialization.trim()}
            />
            <SummaryField label={tr("Department", "Department")} value={departmentName ?? ""} />
            <SummaryField
              label={tr("Years of experience", "Tajurbe ke saal")}
              value={form.yearsExperience.trim()}
              mono
            />
            <SummaryField
              label={tr("Previous hospital", "Pichhla hospital")}
              value={form.previousHospital.trim()}
            />
            <SummaryField
              label={tr("Consultation fee", "Consultation fee")}
              value={form.consultationFee.trim()}
              mono
            />
          </dl>
        </SummarySection>

        <SummarySection
          title={tr("Qualifications", "Qualifications")}
          icon="school"
          onEdit={() => onJump(2)}
          editLabel={edit}
        >
          {qualifications.length === 0 ? (
            <p className="text-sm italic text-faint">{tr("None added", "Koi nahi")}</p>
          ) : (
            <ul className="flex flex-wrap gap-2">
              {qualifications.map((value, index) => (
                <li
                  key={`${value}-${index}`}
                  className="border-gradient-fill rounded-full px-3 py-1 text-xs font-semibold text-strong"
                >
                  {value}
                </li>
              ))}
            </ul>
          )}
        </SummarySection>

        <SummarySection
          title={tr("Documents", "Documents")}
          icon="folder_open"
          onEdit={() => onJump(3)}
          editLabel={edit}
        >
          <ul className="space-y-2">
            {Object.entries(KIND_META).map(([kind, meta]) => {
              const uploaded = documents.filter((document) => document.kind === kind);
              return (
                <li key={kind} className="flex items-center gap-2 text-sm">
                  <Icon
                    name={uploaded.length > 0 ? "check_circle" : "radio_button_unchecked"}
                    filled={uploaded.length > 0}
                    className={cx(
                      "text-[18px]",
                      uploaded.length > 0 ? "text-stable" : "text-faint",
                    )}
                  />
                  <span className="text-strong">{tr(...meta.label)}</span>
                  <span className="ml-auto font-mono text-xs text-muted">
                    {uploaded.length > 0
                      ? tr(
                          `${uploaded.length} file${uploaded.length === 1 ? "" : "s"}`,
                          `${uploaded.length} file`,
                        )
                      : tr("none", "koi nahi")}
                  </span>
                </li>
              );
            })}
          </ul>
        </SummarySection>
      </div>

      <div className="mt-6 rounded-2xl border border-line bg-card p-5">
        <Checkbox
          checked={consent}
          onChange={(event) => onConsentChange(event.target.checked)}
          label={
            <span className="text-sm text-strong">
              {tr(
                "I confirm that everything above is true, and that the documents I uploaded are mine.",
                "Main tasdeeq karta hoon ke upar sab kuchh sach hai, aur jo documents maine upload kiye woh mere hain.",
              )}
            </span>
          }
        />
        {submitError}
        <Button
          size="lg"
          className="mt-5 w-full sm:w-auto"
          disabled={!consent || submitting}
          loading={submitting}
          onClick={onSubmit}
        >
          <Icon name="send" className="text-[20px]" />
          {tr("Send my application", "Meri darkhwast bhejein")}
        </Button>
        {!consent && (
          <p className="mt-2 text-xs text-muted">
            {tr(
              "Tick the box above to send it.",
              "Bhejne ke liye upar wala box tick karein.",
            )}
          </p>
        )}
      </div>
    </div>
  );
}
