import "@testing-library/jest-dom/vitest";

import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

// Each test starts with an empty document; a leaked tree from the previous one
// makes queries match the wrong element and the failure look unrelated.
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// jsdom implements neither. Components that use them must still render.
if (!window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

class NoopEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  addEventListener(): void {}
  removeEventListener(): void {}
  close(): void {}
}

// The live alert feed opens one of these on mount. Without a stub, jsdom throws
// and the component never renders — which would look like a component bug.
if (!("EventSource" in window)) {
  (window as unknown as { EventSource: unknown }).EventSource = NoopEventSource;
}

// The app defaults to Roman Urdu; the UI tests assert the English strings.
// The language is set through the store's own API rather than localStorage:
// under this Node/jsdom combination the global `localStorage` is Node's own
// experimental shim, whose `setItem` is not callable without a backing file.
// `setLang` already treats storage as best-effort, so it works either way —
// and every test renders the English branch, the same one a reviewer flips to
// with the navbar toggle.
import { setLang } from "@/lib/lang";

setLang("en");

// Layout animations measure elements with a ResizeObserver, which jsdom does
// not provide. A no-op keeps the components mounting; nothing here asserts on
// the motion itself.
if (!("ResizeObserver" in window)) {
  class NoopResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  (window as unknown as { ResizeObserver: unknown }).ResizeObserver = NoopResizeObserver;
}
