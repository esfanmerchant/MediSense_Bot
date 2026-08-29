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
import { GradientText } from "@/components/brand/GradientText";
import { useTr } from "@/lib/lang";

import { Reveal, Shell } from "./parts";

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

  return (
    <section className="py-24">
      <Shell>
        <Reveal>
          <div className="border-gradient-thick relative overflow-hidden rounded-2xl px-6 py-16 text-center shadow-card sm:px-10">
            <div aria-hidden className="pointer-events-none absolute inset-x-0 top-1/2 -translate-y-1/2 opacity-10">
              <EcgLine width={3} height={160} speed={4} loop />
            </div>

            <div className="relative">
              <h2 className="font-display text-[2rem] font-bold leading-[1.12] text-strong sm:text-[2.6rem]">
                {tr("Ready when", "Jab aap tayyar,")}{" "}
                <GradientText>{tr("you are", "hum tayyar")}</GradientText>
              </h2>
              <p className="mx-auto mt-4 max-w-[46ch] text-[17px] leading-relaxed text-muted">
                {tr(
                  "Takes about a minute. You can book your first appointment straight after.",
                  "Bas ek minute lagta hai — us ke foran baad aap apni pehli appointment book kar sakte hain.",
                )}
              </p>
              <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
                <Link
                  href={primaryHref}
                  className="btn-gradient btn-shine group inline-flex min-h-[52px] items-center gap-2 rounded-xl px-6 text-base font-semibold text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                >
                  {signedIn
                    ? primaryLabel
                    : tr("Create your account", "Apna account banayein")}
                  <Icon
                    name="arrow_forward"
                    className="text-[20px] transition-transform duration-200 group-hover:translate-x-1"
                  />
                </Link>
                {!signedIn && (
                  <Link
                    href="/login"
                    className="ms-ghost-cta inline-flex min-h-[52px] items-center rounded-xl px-6 text-base font-semibold text-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                  >
                    {tr("Sign in", "Login karein")}
                  </Link>
                )}
              </div>
            </div>
          </div>
        </Reveal>
      </Shell>
    </section>
  );
}
