"use client";

/**
 * The landing bar.
 *
 * Transparent while the hero is under it — the mesh and the circuit field are
 * the first thing a visitor should see, not a chrome band — and it frosts into
 * a real surface the moment the page moves, at which point it also loses 12px
 * of height. Both changes are one transition, so the bar reads as settling
 * rather than switching.
 *
 * The controls sit in the order someone reaches for them: language first,
 * because a Roman Urdu reader landing on English needs it before anything
 * else; then the theme; then sign in; then the one button this page is for.
 */

import Link from "next/link";
import { useEffect, useState } from "react";

import { Icon } from "@/components/Icon";
import { LanguageToggle } from "@/components/LanguageToggle";
import { ThemeToggle } from "@/components/ThemeToggle";
import { Logo } from "@/components/brand/Logo";
import { cx } from "@/components/ui";
import { useTr } from "@/lib/lang";

export function Nav({
  primaryHref,
  primaryLabel,
  showSignIn,
}: {
  primaryHref: string;
  primaryLabel: string;
  showSignIn: boolean;
}) {
  const tr = useTr();
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 40);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <header
      className={cx(
        "fixed inset-x-0 top-0 z-50 transition-[background-color,border-color,box-shadow,backdrop-filter] duration-300",
        scrolled
          ? "border-b border-line bg-[var(--surface-glass)] shadow-sm backdrop-blur-xl"
          : "border-b border-transparent",
      )}
    >
      <div
        className={cx(
          "mx-auto flex w-full max-w-[1180px] items-center gap-3 px-5 transition-[height] duration-300 ease-out",
          scrolled ? "h-[60px]" : "h-[72px]",
        )}
      >
        <Link
          href="/"
          aria-label="MediSense"
          className="rounded-lg focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-primary"
        >
          <Logo variant="full" size="md" />
        </Link>

        <nav aria-label="Primary" className="ml-auto flex items-center gap-2 sm:gap-3">
          <span className="hidden sm:block">
            <LanguageToggle />
          </span>
          <ThemeToggle />
          {showSignIn && (
            <Link
              href="/login"
              className="hidden min-h-10 items-center rounded-xl px-3.5 text-sm font-semibold text-muted transition-colors hover:bg-gradient-soft hover:text-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary md:inline-flex"
            >
              {tr("Sign in", "Login karein")}
            </Link>
          )}
          <Link
            href={primaryHref}
            className="btn-gradient btn-shine group inline-flex min-h-10 items-center gap-1.5 rounded-xl px-4 text-sm font-semibold text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
          >
            {primaryLabel}
            <Icon
              name="arrow_forward"
              className="text-[18px] transition-transform duration-200 group-hover:translate-x-0.5"
            />
          </Link>
        </nav>
      </div>
    </header>
  );
}
