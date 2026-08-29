"use client";

/**
 * Upload and open medical documents.
 *
 * Opening a document is a two-step trip on purpose: the client asks the API for
 * a link, the API checks access and mints one that expires in minutes, and only
 * then does the browser follow it. There is no stored URL to leak, and a link
 * copied out of the address bar stops working shortly after (conflict C8).
 */

import { AnimatePresence, motion } from "framer-motion";
import { Fragment, useCallback, useEffect, useRef, useState, type DragEvent } from "react";

import { Icon } from "@/components/Icon";
import { OcrReview } from "@/components/OcrReview";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Field,
  IconButton,
  Input,
  Select,
  Skeleton,
  cx,
} from "@/components/ui";
import {
  ACCEPTED_UPLOAD_TYPES,
  ApiError,
  documents,
  type DocumentType,
  type MedicalDocument,
} from "@/lib/api";
import { useTr } from "@/lib/lang";
import { useAsync } from "@/lib/useAsync";

/** Types the engine can read. HEIC is stored but not machine-read. */
const READABLE = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/tiff",
]);

const TYPE_LABELS: Record<DocumentType, string> = {
  PRESCRIPTION: "Prescription",
  LAB_REPORT: "Lab report",
  BLOOD_TEST: "Blood test",
  MEDICAL_CERTIFICATE: "Medical certificate",
  REFERRAL_LETTER: "Referral letter",
  DISCHARGE_SUMMARY: "Discharge summary",
  IMAGING: "Imaging (X-ray, MRI, CT)",
  PROFILE_IMAGE: "Profile image",
  OTHER: "Other",
};

/** Types a person would choose when uploading; PROFILE_IMAGE is set elsewhere. */
const CHOOSABLE: DocumentType[] = [
  "PRESCRIPTION",
  "LAB_REPORT",
  "BLOOD_TEST",
  "IMAGING",
  "MEDICAL_CERTIFICATE",
  "REFERRAL_LETTER",
  "DISCHARGE_SUMMARY",
  "OTHER",
];

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

/** The icon a file wears, by what it is. */
function iconFor(mimeType: string): string {
  if (mimeType === "application/pdf") return "picture_as_pdf";
  if (mimeType.startsWith("image/")) return "image";
  return "description";
}

/** What the browser can show inline. TIFF and HEIC are stored, not rendered. */
function previewKind(mimeType: string): "image" | "pdf" | null {
  if (mimeType === "application/pdf") return "pdf";
  if (["image/jpeg", "image/png", "image/webp", "image/gif"].includes(mimeType)) return "image";
  return null;
}

export function DocumentsCard({
  patientId,
  canUpload = true,
  canRemove = true,
  canConfirmOcr = false,
  title = "Documents",
  description,
}: {
  patientId: string;
  canUpload?: boolean;
  canRemove?: boolean;
  /** Only a doctor may confirm an extracted prescription (spec §24). */
  canConfirmOcr?: boolean;
  title?: string;
  description?: string;
}) {
  const tr = useTr();
  const [refresh, setRefresh] = useState(0);
  const reload = useCallback(() => setRefresh((n) => n + 1), []);
  const list = useAsync(() => documents.list({ patientId, limit: 100 }), [patientId, refresh]);

  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState<MedicalDocument | null>(null);
  const [preview, setPreview] = useState<{ document: MedicalDocument; url: string } | null>(null);

  const open = async (document: MedicalDocument) => {
    setOpening(document.id);
    setError(null);
    try {
      const link = await documents.downloadUrl(document.id);
      setPreview({ document, url: link.url });
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Could not open that document.");
    } finally {
      setOpening(null);
    }
  };

  const remove = async (document: MedicalDocument) => {
    setError(null);
    try {
      await documents.remove(document.id);
      reload();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Could not remove that document.");
    }
  };

  return (
    <Card icon="folder_open" title={title} description={description}>
      {canUpload && <UploadForm patientId={patientId} onUploaded={reload} />}

      {list.loading && (
        <div role="status" aria-live="polite" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          <span className="sr-only">{tr("Loading documents", "Documents load ho rahe hain")}…</span>
          {Array.from({ length: 3 }, (_, index) => (
            <div key={index} aria-hidden className="rounded-2xl border border-line bg-card p-5">
              <div className="flex items-start gap-3">
                <Skeleton className="h-12 w-12 rounded-xl" />
                <div className="flex-1">
                  <Skeleton className="h-4 w-3/4" />
                  <Skeleton className="mt-2 h-3 w-1/2" />
                </div>
              </div>
              <Skeleton className="mt-5 h-10 w-full rounded-xl" />
            </div>
          ))}
        </div>
      )}
      {list.error && <ErrorState message={list.error.message} onRetry={list.reload} />}

      {error && (
        <p
          role="alert"
          className="pop-in mb-4 flex items-start gap-2 rounded-xl border border-critical/50 bg-critical-soft px-4 py-3 text-sm font-medium text-critical"
        >
          <Icon name="error" className="mt-px shrink-0 text-[18px]" />
          {error}
        </p>
      )}

      {list.data &&
        (list.data.data.length === 0 ? (
          <EmptyState
            icon="upload_file"
            title={tr("No documents yet", "Abhi koi document nahi")}
            description={tr(
              "Reports, prescriptions and scans appear here once uploaded.",
              "Reports, nuskhe aur scans upload hote hi yahan nazar aate hain.",
            )}
            action={
              canUpload && (
                <Button variant="secondary" onClick={() => window.document.getElementById("document-file")?.click()}>
                  <Icon name="cloud_upload" className="text-[20px]" />
                  {tr("Upload your first document", "Apni pehli document upload karein")}
                </Button>
              )
            }
          />
        ) : (
          <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {list.data.data.map((document) => (
              <Fragment key={document.id}>
                <li className="group hover-lift-sm pop-in flex flex-col gap-4 rounded-2xl border border-line bg-card p-5 shadow-card">
                  <div className="flex items-start gap-3">
                    <span
                      aria-hidden
                      className="bg-gradient-soft grid h-12 w-12 shrink-0 place-items-center rounded-xl text-primary"
                    >
                      <Icon name={iconFor(document.mimeType)} filled className="icon-wiggle text-[24px]" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p
                        className="truncate font-display text-base font-bold text-strong"
                        title={document.title || document.fileName}
                      >
                        {document.title || document.fileName}
                      </p>
                      <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
                        <Badge tone="info">{TYPE_LABELS[document.documentType]}</Badge>
                        <span className="tabular-nums">{formatDate(document.createdAt)}</span>
                        <span aria-hidden>·</span>
                        <span className="tabular-nums">{formatSize(document.fileSize)}</span>
                      </div>
                      {document.uploadedBy && (
                        <p className="mt-1 text-xs text-faint">
                          {tr(`Uploaded by ${document.uploadedBy}`, `${document.uploadedBy} ne upload ki`)}
                        </p>
                      )}
                    </div>
                  </div>

                  <div className="mt-auto flex flex-wrap gap-2">
                    <Button
                      variant="secondary"
                      disabled={opening === document.id}
                      loading={opening === document.id}
                      onClick={() => void open(document)}
                    >
                      <Icon name="visibility" className="text-[20px]" />
                      {opening === document.id ? tr("Opening…", "Khul rahi hai…") : tr("Open", "Kholein")}
                    </Button>
                    {READABLE.has(document.mimeType) && (
                      <Button
                        variant="ghost"
                        aria-expanded={reviewing?.id === document.id}
                        onClick={() =>
                          setReviewing((current) =>
                            current?.id === document.id ? null : document,
                          )
                        }
                      >
                        <Icon name="document_scanner" className="text-[20px]" />
                        {reviewing?.id === document.id
                          ? tr("Hide details", "Tafseel chhupayein")
                          : tr("Read details", "Tafseel parhein")}
                      </Button>
                    )}
                    {canRemove && (
                      <Button variant="ghost" onClick={() => void remove(document)}>
                        <Icon name="delete" className="text-[20px]" />
                        {tr("Remove", "Hatayein")}
                      </Button>
                    )}
                  </div>
                </li>

                <AnimatePresence initial={false}>
                  {reviewing?.id === document.id && (
                    <motion.li
                      key={`${document.id}-review`}
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: "auto", opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      transition={{ duration: 0.3, ease: "easeOut" }}
                      className="col-span-full overflow-hidden"
                    >
                      <OcrReview
                        documentId={document.id}
                        fileName={document.fileName}
                        canConfirm={canConfirmOcr}
                      />
                    </motion.li>
                  )}
                </AnimatePresence>
              </Fragment>
            ))}
          </ul>
        ))}

      <AnimatePresence>
        {preview && (
          <Lightbox
            key="lightbox"
            document={preview.document}
            url={preview.url}
            onClose={() => setPreview(null)}
          />
        )}
      </AnimatePresence>
    </Card>
  );
}

/**
 * The document, full-screen, behind a soft dark glass. Images and PDFs render
 * inline; anything else gets the link to open or save.
 */
function Lightbox({
  document,
  url,
  onClose,
}: {
  document: MedicalDocument;
  url: string;
  onClose: () => void;
}) {
  const tr = useTr();
  const kind = previewKind(document.mimeType);
  const name = document.title || document.fileName;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const linkClass =
    "btn-outline inline-flex min-h-11 items-center justify-center gap-2 rounded-xl px-4 text-base font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary";

  return (
    <motion.div
      role="dialog"
      aria-modal="true"
      aria-label={name}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2 }}
      onClick={onClose}
      className="fixed inset-0 z-50 flex items-center justify-center bg-navy-deep/70 p-4 backdrop-blur-sm"
    >
      <motion.div
        initial={{ scale: 0.92, opacity: 0, y: 12 }}
        animate={{ scale: 1, opacity: 1, y: 0 }}
        exit={{ scale: 0.96, opacity: 0, y: 8 }}
        transition={{ duration: 0.25, ease: "easeOut" }}
        onClick={(event) => event.stopPropagation()}
        className="glass flex max-h-full w-full max-w-4xl flex-col overflow-hidden rounded-2xl"
      >
        <header className="flex flex-wrap items-center gap-3 border-b border-line px-5 py-4">
          <span
            aria-hidden
            className="bg-gradient-brand grid h-10 w-10 shrink-0 place-items-center rounded-xl text-white"
          >
            <Icon name={iconFor(document.mimeType)} filled className="text-[22px]" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate font-display text-base font-bold text-strong">{name}</p>
            <p className="text-xs text-muted">
              {TYPE_LABELS[document.documentType]} · {formatSize(document.fileSize)} ·{" "}
              {formatDate(document.createdAt)}
            </p>
          </div>
          <a href={url} target="_blank" rel="noopener noreferrer" className={linkClass}>
            <Icon name="open_in_new" className="text-[20px]" />
            {tr("Open in new tab", "Naye tab mein kholein")}
          </a>
          <IconButton label={tr("Close", "Band karein")} icon="close" onClick={onClose} autoFocus />
        </header>

        <div className="min-h-0 flex-1 overflow-auto bg-sunken">
          {kind === "image" && (
            // A signed, short-lived URL from the API — not an asset for next/image.
            // eslint-disable-next-line @next/next/no-img-element
            <img src={url} alt={name} className="mx-auto max-h-[70vh] w-auto max-w-full object-contain" />
          )}
          {kind === "pdf" && <iframe src={url} title={name} className="h-[70vh] w-full" />}
          {kind === null && (
            <EmptyState
              icon="download"
              title={tr("This file cannot be shown here", "Yeh file yahan nahi dikhai ja sakti")}
              description={tr(
                "Your browser does not display this format inline. Save it, or open it in a new tab.",
                "Aap ka browser yeh format seedha nahi dikhata. Save karein, ya naye tab mein kholein.",
              )}
              action={
                <a href={url} download={document.fileName} className={linkClass}>
                  <Icon name="download" className="text-[20px]" />
                  {tr("Download", "Download karein")}
                </a>
              }
            />
          )}
        </div>
      </motion.div>
    </motion.div>
  );
}

/** An indeterminate ring turning around a document icon. */
function UploadRing({ label }: { label: string }) {
  return (
    <span role="status" aria-live="polite" className="relative grid h-16 w-16 place-items-center">
      <svg aria-hidden viewBox="0 0 64 64" fill="none" className="absolute inset-0 h-full w-full animate-spin">
        <defs>
          <linearGradient id="upload-ring" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#1B4FE0" />
            <stop offset="100%" stopColor="#14C7C0" />
          </linearGradient>
        </defs>
        <circle cx="32" cy="32" r="28" className="stroke-line" strokeWidth="4" />
        <circle
          cx="32"
          cy="32"
          r="28"
          stroke="url(#upload-ring)"
          strokeWidth="4"
          strokeLinecap="round"
          strokeDasharray="70 200"
        />
      </svg>
      <Icon name="description" filled className="text-[26px] text-primary" />
      <span className="sr-only">{label}</span>
    </span>
  );
}

function UploadForm({
  patientId,
  onUploaded,
}: {
  patientId: string;
  onUploaded: () => void;
}) {
  const tr = useTr();
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [documentType, setDocumentType] = useState<DocumentType>("LAB_REPORT");
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  const submit = async () => {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      await documents.upload({ file, patientId, documentType, title: title || undefined });
      setFile(null);
      setTitle("");
      if (input.current) input.current.value = "";
      onUploaded();
    } catch (caught) {
      // The server's rejection messages are specific and worth showing as-is:
      // "the file's contents do not match its type" tells someone exactly what
      // to fix.
      setError(caught instanceof ApiError ? caught.message : "The file could not be uploaded.");
    } finally {
      setBusy(false);
    }
  };

  // A dropped file lands in the same place a chosen one does.
  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    const dropped = event.dataTransfer.files?.[0];
    if (dropped) setFile(dropped);
  };

  return (
    <div className="mb-6 space-y-4">
      <div
        onDragOver={(event) => {
          event.preventDefault();
          if (!dragging) setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className={cx(
          "group relative rounded-2xl transition-[box-shadow,transform] duration-200 ease-out",
          dragging && "scale-[1.01] shadow-[0_0_0_6px_rgb(27_79_224/0.18),0_12px_32px_-12px_rgb(20_199_192/0.6)]",
        )}
      >
        {/* Dashes drawn in the gradient: an SVG stroke, since a CSS border cannot
            be both dashed and a gradient. */}
        <svg aria-hidden className="pointer-events-none absolute inset-0 h-full w-full overflow-visible">
          <defs>
            <linearGradient id="dropzone-dash" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor="#1B4FE0" />
              <stop offset="100%" stopColor="#14C7C0" />
            </linearGradient>
          </defs>
          <rect
            x="1"
            y="1"
            rx="16"
            ry="16"
            fill="none"
            stroke="url(#dropzone-dash)"
            strokeWidth={dragging ? 3 : 2}
            strokeDasharray={dragging ? "10 5" : "8 7"}
            style={{ width: "calc(100% - 2px)", height: "calc(100% - 2px)", transition: "stroke-width 0.2s ease" }}
            className={cx(dragging ? "opacity-100" : "opacity-60 group-hover:opacity-100", "transition-opacity duration-200")}
          />
        </svg>

        <input
          ref={input}
          id="document-file"
          type="file"
          accept={ACCEPTED_UPLOAD_TYPES}
          onChange={(event) => setFile(event.target.files?.[0] ?? null)}
          className="sr-only"
        />
        <label
          htmlFor="document-file"
          className={cx(
            "flex cursor-pointer flex-col items-center justify-center gap-3 rounded-2xl px-6 py-10 text-center transition-colors duration-200",
            dragging ? "bg-primary-soft/50" : "bg-card hover:bg-sunken/60",
          )}
        >
          {busy ? (
            <UploadRing label={tr("Uploading…", "Upload ho rahi hai…")} />
          ) : (
            <motion.span
              aria-hidden
              animate={dragging ? { y: [0, -8, 0], rotate: [0, -6, 4, 0] } : { y: 0, rotate: 0 }}
              transition={dragging ? { duration: 0.6, repeat: Infinity, ease: "easeInOut" } : { duration: 0.2 }}
              className={cx(
                "bg-gradient-soft icon-bounce grid h-16 w-16 place-items-center rounded-2xl text-primary shadow-sm transition-transform duration-200",
                dragging && "scale-110",
              )}
            >
              <Icon name={file ? "task" : "cloud_upload"} filled className="text-[32px]" />
            </motion.span>
          )}
          {file ? (
            <>
              <span className="font-display text-base font-bold text-strong">{file.name}</span>
              <span className="text-sm text-muted">
                {formatSize(file.size)} · {tr("Click to choose a different file", "Doosri file chunne ke liye click karein")}
              </span>
            </>
          ) : (
            <>
              <span className="font-display text-base font-bold text-strong">
                {dragging
                  ? tr("Drop it here", "Yahan chhor dein")
                  : tr("Drop a file here, or click to choose one", "File yahan chhorein, ya chunne ke liye click karein")}
              </span>
              <span className="text-sm text-muted">
                {tr("PDF, JPEG, PNG, WebP, TIFF or HEIC, up to 20 MB.", "PDF, JPEG, PNG, WebP, TIFF ya HEIC, 20 MB tak.")}
              </span>
            </>
          )}
        </label>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={tr("What is it?", "Yeh kya hai?")} htmlFor="document-type">
          <Select
            id="document-type"
            value={documentType}
            onChange={(event) => setDocumentType(event.target.value as DocumentType)}
          >
            {CHOOSABLE.map((type) => (
              <option key={type} value={type}>
                {TYPE_LABELS[type]}
              </option>
            ))}
          </Select>
        </Field>

        <Field label={tr("Title (optional)", "Unwan (ikhtiyari)")} htmlFor="document-title">
          <Input
            id="document-title"
            value={title}
            maxLength={120}
            onChange={(event) => setTitle(event.target.value)}
            placeholder={tr("e.g. Blood panel, March", "maslan Blood panel, March")}
          />
        </Field>
      </div>

      {error && (
        <p
          role="alert"
          className="pop-in flex items-start gap-2 rounded-xl border border-critical/50 bg-critical-soft px-4 py-3 text-sm font-medium text-critical"
        >
          <Icon name="error" className="mt-px shrink-0 text-[18px]" />
          {error}
        </p>
      )}

      <Button disabled={!file || busy} loading={busy} onClick={() => void submit()}>
        {busy ? tr("Uploading…", "Upload ho rahi hai…") : tr("Upload", "Upload karein")}
        {!busy && <Icon name="cloud_upload" className="text-[20px]" />}
      </Button>
    </div>
  );
}
