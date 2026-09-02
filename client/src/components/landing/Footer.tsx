"use client";

/**
 * The foot of the page.
 *
 * The pulse returns one last time as the divider — the same motif that opened
 * under the headline, closing the document. Four columns of links that all go
 * somewhere real (no placeholder legal pages that 404), and the two settings a
 * visitor is most likely to want changed — language and theme — sit at the
 * bottom right where a footer is read last.
 */

import Link from "next/link";

import { LanguageToggle } from "@/components/LanguageToggle";
import { ThemeToggle } from "@/components/ThemeToggle";
import { EcgLine } from "@/components/brand/EcgLine";
import { Logo } from "@/components/brand/Logo";
import { useTr } from "@/lib/lang";

import { Rise, Shell } from "./parts";

export function Footer() {
  const tr = useTr();

  const columns: { heading: string; links: { label: string; href: string }[] }[] = [
    {
      heading: tr("Product", "Product"),
      links: [
        { label: tr("What it does", "Yeh kya karta hai"), href: "#kya-karta-hai" },
        { label: tr("How it works", "Kaise chalta hai"), href: "#kaise" },
        { label: tr("Three portals", "Teen portals"), href: "#portals" },
      ],
    },
    {
      heading: tr("Portals", "Portals"),
      links: [
        { label: tr("Patients", "Mareez"), href: "/login" },
        { label: tr("Doctors", "Doctors"), href: "/login" },
        { label: tr("Administrators", "Intezamia"), href: "/login" },
      ],
    },
    {
      heading: tr("Account", "Account"),
      links: [
        { label: tr("Sign in", "Login karein"), href: "/login" },
        { label: tr("Create your account", "Apna account banayein"), href: "/register" },
        { label: tr("Forgot password", "Password bhool gaye"), href: "/forgot-password" },
      ],
    },
    {
      heading: tr("Build", "Build"),
      links: [
        { label: tr("Design system", "Design system"), href: "/styleguide" },
        { label: tr("Security", "Hifazat"), href: "#hifazat" },
      ],
    },
  ];

  return (
    <footer className="band-dark">
      <div aria-hidden className="text-line-strong">
        <EcgLine color="currentColor" width={2} height={26} speed={3} />
      </div>

      <Shell className="py-14">
        <Rise y={18} scale={1} className="grid gap-10 lg:grid-cols-[1.3fr_2.4fr]">
          <div>
            <Logo variant="full" size="md" />
            <p className="mt-4 max-w-[34ch] text-sm leading-relaxed text-muted">
              {tr(
                "Smart Healthcare Management System",
                "Smart Healthcare Management System",
              )}
            </p>
          </div>

          <div className="grid grid-cols-2 gap-8 sm:grid-cols-4">
            {columns.map((column) => (
              <div key={column.heading}>
                <p className="mono-caps text-[0.6rem] text-faint">{column.heading}</p>
                <ul className="mt-4 space-y-2.5">
                  {column.links.map((link) => (
                    <li key={link.label}>
                      <Link
                        href={link.href}
                        className="text-sm text-muted transition-colors hover:text-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                      >
                        {link.label}
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </Rise>

        <div className="mt-12 flex flex-wrap items-center gap-4 border-t border-line pt-6">
          <p className="text-xs text-faint">
            {tr(
              "Preliminary guidance only — never a substitute for a licensed clinician.",
              "Sirf ibtidai rehnumai — kisi licensed doctor ka mutabadil hargiz nahi.",
            )}
          </p>
          <div className="ml-auto flex items-center gap-3">
            <LanguageToggle />
            <ThemeToggle />
          </div>
        </div>
      </Shell>
    </footer>
  );
}
