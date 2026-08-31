"use client";

/**
 * A time the assistant found, waiting for the patient to say yes.
 *
 * **Nothing is booked until this is pressed**, and the card says so. The model
 * can misread a name or a weekday, and a wrong appointment costs a clinic slot
 * and somebody's day — so it proposes and a person decides. That is the same
 * arrangement the symptom flow already uses, and the reason the assistant's own
 * sentence says it *found* a time rather than that it took one.
 *
 * The other free times that day are offered here too. Somebody who wants four
 * o'clock rather than the first slot should not have to abandon the
 * conversation for the booking screen and start again.
 */

import { useState } from "react";

import { Icon } from "@/components/Icon";
import { useToast } from "@/components/overlays";
import { Badge, Button, cx } from "@/components/ui";
import { ApiError, appointments, type BookingProposal } from "@/lib/api";
import { useTr } from "@/lib/lang";

function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function longDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    weekday: "long",
    day: "numeric",
    month: "long",
  });
}

export function BookingOffer({ proposal }: { proposal: BookingProposal }) {
  const tr = useTr();
  const toast = useToast();
  const [chosen, setChosen] = useState(proposal.startTime);
  const [busy, setBusy] = useState(false);
  const [booked, setBooked] = useState(false);

  const times = [
    { startTime: proposal.startTime, endTime: proposal.endTime },
    ...proposal.alternatives,
  ];

  async function confirm() {
    setBusy(true);
    try {
      await appointments.book({
        doctorId: proposal.doctorId,
        startTime: chosen,
        reason: tr("Booked from the assistant", "Assistant se book kiya"),
      });
      setBooked(true);
      toast.show({
        tone: "success",
        title: tr("Appointment booked", "Appointment book ho gayi"),
        body: tr(
          `${proposal.doctorName}, ${longDate(chosen)} at ${clock(chosen)}.`,
          `${proposal.doctorName}, ${longDate(chosen)} ko ${clock(chosen)} baje.`,
        ),
      });
    } catch (cause) {
      toast.show({
        tone: "critical",
        title: tr("Could not book", "Book nahi ho saki"),
        // The server's own words: it knows whether the slot went to somebody
        // else in the meantime, which is the likeliest reason.
        body: cause instanceof ApiError ? cause.message : String(cause),
      });
    } finally {
      setBusy(false);
    }
  }

  if (booked) {
    return (
      <div className="pop-in flex items-center gap-3 rounded-2xl border border-stable/50 bg-stable-soft p-4">
        <Icon name="check_circle" filled className="shrink-0 text-[24px] text-stable" />
        <p className="text-sm font-semibold text-strong">
          {tr(
            `Booked with ${proposal.doctorName} on ${longDate(chosen)} at ${clock(chosen)}.`,
            `${proposal.doctorName} ke saath ${longDate(chosen)} ko ${clock(chosen)} baje book ho gayi.`,
          )}
        </p>
      </div>
    );
  }

  return (
    <div className="glass pop-in space-y-4 rounded-2xl !shadow-card p-4">
      <div className="flex items-center gap-3">
        <span className="bg-gradient-brand grid h-11 w-11 shrink-0 place-items-center rounded-xl text-white shadow-md">
          <Icon name="event_available" filled className="text-[24px]" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-faint">
            {/* Not "Booked". Saying so before anybody confirmed is how a person
                arrives at a clinic that is not expecting them. */}
            {tr("Found a time", "Ek waqt mila")}
          </p>
          <p className="font-display text-base font-bold text-strong">
            {proposal.doctorName}
          </p>
          <p className="text-xs text-muted">
            {proposal.specialization} · {proposal.currency} {proposal.fee}
          </p>
        </div>
      </div>

      <p className="text-sm text-strong">{longDate(proposal.startTime)}</p>

      <div className="flex flex-wrap gap-2">
        {times.map((slot) => (
          <button
            key={slot.startTime}
            type="button"
            aria-pressed={chosen === slot.startTime}
            onClick={() => setChosen(slot.startTime)}
            className={cx(
              "min-h-9 rounded-lg px-3 text-sm font-semibold tabular-nums transition-colors",
              "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary",
              chosen === slot.startTime
                ? "bg-primary text-primary-on"
                : "border border-line bg-card text-muted hover:text-strong",
            )}
          >
            {clock(slot.startTime)}
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={confirm} loading={busy}>
          <Icon name="check" className="text-[20px]" />
          {tr("Confirm this appointment", "Yeh appointment confirm karein")}
        </Button>
        <Badge tone="neutral">{tr("Not booked yet", "Abhi book nahi hui")}</Badge>
      </div>
    </div>
  );
}
