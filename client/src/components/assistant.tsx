"use client";

/**
 * The patient-facing health assistant (spec §18-21).
 *
 * The API already refuses to produce a diagnosis, to name a drug the patient is
 * not on, or to talk an escalation down. This file's job is to make sure none of
 * that is lost on the way to the screen:
 *
 * - **The disclaimer renders with every answer and cannot be dismissed.** It is
 *   part of the answer, not a footnote under it.
 * - **An emergency is unmissable**, and it is announced to assistive technology
 *   rather than only coloured red.
 * - **Symptoms are never saved by the act of describing them.** Extraction and
 *   confirmation are two separate screens with two separate buttons, because the
 *   spec requires the patient to correct the list before anything is stored.
 * - **Nothing here is presented as a record.** The confirmation copy says whose
 *   account it is and that no doctor has seen it.
 *
 * The shape is a conversation, the way people now expect an assistant to look:
 * a history of chats down the side, one thread in the middle, and a composer
 * at the bottom that takes typing, speech, or a photograph of a report. The
 * answer is revealed progressively *after* the server has validated all of it —
 * the streaming is presentation, never a bypass of the safety layer, which
 * only ever sees, and only ever releases, a complete answer.
 */

import Link from "next/link";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";

import { Icon } from "@/components/Icon";
import {
  Badge,
  Button,
  Card,
  ErrorState,
  Field,
  Input,
  Loading,
  cx,
} from "@/components/ui";
import {
  ACCEPTED_ASSISTANT_IMAGE_TYPES,
  ApiError,
  MAX_ASSISTANT_IMAGE_BYTES,
  assistant as assistantApi,
  patients as patientsApi,
  type AssistantAnswer,
  type AssistantStatus,
  type AssistantTurn,
  type ConfirmedSymptom,
  type InputType,
  type SymptomProposal,
  type Urgency,
} from "@/lib/api";
import { useTr } from "@/lib/lang";
import { useAsync } from "@/lib/useAsync";
import { useSpeechRecognition } from "@/lib/useSpeechRecognition";

function messageOf(caught: unknown, fallback: string): string {
  return caught instanceof ApiError ? caught.message : fallback;
}

const URGENCY_TONE: Record<Urgency, "critical" | "warning" | "info" | "neutral"> = {
  EMERGENCY: "critical",
  URGENT: "warning",
  ROUTINE: "info",
  INFORMATION: "neutral",
};

const URGENCY_LABEL: Record<Urgency, [string, string]> = {
  EMERGENCY: ["Seek care now", "Foran ilaaj lein"],
  URGENT: ["See a doctor today", "Aaj hi doctor ko dikhayein"],
  ROUTINE: ["Routine", "Mamool ki baat"],
  INFORMATION: ["Information", "Ittila"],
};

/** The marker the server writes into a recorded question when an image was
    attached. The image itself is never stored, so this is all history has. */
const ATTACHMENT_MARKER = /\n\[Attached image: (.+)\]$/;

// ---------------------------------------------------------------------------
// Rendering an answer
// ---------------------------------------------------------------------------

/**
 * The banner an emergency answer opens with.
 *
 * `role="alert"` rather than colour alone: someone using a screen reader has to
 * hear this, and someone who cannot distinguish red from grey has to see it.
 */
function EmergencyBanner() {
  const tr = useTr();
  return (
    <div
      role="alert"
      className="flex gap-3 rounded-xl border-2 border-critical bg-critical-soft px-4 py-3"
    >
      <Icon name="emergency" filled className="mt-0.5 shrink-0 text-[24px] text-critical" />
      <div>
        <p className="font-semibold text-critical">
          {tr("This may need emergency care", "Yeh emergency ho sakti hai")}
        </p>
        <p className="mt-1 text-sm text-strong">
          {tr(
            "Do not wait for a reply here. Call your local emergency number or go to the nearest emergency department.",
            "Yahan jawab ka intezar na karein. Foran emergency number par call karein ya qareeb tareen emergency department jayein.",
          )}
        </p>
      </div>
    </div>
  );
}

/**
 * Never optional, never collapsible.
 *
 * The server sends the disclaimer with every answer so a client cannot render
 * guidance without it; hiding it behind a toggle here would defeat that.
 */
function Disclaimer({ text }: { text: string }) {
  return (
    <p className="mt-3 flex items-start gap-1.5 border-t border-line pt-3 text-xs text-muted">
      <Icon name="info" className="mt-px shrink-0 text-[14px]" />
      <span>{text}</span>
    </p>
  );
}

/** Inline `**bold**` inside one line of the answer. */
function inline(text: string, key: string): ReactNode[] {
  const parts = text.split(/(\*\*[^*]+\*\*)/g).filter(Boolean);
  return parts.map((part, index) =>
    part.startsWith("**") && part.endsWith("**") && part.length > 4 ? (
      <strong key={`${key}-${index}`}>{part.slice(2, -2)}</strong>
    ) : (
      <span key={`${key}-${index}`}>{part}</span>
    ),
  );
}

/**
 * The tiny markdown the model is allowed: paragraphs, "- " bullets, bold.
 *
 * Written by hand rather than pulled from a library, because the whole grammar
 * is three rules and anything a library would additionally render — links,
 * images, raw HTML — is exactly what must not appear in a clinical answer.
 */
function ChatMarkdown({ text }: { text: string }) {
  const blocks = text.split(/\n\s*\n/);
  return (
    <div className="prose-chat text-[15.5px] leading-relaxed text-strong">
      {blocks.map((block, blockIndex) => {
        const lines = block.split("\n");
        const bullets = lines.every((line) => /^\s*[-•]\s+/.test(line));
        if (bullets) {
          return (
            <ul key={blockIndex}>
              {lines.map((line, lineIndex) => (
                <li key={lineIndex}>
                  {inline(line.replace(/^\s*[-•]\s+/, ""), `${blockIndex}-${lineIndex}`)}
                </li>
              ))}
            </ul>
          );
        }
        return (
          <p key={blockIndex}>
            {lines.map((line, lineIndex) => (
              <span key={lineIndex}>
                {lineIndex > 0 && <br />}
                {inline(line, `${blockIndex}-${lineIndex}`)}
              </span>
            ))}
          </p>
        );
      })}
    </div>
  );
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/**
 * Reveals a validated answer a few words at a time.
 *
 * The text is complete before the first word shows — the server never releases
 * a partial answer, and the safety layer has already run over all of it. What
 * this adds is pacing: a long explanation of a lab report reads better arriving
 * at reading speed than landing as a wall. Reduced motion, and the test
 * environment, get the whole answer at once.
 */
function StreamedText({
  text,
  animate,
  onTick,
  onDone,
}: {
  text: string;
  animate: boolean;
  onTick?: () => void;
  onDone?: () => void;
}) {
  const tokens = useMemo(() => text.split(/(\s+)/).filter(Boolean), [text]);
  const instant = !animate || prefersReducedMotion() || process.env.NODE_ENV === "test";
  const [shown, setShown] = useState(() => (instant ? tokens.length : 0));
  const done = shown >= tokens.length;

  useEffect(() => {
    if (instant || done) return;
    const timer = window.setInterval(() => {
      setShown((current) => Math.min(tokens.length, current + 2));
      onTick?.();
    }, 22);
    return () => window.clearInterval(timer);
  }, [instant, done, tokens.length, onTick]);

  useEffect(() => {
    if (done) onDone?.();
  }, [done, onDone]);

  const visible = done ? text : tokens.slice(0, shown).join("");
  return (
    <div className={cx(!done && "stream-cursor")}>
      <ChatMarkdown text={visible} />
    </div>
  );
}

function AnswerBody({
  answer,
  animate,
  onTick,
}: {
  answer: AssistantAnswer;
  animate: boolean;
  onTick?: () => void;
}) {
  const tr = useTr();
  const [revealed, setRevealed] = useState(!animate);
  const finish = useCallback(() => setRevealed(true), []);

  return (
    <div className="space-y-3">
      {answer.emergency && <EmergencyBanner />}

      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={URGENCY_TONE[answer.urgency]}>{tr(...URGENCY_LABEL[answer.urgency])}</Badge>
        {answer.suggestedDepartment && (
          <Badge tone="neutral">
            {tr("Suggested:", "Tajweez:")} {answer.suggestedDepartment}
          </Badge>
        )}
      </div>

      <StreamedText text={answer.answer} animate={animate} onTick={onTick} onDone={finish} />

      {revealed && !answer.emergency && answer.urgency !== "INFORMATION" && (
        <Link
          href="/patient/appointments"
          className="pop-in inline-flex min-h-10 items-center gap-1.5 rounded-full border border-line-strong bg-card px-4 text-sm font-semibold text-primary transition-colors hover:bg-primary-soft focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
        >
          <Icon name="calendar_add_on" className="text-[18px]" />
          {tr("Book an appointment", "Appointment book karein")}
        </Link>
      )}

      <Disclaimer text={answer.disclaimer} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// The thread
// ---------------------------------------------------------------------------

export interface Turn {
  id: string;
  question: string;
  answer: AssistantAnswer;
  /** A local preview of the attached photo. Only exists for this visit. */
  imageUrl?: string;
  /** What was attached, for turns loaded from history (the image is gone). */
  imageName?: string;
  /** Freshly answered — reveal progressively. History arrives whole. */
  fresh: boolean;
}

/** A history row, as the thread renders it. */
export function turnFromHistory(row: AssistantTurn, disclaimer: string): Turn {
  const marker = row.input.match(ATTACHMENT_MARKER);
  return {
    id: row.id,
    question: marker ? row.input.replace(ATTACHMENT_MARKER, "") : row.input,
    imageName: marker?.[1],
    fresh: false,
    answer: {
      sessionId: row.sessionId,
      answer: row.response,
      urgency: row.urgency,
      emergency: row.emergency,
      suggestedDepartment: row.suggestedDepartment,
      extractedSymptoms: row.extractedSymptoms,
      disclaimer,
      safetyInterventions: [],
    },
  };
}

function AssistantAvatar({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cx(
        "grid h-9 w-9 shrink-0 place-items-center rounded-full bg-gradient-to-br from-[#006b5f] to-[#0d47a1] text-white shadow-md",
        className,
      )}
    >
      <Icon name="health_and_safety" filled className="text-[20px]" />
    </span>
  );
}

function UserMessage({ turn }: { turn: Turn }) {
  const tr = useTr();
  return (
    <div className={cx("flex justify-end", turn.fresh && "pop-in")}>
      <div className="max-w-[85%] space-y-2">
        {turn.imageUrl && (
          // A blob: URL from this visit; next/image cannot optimise it and
          // should not try.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={turn.imageUrl}
            alt={tr("The report you attached", "Aap ki attach ki hui report")}
            className="ml-auto max-h-56 rounded-2xl rounded-br-md border border-line object-cover shadow-card"
          />
        )}
        {turn.imageName && !turn.imageUrl && (
          <p className="ml-auto flex w-fit items-center gap-1.5 rounded-full bg-sunken px-3 py-1 text-xs text-muted">
            <Icon name="image" className="text-[16px]" />
            {turn.imageName}
            <span className="text-faint">· {tr("not stored", "save nahi hui")}</span>
          </p>
        )}
        <p className="whitespace-pre-line rounded-2xl rounded-br-md bg-gradient-to-br from-[#003178] to-[#0d47a1] px-4 py-3 text-[15.5px] leading-relaxed text-white shadow-md">
          {turn.question}
        </p>
      </div>
    </div>
  );
}

function AssistantMessage({ turn, onTick }: { turn: Turn; onTick?: () => void }) {
  return (
    <div className={cx("flex gap-3", turn.fresh && "pop-in")}>
      <AssistantAvatar className="mt-1" />
      <div className="min-w-0 flex-1 rounded-2xl rounded-tl-md border border-line bg-card px-4 py-3.5 shadow-card sm:px-5">
        <AnswerBody answer={turn.answer} animate={turn.fresh} onTick={onTick} />
      </div>
    </div>
  );
}

/** "Working on it", with the stage named so the wait has a shape. */
function Thinking({ withImage }: { withImage: boolean }) {
  const tr = useTr();
  const phases: [string, string][] = withImage
    ? [
        ["Reading your report", "Aap ki report parhi ja rahi hai"],
        ["Checking your prescriptions", "Aap ke nuskhe check ho rahe hain"],
        ["Safety check", "Safety check"],
      ]
    : [
        ["Reading your question", "Aap ka sawal parha ja raha hai"],
        ["Checking your prescriptions", "Aap ke nuskhe check ho rahe hain"],
        ["Safety check", "Safety check"],
      ];
  const [phase, setPhase] = useState(0);

  useEffect(() => {
    const timer = window.setInterval(
      () => setPhase((current) => Math.min(phases.length - 1, current + 1)),
      1600,
    );
    return () => window.clearInterval(timer);
  }, [phases.length]);

  return (
    <div className="pop-in flex items-center gap-3" role="status" aria-live="polite">
      <AssistantAvatar />
      <div className="flex items-center gap-3 rounded-2xl rounded-tl-md border border-line bg-card px-4 py-3 shadow-card">
        <span className="flex items-center gap-1" aria-hidden>
          <span className="typing-dot h-2 w-2 rounded-full bg-accent" />
          <span className="typing-dot h-2 w-2 rounded-full bg-accent" />
          <span className="typing-dot h-2 w-2 rounded-full bg-accent" />
        </span>
        <span className="text-sm text-muted">{tr(...phases[phase])}…</span>
      </div>
    </div>
  );
}

function Welcome({ onSuggest }: { onSuggest: (text: string) => void }) {
  const tr = useTr();
  const suggestions: [string, string][] = [
    ["What is my blood pressure tablet for?", "Meri blood pressure ki goli kis liye hai?"],
    [
      "Which department should I see for a persistent cough?",
      "Purani khansi ke liye kaunsa department dekhun?",
    ],
    ["When is my next appointment?", "Meri agli appointment kab hai?"],
    ["Explain the report in this photo", "Is tasveer wali report samjhayein"],
  ];

  return (
    <div className="flex h-full flex-col items-center justify-center px-4 py-10 text-center">
      <div className="relative">
        <span
          aria-hidden
          className="animate-breathe absolute inset-0 rounded-full bg-accent-bright/50 blur-2xl"
        />
        <AssistantAvatar className="animate-float relative h-16 w-16 [&>span]:text-[32px]" />
      </div>
      <h2 className="mt-6 font-display text-2xl font-bold text-strong">
        {tr("How can I help today?", "Aaj main kaise madad karun?")}
      </h2>
      <p className="mt-2 max-w-md text-[15px] text-muted">
        {tr(
          "Ask about your prescriptions and appointments, or attach a photo of a report and ask what it means.",
          "Apne nuskhon ya appointments ke baare mein poochein, ya report ki tasveer laga kar poochein ke iska matlab kya hai.",
        )}
      </p>
      <ul className="mt-8 grid w-full max-w-xl gap-2 sm:grid-cols-2">
        {suggestions.map(([en, ur]) => (
          <li key={en}>
            <button
              type="button"
              onClick={() => onSuggest(tr(en, ur))}
              className="hover-lift-sm flex min-h-12 w-full items-center gap-2.5 rounded-xl border border-line bg-card px-4 py-2.5 text-left text-sm text-strong shadow-card focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
            >
              <Icon name="auto_awesome" className="shrink-0 text-[18px] text-accent" />
              {tr(en, ur)}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The composer
// ---------------------------------------------------------------------------

/**
 * The microphone from spec §20, as one round control in the composer.
 *
 * Built for the people it is for. Recognition exists so that someone who
 * struggles to type can still describe how they feel, so the control is a full
 * touch target, keyboard-operable, and announces its own state rather than
 * signalling only through colour. Where the browser cannot do this at all, the
 * control says so in its label instead of being a button that does nothing.
 */
function MicButton({
  onTranscript,
  onInterim,
  disabled,
}: {
  onTranscript: (settled: string) => void;
  onInterim: (interim: string) => void;
  disabled: boolean;
}) {
  const tr = useTr();
  const speech = useSpeechRecognition(onTranscript);
  const listening = speech.state === "listening";

  useEffect(() => {
    onInterim(speech.interim);
  }, [speech.interim, onInterim]);

  if (speech.state === "unsupported") {
    return (
      <button
        type="button"
        disabled
        title={tr(
          "This browser cannot listen for speech. Chrome, Edge and Safari can.",
          "Yeh browser awaaz nahi sun sakta. Chrome, Edge aur Safari sun sakte hain.",
        )}
        aria-label={tr("Speech input is not available in this browser", "Is browser mein awaaz se likhna dastyab nahi")}
        className="grid h-11 w-11 place-items-center rounded-full text-faint opacity-50"
      >
        <Icon name="mic_off" className="text-[22px]" />
      </button>
    );
  }

  return (
    <>
      <button
        type="button"
        disabled={disabled}
        aria-pressed={listening}
        aria-label={listening ? tr("Stop listening", "Sunna band karein") : tr("Speak your question", "Apna sawal bolein")}
        onClick={() => (listening ? speech.stop() : speech.start())}
        className={cx(
          "relative grid h-11 w-11 place-items-center rounded-full transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary",
          listening
            ? "listening-ring bg-critical text-white"
            : "text-muted hover:bg-sunken hover:text-strong disabled:opacity-50",
        )}
      >
        <Icon name={listening ? "stop" : "mic"} filled={listening} className="text-[22px]" />
      </button>
      {/* Announced, not merely animated: a patient who cannot see the button
          change colour still needs to know the microphone is live. */}
      <span role="status" aria-live="polite" className="sr-only">
        {listening
          ? tr("Listening. Your words appear in the box, and you can edit them before sending.", "Sun raha hai. Aap ke alfaz box mein aayenge, aur bhejne se pehle aap unhe badal sakte hain.")
          : ""}
      </span>
      {speech.error && (
        <p role="alert" className="absolute -top-8 left-0 right-0 text-xs text-critical">
          {speech.error}
        </p>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Conversation
// ---------------------------------------------------------------------------

const noop = () => {};

/**
 * One conversation with the assistant.
 *
 * Turns are held in local state and appended from the send handler. The server
 * keeps its own history (and is the record of what was said); this list is what
 * is on screen since the thread opened.
 */
export function AssistantChat({
  sessionId: initialSessionId,
  initialTurns = [],
  prefill = "",
  onTurn = noop,
}: {
  sessionId?: string;
  initialTurns?: Turn[];
  /** A question to start with — from the dashboard's "ask" box. */
  prefill?: string;
  /** Called after each answered turn, so a history list can update. */
  onTurn?: (sessionId: string, turn: Turn) => void;
} = {}) {
  const tr = useTr();
  const [question, setQuestion] = useState(prefill);
  const [interim, setInterim] = useState("");
  const [turns, setTurns] = useState<Turn[]>(initialTurns);
  const [sessionId, setSessionId] = useState<string | undefined>(initialSessionId);
  const [dictated, setDictated] = useState(false);
  const [attachment, setAttachment] = useState<{ file: File; url: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const textarea = useRef<HTMLTextAreaElement | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const scroller = useRef<HTMLDivElement | null>(null);
  const bottom = useRef<HTMLDivElement | null>(null);
  const previews = useRef<string[]>([]);

  // Preview URLs are released when the thread goes away, not before: a
  // photo the patient sent stays visible for the rest of the conversation.
  useEffect(() => {
    const urls = previews.current;
    return () => {
      for (const url of urls) URL.revokeObjectURL(url);
    };
  }, []);

  const scrollToEnd = useCallback((force = false) => {
    const container = scroller.current;
    if (!container) return;
    const nearBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight < 160;
    if (force || nearBottom) bottom.current?.scrollIntoView?.({ block: "end" });
  }, []);

  useLayoutEffect(() => {
    scrollToEnd(true);
  }, [turns.length, busy, scrollToEnd]);

  // The box grows with what is typed, up to a few lines, then scrolls.
  const fit = () => {
    const element = textarea.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, 200)}px`;
  };

  const appendTranscript = useCallback((settled: string) => {
    setDictated(true);
    setQuestion((current) => (current ? `${current} ${settled}` : settled).slice(0, 2000));
    setInterim("");
  }, []);

  const attach = (file: File | undefined) => {
    setError(null);
    if (!file) return;
    if (!ACCEPTED_ASSISTANT_IMAGE_TYPES.split(",").includes(file.type)) {
      setError(
        tr(
          "Attach a photo of the report as a JPEG, PNG or WebP image. PDFs belong on your documents page.",
          "Report ki tasveer JPEG, PNG ya WebP mein lagayein. PDF documents page par jaati hai.",
        ),
      );
      return;
    }
    if (file.size > MAX_ASSISTANT_IMAGE_BYTES) {
      setError(tr("That image is larger than 8 MB.", "Yeh tasveer 8 MB se bari hai."));
      return;
    }
    const url = URL.createObjectURL(file);
    previews.current.push(url);
    setAttachment({ file, url });
    textarea.current?.focus();
  };

  const send = async () => {
    const message = question.trim();
    if (!message || busy) return;

    setBusy(true);
    setError(null);
    const sent = attachment;
    const inputType: InputType = dictated ? "VOICE" : "TEXT";
    try {
      const answer = sent
        ? await assistantApi.chatWithImage({ message, image: sent.file, sessionId, inputType })
        : await assistantApi.chat({ message, sessionId, inputType });
      const turn: Turn = {
        id: `${answer.sessionId}-${Date.now()}`,
        question: message,
        answer,
        imageUrl: sent?.url,
        imageName: sent?.file.name,
        fresh: true,
      };
      setSessionId(answer.sessionId);
      setTurns((current) => [...current, turn]);
      onTurn(answer.sessionId, turn);
      setQuestion("");
      setDictated(false);
      setAttachment(null);
      requestAnimationFrame(fit);
    } catch (caught) {
      setError(
        messageOf(
          caught,
          tr("Could not reach the assistant. Please try again.", "Assistant tak nahi pahunch saka. Dobara koshish karein."),
        ),
      );
    } finally {
      setBusy(false);
    }
  };

  const onKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void send();
    }
  };

  const suggest = (text: string) => {
    setQuestion(text);
    textarea.current?.focus();
    requestAnimationFrame(fit);
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* The thread. aria-live so each new answer is announced without moving
          focus away from the box the patient is still using. */}
      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto px-3 py-4 sm:px-6">
        {turns.length === 0 && !busy ? (
          <Welcome onSuggest={suggest} />
        ) : (
          <ol aria-live="polite" className="mx-auto max-w-3xl space-y-6">
            {turns.map((turn) => (
              <li key={turn.id} className="space-y-4">
                <UserMessage turn={turn} />
                <AssistantMessage turn={turn} onTick={scrollToEnd} />
              </li>
            ))}
            {busy && (
              <li>
                <Thinking withImage={attachment !== null} />
              </li>
            )}
          </ol>
        )}
        <div ref={bottom} />
      </div>

      {/* The composer. */}
      <div className="border-t border-line bg-card/80 px-3 pb-3 pt-3 backdrop-blur sm:px-6">
        <div className="mx-auto max-w-3xl">
          {error && (
            <p role="alert" className="mb-2 rounded-lg bg-critical-soft px-3 py-2 text-sm font-medium text-critical">
              {error}
            </p>
          )}

          {attachment && (
            <div className="pop-in mb-2 flex items-center gap-3 rounded-xl border border-line bg-sunken p-2 pr-3">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={attachment.url}
                alt=""
                className="h-14 w-14 rounded-lg border border-line object-cover"
              />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-strong">{attachment.file.name}</p>
                <p className="text-xs text-muted">
                  {tr(
                    "Read for this answer only — not saved to your documents.",
                    "Sirf is jawab ke liye parhi jayegi — documents mein save nahi hogi.",
                  )}
                </p>
              </div>
              <button
                type="button"
                aria-label={tr("Remove image", "Tasveer hatayein")}
                onClick={() => setAttachment(null)}
                className="grid h-9 w-9 place-items-center rounded-full text-muted hover:bg-raised hover:text-strong focus-visible:outline-2 focus-visible:outline-primary"
              >
                <Icon name="close" className="text-[20px]" />
              </button>
            </div>
          )}

          <form
            className="relative flex items-end gap-1 rounded-2xl border border-line-strong bg-card p-1.5 shadow-card transition-[box-shadow,border-color] focus-within:border-primary focus-within:shadow-float"
            onSubmit={(event) => {
              event.preventDefault();
              void send();
            }}
          >
            <input
              ref={fileInput}
              type="file"
              accept={ACCEPTED_ASSISTANT_IMAGE_TYPES}
              className="hidden"
              onChange={(event) => {
                attach(event.target.files?.[0]);
                event.target.value = "";
              }}
            />
            <button
              type="button"
              disabled={busy}
              aria-label={tr("Attach a photo of a report", "Report ki tasveer lagayein")}
              title={tr("Attach a photo of a report", "Report ki tasveer lagayein")}
              onClick={() => fileInput.current?.click()}
              className="grid h-11 w-11 shrink-0 place-items-center rounded-full text-muted transition-colors hover:bg-sunken hover:text-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:opacity-50"
            >
              <Icon name="add_photo_alternate" className="text-[22px]" />
            </button>

            <MicButton onTranscript={appendTranscript} onInterim={setInterim} disabled={busy} />

            <div className="relative min-w-0 flex-1">
              <textarea
                ref={textarea}
                id="assistant-question"
                aria-label={tr("Your question", "Aap ka sawal")}
                placeholder={
                  interim
                    ? ""
                    : tr("Ask about your care…", "Apne ilaaj ke baare mein poochein…")
                }
                rows={1}
                maxLength={2000}
                value={question}
                disabled={busy}
                onChange={(event) => {
                  setQuestion(event.target.value);
                  fit();
                }}
                onKeyDown={onKey}
                className="block max-h-[200px] w-full resize-none bg-transparent px-2 py-2.5 text-base text-strong placeholder:text-faint focus:outline-none"
              />
              {interim && !question && (
                <span
                  aria-hidden
                  className="pointer-events-none absolute left-2 top-2.5 text-base italic text-faint"
                >
                  {interim}…
                </span>
              )}
            </div>

            <button
              type="submit"
              aria-label={tr("Send", "Bhejein")}
              disabled={busy || !question.trim()}
              className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-primary text-white shadow-sm transition-[background-color,transform,opacity] hover:bg-primary-strong active:scale-95 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:opacity-40 disabled:hover:bg-primary"
            >
              <Icon name="arrow_upward" className="text-[22px]" />
            </button>
          </form>

          <p className="mt-2 text-center text-[11px] text-faint">
            {tr(
              "General guidance only — not a diagnosis. Enter sends, Shift+Enter starts a new line.",
              "Sirf aam rehnumai — tashkhees nahi. Enter se bhejein, Shift+Enter se nayi line.",
            )}
          </p>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Symptom review
// ---------------------------------------------------------------------------

interface SymptomDraft {
  /** Stable across removals, so editing a row does not move focus to another. */
  key: number;
  symptom: string;
  severity: string;
  duration: string;
}

let nextDraftKey = 0;

function draftOf(symptom = ""): SymptomDraft {
  nextDraftKey += 1;
  return { key: nextDraftKey, symptom, severity: "", duration: "" };
}

/**
 * The spec's "[ 🎤 Speak your symptoms ]" — a large, labelled microphone for
 * the symptom form, where a full-width control suits the page better than the
 * composer's round one.
 */
function VoiceInput({
  label,
  onTranscript,
  disabled,
}: {
  label: string;
  onTranscript: (settled: string) => void;
  disabled: boolean;
}) {
  const tr = useTr();
  const speech = useSpeechRecognition(onTranscript);

  if (speech.state === "unsupported") {
    return (
      <p className="text-sm text-muted">
        {tr(
          "This browser cannot listen for speech. Chrome, Edge and Safari can — or you can type below.",
          "Yeh browser awaaz nahi sun sakta. Chrome, Edge aur Safari sun sakte hain — ya aap neeche likh sakte hain.",
        )}
      </p>
    );
  }

  const listening = speech.state === "listening";

  return (
    <div className="space-y-2">
      <Button
        type="button"
        size="lg"
        variant={listening ? "danger" : "secondary"}
        disabled={disabled}
        aria-pressed={listening}
        onClick={() => (listening ? speech.stop() : speech.start())}
        className={cx("relative", listening && "listening-ring")}
      >
        <Icon name={listening ? "stop" : "mic"} filled={listening} className="text-[22px]" />
        {listening ? tr("Stop listening", "Sunna band karein") : label}
      </Button>

      <p role="status" aria-live="polite" className="text-sm text-muted">
        {listening
          ? tr(
              "Listening. Speak normally — your words appear below, and you can edit them before anything is sent.",
              "Sun raha hai. Aaram se bolein — aap ke alfaz neeche aayenge, aur bhejne se pehle aap unhe badal sakte hain.",
            )
          : tr(
              "Your speech is turned into text on this device. The recording is never sent to MediSense.",
              "Aap ki awaaz isi device par likhai mein badalti hai. Recording kabhi MediSense ko nahi bheji jaati.",
            )}
      </p>

      {speech.interim && <p className="text-sm italic text-faint">{speech.interim}…</p>}

      {speech.error && <ErrorState title={tr("Microphone", "Microphone")} message={speech.error} />}
    </div>
  );
}

/**
 * Describe symptoms by voice or by typing, then correct what the assistant
 * heard (spec §20).
 *
 * The spec's pipeline has *two* review points, and both are here:
 *
 *     microphone -> transcript -> [edit] -> extraction -> [edit] -> analysis
 *
 * The transcript lands in the same textarea the patient types into, so it is
 * editable by construction rather than by a separate "edit transcript" mode.
 * The extraction that follows is a *proposal*, editable from the moment it
 * appears, and only the patient's confirmed list is sent to the server. Nothing
 * about describing symptoms writes anything, and the extracted list is never
 * treated as clinical information.
 *
 * Whether speech was involved is carried through to the server, because it
 * changes the provenance recorded against the stored symptom (§21): dictated
 * symptoms are `AI_ASSISTED`, typed ones are `PATIENT_REPORTED`.
 */
export function SymptomReview() {
  const tr = useTr();
  const [text, setText] = useState("");
  /**
   * Set once the patient dictates anything, and deliberately not cleared when
   * they edit afterwards. A transcript the patient corrected is still a
   * transcript, and understating how a symptom was captured would misrepresent
   * its provenance in the record (§21).
   */
  const [dictated, setDictated] = useState(false);
  const [proposal, setProposal] = useState<SymptomProposal | null>(null);
  /**
   * Whether the correction step is on screen. Separate from `proposal` on
   * purpose: if extraction fails, the patient still gets the list to fill in by
   * hand rather than losing the feature to a provider problem.
   */
  const [reviewing, setReviewing] = useState(false);
  const [drafts, setDrafts] = useState<SymptomDraft[]>([]);
  const [saved, setSaved] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const inputType: InputType = dictated ? "VOICE" : "TEXT";

  const analyse = async () => {
    const described = text.trim();
    if (!described || busy) return;

    setBusy(true);
    setError(null);
    setSaved(null);
    try {
      const result = await assistantApi.analyseSymptoms({ text: described, inputType });
      setProposal(result);
      setReviewing(true);
      // Seeded once here, from an event handler — from now on it is the
      // patient's list, and re-analysing is what replaces it.
      setDrafts(
        result.extractedSymptoms.length > 0
          ? result.extractedSymptoms.map((symptom) => draftOf(symptom))
          : [draftOf()],
      );
    } catch (caught) {
      setError(
        messageOf(caught, "Could not read your description. You can still list your symptoms below."),
      );
      // The feature does not disappear because the provider did — an empty row
      // is offered so the patient can record their symptoms themselves.
      setProposal(null);
      setReviewing(true);
      setDrafts((current) => (current.length > 0 ? current : [draftOf()]));
    } finally {
      setBusy(false);
    }
  };

  const confirm = async () => {
    const symptoms: ConfirmedSymptom[] = drafts
      .filter((draft) => draft.symptom.trim())
      .map((draft) => ({
        symptom: draft.symptom.trim(),
        severity: draft.severity.trim() || undefined,
        duration: draft.duration.trim() || undefined,
      }));
    if (symptoms.length === 0) return;

    setBusy(true);
    setError(null);
    try {
      const result = await assistantApi.confirmSymptoms({
        symptoms,
        inputType,
        rawText: text.trim() || undefined,
      });
      setSaved(result.note);
      setProposal(null);
      setReviewing(false);
      setDrafts([]);
      setText("");
      setDictated(false);
    } catch (caught) {
      setError(messageOf(caught, "Could not save your symptoms. Please try again."));
    } finally {
      setBusy(false);
    }
  };

  const update = (key: number, patch: Partial<SymptomDraft>) =>
    setDrafts((current) =>
      current.map((draft) => (draft.key === key ? { ...draft, ...patch } : draft)),
    );

  const remove = (key: number) =>
    setDrafts((current) => current.filter((draft) => draft.key !== key));

  const usable = drafts.some((draft) => draft.symptom.trim());

  /** Appends settled speech to whatever the patient has already written. */
  const appendTranscript = (settled: string) => {
    setDictated(true);
    setText((current) => (current ? `${current} ${settled}` : settled).slice(0, 2000));
  };

  return (
    <Card
      icon="stethoscope"
      title={tr("Describe your symptoms", "Apni takleef batayein")}
      description={tr(
        "Speak or type, in your own words. You will get to correct everything before anything is saved.",
        "Bol kar ya likh kar, apne alfaz mein. Save hone se pehle aap har cheez durust kar sakenge.",
      )}
      className="border-0 shadow-none"
    >
      <div className="space-y-4">
        <VoiceInput
          label={tr("Speak your symptoms", "Apni takleef bolein")}
          onTranscript={appendTranscript}
          disabled={busy}
        />

        <Field
          label={tr("What are you experiencing?", "Aap kya mehsoos kar rahe hain?")}
          htmlFor="symptom-text"
          hint={
            dictated
              ? tr(
                  "This is what was heard. Correct anything that is wrong before continuing.",
                  "Jo suna gaya woh yeh hai. Aage barhne se pehle jo ghalat ho usay durust kar lein.",
                )
              : tr(
                  "For example: “headache since yesterday, worse in the morning, and some dizziness.”",
                  "Misal: “kal se sar dard hai, subah zyada hota hai, aur kabhi kabhi chakkar bhi.”",
                )
          }
        >
          <textarea
            id="symptom-text"
            rows={4}
            maxLength={2000}
            value={text}
            disabled={busy}
            onChange={(event) => setText(event.target.value)}
            className="block w-full rounded-xl border border-line-strong bg-card px-3 py-2.5 text-base text-strong placeholder:text-faint focus:outline-2 focus:outline-offset-0 focus:outline-primary"
          />
        </Field>

        <Button disabled={busy || !text.trim()} loading={busy && !reviewing} onClick={() => void analyse()}>
          <Icon name="manage_search" className="text-[20px]" />
          {busy && !reviewing
            ? tr("Reading…", "Parha ja raha hai…")
            : tr("Review my symptoms", "Meri takleef ka jaiza lein")}
        </Button>

        {error && <ErrorState message={error} />}

        {saved && (
          <div
            role="status"
            className="pop-in flex items-start gap-2 rounded-xl border border-stable/40 bg-stable-soft px-4 py-3 text-sm text-stable"
          >
            <Icon name="check_circle" filled className="shrink-0 text-[20px]" />
            {saved}
          </div>
        )}

        {reviewing && (
          <div className="pop-in space-y-4 border-t border-line pt-4">
            {proposal?.emergency && <EmergencyBanner />}

            <div>
              <h3 className="font-semibold text-strong">
                {proposal?.reviewPrompt ?? tr("List the symptoms you want to record.", "Jo takleef darj karni hai uski fehrist banayein.")}
              </h3>
              <p className="mt-1 text-sm text-muted">
                {proposal
                  ? tr(
                      "This is what the assistant heard, not a medical record. Change anything that is wrong, remove anything you did not say, and add anything it missed.",
                      "Yeh woh hai jo assistant ne suna — medical record nahi. Jo ghalat hai badlein, jo aap ne nahi kaha usay hatayein, aur jo reh gaya usay shamil karein.",
                    )
                  : tr(
                      "Nothing has been saved yet. Add a row for each symptom, and remove any you do not want to record.",
                      "Abhi kuchh save nahi hua. Har takleef ke liye ek qatar barhayein, aur jo darj nahi karni usay hata dein.",
                    )}
              </p>
            </div>

            <ul className="space-y-3">
              {drafts.map((draft, index) => (
                <li
                  key={draft.key}
                  className="grid gap-3 rounded-xl border border-line bg-sunken/60 p-3 sm:grid-cols-[2fr_1fr_1fr_auto]"
                >
                  <Field label={tr("Symptom", "Takleef")} htmlFor={`symptom-${draft.key}`}>
                    <Input
                      id={`symptom-${draft.key}`}
                      value={draft.symptom}
                      maxLength={200}
                      onChange={(event) => update(draft.key, { symptom: event.target.value })}
                    />
                  </Field>
                  <Field label={tr("Severity", "Shiddat")} htmlFor={`severity-${draft.key}`}>
                    <Input
                      id={`severity-${draft.key}`}
                      value={draft.severity}
                      maxLength={50}
                      placeholder={tr("mild / severe", "halki / sakht")}
                      onChange={(event) => update(draft.key, { severity: event.target.value })}
                    />
                  </Field>
                  <Field label={tr("How long", "Kab se")} htmlFor={`duration-${draft.key}`}>
                    <Input
                      id={`duration-${draft.key}`}
                      value={draft.duration}
                      maxLength={100}
                      placeholder={tr("2 days", "2 din")}
                      onChange={(event) => update(draft.key, { duration: event.target.value })}
                    />
                  </Field>
                  <div className="flex items-end">
                    <Button
                      variant="ghost"
                      aria-label={`Remove ${draft.symptom || `symptom ${index + 1}`}`}
                      onClick={() => remove(draft.key)}
                    >
                      {tr("Remove", "Hatayein")}
                    </Button>
                  </div>
                </li>
              ))}
            </ul>

            <div className="flex flex-wrap gap-2">
              <Button
                variant="secondary"
                onClick={() => setDrafts((current) => [...current, draftOf()])}
              >
                <Icon name="add" className="text-[20px]" />
                {tr("Add a symptom", "Aur takleef likhein")}
              </Button>
              <Button disabled={busy || !usable} loading={busy} onClick={() => void confirm()}>
                {busy ? tr("Saving…", "Save ho raha hai…") : tr("This is correct — save it", "Yeh durust hai — save karein")}
              </Button>
            </div>

            <p className="text-sm text-muted">
              {tr(
                "Saved symptoms are your own account of how you feel. They are not a diagnosis, and a doctor decides what goes in your medical record.",
                "Save shuda takleef aap ka apna bayan hai. Yeh tashkhees nahi — medical record mein kya jayega, yeh doctor tay karta hai.",
              )}
            </p>

            {proposal && <Disclaimer text={proposal.disclaimer} />}
          </div>
        )}
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Consent, history, and the workspace
// ---------------------------------------------------------------------------

/**
 * Explains why the assistant is off, and — when the reason is consent — offers
 * the one control that turns it on.
 *
 * Consent is the patient's decision to make and to reverse, so the copy says
 * what it covers and that it can be withdrawn (spec §5, conflict C2).
 */
function ConsentGate({ status, onGranted }: { status: AssistantStatus; onGranted: () => void }) {
  const tr = useTr();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const grant = async () => {
    setBusy(true);
    setError(null);
    try {
      await patientsApi.setAiConsent(true);
      onGranted();
    } catch (caught) {
      setError(messageOf(caught, "Could not record your choice. Please try again."));
    } finally {
      setBusy(false);
    }
  };

  if (!status.providerConfigured) {
    return (
      <Card icon="smart_toy" title={tr("The assistant is unavailable", "Assistant dastyab nahi hai")}>
        <p className="text-muted">
          {status.reason ?? tr("The assistant is not configured on this server.", "Is server par assistant configure nahi hai.")}{" "}
          {tr(
            "Your appointments, records and documents are unaffected.",
            "Aap ki appointments, records aur documents par koi asar nahi.",
          )}
        </p>
      </Card>
    );
  }

  const points: [string, string, string][] = [
    [
      "cloud_upload",
      "To answer your questions, the assistant sends what you write — and a list of your current prescriptions and upcoming appointments — to an AI provider. Nothing is sent until you agree, and you can withdraw at any time from your profile.",
      "Jawab dene ke liye assistant aap ki likhi hui baat — aur maujooda nuskhon aur aane wali appointments ki fehrist — AI provider ko bhejta hai. Aap ki ijazat ke baghair kuchh nahi bheja jaata, aur aap kabhi bhi profile se ijazat wapas le sakte hain.",
    ],
    [
      "mic",
      "If you use the microphone, your browser turns your speech into text on your device and MediSense never receives the recording. Most browsers use their own online service to do that, so the audio reaches the browser's provider rather than ours. You can always type instead.",
      "Microphone istemal karein to aap ka browser awaaz ko isi device par likhai mein badalta hai — MediSense ko recording kabhi nahi milti. Aksar browsers iske liye apni online service istemal karte hain, is liye audio browser ke provider tak jaati hai, hum tak nahi. Aap hamesha likh bhi sakte hain.",
    ],
    [
      "add_photo_alternate",
      "If you attach a photo of a report, it is read for that one answer and not saved anywhere.",
      "Report ki tasveer lagayein to woh sirf us jawab ke liye parhi jaati hai, kahin save nahi hoti.",
    ],
    [
      "medical_information",
      "The assistant gives general guidance. It does not diagnose, and it never replaces your doctor.",
      "Assistant sirf aam rehnumai deta hai. Yeh tashkhees nahi karta, aur kabhi doctor ki jagah nahi leta.",
    ],
  ];

  return (
    <div className="mx-auto max-w-2xl">
      <Card className="card-thread">
        <div className="flex flex-col items-center text-center">
          <AssistantAvatar className="h-16 w-16 [&>span]:text-[32px]" />
          <h2 className="mt-4 font-display text-2xl font-bold text-strong">
            {tr("Turn on the health assistant", "Health assistant chalu karein")}
          </h2>
          <p className="mt-1 text-muted">
            {tr("Here is what it does with what you tell it.", "Aap jo batayenge, uske saath yeh kya karta hai — yahan likha hai.")}
          </p>
        </div>
        <ul className="mt-6 space-y-4">
          {points.map(([icon, en, ur]) => (
            <li key={icon} className="flex gap-3">
              <span
                aria-hidden
                className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-primary-soft text-primary"
              >
                <Icon name={icon} className="text-[22px]" />
              </span>
              <p className="text-[15px] leading-relaxed text-muted">{tr(en, ur)}</p>
            </li>
          ))}
        </ul>
        {error && <div className="mt-4"><ErrorState message={error} /></div>}
        <div className="mt-6 flex justify-center">
          <Button size="lg" loading={busy} onClick={() => void grant()}>
            {busy ? tr("Saving…", "Save ho raha hai…") : tr("I agree — turn it on", "Main razi hoon — chalu karein")}
          </Button>
        </div>
      </Card>
    </div>
  );
}

interface Conversation {
  sessionId: string;
  title: string;
  updatedAt: string;
  turns: Turn[];
}

/** History rows, grouped into conversations, newest first. */
function groupConversations(rows: AssistantTurn[], disclaimer: string): Conversation[] {
  const byId = new Map<string, Conversation>();
  // Rows arrive newest first; walk them oldest first so turns read in order.
  for (const row of [...rows].reverse()) {
    const turn = turnFromHistory(row, disclaimer);
    const existing = byId.get(row.sessionId);
    if (existing) {
      existing.turns.push(turn);
      existing.updatedAt = row.createdAt;
    } else {
      byId.set(row.sessionId, {
        sessionId: row.sessionId,
        title: turn.question,
        updatedAt: row.createdAt,
        turns: [turn],
      });
    }
  }
  return [...byId.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function whenLabel(iso: string, tr: (en: string, ur: string) => string): string {
  const then = new Date(iso);
  const today = new Date();
  const sameDay = then.toDateString() === today.toDateString();
  if (sameDay) return tr("Today", "Aaj");
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (then.toDateString() === yesterday.toDateString()) return tr("Yesterday", "Kal");
  return then.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

type Mode = { kind: "chat"; sessionId: string | null } | { kind: "symptoms" };

/** The assistant page's body: status gate, then the conversation workspace. */
export function AssistantPanels({ prefill = "" }: { prefill?: string } = {}) {
  const tr = useTr();
  const status = useAsync(() => assistantApi.status(), []);
  const history = useAsync(
    () => (status.data?.available ? assistantApi.history({ limit: 100 }) : Promise.resolve([])),
    [status.data?.available],
  );
  const disclaimer = status.data?.disclaimer ?? "";

  /**
   * Turns answered during this visit, by session. The list on screen is the
   * fetched history with these laid over it — derived, never copied — so no
   * effect has to keep two states in step and no second round trip is needed.
   */
  const [added, setAdded] = useState<Record<string, { turns: Turn[]; updatedAt: string }>>({});
  const [mode, setMode] = useState<Mode>({ kind: "chat", sessionId: null });
  const [drawer, setDrawer] = useState(false);

  const loaded = history.data;
  const conversations = useMemo<Conversation[] | null>(() => {
    if (!loaded && Object.keys(added).length === 0) return null;
    const base = loaded ? groupConversations(loaded, disclaimer) : [];
    for (const [sessionId, extra] of Object.entries(added)) {
      const existing = base.find((conversation) => conversation.sessionId === sessionId);
      if (existing) {
        existing.turns = [...existing.turns, ...extra.turns];
        existing.updatedAt = extra.updatedAt;
      } else {
        base.push({
          sessionId,
          title: extra.turns[0]?.question ?? "",
          updatedAt: extra.updatedAt,
          turns: extra.turns,
        });
      }
    }
    return base.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }, [loaded, added, disclaimer]);

  const onTurn = useCallback((sessionId: string, turn: Turn) => {
    const stamp = new Date().toISOString();
    setAdded((current) => ({
      ...current,
      [sessionId]: {
        turns: [...(current[sessionId]?.turns ?? []), turn],
        updatedAt: stamp,
      },
    }));
    setMode((current) =>
      current.kind === "chat" && current.sessionId === null
        ? { kind: "chat", sessionId }
        : current,
    );
  }, []);

  if (status.loading) return <Loading label={tr("Checking the assistant", "Assistant check ho raha hai")} />;
  if (status.error) return <ErrorState message={status.error.message} onRetry={status.reload} />;
  if (!status.data) return null;

  if (!status.data.available) {
    return <ConsentGate status={status.data} onGranted={status.reload} />;
  }

  const active =
    mode.kind === "chat" && mode.sessionId
      ? conversations?.find((conversation) => conversation.sessionId === mode.sessionId)
      : undefined;

  const openChat = (sessionId: string | null) => {
    setMode({ kind: "chat", sessionId });
    setDrawer(false);
  };

  const sidebar = (
    <div className="flex h-full flex-col">
      <div className="space-y-2 p-3">
        <button
          type="button"
          onClick={() => openChat(null)}
          className="flex min-h-11 w-full items-center gap-2 rounded-xl bg-primary px-3 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-primary-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
        >
          <Icon name="add_comment" className="text-[20px]" />
          {tr("New chat", "Nayi baat-cheet")}
        </button>
        <button
          type="button"
          aria-pressed={mode.kind === "symptoms"}
          onClick={() => {
            setMode({ kind: "symptoms" });
            setDrawer(false);
          }}
          className={cx(
            "flex min-h-11 w-full items-center gap-2 rounded-xl border px-3 text-sm font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary",
            mode.kind === "symptoms"
              ? "border-accent bg-accent-soft text-accent"
              : "border-line-strong bg-card text-strong hover:bg-sunken",
          )}
        >
          <Icon name="stethoscope" className="text-[20px]" />
          {tr("Symptom check", "Takleef ka jaiza")}
        </button>
      </div>

      <p className="px-4 pb-1 pt-2 text-[11px] font-bold uppercase tracking-[0.14em] text-faint">
        {tr("Recent", "Haal hi mein")}
      </p>
      <nav aria-label={tr("Conversations", "Baat-cheet")} className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {conversations === null && (
          <div className="space-y-2 p-2" aria-hidden>
            <span className="skeleton block h-10" />
            <span className="skeleton block h-10" />
            <span className="skeleton block h-10" />
          </div>
        )}
        {conversations?.length === 0 && (
          <p className="px-2 py-4 text-sm text-faint">
            {tr("Your conversations will appear here.", "Aap ki baat-cheet yahan nazar aayegi.")}
          </p>
        )}
        <ul className="space-y-0.5">
          {conversations?.map((conversation) => {
            const current = mode.kind === "chat" && mode.sessionId === conversation.sessionId;
            return (
              <li key={conversation.sessionId}>
                <button
                  type="button"
                  aria-current={current ? "true" : undefined}
                  onClick={() => openChat(conversation.sessionId)}
                  className={cx(
                    "flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary",
                    current ? "bg-primary-soft" : "hover:bg-sunken",
                  )}
                >
                  <Icon
                    name="chat_bubble"
                    filled={current}
                    className={cx("mt-0.5 shrink-0 text-[18px]", current ? "text-primary" : "text-faint")}
                  />
                  <span className="min-w-0 flex-1">
                    <span className={cx("block truncate text-sm", current ? "font-semibold text-primary" : "text-strong")}>
                      {conversation.title}
                    </span>
                    <span className="block text-[11px] text-faint">
                      {whenLabel(conversation.updatedAt, tr)} · {conversation.turns.length}{" "}
                      {tr(conversation.turns.length === 1 ? "message" : "messages", conversation.turns.length === 1 ? "paigham" : "paighamat")}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </nav>
    </div>
  );

  return (
    <div className="flex h-[calc(100dvh-11.5rem)] min-h-[560px] overflow-hidden rounded-2xl border border-line bg-canvas shadow-card">
      {/* Desktop sidebar */}
      <aside className="hidden w-72 shrink-0 border-r border-line bg-card lg:block">{sidebar}</aside>

      {/* Mobile drawer */}
      {drawer && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <button
            type="button"
            aria-label={tr("Close conversations", "Baat-cheet band karein")}
            className="absolute inset-0 bg-black/50"
            onClick={() => setDrawer(false)}
          />
          <aside className="relative h-full w-80 max-w-[85%] bg-card shadow-overlay">{sidebar}</aside>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-2 border-b border-line bg-card/80 px-3 py-2 backdrop-blur sm:px-5">
          <button
            type="button"
            aria-label={tr("Open conversations", "Baat-cheet kholein")}
            onClick={() => setDrawer(true)}
            className="grid h-10 w-10 place-items-center rounded-full text-muted hover:bg-sunken lg:hidden"
          >
            <Icon name="history" className="text-[22px]" />
          </button>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold text-strong">
              {mode.kind === "symptoms"
                ? tr("Symptom check", "Takleef ka jaiza")
                : (active?.title ?? tr("New chat", "Nayi baat-cheet"))}
            </p>
            <p className="text-[11px] text-faint">
              {tr("MediSense assistant · guidance, not diagnosis", "MediSense assistant · rehnumai, tashkhees nahi")}
            </p>
          </div>
          <span className="hidden items-center gap-1.5 rounded-full bg-stable-soft px-2.5 py-1 text-[11px] font-semibold text-stable sm:inline-flex">
            <span aria-hidden className="animate-breathe h-1.5 w-1.5 rounded-full bg-stable" />
            {tr("Online", "Online")}
          </span>
        </div>

        <div className="min-h-0 flex-1">
          {mode.kind === "symptoms" ? (
            <div className="h-full overflow-y-auto p-3 sm:p-6">
              <div className="mx-auto max-w-3xl">
                <SymptomReview />
              </div>
            </div>
          ) : (
            <AssistantChat
              key={mode.sessionId ?? "new"}
              sessionId={mode.sessionId ?? undefined}
              initialTurns={active?.turns ?? []}
              prefill={mode.sessionId ? "" : prefill}
              onTurn={onTurn}
            />
          )}
        </div>
      </div>
    </div>
  );
}
