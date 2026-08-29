"use client";

/**
 * What the product does, as a bento.
 *
 * A feature grid is the easiest section on a landing page to make boring: six
 * icons, six sentences, six identical boxes. What stops that here is that each
 * tile *demonstrates itself* under the cursor — the assistant types, the voice
 * bars move, a scan line crosses a document, the ECG draws. All of it is built
 * from motifs the design system already owns, so hovering the page feels like
 * touching the product rather than watching a showreel.
 *
 * Every demo is paused at rest. Six loops running at once on a page about
 * calm would be its own argument against the product, and it is a battery
 * cost paid by people who never hover at all.
 */

import { Icon } from "@/components/Icon";
import { EcgLine } from "@/components/brand/EcgLine";
import { GradientText } from "@/components/brand/GradientText";
import { cx } from "@/components/ui";
import { useTr } from "@/lib/lang";

import { Reveal, SectionHead, Shell } from "./parts";

/* ------------------------------------------------------------------ */
/* Tile shell                                                          */
/* ------------------------------------------------------------------ */

function Tile({
  icon,
  title,
  body,
  demo,
  className,
  demoClassName,
}: {
  icon: string;
  title: string;
  body: string;
  demo: React.ReactNode;
  className?: string;
  /** Height of the demo well, which differs between the wide tile and the rest. */
  demoClassName?: string;
}) {
  return (
    <article
      className={cx(
        "hover-lift-sm group flex flex-col rounded-2xl border border-line bg-card p-6 shadow-card",
        className,
      )}
    >
      <span
        aria-hidden
        className="bg-gradient-soft grid h-11 w-11 shrink-0 place-items-center rounded-xl text-primary"
      >
        <Icon name={icon} className="icon-wiggle text-[23px]" />
      </span>
      <h3 className="mt-4 font-display text-[17px] font-bold text-strong">{title}</h3>
      <p className="mt-2 text-[15px] leading-relaxed text-muted">{body}</p>
      <div
        aria-hidden
        className={cx(
          "relative mt-5 flex-1 overflow-hidden rounded-xl border border-line bg-sunken",
          demoClassName ?? "min-h-[104px]",
        )}
      >
        {demo}
      </div>
    </article>
  );
}

/* ------------------------------------------------------------------ */
/* Demos                                                               */
/* ------------------------------------------------------------------ */

function AssistantDemo({ ask, reply }: { ask: string; reply: string }) {
  return (
    <div className="ms-demo flex h-full flex-col justify-end gap-2.5 p-4">
      <p className="bg-gradient-brand ml-auto max-w-[70%] rounded-2xl rounded-br-md px-3.5 py-2 text-[13px] leading-snug text-white shadow-sm">
        {ask}
      </p>
      <div className="max-w-[85%] rounded-2xl rounded-bl-md border border-line bg-card px-3.5 py-2 shadow-sm">
        <span className="ms-type stream-cursor text-[13px] leading-snug text-strong">{reply}</span>
      </div>
    </div>
  );
}

function VoiceDemo({ caption }: { caption: string }) {
  return (
    <div className="ms-demo flex h-full items-center gap-3 p-4">
      <span
        aria-hidden
        className="bg-gradient-brand mic-idle grid h-10 w-10 shrink-0 place-items-center rounded-full text-white"
      >
        <Icon name="mic" filled className="text-[20px]" />
      </span>
      <span className="voice-bars h-8">
        {Array.from({ length: 16 }, (_, index) => (
          <span
            key={index}
            style={{
              animationDelay: `${(index % 5) * 0.11}s`,
              animationDuration: `${0.8 + (index % 4) * 0.12}s`,
            }}
          />
        ))}
      </span>
      <span className="mono-caps shrink-0 text-[0.55rem] text-faint">{caption}</span>
    </div>
  );
}

function OcrDemo({ caption }: { caption: string }) {
  return (
    <div className="ms-demo relative h-full overflow-hidden p-4">
      <div className="relative mx-auto h-full max-w-[150px] rounded-md border border-line bg-card p-2.5 shadow-sm">
        <span className="mono-caps block text-[0.45rem] text-faint">{caption}</span>
        <span className="mt-2 block h-1 w-full rounded-full bg-line-strong" />
        <span className="mt-1.5 block h-1 w-4/5 rounded-full bg-line-strong" />
        <span className="mt-1.5 block h-1 w-2/3 rounded-full bg-line-strong" />
        <span className="mt-1.5 block h-1 w-3/4 rounded-full bg-line-strong" />
      </div>
      <span className="scan-line" />
    </div>
  );
}

function VitalsDemo({ caption }: { caption: string }) {
  return (
    <div className="relative flex h-full flex-col justify-center gap-1 px-4">
      {/* The resting shape, so the tile is never an empty box. */}
      <div className="absolute inset-x-4 top-1/2 -translate-y-1/2 text-line-strong opacity-70">
        <EcgLine color="currentColor" width={2} height={44} speed={0.001} />
      </div>
      {/* The bright trace, which only draws while the tile is hovered. */}
      <div className="ms-demo relative">
        <EcgLine loop width={2} height={44} speed={2.2} />
      </div>
      <span className="mono-caps relative mt-1 flex items-center gap-1.5 text-[0.55rem] text-critical">
        <span aria-hidden className="pulse-dot ms-demo h-1.5 w-1.5 rounded-full bg-critical" />
        {caption}
      </span>
    </div>
  );
}

function BillingDemo({ rows, total }: { rows: [string, string][]; total: string }) {
  return (
    <div className="flex h-full flex-col justify-center gap-1.5 p-4">
      {rows.map(([label, amount], index) => (
        <span
          key={label}
          className="flex items-center gap-2 rounded-md border border-line bg-card px-2 py-1 opacity-45 transition-all duration-500 ease-out group-hover:translate-x-0 group-hover:opacity-100 group-focus-within:opacity-100 -translate-x-2"
          style={{ transitionDelay: `${index * 110}ms` }}
        >
          <span className="mono-caps text-[0.5rem] text-faint">{label}</span>
          <span className="ml-auto font-mono text-[0.6rem] font-semibold text-strong">{amount}</span>
        </span>
      ))}
      <span className="mt-1 flex items-center gap-2 px-2">
        <span className="mono-caps text-[0.5rem] text-accent">TOTAL</span>
        <span className="ml-auto font-mono text-[0.75rem] font-bold text-strong">{total}</span>
      </span>
    </div>
  );
}

function AuditDemo({ caption }: { caption: string }) {
  return (
    <div className="ms-demo flex h-full flex-col justify-center gap-1.5 p-4">
      {["a41f", "9c07", "e2b8"].map((hash, index) => (
        <span key={hash} className="flex items-center gap-2">
          <span
            className={cx(
              "grid h-5 w-5 shrink-0 place-items-center rounded-md text-[11px]",
              index === 1 ? "bg-critical-soft text-critical glow-critical" : "bg-gradient-soft text-primary",
            )}
          >
            <Icon name={index === 1 ? "e911_emergency" : "link"} className="text-[12px]" />
          </span>
          <span className="font-mono text-[0.55rem] text-faint">sha256:{hash}…</span>
          <span className="h-px flex-1 bg-line-strong" />
        </span>
      ))}
      <span className="mono-caps mt-1 text-[0.5rem] text-faint">{caption}</span>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* The section                                                         */
/* ------------------------------------------------------------------ */

export function Bento() {
  const tr = useTr();

  return (
    <section id="kya-karta-hai" className="scroll-mt-24 border-y border-line bg-sunken py-24">
      <Shell>
        <SectionHead
          eyebrow={tr("Capabilities", "Salahiyatein")}
          title={
            <>
              {tr("Everything a visit", "Ilaaj ka har qadam,")}{" "}
              <GradientText>{tr("touches", "ek jagah")}</GradientText>
            </>
          }
          lede={tr(
            "Not a folder of features — one path a patient actually walks, from booking to paying, with the clinical safety built into each step rather than bolted on.",
            "Yeh features ki fehrist nahi — woh rasta hai jo mareez sach mein tay karta hai, booking se bill tak. Aur hifazat har qadam ke andar bani hai, upar se lagai nahi gayi.",
          )}
        />

        <div className="mt-12 grid gap-5 md:grid-cols-3">
          <Reveal className="md:col-span-2 md:row-span-2">
            <Tile
              className="h-full"
              demoClassName="min-h-[200px]"
              icon="smart_toy"
              title={tr("AI health assistant", "AI health assistant")}
              body={tr(
                "Grounded in your own prescriptions and appointments. It escalates rather than reassures when something sounds serious.",
                "Aap ke apne nuskhon aur appointments par mabni. Baat sangeen lage to tasalli nahi deta — foran doctor ke paas bhejta hai.",
              )}
              demo={
                <AssistantDemo
                  ask={tr("Which pill do I take at night?", "Raat wali goli kaun si hai?")}
                  reply={tr(
                    "Your prescription lists Metformin 500mg after dinner.",
                    "Aap ke nuskhe mein raat khane ke baad Metformin 500mg likha hai.",
                  )}
                />
              }
            />
          </Reveal>

          <Reveal delay={70}>
            <Tile
              className="h-full"
              icon="mic"
              title={tr("Speak your symptoms", "Apni takleef bol kar batayein")}
              body={tr(
                "Speech becomes text on your device. You correct it before anything is stored.",
                "Aap ki awaaz aap ke apne device par likhai mein badalti hai — save hone se pehle aap khud usay durust karte hain.",
              )}
              demo={
                <VoiceDemo caption={tr("Listening", "Sun raha hai")} />
              }
            />
          </Reveal>

          <Reveal delay={140}>
            <Tile
              className="h-full"
              icon="document_scanner"
              title={tr("Reads your documents", "Aap ke documents parh leta hai")}
              body={tr(
                "Prescriptions and reports are read automatically — and a doctor confirms every value before it counts.",
                "Nuskhe aur reports khud-ba-khud parhi jaati hain — magar har qeemat doctor ki tasdeeq ke baad hi record banti hai.",
              )}
              demo={
                <OcrDemo caption={tr("Report", "Report")} />
              }
            />
          </Reveal>

          <Reveal delay={210}>
            <Tile
              className="h-full"
              icon="monitor_heart"
              title={tr("Live vital monitoring", "Vitals par live nazar")}
              body={tr(
                "Readings are checked against configurable thresholds the moment they arrive, and the responsible doctor is told.",
                "Har reading usi lamhe muqarrar hadon se jaanchi jaati hai — had paar hui to zimmedar doctor ko foran khabar milti hai.",
              )}
              demo={
                <VitalsDemo caption={tr("Threshold breached", "Had paar ho gayi")} />
              }
            />
          </Reveal>

          <Reveal delay={280}>
            <Tile
              className="h-full"
              icon="receipt_long"
              title={tr("Billing that just happens", "Billing jo khud ho jaati hai")}
              body={tr(
                "An invoice is created the moment a consultation is completed. Exactly one, however many times it retries.",
                "Consultation mukammal hote hi invoice ban jaata hai. Sirf ek — chahe system kitni hi baar koshish kare.",
              )}
              demo={
                <BillingDemo
                  rows={[
                    [tr("Consultation", "Consultation"), "2,000"],
                    [tr("Lab", "Lab"), "1,450"],
                    [tr("Pharmacy", "Dawai"), "860"],
                  ]}
                  total="4,310"
                />
              }
            />
          </Reveal>

          <Reveal delay={350}>
            <Tile
              className="h-full"
              icon="policy"
              title={tr("Emergency access, on the record", "Emergency access, poore record ke saath")}
              body={tr(
                "Break-glass opens one chart, expires on a clock, and lands in a hash-chained trail nobody can edit.",
                "Emergency access sirf ek mareez ki file kholta hai, waqt par khatam hota hai — aur aise record mein darj hota hai jise koi badal nahi sakta.",
              )}
              demo={
                <AuditDemo caption={tr("Append-only", "Sirf barhta hai")} />
              }
            />
          </Reveal>
        </div>
      </Shell>
    </section>
  );
}
