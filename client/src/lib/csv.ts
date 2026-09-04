/**
 * Building a CSV a spreadsheet will open correctly, and safely.
 *
 * Three things go wrong with hand-rolled CSV, and all three are here.
 *
 * **Quoting.** A field holding a comma, a quote or a newline has to be wrapped
 * and its quotes doubled (RFC 4180). An invoice note is free text, so this is
 * not theoretical: one comma in "Paid at counter, receipt kept" silently shifts
 * every column after it.
 *
 * **Encoding.** Excel on Windows reads a UTF-8 file as the system codepage
 * unless it finds a byte-order mark, so a name in Urdu — or any name with an
 * accent — arrives as mojibake. The BOM is three bytes and fixes it.
 *
 * **Formula injection.** A cell beginning `=`, `+`, `-`, `@`, tab or carriage
 * return is executed as a formula by Excel, Sheets and LibreOffice when the
 * file is opened. `=HYPERLINK(...)` in a text field somebody typed into this
 * system becomes a live link in the recipient's spreadsheet. Prefixing an
 * apostrophe stops it being parsed as a formula and does not show in the cell.
 * This is the reason this file exists rather than a `join(",")` at the call
 * site.
 */

/** Cells that a spreadsheet would otherwise evaluate rather than display. */
const FORMULA_START = /^[=+\-@\t\r]/;

function cell(value: unknown): string {
  if (value === null || value === undefined) return "";
  let text = String(value);

  if (FORMULA_START.test(text)) {
    // Not stripped: the character may be part of what somebody meant to write
    // (a negative amount, an email starting with @). The apostrophe makes it
    // text without changing what it says.
    text = `'${text}`;
  }

  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/**
 * A CSV document from a header row and its rows.
 *
 * CRLF line endings, per RFC 4180 — a lone LF is read as one long cell by
 * older Excel builds.
 */
export function toCsv(headers: string[], rows: Array<Array<unknown>>): string {
  return [headers, ...rows].map((row) => row.map(cell).join(",")).join("\r\n");
}

/**
 * Hand the browser a CSV file to save.
 *
 * The BOM is prepended here rather than inside `toCsv`, so the string stays a
 * clean CSV for anything that wants to read it rather than save it.
 */
export function downloadCsv(fileName: string, content: string): void {
  const blob = new Blob(["﻿", content], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}
