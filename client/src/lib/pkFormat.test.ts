/**
 * A field that punctuates itself has to survive how people actually type.
 *
 * The cases that matter are not the clean ones. They are: pasting a number that
 * already has dashes, typing the country code three different ways, and
 * backspacing — which in a self-formatting field means deleting a separator,
 * and must not leave the caret fighting a dash that reappears.
 */

import { describe, expect, it } from "vitest";

import { formatCnic, formatPkPhone, isCompleteCnic, isCompletePkPhone } from "@/lib/pkFormat";

describe("a CNIC punctuates itself", () => {
  it("groups thirteen digits five, seven, one", () => {
    expect(formatCnic("4210175366223")).toBe("42101-7536622-3");
  });

  it("puts the dashes in as they are typed", () => {
    expect(formatCnic("4")).toBe("4");
    expect(formatCnic("42101")).toBe("42101");
    expect(formatCnic("421017")).toBe("42101-7");
    expect(formatCnic("421017536622")).toBe("42101-7536622");
    expect(formatCnic("4210175366223")).toBe("42101-7536622-3");
  });

  it("accepts a pasted number that already has them", () => {
    expect(formatCnic("42101-7536622-3")).toBe("42101-7536622-3");
  });

  it("accepts one with the dashes in the wrong places", () => {
    // Somebody's own note-keeping, pasted in. Keeping the digits and
    // re-laying them out is more use than refusing it.
    expect(formatCnic("421-0175-366223")).toBe("42101-7536622-3");
  });

  it("refuses a fourteenth digit", () => {
    // Not truncating produces something that looks like an identifier and is
    // not one.
    expect(formatCnic("42101753662233333")).toBe("42101-7536622-3");
  });

  it("backspacing over a dash removes the digit before it", () => {
    // What the field re-renders after the browser deletes one character.
    expect(formatCnic("42101-7536622-")).toBe("42101-7536622");
    expect(formatCnic("42101-753662")).toBe("42101-753662");
  });

  it("knows when it is finished", () => {
    expect(isCompleteCnic("42101-7536622-3")).toBe(true);
    expect(isCompleteCnic("42101-7536622")).toBe(false);
    expect(isCompleteCnic("")).toBe(false);
  });
});

describe("a phone number normalises to the international form", () => {
  it("takes the domestic form", () => {
    expect(formatPkPhone("03062150375")).toBe("+92 306 2150375");
  });

  it("takes the international form", () => {
    expect(formatPkPhone("+923062150375")).toBe("+92 306 2150375");
  });

  it("takes it with spaces already in", () => {
    expect(formatPkPhone("92 306 215 0375")).toBe("+92 306 2150375");
  });

  it("takes it with no prefix at all", () => {
    expect(formatPkPhone("3062150375")).toBe("+92 306 2150375");
  });

  it("builds up as it is typed", () => {
    expect(formatPkPhone("0")).toBe("+92");
    expect(formatPkPhone("0306")).toBe("+92 306");
    expect(formatPkPhone("030621")).toBe("+92 306 21");
  });

  it("leaves a number that is not Pakistani alone rather than mangling it", () => {
    // A formatter, not a gate. Refusing to display what somebody typed because
    // it is unfamiliar is how a form becomes unusable at the edges.
    expect(formatPkPhone("+44 20 7946 0958")).toBe("4420 7946 0958");
  });

  it("knows when it is finished", () => {
    expect(isCompletePkPhone("03062150375")).toBe(true);
    expect(isCompletePkPhone("+923062150375")).toBe(true);
    expect(isCompletePkPhone("0306215")).toBe(false);
  });
});
