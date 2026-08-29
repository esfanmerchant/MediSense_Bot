import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

/**
 * UI test setup (spec §"Phase 14 — UI tests").
 *
 * jsdom rather than a real browser: what these tests check is what the
 * components *render* and announce — a disclaimer that must always be present,
 * an alert that must reach assistive technology, an amount that must never be
 * parsed into a float. None of that needs a paint, and a headless browser would
 * turn a sub-second suite into a slow one for no extra signal.
 *
 * **No React plugin, deliberately.** `@vitejs/plugin-react` exists for Fast
 * Refresh, which is meaningless in a test run, and its current major pulls a
 * different Vite than Vitest does — two incompatible copies of Vite's types in
 * one project. Vitest's esbuild already applies the automatic JSX runtime from
 * `tsconfig.json`, so the plugin was buying nothing and costing a conflict.
 */
export default defineConfig({
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./vitest.setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
    css: false,
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
});
