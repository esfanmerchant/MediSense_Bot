"use client";

/**
 * The front door — Roman Urdu first, English one tap away.
 *
 * The person arriving here is usually worried about something, and what works
 * on them is not excitement but *relief*. So the page is daylight rather than
 * the lit control room it used to be: the brand ramp carries the headline, the
 * circuit field frames the product instead of wallpapering the sentence, and
 * the ECG appears exactly three times — as the rule under the headline, as the
 * ghost behind the closing card, and as the footer's divider. A motif used
 * three times is a signature; used everywhere it is noise, and on a health
 * page moving noise reads as alarm.
 *
 * This file is now only the arrangement. Every section lives in
 * `components/landing/`, takes the session facts it needs as props, and owns
 * its own copy — which is what keeps a page this long editable.
 */

import { Bento } from "@/components/landing/Bento";
import { Hero } from "@/components/landing/Hero";
import { FinalCta } from "@/components/landing/FinalCta";
import { Footer } from "@/components/landing/Footer";
import { HowItWorks } from "@/components/landing/HowItWorks";
import { Nav } from "@/components/landing/Nav";
import { Portals } from "@/components/landing/Portals";
import { SecurityStrip } from "@/components/landing/SecurityStrip";
import { LandingStyles } from "@/components/landing/parts";
import { useTr } from "@/lib/lang";
import { homePathFor, useSession } from "@/lib/session";

export default function Home() {
  const { user, loading } = useSession();
  const tr = useTr();

  // Someone already signed in should be shown their own door, not a signup
  // form they will bounce off.
  // Two words at most, everywhere. A call to action that has to be read is
  // not a call to action; the sentence above it already did the arguing.
  const primaryHref = user ? homePathFor(user.role) : "/register";
  const heroLabel = loading
    ? "…"
    : user
      ? tr("Dashboard", "Dashboard")
      : tr("Get started", "Shuru karein");
  const navLabel = heroLabel;

  return (
    <div className="min-h-screen bg-canvas">
      <LandingStyles />

      <Nav primaryHref={primaryHref} primaryLabel={navLabel} showSignIn={!loading && !user} />

      <main id="main">
        {/* The page opens on a working hospital rather than a pitch. Scrolling
            walks the camera through it room by room while the building carries
            on around you — patients checking in, a nurse on her rounds, a ward
            monitor that goes critical and a doctor who walks there. A feature
            grid can list what this product has; only a place that is open can
            show what it is for. */}
        <Hero primaryHref={primaryHref} primaryLabel={heroLabel} />
        <Portals />
        <Bento />
        <HowItWorks />
        <SecurityStrip />
        <FinalCta primaryHref={primaryHref} primaryLabel={heroLabel} signedIn={Boolean(user)} />
      </main>

      <Footer />
    </div>
  );
}
