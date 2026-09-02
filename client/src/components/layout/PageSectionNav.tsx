"use client";

/**
 * What is on this page.
 *
 * Most screens here are a stack of cards. On a desktop that is fine — the eye
 * catches the top of the next one. On a phone at 390×720 it is not: the doctor's
 * patient chart has eight sections and shows one, and nothing on screen says the
 * other seven exist. People do not scroll hopefully; they conclude the page is
 * what they can see.
 *
 * So every multi-section page opens with a row naming all of its sections. Two
 * modes, because two different things are being asked for:
 *
 * - **jump** — the sections stay on the page in order and the row scrolls to
 *   them. For pages that are read through: dashboards, settings-like stacks.
 * - **tabs** — one section is rendered at a time and the row switches. For
 *   pages whose sections are long and independent, where scrolling past four
 *   screens of prescriptions to reach vitals is work, not context.
 *
 * Never an accordion. Collapsed content is the problem, not the fix.
 *
 * **This is not `Segmented`.** That control is for two to four exclusive
 * choices at equal widths — a filter. Eight equal-width sections on a 390px
 * screen would be eight illegible slivers, so this scrolls horizontally
 * instead and is styled flat: a row of labels with the current one underlined,
 * which is what a section index looks like everywhere it is done well.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

import { Icon } from "@/components/Icon";
import { cx } from "@/components/ui";

export interface Section {
  /** Element id in jump mode; the `?tab=` value in tabs mode. */
  id: string;
  label: string;
  /** Material Symbols name — the icon set this application already ships. */
  icon?: string;
  /** Shown after the label, e.g. "Reports · 4". */
  count?: number;
  badge?: "critical" | "warning";
}

interface Props {
  sections: Section[];
  mode: "jump" | "tabs";
  /** Controlled in tabs mode. */
  activeId?: string;
  onChange?: (id: string) => void;
  label: string;
}

/**
 * Keeps the current button in view on a narrow screen — and moves nothing else.
 *
 * This was `button.scrollIntoView(...)`, which is the obvious way to write it
 * and which broke scrolling on every page that has this bar. `scrollIntoView`
 * does not scroll *an* ancestor, it scrolls **every** scrollable ancestor,
 * including the document: so reading down a page fired the observer, the
 * observer asked for the new button to be brought into view, and the browser
 * obligingly scrolled the page back up to do it. The reader scrolls down, the
 * page jumps up, and it happens again at every section boundary.
 *
 * Setting `scrollLeft` on the row touches one element and cannot reach the
 * document. The row is only ever scrollable sideways, so nothing is lost.
 */
function keepInView(bar: HTMLElement | null, id: string) {
  if (!bar) return;
  const button = bar.querySelector<HTMLElement>(`[data-section="${CSS.escape(id)}"]`);
  if (!button) return;

  const left = button.offsetLeft;
  const right = left + button.offsetWidth;
  const from = bar.scrollLeft;
  const to = from + bar.clientWidth;
  // A margin, so the active button does not sit flush against the edge fade.
  const margin = 24;

  if (left < from + margin) bar.scrollTo({ left: left - margin, behavior: "smooth" });
  else if (right > to - margin) {
    bar.scrollTo({ left: right - bar.clientWidth + margin, behavior: "smooth" });
  }
}

export function PageSectionNav({ sections, mode, activeId, onChange, label }: Props) {
  const bar = useRef<HTMLDivElement | null>(null);
  const wrapper = useRef<HTMLDivElement | null>(null);
  const [seen, setSeen] = useState<string | null>(sections[0]?.id ?? null);

  const current = mode === "tabs" ? (activeId ?? sections[0]?.id) : seen;

  /**
   * Publish this bar's height too, so `scroll-margin-top` can account for it.
   *
   * A section jumped to from a hash has to clear the header *and* this row. Both
   * are measured rather than assumed; a wrong number here puts the heading you
   * asked for underneath the thing you clicked.
   */
  useEffect(() => {
    const node = wrapper.current;
    if (!node) return;
    const publish = () => {
      document.documentElement.style.setProperty(
        "--section-nav-h",
        `${Math.round(node.getBoundingClientRect().height)}px`,
      );
    };
    publish();
    const observer = new ResizeObserver(publish);
    observer.observe(node);
    return () => {
      observer.disconnect();
      document.documentElement.style.removeProperty("--section-nav-h");
    };
  }, []);

  /**
   * In jump mode the bar follows the page rather than the page following the
   * bar: whichever section is in view is the one highlighted, however the reader
   * got there.
   *
   * The URL is updated with `replaceState`. Pushing would fill the back button
   * with every heading somebody scrolled past, so "back" would stop meaning
   * "the page I came from" — which is the only thing anybody presses it for.
   */
  useEffect(() => {
    if (mode !== "jump") return;
    const nodes = sections
      .map((section) => document.getElementById(section.id))
      .filter((node): node is HTMLElement => node !== null);
    if (nodes.length === 0) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        if (!visible) return;
        const id = visible.target.id;
        setSeen(id);
        keepInView(bar.current, id);
        // The hash is rewritten from an idle callback rather than from inside
        // the observer. `replaceState` is not free, and doing it synchronously
        // while the compositor is mid-scroll is a frame dropped at exactly the
        // moment somebody is looking at the page moving.
        if (window.location.hash !== `#${id}`) {
          const write = () => {
            if (window.location.hash !== `#${id}`) {
              window.history.replaceState(null, "", `#${id}`);
            }
          };
          const idle = window.requestIdleCallback;
          if (idle) idle(write);
          else window.setTimeout(write, 200);
        }
      },
      { threshold: 0.4, rootMargin: "-25% 0px -55% 0px" },
    );

    for (const node of nodes) observer.observe(node);
    return () => observer.disconnect();
  }, [mode, sections]);

  useEffect(() => {
    if (mode === "tabs" && current) keepInView(bar.current, current);
  }, [mode, current]);

  const go = useCallback(
    (id: string) => {
      if (mode === "tabs") {
        onChange?.(id);
        return;
      }
      // `scroll-margin-top` on the target does the arithmetic; see globals.css.
      document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
      setSeen(id);
    },
    [mode, onChange],
  );

  /** Arrow keys move between tabs, which is what a tablist is expected to do. */
  const onKeyDown = (event: React.KeyboardEvent) => {
    const delta = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (delta === 0) return;
    event.preventDefault();
    const index = sections.findIndex((section) => section.id === current);
    const next = sections[(index + delta + sections.length) % sections.length];
    if (next) {
      go(next.id);
      bar.current
        ?.querySelector<HTMLElement>(`[data-section="${CSS.escape(next.id)}"]`)
        ?.focus();
    }
  };

  if (sections.length < 2) return null;

  return (
    <div
      ref={wrapper}
      /* Opaque, and no backdrop blur. The shell's header above this one already
         carries a 20px backdrop-filter, and a second one stacked directly under
         it means the browser blurs two full-width regions on every scroll frame
         — which is most of the "scrolling feels heavy" this page had. The
         background here is the page's own colour, so the blur was buying a
         difference nobody could see. */
      className="sticky z-30 -mx-4 mb-6 border-b border-line bg-canvas sm:-mx-6"
      style={{ top: "var(--topbar-h, 64px)" }}
    >
      {/* The fades are the only thing telling a phone reader the row continues
          past the edge. A scrollbar would say it too, but not on iOS. */}
      <div className="relative">
        <span
          aria-hidden
          className="from-canvas pointer-events-none absolute inset-y-0 left-0 z-10 w-4 bg-gradient-to-r to-transparent"
        />
        <span
          aria-hidden
          className="from-canvas pointer-events-none absolute inset-y-0 right-0 z-10 w-4 bg-gradient-to-l to-transparent"
        />
        <div
          ref={bar}
          role={mode === "tabs" ? "tablist" : undefined}
          aria-label={label}
          onKeyDown={mode === "tabs" ? onKeyDown : undefined}
          className="no-scrollbar flex snap-x snap-mandatory gap-1 overflow-x-auto px-4 py-2 sm:px-6"
        >
          {sections.map((section) => {
            const active = section.id === current;
            return (
              <button
                key={section.id}
                type="button"
                data-section={section.id}
                role={mode === "tabs" ? "tab" : undefined}
                aria-selected={mode === "tabs" ? active : undefined}
                aria-controls={mode === "tabs" ? `panel-${section.id}` : undefined}
                aria-current={mode === "jump" && active ? "location" : undefined}
                tabIndex={mode === "tabs" && !active ? -1 : 0}
                onClick={() => go(section.id)}
                className={cx(
                  "relative flex min-h-9 shrink-0 snap-start items-center gap-1.5 rounded-lg px-3 text-sm font-semibold",
                  "transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary",
                  active
                    ? "text-primary"
                    : "text-muted hover:bg-sunken hover:text-strong",
                )}
              >
                {section.icon && (
                  <Icon name={section.icon} filled={active} className="text-[18px]" />
                )}
                <span className="whitespace-nowrap">{section.label}</span>
                {section.count !== undefined && (
                  <span className="tabular-nums text-faint">· {section.count}</span>
                )}
                {section.badge && (
                  <span
                    aria-hidden
                    className={cx(
                      "h-1.5 w-1.5 shrink-0 rounded-full",
                      section.badge === "critical" ? "bg-critical" : "bg-warning",
                    )}
                  />
                )}
                {active && (
                  <span
                    aria-hidden
                    className="bg-gradient-brand absolute inset-x-2 -bottom-2 h-0.5 rounded-full"
                  />
                )}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/**
 * A section that the bar above can reach.
 *
 * Exists so no page has to remember the `scroll-mt` class — a section that
 * forgets it lands under the sticky header, which looks like the jump missing
 * rather than like a missing utility class.
 */
export function Section({
  id,
  children,
  className,
}: {
  id: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section id={id} className={cx("scroll-section", className)}>
      {children}
    </section>
  );
}

/**
 * Keeps a tabbed page's choice in the URL.
 *
 * So a link to a tab opens on that tab, and the back button leaves the page
 * rather than walking backwards through the tabs somebody clicked. Mirrors what
 * `AccountSettings` already does with the hash, in the query string, because a
 * page using hash jumps for sections cannot also use the hash for tabs.
 */
export function useTabParam(sections: readonly string[], fallback: string) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  const raw = params.get("tab");
  const active = raw && sections.includes(raw) ? raw : fallback;

  const choose = useCallback(
    (next: string) => {
      const query = new URLSearchParams(params.toString());
      if (next === fallback) query.delete("tab");
      else query.set("tab", next);
      const suffix = query.toString();
      router.replace(suffix ? `${pathname}?${suffix}` : pathname, { scroll: false });
    },
    [router, pathname, params, fallback],
  );

  return [active, choose] as const;
}
