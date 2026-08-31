"use client";

/**
 * The assistant, mid-conversation, on the screens where nobody has signed in.
 *
 * A still screenshot of a chat asks you to imagine the product. This one plays:
 * a question lands, the dots come up while the assistant thinks, the answer
 * arrives, and after a beat the next question follows. Three exchanges, then it
 * starts over — chosen so that the last thing it says before looping is the
 * thing that matters most, which is that it will not diagnose you.
 *
 * **It is an illustration, not a transcript.** The whole thing is `aria-hidden`
 * and holds nothing focusable: a screen reader announcing fake messages arriving
 * one at a time, over the top of a sign-in form, would be a small disaster.
 *
 * **It knows when to stop.** Three separate things silence it, and all of them
 * are the same switch:
 *
 *   - `prefers-reduced-motion` — the finished conversation, complete and still,
 *     with no timer ever scheduled;
 *   - a backgrounded tab (`visibilitychange`) — frozen exactly where it was,
 *     because a login page left open in a spare tab should cost nothing;
 *   - unmount — the pending `setTimeout` is the effect's own, and the effect
 *     clears it.
 *
 * Both environment questions are asked through `useSyncExternalStore` rather
 * than an effect that calls `setState`. The server snapshot is "motion is fine,
 * the tab is visible", so the prerendered HTML and the first client render agree
 * and React swaps in the truth right after hydration — no mismatch, and no
 * second render pass for something that was never state.
 */

import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";

import { Icon } from "@/components/Icon";
import { LogoMark } from "@/components/brand/Logo";
import { cx } from "@/components/ui";
import { useTr } from "@/lib/lang";

// ---------------------------------------------------------------------------
// What the environment says
// ---------------------------------------------------------------------------

function subscribeVisibility(onChange: () => void): () => void {
  document.addEventListener("visibilitychange", onChange);
  return () => document.removeEventListener("visibilitychange", onChange);
}

/** True while this tab is in the background. */
function useTabHidden(): boolean {
  return useSyncExternalStore(
    subscribeVisibility,
    () => document.visibilityState === "hidden",
    () => false,
  );
}

const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

function subscribeMotion(onChange: () => void): () => void {
  const query = window.matchMedia(REDUCED_MOTION);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

/** True when the reader has asked the system for less movement. */
function usePrefersStillness(): boolean {
  return useSyncExternalStore(
    subscribeMotion,
    () => window.matchMedia(REDUCED_MOTION).matches,
    () => false,
  );
}

// ---------------------------------------------------------------------------
// The script
// ---------------------------------------------------------------------------

interface Turn {
  from: "patient" | "assistant";
  text: string;
  /** The line that keeps the assistant honest, under its first answer. */
  note?: string;
}

/** Rough word count — enough to time a beat by, not enough to be precise. */
function words(text: string): number {
  return text.trim().split(/\s+/).length;
}

/** Before the first question lands, after the conversation has restarted. */
const OPENING_MS = 700;
/** The question has been read; the dots have not come up yet. */
const THINKING_MS = 620;
/** The finished conversation, held still before it starts over. */
const HOLD_MS = 3400;

/** How long the dots stay up — a long answer takes longer to write. */
function typingMs(text: string): number {
  return Math.min(2400, 640 + words(text) * 55);
}

/** How long an answer stays alone on screen before the next question. */
function readingMs(text: string): number {
  return Math.min(6200, 1500 + words(text) * 130);
}

/** Per character, while the question is being written into the composer. */
const KEYSTROKE_MS = 34;
/** The beat between the last character and the message leaving — a thumb
    travelling to send. Without it the bubble appears the instant typing stops,
    which reads as a machine rather than a person. */
const SEND_MS = 420;

// ---------------------------------------------------------------------------

export function AssistantChatDemo({
  className,
  chrome = "phone",
}: {
  className?: string;
  /**
   * `phone` draws the handset shell and the "Example" caption — right on the
   * sign-in page, where the demo is the only thing in its column. `bare` drops
   * both for a panel that already has a frame and a heading of its own, so the
   * page does not end up with a border inside a border inside a card.
   */
  chrome?: "phone" | "bare";
}) {
  const tr = useTr();
  const still = usePrefersStillness();
  const hidden = useTabHidden();

  // `tr` is stable per language, so the script is rebuilt only when the
  // language toggle flips — which restarts the beat, which is the right
  // behaviour: half a conversation in two languages is nobody's demo.
  const script = useMemo<Turn[]>(
    () => [
      {
        from: "patient",
        text: tr(
          "What is my blood pressure tablet for?",
          "Meri blood pressure ki goli kis liye hai?",
        ),
      },
      {
        from: "assistant",
        text: tr(
          "Amlodipine 5 mg, on your record since March, relaxes blood vessels so your pressure stays lower through the day. Take it at the same time each day — and if you get swollen ankles, mention it at your visit on the 12th.",
          "Amlodipine 5 mg, jo March se aap ke record par hai, khoon ki naliyon ko dheela karti hai taake din bhar pressure kam rahe. Roz ek hi waqt par lein — aur agar takhnay soojein to 12 tareekh ki visit par zikr karein.",
        ),
        note: tr("Guidance, not a diagnosis.", "Rehnumai, tashkhees nahi."),
      },
      {
        from: "patient",
        text: tr(
          "My knee has been hurting. Which department do I book?",
          "Ghutne mein dard hai. Kis department mein appointment lun?",
        ),
      },
      {
        from: "assistant",
        text: tr(
          "Knee pain usually starts with Orthopaedics. There are three free slots on Thursday — I can open the booking page for you.",
          "Ghutne ke dard ke liye aam tor par Orthopaedics. Jumeraat ko teen slot khali hain — main booking ka safha khol deta hoon.",
        ),
      },
      {
        from: "patient",
        text: tr("Can you tell me if it is arthritis?", "Kya aap bata sakte hain ke yeh arthritis hai?"),
      },
      {
        from: "assistant",
        text: tr(
          "That is a diagnosis, and a diagnosis is not mine to make. I have added your question to your file so Dr Farooq sees it at the visit.",
          "Yeh tashkhees hai, aur tashkhees mera kaam nahi. Main ne aap ka sawal file mein likh diya hai taake Dr Farooq visit par dekh lein.",
        ),
      },
    ],
    [tr],
  );

  /** How many turns are on screen. One at first render, so the frame is never
      empty in the prerendered HTML. */
  const [shown, setShown] = useState(1);
  const [typing, setTyping] = useState(false);
  /** The question as far as it has been written into the composer. */
  const [draft, setDraft] = useState("");
  /** True while a question is being written rather than waiting to be sent. */
  const [composing, setComposing] = useState(false);
  /** Bumped on every restart, so a loop's bubbles never share a key with the
      bubbles still fading out from the loop before it. */
  const [cycle, setCycle] = useState(0);

  const frozen = still || hidden;

  useEffect(() => {
    if (frozen) return;

    let id: number;
    if (shown >= script.length) {
      // Everything has been said. Hold it, then start again from nothing.
      id = window.setTimeout(() => {
        setShown(0);
        setTyping(false);
        setComposing(false);
        setDraft("");
        setCycle((current) => current + 1);
      }, HOLD_MS);
    } else if (script[shown].from === "assistant") {
      id = typing
        ? window.setTimeout(() => {
            setTyping(false);
            setShown((current) => current + 1);
          }, typingMs(script[shown].text))
        : window.setTimeout(() => setTyping(true), THINKING_MS);
    } else {
      // A question waits for the previous answer to have been read, and is then
      // *written* rather than appearing whole — see the composing effect below.
      const previous = script[shown - 1];
      id = window.setTimeout(
        () => setComposing(true),
        previous ? readingMs(previous.text) : OPENING_MS,
      );
    }
    return () => window.clearTimeout(id);
  }, [script, shown, typing, frozen]);

  /**
   * The question being written, one character at a time, into the composer.
   *
   * This is the half a still screenshot cannot show: a person types, and only
   * then does a bubble exist. Driven by `draft.length` rather than an interval
   * so it is a chain of single timeouts — each render schedules exactly one
   * more keystroke, and React's cleanup cancels it, which means a language
   * flip or an unmount mid-sentence leaves nothing running.
   */
  useEffect(() => {
    if (!composing || frozen) return;

    const full = script[shown]?.text ?? "";

    if (draft.length >= full.length) {
      const id = window.setTimeout(() => {
        setComposing(false);
        setDraft("");
        setShown((current) => current + 1);
      }, SEND_MS);
      return () => window.clearTimeout(id);
    }

    const id = window.setTimeout(
      () => setDraft(full.slice(0, draft.length + 1)),
      KEYSTROKE_MS,
    );
    return () => window.clearTimeout(id);
  }, [composing, draft, shown, script, frozen]);

  // Reduced motion gets the end of the conversation rather than the start of
  // it: the point is what the assistant says, not the order it arrives in.
  const turns = still ? script : script.slice(0, shown);
  const enter = still ? { duration: 0 } : { duration: 0.34, ease: "easeOut" as const };

  const bare = chrome === "bare";

  return (
    <div aria-hidden className={cx("relative", bare && "h-full", className)}>
      {/* Honest labelling, for eyes only — the demo is hidden from assistive
          technology, so this caption lives inside it rather than beside it.
          The bare variant leaves it out because the panel around it is already
          captioned. */}
      {!bare && (
        <p className="mb-3 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-white/80">
          <span className="pulse-dot-brand h-1.5 w-1.5 rounded-full bg-accent-bright" />
          {tr("Example", "Misal")}
        </p>
      )}

      {/* The handset. */}
      <div
        className={cx(
          "relative",
          bare
            ? "h-full"
            : "rounded-[1.9rem] border border-white/25 bg-white/10 p-2.5 shadow-float backdrop-blur-sm",
        )}
      >
        <div
          className={cx(
            "flex flex-col overflow-hidden bg-card",
            bare ? "h-full rounded-xl" : "rounded-[1.4rem]",
          )}
        >
          {!bare && (
            <div className="flex justify-center pt-2.5">
              <span className="h-1 w-9 rounded-full bg-line-strong" />
            </div>
          )}

          {/* Who you are talking to. */}
          <div className="flex items-center gap-2.5 border-b border-line px-3.5 pb-3 pt-2.5">
            <span className="bg-gradient-brand grid h-9 w-9 shrink-0 place-items-center rounded-full shadow-sm">
              <LogoMark onDark className="h-[15px] w-auto" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13.5px] font-semibold leading-tight text-strong">
                {tr("MediSense Assistant", "MediSense Assistant")}
              </span>
              <span className="mt-0.5 flex items-center gap-1.5 text-[11.5px] font-medium text-muted">
                <span className="h-1.5 w-1.5 rounded-full bg-accent-bright" />
                {tr("Online", "Online")}
              </span>
            </span>
            <Icon name="more_vert" className="text-[18px] text-faint" />
          </div>

          {/* The thread. Messages stack from the bottom and the oldest ones
              slide up under the fade, the way a real one scrolls. */}
          <div className={cx("relative", bare && "flex-1")}>
            {/* Wallpaper, in the logo's circuit traces. A chat with one message
                in it should read as a chat that has just started, and an empty
                white rectangle reads as something broken. */}
            <span
              aria-hidden
              className="circuit-pattern-light pointer-events-none absolute inset-0 opacity-70"
            />
            <div
              className={cx(
                "relative flex flex-col justify-end gap-2 px-3.5 pb-3 pt-5",
                // Fixed on the sign-in page, where the column has a known
                // height; grown to fill inside a tile, which sets its own.
                bare ? "h-full min-h-[248px]" : "h-[212px] xl:h-[252px]",
              )}
              style={{
                maskImage: "linear-gradient(to bottom, transparent, #000 14%)",
                WebkitMaskImage: "linear-gradient(to bottom, transparent, #000 14%)",
              }}
            >
              <AnimatePresence initial={false}>
                {turns.map((turn, index) => (
                  <motion.div
                    key={`${cycle}:${index}`}
                    layout="position"
                    initial={{ opacity: 0, y: 14, scale: 0.98 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.98, transition: { duration: still ? 0 : 0.22 } }}
                    transition={enter}
                    className={cx(
                      "shrink-0",
                      turn.from === "patient" ? "ml-auto max-w-[88%]" : "mr-auto max-w-[94%]",
                    )}
                  >
                    <div
                      className={cx(
                        "rounded-2xl px-3.5 py-2.5 text-sm leading-[1.5]",
                        turn.from === "patient"
                          ? "rounded-br-md bg-primary font-medium text-primary-on"
                          : "rounded-bl-md border border-line bg-sunken text-strong",
                      )}
                    >
                      {turn.text}
                      {turn.note && (
                        <span className="mt-2 flex items-center gap-1.5 text-[11.5px] font-semibold text-muted">
                          <Icon name="shield" className="text-[14px]" />
                          {turn.note}
                        </span>
                      )}
                    </div>
                  </motion.div>
                ))}
  
                {typing && !still && (
                  <motion.div
                    key={`${cycle}:typing`}
                    layout="position"
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, transition: { duration: 0.15 } }}
                    transition={enter}
                    className="mr-auto shrink-0"
                  >
                    <span className="flex items-center gap-1.5 rounded-2xl rounded-bl-md border border-line bg-sunken px-3.5 py-3">
                      <span className="typing-dot bg-gradient-brand h-1.5 w-1.5 rounded-full" />
                      <span className="typing-dot bg-gradient-brand h-1.5 w-1.5 rounded-full" />
                      <span className="typing-dot bg-gradient-brand h-1.5 w-1.5 rounded-full" />
                    </span>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </div>

          {/* The composer writes. Nothing here can be typed into by a reader —
              it is still furniture — but the question is now *composed* in it
              before it becomes a bubble, which is the half of the exchange a
              screenshot cannot show: somebody asked this. */}
          <div className="flex items-center gap-2 border-t border-line px-3 py-2.5">
            <span
              className={cx(
                "min-w-0 flex-1 rounded-full bg-sunken px-3.5 py-2 text-[12.5px]",
                draft ? "text-strong" : "truncate text-muted",
              )}
            >
              {draft ? (
                <>
                  {/* No truncation while writing: a question that ellipses at
                      the halfway mark reads as a bug rather than as typing. */}
                  <span className="line-clamp-2">{draft}</span>
                </>
              ) : (
                tr("Ask about your care…", "Apni dekh-bhaal ke baare mein poochhein…")
              )}
            </span>
            <span
              className={cx(
                "grid h-8 w-8 shrink-0 place-items-center rounded-full text-white transition-opacity duration-200",
                // Dimmed until there is something to send, so the button reads
                // as part of the same act rather than as decoration.
                draft ? "bg-gradient-brand opacity-100 shadow-sm" : "bg-line-strong opacity-60",
              )}
            >
              <Icon name="send" filled className="text-[16px]" />
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
