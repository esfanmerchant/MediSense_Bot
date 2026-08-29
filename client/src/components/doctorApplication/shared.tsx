"use client";

/**
 * The pieces the three doctor-application screens share.
 *
 * A doctor fills the application in on `/doctor/onboarding`, waits on
 * `/doctor/pending`, and an administrator reads the same five sections back in
 * a drawer on `/admin/doctor-requests`. Everything that both sides must agree
 * on — what a document kind is called, how a status is coloured, how a file is
 * opened — lives here so the two views cannot drift apart.
 */

import { motion, useReducedMotion } from "framer-motion";
import Link from "next/link";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

import { Icon } from "@/components/Icon";
import { LanguageToggle } from "@/components/LanguageToggle";
import { ThemeToggle } from "@/components/ThemeToggle";
import { Logo } from "@/components/brand/Logo";
import { Badge, Button, EmptyState, IconButton, cx } from "@/components/ui";
import {
  ApiError,
  departments,
  doctorApplication,
  type ApplicationDocument,
  type ApplicationDocumentKind,
  type ApplicationStatus,
  type DoctorApplication,
  type DoctorApplicationDraft,
} from "@/lib/api";
import { useTr } from "@/lib/lang";
import { useAsync } from "@/lib/useAsync";
// The portal needs a document, which the server does not have.
import { useHydrated } from "@/lib/useHydrated";

// ---------------------------------------------------------------------------
// Vocabulary — one definition, used by the applicant and the reviewer alike
// ---------------------------------------------------------------------------

/** The five steps, in order. Index is the step number everywhere. */
export const STEPS: Array<{ label: [string, string]; hint: [string, string]; icon: string }> = [
  {
    label: ["Personal details", "Zaati maloomat"],
    hint: ["Who you are", "Aap kaun hain"],
    icon: "badge",
  },
  {
    label: ["Professional details", "Professional details"],
    hint: ["Registration and practice", "Registration aur practice"],
    icon: "medical_information",
  },
  {
    label: ["Qualifications", "Qualifications"],
    hint: ["Degrees and training", "Degrees aur training"],
    icon: "school",
  },
  {
    label: ["Documents", "Documents"],
    hint: ["Proof to upload", "Saboot upload karein"],
    icon: "folder_open",
  },
  {
    label: ["Review & submit", "Dekh kar bhejein"],
    hint: ["Check everything once", "Sab kuchh ek baar dekh lein"],
    icon: "fact_check",
  },
];

export const DOCUMENT_KINDS: ApplicationDocumentKind[] = [
  "REGISTRATION_CERTIFICATE",
  "DEGREE",
  "NATIONAL_ID",
  "PHOTO",
];

export const KIND_META: Record<
  ApplicationDocumentKind,
  { label: [string, string]; hint: [string, string]; icon: string }
> = {
  REGISTRATION_CERTIFICATE: {
    label: ["Registration certificate", "Registration certificate"],
    hint: ["Your PMC / council registration.", "Aap ki PMC / council registration."],
    icon: "verified",
  },
  DEGREE: {
    label: ["Degree", "Degree"],
    hint: ["MBBS or your highest degree.", "MBBS ya aap ki sab se aala degree."],
    icon: "school",
  },
  NATIONAL_ID: {
    label: ["National ID (CNIC)", "Shanakhti card (CNIC)"],
    hint: ["Both sides, or one clear scan.", "Dono taraf, ya ek saaf scan."],
    icon: "contact_emergency",
  },
  PHOTO: {
    label: ["Photograph", "Tasveer"],
    hint: ["A recent passport-style photo.", "Haal hi ki passport size tasveer."],
    icon: "photo_camera",
  },
};

export const STATUS_META: Record<
  ApplicationStatus,
  { label: [string, string]; tone: "neutral" | "good" | "warning" | "critical" | "info"; icon: string }
> = {
  DRAFT: { label: ["Draft", "Draft"], tone: "neutral", icon: "edit_note" },
  SUBMITTED: { label: ["Under review", "Zer-e-ghaur"], tone: "info", icon: "hourglass_top" },
  APPROVED: { label: ["Approved", "Manzoor"], tone: "good", icon: "check_circle" },
  REJECTED: { label: ["Rejected", "Na-manzoor"], tone: "critical", icon: "cancel" },
};

export function StatusChip({ status }: { status: ApplicationStatus }) {
  const tr = useTr();
  const meta = STATUS_META[status];
  return (
    <Badge tone={meta.tone}>
      <Icon name={meta.icon} filled className="text-[13px]" />
      {tr(...meta.label)}
    </Badge>
  );
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * "2s ago" in whichever language is on.
 *
 * Seconds are kept, rather than rounded away to "just now", because the
 * auto-save indicator is the one place a person is watching the clock — the
 * difference between two seconds and twenty is the difference between "it
 * saved" and "did it save?".
 */
export function relativeTime(from: number, now: number, urdu: boolean): string {
  const seconds = Math.max(0, Math.round((now - from) / 1000));
  if (seconds < 5) return urdu ? "abhi" : "just now";
  if (seconds < 60) return urdu ? `${seconds}s pehle` : `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return urdu ? `${minutes}m pehle` : `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return urdu ? `${hours}h pehle` : `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return urdu ? `${days}d pehle` : `${days}d ago`;
}

/** Re-renders on a tick, but only while something is actually counting. */
export function useNow(active: boolean, everyMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setNow(Date.now()), everyMs);
    return () => window.clearInterval(timer);
  }, [active, everyMs]);
  return now;
}

/** A relative timestamp that keeps itself current. */
export function RelativeTime({ iso, className }: { iso: string; className?: string }) {
  const tr = useTr();
  const now = useNow(true, 30_000);
  const urdu = tr("en", "ur") === "ur";
  return (
    <span className={className} title={formatDateTime(iso)}>
      {relativeTime(new Date(iso).getTime(), now, urdu)}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Departments — the application stores an id, the screens show a name
// ---------------------------------------------------------------------------

export interface DepartmentOption {
  id: string;
  name: string;
  code: string;
}

/**
 * The department list, and an id → name lookup.
 *
 * The application only ever carries `departmentId`; the name has to come from
 * here. A failure is not fatal — the screens fall back to showing the id, which
 * is still true, rather than inventing a name.
 */
export function useDepartments(): {
  list: DepartmentOption[];
  nameFor: (id: string | null | undefined) => string | null;
  loading: boolean;
} {
  const query = useAsync(() => departments.list(), []);
  const list = useMemo<DepartmentOption[]>(
    () => (query.data?.data ?? []).map(({ id, name, code }) => ({ id, name, code })),
    [query.data],
  );
  const byId = useMemo(() => new Map(list.map((item) => [item.id, item.name])), [list]);
  const nameFor = useCallback(
    (id: string | null | undefined) => (id ? (byId.get(id) ?? id) : null),
    [byId],
  );
  return { list, nameFor, loading: query.loading };
}

// ---------------------------------------------------------------------------
// The slim header the two doctor screens wear instead of the portal shell
// ---------------------------------------------------------------------------

/**
 * A header, not a shell.
 *
 * Onboarding has no sidebar on purpose: there is nowhere else to go until the
 * application is in, and a rail full of links a pending doctor cannot open
 * would be a menu of closed doors.
 */
export function SlimHeader({ onSignOut }: { onSignOut: () => void }) {
  const tr = useTr();
  return (
    <header className="glass sticky top-0 z-30 flex h-16 items-center gap-3 rounded-none border-x-0 border-t-0 border-b border-line/80 px-4 !shadow-none sm:px-8">
      <Link
        href="/"
        className="rounded-lg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
      >
        <Logo size="sm" />
      </Link>
      <div className="ml-auto flex items-center gap-1.5 sm:gap-2">
        <LanguageToggle />
        <ThemeToggle />
        <button
          type="button"
          onClick={onSignOut}
          className="inline-flex min-h-9 items-center gap-1.5 rounded-full px-3 text-sm font-semibold text-muted transition-colors hover:bg-critical-soft hover:text-critical focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
        >
          <Icon name="logout" className="text-[18px]" />
          <span className="hidden sm:inline">{tr("Sign out", "Sign out")}</span>
        </button>
      </div>
    </header>
  );
}

// ---------------------------------------------------------------------------
// Auto-save
// ---------------------------------------------------------------------------

export type SaveState = "idle" | "dirty" | "saving" | "saved" | "error";

/** Long enough that a typist is not saving every letter, short enough to trust. */
const DEBOUNCE_MS = 1200;

export interface Autosave {
  state: SaveState;
  savedAt: number | null;
  error: string | null;
  /** Records the newest draft and restarts the debounce. Never blocks typing. */
  schedule: (draft: DoctorApplicationDraft) => void;
  /** Sends whatever is outstanding right now and resolves when it has landed. */
  flush: () => Promise<void>;
  /** Marks a save that happened elsewhere — the first load, or a submit. */
  markSaved: (at: number) => void;
}

/**
 * Saves the draft on a debounce, and never makes anyone wait for it.
 *
 * The rule that shapes this: **a keystroke is never lost to a round-trip.**
 * The form's state is the truth; a save is a copy of it sent out at a
 * convenient moment. So the newest draft sits in a ref, a save takes a snapshot
 * of it, and anything typed while that request is in the air is still in the
 * ref when it returns — the loop below sends it on the next pass. The server's
 * echo is never written back into the form, because by the time it arrives the
 * form may already say something newer.
 *
 * A failed save keeps its payload rather than dropping it, and stops the loop:
 * spinning against a server that is refusing helps nobody, and the next
 * keystroke — or the Retry button — starts it again.
 */
export function useAutosave(onSaved?: (application: DoctorApplication) => void): Autosave {
  const [state, setState] = useState<SaveState>("idle");
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const pending = useRef<DoctorApplicationDraft | null>(null);
  const timer = useRef<number | null>(null);
  const busy = useRef<Promise<void> | null>(null);
  const onSavedRef = useRef(onSaved);

  useEffect(() => {
    onSavedRef.current = onSaved;
  });

  const clearTimer = useCallback(() => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  const flush = useCallback(async (): Promise<void> => {
    clearTimer();
    // A second caller does not start a second loop; it waits for the one that
    // is already draining `pending`, which by then includes its own payload.
    if (busy.current) {
      await busy.current;
      return;
    }
    const loop = (async () => {
      while (pending.current) {
        const payload = pending.current;
        pending.current = null;
        setState("saving");
        try {
          const application = await doctorApplication.save(payload);
          setSavedAt(Date.now());
          setError(null);
          setState("saved");
          onSavedRef.current?.(application);
        } catch (caught) {
          if (caught instanceof ApiError && caught.isAuthFailure) return;
          // Put it back: the draft is not lost, it is merely not sent yet.
          pending.current = payload;
          setError(
            caught instanceof ApiError ? caught.message : "The draft could not be saved.",
          );
          setState("error");
          return;
        }
      }
    })();
    busy.current = loop;
    try {
      await loop;
    } finally {
      busy.current = null;
    }
  }, [clearTimer]);

  const schedule = useCallback(
    (draft: DoctorApplicationDraft) => {
      pending.current = draft;
      setState((current) => (current === "saving" ? current : "dirty"));
      clearTimer();
      timer.current = window.setTimeout(() => void flush(), DEBOUNCE_MS);
    },
    [clearTimer, flush],
  );

  const markSaved = useCallback((at: number) => {
    setSavedAt(at);
    setState("saved");
  }, []);

  // Leaving the page mid-edit must not throw the last change away. There is no
  // component left to update, so this fires the request and walks off.
  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
      const outstanding = pending.current;
      pending.current = null;
      if (outstanding) void doctorApplication.save(outstanding).catch(() => {});
    },
    [],
  );

  return { state, savedAt, error, schedule, flush, markSaved };
}

/**
 * "Draft saved 2s ago", in the corner, in mono.
 *
 * The ticking part is hidden from assistive technology: an `aria-live` region
 * that re-announced the seconds every second would be unusable. What is
 * announced is the state change — saving, saved, not saved — which is the part
 * that carries news.
 */
export function DraftIndicator({
  autosave,
  onRetry,
}: {
  autosave: Autosave;
  onRetry?: () => void;
}) {
  const tr = useTr();
  const urdu = tr("en", "ur") === "ur";
  const ticking = autosave.state === "saved" && autosave.savedAt !== null;
  const now = useNow(ticking);

  const dot = {
    idle: "bg-line-strong",
    dirty: "bg-warning",
    saving: "bg-info",
    saved: "bg-stable",
    error: "bg-critical",
  }[autosave.state];

  let text: string;
  let announced: string;
  if (autosave.state === "saving") {
    text = tr("Saving…", "Save ho raha hai…");
    announced = text;
  } else if (autosave.state === "error") {
    text = tr("Not saved", "Save nahi hua");
    announced = tr("The draft was not saved", "Draft save nahi hua");
  } else if (autosave.state === "dirty") {
    text = tr("Unsaved changes", "Tabdeeliyan baqi hain");
    announced = "";
  } else if (autosave.savedAt !== null) {
    const when = relativeTime(autosave.savedAt, now, urdu);
    text = tr(`Draft saved ${when}`, `Draft ${when} save hua`);
    announced = tr("Draft saved", "Draft save ho gaya");
  } else {
    text = tr("Draft not started", "Draft shuru nahi hua");
    announced = "";
  }

  return (
    <div className="flex items-center gap-2">
      <span className="sr-only" role="status" aria-live="polite">
        {announced}
      </span>
      <span
        aria-hidden
        className={cx(
          "inline-flex items-center gap-2 rounded-full border border-line bg-card/70 px-3 py-1.5 font-mono text-[11px] font-medium tracking-tight text-muted",
          autosave.state === "error" && "border-critical/50 text-critical",
        )}
      >
        <span
          className={cx(
            "h-1.5 w-1.5 shrink-0 rounded-full",
            dot,
            // The teal ripple, not the red one: red in this product means a
            // clinician must act, and a save in flight is not that.
            autosave.state === "saving" && "pulse-dot-brand",
          )}
        />
        {text}
      </span>
      {autosave.state === "error" && onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="rounded-full px-2 py-1 font-mono text-[11px] font-semibold text-primary underline underline-offset-2 hover:text-primary-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
        >
          {tr("Retry", "Dobara")}
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Reading a summary back
// ---------------------------------------------------------------------------

/** One label/value pair. An empty value says so rather than showing a blank. */
export function SummaryField({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: ReactNode;
  mono?: boolean;
}) {
  const tr = useTr();
  const empty = value === null || value === undefined || value === "";
  return (
    <div className="min-w-0">
      <dt className="mono-caps text-[10px] text-faint">{label}</dt>
      <dd
        className={cx(
          "mt-0.5 break-words text-sm",
          mono && !empty && "font-mono",
          empty ? "text-faint italic" : "text-strong",
        )}
      >
        {empty ? tr("Not given", "Nahi diya gaya") : value}
      </dd>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Documents: thumbnails and the lightbox
// ---------------------------------------------------------------------------

export function iconForMime(mimeType: string): string {
  if (mimeType === "application/pdf") return "picture_as_pdf";
  if (mimeType.startsWith("image/")) return "image";
  return "description";
}

/** What a browser will actually render inline. TIFF and HEIC are stored only. */
export function previewKind(mimeType: string): "image" | "pdf" | null {
  if (mimeType === "application/pdf") return "pdf";
  if (["image/jpeg", "image/png", "image/webp", "image/gif"].includes(mimeType)) return "image";
  return null;
}

/**
 * Signed thumbnail URLs for the images in a list of documents.
 *
 * There is no permanent URL by design — the API mints a short-lived link after
 * re-checking access — so a thumbnail costs one request per image, once. A
 * locally uploaded file skips it entirely: `adopt` parks the browser's own
 * object URL under the new document's id, so the thumbnail is on screen before
 * the server could have answered.
 */
export function useThumbnails(
  documents: ApplicationDocument[],
  resolve: (documentId: string) => Promise<{ url: string }>,
): { urls: Record<string, string>; adopt: (documentId: string, file: File) => void } {
  const [urls, setUrls] = useState<Record<string, string>>({});
  const asked = useRef(new Set<string>());
  const objectUrls = useRef<string[]>([]);
  const resolveRef = useRef(resolve);

  useEffect(() => {
    resolveRef.current = resolve;
  });

  const wanted = documents
    .filter((document) => previewKind(document.mimeType) === "image")
    .map((document) => document.id)
    .join(",");

  useEffect(() => {
    let cancelled = false;
    const ids = wanted ? wanted.split(",") : [];
    for (const id of ids) {
      if (asked.current.has(id)) continue;
      asked.current.add(id);
      void resolveRef
        .current(id)
        .then((link) => {
          if (!cancelled) setUrls((current) => ({ ...current, [id]: link.url }));
        })
        .catch(() => {
          // A thumbnail that cannot be fetched falls back to the file icon.
        });
    }
    return () => {
      cancelled = true;
    };
  }, [wanted]);

  const adopt = useCallback((documentId: string, file: File) => {
    if (previewKind(file.type) !== "image") return;
    const url = URL.createObjectURL(file);
    objectUrls.current.push(url);
    asked.current.add(documentId);
    setUrls((current) => ({ ...current, [documentId]: url }));
  }, []);

  useEffect(
    () => () => {
      for (const url of objectUrls.current) URL.revokeObjectURL(url);
    },
    [],
  );

  return { urls, adopt };
}

const ZOOM_STEPS = [0.5, 0.75, 1, 1.5, 2, 3, 4];


/**
 * One document, full screen, with zoom and rotate.
 *
 * The keyboard handling runs in the **capture** phase on `document`, and that
 * is deliberate: this opens on top of a `Drawer`, whose own focus trap listens
 * on `document` in the bubble phase. Capturing first — and stopping the event
 * for the keys this owns — means Tab cycles inside the lightbox and Escape
 * closes the lightbox rather than the panel underneath it.
 */
export function DocumentLightbox({
  name,
  mimeType,
  url,
  onClose,
}: {
  name: string;
  mimeType: string;
  url: string;
  onClose: () => void;
}) {
  const tr = useTr();
  const reduced = useReducedMotion();
  const panel = useRef<HTMLDivElement>(null);
  const [zoomIndex, setZoomIndex] = useState(2);
  const [rotation, setRotation] = useState(0);
  const mounted = useHydrated();
  const kind = previewKind(mimeType);
  const zoom = ZOOM_STEPS[zoomIndex];

  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    const focusables = () =>
      Array.from(
        panel.current?.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      );

    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (event.key === "Tab") {
        const items = focusables();
        if (items.length === 0) return;
        event.preventDefault();
        event.stopPropagation();
        const index = items.indexOf(document.activeElement as HTMLElement);
        const next = event.shiftKey
          ? (index <= 0 ? items.length : index) - 1
          : (index + 1) % items.length;
        items[next]?.focus();
        return;
      }
      // Everything below is a bare letter or symbol. If anything typeable has
      // focus, those keys belong to it.
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.isContentEditable ||
          ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
      ) {
        return;
      }
      if (event.key === "+" || event.key === "=") {
        setZoomIndex((current) => Math.min(ZOOM_STEPS.length - 1, current + 1));
      } else if (event.key === "-") {
        setZoomIndex((current) => Math.max(0, current - 1));
      } else if (event.key === "r" || event.key === "R") {
        setRotation((current) => (current + 90) % 360);
      } else if (event.key === "0") {
        setZoomIndex(2);
        setRotation(0);
      }
    };

    document.addEventListener("keydown", onKey, true);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    focusables()[0]?.focus({ preventScroll: true });
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.body.style.overflow = previousOverflow;
    };
  }, []);

  if (!mounted) return null;

  const control = (icon: string, label: string, onClick: () => void, disabled = false) => (
    <IconButton label={label} icon={icon} size="sm" onClick={onClick} disabled={disabled} />
  );

  return createPortal(
    <motion.div
      role="dialog"
      aria-modal="true"
      aria-label={name}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: reduced ? 0 : 0.18 }}
      onClick={onClose}
      className="fixed inset-0 z-[120] flex items-center justify-center bg-navy-deep/80 p-4 backdrop-blur-sm"
    >
      <motion.div
        ref={panel}
        initial={reduced ? { opacity: 0 } : { scale: 0.94, opacity: 0, y: 10 }}
        animate={reduced ? { opacity: 1 } : { scale: 1, opacity: 1, y: 0 }}
        exit={reduced ? { opacity: 0 } : { scale: 0.97, opacity: 0 }}
        transition={{ duration: reduced ? 0 : 0.22, ease: "easeOut" }}
        onClick={(event) => event.stopPropagation()}
        className="glass flex max-h-full w-full max-w-5xl flex-col overflow-hidden rounded-2xl"
      >
        <header className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3">
          <span
            aria-hidden
            className="bg-gradient-brand grid h-9 w-9 shrink-0 place-items-center rounded-xl text-white"
          >
            <Icon name={iconForMime(mimeType)} filled className="text-[20px]" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate font-display text-sm font-bold text-strong">{name}</p>
            <p className="font-mono text-[11px] text-muted">
              {mimeType} · {Math.round(zoom * 100)}% · {rotation}°
            </p>
          </div>
          {kind === "image" && (
            <div className="flex items-center gap-1">
              {control(
                "zoom_out",
                tr("Zoom out", "Chhota karein"),
                () => setZoomIndex((current) => Math.max(0, current - 1)),
                zoomIndex === 0,
              )}
              {control(
                "zoom_in",
                tr("Zoom in", "Bara karein"),
                () => setZoomIndex((current) => Math.min(ZOOM_STEPS.length - 1, current + 1)),
                zoomIndex === ZOOM_STEPS.length - 1,
              )}
              {control("rotate_left", tr("Rotate left", "Baayen ghumayein"), () =>
                setRotation((current) => (current + 270) % 360),
              )}
              {control("rotate_right", tr("Rotate right", "Daayen ghumayein"), () =>
                setRotation((current) => (current + 90) % 360),
              )}
              {control("restart_alt", tr("Reset view", "Reset karein"), () => {
                setZoomIndex(2);
                setRotation(0);
              })}
            </div>
          )}
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="btn-outline inline-flex min-h-9 items-center gap-1.5 rounded-xl px-3 text-sm font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
          >
            <Icon name="open_in_new" className="text-[18px]" />
            {tr("New tab", "Naya tab")}
          </a>
          <IconButton label={tr("Close", "Band karein")} icon="close" size="sm" onClick={onClose} />
        </header>

        <div className="min-h-0 flex-1 overflow-auto bg-sunken p-4">
          {kind === "image" && (
            // A signed, short-lived URL from the API — not an asset next/image
            // can optimise, and one that must not be cached anywhere.
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={url}
              alt={name}
              style={{
                transform: `rotate(${rotation}deg) scale(${zoom})`,
                transition: reduced ? undefined : "transform 0.2s ease-out",
              }}
              className="mx-auto max-h-[70vh] w-auto max-w-full origin-center object-contain"
            />
          )}
          {kind === "pdf" && <iframe src={url} title={name} className="h-[70vh] w-full rounded-xl" />}
          {kind === null && (
            <EmptyState
              icon="download"
              title={tr("This file cannot be shown here", "Yeh file yahan nahi dikhai ja sakti")}
              description={tr(
                "Your browser does not display this format inline. Open it in a new tab instead.",
                "Aap ka browser yeh format seedha nahi dikhata. Ise naye tab mein kholein.",
              )}
              action={
                <a
                  href={url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="btn-outline inline-flex min-h-11 items-center gap-2 rounded-xl px-4 text-base font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                >
                  <Icon name="open_in_new" className="text-[20px]" />
                  {tr("Open in a new tab", "Naye tab mein kholein")}
                </a>
              }
            />
          )}
        </div>

        <footer className="border-t border-line px-4 py-2">
          <p className="font-mono text-[10.5px] text-faint">
            {tr(
              "Esc close · + / − zoom · R rotate · 0 reset",
              "Esc band · + / − zoom · R ghumayein · 0 reset",
            )}
          </p>
        </footer>
      </motion.div>
    </motion.div>,
    document.body,
  );
}

/**
 * Opens a document: asks for a signed link, then shows it.
 *
 * Written as a hook so the applicant's own view and the administrator's review
 * differ by one line — which endpoint mints the link — and by nothing else.
 */
export function useDocumentViewer(resolve: (documentId: string) => Promise<{ url: string }>) {
  const [opening, setOpening] = useState<string | null>(null);
  const [viewing, setViewing] = useState<{ document: ApplicationDocument; url: string } | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const resolveRef = useRef(resolve);

  useEffect(() => {
    resolveRef.current = resolve;
  });

  const open = useCallback(async (document: ApplicationDocument) => {
    setOpening(document.id);
    setError(null);
    try {
      const link = await resolveRef.current(document.id);
      setViewing({ document, url: link.url });
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Could not open that document.");
    } finally {
      setOpening(null);
    }
  }, []);

  const close = useCallback(() => setViewing(null), []);

  return { opening, viewing, error, open, close };
}

/** The thumbnail square: the image itself when there is one, its icon when not. */
export function DocumentThumb({
  document,
  url,
  className,
}: {
  document: ApplicationDocument;
  url?: string;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cx(
        "relative grid shrink-0 place-items-center overflow-hidden rounded-xl border border-line bg-sunken",
        className ?? "h-14 w-14",
      )}
    >
      {url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={url} alt="" className="h-full w-full object-cover" />
      ) : (
        <Icon name={iconForMime(document.mimeType)} filled className="text-[24px] text-primary" />
      )}
    </span>
  );
}

/** The gradient-dashed outline every dropzone in the product wears. */
export function DashedFrame({ active }: { active: boolean }) {
  // Four of these render side by side. Two <defs> sharing an id means the
  // second silently paints with the first's coordinates, so each gets its own.
  const id = `dash-${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  return (
    <svg
      aria-hidden
      className="pointer-events-none absolute inset-0 h-full w-full overflow-visible"
    >
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#0B3FA8" />
          <stop offset="55%" stopColor="#1A8FC7" />
          <stop offset="100%" stopColor="#14C4C1" />
        </linearGradient>
      </defs>
      <rect
        x="1"
        y="1"
        rx="14"
        ry="14"
        fill="none"
        stroke={`url(#${id})`}
        strokeWidth={active ? 3 : 2}
        strokeDasharray={active ? "10 5" : "8 7"}
        style={{
          width: "calc(100% - 2px)",
          height: "calc(100% - 2px)",
          transition: "stroke-width 0.2s ease",
        }}
        className={cx(
          "transition-opacity duration-200",
          active ? "opacity-100" : "opacity-60 group-hover:opacity-100",
        )}
      />
    </svg>
  );
}

/** An indeterminate ring: the API gives no progress events, so nor does this. */
export function UploadRing({ label, size = 56 }: { label: string; size?: number }) {
  const id = `ring-${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  return (
    <span
      role="status"
      aria-live="polite"
      className="relative grid place-items-center"
      style={{ width: size, height: size }}
    >
      <svg
        aria-hidden
        viewBox="0 0 64 64"
        fill="none"
        className="absolute inset-0 h-full w-full animate-spin"
      >
        <defs>
          <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#0B3FA8" />
            <stop offset="100%" stopColor="#14C4C1" />
          </linearGradient>
        </defs>
        <circle cx="32" cy="32" r="27" className="stroke-line" strokeWidth="5" />
        <circle
          cx="32"
          cy="32"
          r="27"
          stroke={`url(#${id})`}
          strokeWidth="5"
          strokeLinecap="round"
          strokeDasharray="60 200"
        />
      </svg>
      <Icon name="cloud_upload" filled className="text-[22px] text-primary" />
      <span className="sr-only">{label}</span>
    </span>
  );
}

/** A message a person must read before they carry on. */
export function Notice({
  tone,
  icon,
  title,
  children,
  action,
}: {
  tone: "critical" | "warning" | "info";
  icon: string;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  const tones = {
    critical: "border-critical/40 bg-critical-soft text-critical",
    warning: "border-warning/40 bg-warning-soft text-warning",
    info: "border-info/40 bg-info-soft text-info",
  } as const;
  return (
    <div
      role="alert"
      className={cx("pop-in flex gap-3 rounded-2xl border p-4 sm:p-5", tones[tone])}
    >
      <Icon name={icon} filled className="mt-0.5 shrink-0 text-[22px]" />
      <div className="min-w-0 flex-1">
        <p className="font-display text-sm font-bold">{title}</p>
        {children && <div className="mt-1 text-sm text-strong">{children}</div>}
        {action && <div className="mt-3">{action}</div>}
      </div>
    </div>
  );
}

/**
 * Stops one Escape from closing two overlays at once.
 *
 * `Dialog` and `Drawer` both listen for Escape on `document` in the bubble
 * phase, so a confirmation opened over a drawer would close both — taking the
 * reviewer's half-written notes with it. Capturing first, and stopping the key
 * there, keeps the dismissal to the thing on top.
 */
export function useEscapeShield(active: boolean, onEscape: () => void) {
  const handler = useRef(onEscape);
  useEffect(() => {
    handler.current = onEscape;
  });
  useEffect(() => {
    if (!active) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      handler.current();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [active]);
}

/** Sends a doctor back where they belong when the application says so. */
export function RedirectNotice({ label }: { label: string }) {
  return (
    <main
      id="main"
      className="mx-auto flex min-h-[60vh] max-w-md flex-col items-center justify-center gap-4 px-4 text-center"
    >
      <span aria-hidden className="bg-gradient-soft animate-float grid h-16 w-16 place-items-center rounded-2xl text-primary">
        <Icon name="arrow_forward" className="text-[30px]" />
      </span>
      <p role="status" className="text-sm font-medium text-muted">
        {label}
      </p>
    </main>
  );
}

/** The "one more thing" button pair at the foot of every wizard step. */
export function StepNav({
  onBack,
  onNext,
  nextLabel,
  backLabel,
  nextDisabled = false,
}: {
  onBack?: () => void;
  onNext?: () => void;
  nextLabel: string;
  backLabel: string;
  nextDisabled?: boolean;
}) {
  return (
    <div className="mt-8 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-6">
      {onBack ? (
        <Button variant="ghost" onClick={onBack}>
          <Icon name="arrow_back" className="text-[20px]" />
          {backLabel}
        </Button>
      ) : (
        <span />
      )}
      {onNext && (
        <Button onClick={onNext} disabled={nextDisabled}>
          {nextLabel}
          <Icon name="arrow_forward" className="text-[20px]" />
        </Button>
      )}
    </div>
  );
}
