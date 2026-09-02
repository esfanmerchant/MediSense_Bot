"use client";

/**
 * The close.
 *
 * One card, one button, and the pulse running behind it at a tenth of its
 * strength — present enough to be felt, faint enough that nothing competes
 * with the sentence. The gradient border is the whole brand in 1.5 pixels,
 * which is the right amount of decoration for the last thing on the page
 * before the footer.
 */

import Link from "next/link";

import { Icon } from "@/components/Icon";
import { EcgLine } from "@/components/brand/EcgLine";
import { useTr } from "@/lib/lang";

import { Rise, Shell, SplitText, useStagger } from "./parts";

export function FinalCta({
  primaryHref,
  primaryLabel,
  signedIn,
}: {
  primaryHref: string;
  primaryLabel: string;
  signedIn: boolean;
}) {
  const tr = useTr();
  const { ref: headRef, className: headMotion } = useStagger<HTMLDivElement>();

  return (
    <section className="band-light relative overflow-hidden py-24">
      <Shell>
        <Rise y={34}>
          <div className="relative">
            {/* The card's own light. On white this is what tells the eye the
                card is in front of the page rather than printed on it. */}
            <div
              aria-hidden
              className="pointer-events-none absolute -inset-10 rounded-[3rem]"
              style={{
                background:
                  "radial-gradient(58% 58% at 50% 52%, rgb(20 196 193 / 0.14), rgb(11 63 168 / 0.08) 46%, transparent 74%)",
              }}
            />

            <div className="border-gradient-thick ms-elevate relative overflow-hidden rounded-2xl px-6 py-16 text-center sm:px-10">
              <div
                aria-hidden
                className="pointer-events-none absolute inset-x-0 top-1/2 -translate-y-1/2 opacity-10"
              >
                <EcgLine width={3} height={160} speed={4} loop />
              </div>

              <div ref={headRef} className={headMotion}>
                <h2 className="relative font-display text-[2rem] font-bold leading-[1.12] text-strong sm:text-[2.6rem]">
                  <SplitText
                    parts={[
                      tr("Ready when", "Jab aap tayyar,"),
                      { text: tr("you are", "hum tayyar"), gradient: true },
                    ]}
                    start={120}
                  />
                </h2>
                <p
                  className="ms-fade relative mx-auto mt-4 max-w-[46ch] text-[17px] leading-relaxed text-muted"
                  style={{ animationDelay: "400ms" }}
                >
                  {tr(
                    "About a minute, and you can book.",
                    "Ek minute, aur booking ho sakti hai.",
                  )}
                </p>
                <div
                  className="ms-fade relative mt-9 flex flex-wrap items-center justify-center gap-3"
                  style={{ animationDelay: "500ms" }}
                >
                  <Link
                    href={primaryHref}
                    className="btn-gradient btn-shine group inline-flex min-h-[52px] items-center gap-2 rounded-xl px-7 text-base font-semibold text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                  >
                    {signedIn ? primaryLabel : tr("Create account", "Account banayein")}
                    <Icon
                      name="arrow_forward"
                      className="text-[20px] transition-transform duration-200 group-hover:translate-x-1"
                    />
                  </Link>
                  {!signedIn && (
                    <Link
                      href="/login"
                      className="ms-ghost-cta inline-flex min-h-[52px] items-center rounded-xl px-7 text-base font-semibold text-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                    >
                      {tr("Sign in", "Login karein")}
                    </Link>
                  )}
                </div>
              </div>
            </div>
          </div>
        </Rise>
      </Shell>
    </section>
  );
}
