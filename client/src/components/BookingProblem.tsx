"use client";

/**
 * Why the appointment the assistant went looking for is not there.
 *
 * The assistant used to say "I have found a time, confirm it on screen" before
 * anything had read the diary. When the day turned out to be one the doctor
 * does not work — or a day that had already gone — the sentence stood, no card
 * appeared, and the patient was left holding two contradictory things. The
 * model now says it is *checking*, the server reads the diary, and this states
 * what it found.
 *
 * **The reason comes from the server; the words are written here.** The server
 * knows which doctor and which day; only the client knows which of the two
 * languages this reader chose. Sending a sentence would have meant the server
 * guessing that, and guessing it wrong for half the people using it.
 *
 * Every case ends with somewhere to go. "Not available" with no next step is a
 * dead end, and the whole point of asking an assistant was to avoid the
 * calendar.
 */

import Link from "next/link";

import { Icon } from "@/components/Icon";
import { cx } from "@/components/ui";
import { useTr } from "@/lib/lang";
import type { BookingProblem as Problem } from "@/lib/api";

/**
 * A date the server sent, written out.
 *
 * Built from the parts rather than `new Date(iso)`. A bare "2026-09-02" parses
 * as midnight *UTC*, and rendering that in a timezone behind UTC prints the day
 * before — which, on a card whose whole job is to say which day a doctor sits,
 * would be the same class of mistake it exists to correct.
 */
function day(iso: string | undefined): string {
  if (!iso) return "";
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return iso;
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

export function BookingProblem({ problem }: { problem: Problem }) {
  const tr = useTr();
  const who = problem.doctorName ?? tr("that doctor", "us doctor");

  let headline: string;
  let detail: string | null = null;

  switch (problem.reason) {
    case "past":
      headline = tr(
        `${day(problem.date)} has already passed.`,
        `${day(problem.date)} guzar chuki hai.`,
      );
      detail = tr(
        "An appointment can only be booked for a day still to come. Tell me which upcoming day suits you.",
        "Appointment sirf aane wale din ke liye ho sakti hai. Bataiye kaun sa aane wala din theek rahega.",
      );
      break;

    case "not_working":
      headline = tr(
        `${who} does not see patients on ${day(problem.date)}.`,
        `${who} ${day(problem.date)} ko mareez nahi dekhte.`,
      );
      detail = problem.worksOn
        ? tr(`They sit on ${problem.worksOn}.`, `Woh ${problem.worksOn} ko baithte hain.`)
        : null;
      break;

    case "day_full":
      headline = tr(
        `${who} is fully booked on ${day(problem.date)}.`,
        `${day(problem.date)} ko ${who} ka poora din book hai.`,
      );
      detail = tr("Every slot that day is taken.", "Us din ka har waqt le liya gaya hai.");
      break;

    case "unknown_doctor":
      headline = tr(
        `I could not find a doctor called ${who}.`,
        `${who} naam ka koi doctor nahi mila.`,
      );
      detail = tr(
        "Check the spelling, or browse the doctors and pick one.",
        "Hijje dekh lein, ya doctors ki fehrist se chunein.",
      );
      break;

    case "ambiguous_doctor":
      headline = tr(
        `More than one doctor matches "${who}".`,
        `"${who}" se ek se zyada doctor milte hain.`,
      );
      detail = tr(
        "Pick the one you mean and I will check their diary.",
        "Jo aap ka maqsood hai unhein chunein, main un ka waqt dekh leta hoon.",
      );
      break;

    default:
      headline = tr(
        `${who} cannot be booked right now.`,
        `${who} ke saath abhi appointment nahi ho sakti.`,
      );
      detail = tr(
        "They may not have published their hours yet.",
        "Shayad unhon ne abhi apne auqaat share nahi kiye.",
      );
  }

  const free = problem.nextFree ?? [];

  return (
    <div className="pop-in mt-3 rounded-2xl border border-warning/40 bg-warning-soft/60 p-4">
      <div className="flex items-start gap-3">
        <span
          aria-hidden
          className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-warning/15 text-warning"
        >
          <Icon name="event_busy" className="text-[22px]" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[0.9375rem] font-semibold text-strong">{headline}</p>
          {detail && <p className="mt-1 text-sm leading-relaxed text-muted">{detail}</p>}

          {free.length > 0 && (
            <>
              <p className="mono-caps mt-3 text-[10px] text-faint">
                {tr("Next free", "Agla khali waqt")}
              </p>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {free.map((iso) => (
                  <Link
                    key={iso}
                    href={
                      problem.doctorId
                        ? `/patient/appointments?doctorId=${problem.doctorId}&date=${iso}`
                        : "/patient/appointments"
                    }
                    className={cx(
                      "inline-flex min-h-11 items-center rounded-xl border border-line bg-card px-3",
                      "text-sm font-semibold text-strong transition-colors hover:border-primary hover:text-primary",
                      "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary",
                    )}
                  >
                    {day(iso)}
                  </Link>
                ))}
              </div>
            </>
          )}

          {free.length === 0 && (
            <Link
              href="/patient/appointments"
              className="mt-3 inline-flex min-h-11 items-center gap-1.5 text-sm font-semibold text-primary hover:underline"
            >
              {tr("Open the booking page", "Booking ka safha kholein")}
              <Icon name="arrow_forward" className="text-[18px]" />
            </Link>
          )}
        </div>
      </div>
    </div>
  );
}
