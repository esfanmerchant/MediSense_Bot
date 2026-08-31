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

import type { CSSProperties } from "react";

import { Icon } from "@/components/Icon";
import { AssistantChatDemo } from "@/components/auth/ChatDemo";
import { EcgLine } from "@/components/brand/EcgLine";
import { cx } from "@/components/ui";
import { useTr } from "@/lib/lang";

import { Grain, Parallax, Rise, SectionHead, Shell, useOneShot } from "./parts";

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
  shotDelay = 0,
  shotDuration,
}: {
  icon: string;
  title: string;
  body: string;
  demo: React.ReactNode;
  className?: string;
  /** Height of the demo well, which differs between the wide tile and the rest. */
  demoClassName?: string;
  /** This tile's place in its row, so the row plays left to right. */
  shotDelay?: number;
  /** How long this demo needs for one complete pass. */
  shotDuration?: number;
}) {
  // The demo plays itself once as the tile arrives and then stays finished.
  // Hover still replays it; what changed is that not hovering is no longer
  // the same as never having seen it.
  const { ref: shotRef, className: shotPhase } = useOneShot<HTMLElement>({
    delay: shotDelay,
    duration: shotDuration,
  });

  return (
    <article
      ref={shotRef}
      className={cx(
        "hover-lift-sm ms-edge group flex flex-col overflow-hidden rounded-2xl border border-line bg-card p-6 shadow-card",
        shotPhase,
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

/** Where the sixteen voice bars settle once the pass is over. */
const VOICE_REST = [
  0.35, 0.62, 0.88, 0.5, 1, 0.72, 0.42, 0.8, 0.58, 0.95, 0.46, 0.76, 0.34, 0.66, 0.9, 0.52,
];

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
        {VOICE_REST.map((rest, index) => (
          <span
            key={index}
            style={
              {
                animationDelay: `${(index % 5) * 0.11}s`,
                animationDuration: `${0.8 + (index % 4) * 0.12}s`,
                // Where this bar stops once the pass is over. Fixed rather
                // than random so the settled waveform is the same shape on
                // every visit, and so the server and the client agree.
                "--ms-rest": rest,
              } as CSSProperties
            }
          />
        ))}
      </span>
      <span className="mono-caps shrink-0 text-[0.55rem] text-faint">{caption}</span>
    </div>
  );
}

/** A line of the document, and the value read out of it behind the scan. */
function OcrLine({ width, delay, first }: { width: string; delay: number; first?: boolean }) {
  return (
    <span
      className={cx(
        "relative block h-1 overflow-hidden rounded-full bg-line-strong",
        first ? "mt-2" : "mt-1.5",
        width,
      )}
    >
      <span
        className="ms-ocr-fill absolute inset-0 rounded-full"
        style={{ transitionDelay: `${delay}ms` }}
      />
    </span>
  );
}

function OcrDemo({ caption }: { caption: string }) {
  return (
    <div className="ms-demo relative h-full overflow-hidden p-4">
      <div className="relative mx-auto h-full max-w-[150px] rounded-md border border-line bg-card p-2.5 shadow-sm">
        <span className="mono-caps block text-[0.45rem] text-faint">{caption}</span>
        {/* The delays track the scan line down the page, so each field is
            read as the light passes over it rather than all at once. */}
        <OcrLine width="w-full" delay={300} first />
        <OcrLine width="w-4/5" delay={700} />
        <OcrLine width="w-2/3" delay={1100} />
        <OcrLine width="w-3/4" delay={1500} />
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
          className="ms-bill-row flex items-center gap-2 rounded-md border border-line bg-card px-2 py-1"
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
    <section
      id="kya-karta-hai"
      className="relative scroll-mt-24 overflow-hidden border-y border-line bg-sunken py-24"
    >
      {/* The logo's circuit routing as a flat texture, drifting against the
          scroll. It is the one thing that stops the sunken band reading as a
          slightly greyer rectangle in light mode. */}
      <Parallax speed={90} className="pointer-events-none absolute inset-0">
        <div className="circuit-pattern-light absolute inset-x-0 -inset-y-16 opacity-70 dark:opacity-40" />
      </Parallax>
      <Grain />

      <Shell className="relative">
        <SectionHead
          eyebrow={tr("Capabilities", "Salahiyatein")}
          title={[
            tr("Everything a visit", "Ilaaj ka har qadam,"),
            { text: tr("touches", "ek jagah"), gradient: true },
          ]}
          lede={tr(
            "One path, from booking to paying.",
            "Ek rasta — booking se bill tak.",
          )}
        />

        <div className="mt-12 grid gap-5 md:grid-cols-3">
          <Rise className="md:col-span-2 md:row-span-2" y={34}>
            <Tile
              className="h-full"
              shotDelay={0}
              shotDuration={3200}
              demoClassName="min-h-[330px] !border-0 !bg-transparent"
              icon="smart_toy"
              title={tr("AI health assistant", "AI health assistant")}
              body={tr(
                "Answers from your own records. Anything serious goes to a doctor.",
                "Aap ke apne record se jawab. Sangeen baat doctor tak jaati hai.",
              )}
              demo={
                <AssistantChatDemo chrome="bare" className="p-0" />
              }
            />
          </Rise>

          <Rise delay={70} y={34}>
            <Tile
              className="h-full"
              shotDelay={320}
              shotDuration={1900}
              icon="mic"
              title={tr("Speak your symptoms", "Apni takleef bol kar batayein")}
              body={tr(
                "Your voice becomes text on your own device.",
                "Aap ki awaaz aap ke apne device par likhai banti hai.",
              )}
              demo={
                <VoiceDemo caption={tr("Listening", "Sun raha hai")} />
              }
            />
          </Rise>

          <Rise delay={140} y={34}>
            <Tile
              className="h-full"
              shotDelay={640}
              shotDuration={2400}
              icon="document_scanner"
              title={tr("Reads your documents", "Aap ke documents parh leta hai")}
              body={tr(
                "Reports read themselves. A doctor confirms every value.",
                "Reports khud parhi jaati hain. Har qeemat doctor tasdeeq karta hai.",
              )}
              demo={
                <OcrDemo caption={tr("Report", "Report")} />
              }
            />
          </Rise>

          <Rise delay={210} y={34}>
            <Tile
              className="h-full"
              shotDelay={0}
              shotDuration={2600}
              icon="monitor_heart"
              title={tr("Live vital monitoring", "Vitals par live nazar")}
              body={tr(
                "A reading past its limit reaches a doctor at once.",
                "Had se bahar reading foran doctor tak pahunchti hai.",
              )}
              demo={
                <VitalsDemo caption={tr("Threshold breached", "Had paar ho gayi")} />
              }
            />
          </Rise>

          <Rise delay={280} y={34}>
            <Tile
              className="h-full"
              shotDelay={320}
              shotDuration={1200}
              icon="receipt_long"
              title={tr("Billing that just happens", "Billing jo khud ho jaati hai")}
              body={tr(
                "A finished consultation raises its own invoice.",
                "Consultation khatam, invoice khud ban gaya.",
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
          </Rise>

          <Rise delay={350} y={34}>
            <Tile
              className="h-full"
              shotDelay={640}
              shotDuration={2000}
              icon="policy"
              title={tr("Emergency access, on the record", "Emergency access, poore record ke saath")}
              body={tr(
                "One chart, on a timer, in a record nobody can edit.",
                "Ek file, waqt ki had mein, aise record mein jo badla nahi ja sakta.",
              )}
              demo={
                <AuditDemo caption={tr("Append-only", "Sirf barhta hai")} />
              }
            />
          </Rise>
        </div>
      </Shell>
    </section>
  );
}
