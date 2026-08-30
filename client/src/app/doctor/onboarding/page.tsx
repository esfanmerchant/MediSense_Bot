"use client";

/**
 * A doctor applying to join.
 *
 * Five steps, one draft, and no sidebar: until an administrator approves this
 * application there is nowhere else in the product to go, and a rail of links
 * that all refuse would be a menu of closed doors. What replaces it is the
 * stepper — the same five names on the left, on the review page, and in the
 * administrator's drawer, so everyone is talking about the same thing.
 *
 * The draft saves itself. Nothing here has a Save button, because a form that
 * can be lost by closing a tab is a form people fill in twice.
 */

import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import { Icon } from "@/components/Icon";
import { Stepper, SuccessPanel } from "@/components/forms";
import { Button, ErrorState, Loading, Unauthorized, cx } from "@/components/ui";
import {
  ApiError,
  doctorApplication,
  type ApplicationDocument,
  type ApplicationDocumentKind,
  type ApplicationStatus,
  type DoctorApplication,
} from "@/lib/api";
import { useTr } from "@/lib/lang";
import { useSession } from "@/lib/session";

import { StepDocuments } from "@/components/doctorApplication/DocumentsStep";
import {
  DraftIndicator,
  KIND_META,
  Notice,
  RedirectNotice,
  STEPS,
  SlimHeader,
  StepNav,
  useAutosave,
  useDepartments,
} from "@/components/doctorApplication/shared";
import {
  StepIdentity,
  StepProfessional,
  StepQualifications,
  StepReview,
  emptyForm,
  formFrom,
  missingDocumentKinds,
  toDraft,
  type FormState,
} from "@/components/doctorApplication/steps";

/**
 * Which step a server-side field error belongs to.
 *
 * A missing document comes back as one detail per kind, with the kind itself as
 * the field — `REGISTRATION_CERTIFICATE`, not `documents` — so each of the four
 * names has to lead back to step four on its own.
 */
/**
 * The name a person recognises, for a field the server named in its own terms.
 *
 * A missing photograph came back as `PHOTO` in monospace, which is a column
 * name, not a thing anyone uploaded. The document kinds already carry a
 * bilingual label beside their dropzone; this is the same one, so the error and
 * the box it points at say the same words. Anything unmapped falls back to the
 * server's name — an unfamiliar word beats no word.
 */
function fieldLabel(field: string, tr: (en: string, ur: string) => string): string {
  const kind = KIND_META[field as ApplicationDocumentKind];
  if (kind) return tr(...kind.label);
  const known: Record<string, [string, string]> = {
    fullName: ["Full name", "Poora naam"],
    phone: ["Phone number", "Phone number"],
    nationalId: ["National ID (CNIC)", "Shanakhti card (CNIC)"],
    address: ["Address", "Pata"],
    registrationNumber: ["Registration number", "Registration number"],
    specialization: ["Specialization", "Specialization"],
    departmentId: ["Department", "Department"],
    yearsExperience: ["Years of experience", "Tajruba (saal)"],
    previousHospital: ["Previous hospital", "Pichla hospital"],
    consultationFee: ["Consultation fee", "Consultation fee"],
    qualifications: ["Qualifications", "Taleemi liyaqat"],
    documents: ["Documents", "Documents"],
  };
  const label = known[field];
  return label ? tr(...label) : field;
}

const FIELD_STEP: Record<string, number> = {
  fullName: 0,
  phone: 0,
  nationalId: 0,
  address: 0,
  registrationNumber: 1,
  specialization: 1,
  departmentId: 1,
  yearsExperience: 1,
  previousHospital: 1,
  consultationFee: 1,
  qualifications: 2,
  documents: 3,
  REGISTRATION_CERTIFICATE: 3,
  DEGREE: 3,
  NATIONAL_ID: 3,
  PHOTO: 3,
};

export default function DoctorOnboardingPage() {
  const tr = useTr();
  const router = useRouter();
  const { user, loading, signOut } = useSession();

  useEffect(() => {
    if (!loading && !user) router.replace("/login");
  }, [loading, user, router]);

  return (
    <div className="flex min-h-screen flex-col">
      <SlimHeader onSignOut={() => void signOut()} />
      {loading ? (
        <main className="mx-auto w-full max-w-2xl px-4 py-20">
          <Loading label={tr("Checking your session", "Aap ka session check ho raha hai")} />
        </main>
      ) : !user ? null : user.role !== "DOCTOR" ? (
        <main id="main" className="mx-auto w-full max-w-2xl px-4 py-16">
          <Unauthorized
            message={tr(
              "This form is for doctors applying to join. Your account is signed in as something else.",
              "Yeh form un doctors ke liye hai jo shamil hona chahte hain. Aap kisi aur haisiyat se signed in hain.",
            )}
          />
        </main>
      ) : (
        <Wizard />
      )}
    </div>
  );
}

function Wizard() {
  const tr = useTr();
  const router = useRouter();
  const reduced = useReducedMotion();
  const departments = useDepartments();

  const [form, setForm] = useState<FormState>(emptyForm);
  const formRef = useRef<FormState>(form);
  const [documents, setDocuments] = useState<ApplicationDocument[]>([]);
  const [status, setStatus] = useState<ApplicationStatus>("DRAFT");
  const [rejection, setRejection] = useState<{ reason: string | null; notes: string | null } | null>(
    null,
  );
  const [step, setStep] = useState(0);
  const [consent, setConsent] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<ApiError | null>(null);
  const [sent, setSent] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [load, setLoad] = useState<{ ready: boolean; error: ApiError | null }>({
    ready: false,
    error: null,
  });
  const card = useRef<HTMLDivElement>(null);

  // The server's echo is not written back into the form: by the time it lands,
  // the form may already say something newer. Only what the form cannot know
  // about itself — its status — is taken from it.
  const onSaved = useCallback((saved: DoctorApplication) => {
    setStatus((current) => (current === saved.status ? current : saved.status));
  }, []);
  const autosave = useAutosave(onSaved);
  const { markSaved } = autosave;

  /**
   * The one load, and the only place the form is ever written from outside.
   *
   * Everything happens in the continuation rather than the effect body: a
   * synchronous setState here would re-render the whole wizard twice on every
   * mount for nothing.
   */
  useEffect(() => {
    let cancelled = false;
    void doctorApplication
      .mine()
      .then((loaded) => {
        if (cancelled) return;
        const next = formFrom(loaded);
        formRef.current = next;
        setForm(next);
        setDocuments(loaded.documents ?? []);
        setStatus(loaded.status);
        setRejection(
          loaded.status === "REJECTED"
            ? { reason: loaded.rejectionReason, notes: loaded.reviewNotes }
            : null,
        );
        // `updatedAt` is when this draft was last stored — the honest starting
        // value for "saved 3h ago".
        markSaved(new Date(loaded.updatedAt).getTime());
        setLoad({ ready: true, error: null });
      })
      .catch((caught: unknown) => {
        if (cancelled || (caught instanceof ApiError && caught.isAuthFailure)) return;
        setLoad({
          ready: false,
          error:
            caught instanceof ApiError
              ? caught
              : new ApiError("INTERNAL_ERROR", "Something went wrong.", 500),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [attempt, markSaved]);

  // An application already with a reviewer, or already through, does not belong
  // in an editable form.
  useEffect(() => {
    if (sent) return;
    if (status === "SUBMITTED") router.replace("/doctor/pending");
    else if (status === "APPROVED") router.replace("/doctor");
  }, [status, sent, router]);

  /**
   * The single way the form changes.
   *
   * The ref is written first and is what the auto-save reads, so a save that
   * is already in the air cannot swallow the letter typed while it flew.
   */
  const patch = useCallback(
    (changes: Partial<FormState>) => {
      const next = { ...formRef.current, ...changes };
      formRef.current = next;
      setForm(next);
      autosave.schedule(toDraft(next));
    },
    [autosave],
  );

  const goto = useCallback(
    (next: number) => {
      setStep(next);
      // A step boundary is a natural save point; do not wait out the debounce.
      void autosave.flush();
      card.current?.scrollIntoView({
        block: "start",
        behavior: reduced ? "auto" : "smooth",
      });
    },
    [autosave, reduced],
  );

  const submit = async () => {
    setSubmitting(true);
    setSubmitError(null);
    try {
      // Everything typed since the last save goes first: `submit` validates
      // what is stored, not what is on screen.
      await autosave.flush();
      const result = await doctorApplication.submit();
      setStatus(result.status);
      setSent(true);
    } catch (caught) {
      if (caught instanceof ApiError) setSubmitError(caught);
      else
        setSubmitError(
          new ApiError("INTERNAL_ERROR", tr("Something went wrong.", "Kuchh ghalat ho gaya."), 500),
        );
    } finally {
      setSubmitting(false);
    }
  };

  if (load.error) {
    return (
      <main id="main" className="mx-auto w-full max-w-2xl px-4 py-16">
        <ErrorState
          message={load.error.message}
          onRetry={() => {
            setLoad({ ready: false, error: null });
            setAttempt((value) => value + 1);
          }}
        />
      </main>
    );
  }

  if (!load.ready) {
    return (
      <main className="mx-auto w-full max-w-2xl px-4 py-20">
        <Loading label={tr("Opening your application", "Aap ki darkhwast khul rahi hai")} />
      </main>
    );
  }

  if (!sent && (status === "SUBMITTED" || status === "APPROVED")) {
    return (
      <RedirectNotice
        label={
          status === "APPROVED"
            ? tr("Taking you to your dashboard…", "Aap ko dashboard par le ja rahe hain…")
            : tr("Taking you to your application status…", "Aap ko status par le ja rahe hain…")
        }
      />
    );
  }

  if (sent) {
    return (
      <main id="main" className="mx-auto w-full max-w-2xl px-4 py-16">
        <div className="rounded-2xl border border-line bg-card p-8 shadow-card">
          <SuccessPanel
            title={tr("Your application has been sent", "Aap ki darkhwast bhej di gayi")}
            description={tr(
              "You will get an email once an administrator has reviewed it.",
              "Admin review ke baad aap ko email milegi.",
            )}
          >
            <Link
              href="/doctor/pending"
              className="btn-gradient inline-flex min-h-11 items-center gap-2 rounded-xl px-4 text-base font-semibold text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
            >
              <Icon name="hourglass_top" className="text-[20px]" />
              {tr("See the status", "Status dekhein")}
            </Link>
          </SuccessPanel>
        </div>
      </main>
    );
  }

  const stepperSteps = STEPS.map((entry) => ({
    label: tr(...entry.label),
    hint: tr(...entry.hint),
  }));

  return (
    <main id="main" className="mx-auto w-full max-w-[1180px] flex-1 px-4 py-8 sm:px-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="mono-caps text-[0.68rem] text-accent">
            {tr("Doctor registration", "Doctor registration")}
          </p>
          <h1 className="mt-1.5 font-display text-[1.75rem] font-bold leading-tight text-strong">
            {tr("Join MediSense", "MediSense mein shamil hon")}
          </h1>
          <p className="mt-2 max-w-2xl text-[15px] leading-relaxed text-muted">
            {tr(
              "Fill this in at your own pace — every change is saved as you go.",
              "Ise apni raftaar se bharein — har tabdeeli khud ba khud save hoti rehti hai.",
            )}
          </p>
        </div>
        <DraftIndicator autosave={autosave} onRetry={() => void autosave.flush()} />
      </div>

      {autosave.state === "error" && autosave.error && (
        <div className="mt-5">
          <Notice
            tone="warning"
            icon="cloud_off"
            title={tr("The draft is not saved", "Draft save nahi hua")}
          >
            <p>{autosave.error}</p>
            <p className="mt-1 text-xs">
              {tr(
                "What you typed is still here. It will be sent again on your next change.",
                "Jo aap ne likha hai woh yahin hai. Agli tabdeeli par dobara bheja jaye ga.",
              )}
            </p>
          </Notice>
        </div>
      )}

      {status === "REJECTED" && rejection && (
        <div className="mt-5">
          <Notice
            tone="critical"
            icon="cancel"
            title={tr("This application was not approved", "Yeh darkhwast manzoor nahi hui")}
          >
            <p className="font-semibold">
              {rejection.reason ?? tr("No reason was recorded.", "Koi wajah darj nahi ki gayi.")}
            </p>
            {rejection.notes && <p className="mt-1 text-muted">{rejection.notes}</p>}
            <p className="mt-2">
              {tr(
                "Correct what is wrong below and send it again.",
                "Neeche jo ghalat hai theek karein aur dobara bhejein.",
              )}
            </p>
          </Notice>
        </div>
      )}

      <div className="mt-6 grid gap-6 lg:grid-cols-[248px_1fr]">
        <aside className="lg:sticky lg:top-24 lg:self-start">
          <div className="rounded-2xl border border-line bg-card p-5 shadow-card">
            <p className="mono-caps mb-4 text-[10px] text-faint">
              {tr("Your progress", "Aap ki peshraft")}
            </p>
            <Stepper steps={stepperSteps} current={step} onJump={goto} orientation="vertical" />
          </div>
        </aside>

        <div
          ref={card}
          className="scroll-mt-24 rounded-2xl border border-line bg-card p-5 shadow-card sm:p-7"
        >
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={step}
              initial={reduced ? { opacity: 0 } : { opacity: 0, x: 16 }}
              animate={reduced ? { opacity: 1 } : { opacity: 1, x: 0 }}
              exit={reduced ? { opacity: 0 } : { opacity: 0, x: -16 }}
              transition={{ duration: reduced ? 0 : 0.22, ease: [0.16, 1, 0.3, 1] }}
            >
              {step === 0 && <StepIdentity form={form} patch={patch} />}
              {step === 1 && (
                <StepProfessional
                  form={form}
                  patch={patch}
                  departmentList={departments.list}
                  departmentsLoading={departments.loading}
                />
              )}
              {step === 2 && <StepQualifications form={form} patch={patch} />}
              {step === 3 && (
                <StepDocuments
                  documents={documents}
                  onUploaded={(uploaded) =>
                    setDocuments((current) => [
                      ...current.filter((document) => document.id !== uploaded.id),
                      uploaded,
                    ])
                  }
                  onRemoved={(id) =>
                    setDocuments((current) => current.filter((document) => document.id !== id))
                  }
                />
              )}
              {step === 4 && (
                <StepReview
                  form={form}
                  documents={documents}
                  departmentName={departments.nameFor(form.departmentId || null)}
                  consent={consent}
                  onConsentChange={setConsent}
                  onJump={goto}
                  submitting={submitting}
                  onSubmit={() => void submit()}
                  submitError={
                    submitError && (
                      <div className="mt-4">
                        <Notice
                          tone="critical"
                          icon="error"
                          title={tr("It could not be sent", "Bheji nahi ja saki")}
                          action={
                            submitError.details.length > 0 && (
                              <Button
                                variant="secondary"
                                onClick={() =>
                                  goto(FIELD_STEP[submitError.details[0].field ?? ""] ?? 0)
                                }
                              >
                                <Icon name="edit" className="text-[18px]" />
                                {tr("Go and fix it", "Jaa kar theek karein")}
                              </Button>
                            )
                          }
                        >
                          <p>{submitError.message}</p>
                          {submitError.details.length > 0 && (
                            <ul className="mt-2 list-disc space-y-1 pl-5">
                              {submitError.details.map((detail, index) => (
                                <li key={`${detail.field ?? "general"}-${index}`}>
                                  {detail.field && (
                                    <span className="font-semibold">{fieldLabel(detail.field, tr)}: </span>
                                  )}
                                  {detail.message}
                                </li>
                              ))}
                            </ul>
                          )}
                        </Notice>
                      </div>
                    )
                  }
                />
              )}
            </motion.div>
          </AnimatePresence>

          {step < 4 && (
            <StepNav
              onBack={step > 0 ? () => goto(step - 1) : undefined}
              onNext={() => goto(step + 1)}
              backLabel={tr("Back", "Peechhe")}
              nextLabel={
                step === 3 ? tr("Review", "Dekh lein") : tr("Continue", "Aage barhein")
              }
              // The one gate in the flow. All four documents are required, the
              // server refuses a submission without them, and the step itself
              // names what is still missing — so this button is never a dead
              // end, only the last thing that has not been earned yet.
              nextDisabled={step === 3 && missingDocumentKinds(documents).length > 0}
            />
          )}
          {step === 4 && (
            <div className={cx("mt-8 border-t border-line pt-6")}>
              <Button variant="ghost" onClick={() => goto(3)}>
                <Icon name="arrow_back" className="text-[20px]" />
                {tr("Back to documents", "Documents par wapas")}
              </Button>
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
