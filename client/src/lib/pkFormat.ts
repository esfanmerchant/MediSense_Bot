/**
 * Pakistani identifiers, punctuated as they are typed.
 *
 * People know what a CNIC looks like — `42101-7536622-3` — and they type the
 * dashes themselves, or forget to, or put them in the wrong place. Asking them
 * to get it right is asking them to do the machine's job; a field that punctuates
 * itself is one nobody can format wrongly.
 *
 * **Both functions are pure and lossy in one direction only.** They take
 * whatever was typed, keep the digits, and lay them out. That means backspacing
 * over a dash deletes the dash and the digit before it in one press, which is
 * what people expect from a formatted field and is why the digits are always
 * re-derived rather than patched in place.
 */

/** Digits and nothing else. */
function digits(raw: string): string {
  return raw.replace(/\D/g, "");
}

/**
 * `42101-7536622-3` — five, seven, one.
 *
 * Never longer than thirteen digits: a CNIC has exactly that many, and letting
 * a fourteenth in produces something that looks like an identifier and is not.
 */
export function formatCnic(raw: string): string {
  const value = digits(raw).slice(0, 13);
  const parts = [value.slice(0, 5), value.slice(5, 12), value.slice(12, 13)];
  return parts.filter(Boolean).join("-");
}

/** True once it is a complete CNIC. Partial input is not *wrong*, only unfinished. */
export function isCompleteCnic(raw: string): boolean {
  return digits(raw).length === 13;
}

/**
 * `+92 306 2150375`, however it was entered.
 *
 * Pakistani mobile numbers are written three ways — `03062150375`,
 * `+923062150375`, `92 306 215 0375` — and all three mean the same number. This
 * normalises to the international form, because that is the one that is
 * unambiguous when somebody abroad reads it off a record.
 *
 * A number that is not recognisably Pakistani is grouped but otherwise left
 * alone: this is a formatter, not a gate, and refusing to display what somebody
 * typed because it is unfamiliar is how a form becomes unusable at the edges.
 */
export function formatPkPhone(raw: string): string {
  let value = digits(raw);

  // A leading zero is the domestic trunk prefix; +92 replaces it.
  if (value.startsWith("0")) value = `92${value.slice(1)}`;
  else if (!value.startsWith("92") && value.length <= 10) value = `92${value}`;

  if (!value.startsWith("92")) {
    // Not a Pakistani number. Group it in fours so it stays readable.
    return value.replace(/(\d{4})(?=\d)/g, "$1 ").trim();
  }

  const national = value.slice(2, 12); // 10 digits after the country code
  const parts = [national.slice(0, 3), national.slice(3)];
  return `+92 ${parts.filter(Boolean).join(" ")}`.trim();
}

/** True once a Pakistani mobile number is complete: `+92` plus ten digits. */
export function isCompletePkPhone(raw: string): boolean {
  const value = digits(raw);
  const national = value.startsWith("0")
    ? value.slice(1)
    : value.startsWith("92")
      ? value.slice(2)
      : value;
  return national.length === 10;
}
