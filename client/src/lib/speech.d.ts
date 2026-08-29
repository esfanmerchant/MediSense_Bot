/**
 * Web Speech API recognition types.
 *
 * TypeScript's DOM library ships `SpeechRecognitionResult`,
 * `SpeechRecognitionResultList` and `SpeechRecognitionAlternative`, but not the
 * `SpeechRecognition` constructor or its events — recognition is still a draft
 * spec and browsers implement it behind a prefix. These declarations cover only
 * what `useSpeechRecognition` actually touches; they are not a complete port,
 * and they are named `…Like` so they cannot collide with the real definitions
 * if a future TypeScript release adds them.
 *
 * Everything lives inside `declare global` on purpose: the `export {}` needed
 * to make `declare global` legal also turns this file into a module, and
 * anything declared outside the block would then be invisible to its callers.
 *
 * Declaring the constructors as optional is likewise deliberate. Neither exists
 * in Firefox, so code that reads them must handle `undefined`; a non-optional
 * declaration would let the compiler wave through the exact crash this feature
 * has to avoid.
 */

declare global {
  interface SpeechRecognitionAlternativeLike {
    readonly transcript: string;
    readonly confidence: number;
  }

  interface SpeechRecognitionResultLike {
    readonly isFinal: boolean;
    readonly length: number;
    [index: number]: SpeechRecognitionAlternativeLike;
  }

  interface SpeechRecognitionResultListLike {
    readonly length: number;
    [index: number]: SpeechRecognitionResultLike;
  }

  interface SpeechRecognitionEventLike extends Event {
    readonly resultIndex: number;
    readonly results: SpeechRecognitionResultListLike;
  }

  interface SpeechRecognitionErrorEventLike extends Event {
    /** "not-allowed", "no-speech", "audio-capture", "network", "aborted", … */
    readonly error: string;
    readonly message: string;
  }

  interface SpeechRecognitionLike extends EventTarget {
    lang: string;
    continuous: boolean;
    interimResults: boolean;
    maxAlternatives: number;
    start(): void;
    stop(): void;
    abort(): void;
    onresult: ((event: SpeechRecognitionEventLike) => void) | null;
    onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
    onend: (() => void) | null;
    onstart: (() => void) | null;
  }

  interface Window {
    SpeechRecognition?: new () => SpeechRecognitionLike;
    webkitSpeechRecognition?: new () => SpeechRecognitionLike;
  }
}

export {};
