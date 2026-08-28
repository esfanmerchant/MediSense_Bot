"use client";

/**
 * Upload and open medical documents.
 *
 * Opening a document is a two-step trip on purpose: the client asks the API for
 * a link, the API checks access and mints one that expires in minutes, and only
 * then does the browser follow it. There is no stored URL to leak, and a link
 * copied out of the address bar stops working shortly after (conflict C8).
 */

import { useCallback, useRef, useState } from "react";

import { OcrReview } from "@/components/OcrReview";
import { Button, Card, EmptyState, ErrorState, Field, Input, Loading, cx } from "@/components/ui";
import {
  ACCEPTED_UPLOAD_TYPES,
  ApiError,
  documents,
  type DocumentType,
  type MedicalDocument,
} from "@/lib/api";
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
  const [refresh, setRefresh] = useState(0);
  const reload = useCallback(() => setRefresh((n) => n + 1), []);
  const list = useAsync(() => documents.list({ patientId, limit: 100 }), [patientId, refresh]);

  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState<MedicalDocument | null>(null);

  const open = async (document: MedicalDocument) => {
    setOpening(document.id);
    setError(null);
    try {
      const link = await documents.downloadUrl(document.id);
      window.open(link.url, "_blank", "noopener,noreferrer");
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
    <Card title={title} description={description}>
      {canUpload && <UploadForm patientId={patientId} onUploaded={reload} />}

      {list.loading && <Loading label="Loading documents" />}
      {list.error && <ErrorState message={list.error.message} onRetry={list.reload} />}

      {error && (
        <p role="alert" className="mb-3 text-sm font-medium text-red-700 dark:text-red-400">
          {error}
        </p>
      )}

      {list.data &&
        (list.data.data.length === 0 ? (
          <EmptyState
            title="No documents yet"
            description="Reports, prescriptions and scans appear here once uploaded."
          />
        ) : (
          <ul className="divide-y divide-slate-200 dark:divide-slate-700">
            {list.data.data.map((document) => (
              <li key={document.id} className="flex flex-wrap items-center gap-3 py-3">
                <div className="min-w-0 flex-1">
                  <p className="font-medium text-slate-900 dark:text-slate-100">
                    {document.title || document.fileName}
                  </p>
                  <p className="text-sm text-slate-600 dark:text-slate-400">
                    {TYPE_LABELS[document.documentType]} · {formatSize(document.fileSize)} ·{" "}
                    {formatDate(document.createdAt)}
                  </p>
                  {document.uploadedBy && (
                    <p className="text-xs text-slate-500 dark:text-slate-500">
                      Uploaded by {document.uploadedBy}
                    </p>
                  )}
                </div>

                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="secondary"
                    disabled={opening === document.id}
                    onClick={() => void open(document)}
                  >
                    {opening === document.id ? "Opening…" : "Open"}
                  </Button>
                  {READABLE.has(document.mimeType) && (
                    <Button
                      variant="ghost"
                      onClick={() =>
                        setReviewing((current) =>
                          current?.id === document.id ? null : document,
                        )
                      }
                    >
                      {reviewing?.id === document.id ? "Hide details" : "Read details"}
                    </Button>
                  )}
                  {canRemove && (
                    <Button variant="ghost" onClick={() => void remove(document)}>
                      Remove
                    </Button>
                  )}
                </div>

                {reviewing?.id === document.id && (
                  <div className="w-full pt-2">
                    <OcrReview
                      documentId={document.id}
                      fileName={document.fileName}
                      canConfirm={canConfirmOcr}
                    />
                  </div>
                )}
              </li>
            ))}
          </ul>
        ))}
    </Card>
  );
}

function UploadForm({
  patientId,
  onUploaded,
}: {
  patientId: string;
  onUploaded: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [documentType, setDocumentType] = useState<DocumentType>("LAB_REPORT");
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  return (
    <div className="mb-5 space-y-4 rounded-md border border-slate-200 p-4 dark:border-slate-700">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="File"
          htmlFor="document-file"
          hint="PDF, JPEG, PNG, WebP, TIFF or HEIC, up to 20 MB."
        >
          <input
            ref={input}
            id="document-file"
            type="file"
            accept={ACCEPTED_UPLOAD_TYPES}
            onChange={(event) => setFile(event.target.files?.[0] ?? null)}
            className={cx(
              "block w-full text-base text-slate-900 dark:text-slate-100",
              "file:mr-3 file:min-h-11 file:rounded-md file:border-0 file:bg-teal-700",
              "file:px-4 file:text-base file:font-medium file:text-white hover:file:bg-teal-800",
            )}
          />
        </Field>

        <Field label="What is it?" htmlFor="document-type">
          <select
            id="document-type"
            value={documentType}
            onChange={(event) => setDocumentType(event.target.value as DocumentType)}
            className="block min-h-11 w-full rounded-md border border-slate-300 bg-white px-3 py-2.5 text-base text-slate-900 focus:outline-2 focus:outline-teal-600 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
          >
            {CHOOSABLE.map((type) => (
              <option key={type} value={type}>
                {TYPE_LABELS[type]}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <Field label="Title (optional)" htmlFor="document-title">
        <Input
          id="document-title"
          value={title}
          maxLength={120}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="e.g. Blood panel, March"
        />
      </Field>

      {error && (
        <p role="alert" className="text-sm font-medium text-red-700 dark:text-red-400">
          {error}
        </p>
      )}

      <Button disabled={!file || busy} onClick={() => void submit()}>
        {busy ? "Uploading…" : "Upload"}
      </Button>
    </div>
  );
}
