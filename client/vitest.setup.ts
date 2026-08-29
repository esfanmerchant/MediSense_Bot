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
