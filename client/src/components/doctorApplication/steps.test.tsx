/**
 * What a half-filled application sends to the server.
 *
 * The onboarding form saves a draft on a debounce, from the first keystroke,
 * long before any of it is complete. So the payload it builds has to be one the
 * server accepts while it is still mostly empty — and it was not: every blank
 * field went as `""`, which fails `min_length=2` on the name, the registration
 * number and the specialization. Every autosave from step two came back 422 and
 * the screen said "The draft is not saved" on every keystroke.
 *
 * These tests pin the distinction the server actually draws: two characters or
 * more, or nothing at all. An empty string is neither.
 */

import { describe, expect, it } from "vitest";

import { toDraft, type FormState } from "@/components/doctorApplication/steps";

function form(overrides: Partial<FormState> = {}): FormState {
  return {
    fullName: "",
    phone: "",
    nationalId: "",
    address: "",
    registrationNumber: "",
    specialization: "",
    departmentId: "",
    qualifications: [],
    yearsExperience: "",
    previousHospital: "",
    consultationFee: "",
    availability: [],
    ...overrides,
  } as FormState;
}

describe("the draft a half-filled form sends", () => {
  it("sends nothing rather than an empty string for a blank field", () => {
    // `""` is the one value the server rejects for these: the rule is two
    // characters or more, or absent.
    const draft = toDraft(form());
    for (const field of [
      "fullName",
      "phone",
      "nationalId",
      "address",
      "registrationNumber",
      "specialization",
      "departmentId",
      "previousHospital",
    ] as const) {
      expect(draft[field], field).toBeNull();
    }
  });

  it("trims what was typed", () => {
    const draft = toDraft(form({ fullName: "  Priya Sharma  ", specialization: " Cardiology " }));
    expect(draft.fullName).toBe("Priya Sharma");
    expect(draft.specialization).toBe("Cardiology");
  });

  it("treats a field of only spaces as blank", () => {
    expect(toDraft(form({ registrationNumber: "   " })).registrationNumber).toBeNull();
  });

  it("sends numbers as numbers, and blanks as null", () => {
    const typed = toDraft(form({ yearsExperience: "12", consultationFee: "5000" }));
    expect(typed.yearsExperience).toBe(12);
    expect(typed.consultationFee).toBe(5000);

    const blank = toDraft(form());
    expect(blank.yearsExperience).toBeNull();
    expect(blank.consultationFee).toBeNull();
  });

  it("drops a qualification row the doctor left empty", () => {
    const draft = toDraft(
      form({
        qualifications: [
          { id: "q1", value: "MBBS, King Edward Medical University" },
          { id: "q2", value: "   " },
        ],
      }),
    );
    expect(draft.qualifications).toEqual(["MBBS, King Edward Medical University"]);
  });
});
