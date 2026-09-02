"use client";

/**
 * The Roman Urdu ⇄ English switch.
 *
 * A segmented pill rather than a dropdown: two languages is a toggle, and both
 * options staying visible is what tells a visitor the other language exists at
 * all. Each segment is labelled in its own language — "اردو would be wrong here;
 * the site is Roman Urdu, so the label is too.
 */

import { setLang, useLang } from "@/lib/lang";
import { cx } from "@/components/ui";

const OPTIONS = [
  { value: "ur", label: "Urdu" },
  { value: "en", label: "English" },
] as const;

export function LanguageToggle({ onDark = false }: { onDark?: boolean }) {
  const lang = useLang();

  return (
    <div
      role="group"
      aria-label="Language / Zubaan"
      className={cx(
        "flex items-center rounded-full border p-0.5 text-xs font-semibold",
        onDark ? "border-white/25 bg-white/10" : "border-line-strong bg-card",
      )}
    >
      {OPTIONS.map((option) => {
        const active = lang === option.value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={active}
            onClick={() => setLang(option.value)}
            className={cx(
              "min-h-11 rounded-full px-3 transition-colors",
              "focus-visible:outline-2 focus-visible:outline-offset-2",
              onDark ? "focus-visible:outline-white" : "focus-visible:outline-primary",
              active
                ? onDark
                  ? "bg-accent-bright text-[#053B38]"
                  : // `text-primary-on`, not `text-white`. The primary colour is a
                    // deep blue on a light ground and a pale one on a dark
                    // ground, so white on it is 12:1 in one theme and 2.6:1 in
                    // the other — the token exists precisely to follow it.
                    "bg-primary text-primary-on"
                : onDark
                  ? "text-white/70 hover:text-white"
                  : "text-muted hover:text-strong",
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
