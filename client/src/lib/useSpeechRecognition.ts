"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

import { getLang } from "@/lib/lang";

/**
 * Speech-to-text through the browser, for spec §20's voice symptom input.
 *
 * **Why the browser and not the server.** Recognition runs on the patient's own
 * device: the audio never reaches MediSense, is never stored, and never passes
 * through the Gemini key. Uploading recordings to the server for transcription
 * would mean holding patient audio and paying per call, for strictly worse
 * privacy. The transcript — text the patient can read and edit — is the only
 * thing that leaves this hook.
 *
 * **The hook does not keep the transcript.** Settled speech is handed to
 * `onTranscript` and forgotten. The spec requires the patient to edit the
 * transcript before analysis, so it has to live in the field they are editing;
 * keeping a second copy here would mean two sources of truth and an edit that
 * the next spoken word silently overwrites.
 *
 * **Support is genuinely partial**, and this feature exists for people who have
 * difficulty typing, so a microphone button that silently does nothing is worse
 * than no button at all. `supported` is reported honestly and callers are
 * expected to say so rather than render a dead control. Chrome, Edge and Safari
 * implement recognition; Firefox does not.
 */

export type SpeechState = "unsupported" | "idle" | "listening" | "error";

interface SpeechRecognitionState {
  supported: boolean;
  state: SpeechState;
  /** The engine's current guess, not yet settled. Shown greyed, never saved. */
  interim: string;
  error: string | null;
  start: () => void;
  stop: () => void;
}

/** Phrases a worried person can act on, rather than the spec's error codes.

Reads the language store directly instead of a hook: this runs inside a browser
event callback, not a render. */
function describe(code: string): string {
  const t = (en: string, ur: string) => (getLang() === "ur" ? ur : en);
  switch (code) {
    case "not-allowed":
    case "service-not-allowed":
      return t(
        "Microphone access was blocked. Allow it in your browser's address bar, or type instead.",
        "Microphone ki ijazat nahi mili. Browser ke address bar se ijazat dein, ya likh lein.",
      );
    case "no-speech":
      return t(
        "I did not hear anything. Try again, or type instead.",
        "Kuchh sunai nahi diya. Dobara koshish karein, ya likh lein.",
      );
    case "audio-capture":
      return t(
        "No microphone was found. Check it is connected, or type instead.",
        "Koi microphone nahi mila. Connection check karein, ya likh lein.",
      );
    case "network":
      return t(
        "Speech recognition needs a connection and could not reach it. You can type instead.",
        "Awaaz samajhne ke liye internet chahiye tha jo nahi mila. Aap likh sakte hain.",
      );
    case "aborted":
      // Usually the patient pressing stop; not worth alarming them about.
      return "";
    default:
      return t(
        "Speech recognition stopped unexpectedly. You can type instead.",
        "Awaaz samajhna achanak ruk gaya. Aap likh sakte hain.",
      );
  }
}

/** Whether this browser can transcribe at all. Constant for the page's life. */
const subscribe = () => () => {};
const hasRecognition = () =>
  Boolean(window.SpeechRecognition ?? window.webkitSpeechRecognition);

export function useSpeechRecognition(
  onTranscript: (settled: string) => void,
  lang = "en-IN",
): SpeechRecognitionState {
  // Read through `useSyncExternalStore` rather than seeded from an effect. The
  // server has no `window`, so the server snapshot is `false` and React
  // reconciles the difference on hydration — where setting state in an effect
  // would instead cause the cascading re-render React 19 rejects.
  const supported = useSyncExternalStore(subscribe, hasRecognition, () => false);
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState("");
  const [error, setError] = useState<string | null>(null);

  const recognition = useRef<SpeechRecognitionLike | null>(null);

  // Held in a ref so a caller that passes an inline function does not tear down
  // and rebuild the recognition instance — which would drop the microphone
  // mid-sentence on every render.
  const callback = useRef(onTranscript);
  useEffect(() => {
    callback.current = onTranscript;
  });

  useEffect(() => {
    const Recognition = window.SpeechRecognition ?? window.webkitSpeechRecognition;
    if (!Recognition) return;

    const instance = new Recognition();
    instance.lang = lang;
    // Keep listening through the pauses in "since yesterday… I have a fever".
    instance.continuous = true;
    instance.interimResults = true;
    instance.maxAlternatives = 1;

    instance.onresult = (event) => {
      let settled = "";
      let pending = "";
      // `resultIndex` marks where this event's changes begin; everything before
      // it has already been handed over and must not be sent again.
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        if (result.isFinal) settled += result[0].transcript;
        else pending += result[0].transcript;
      }
      if (settled.trim()) callback.current(settled.trim());
      setInterim(pending);
    };

    instance.onerror = (event) => {
      const message = describe(event.error);
      if (message) setError(message);
      setListening(false);
      setInterim("");
    };

    instance.onend = () => {
      setListening(false);
      setInterim("");
    };

    recognition.current = instance;

    return () => {
      instance.onresult = null;
      instance.onerror = null;
      instance.onend = null;
      // Release the microphone if the page navigates away mid-sentence.
      instance.abort();
      recognition.current = null;
    };
  }, [lang]);

  const start = useCallback(() => {
    if (!recognition.current) return;
    setError(null);
    setInterim("");
    try {
      recognition.current.start();
    } catch {
      // start() throws if it is already running, which is not a failure.
    }
    setListening(true);
  }, []);

  const stop = useCallback(() => {
    recognition.current?.stop();
    setListening(false);
  }, []);

  const state: SpeechState = !supported
    ? "unsupported"
    : error
      ? "error"
      : listening
        ? "listening"
        : "idle";

  return { supported, state, interim, error, start, stop };
}
