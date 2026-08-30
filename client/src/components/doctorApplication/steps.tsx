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
import type {
  DoctorApplicationDraft,
  QualificationEntry,
  StoredApplicationDraft,
} from "@/lib/api";
import { useTr } from "@/lib/lang";

import {
  DOCUMENT_KINDS,
  KIND_META,
  SummaryField,
  formatQualification,
  normalizeQualification,
  type DepartmentOption,
} from "@/components/doctorApplication/shared";
import type { ApplicationDocument, ApplicationDocumentKind } from "@/lib/api";

// ---------------------------------------------------------------------------
// The form's own shape
// ---------------------------------------------------------------------------

/**
 * A qualification row carries an id the API never sees.
 *
 * Keying the rows by array index would make a removal animate the wrong row
 * out — React would reuse the element and only the text would change. An id
 * per row is what lets `AnimatePresence` collapse the row that actually left.
 *
 * The two years are text here for the same reason every other number in this
 * form is: "20" halfway through typing 2015 is not the year twenty.
 */
export interface Qualification {
  id: string;
  title: string;
  startYear: string;
  endYear: string;
}

let qualificationSeq = 0;
export function newQualification(
  init: { title?: string; startYear?: string; endYear?: string } = {},
): Qualification {
  qualificationSeq += 1;
  return {
    id: `q${qualificationSeq}`,
    title: init.title ?? "",
    startYear: init.startYear ?? "",
    endYear: init.endYear ?? "",
  };
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

export function formFrom(draft: StoredApplicationDraft): FormState {
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
    // Tolerant of both shapes: a row stored before the years existed is a bare
    // string, and a page open across the deploy will read one written as the
    // other. `normalizeQualification` is the single place that decides.
    qualifications: (draft.qualifications ?? []).map((entry) => {
      const { title, startYear, endYear } = normalizeQualification(entry);
      return newQualification({
        title,
        startYear: startYear === null ? "" : String(startYear),
        endYear: endYear === null ? "" : String(endYear),
      });
    }),
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

/** No qualification predates it by any believable reading. */
export const QUALIFICATION_MIN_YEAR = 1950;

/** Seven years ahead: somebody enrolled this week has a passing year to come. */
export function qualificationMaxYear(now: Date = new Date()): number {
  return now.getFullYear() + 7;
}

/**
 * A year the server will store, or nothing — the same bargain `textOrNull`
 * strikes, for the same reason.
 *
 * The draft schema checks a year's range on every save, so a half-typed one
 * would be refused: "2", "20" and "201" all go past on the way to 2015, and a
 * debounce that fires on the pause between two keystrokes would turn typing a
 * date into "The draft is not saved". A year that is not yet a year therefore
 * travels as `null`. Nothing is lost on screen — the digits stay in the box,
 * marked, and are sent the moment they add up to a year.
 */
function plausibleYearOrNull(raw: string, now: Date): number | null {
  const year = numberOrNull(raw);
  if (year === null || !Number.isInteger(year)) return null;
  return year >= QUALIFICATION_MIN_YEAR && year <= qualificationMaxYear(now) ? year : null;
}

/**
 * One row as the API will hold it.
 *
 * The only conversion there is, so that "how it will read" and the review's
 * summary cannot promise a year the save does not actually send.
 */
export function qualificationEntry(
  row: Qualification,
  now: Date = new Date(),
): QualificationEntry {
  const startYear = plausibleYearOrNull(row.startYear, now);
  const endYear = plausibleYearOrNull(row.endYear, now);
  // The server refuses a pair that runs backwards, and there is no principled
  // half of it to keep, so neither goes until the correction is finished. Both
  // are still on screen, with the reason under them.
  const backwards = startYear !== null && endYear !== null && startYear > endYear;
  return {
    title: row.title.trim(),
    startYear: backwards ? null : startYear,
    endYear: backwards ? null : endYear,
  };
}

export function toDraft(form: FormState, now: Date = new Date()): DoctorApplicationDraft {
  return {
    fullName: textOrNull(form.fullName),
    phone: textOrNull(form.phone),
    nationalId: textOrNull(form.nationalId),
    address: textOrNull(form.address),
    registrationNumber: textOrNull(form.registrationNumber),
    specialization: textOrNull(form.specialization),
    departmentId: textOrNull(form.departmentId),
    // A row with no title is a row somebody started and abandoned, so it is not
    // sent at all. A year that was left blank is sent as `null`, like every
    // other blank here — the draft has to be storable while it is incomplete.
    qualifications: form.qualifications
      .filter((row) => row.title.trim().length > 0)
      .map((row) => qualificationEntry(row, now)),
    yearsExperience: numberOrNull(form.yearsExperience),
    previousHospital: textOrNull(form.previousHospital),
    consultationFee: numberOrNull(form.consultationFee),
    availability: form.availability,
  };
}

// ---------------------------------------------------------------------------
// What is not right yet
// ---------------------------------------------------------------------------

export interface QualificationYearIssue {
  /** Which box to mark. "both" when it is the pair, not one value, that is wrong. */
  field: "startYear" | "endYear" | "both";
  message: [string, string];
}

/**
 * What is wrong with one row's years, in the language of the person typing.
 *
 * Advisory only. It marks the box and says why, but it never blocks the save —
 * `plausibleYearOrNull` simply leaves the year behind until it is one, so the
 * draft goes on being stored while it is wrong. The server is the authority on
 * what may be submitted.
 */
export function qualificationYearIssue(
  row: Pick<Qualification, "startYear" | "endYear">,
  now: Date = new Date(),
): QualificationYearIssue | null {
  const max = qualificationMaxYear(now);
  const range: [string, string] = [
    `Enter a year between ${QUALIFICATION_MIN_YEAR} and ${max}.`,
    `${QUALIFICATION_MIN_YEAR} aur ${max} ke darmiyan ka saal likhein.`,
  ];
  const outOfRange = (raw: string): boolean => {
    if (raw.trim() === "") return false;
    const year = numberOrNull(raw);
    return (
      year === null ||
      !Number.isInteger(year) ||
      year < QUALIFICATION_MIN_YEAR ||
      year > max
    );
  };

  if (outOfRange(row.startYear)) return { field: "startYear", message: range };
  if (outOfRange(row.endYear)) return { field: "endYear", message: range };

  const start = numberOrNull(row.startYear);
  const end = numberOrNull(row.endYear);
  if (start !== null && end !== null && start > end) {
    return {
      field: "both",
      message: [
        "The start year cannot be after the passing year.",
        "Shuru ka saal paas hone ke saal ke baad ka nahi ho sakta.",
      ],
    };
  }
  return null;
}

/**
 * The document kinds with nothing uploaded against them.
 *
 * All four are required — the server refuses a submission that is short of one
 * — so this single answer feeds the Documents step's forward gate, the line
 * that says what is still needed, and the review's list of unfinished business.
 * The order is the order of the boxes on screen, so the sentence a person reads
 * matches what they are looking at.
 */
export function missingDocumentKinds(
  documents: ApplicationDocument[],
): ApplicationDocumentKind[] {
  return DOCUMENT_KINDS.filter((kind) => !documents.some((document) => document.kind === kind));
}

/**
 * What is still blank, and which step to go and fill it in on.
 *
 * Advisory, not a gate: the server owns what "complete" means, and the review
 * step shows this list rather than disabling the button, so nobody is left
 * guessing at a control that will not press.
 */
/**
 * The eight fields the server requires at submission, in the order it asks for
 * them.
 *
 * This list has to be the same list — `REQUIRED_FIELDS` in
 * `api/app/modules/doctor_applications/service.py`. Advisory here, authoritative
 * there: this one tells someone what is still outstanding so they can go and
 * fill it in, and if the two ever drift the review step says everything is
 * ready and the submit button then refuses for a reason nothing on screen
 * mentioned. Three of them — address, years of experience and the fee — were
 * missing from this list and were exactly that bug.
 */
const REQUIRED_FIELDS: Array<{
  step: number;
  label: [string, string];
  filled: (form: FormState) => boolean;
}> = [
  { step: 0, label: ["Full name", "Poora naam"], filled: (f) => Boolean(f.fullName.trim()) },
  { step: 0, label: ["Phone number", "Phone number"], filled: (f) => Boolean(f.phone.trim()) },
  {
    step: 0,
    label: ["National ID (CNIC)", "Shanakhti card (CNIC)"],
    filled: (f) => Boolean(f.nationalId.trim()),
  },
  { step: 0, label: ["Address", "Pata"], filled: (f) => Boolean(f.address.trim()) },
  {
    step: 1,
    label: ["Registration number", "Registration number"],
    filled: (f) => Boolean(f.registrationNumber.trim()),
  },
  {
    step: 1,
    label: ["Specialization", "Specialization"],
    filled: (f) => Boolean(f.specialization.trim()),
  },
  {
    step: 1,
    label: ["Years of experience", "Tajruba (saal)"],
    filled: (f) => Boolean(f.yearsExperience.trim()),
  },
  {
    step: 1,
    label: ["Consultation fee", "Consultation fee"],
    filled: (f) => Boolean(f.consultationFee.trim()),
  },
];

export function missingFields(form: FormState): Array<{ step: number; label: [string, string] }> {
  return REQUIRED_FIELDS.filter((field) => !field.filled(form)).map(({ step, label }) => ({
    step,
    label,
  }));
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

  const update = (id: string, changes: Partial<Omit<Qualification, "id">>) => {
    patch({
      qualifications: rows.map((row) => (row.id === id ? { ...row, ...changes } : row)),
    });
  };

  const remove = (id: string) => {
    patch({ qualifications: rows.filter((row) => row.id !== id) });
  };

  const filled = rows.filter((row) => row.title.trim().length > 0);

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
          {rows.map((row, index) => {
            const issue = qualificationYearIssue(row);
            return (
              <motion.li
                key={row.id}
                initial={reduced ? { opacity: 0 } : { height: 0, opacity: 0 }}
                animate={reduced ? { opacity: 1 } : { height: "auto", opacity: 1 }}
                exit={reduced ? { opacity: 0 } : { height: 0, opacity: 0 }}
                transition={{ duration: reduced ? 0 : 0.25, ease: [0.16, 1, 0.3, 1] }}
                className="overflow-hidden"
              >
                <div className="flex items-start gap-2 pb-1">
                  <span
                    aria-hidden
                    className="bg-gradient-soft mt-2 grid h-9 w-9 shrink-0 place-items-center rounded-lg font-mono text-xs font-bold text-primary"
                  >
                    {index + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="grid gap-2 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)]">
                      <Field
                        label={tr(`Qualification ${index + 1}`, `Qualification ${index + 1}`)}
                        htmlFor={`application-qualification-${row.id}`}
                      >
                        <Input
                          id={`application-qualification-${row.id}`}
                          maxLength={120}
                          value={row.title}
                          onChange={(event) => update(row.id, { title: event.target.value })}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") {
                              event.preventDefault();
                              add();
                            }
                          }}
                        />
                      </Field>
                      <Field
                        label={tr("Start year", "Shuru ka saal")}
                        htmlFor={`application-qualification-${row.id}-start`}
                      >
                        <Input
                          id={`application-qualification-${row.id}-start`}
                          inputMode="numeric"
                          maxLength={4}
                          placeholder="2015"
                          className="tabular-nums"
                          invalid={issue?.field === "startYear" || issue?.field === "both"}
                          value={row.startYear}
                          onChange={(event) =>
                            update(row.id, { startYear: event.target.value.replace(/[^\d]/g, "") })
                          }
                        />
                      </Field>
                      <Field
                        label={tr("Passing year", "Paas hone ka saal")}
                        htmlFor={`application-qualification-${row.id}-end`}
                      >
                        <Input
                          id={`application-qualification-${row.id}-end`}
                          inputMode="numeric"
                          maxLength={4}
                          placeholder="2020"
                          className="tabular-nums"
                          invalid={issue?.field === "endYear" || issue?.field === "both"}
                          value={row.endYear}
                          onChange={(event) =>
                            update(row.id, { endYear: event.target.value.replace(/[^\d]/g, "") })
                          }
                        />
                      </Field>
                    </div>
                    {issue && (
                      // Under the row rather than under one box: with two years
                      // the problem is often the pair, not either number.
                      <p
                        role="alert"
                        className="pop-in mt-1.5 flex items-start gap-1 px-1 text-sm font-medium text-critical"
                      >
                        <Icon name="error" className="mt-px shrink-0 text-[16px]" />
                        {tr(...issue.message)}
                      </p>
                    )}
                  </div>
                  <IconButton
                    label={tr(
                      `Remove qualification ${index + 1}`,
                      `Qualification ${index + 1} hatayein`,
                    )}
                    icon="close"
                    size="sm"
                    className="mt-2"
                    onClick={() => remove(row.id)}
                  />
                </div>
              </motion.li>
            );
          })}
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
                  {formatQualification(qualificationEntry(row))}
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
  /**
   * A missing document is missing in exactly the sense a blank field is, so it
   * queues in the same list with the same jump — to step four instead of step
   * one. The icon is what tells the two apart: "National ID (CNIC)" is both a
   * field and a file, and without it the same words would appear twice.
   */
  const missing: Array<{ key: string; step: number; label: [string, string]; icon?: string }> = [
    ...missingFields(form).map((item) => ({ ...item, key: `field-${item.label[0]}` })),
    ...missingDocumentKinds(documents).map((kind) => ({
      key: `document-${kind}`,
      step: 3,
      label: KIND_META[kind].label,
      icon: "folder_open",
    })),
  ];
  const qualifications = form.qualifications
    .filter((row) => row.title.trim().length > 0)
    .map((row) => ({ id: row.id, text: formatQualification(qualificationEntry(row)) }));

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
              <li key={item.key}>
                <button
                  type="button"
                  onClick={() => onJump(item.step)}
                  className="inline-flex items-center gap-1 rounded-full border border-warning/40 bg-card px-3 py-1 text-xs font-semibold text-strong transition-colors hover:border-warning focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                >
                  {item.icon && <Icon name={item.icon} className="text-[14px] text-warning" />}
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
              {qualifications.map((entry) => (
                <li
                  key={entry.id}
                  className="border-gradient-fill rounded-full px-3 py-1 text-xs font-semibold text-strong"
                >
                  {entry.text}
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
