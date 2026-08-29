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
      className="rounded-md border-2 border-critical bg-critical-soft px-4 py-3"
    >
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
  const tr = useTr();
  return (
    <div className="space-y-3">
      {answer.emergency && <EmergencyBanner />}

      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={URGENCY_TONE[answer.urgency]}>{tr(...URGENCY_LABEL[answer.urgency])}</Badge>
        {answer.suggestedDepartment && (
          <Badge tone="neutral">{tr("Suggested:", "Tajweez:")} {answer.suggestedDepartment}</Badge>
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
          {tr("Book an appointment", "Appointment book karein")}
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
  const tr = useTr();
  const speech = useSpeechRecognition(onTranscript);

  if (speech.state === "unsupported") {
    return (
      <p className="text-sm text-muted">
        {tr(
          "This browser cannot listen for speech. Chrome, Edge and Safari can — or you can type",
          "Yeh browser awaaz nahi sun sakta. Chrome, Edge aur Safari sun sakte hain — ya aap neeche likh sakte hain:",
        )}{" "}
        {subject}
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
        {listening ? tr("Stop listening", "Sunna band karein") : label}
      </Button>

      {/* Announced, not merely animated: a patient who cannot see the button
          change colour still needs to know the microphone is live. */}
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

      {speech.interim && (
        <p className="text-sm italic text-faint">{speech.interim}…</p>
      )}

      {speech.error && <ErrorState title={tr("Microphone", "Microphone")} message={speech.error} />}
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
  const tr = useTr();
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
      title={tr("Ask about your care", "Apne ilaaj ke baare mein poochein")}
      description={tr(
        "Questions about your prescriptions, your appointments, or which department to see.",
        "Apne nuskhon, appointments, ya kis department ko dikhana hai — is baare mein sawal karein.",
      )}
    >
      <div className="space-y-4">
        {turns.length === 0 && (
          <EmptyState
            title={tr("No questions yet", "Abhi koi sawal nahi")}
            description={tr(
              "Try “what is my blood pressure tablet for?” or “which department should I see for a persistent cough?”",
              "Misal ke taur par poochein: “meri blood pressure ki goli kis liye hai?” ya “purani khansi ke liye kaunsa department dekhun?”",
            )}
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

        {busy && <Loading label={tr("Thinking", "Soch raha hai")} />}
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
            aria-label={tr("Your question", "Aap ka sawal")}
            placeholder={tr("Type your question", "Apna sawal likhein")}
            maxLength={2000}
            value={question}
            disabled={busy}
            onChange={(event) => setQuestion(event.target.value)}
          />
          <Button type="submit" disabled={busy || !question.trim()}>
            {tr("Send", "Bhejein")}
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
      title={tr("Describe your symptoms", "Apni takleef batayein")}
      description={tr(
        "Speak or type, in your own words. You will get to correct everything before anything is saved.",
        "Bol kar ya likh kar, apne alfaz mein. Save hone se pehle aap har cheez durust kar sakenge.",
      )}
    >
      <div className="space-y-4">
        <VoiceInput
          label="Speak your symptoms"
          subject="your symptoms"
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
            className="block w-full rounded-md border border-line-strong bg-card px-3 py-2.5 text-base text-strong placeholder:text-faint focus:outline-2 focus:outline-offset-0 focus:outline-primary"
          />
        </Field>

        <Button disabled={busy || !text.trim()} onClick={() => void analyse()}>
          {busy && !reviewing
            ? tr("Reading…", "Parha ja raha hai…")
            : tr("Review my symptoms", "Meri takleef ka jaiza lein")}
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
                  className="grid gap-3 rounded-md border border-line p-3 sm:grid-cols-[2fr_1fr_1fr_auto] "
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
                {tr("Add a symptom", "Aur takleef likhein")}
              </Button>
              <Button disabled={busy || !usable} onClick={() => void confirm()}>
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
      <Card title={tr("The assistant is unavailable", "Assistant dastyab nahi hai")}>
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

  return (
    <Card title={tr("Turn on the health assistant", "Health assistant chalu karein")}>
      <div className="space-y-4">
        <p className="text-muted">
          {tr(
            "To answer your questions, the assistant sends what you write — and a list of your current prescriptions and upcoming appointments — to an AI provider. Nothing is sent until you agree, and you can withdraw at any time from your profile.",
            "Jawab dene ke liye assistant aap ki likhi hui baat — aur maujooda nuskhon aur aane wali appointments ki fehrist — AI provider ko bhejta hai. Aap ki ijazat ke baghair kuchh nahi bheja jaata, aur aap kabhi bhi profile se ijazat wapas le sakte hain.",
          )}
        </p>
        <p className="text-muted">
          {tr(
            "If you use the microphone, your browser turns your speech into text on your device and MediSense never receives the recording. Most browsers use their own online service to do that, so the audio reaches the browser's provider rather than ours. You can always type instead.",
            "Microphone istemal karein to aap ka browser awaaz ko isi device par likhai mein badalta hai — MediSense ko recording kabhi nahi milti. Aksar browsers iske liye apni online service istemal karte hain, is liye audio browser ke provider tak jaati hai, hum tak nahi. Aap hamesha likh bhi sakte hain.",
          )}
        </p>
        <p className="text-muted">
          {tr(
            "The assistant gives general guidance. It does not diagnose, and it never replaces your doctor.",
            "Assistant sirf aam rehnumai deta hai. Yeh tashkhees nahi karta, aur kabhi doctor ki jagah nahi leta.",
          )}
        </p>
        {error && <ErrorState message={error} />}
        <Button disabled={busy} onClick={() => void grant()}>
          {busy ? tr("Saving…", "Save ho raha hai…") : tr("I agree — turn it on", "Main razi hoon — chalu karein")}
        </Button>
      </div>
    </Card>
  );
}

/** The assistant page's body: status gate, then chat and symptom review. */
export function AssistantPanels() {
  const tr = useTr();
  const status = useAsync(() => assistantApi.status(), []);

  if (status.loading) return <Loading label={tr("Checking the assistant", "Assistant check ho raha hai")} />;
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
