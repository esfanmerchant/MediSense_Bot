"use client";

/**
 * The floating label, restyled for the screens where nobody is signed in yet.
 *
 * The pattern in `globals.css` is right: a real `<label>` that sits inside the
 * control and rises to a caption once the field is focused or filled. The
 * *treatment* is what fails here. Risen, that label becomes 11px mono
 * uppercase with 0.1em of tracking, and at that size, on a card, mono-caps
 * stops reading as a label and starts reading as a decorative tag — which is
 * exactly the complaint. There is nowhere on these six screens where a person
 * can afford to be unsure which box wants their email.
 *
 * So: sans instead of mono, sentence case instead of caps, 13px instead of
 * 11.2px, 600 weight, and `--text-muted` in place of `--text-faint` — 5.6:1 on
 * a white card, 8.2:1 on a dark one, where the faint token managed 2.7:1. The
 * brand blue takes over on focus, still well past 4.5:1 in both themes, and
 * critical still wins over both when the field is wrong.
 *
 * **Why a `<style>` element and not `globals.css`.** The change belongs to the
 * auth screens alone; the rest of the product keeps the mono-caps caption,
 * which is right beside a record number and wrong beside a password. Scoping it
 * under `.auth-shell` and shipping it from the component that owns that class
 * keeps the two decisions in one place, and every selector below is a class
 * deeper than the rule it overrides, so the cascade never depends on which
 * stylesheet the browser saw first.
 *
 * React hoists this into `<head>` and dedupes it by `href`, so mounting six
 * auth screens in a row still yields one rule set.
 */

const CSS = `
.auth-shell .field-shell > :is(input, select, textarea),
.auth-shell .field-shell > * > :is(input, select, textarea) {
  padding-top: 1.7rem;
  padding-bottom: 0.55rem;
  min-height: 3.5rem;
}
.auth-shell .field-label {
  color: var(--text-muted);
  font-weight: 500;
}
.auth-shell .field-shell:has(:focus) .field-label,
.auth-shell .field-shell:has(:not(:placeholder-shown)) .field-label,
.auth-shell .field-shell:has(select) .field-label,
.auth-shell .field-shell:has(input[type="date"]) .field-label,
.auth-shell .field-shell:has(input[type="time"]) .field-label,
.auth-shell .field-shell:has(input[type="datetime-local"]) .field-label,
.auth-shell .field-shell:has(input[type="file"]) .field-label {
  top: 0.5rem;
  font-family: inherit;
  font-size: 0.8125rem;
  font-weight: 600;
  letter-spacing: 0.005em;
  text-transform: none;
  color: var(--text-muted);
}
.auth-shell .field-shell:has(:focus) .field-label {
  color: var(--brand-primary);
}
.auth-shell .field-invalid .field-shell .field-label,
.auth-shell .field-invalid .field-shell:has(:focus) .field-label {
  color: var(--status-critical);
}
`;

export function AuthFieldStyles() {
  return (
    <style href="medisense-auth-fields" precedence="medium">
      {CSS}
    </style>
  );
}
