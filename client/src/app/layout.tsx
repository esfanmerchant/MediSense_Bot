import type { Metadata, Viewport } from "next";
import { Inter, JetBrains_Mono, Sora } from "next/font/google";
import type { ReactNode } from "react";

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
 * Material Symbols is *not* loaded through `next/font`, and it is *not* allowed
 * to block the first paint.
 *
 * It cannot go through `next/font`: this Next version's bundled Google Fonts
 * list covers text faces only and has no icon fonts in it at all — there is no
 * `Material_Symbols_Outlined` export to import. The stylesheet link below is
 * the supported route.
 *
 * What that link used to cost was the whole of the first paint. A stylesheet in
 * the head is render-blocking, so every page waited on a round trip to
 * fonts.googleapis.com and then another to fonts.gstatic.com before it drew
 * anything — on a landing page whose first screen contains four icons, that is
 * a second of blank white bought for very little.
 *
 * `media="print"` is the fix: the browser fetches the sheet at a low priority
 * and does not wait for it, and the inline script below promotes it to `all`
 * once it has arrived. Nothing else changes, including `display=block`, which
 * is still right for an icon font — `swap` flashes the raw ligature name
 * ("monitor_heart") before the glyph arrives, and a word where an icon should
 * be reads as a bug.
 */
const ICON_FONT =
  "https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20..48,100..700,0..1,-50..200&display=block";

/**
 * Promotes the icon sheet once it has loaded.
 *
 * Guarded on `sheet` as well as the load event, because a sheet already in the
 * cache can finish before this script runs and the event would never fire —
 * which would leave the icons permanently print-only.
 */
const PROMOTE_ICON_FONT = `(function(){var l=document.getElementById('msym-css');if(!l)return;var go=function(){l.media='all'};if(l.sheet)go();else l.addEventListener('load',go,{once:true})})()`;

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
        { }
        <link rel="preload" as="style" href={ICON_FONT} />
        { }
        <link id="msym-css" rel="stylesheet" href={ICON_FONT} media="print" />
        <script dangerouslySetInnerHTML={{ __html: PROMOTE_ICON_FONT }} />
        <noscript>
          { }
          <link rel="stylesheet" href={ICON_FONT} />
        </noscript>
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
