"use client";

/**
 * Where the "Stop these emails" link in an email lands.
 *
 * **No sign-in.** This is opened from a mail client, on a phone that is
 * probably signed out, by somebody who has already decided. Putting a password
 * form in front of them would make the `List-Unsubscribe` header a false
 * promise — and a header that offers one-click and then asks for credentials
 * is precisely what deliverability rules are written against. The token in the
 * link is the authorisation, and the only thing it can do is turn this
 * address's email off.
 *
 * **It acts on load, and says so plainly.** A page that arrives with a button
 * marked "confirm" is one more step for somebody who has already pressed
 * unsubscribe once; Gmail's own one-click sends a POST without ever opening a
 * browser, so the two paths behave the same way by design.
 *
 * **Nothing is lost by pressing it.** Email stops; the portal keeps every
 * notification, and the switch is one press to undo in settings. That is said
 * on the page, because somebody who thinks they have just deleted something
 * needs to be told they have not.
 */

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";

import { Icon } from "@/components/Icon";
import { Logo } from "@/components/brand/Logo";
import { cx } from "@/components/ui";
import { API_URL } from "@/lib/api";
import { useTr } from "@/lib/lang";

type State = "working" | "done" | "no-token" | "failed";

function Unsubscribe() {
  const tr = useTr();
  const params = useSearchParams();
  const token = params.get("token");
  const [state, setState] = useState<State>(token ? "working" : "no-token");

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch(`${API_URL}/notifications/unsubscribe`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token }),
        });
        if (!cancelled) setState(response.ok ? "done" : "failed");
      } catch {
        if (!cancelled) setState("failed");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  const copy: Record<State, { icon: string; title: string; body: string }> = {
    working: {
      icon: "hourglass_top",
      title: tr("One moment…", "Ek lamha…"),
      body: tr("Turning email off for this address.", "Is address ke liye email band ki ja rahi hai."),
    },
    done: {
      icon: "mark_email_read",
      title: tr("Email is off.", "Email band ho gayi."),
      body: tr(
        "We will not email this address again. Everything still appears in your portal, and you can turn email back on any time in Settings.",
        "Ab is address par email nahi jayegi. Sab kuch aap ke portal mein maujood rahega, aur Settings se aap kabhi bhi email dobara on kar sakte hain.",
      ),
    },
    "no-token": {
      icon: "link_off",
      title: tr("This link is incomplete.", "Yeh link adhoora hai."),
      body: tr(
        "Some mail apps shorten long links. Sign in and use Settings instead — it does the same thing.",
        "Kuch mail apps lambe link kaat dete hain. Sign in kar ke Settings istemal karein — wahi kaam wahan bhi hota hai.",
      ),
    },
    failed: {
      icon: "error",
      title: tr("That did not work.", "Yeh nahi ho saka."),
      body: tr(
        "The link may have been altered in transit. Sign in and turn email off in Settings — it does the same thing.",
        "Ho sakta hai link raste mein badal gaya ho. Sign in kar ke Settings se email band kar dein — wahi kaam wahan bhi hota hai.",
      ),
    },
  };

  const { icon, title, body } = copy[state];

  return (
    <main className="grid min-h-screen place-items-center bg-canvas px-5 py-16">
      <div className="w-full max-w-md text-center">
        <Logo variant="full" size="md" className="mx-auto" />

        <div className="mt-8 rounded-2xl border border-line bg-card p-8 shadow-card">
          <span
            aria-hidden
            className={cx(
              "mx-auto grid h-14 w-14 place-items-center rounded-2xl",
              state === "done" ? "bg-gradient-soft text-primary" : "bg-sunken text-muted",
            )}
          >
            <Icon name={icon} className="text-[28px]" />
          </span>

          <h1 className="font-display mt-5 text-xl font-bold text-strong">{title}</h1>
          <p
            // Announced, because the outcome arrives after the page does.
            role="status"
            className="mt-2 text-[0.9375rem] leading-relaxed text-muted"
          >
            {body}
          </p>

          {state !== "working" && (
            <Link
              href="/login"
              className="bg-gradient-brand mt-6 inline-flex min-h-11 items-center gap-2 rounded-xl px-5 font-semibold text-white"
            >
              {tr("Go to MediSense", "MediSense par jayein")}
              <Icon name="arrow_forward" className="text-[18px]" />
            </Link>
          )}
        </div>
      </div>
    </main>
  );
}

export default function UnsubscribePage() {
  // `useSearchParams` needs one, and the fallback is what renders while the
  // token is being read — a blank screen would look like a broken link.
  return (
    <Suspense fallback={<main className="min-h-screen bg-canvas" />}>
      <Unsubscribe />
    </Suspense>
  );
}
