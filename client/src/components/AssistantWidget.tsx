"use client";

/**
 * The assistant, one tap away on every patient page.
 *
 * A floating button in the corner that opens into a glass panel holding the
 * same conversation component the full page uses — same consent gate, same
 * safety layer, same disclaimer. Nothing here is a second assistant; it is a
 * second door to the one that exists.
 *
 * The halo around the button asks for attention once. After the panel has
 * been opened in this session it stops, because a pulse that never stops is
 * a notification that never arrives.
 */

import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import Link from "next/link";
import { useState } from "react";

import { AssistantChat } from "@/components/assistant";
import { Icon } from "@/components/Icon";
import { LogoMark } from "@/components/Logo";
import { Button, ErrorState, Loading, cx } from "@/components/ui";
import { assistant as assistantApi } from "@/lib/api";
import { useTr } from "@/lib/lang";
import { useAsync } from "@/lib/useAsync";

const SEEN_KEY = "medisense:assistant-widget-opened";

function seenThisSession(): boolean {
  try {
    return window.sessionStorage.getItem(SEEN_KEY) === "1";
  } catch {
    return false;
  }
}

/** The panel body: checks the assistant is usable before offering a box. */
function WidgetBody() {
  const tr = useTr();
  const status = useAsync(() => assistantApi.status(), []);

  if (status.loading) return <Loading label={tr("Checking the assistant", "Assistant check ho raha hai")} />;
  if (status.error) return <div className="p-4"><ErrorState message={status.error.message} onRetry={status.reload} /></div>;
  if (!status.data?.available) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <LogoMark className="h-12 w-auto" />
        <p className="font-display font-bold text-strong">
          {tr("The assistant needs your consent first", "Assistant ko pehle aap ki ijazat chahiye")}
        </p>
        <p className="text-sm text-muted">
          {tr("Turn it on from the assistant page — it takes a moment.", "Assistant page se chalu karein — ek lamha lagta hai.")}
        </p>
        <Link href="/patient/assistant">
          <Button>{tr("Open the assistant", "Assistant kholein")}</Button>
        </Link>
      </div>
    );
  }
  return <AssistantChat />;
}

export function AssistantWidget() {
  const tr = useTr();
  const reduced = useReducedMotion();
  const [open, setOpen] = useState(false);
  const [seen, setSeen] = useState(() => (typeof window !== "undefined" ? seenThisSession() : true));

  const toggle = () => {
    setOpen((current) => !current);
    if (!seen) {
      setSeen(true);
      try {
        window.sessionStorage.setItem(SEEN_KEY, "1");
      } catch {
        // Not remembered; the halo simply returns next visit.
      }
    }
  };

  return (
    <>
      <AnimatePresence>
        {open && (
          <motion.div
            key="panel"
            role="dialog"
            aria-label={tr("MediSense Assistant", "MediSense Assistant")}
            initial={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.6, y: 24, x: 24 }}
            animate={reduced ? { opacity: 1 } : { opacity: 1, scale: 1, y: 0, x: 0 }}
            exit={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.7, y: 24, x: 24 }}
            transition={{ type: "spring", stiffness: 380, damping: 32 }}
            style={{ transformOrigin: "bottom right" }}
            className="glass fixed bottom-24 right-4 z-40 flex h-[min(600px,calc(100dvh-8rem))] w-[min(400px,calc(100vw-2rem))] flex-col overflow-hidden rounded-3xl sm:right-6"
          >
            <div className="flex items-center gap-3 border-b border-line/70 px-4 py-3">
              <span className="bg-gradient-soft grid h-9 w-9 place-items-center rounded-full border border-line/70">
                <LogoMark className="h-5 w-auto" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="font-display text-sm font-bold text-strong">MediSense Assistant</p>
                <p className="text-[11px] text-faint">{tr("Guidance, not diagnosis", "Rehnumai, tashkhees nahi")}</p>
              </div>
              <Link
                href="/patient/assistant"
                aria-label={tr("Open full page", "Poora page kholein")}
                title={tr("Open full page", "Poora page kholein")}
                className="grid h-9 w-9 place-items-center rounded-full text-muted transition-colors hover:bg-gradient-soft hover:text-primary"
              >
                <Icon name="open_in_full" className="text-[18px]" />
              </Link>
              <button
                type="button"
                aria-label={tr("Minimize assistant", "Assistant chhota karein")}
                onClick={toggle}
                className="grid h-9 w-9 place-items-center rounded-full text-muted transition-[background-color,color,transform] hover:rotate-90 hover:bg-gradient-soft hover:text-primary focus-visible:outline-2 focus-visible:outline-primary"
              >
                <Icon name="close" className="text-[20px]" />
              </button>
            </div>
            <div className="min-h-0 flex-1">
              <WidgetBody />
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <motion.button
        type="button"
        aria-expanded={open}
        aria-label={open ? tr("Close the assistant", "Assistant band karein") : tr("Ask the MediSense Assistant", "MediSense Assistant se poochein")}
        onClick={toggle}
        whileHover={reduced ? undefined : { scale: 1.06 }}
        whileTap={reduced ? undefined : { scale: 0.94 }}
        className={cx(
          "bg-gradient-brand fixed bottom-6 right-4 z-40 grid h-14 w-14 place-items-center rounded-full text-white shadow-float focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-primary sm:right-6",
          !seen && !open && "animate-halo",
        )}
      >
        <AnimatePresence mode="wait" initial={false}>
          <motion.span
            key={open ? "close" : "open"}
            initial={{ rotate: -90, opacity: 0 }}
            animate={{ rotate: 0, opacity: 1 }}
            exit={{ rotate: 90, opacity: 0 }}
            transition={{ duration: 0.18 }}
            className="grid place-items-center"
          >
            <Icon name={open ? "close" : "smart_toy"} filled className="text-[28px]" />
          </motion.span>
        </AnimatePresence>
      </motion.button>
    </>
  );
}
