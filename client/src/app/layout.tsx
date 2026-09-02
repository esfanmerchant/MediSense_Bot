import type { Metadata, Viewport } from "next";
import { Inter, JetBrains_Mono, Sora } from "next/font/google";
import type { ReactNode } from "react";

import { ICON_NAMES } from "@/app/icon-names.generated";
import { Providers } from "@/components/Providers";
import { ServiceWorker } from "@/components/ServiceWorker";
import "./globals.css";

/**
 * Three faces, three jobs.
 *
 * **Sora** carries headings — its squared, slightly technical cuts echo the
 * circuit nodes in the logo. **Inter** is the body and UI face, chosen for
 * legibility in the data-heavy screens that make up most of this application.
 * **JetBrains Mono** takes everything that must line up or be read character by
 * character: vitals, record numbers, timestamps, and the OTP digits people
 * copy from an email.
 */
const display = Sora({
  subsets: ["latin"],
  variable: "--font-display-face",
  display: "swap",
  weight: ["500", "600", "700"],
});

const body = Inter({
  subsets: ["latin"],
  variable: "--font-body",
  display: "swap",
});

const mono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-mono-face",
  display: "swap",
  weight: ["400", "500", "600", "700"],
});

/**
 * Material Symbols is *not* loaded through `next/font`, and it *is* allowed to
 * block the first paint.
 *
 * It cannot go through `next/font`: this Next version's bundled Google Fonts
 * list covers text faces only and has no icon fonts in it at all — there is no
 * `Material_Symbols_Outlined` export to import. The stylesheet link below is
 * the supported route.
 *
 * It was briefly loaded as `media="print"` and promoted by an inline script,
 * which is the standard way to take a stylesheet off the critical path and
 * which broke the entire interface. React hoists and reorders `<link>` and
 * `<script>` out of the markup they were written in, so the script could run
 * before the link existed, find nothing, and leave the sheet print-only for
 * good. The failure mode is not subtle: with no icon font, every `<Icon>`
 * renders its ligature — the literal words "monitor_heart", "arrow_forward" —
 * at whatever size its parent sets, and every button, chip and border in the
 * application stretches around a word. A page that is four hundred
 * milliseconds slower is worth a great deal less than a page that is legible,
 * so it blocks, and it blocks on purpose.
 *
 * `preconnect` below and `preload` here are the parts of that idea that are
 * safe: they start the two round trips as early as the browser can, without
 * making the result conditional on a script running in the right order.
 *
 * `display=block` rather than `swap`, for the same reason: `swap` shows the raw
 * ligature name until the glyph arrives, and a word where an icon should be
 * reads as a bug.
 *
 * What made blocking affordable is the subset below. The unqualified URL
 * fetches every Material Symbol Google has, at every axis — 3.8 MB — and
 * blocking the first paint on that is a different proposition from blocking
 * on the 28 KB this application actually uses.
 */
const ICON_FONT =
  "https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined" +
  // Only FILL varies: `.msym` pins wght 400, GRAD 0 and opsz 24, and
  // `.msym-fill` changes nothing but FILL. Asking for the full ranges shipped
  // four axes of interpolation the app never moves — 230 KB against 28 KB.
  ":opsz,wght,FILL,GRAD@24,400,0..1,0" +
  // Naming the icons is the rest of it: unqualified, Google serves every
  // symbol it has. The list is generated from the source rather than written,
  // because an icon missing from it has no glyph and renders its own name as
  // a word — see icon-names.generated.ts and the test beside it.
  `&icon_names=${ICON_NAMES.join(",")}` +
  "&display=block";

export const metadata: Metadata = {
  title: "MediSense — Smart Healthcare Management",
  description:
    "Sehat ka sara record, appointments, vitals aur billing — sab ek jagah. One place for your whole care.",
  applicationName: "MediSense",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    title: "MediSense",
    // The status bar sits over the app's own header, which is navy, so the
    // system text on it has to be light.
    statusBarStyle: "black-translucent",
  },
  icons: {
    icon: "/icon.svg",
    apple: "/brand/icon-192.png",
  },
};

/**
 * `viewport-fit=cover` is what lets the shell reach under a phone's notch and
 * home indicator; the safe-area insets in the layout put the content back where
 * a thumb can reach it. `themeColor` is the colour Android paints the status bar
 * and the task switcher card.
 */
export const viewport: Viewport = {
  themeColor: "#00194d",
  viewportFit: "cover",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html
      lang="ur-Latn"
      className={`${body.variable} ${display.variable} ${mono.variable}`}
      suppressHydrationWarning
    >
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link rel="preload" as="style" href={ICON_FONT} />
        <link rel="stylesheet" href={ICON_FONT} />
      </head>
      <body className="text-strong antialiased">
        <ServiceWorker />
        {/* Keyboard users should be able to skip the navigation on every page. */}
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-primary focus:px-4 focus:py-2 focus:text-primary-on"
        >
          Skip to content
        </a>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
