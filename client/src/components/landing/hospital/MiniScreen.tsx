"use client";

/**
 * The little interface that sits under the words, not over the building.
 *
 * These panels used to float across the middle of the scene, which meant the
 * hospital — the thing the section exists to show — was covered up on every
 * stop except the two wide shots. A panel that hides the subject it is
 * annotating is not an annotation.
 *
 * So each one is a card at the foot of the text column: the width of the
 * paragraph above it, capped short enough that the column never outgrows the
 * viewport, and carrying only the one interaction that stop is about. The 3D
 * stays clear.
 */

import { useEffect, useRef, useState } from "react";

import { Icon } from "@/components/Icon";
import { useTr } from "@/lib/lang";

function Shell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="overflow-hidden rounded-xl border border-white/15 bg-[#0A1733]/85 backdrop-blur-sm">
      <div className="flex items-center gap-2 border-b border-white/10 px-3 py-2">
        <span className="h-2 w-2 rounded-full bg-[#0B3FA8]" />
        <span className="h-2 w-2 rounded-full bg-[#1A8FC7]" />
        <span className="h-2 w-2 rounded-full bg-[#14C4C1]" />
        <span className="ml-1 text-[11px] font-semibold text-[#8FA8CC]">{title}</span>
      </div>
      <div className="p-3">{children}</div>
    </div>
  );
}

const BARS = Array.from({ length: 22 }, (_, i) => i);

/** Reception — speak, and watch it become symptoms. */
function Voice() {
  const tr = useTr();
  const [live, setLive] = useState(false);
  const [shown, setShown] = useState(0);
  const chips: [string, string][] = [
    ["fever", "bukhaar"],
    ["headache", "sar dard"],
    ["3 days", "3 din"],
  ];

  useEffect(() => {
    if (!live) return;
    const timer = window.setInterval(() => setShown((n) => Math.min(chips.length, n + 1)), 750);
    return () => window.clearInterval(timer);
  }, [live, chips.length]);

  return (
    <Shell title={tr("Health assistant", "Health assistant")}>
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => {
            setLive((on) => !on);
            setShown(0);
          }}
          aria-pressed={live}
          // An icon is not a name. Without this the only control in the panel
          // is announced as "button", which is the same as not being there.
          aria-label={live ? tr("Stop speaking", "Bolna band karein") : tr("Speak", "Bolein")}
          className="bg-gradient-brand grid h-11 w-11 shrink-0 place-items-center rounded-full text-white"
        >
          <Icon name={live ? "mic" : "mic_off"} filled className="text-[20px]" />
        </button>
        <span className="flex h-9 flex-1 items-center gap-[3px]" aria-hidden>
          {BARS.map((i) => (
            <span
              key={i}
              className="w-[3px] flex-1 rounded-full bg-[#14C4C1] transition-[height] duration-150"
              style={{ height: live ? 6 + ((i * 37) % 22) : 5 }}
            />
          ))}
        </span>
      </div>
      <p className="mt-2 min-h-[2.5rem] text-[12px] leading-snug text-[#AFC9E8]">
        {live
          ? `“${tr("Fever and a headache, three days now.", "Bukhaar hai aur sar dard, teen din se.")}”`
          : tr("Press to speak — no form to fill in.", "Bolne ke liye dabayein — koi form nahi.")}
      </p>
      <div className="flex flex-wrap gap-1.5">
        {chips.slice(0, shown).map((chip) => (
          <span
            key={chip[0]}
            className="rounded-md border border-white/15 bg-white/[0.07] px-2 py-1 text-[11px] text-[#DCEBFF]"
          >
            {tr(...chip)}
          </span>
        ))}
      </div>
    </Shell>
  );
}

/** Records — a document being read. */
function Ocr() {
  const tr = useTr();
  return (
    <Shell title={tr("Documents · reading", "Documents · parhi ja rahi")}>
      <div className="grid grid-cols-2 gap-2">
        <div className="relative h-24 overflow-hidden rounded-md border border-white/10 bg-white/[0.06] p-2">
          {[70, 90, 55, 80, 60].map((w, i) => (
            <span key={i} className="mb-1.5 block h-1.5 rounded-sm bg-white/25" style={{ width: `${w}%` }} />
          ))}
          <span className="story-scan absolute inset-x-0 h-0.5 bg-[#14C4C1]" />
        </div>
        <ul className="space-y-1 text-[11px]">
          {[
            ["Hemoglobin", "12.1 g/dL"],
            ["WBC", "11.2"],
            ["Date", "12 Aug"],
          ].map(([label, value]) => (
            <li key={label} className="flex justify-between rounded-md bg-white/[0.07] px-2 py-1">
              <span className="text-[#AFC9E8]">{label}</span>
              <span className="font-mono text-[#DCEBFF]">{value}</span>
            </li>
          ))}
        </ul>
      </div>
    </Shell>
  );
}

/** ICU — the trace, and what happens when it goes wrong. */
function Vitals({ critical }: { critical: boolean }) {
  const tr = useTr();
  const canvas = useRef<HTMLCanvasElement | null>(null);
  // The drawing loop reads this rather than closing over `critical`, so a
  // change of state never restarts the trace mid-beat. Written from an effect:
  // a ref set during render is a value that disagrees with itself if React
  // throws that render away.
  const alarming = useRef(critical);
  useEffect(() => {
    alarming.current = critical;
  }, [critical]);

  useEffect(() => {
    const node = canvas.current;
    if (!node) return;
    const ctx = node.getContext("2d");
    if (!ctx) return;
    const history: number[] = [];
    let frame = 0;
    let running = true;

    const draw = () => {
      const bad = alarming.current;
      const t = performance.now() / 1000;
      const phase = (t * (bad ? 1.9 : 1.2)) % 1;
      let y = 26;
      if (phase < 0.08) y = 26 - Math.sin((phase / 0.08) * Math.PI) ** 2 * 19;
      else if (phase < 0.14) y = 26 + Math.sin(((phase - 0.08) / 0.06) * Math.PI) * 8;
      history.push(y + (Math.random() - 0.5) * (bad ? 3 : 0.8));
      if (history.length > 300) history.shift();

      ctx.fillStyle = "#071129";
      ctx.fillRect(0, 0, 300, 52);
      ctx.strokeStyle = bad ? "#ff6b6b" : "#3fd6d3";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      history.forEach((v, i) => (i ? ctx.lineTo(i, v) : ctx.moveTo(i, v)));
      ctx.stroke();
      if (running) frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => {
      running = false;
      cancelAnimationFrame(frame);
    };
  }, []);

  return (
    <Shell title={tr("Live vitals · bed 3", "Live vitals · bed 3")}>
      <div className="flex items-center justify-between">
        <span className="text-[12px] font-semibold text-[#DCEBFF]">
          {tr("Ward patient", "Ward ka mareez")}
        </span>
        <span
          className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${
            critical ? "bg-[#4a2020] text-[#ff9a9a]" : "bg-[#153b41] text-[#7fe5c6]"
          }`}
        >
          {critical ? tr("Critical", "Nazuk") : tr("Normal", "Normal")}
        </span>
      </div>
      <canvas ref={canvas} width={300} height={52} className="mt-2 w-full rounded-md" />
      <div className="mt-2 grid grid-cols-3 gap-2 text-center">
        {[
          ["HR", critical ? "112" : "72"],
          ["SpO₂", critical ? "91%" : "98%"],
          ["Temp", "37.1°"],
        ].map(([label, value]) => (
          <span key={label} className="rounded-md bg-white/[0.07] py-1">
            <span className="block text-[10px] text-[#8FA8CC]">{label}</span>
            <span className="block font-mono text-[13px] text-[#DCEBFF]">{value}</span>
          </span>
        ))}
      </div>
      {critical && (
        <p className="mt-2 rounded-md bg-[#4a2020] px-2 py-1.5 text-[11px] text-[#ff9a9a]">
          {tr("Doctor alerted in 0.6 s", "Doctor ko 0.6 s mein alert")}
        </p>
      )}
    </Shell>
  );
}

/** Consultation — completing the visit raises the bill. */
function Invoice() {
  const tr = useTr();
  const [done, setDone] = useState(false);
  return (
    <Shell title={tr("Consultation", "Consultation")}>
      <ul className="space-y-1 text-[11px]">
        {[
          [tr("Symptoms (by voice)", "Alamat (awaaz se)"), "bukhaar · sar dard"],
          [tr("Lab report", "Lab report"), tr("read ✓", "parh li ✓")],
        ].map(([label, value]) => (
          <li key={label} className="flex justify-between rounded-md bg-white/[0.07] px-2 py-1.5">
            <span className="text-[#AFC9E8]">{label}</span>
            <span className="text-[#DCEBFF]">{value}</span>
          </li>
        ))}
      </ul>
      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => setDone(true)}
          disabled={done}
          className="bg-gradient-brand rounded-full px-3 py-1.5 text-[11px] font-bold text-white disabled:opacity-60"
        >
          {done ? tr("Completed ✓", "Mukammal ✓") : tr("Mark complete", "Mukammal karein")}
        </button>
        {done && (
          <span className="font-mono text-[11px] text-[#7fe5c6]">INV-2026-0142 ✓</span>
        )}
      </div>
    </Shell>
  );
}

/** Pharmacy — the prescription, and the reminders it sets. */
function Reminders() {
  const tr = useTr();
  const [on, setOn] = useState([true, true, false]);
  const meds: [string, string][] = [
    ["Paracetamol 500 mg", tr("morning, evening", "subah, shaam")],
    ["ORS", tr("twice a day", "din mein 2 baar")],
    ["Omeprazole 20 mg", tr("morning", "subah")],
  ];
  return (
    <Shell title={tr("Prescription", "Nuskha")}>
      <ul className="space-y-1">
        {meds.map(([name, when], i) => (
          <li key={name} className="flex items-center gap-2 rounded-md bg-white/[0.07] px-2 py-1.5">
            <Icon name="pill" filled className="text-[15px] text-[#5EC8E6]" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[11px] font-semibold text-[#DCEBFF]">{name}</span>
              <span className="block text-[10px] text-[#8FA8CC]">{when}</span>
            </span>
            <button
              type="button"
              role="switch"
              aria-checked={on[i]}
              aria-label={`${tr("Reminder for", "Yaad-dehani")} ${name}`}
              onClick={() => setOn((state) => state.map((v, j) => (i === j ? !v : v)))}
              className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${
                on[i] ? "bg-[#14C4C1]" : "bg-white/20"
              }`}
            >
              <span
                className="absolute top-0.5 h-4 w-4 rounded-full bg-white transition-[left]"
                style={{ left: on[i] ? 18 : 2 }}
              />
            </button>
          </li>
        ))}
      </ul>
    </Shell>
  );
}

/** Admin — approving a doctor, and the line it writes. */
function Approvals() {
  const tr = useTr();
  const [approved, setApproved] = useState(false);
  return (
    <Shell title={tr("Doctor requests", "Doctors ki darkhwastein")}>
      <div className="flex items-center justify-between rounded-md bg-white/[0.07] px-2 py-1.5">
        <span>
          <span className="block text-[11px] font-semibold text-[#DCEBFF]">Dr Bilal Khan</span>
          <span className="block text-[10px] text-[#8FA8CC]">Cardiology · PMDC 44812</span>
        </span>
        {approved ? (
          <span className="rounded-full bg-[#153b41] px-2 py-0.5 text-[10px] font-bold text-[#7fe5c6]">
            {tr("Approved ✓", "Manzoor ✓")}
          </span>
        ) : (
          <button
            type="button"
            onClick={() => setApproved(true)}
            className="bg-gradient-brand rounded-full px-3 py-1 text-[11px] font-bold text-white"
          >
            {tr("Approve", "Manzoor")}
          </button>
        )}
      </div>
      <div className="mt-2 space-y-1 font-mono text-[10px]">
        <p className="flex justify-between rounded-md bg-white/[0.05] px-2 py-1 text-[#AFC9E8]">
          <span>10:42 · viewed #4412</span>
          <span className="text-[#7fe5c6]">audit ✓</span>
        </p>
        <p
          className="flex justify-between rounded-md bg-white/[0.05] px-2 py-1 text-[#AFC9E8] transition-opacity"
          style={{ opacity: approved ? 1 : 0.35 }}
        >
          <span>{approved ? "10:44 · approved Dr Bilal" : "— · approve Dr Bilal"}</span>
          <span className={approved ? "text-[#7fe5c6]" : ""}>{approved ? "audit ✓" : "pending"}</span>
        </p>
      </div>
    </Shell>
  );
}

/** The panel a stop shows, if it shows one. Overview and the close do not. */
export function MiniScreen({ room, critical }: { room: string | null; critical: boolean }) {
  if (room === "reception") return <Voice />;
  if (room === "records") return <Ocr />;
  if (room === "icu") return <Vitals critical={critical} />;
  if (room === "consultation") return <Invoice />;
  if (room === "pharmacy") return <Reminders />;
  if (room === "admin") return <Approvals />;
  return null;
}
