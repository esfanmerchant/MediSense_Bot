import type { Metadata } from "next";
import { Inter } from "next/font/google";
import type { ReactNode } from "react";

import { SessionProvider } from "@/lib/session";
import "./globals.css";

/**
 * Inter, and only Inter.
 *
 * The design system picks it for legibility in data-heavy contexts, which is
 * what most of this application is: tables of readings, doses, times. A second
 * display face would buy personality on the landing page and cost clarity on
 * every screen that matters more.
 */
const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

export const metadata: Metadata = {
  title: "MediSense — Smart Healthcare Management",
  description:
    "One place for appointments, records, vitals and billing — for patients and the people caring for them.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={inter.variable} suppressHydrationWarning>
      <body className="bg-canvas text-strong antialiased">
        {/* Keyboard users should be able to skip the navigation on every page. */}
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-primary focus:px-4 focus:py-2 focus:text-primary-on"
        >
          Skip to content
        </a>
        <SessionProvider>{children}</SessionProvider>
      </body>
    </html>
  );
}
