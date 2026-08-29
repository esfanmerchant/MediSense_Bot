"use client";

/**
 * The circuit traces from the logo, as a decorative field.
 *
 * Nodes joined by thin right-angled lines, kept faint and non-interactive.
 * Decoration only: `pointer-events: none`, `aria-hidden`, opacity capped, and
 * the slow pulse drops out under `prefers-reduced-motion` via the global rule.
 *
 * The layout is deterministic rather than random so a reload does not reshuffle
 * the background, and so server and client render the same thing.
 */

import { useId } from "react";

import { cx } from "@/components/ui";

interface Node {
  x: number;
  y: number;
  r: number;
}

/** A fixed lattice, jittered by a cheap hash so it never looks like graph paper. */
function lattice(step: number): { nodes: Node[]; paths: string[] } {
  const nodes: Node[] = [];
  const paths: string[] = [];
  let seed = 7;
  const next = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };

  for (let y = step; y < 200; y += step) {
    for (let x = step; x < 200; x += step) {
      const jx = x + (next() - 0.5) * step * 0.5;
      const jy = y + (next() - 0.5) * step * 0.5;
      nodes.push({ x: jx, y: jy, r: next() > 0.7 ? 2.2 : 1.4 });
      // A trace leaves most nodes: right then down, the way a board is routed.
      if (next() > 0.35) {
        const run = step * (0.6 + next() * 0.7);
        paths.push(`M${jx} ${jy} H${jx + run} L${jx + run + 6} ${jy + 6} V${jy + run * 0.6}`);
      }
    }
  }
  return { nodes, paths };
}

export function CircuitNodes({
  density = "low",
  className,
  /** Teal by default; pass `white` over a coloured panel. */
  tone = "teal",
}: {
  density?: "low" | "med";
  className?: string;
  tone?: "teal" | "white";
}) {
  const id = `cn-${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  const { nodes, paths } = lattice(density === "low" ? 46 : 32);
  const colour = tone === "white" ? "#FFFFFF" : "#14C4C1";

  return (
    <svg
      aria-hidden
      viewBox="0 0 200 200"
      preserveAspectRatio="xMidYMid slice"
      className={cx("pointer-events-none absolute inset-0 h-full w-full", className)}
      style={{ opacity: density === "low" ? 0.22 : 0.32 }}
      fill="none"
    >
      <defs>
        <filter id={`${id}-glow`} x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="1.6" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>
      <g stroke={colour} strokeWidth="0.6" strokeLinecap="round" strokeLinejoin="round" opacity="0.75">
        {paths.map((d, index) => (
          <path key={index} d={d} />
        ))}
      </g>
      <g fill={colour} filter={`url(#${id}-glow)`}>
        {nodes.map((node, index) => (
          <circle
            key={index}
            cx={node.x}
            cy={node.y}
            r={node.r}
            className="circuit-node"
            style={{ animationDelay: `${(index % 7) * 0.45}s` }}
          />
        ))}
      </g>
    </svg>
  );
}
