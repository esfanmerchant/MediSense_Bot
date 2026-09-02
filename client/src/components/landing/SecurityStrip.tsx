"use client";

/**
 * The security band — the one place on the page that is dark in both themes.
 *
 * That is a deliberate exception to the theme rule rather than a lapse. The
 * page is otherwise daylight, and this section has to *feel* different: it is
 * the part a hospital administrator reads with their guard up. A navy slab
 * with the circuit field behind it reads as the machine room, and the switch
 * in ground does more for the point than another heading would.
 *
 * The claims are specifics on purpose. "Bank-grade security" means nothing;
 * every line here names a property the system can be tested against.
 */

import { Icon } from "@/components/Icon";
import { CircuitNodes } from "@/components/brand/CircuitNodes";
import { useTr } from "@/lib/lang";

import { Eyebrow, GradientRule, Parallax, Rise, Shell, SplitText, useStagger } from "./parts";

export function SecurityStrip() {
  const tr = useTr();
  const { ref: headRef, className: headMotion } = useStagger<HTMLDivElement>();

  const points: { icon: string; label: string; body: string }[] = [
    {
      icon: "lock",
      label: tr("End-to-end encryption", "End-to-end encryption"),
      body: tr(
        "Traffic is TLS and the store is encrypted at rest, so a stolen disk is a stolen brick.",
        "Data raaste mein TLS se mehfooz hai aur database khud encrypted hai — chori hui disk se kuchh haasil nahi hota.",
      ),
    },
    {
      icon: "verified_user",
      label: tr("Role-based access", "Role ke mutabiq rasai"),
      body: tr(
        "A doctor sees your record because they treat you — not because they are a doctor.",
        "Doctor aap ka record is liye dekhta hai ke woh aap ka ilaaj karta hai — sirf doctor hone ki wajah se nahi.",
      ),
    },
    {
      icon: "fact_check",
      label: tr("Immutable audit log", "Na badalne wala audit log"),
      body: tr(
        "The trail is append-only and hash-chained. Nobody can edit it, including us.",
        "Record sirf barhta hai, badla nahi ja sakta — hum bhi nahi badal sakte.",
      ),
    },
    {
      icon: "timer",
      label: tr("Auto sign-out on shared screens", "Mushtarka screens par auto sign-out"),
      body: tr(
        "On a shared hospital terminal, two minutes of inactivity ends the session.",
        "Hospital ke mushtarka computer par do minute ki khamoshi session khatam kar deti hai.",
      ),
    },
  ];

  return (
    <section id="hifazat" className="band-dark relative scroll-mt-24 overflow-hidden py-24">
      {/* The machine room's own field, lagging the scroll — the depth cue the
          navy gets that a white section has to earn. */}
      <Parallax speed={110} className="pointer-events-none absolute inset-x-0 -inset-y-20 opacity-50">
        <CircuitNodes density="med" tone="white" />
      </Parallax>
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(40rem 22rem at 12% -10%, rgb(26 143 199 / 0.35), transparent 62%), radial-gradient(32rem 20rem at 92% 110%, rgb(20 196 193 / 0.28), transparent 62%)",
        }}
      />

      <Shell className="relative">
        <div ref={headRef} className={headMotion}>
          <Eyebrow tone="light">{tr("Security", "Hifazat")}</Eyebrow>
          <h2 className="mt-4 max-w-2xl font-display text-[2rem] font-bold leading-[1.12] text-white sm:text-[2.6rem]">
            <SplitText
              parts={[tr("Built to be trusted with this", "Itni hifazat ke aap bharosa kar sakein")]}
              start={180}
            />
          </h2>
          <GradientRule className="mt-5 max-w-[7rem]" style={{ transitionDelay: "540ms" }} />
          <p
            className="ms-fade mt-5 max-w-[56ch] text-[17px] leading-relaxed text-white/70"
            style={{ animationDelay: "620ms" }}
          >
            {tr(
              "Specifics, because “bank-grade security” means nothing. Each of these is a property the system can be tested against, not a promise.",
              "Waade nahi, tafseelat — kyunke “bank jaisi security” ka koi matlab nahi hota. Neeche di gayi har baat aisi hai jise test kiya ja sakta hai.",
            )}
          </p>
        </div>

        <ul className="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
          {points.map((point, index) => (
            <li key={point.label} className="h-full">
              <Rise delay={index * 90} y={30} className="h-full">
                <div className="glass-dark group h-full rounded-2xl p-5 transition-colors duration-300 hover:bg-white/[0.14]">
                  <span
                    aria-hidden
                    className="grid h-10 w-10 place-items-center rounded-xl bg-white/10 text-[#5EEAD4]"
                  >
                    <Icon name={point.icon} filled className="icon-wiggle text-[20px]" />
                  </span>
                  <h3 className="mono-caps mt-4 text-[0.7rem] leading-relaxed text-white">
                    {point.label}
                  </h3>
                  <p className="mt-2 text-sm leading-relaxed text-white/65">{point.body}</p>
                </div>
              </Rise>
            </li>
          ))}
        </ul>
      </Shell>
    </section>
  );
}
