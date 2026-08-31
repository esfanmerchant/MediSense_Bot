"use client";

/**
 * Three portals, one record.
 *
 * The hard thing to communicate about role-based access is that it is not a
 * settings screen — it is three genuinely different products over one set of
 * facts. Words alone do not carry that, so each card shows what its portal
 * *looks* like.
 *
 * **The previews are drawings, and they say so.** Rendering the real admin,
 * doctor or patient screens here is impossible — they need a session, an API
 * and a person — and faking them convincingly enough to be mistaken for
 * screenshots would be a small lie in the most trust-sensitive part of the
 * page. Each frame is built from the design system's own primitives, is
 * labelled `Illustration`, and is `aria-hidden` so a screen reader gets the
 * three capabilities underneath instead of a description of a picture.
 */

import { Icon } from "@/components/Icon";
import { cx } from "@/components/ui";
import { useTr } from "@/lib/lang";

import { Grain, Rise, SectionHead, Shell } from "./parts";

/* ------------------------------------------------------------------ */
/* The drawings                                                        */
/* ------------------------------------------------------------------ */

function Bar({ height, delay }: { height: string; delay: string }) {
  return (
    <span
      className="bg-gradient-brand ms-bar block w-2.5 rounded-t-sm"
      style={{ height, animationDelay: delay }}
    />
  );
}

/** Admin: a ledger and a month of billing. */
function AdminPreview() {
  return (
    <div aria-hidden className="ms-demo flex h-full flex-col gap-2.5">
      <div className="flex items-end gap-1.5 px-1">
        <Bar height="46%" delay="0ms" />
        <Bar height="72%" delay="180ms" />
        <Bar height="34%" delay="360ms" />
        <Bar height="88%" delay="120ms" />
        <Bar height="58%" delay="300ms" />
        <Bar height="76%" delay="60ms" />
        <span className="mono-caps ml-auto self-start text-[0.5rem] text-faint">PKR</span>
      </div>
      <div className="space-y-1.5 rounded-lg border border-line bg-card p-2">
        {[
          ["INV-2041", "w-10", "bg-stable-soft text-stable"],
          ["INV-2042", "w-14", "bg-warning-soft text-warning"],
          ["INV-2043", "w-8", "bg-stable-soft text-stable"],
        ].map(([id, width, tone]) => (
          <div key={id} className="flex items-center gap-2">
            <span className="font-mono text-[0.5rem] text-faint">{id}</span>
            <span className={cx("h-1.5 rounded-full bg-line-strong", width)} />
            <span className={cx("ml-auto rounded-full px-1.5 py-px text-[0.5rem] font-bold", tone)}>
              ●
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Doctor: a ward list where one row is shouting. */
function DoctorPreview() {
  return (
    <div aria-hidden className="ms-demo flex h-full flex-col gap-2">
      <div className="rounded-lg border border-critical bg-critical-soft p-2">
        <div className="flex items-center gap-1.5">
          <span className="pulse-dot h-1.5 w-1.5 rounded-full bg-critical" />
          <span className="mono-caps text-[0.5rem] text-critical">HR 138</span>
          <span className="ml-auto font-mono text-[0.5rem] text-critical">BED 12</span>
        </div>
        <svg viewBox="0 0 120 20" className="mt-1 h-5 w-full" fill="none" preserveAspectRatio="none">
          <path
            d="M0 12 H26 L30 12 L34 4 L39 18 L43 12 H66 L70 8 L73 12 H120"
            className="stroke-critical"
            strokeWidth="1.4"
            vectorEffect="non-scaling-stroke"
            opacity="0.35"
          />
          <path
            d="M0 12 H26 L30 12 L34 4 L39 18 L43 12 H66 L70 8 L73 12 H120"
            className="ecg-sweep stroke-critical"
            strokeWidth="1.8"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
      </div>
      {["w-16", "w-12", "w-20"].map((width, index) => (
        <div key={width} className="flex items-center gap-2 rounded-lg border border-line bg-card p-2">
          <span className="bg-gradient-soft h-4 w-4 shrink-0 rounded-full" />
          <span className={cx("h-1.5 rounded-full bg-line-strong", width)} />
          <span
            className="mono-caps ml-auto rounded-full bg-stable-soft px-1.5 text-[0.5rem] text-stable"
            style={{ opacity: 1 - index * 0.2 }}
          >
            OK
          </span>
        </div>
      ))}
    </div>
  );
}

/** Patient: a question at 2am, and an answer that arrives. */
function PatientPreview() {
  return (
    <div aria-hidden className="ms-demo flex h-full flex-col justify-end gap-2">
      <div className="flex gap-1.5">
        {[
          ["72", "bpm"],
          ["98", "%"],
          ["36.8", "°C"],
        ].map(([value, unit]) => (
          <span
            key={unit}
            className="flex-1 rounded-lg border border-line bg-card px-1.5 py-1 text-center"
          >
            <span className="block font-mono text-[0.65rem] font-semibold text-strong">{value}</span>
            <span className="mono-caps block text-[0.45rem] text-faint">{unit}</span>
          </span>
        ))}
      </div>
      <span className="bg-gradient-brand ml-auto w-[62%] rounded-xl rounded-br-sm px-2 py-1.5">
        <span className="block h-1 w-full rounded-full bg-white/70" />
        <span className="mt-1 block h-1 w-2/3 rounded-full bg-white/40" />
      </span>
      <span className="w-[72%] rounded-xl rounded-bl-sm border border-line bg-card px-2 py-1.5">
        <span className="flex items-center gap-1">
          <span className="typing-dot h-1 w-1 rounded-full bg-accent-bright" />
          <span className="typing-dot h-1 w-1 rounded-full bg-accent-bright" />
          <span className="typing-dot h-1 w-1 rounded-full bg-accent-bright" />
        </span>
        <span className="mt-1.5 block h-1 w-full rounded-full bg-line-strong" />
        <span className="mt-1 block h-1 w-4/5 rounded-full bg-line-strong" />
      </span>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* The section                                                         */
/* ------------------------------------------------------------------ */

export function Portals() {
  const tr = useTr();

  const portals = [
    {
      key: "admin",
      icon: "admin_panel_settings",
      who: tr("Administrators", "Intezamia"),
      line: tr(
        "Run the hospital without reading anyone's diagnosis.",
        "Hospital chalayein — kisi ki bimari parhe baghair.",
      ),
      points: [
        tr("Scheduling and staff", "Schedule aur staff"),
        tr("Billing, invoices, credit notes", "Billing, invoices aur credit notes"),
        tr("Audit trail and break-glass review", "Audit trail aur emergency access ka review"),
      ],
      preview: <AdminPreview />,
    },
    {
      key: "doctor",
      icon: "stethoscope",
      who: tr("Doctors", "Doctors"),
      line: tr(
        "Your patients, your alerts, your notes — one screen, not six.",
        "Aap ke mareez, aap ke alerts, aap ke notes — chhe screens nahi, sirf ek.",
      ),
      points: [
        tr("Live vital alerts as they happen", "Vitals ke alerts, usi waqt"),
        tr("Charts, prescribing, consultation notes", "Charts, nuskha likhna, consultation notes"),
        tr("Document reading with review", "Documents ki parhai, review ke saath"),
      ],
      preview: <DoctorPreview />,
    },
    {
      key: "patient",
      icon: "person",
      who: tr("Patients", "Mareez"),
      line: tr(
        "Book a visit, read your own history, ask a question at 2am.",
        "Appointment book karein, apni puri history parhein, raat 2 baje bhi sawal poochein.",
      ),
      points: [
        tr("Appointments and reminders", "Appointments aur yaad-dehani"),
        tr("Records, prescriptions, invoices", "Records, nuskhe aur bills"),
        tr("Health assistant with voice input", "Awaaz se chalne wala health assistant"),
      ],
      preview: <PatientPreview />,
    },
  ];

  return (
    <section id="portals" className="relative scroll-mt-24 overflow-hidden py-24">
      {/* One ramp wash behind the grid, so three white cards are not floating
          on nothing. It drifts, which is the whole difference on a light page
          between depth and a gradient somebody applied once. */}
      <div
        aria-hidden
        className="ms-aurora pointer-events-none absolute inset-0"
      >
        <span
          className="ms-aurora-b animate-drift-late"
          style={{ right: "-10%", top: "8%", width: "44%", paddingBottom: "44%" }}
        />
      </div>
      <Grain />

      <Shell className="relative">
        <SectionHead
          eyebrow={tr("Three portals", "Teen portals")}
          title={[
            tr("Three portals,", "Teen portals,"),
            { text: tr("one record", "ek record"), gradient: true },
          ]}
          lede={tr(
            "Everyone sees what their job needs. Nothing more.",
            "Har shakhs sirf apne kaam ki cheez dekhta hai. Is se zyada kuchh nahi.",
          )}
        />

        <div className="mt-12 grid gap-5 md:grid-cols-3">
          {portals.map((portal, index) => (
            <Rise key={portal.key} delay={index * 110} y={34} className="h-full">
              <article className="hover-lift ms-edge group flex h-full flex-col overflow-hidden rounded-2xl border border-line bg-card p-6 shadow-card">
                <span
                  aria-hidden
                  className="bg-gradient-brand grid h-12 w-12 shrink-0 place-items-center rounded-full p-[2px]"
                >
                  <span className="grid h-full w-full place-items-center rounded-full bg-card text-primary">
                    <Icon name={portal.icon} filled className="icon-bounce text-[24px]" />
                  </span>
                </span>

                <h3 className="mt-5 font-display text-xl font-bold text-strong">{portal.who}</h3>
                <p className="mt-2 text-[15px] leading-relaxed text-muted">{portal.line}</p>

                {/* The drawing. Held to a fixed height so three cards line up
                    whatever the copy above does. */}
                <div className="relative mt-5 h-[148px] overflow-hidden rounded-xl border border-line bg-sunken p-3">
                  <div className="bg-gradient-soft pointer-events-none absolute inset-0" />
                  <div className="relative h-full transition-transform duration-500 ease-out group-hover:scale-[1.04]">
                    {portal.preview}
                  </div>
                  <span className="mono-caps absolute bottom-1.5 right-2 text-[0.5rem] text-faint">
                    {tr("Illustration", "Sirf tasveeri misaal")}
                  </span>
                </div>

                <ul className="mt-5 space-y-2.5 border-t border-line pt-5">
                  {portal.points.map((point) => (
                    <li key={point} className="flex items-start gap-2.5 text-sm text-muted">
                      <Icon name="check" className="mt-0.5 shrink-0 text-[16px] text-accent" />
                      {point}
                    </li>
                  ))}
                </ul>
              </article>
            </Rise>
          ))}
        </div>
      </Shell>
    </section>
  );
}
