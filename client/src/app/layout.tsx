import type { Metadata } from "next";
import { Bricolage_Grotesque, Inter } from "next/font/google";
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

/**
 * The display face, for headlines only.
 *
 * Inter stays on every data surface — the design system chose it for tables of
 * doses and times, and that holds. But headlines set in the body face read as a
 * settings page, and this product has a public front door now. Bricolage's
 * slightly flared, characterful cuts give the big type a voice without touching
 * a single clinical screen's legibility.
 */
const display = Bricolage_Grotesque({
  subsets: ["latin"],
  variable: "--font-display-face",
  display: "swap",
  weight: ["500", "600", "700", "800"],
});

/**
 * Material Symbols is *not* loaded through `next/font`.
 *
 * It cannot be: this Next version's bundled Google Fonts list covers text faces
 * only, and contains no icon fonts at all — `Material_Symbols_Outlined` is not
 * an export. The stylesheet link below is the supported route.
 *
 * The variable axes are what make it worth the request. `FILL` marks an active
 * nav item by *shape*, which survives a colour-blind reader in a way a hue
 * change does not.
 */

export const metadata: Metadata = {
  title: "MediSense — Smart Healthcare Management",
  description:
    "Sehat ka sara record, appointments, vitals aur billing — sab ek jagah. One place for your whole care.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ur-Latn" className={`${inter.variable} ${display.variable}`} suppressHydrationWarning>
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        {/* Two rules are disabled here, both deliberately.

            `no-page-custom-font` is Pages Router advice: there, a <link>
            outside `_document.js` loads for one page only. This is the *root*
            layout, whose <head> applies to every route.

            `google-font-display` warns against `block` because invisible text
            is worse than unstyled text — true for a text face. For an icon
            font it is the opposite: `swap` flashes the raw ligature name
            ("monitor_heart") before the glyph arrives, which looks broken.
            `block` shows nothing for a moment and then the icon. */}
        {/* eslint-disable-next-line @next/next/no-page-custom-font, @next/next/google-font-display */}
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20..48,100..700,0..1,-50..200&display=block"
        />
      </head>
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
