/**
 * A Material Symbol.
 *
 * Always decorative: `aria-hidden` is not optional here. Every icon in this
 * application sits beside a real text label, and an icon font announced to a
 * screen reader reads out the ligature name — "monitor_heart" — which is worse
 * than silence.
 *
 * `filled` is the design system's active state. It is a shape change rather
 * than a colour change, so it survives a colour-blind reader and a bad monitor.
 */
export function Icon({
  name,
  filled = false,
  className,
}: {
  name: string;
  filled?: boolean;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={["msym", filled && "msym-fill", className].filter(Boolean).join(" ")}
    >
      {name}
    </span>
  );
}
