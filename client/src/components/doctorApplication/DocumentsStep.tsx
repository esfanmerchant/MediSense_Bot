"use client";

/**
 * Step four: the proof.
 *
 * One dropzone per kind rather than one dropzone and a "what is it?" menu. The
 * kind is the question — a reviewer needs a registration certificate, a degree,
 * an ID and a photo — so asking it four times in four boxes removes the step
 * where somebody uploads the right file under the wrong label.
 *
 * Each file walks one path: idle → uploading (a ring, because the API reports
 * no progress and a fake bar would be a lie) → uploaded, with the image itself
 * as its thumbnail and a tick over the corner.
 */

import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useRef, useState, type DragEvent } from "react";

import { Icon } from "@/components/Icon";
import { Badge, IconButton, cx } from "@/components/ui";
import {
  ACCEPTED_UPLOAD_TYPES,
  ApiError,
  doctorApplication,
  type ApplicationDocument,
  type ApplicationDocumentKind,
} from "@/lib/api";
import { useTr } from "@/lib/lang";

import {
  DashedFrame,
  DOCUMENT_KINDS,
  DocumentLightbox,
  DocumentThumb,
  KIND_META,
  UploadRing,
  formatSize,
  useDocumentViewer,
  useThumbnails,
} from "@/components/doctorApplication/shared";
import { StepHeading, missingDocumentKinds } from "@/components/doctorApplication/steps";

/** A photograph is a photograph; the rest may be a scan or a PDF. */
function acceptFor(kind: ApplicationDocumentKind): string {
  return kind === "PHOTO" ? "image/jpeg,image/png,image/webp" : ACCEPTED_UPLOAD_TYPES;
}

type KindState = { uploading: boolean; error: string | null };

export function StepDocuments({
  documents,
  onUploaded,
  onRemoved,
}: {
  documents: ApplicationDocument[];
  onUploaded: (document: ApplicationDocument) => void;
  onRemoved: (documentId: string) => void;
}) {
  const tr = useTr();
  const reduced = useReducedMotion();
  const [states, setStates] = useState<Partial<Record<ApplicationDocumentKind, KindState>>>({});
  const [dragging, setDragging] = useState<ApplicationDocumentKind | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const inputs = useRef<Partial<Record<ApplicationDocumentKind, HTMLInputElement | null>>>({});

  const { urls, adopt } = useThumbnails(documents, doctorApplication.documentUrl);
  const viewer = useDocumentViewer(doctorApplication.documentUrl);

  // All four are required, and the server refuses a submission that is short of
  // one. Saying which ones are missing, here, is what keeps the disabled
  // Continue button from being a dead end.
  const missing = missingDocumentKinds(documents);
  const missingNames = missing.map((kind) => tr(...KIND_META[kind].label)).join(", ");

  const setState = (kind: ApplicationDocumentKind, next: Partial<KindState>) =>
    setStates((current) => ({
      ...current,
      [kind]: { uploading: false, error: null, ...current[kind], ...next },
    }));

  const upload = async (kind: ApplicationDocumentKind, file: File) => {
    setState(kind, { uploading: true, error: null });
    try {
      const uploaded = await doctorApplication.uploadDocument({ file, kind });
      // The browser already holds the bytes: the thumbnail is on screen before
      // a signed URL could have been fetched for it.
      adopt(uploaded.id, file);
      onUploaded(uploaded);
      setState(kind, { uploading: false, error: null });
    } catch (caught) {
      // The server's wording is specific — "the file's contents do not match
      // its type" tells someone exactly what to fix — so it is shown as sent.
      setState(kind, {
        uploading: false,
        error:
          caught instanceof ApiError ? caught.message : tr("Upload failed.", "Upload nahi hui."),
      });
    } finally {
      const input = inputs.current[kind];
      if (input) input.value = "";
    }
  };

  const remove = async (document: ApplicationDocument) => {
    setRemoving(document.id);
    try {
      await doctorApplication.removeDocument(document.id);
      onRemoved(document.id);
    } catch (caught) {
      setState(document.kind, {
        error:
          caught instanceof ApiError
            ? caught.message
            : tr("Could not remove that file.", "Woh file hataayi nahi ja saki."),
      });
    } finally {
      setRemoving(null);
    }
  };

  const onDrop = (kind: ApplicationDocumentKind) => (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(null);
    const dropped = event.dataTransfer.files?.[0];
    if (dropped) void upload(kind, dropped);
  };

  return (
    <div>
      <StepHeading
        step={3}
        icon="folder_open"
        title={tr("Documents", "Documents")}
        description={tr(
          "Clear scans or photographs. An administrator opens each one to check it.",
          "Saaf scan ya tasveer. Admin har ek ko khol kar check karta hai.",
        )}
      />

      <div className="grid gap-4 lg:grid-cols-2">
        {DOCUMENT_KINDS.map((kind) => {
          const meta = KIND_META[kind];
          const state = states[kind];
          const files = documents.filter((document) => document.kind === kind);
          const active = dragging === kind;

          return (
            <section
              key={kind}
              className={cx(
                "rounded-2xl border bg-card p-4 transition-colors",
                files.length > 0 ? "border-stable/40" : "border-line",
              )}
            >
              <header className="mb-3 flex items-start gap-3">
                <span
                  aria-hidden
                  className={cx(
                    "grid h-10 w-10 shrink-0 place-items-center rounded-xl",
                    files.length > 0
                      ? "bg-stable-soft text-stable"
                      : "bg-gradient-soft text-primary",
                  )}
                >
                  <Icon name={files.length > 0 ? "task_alt" : meta.icon} filled className="text-[21px]" />
                </span>
                <div className="min-w-0 flex-1">
                  <h3 className="font-display text-[15px] font-bold text-strong">
                    {tr(...meta.label)}
                  </h3>
                  <p className="text-xs text-muted">{tr(...meta.hint)}</p>
                </div>
                {files.length > 0 ? (
                  <Badge tone="good">
                    <Icon name="check" className="text-[13px]" />
                    {tr("Uploaded", "Ho gaya")}
                  </Badge>
                ) : (
                  // Neutral, not a warning: nothing is wrong yet on a form
                  // somebody has only just opened. It states the requirement.
                  <Badge tone="neutral">
                    <Icon name="asterisk" className="text-[13px]" />
                    {tr("Required", "Zaroori")}
                  </Badge>
                )}
              </header>

              <ul className="mb-3 space-y-2">
                <AnimatePresence initial={false}>
                  {files.map((document) => (
                    <motion.li
                      key={document.id}
                      initial={reduced ? { opacity: 0 } : { height: 0, opacity: 0 }}
                      animate={reduced ? { opacity: 1 } : { height: "auto", opacity: 1 }}
                      exit={reduced ? { opacity: 0 } : { height: 0, opacity: 0 }}
                      transition={{ duration: reduced ? 0 : 0.25, ease: [0.16, 1, 0.3, 1] }}
                      className="overflow-hidden"
                    >
                      <div className="flex items-center gap-3 rounded-xl bg-sunken/70 p-2">
                        <span className="relative">
                          <DocumentThumb document={document} url={urls[document.id]} />
                          <span
                            aria-hidden
                            className="pop-scale absolute -right-1.5 -top-1.5 grid h-5 w-5 place-items-center rounded-full bg-stable text-white shadow-sm"
                          >
                            <Icon name="check" className="text-[14px]" />
                          </span>
                        </span>
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-semibold text-strong" title={document.fileName}>
                            {document.fileName}
                          </p>
                          <p className="font-mono text-[11px] text-muted">
                            {formatSize(document.fileSize)}
                            {document.verified && (
                              <span className="ml-2 text-stable">
                                {tr("verified", "tasdeeq shuda")}
                              </span>
                            )}
                          </p>
                        </div>
                        <IconButton
                          label={tr(`View ${document.fileName}`, `${document.fileName} dekhein`)}
                          icon="visibility"
                          size="sm"
                          disabled={viewer.opening === document.id}
                          onClick={() => void viewer.open(document)}
                        />
                        <IconButton
                          label={tr(`Remove ${document.fileName}`, `${document.fileName} hatayein`)}
                          icon="delete"
                          size="sm"
                          disabled={removing === document.id}
                          onClick={() => void remove(document)}
                        />
                      </div>
                    </motion.li>
                  ))}
                </AnimatePresence>
              </ul>

              <div
                onDragOver={(event) => {
                  event.preventDefault();
                  if (dragging !== kind) setDragging(kind);
                }}
                onDragLeave={() => setDragging(null)}
                onDrop={onDrop(kind)}
                className={cx(
                  "group relative rounded-2xl transition-transform duration-200",
                  active && "scale-[1.01]",
                )}
              >
                <DashedFrame active={active} />
                <input
                  ref={(element) => {
                    inputs.current[kind] = element;
                  }}
                  id={`application-document-${kind}`}
                  type="file"
                  accept={acceptFor(kind)}
                  className="sr-only"
                  disabled={state?.uploading}
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) void upload(kind, file);
                  }}
                />
                <label
                  htmlFor={`application-document-${kind}`}
                  className={cx(
                    "flex min-h-[104px] cursor-pointer flex-col items-center justify-center gap-2 rounded-2xl px-4 py-5 text-center transition-colors",
                    active ? "bg-primary-soft/50" : "hover:bg-sunken/60",
                    state?.uploading && "cursor-progress",
                  )}
                >
                  {state?.uploading ? (
                    <UploadRing label={tr("Uploading…", "Upload ho rahi hai…")} />
                  ) : (
                    <motion.span
                      aria-hidden
                      animate={
                        active && !reduced ? { y: [0, -6, 0] } : { y: 0 }
                      }
                      transition={
                        active && !reduced
                          ? { duration: 0.6, repeat: Infinity, ease: "easeInOut" }
                          : { duration: 0.2 }
                      }
                      className="bg-gradient-soft grid h-11 w-11 place-items-center rounded-xl text-primary"
                    >
                      <Icon name="cloud_upload" filled className="text-[22px]" />
                    </motion.span>
                  )}
                  <span className="text-sm font-semibold text-strong">
                    {state?.uploading
                      ? tr("Uploading…", "Upload ho rahi hai…")
                      : active
                        ? tr("Drop it here", "Yahan chhor dein")
                        : files.length > 0
                          ? tr("Add another file", "Ek aur file lagayein")
                          : tr("Drop a file, or click to choose", "File chhorein, ya click karein")}
                  </span>
                  <span className="font-mono text-[10.5px] text-faint">
                    {kind === "PHOTO" ? "JPEG · PNG · WEBP" : "PDF · JPEG · PNG · WEBP · TIFF"}
                  </span>
                </label>
              </div>

              {state?.error && (
                <p
                  role="alert"
                  className="pop-in mt-3 flex items-start gap-2 rounded-xl border border-critical/50 bg-critical-soft px-3 py-2 text-sm font-medium text-critical"
                >
                  <Icon name="error" className="mt-px shrink-0 text-[17px]" />
                  {state.error}
                </p>
              )}
            </section>
          );
        })}
      </div>

      {viewer.error && (
        <p
          role="alert"
          className="pop-in mt-4 flex items-start gap-2 rounded-xl border border-critical/50 bg-critical-soft px-4 py-3 text-sm font-medium text-critical"
        >
          <Icon name="error" className="mt-px shrink-0 text-[18px]" />
          {viewer.error}
        </p>
      )}

      {/* Why the Continue button will not press. A live region, so finishing
          the last upload announces itself rather than silently unlocking. */}
      <div role="status" className="mt-5">
        {missing.length > 0 ? (
          <p className="flex items-start gap-2 rounded-xl border border-warning/40 bg-warning-soft px-4 py-3 text-sm font-medium text-warning">
            <Icon name="folder_open" className="mt-px shrink-0 text-[18px]" />
            <span>
              {tr(
                `All four documents are needed before you can continue. Still to upload: ${missingNames}.`,
                `Aage barhne se pehle chaaron documents darkaar hain. Abhi upload karni hain: ${missingNames}.`,
              )}
            </span>
          </p>
        ) : (
          <p className="flex items-center gap-2 px-1 text-sm font-medium text-strong">
            <span
              aria-hidden
              className="pop-scale grid h-5 w-5 shrink-0 place-items-center rounded-full bg-primary text-white"
            >
              <Icon name="check" className="text-[14px]" />
            </span>
            {tr("All four documents are here.", "Chaaron documents mojood hain.")}
          </p>
        )}
      </div>

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
    </div>
  );
}
