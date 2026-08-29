"use client";

/**
 * Everything the tree needs before a page renders.
 *
 * `next-themes` writes the theme class onto <html> from a script that runs
 * before paint, which is what stops a light flash on a dark-mode reload. It is
 * a client component by necessity, so it lives here rather than in the layout,
 * and the session provider sits inside it — the theme is chrome and must apply
 * even on the screens where nobody is signed in.
 *
 * Light is the default because the brand is a light-background one; system
 * preference still wins for anyone who has expressed one.
 */

import { ThemeProvider } from "next-themes";
import type { ReactNode } from "react";

import { ToastProvider } from "@/components/overlays";
import { SessionProvider } from "@/lib/session";

export function Providers({ children }: { children: ReactNode }) {
  return (
    <ThemeProvider attribute="class" defaultTheme="light" enableSystem disableTransitionOnChange>
      <SessionProvider>
        <ToastProvider>{children}</ToastProvider>
      </SessionProvider>
    </ThemeProvider>
  );
}
