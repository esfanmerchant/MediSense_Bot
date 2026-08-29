"use client";

/**
 * The brand ramp, clipped to text.
 *
 * `background-clip: text` needs a painted background, so the element must be
 * inline-block for the gradient to have a box to fill. Everything else is
 * inherited, which keeps it usable inside any heading.
 */

import type { ReactNode } from "react";

import { cx } from "@/components/ui";

export function GradientText({
  children,
  className,
  as: Tag = "span",
}: {
  children: ReactNode;
  className?: string;
  as?: "span" | "strong" | "em";
}) {
  return (
    <Tag className={cx("text-gradient-brand inline-block", className)}>{children}</Tag>
  );
}
