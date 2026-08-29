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
 */

import Link from "next/link";
import { useState } from "react";

import { Badge, Button, Card, EmptyState, ErrorState, Field, Input, Loading } from "@/components/ui";
import {
  ApiError,
  assistant as assistantApi,
  patients as patientsApi,
  type AssistantAnswer,
  type AssistantStatus,
  type ConfirmedSymptom,
  type InputType,
  type SymptomProposal,
  type Urgency,
} from "@/lib/api";
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

const URGENCY_LABEL: Record<Urgency, string> = {
  EMERGENCY: "Seek care now",
  URGENT: "See a doctor today",
  ROUTINE: "Routine",
  INFORMATION: "Information",
};

/**
 * The banner an emergency answer opens with.
 *
 * `role="alert"` rather than colour alone: someone using a screen reader has to
 * hear this, and someone who cannot distinguish red from grey has to see it.
 */
function EmergencyBanner() {
  return (
    <div
      role="alert"
      className="rounded-md border-2 border-critical bg-critical-soft px-4 py-3"
    >
      <p className="font-semibold text-critical">
        This may need emergency care
      </p>
      <p className="mt-1 text-sm text-strong">
        Do not wait for a reply here. Call your local emergency number or go to the nearest
        emergency department.
      </p>
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
    <p className="mt-3 border-t border-line pt-3 text-xs text-muted">
      {text}
    </p>
  );
}

function AnswerBody({ answer }: { answer: AssistantAnswer }) {
  return (
    <div className="space-y-3">
      {answer.emergency && <EmergencyBanner />}

      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={URGENCY_TONE[answer.urgency]}>{URGENCY_LABEL[answer.urgency]}</Badge>
        {answer.suggestedDepartment && (
          <Badge tone="neutral">Suggested: {answer.suggestedDepartment}</Badge>
        )}
      </div>

      {/* whitespace-pre-line: the model writes short paragraphs and they carry
          meaning — an escalation is deliberately its own paragraph. */}
      <p className="whitespace-pre-line text-strong">{answer.answer}</p>

      {!answer.emergency && answer.urgency !== "INFORMATION" && (
        <Link
          href="/patient/appointments"
          className="inline-flex min-h-11 items-center text-sm font-medium text-teal-800 underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
        >
          Book an appointment
        </Link>
      )}

      <Disclaimer text={answer.disclaimer} />
    </div>
  );
}

/**
 * The microphone control from spec §20: "[ 🎤 Speak your symptoms ]".
 *
 * Built for the people it is for. Recognition exists so that someone who
 * struggles to type can still describe how they feel, so the control is a large
 * target, keyboard-operable like any button, and announces its own state rather
 * than signalling only through colour. Where the browser cannot do this at all,
 * it says so plainly instead of rendering a button that does nothing.
 */
function VoiceInput({
  label,
  subject,
  onTranscript,
  disabled,
}: {
  /** What the button offers to do, e.g. "Speak your symptoms". */
  label: string;
  /** What the patient would otherwise type — used in the fallback message. */
  subject: string;
  onTranscript: (settled: string) => void;
  disabled: boolean;
}) {
  const speech = useSpeechRecognition(onTranscript);

  if (speech.state === "unsupported") {
    return (
      <p className="text-sm text-muted">
        This browser cannot listen for speech. Chrome, Edge and Safari can — or you can type{" "}
        {subject} below.
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
      >
        <span aria-hidden>{listening ? "⏹" : "🎤"}</span>
        {listening ? "Stop listening" : label}
      </Button>

      {/* Announced, not merely animated: a patient who cannot see the button
          change colour still needs to know the microphone is live. */}
      <p role="status" aria-live="polite" className="text-sm text-muted">
        {listening
          ? "Listening. Speak normally — your words appear below, and you can edit them before anything is sent."
          : "Your speech is turned into text on this device. The recording is never sent to MediSense."}
      </p>

      {speech.interim && (
        <p className="text-sm italic text-faint">{speech.interim}…</p>
      )}

      {speech.error && <ErrorState title="Microphone" message={speech.error} />}
    </div>
  );
}

interface Turn {
  id: string;
  question: string;
  answer: AssistantAnswer;
}

/**
 * Conversation with the assistant.
 *
 * Turns are held in local state and only appended from the send handler. The
 * server keeps its own history (and is the record of what was said); this list
 * is just what is on screen since the page opened.
 */
export function AssistantChat() {
  const [question, setQuestion] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [sessionId, setSessionId] = useState<string | undefined>(undefined);
  const [dictated, setDictated] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const appendTranscript = (settled: string) => {
    setDictated(true);
    setQuestion((current) => (current ? `${current} ${settled}` : settled).slice(0, 2000));
  };

  const send = async () => {
    const message = question.trim();
    if (!message || busy) return;

    setBusy(true);
    setError(null);
    try {
      const answer = await assistantApi.chat({
        message,
        sessionId,
        inputType: dictated ? "VOICE" : "TEXT",
      });
      setSessionId(answer.sessionId);
      setTurns((current) => [
        ...current,
        { id: answer.sessionId + current.length, question: message, answer },
      ]);
      setQuestion("");
      setDictated(false);
    } catch (caught) {
      setError(messageOf(caught, "Could not reach the assistant. Please try again."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      title="Ask about your care"
      description="Questions about your prescriptions, your appointments, or which department to see."
    >
      <div className="space-y-4">
        {turns.length === 0 && (
          <EmptyState
            title="No questions yet"
            description="Try “what is my blood pressure tablet for?” or “which department should I see for a persistent cough?”"
          />
        )}

        {/* aria-live so each new answer is announced without moving focus away
            from the input the patient is still using. */}
        <ol aria-live="polite" className="space-y-4">
          {turns.map((turn) => (
            <li key={turn.id} className="space-y-3">
              <p className="ml-auto max-w-[85%] rounded-lg bg-accent-soft px-4 py-2.5 text-strong  ">
                {turn.question}
              </p>
              <div className="max-w-[95%] rounded-lg border border-line bg-canvas px-4 py-3 /60">
                <AnswerBody answer={turn.answer} />
              </div>
            </li>
          ))}
        </ol>

        {busy && <Loading label="Thinking" />}
        {error && <ErrorState message={error} />}

        <VoiceInput
          label="Speak your question"
          subject="your question"
          onTranscript={appendTranscript}
          disabled={busy}
        />

        <form
          className="flex flex-col gap-2 sm:flex-row"
          onSubmit={(event) => {
            event.preventDefault();
            void send();
          }}
        >
          <Input
            id="assistant-question"
            aria-label="Your question"
            placeholder="Type your question"
            maxLength={2000}
            value={question}
            disabled={busy}
            onChange={(event) => setQuestion(event.target.value)}
          />
          <Button type="submit" disabled={busy || !question.trim()}>
            Send
          </Button>
        </form>
      </div>
    </Card>
  );
}

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
  const inputType: InputType = dictated ? "VOICE" : "TEXT";

  /** Appends settled speech to whatever the patient has already written. */
  const appendTranscript = (settled: string) => {
    setDictated(true);
    setText((current) => (current ? `${current} ${settled}` : settled).slice(0, 2000));
  };

  return (
    <Card
      title="Describe your symptoms"
      description="Speak or type, in your own words. You will get to correct everything before anything is saved."
    >
      <div className="space-y-4">
        <VoiceInput
          label="Speak your symptoms"
          subject="your symptoms"
          onTranscript={appendTranscript}
          disabled={busy}
        />

        <Field
          label="What are you experiencing?"
          htmlFor="symptom-text"
          hint={
            dictated
              ? "This is what was heard. Correct anything that is wrong before continuing."
              : "For example: “headache since yesterday, worse in the morning, and some dizziness.”"
          }
        >
          <textarea
            id="symptom-text"
            rows={4}
            maxLength={2000}
            value={text}
            disabled={busy}
            onChange={(event) => setText(event.target.value)}
            className="block w-full rounded-md border border-line-strong bg-card px-3 py-2.5 text-base text-strong placeholder:text-faint focus:outline-2 focus:outline-offset-0 focus:outline-primary"
          />
        </Field>

        <Button disabled={busy || !text.trim()} onClick={() => void analyse()}>
          {busy && !reviewing ? "Reading…" : "Review my symptoms"}
        </Button>

        {error && <ErrorState message={error} />}

        {saved && (
          <div
            role="status"
            className="rounded-md border border-stable/40 bg-stable-soft px-4 py-3 text-sm text-stable"
          >
            {saved}
          </div>
        )}

        {reviewing && (
          <div className="space-y-4 border-t border-line pt-4">
            {proposal?.emergency && <EmergencyBanner />}

            <div>
              <h3 className="font-medium text-strong">
                {proposal?.reviewPrompt ?? "List the symptoms you want to record."}
              </h3>
              <p className="mt-1 text-sm text-muted">
                {proposal
                  ? "This is what the assistant heard, not a medical record. Change anything that is wrong, remove anything you did not say, and add anything it missed."
                  : "Nothing has been saved yet. Add a row for each symptom, and remove any you do not want to record."}
              </p>
            </div>

            <ul className="space-y-3">
              {drafts.map((draft, index) => (
                <li
                  key={draft.key}
                  className="grid gap-3 rounded-md border border-line p-3 sm:grid-cols-[2fr_1fr_1fr_auto] "
                >
                  <Field label="Symptom" htmlFor={`symptom-${draft.key}`}>
                    <Input
                      id={`symptom-${draft.key}`}
                      value={draft.symptom}
                      maxLength={200}
                      onChange={(event) => update(draft.key, { symptom: event.target.value })}
                    />
                  </Field>
                  <Field label="Severity" htmlFor={`severity-${draft.key}`}>
                    <Input
                      id={`severity-${draft.key}`}
                      value={draft.severity}
                      maxLength={50}
                      placeholder="mild / severe"
                      onChange={(event) => update(draft.key, { severity: event.target.value })}
                    />
                  </Field>
                  <Field label="How long" htmlFor={`duration-${draft.key}`}>
                    <Input
                      id={`duration-${draft.key}`}
                      value={draft.duration}
                      maxLength={100}
                      placeholder="2 days"
                      onChange={(event) => update(draft.key, { duration: event.target.value })}
                    />
                  </Field>
                  <div className="flex items-end">
                    <Button
                      variant="ghost"
                      aria-label={`Remove ${draft.symptom || `symptom ${index + 1}`}`}
                      onClick={() => remove(draft.key)}
                    >
                      Remove
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
                Add a symptom
              </Button>
              <Button disabled={busy || !usable} onClick={() => void confirm()}>
                {busy ? "Saving…" : "This is correct — save it"}
              </Button>
            </div>

            <p className="text-sm text-muted">
              Saved symptoms are your own account of how you feel. They are not a diagnosis, and a
              doctor decides what goes in your medical record.
            </p>

            {proposal && <Disclaimer text={proposal.disclaimer} />}
          </div>
        )}
      </div>
    </Card>
  );
}

/**
 * Explains why the assistant is off, and — when the reason is consent — offers
 * the one control that turns it on.
 *
 * Consent is the patient's decision to make and to reverse, so the copy says
 * what it covers and that it can be withdrawn (spec §5, conflict C2).
 */
function ConsentGate({ status, onGranted }: { status: AssistantStatus; onGranted: () => void }) {
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
      <Card title="The assistant is unavailable">
        <p className="text-muted">
          {status.reason ?? "The assistant is not configured on this server."} Your appointments,
          records and documents are unaffected.
        </p>
      </Card>
    );
  }

  return (
    <Card title="Turn on the health assistant">
      <div className="space-y-4">
        <p className="text-muted">
          To answer your questions, the assistant sends what you write — and a list of your current
          prescriptions and upcoming appointments — to an AI provider. Nothing is sent until you
          agree, and you can withdraw at any time from your profile.
        </p>
        <p className="text-muted">
          If you use the microphone, your browser turns your speech into text on your device and
          MediSense never receives the recording. Most browsers use their own online service to do
          that, so the audio reaches the browser&rsquo;s provider rather than ours. You can always
          type instead.
        </p>
        <p className="text-muted">
          The assistant gives general guidance. It does not diagnose, and it never replaces your
          doctor.
        </p>
        {error && <ErrorState message={error} />}
        <Button disabled={busy} onClick={() => void grant()}>
          {busy ? "Saving…" : "I agree — turn it on"}
        </Button>
      </div>
    </Card>
  );
}

/** The assistant page's body: status gate, then chat and symptom review. */
export function AssistantPanels() {
  const status = useAsync(() => assistantApi.status(), []);

  if (status.loading) return <Loading label="Checking the assistant" />;
  if (status.error) return <ErrorState message={status.error.message} onRetry={status.reload} />;
  if (!status.data) return null;

  if (!status.data.available) {
    return <ConsentGate status={status.data} onGranted={status.reload} />;
  }

  return (
    <div className="space-y-6">
      <AssistantChat />
      <SymptomReview />
    </div>
  );
}
