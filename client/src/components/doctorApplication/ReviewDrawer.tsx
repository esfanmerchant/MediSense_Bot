"use client";

/**
 * The administrator's read of one application.
 *
 * The five sections are the doctor's own five steps, in the same order and
 * under the same names, so a reviewer and an applicant can talk about "step
 * two" and mean the same thing. Each collapses, because a reviewer checking
 * twenty registration numbers wants the other four sections out of the way.
 *
 * Two decisions leave this panel, and both are deliberately two-step: an
 * approval opens someone's account, and a refusal must carry a reason the
 * applicant can act on. Neither is a thing to do by mis-click.
 */

import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useCallback, useEffect, useId, useState } from "react";

import { Icon } from "@/components/Icon";
import { Dialog, Drawer, useToast } from "@/components/overlays";
import { Avatar, Button, Checkbox, Loading, Textarea, cx } from "@/components/ui";
import {
  ApiError,
  doctorRequests,
  type ApplicationDocument,
  type DoctorApplication,
} from "@/lib/api";
import { useTr } from "@/lib/lang";

import {
  DOCUMENT_KINDS,
  DocumentLightbox,
  DocumentThumb,
  KIND_META,
  Notice,
  RelativeTime,
  StatusChip,
  SummaryField,
  formatDateTime,
  formatQualification,
  formatSize,
  useDocumentViewer,
  useEscapeShield,
  useThumbnails,
} from "@/components/doctorApplication/shared";

/** A section that folds away. Height is animated, so nothing ever jumps. */
function Section({
  title,
  icon,
  badge,
  defaultOpen = true,
  children,
}: {
  title: string;
  icon: string;
  badge?: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const reduced = useReducedMotion();
  const [open, setOpen] = useState(defaultOpen);
  const bodyId = useId();

  return (
    <section className="overflow-hidden rounded-2xl border border-line bg-card">
      <h3>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => setOpen((current) => !current)}
          className="flex w-full items-center gap-2.5 px-4 py-3.5 text-left transition-colors hover:bg-sunken/60 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary"
        >
          <Icon name={icon} filled className="shrink-0 text-[20px] text-primary" />
          <span className="min-w-0 flex-1 font-display text-[15px] font-bold text-strong">
            {title}
          </span>
          {badge && <span className="font-mono text-[11px] text-muted">{badge}</span>}
          <Icon
            name="expand_more"
            className={cx(
              "shrink-0 text-[20px] text-faint transition-transform duration-200",
              open && "rotate-180",
            )}
          />
        </button>
      </h3>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            key="body"
            id={bodyId}
            initial={reduced ? { opacity: 0 } : { height: 0, opacity: 0 }}
            animate={reduced ? { opacity: 1 } : { height: "auto", opacity: 1 }}
            exit={reduced ? { opacity: 0 } : { height: 0, opacity: 0 }}
            transition={{ duration: reduced ? 0 : 0.26, ease: [0.16, 1, 0.3, 1] }}
            className="overflow-hidden"
          >
            <div className="border-t border-line px-4 py-4">{children}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  );
}

export function ReviewDrawer({
  open,
  application,
  departmentName,
  onClose,
  onDecided,
}: {
  open: boolean;
  /** The row that was clicked. Rendered at once; refreshed from `get` behind it. */
  application: DoctorApplication | null;
  departmentName: string | null;
  onClose: () => void;
  onDecided: (result: DoctorApplication) => void;
}) {
  const tr = useTr();
  const toast = useToast();
  const [fetched, setFetched] = useState<{
    id: string;
    detail: DoctorApplication | null;
    error: string | null;
  } | null>(null);
  const [documents, setDocuments] = useState<ApplicationDocument[]>(
    application?.documents ?? [],
  );
  const [verifying, setVerifying] = useState<string | null>(null);
  const [notes, setNotes] = useState("");
  const [confirming, setConfirming] = useState<"approve" | "reject" | null>(null);
  const [reason, setReason] = useState("");
  const [reasonError, setReasonError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const applicationId = application?.id ?? null;
  // Only an answer about *this* application counts; the caller keys this
  // component by id, so there is nothing else to reconcile.
  const answer = fetched?.id === applicationId ? fetched : null;
  const detail = answer?.detail ?? null;
  const loadError = answer?.error ?? null;
  const loading = open && answer === null;
  const current = detail ?? application;

  // Fresh detail on open. The row already carries everything the list returns,
  // so the panel is readable immediately and only sharpens when this lands.
  useEffect(() => {
    if (!open || !applicationId) return;
    let cancelled = false;
    void doctorRequests
      .get(applicationId)
      .then((result) => {
        if (cancelled) return;
        setFetched({ id: applicationId, detail: result, error: null });
        setDocuments(result.documents ?? []);
      })
      .catch((caught: unknown) => {
        if (cancelled) return;
        setFetched({
          id: applicationId,
          detail: null,
          error:
            caught instanceof ApiError
              ? caught.message
              : "The application could not be opened.",
        });
      });
    return () => {
      cancelled = true;
    };
  }, [open, applicationId]);

  const resolveUrl = useCallback(
    (documentId: string) =>
      applicationId
        ? doctorRequests.documentUrl(applicationId, documentId)
        : Promise.reject(new ApiError("NOT_FOUND", "No application selected.", 404)),
    [applicationId],
  );

  const { urls } = useThumbnails(documents, resolveUrl);
  const viewer = useDocumentViewer(resolveUrl);

  // Escape belongs to the confirmation while one is open — not to the drawer
  // underneath it, which is holding the notes.
  useEscapeShield(confirming !== null, () => {
    if (!working) setConfirming(null);
  });

  const setVerified = async (document: ApplicationDocument, verified: boolean) => {
    if (!applicationId) return;
    setVerifying(document.id);
    // Optimistic: the tick is the reviewer's own action, and a checkbox that
    // waits for a round-trip feels broken.
    setDocuments((list) =>
      list.map((item) => (item.id === document.id ? { ...item, verified } : item)),
    );
    try {
      const updated = await doctorRequests.setDocumentVerified(
        applicationId,
        document.id,
        verified,
      );
      setDocuments((list) => list.map((item) => (item.id === updated.id ? updated : item)));
    } catch (caught) {
      setDocuments((list) =>
        list.map((item) =>
          item.id === document.id ? { ...item, verified: document.verified } : item,
        ),
      );
      toast.show({
        tone: "critical",
        title: tr("That did not save", "Woh save nahi hua"),
        body: caught instanceof ApiError ? caught.message : undefined,
      });
    } finally {
      setVerifying(null);
    }
  };

  const decide = async (kind: "approve" | "reject") => {
    if (!applicationId || !current) return;
    if (kind === "reject" && reason.trim().length === 0) {
      setReasonError(
        tr(
          "Write the reason. The applicant is shown it word for word.",
          "Wajah likhein. Applicant ko yehi lafz ba lafz dikhaayi jaye gi.",
        ),
      );
      return;
    }
    setWorking(true);
    setActionError(null);
    try {
      const result =
        kind === "approve"
          ? await doctorRequests.approve(applicationId, {
              notes: notes.trim() || undefined,
            })
          : await doctorRequests.reject(applicationId, {
              reason: reason.trim(),
              notes: notes.trim() || undefined,
            });
      const name = result.applicant?.name ?? result.fullName ?? "";
      toast.show({
        tone: kind === "approve" ? "success" : "info",
        title:
          kind === "approve"
            ? tr("Approved", "Manzoor kar di")
            : tr("Rejected", "Na-manzoor kar di"),
        body:
          kind === "approve"
            ? tr(`${name} can sign in now.`, `${name} ab sign in kar sakte hain.`)
            : tr(`${name} has been told why.`, `${name} ko wajah bata di gayi hai.`),
      });
      setConfirming(null);
      onDecided(result);
      onClose();
    } catch (caught) {
      setActionError(
        caught instanceof ApiError
          ? caught.message
          : tr("That could not be recorded.", "Woh darj nahi ho saka."),
      );
    } finally {
      setWorking(false);
    }
  };

  const name = current?.applicant?.name ?? current?.fullName ?? "";
  const verifiedCount = documents.filter((document) => document.verified).length;
  const decided = current?.status === "APPROVED" || current?.status === "REJECTED";

  return (
    <>
      <Drawer
        open={open}
        onClose={onClose}
        width={560}
        title={tr("Review application", "Darkhwast ka jaiza")}
        description={
          current?.registrationNumber
            ? tr(
                `Registration ${current.registrationNumber}`,
                `Registration ${current.registrationNumber}`,
              )
            : undefined
        }
        footer={
          current && !decided ? (
            <div className="flex w-full flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  setReasonError(null);
                  setConfirming("reject");
                }}
                className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-critical/50 px-4 text-base font-semibold text-critical transition-[background-color,transform] hover:bg-critical-soft active:scale-[0.98] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-critical"
              >
                <Icon name="cancel" className="text-[20px]" />
                {tr("Reject", "Na-manzoor")}
              </button>
              <Button className="ml-auto" onClick={() => setConfirming("approve")}>
                <Icon name="check_circle" className="text-[20px]" />
                {tr("Approve", "Manzoor karein")}
              </Button>
            </div>
          ) : undefined
        }
      >
        {!current ? (
          <Loading label={tr("Opening", "Khul raha hai")} />
        ) : (
          <>
            {/* Who is being reviewed, pinned while the panel scrolls. */}
            <div className="sticky -top-5 z-10 -mx-5 -mt-5 mb-5 flex items-center gap-3 border-b border-line bg-card/95 px-5 py-4 backdrop-blur">
              <Avatar name={name || "?"} size="lg" />
              <div className="min-w-0 flex-1">
                <p className="truncate font-display text-lg font-bold text-strong">
                  {name || tr("Unnamed applicant", "Naam nahi diya")}
                </p>
                <p className="truncate text-sm text-muted">
                  {current.specialization || tr("No specialization given", "Specialization nahi di")}
                </p>
                {current.applicant?.email && (
                  <p className="truncate font-mono text-[11px] text-faint">
                    {current.applicant.email}
                    {current.applicant.emailVerified === false && (
                      <span className="ml-1 text-warning">
                        {tr("(email not verified)", "(email tasdeeq shuda nahi)")}
                      </span>
                    )}
                  </p>
                )}
              </div>
              <StatusChip status={current.status} />
            </div>

            {loading && !detail && (
              <p className="mb-4 font-mono text-[11px] text-faint">
                {tr("Refreshing…", "Taza ho raha hai…")}
              </p>
            )}

            {loadError && (
              <div className="mb-4">
                <Notice tone="warning" icon="cloud_off" title={tr("Showing the list's copy", "List wali copy dikh rahi hai")}>
                  <p>{loadError}</p>
                </Notice>
              </div>
            )}

            {current.status === "REJECTED" && (
              <div className="mb-4">
                <Notice
                  tone="critical"
                  icon="cancel"
                  title={tr("Already rejected", "Pehle hi na-manzoor")}
                >
                  <p>{current.rejectionReason ?? tr("No reason recorded.", "Wajah darj nahi.")}</p>
                </Notice>
              </div>
            )}

            <div className="space-y-3">
              <Section title={tr("Personal details", "Zaati maloomat")} icon="badge">
                <dl className="grid gap-4 sm:grid-cols-2">
                  <SummaryField label={tr("Full name", "Poora naam")} value={current.fullName} />
                  <SummaryField label={tr("Phone", "Phone")} value={current.phone} mono />
                  <SummaryField
                    label={tr("National ID", "Shanakhti card")}
                    value={current.nationalId}
                    mono
                  />
                  <SummaryField label={tr("Address", "Pata")} value={current.address} />
                </dl>
              </Section>

              <Section
                title={tr("Professional details", "Professional details")}
                icon="medical_information"
              >
                <dl className="grid gap-4 sm:grid-cols-2">
                  <SummaryField
                    label={tr("Registration number", "Registration number")}
                    value={current.registrationNumber}
                    mono
                  />
                  <SummaryField
                    label={tr("Specialization", "Specialization")}
                    value={current.specialization}
                  />
                  <SummaryField
                    label={tr("Department", "Department")}
                    value={departmentName ?? ""}
                  />
                  <SummaryField
                    label={tr("Years of experience", "Tajurbe ke saal")}
                    value={
                      current.yearsExperience === null || current.yearsExperience === undefined
                        ? ""
                        : String(current.yearsExperience)
                    }
                    mono
                  />
                  <SummaryField
                    label={tr("Previous hospital", "Pichhla hospital")}
                    value={current.previousHospital}
                  />
                  <SummaryField
                    label={tr("Consultation fee", "Consultation fee")}
                    value={
                      current.consultationFee === null || current.consultationFee === undefined
                        ? ""
                        : String(current.consultationFee)
                    }
                    mono
                  />
                </dl>
              </Section>

              <Section
                title={tr("Qualifications", "Qualifications")}
                icon="school"
                badge={String(current.qualifications?.length ?? 0)}
              >
                {(current.qualifications ?? []).length === 0 ? (
                  <p className="text-sm italic text-faint">{tr("None given", "Koi nahi")}</p>
                ) : (
                  <ul className="flex flex-wrap gap-2">
                    {/* Through the shared formatter, so the reviewer reads the
                        line exactly as the applicant saw it — years and all,
                        whichever shape the row was stored in. */}
                    {(current.qualifications ?? []).map(formatQualification).map((line, index) => (
                      <li
                        key={`${line}-${index}`}
                        className="border-gradient-fill rounded-full px-3 py-1 text-xs font-semibold text-strong"
                      >
                        {line}
                      </li>
                    ))}
                  </ul>
                )}
              </Section>

              <Section
                title={tr("Documents", "Documents")}
                icon="folder_open"
                badge={`${verifiedCount}/${documents.length}`}
              >
                {documents.length === 0 ? (
                  <p className="text-sm italic text-faint">
                    {tr("Nothing was uploaded.", "Kuchh upload nahi kiya gaya.")}
                  </p>
                ) : (
                  <ul className="grid gap-3 sm:grid-cols-2">
                    {DOCUMENT_KINDS.flatMap((kind) =>
                      documents
                        .filter((document) => document.kind === kind)
                        .map((document) => (
                          <li
                            key={document.id}
                            className={cx(
                              "rounded-xl border p-3 transition-colors",
                              document.verified
                                ? "border-stable/40 bg-stable-soft/40"
                                : "border-line bg-sunken/50",
                            )}
                          >
                            <button
                              type="button"
                              onClick={() => void viewer.open(document)}
                              disabled={viewer.opening === document.id}
                              className="group flex w-full items-start gap-3 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                            >
                              <span className="relative">
                                <DocumentThumb
                                  document={document}
                                  url={urls[document.id]}
                                  className="h-16 w-16"
                                />
                                <span
                                  aria-hidden
                                  className="absolute inset-0 grid place-items-center rounded-xl bg-navy-deep/50 text-white opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
                                >
                                  <Icon name="zoom_in" className="text-[22px]" />
                                </span>
                              </span>
                              <span className="min-w-0 flex-1">
                                <span className="mono-caps block text-[9.5px] text-faint">
                                  {tr(...KIND_META[document.kind].label)}
                                </span>
                                <span
                                  className="mt-0.5 block truncate text-sm font-semibold text-strong"
                                  title={document.fileName}
                                >
                                  {document.fileName}
                                </span>
                                <span className="block font-mono text-[10.5px] text-muted">
                                  {formatSize(document.fileSize)} ·{" "}
                                  <RelativeTime iso={document.uploadedAt} />
                                </span>
                              </span>
                            </button>
                            <div className="mt-3 border-t border-line/70 pt-2">
                              <Checkbox
                                checked={document.verified}
                                disabled={verifying === document.id || decided}
                                onChange={(event) =>
                                  void setVerified(document, event.target.checked)
                                }
                                label={
                                  <span
                                    className={cx(
                                      "text-xs font-semibold",
                                      document.verified ? "text-stable" : "text-muted",
                                    )}
                                  >
                                    {tr("Verified", "Tasdeeq shuda")}
                                  </span>
                                }
                              />
                            </div>
                          </li>
                        )),
                    )}
                  </ul>
                )}
              </Section>

              <Section title={tr("Review", "Jaiza")} icon="fact_check">
                <dl className="mb-4 grid gap-4 sm:grid-cols-2">
                  <SummaryField
                    label={tr("Submitted", "Bheji gayi")}
                    value={current.submittedAt ? formatDateTime(current.submittedAt) : ""}
                  />
                  <SummaryField
                    label={tr("Reviewed", "Review hui")}
                    value={current.reviewedAt ? formatDateTime(current.reviewedAt) : ""}
                  />
                </dl>
                <label
                  htmlFor="review-notes"
                  className="mono-caps mb-1.5 block text-[10px] text-faint"
                >
                  {tr("Notes", "Notes")}
                </label>
                <Textarea
                  id="review-notes"
                  rows={3}
                  maxLength={1000}
                  value={notes}
                  disabled={decided}
                  onChange={(event) => setNotes(event.target.value)}
                  placeholder={tr(
                    "Kept with the decision. Not shown as the refusal reason.",
                    "Faisle ke saath mehfooz rehta hai. Yeh na-manzoori ki wajah nahi.",
                  )}
                />
                {current.reviewNotes && (
                  <p className="mt-3 rounded-xl bg-sunken p-3 text-sm text-muted">
                    <span className="mono-caps mr-2 text-[10px] text-faint">
                      {tr("Earlier note", "Pichhla note")}
                    </span>
                    {current.reviewNotes}
                  </p>
                )}
              </Section>
            </div>

            {actionError && (
              <div className="mt-4">
                <Notice tone="critical" icon="error" title={tr("Not recorded", "Darj nahi hua")}>
                  <p>{actionError}</p>
                </Notice>
              </div>
            )}

            {decided && (
              <p className="mt-4 text-center text-sm text-muted">
                {tr(
                  "This application has already been decided.",
                  "Is darkhwast ka faisla ho chuka hai.",
                )}
              </p>
            )}
          </>
        )}
      </Drawer>

      <Dialog
        open={confirming === "approve"}
        onClose={() => setConfirming(null)}
        icon="check_circle"
        title={tr("Approve this doctor?", "Is doctor ko manzoor karein?")}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirming(null)}>
              {tr("Cancel", "Rehne dein")}
            </Button>
            <Button loading={working} onClick={() => void decide("approve")}>
              <Icon name="check_circle" className="text-[20px]" />
              {tr("Yes, approve", "Haan, manzoor karein")}
            </Button>
          </>
        }
      >
        <p className="text-sm text-strong">
          {tr(
            `Dr. ${name} will be emailed and will be able to sign in.`,
            `Dr. ${name} ko email bhej di jayegi aur woh login kar sakenge.`,
          )}
        </p>
        {documents.length > 0 && verifiedCount < documents.length && (
          <p className="mt-3 flex items-start gap-2 rounded-xl border border-warning/40 bg-warning-soft px-3 py-2 text-sm text-warning">
            <Icon name="warning" filled className="mt-px shrink-0 text-[18px]" />
            {tr(
              `${documents.length - verifiedCount} document(s) are not ticked as verified.`,
              `${documents.length - verifiedCount} document abhi tasdeeq shuda nahi.`,
            )}
          </p>
        )}
      </Dialog>

      <Dialog
        open={confirming === "reject"}
        onClose={() => setConfirming(null)}
        icon="cancel"
        /* Not "Reject this application?" — asking again after the reviewer has
           already pressed Reject is a step that decides nothing. What this panel
           is for is the reason, which is required, is emailed to the applicant,
           and is the only part a person still has to supply. So it is titled as
           the task it is, and the button below sends it. */
        title={tr("Reason for rejecting", "Na-manzoori ki wajah")}
        description={tr(
          "The applicant is emailed this, and they can apply again.",
          "Yeh applicant ko email ki jati hai, aur woh dobara apply kar sakte hain.",
        )}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirming(null)}>
              {tr("Cancel", "Rehne dein")}
            </Button>
            <Button variant="danger" loading={working} onClick={() => void decide("reject")}>
              <Icon name="send" className="text-[20px]" />
              {tr("Send rejection", "Na-manzoori bhejein")}
            </Button>
          </>
        }
      >
        <label htmlFor="reject-reason" className="mono-caps mb-1.5 block text-[10px] text-faint">
          {tr("Reason", "Wajah")}
        </label>
        <Textarea
          id="reject-reason"
          rows={4}
          autoFocus
          maxLength={600}
          invalid={Boolean(reasonError)}
          aria-describedby={reasonError ? "reject-reason-error" : undefined}
          value={reason}
          onChange={(event) => {
            setReason(event.target.value);
            if (reasonError) setReasonError(null);
          }}
          placeholder={tr(
            "For example: the registration number does not match the certificate.",
            "Maslan: registration number certificate se mail nahi khata.",
          )}
        />
        {reasonError && (
          <p
            id="reject-reason-error"
            role="alert"
            className="pop-in mt-2 flex items-start gap-1 text-sm font-medium text-critical"
          >
            <Icon name="error" className="mt-px text-[16px]" />
            {reasonError}
          </p>
        )}
        {actionError && (
          <p role="alert" className="mt-2 text-sm font-medium text-critical">
            {actionError}
          </p>
        )}
      </Dialog>

      <AnimatePresence>
        {viewer.viewing && (
          <DocumentLightbox
            key="viewer"
            name={viewer.viewing.document.fileName}
            mimeType={viewer.viewing.document.mimeType}
            url={viewer.viewing.url}
            onClose={viewer.close}
          />
        )}
      </AnimatePresence>

      {viewer.error && (
        <div className="sr-only" role="alert">
          {viewer.error}
        </div>
      )}
    </>
  );
}
