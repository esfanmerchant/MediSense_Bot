"use client";

/**
 * How the application looks, how much it moves, and how it stays current.
 *
 * Five controls, all of them local to this browser and none of them a network
 * request: theme, text size, motion, live updates, language. That is not a
 * limitation to apologise for — a person on a ward terminal changes the text
 * size for the shift they are working, not for their account.
 *
 * The theme cards are miniatures rather than swatches. A row of coloured
 * squares does not answer the question somebody actually has, which is "what
 * will the screen I am looking at become".
 */

import { useTheme } from "next-themes";
import { useState } from "react";

import { Icon } from "@/components/Icon";
import { LanguageToggle } from "@/components/LanguageToggle";
import { Segmented, Switch } from "@/components/forms";
import { Card, cx } from "@/components/ui";
import {
  setFontScale,
  setLiveUpdates,
  setMotionPreference,
  useFontScale,
  useLiveUpdates,
  useMotionPreference,
  type FontScale,
} from "@/components/settings/preferences";
import { useTr } from "@/lib/lang";
import { useHydrated } from "@/lib/useHydrated";

/**
 * The two palettes, written out.
 *
 * The one place in this application where a colour is a literal rather than a
 * token, and it has to be: a preview of the light theme shown *while the dark
 * theme is active* cannot read the current theme's variables — they are the
 * wrong theme by definition. These are the `:root` and `.dark` values from
 * `globals.css`; if those change, these follow.
 */
const PREVIEW = {
  light: { canvas: "#F6F9FC", card: "#FFFFFF", line: "#DCE6F2", text: "#0E1B33", faint: "#C2D1E6" },
  dark: { canvas: "#071129", card: "#0D1B3A", line: "#1B2C52", text: "#EAF1FB", faint: "#2B4272" },
} as const;

const BRAND = "linear-gradient(135deg, #0B3FA8 0%, #1A8FC7 55%, #14C4C1 100%)";

/** A screen in miniature: rail, header, a card and two lines of text. */
function ThemeMiniature({ tone }: { tone: "light" | "dark" }) {
  const palette = PREVIEW[tone];
  return (
    <span
      aria-hidden
      className="block h-[74px] w-full overflow-hidden rounded-lg border"
      style={{ background: palette.canvas, borderColor: palette.line }}
    >
      <span className="flex h-full">
        <span
          className="flex h-full w-[22%] flex-col gap-1.5 border-r p-1.5"
          style={{ background: palette.card, borderColor: palette.line }}
        >
          <span className="block h-2 w-full rounded-sm" style={{ background: BRAND }} />
          <span className="block h-1.5 w-3/4 rounded-sm" style={{ background: palette.faint }} />
          <span className="block h-1.5 w-2/3 rounded-sm" style={{ background: palette.faint }} />
        </span>
        <span className="flex h-full flex-1 flex-col gap-1.5 p-1.5">
          <span className="block h-2 w-1/2 rounded-sm" style={{ background: palette.text }} />
          <span
            className="block flex-1 rounded-md border"
            style={{ background: palette.card, borderColor: palette.line }}
          >
            <span
              className="mx-1.5 mt-1.5 block h-1.5 w-2/3 rounded-sm"
              style={{ background: palette.faint }}
            />
            <span className="mx-1.5 mt-1 block h-1.5 w-1/3 rounded-sm" style={{ background: BRAND }} />
          </span>
        </span>
      </span>
    </span>
  );
}

const THEMES = ["light", "dark", "system"] as const;
type ThemeChoice = (typeof THEMES)[number];

export function AppearanceTab() {
  const tr = useTr();
  const { theme, setTheme, resolvedTheme } = useTheme();
  const fontScale = useFontScale();
  const motion = useMotionPreference();
  const live = useLiveUpdates();
  // The chosen theme is not knowable on the server, so the cards render
  // unselected until hydration rather than guessing and correcting themselves
  // in front of the reader.
  const mounted = useHydrated();
  const [announcement, setAnnouncement] = useState("");

  const current: ThemeChoice | null = mounted ? ((theme as ThemeChoice) ?? "system") : null;

  const themeLabel: Record<ThemeChoice, [string, string]> = {
    light: ["Light", "Roshan"],
    dark: ["Dark", "Tareek"],
    system: ["System", "System"],
  };

  const fontLabel: Record<FontScale, [string, string]> = {
    base: ["Default", "Aam"],
    large: ["Large", "Bara"],
    larger: ["Larger", "Sab se bara"],
  };

  return (
    <div className="space-y-6">
      {/* Every change here is silent and instant, so it is announced. */}
      <p role="status" aria-live="polite" className="sr-only">
        {announcement}
      </p>

      <Card
        title={tr("Theme", "Theme")}
        description={tr(
          "System follows whatever this device is set to, and changes with it.",
          "System aap ke device ki setting ke mutabiq chalta hai aur us ke saath badalta hai.",
        )}
        icon="palette"
      >
        <div role="radiogroup" aria-label={tr("Theme", "Theme")} className="stagger grid gap-3 sm:grid-cols-3">
          {THEMES.map((option) => {
            const selected = current === option;
            return (
              <button
                key={option}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => {
                  setTheme(option);
                  setAnnouncement(`${tr("Theme", "Theme")}: ${tr(...themeLabel[option])}`);
                }}
                className={cx(
                  "hover-lift-sm rounded-2xl p-2.5 text-left transition-[border-color,box-shadow]",
                  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary",
                  selected
                    ? "border-gradient-fill shadow-glow"
                    : "border border-line bg-card shadow-sm hover:border-line-strong",
                )}
              >
                {option === "system" ? (
                  // Both, side by side: the point of "system" is that it is
                  // whichever of the two the device says.
                  <span aria-hidden className="grid grid-cols-2 gap-1.5">
                    <ThemeMiniature tone="light" />
                    <ThemeMiniature tone="dark" />
                  </span>
                ) : (
                  <ThemeMiniature tone={option} />
                )}

                <span className="mt-2.5 flex items-center gap-1.5 px-1 pb-0.5">
                  <span
                    aria-hidden
                    className={cx(
                      "grid h-5 w-5 shrink-0 place-items-center rounded-full border-2 transition-colors",
                      selected ? "border-transparent bg-gradient-brand text-white" : "border-line-strong",
                    )}
                  >
                    {selected && <Icon name="check" className="text-[14px]" />}
                  </span>
                  <span className="text-sm font-semibold text-strong">
                    {tr(...themeLabel[option])}
                  </span>
                  {option === "system" && mounted && (
                    <span className="ml-auto text-[11px] text-faint">
                      {resolvedTheme === "dark"
                        ? tr("now dark", "abhi tareek")
                        : tr("now light", "abhi roshan")}
                    </span>
                  )}
                </span>
              </button>
            );
          })}
        </div>
      </Card>

      <Card
        title={tr("Text size", "Likhai ka size")}
        description={tr(
          "Scales the whole interface, not just this page. Remembered on this device.",
          "Poora interface bara hota hai, sirf yeh safha nahi. Is device par yaad rakha jata hai.",
        )}
        icon="format_size"
      >
        <Segmented
          label={tr("Text size", "Likhai ka size")}
          value={fontScale}
          onChange={(next) => {
            setFontScale(next);
            setAnnouncement(`${tr("Text size", "Likhai ka size")}: ${tr(...fontLabel[next])}`);
          }}
          options={(Object.keys(fontLabel) as FontScale[]).map((value) => ({
            value,
            label: tr(...fontLabel[value]),
          }))}
          className="w-full sm:w-auto"
        />
        <p className="mt-4 rounded-xl border border-line bg-sunken/60 p-4 text-[15px] leading-relaxed text-muted">
          {tr(
            "Blood pressure 128/82 mmHg, recorded 12 minutes ago. This is what body text will look like.",
            "Blood pressure 128/82 mmHg, 12 minute pehle record hua. Aam likhai aisi dikhegi.",
          )}
        </p>
      </Card>

      <Card
        title={tr("Motion", "Harkat")}
        description={tr(
          "Your device may already ask for this; turning it on here also covers a shared terminal you cannot change the settings of.",
          "Aap ka device shayad pehle hi yeh maang raha ho; yahan on karne se woh terminal bhi shamil ho jata hai jis ki settings aap nahi badal sakte.",
        )}
        icon="animation"
      >
        <Switch
          checked={motion === "reduced"}
          onChange={(next) => {
            setMotionPreference(next ? "reduced" : "full");
            setAnnouncement(
              next
                ? tr("Reduced motion on", "Kam harkat on")
                : tr("Reduced motion off", "Kam harkat off"),
            );
          }}
          label={tr("Reduce motion", "Harkat kam karein")}
          description={tr(
            "Entrances, sliding indicators and the loading pulse stop moving. Nothing is hidden — only the movement goes.",
            "Entrance, sarakne wale indicators aur loading ki dhadkan ruk jati hain. Kuch chhupta nahi — sirf harkat jati hai.",
          )}
        />
      </Card>

      <Card
        title={tr("Staying up to date", "Khud-ba-khud taza")}
        description={tr(
          "On by default. Turn it off on a metered connection, or while you are comparing figures and want the screen to hold still.",
          "Default par on hai. Mehdood data par, ya jab aap aankray mila rahe hon aur screen ko theher jana chahiye, isse off kar dein.",
        )}
        icon="sync"
      >
        <Switch
          checked={live}
          onChange={(next) => {
            setLiveUpdates(next);
            setAnnouncement(
              next
                ? tr("Live updates on", "Live updates on")
                : tr("Live updates off", "Live updates off"),
            );
          }}
          label={tr("Keep pages up to date", "Safhe khud taza karein")}
          description={tr(
            "Lists and queues re-check the server about once a minute, and again whenever you come back to this window. It happens quietly — the page never blinks back to a skeleton while you are reading it, and a failed check leaves what is on screen alone. Nothing you have typed is touched.",
            "Lists aur queues taqreeban har minute server se dobara poochhti hain, aur jab bhi aap is window par wapas aayein. Yeh khamoshi se hota hai — parhte waqt safha skeleton par wapas nahi jhapakta, aur nakaam koshish screen par mojood cheez ko haath nahi lagati. Aap ka likha hua kuch nahi badalta.",
          )}
        />
      </Card>

      <Card
        title={tr("Language", "Zubaan")}
        description={tr(
          "The interface only. Anything a clinician or the assistant wrote stays in the words it was written in.",
          "Sirf interface ki. Jo kuch doctor ya assistant ne likha, woh apne hi alfaz mein rehta hai.",
        )}
        icon="translate"
      >
        <LanguageToggle />
      </Card>
    </div>
  );
}
