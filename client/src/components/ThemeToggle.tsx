"use client";

/**
 * Light ⇄ dark, as a pill with a sliding puck.
 *
 * The theme is only known after mount — the server cannot know what a person
 * chose last visit — so the control renders in a neutral state until then
 * rather than guessing and correcting itself in front of the reader.
 *
 * Both icons stay visible: the one that is lit says where you are, and the
 * other says where the tap will take you. That is what makes it readable
 * without a label.
 */

import { motion, useReducedMotion } from "framer-motion";
import { useTheme } from "next-themes";
import { Icon } from "@/components/Icon";
import { cx } from "@/components/ui";
import { useTr } from "@/lib/lang";
import { useHydrated } from "@/lib/useHydrated";

export function ThemeToggle({ onDark = false }: { onDark?: boolean }) {
  const tr = useTr();
  const reduced = useReducedMotion();
  const { resolvedTheme, setTheme } = useTheme();
  // The stored choice only exists in the browser, so the control renders in a
  // neutral state until hydration rather than guessing and correcting itself.
  const mounted = useHydrated();

  const dark = mounted && resolvedTheme === "dark";
  const label = dark ? tr("Light mode", "Roshan mode") : tr("Dark mode", "Tareek mode");

  return (
    <button
      type="button"
      role="switch"
      aria-checked={dark}
      aria-label={label}
      title={label}
      onClick={() => setTheme(dark ? "light" : "dark")}
      className={cx(
        "relative inline-flex h-9 w-[68px] items-center rounded-full border p-1 transition-colors",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary",
        onDark ? "border-white/25 bg-white/10" : "border-line-strong bg-sunken",
      )}
    >
      {/* The puck. `layout` moves it with a spring when the theme flips. */}
      <motion.span
        layout
        aria-hidden
        transition={reduced ? { duration: 0 } : { type: "spring", stiffness: 500, damping: 32 }}
        className={cx(
          "bg-gradient-brand absolute h-7 w-7 rounded-full shadow-sm",
          dark ? "right-1" : "left-1",
        )}
      />
      <span className="relative z-10 flex w-full items-center justify-between px-1.5">
        <Icon
          name="light_mode"
          filled={mounted && !dark}
          className={cx(
            "text-[17px] transition-colors",
            mounted && !dark ? "text-white" : onDark ? "text-white/60" : "text-faint",
          )}
        />
        <Icon
          name="dark_mode"
          filled={dark}
          className={cx(
            "text-[17px] transition-colors",
            dark ? "text-white" : onDark ? "text-white/60" : "text-faint",
          )}
        />
      </span>
    </button>
  );
}
