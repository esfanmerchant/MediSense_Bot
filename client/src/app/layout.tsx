import type { Metadata } from "next";
import type { ReactNode } from "react";

import { SessionProvider } from "@/lib/session";
import "./globals.css";

export const metadata: Metadata = {
  title: "MediSense",
  description: "Smart Healthcare Management System",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="bg-slate-50 text-slate-900 antialiased dark:bg-slate-950 dark:text-slate-100">
        {/* Keyboard users should be able to skip the navigation on every page. */}
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-teal-700 focus:px-4 focus:py-2 focus:text-white"
        >
          Skip to content
        </a>
        <SessionProvider>{children}</SessionProvider>
      </body>
    </html>
  );
}
