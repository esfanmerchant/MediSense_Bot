"use client";

/**
 * Mounted fresh on every navigation, which is exactly what makes it the page
 * transition: the entrance animation replays because the node is new.
 *
 * Kept to 350ms and a 10px rise — enough that moving between screens feels
 * placed rather than swapped, not enough to make a clinician wait for it. The
 * global reduced-motion override collapses it to nothing.
 */
import type { ReactNode } from "react";

export default function Template({ children }: { children: ReactNode }) {
  return <div className="page-enter">{children}</div>;
}
