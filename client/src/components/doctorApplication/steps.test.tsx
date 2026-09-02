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

import {
  formFrom,
  missingDocumentKinds,
  missingFields,
  qualificationYearIssue,
  toDraft,
  type FormState,
} from "@/components/doctorApplication/steps";
import type { ApplicationDocument, ApplicationDocumentKind } from "@/lib/api";

function form(overrides: Partial<FormState> = {}): FormState {
  return {
    fullName: "",
    phone: "",
    nationalId: "",
    address: "",
    registrationNumber: "",
    specialization: "",
    qualifications: [],
    yearsExperience: "",
    previousHospital: "",
    clinicName: "",
    city: "",
    addressLine: "",
    consultationFee: "",
    availability: [],
    ...overrides,
  };
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
    // A row with no title is a row somebody opened and walked away from. The
    // years it may carry are not a qualification on their own.
    const draft = toDraft(
      form({
        qualifications: [
          { id: "q1", title: "MBBS, King Edward Medical University", startYear: "", endYear: "" },
          { id: "q2", title: "   ", startYear: "2015", endYear: "2020" },
        ],
      }),
    );
    expect(draft.qualifications).toEqual([
      { title: "MBBS, King Edward Medical University", startYear: null, endYear: null },
    ]);
  });
});

/**
 * The years a qualification ran.
 *
 * Same rule as every other field on this form, and for the same reason: the
 * degree gets typed before the dates are remembered, and an autosave in that
 * moment must still be a payload the server will store. So a year that is not
 * there travels as `null` — never `0`, never `""`, never the key left out.
 */
describe("the years on a qualification", () => {
  it("sends both years when both were typed", () => {
    const draft = toDraft(
      form({
        qualifications: [
          {
            id: "q1",
            title: "MBBS, King Edward Medical University",
            startYear: "2015",
            endYear: "2020",
          },
        ],
      }),
    );
    expect(draft.qualifications).toEqual([
      { title: "MBBS, King Edward Medical University", startYear: 2015, endYear: 2020 },
    ]);
  });

  it("sends null for the year that is still blank", () => {
    const draft = toDraft(
      form({
        qualifications: [
          { id: "q1", title: "FCPS", startYear: "", endYear: "2024" },
          { id: "q2", title: "MRCP", startYear: "2021", endYear: "" },
        ],
      }),
    );
    expect(draft.qualifications).toEqual([
      { title: "FCPS", startYear: null, endYear: 2024 },
      { title: "MRCP", startYear: 2021, endYear: null },
    ]);
  });

  it("sends a title alone when neither year was typed", () => {
    const draft = toDraft(
      form({ qualifications: [{ id: "q1", title: "House job", startYear: "", endYear: "" }] }),
    );
    expect(draft.qualifications).toEqual([
      { title: "House job", startYear: null, endYear: null },
    ]);
  });

  it("leaves a half-typed year behind rather than have the save refused", () => {
    // "201" on the way to 2015 is not a year the server will store, and the
    // debounce fires on the pause between two keystrokes. It is dropped from
    // the payload, not from the box: the digits are still on screen.
    const draft = toDraft(
      form({ qualifications: [{ id: "q1", title: "MBBS", startYear: "201", endYear: "" }] }),
      new Date(2026, 0, 1),
    );
    expect(draft.qualifications).toEqual([{ title: "MBBS", startYear: null, endYear: null }]);
  });

  it("sends neither year while the pair runs backwards", () => {
    // Both are plausible on their own; it is the pair the server refuses, and
    // there is no principled half of it to keep.
    const draft = toDraft(
      form({ qualifications: [{ id: "q1", title: "MBBS", startYear: "2020", endYear: "2015" }] }),
      new Date(2026, 0, 1),
    );
    expect(draft.qualifications).toEqual([{ title: "MBBS", startYear: null, endYear: null }]);
  });

  it("says nothing about a row whose years are fine, or absent", () => {
    const now = new Date(2026, 0, 1);
    expect(qualificationYearIssue({ startYear: "", endYear: "" }, now)).toBeNull();
    expect(qualificationYearIssue({ startYear: "2015", endYear: "2020" }, now)).toBeNull();
    expect(qualificationYearIssue({ startYear: "", endYear: "2020" }, now)).toBeNull();
    // The same year twice is a one-year course, not a mistake.
    expect(qualificationYearIssue({ startYear: "2020", endYear: "2020" }, now)).toBeNull();
  });

  it("objects to a year outside living memory, and names the box", () => {
    const now = new Date(2026, 0, 1);
    expect(qualificationYearIssue({ startYear: "1492", endYear: "" }, now)?.field).toBe(
      "startYear",
    );
    // Seven years ahead is allowed — somebody enrolled now has a passing year
    // to come — and 2034 is one year past that.
    expect(qualificationYearIssue({ startYear: "", endYear: "2033" }, now)).toBeNull();
    expect(qualificationYearIssue({ startYear: "", endYear: "2034" }, now)?.field).toBe("endYear");
  });

  it("objects when the degree finishes before it starts", () => {
    const issue = qualificationYearIssue({ startYear: "2020", endYear: "2015" }, new Date(2026, 0, 1));
    expect(issue?.field).toBe("both");
    expect(issue?.message[0]).toBe("The start year cannot be after the passing year.");
  });
});

/**
 * Reading back what was stored.
 *
 * Qualifications used to be bare strings. The migration rewrites them, but a
 * page that was open across the deploy reads the old shape from a payload it
 * fetched before it — and a form that throws on load loses everything typed
 * into it. So both shapes have to be readable, and only one is ever written.
 */
describe("the form a stored application opens into", () => {
  it("reads the new object shape, years and all", () => {
    const state = formFrom({
      qualifications: [{ title: "MBBS", startYear: 2015, endYear: 2020 }],
    });
    expect(state.qualifications).toHaveLength(1);
    expect(state.qualifications[0]).toMatchObject({
      title: "MBBS",
      startYear: "2015",
      endYear: "2020",
    });
  });

  it("reads a bare string from before the years existed", () => {
    const state = formFrom({ qualifications: ["MBBS, King Edward Medical University"] });
    expect(state.qualifications[0]).toMatchObject({
      title: "MBBS, King Edward Medical University",
      startYear: "",
      endYear: "",
    });
  });

  it("reads a mix of the two without losing either", () => {
    const state = formFrom({
      qualifications: ["MBBS", { title: "FCPS", startYear: null, endYear: 2024 }],
    });
    expect(state.qualifications.map((row) => [row.title, row.startYear, row.endYear])).toEqual([
      ["MBBS", "", ""],
      ["FCPS", "", "2024"],
    ]);
  });

  it("gives every row an id of its own, so removing one animates the right one", () => {
    const state = formFrom({ qualifications: ["MBBS", "MBBS"] });
    expect(state.qualifications[0].id).not.toBe(state.qualifications[1].id);
  });
});

/**
 * Which of the four documents are still missing.
 *
 * All four are required at submit, and the server refuses without them. This
 * one answer feeds the Documents step's forward gate, the line naming what is
 * still needed, and the review's list of unfinished business — so if it is
 * wrong, a doctor is either blocked with no explanation or sent to a refusal.
 */
describe("the documents that are still missing", () => {
  function uploaded(kind: ApplicationDocumentKind, id: string = kind): ApplicationDocument {
    return {
      id,
      kind,
      fileName: `${kind.toLowerCase()}.pdf`,
      mimeType: "application/pdf",
      fileSize: 2048,
      uploadedAt: "2026-01-01T09:00:00.000Z",
      verified: false,
    };
  }

  it("names all four when nothing has been uploaded", () => {
    expect(missingDocumentKinds([])).toEqual([
      "REGISTRATION_CERTIFICATE",
      "DEGREE",
      "NATIONAL_ID",
      "PHOTO",
    ]);
  });

  it("names them in the order of the boxes on screen", () => {
    // The sentence a person reads has to match what they are looking at.
    expect(missingDocumentKinds([uploaded("DEGREE")])).toEqual([
      "REGISTRATION_CERTIFICATE",
      "NATIONAL_ID",
      "PHOTO",
    ]);
  });

  it("counts one file as enough for its kind, and two as no more than enough", () => {
    const documents = [
      uploaded("NATIONAL_ID", "front"),
      uploaded("NATIONAL_ID", "back"),
      uploaded("REGISTRATION_CERTIFICATE"),
      uploaded("DEGREE"),
    ];
    expect(missingDocumentKinds(documents)).toEqual(["PHOTO"]);
  });

  it("is empty once every kind has a file — which is what opens the gate", () => {
    const documents = [
      uploaded("REGISTRATION_CERTIFICATE"),
      uploaded("DEGREE"),
      uploaded("NATIONAL_ID"),
      uploaded("PHOTO"),
    ];
    expect(missingDocumentKinds(documents)).toEqual([]);
  });
});

describe("what the review step says is still outstanding", () => {
  /**
   * The list has to be the server's list. When it was shorter, the review step
   * reported an application ready that the submit endpoint then refused for
   * three fields nothing on screen had mentioned.
   */
  const serverRequires: Array<[keyof FormState, string]> = [
    ["fullName", "Full name"],
    ["phone", "Phone number"],
    ["nationalId", "National ID (CNIC)"],
    ["address", "Address"],
    ["registrationNumber", "Registration number"],
    ["specialization", "Specialization"],
    ["yearsExperience", "Years of experience"],
    ["consultationFee", "Consultation fee"],
    // Where they practise. The directory is a list a patient chooses from on
    // reachability as much as on qualification, so the server insists on these
    // three and this screen has to name them before submit does.
    ["clinicName", "Clinic or hospital"],
    ["city", "City"],
    ["addressLine", "Clinic address"],
  ];

  it("names every field the server requires when the form is empty", () => {
    const labels = missingFields(form()).map((item) => item.label[0]);
    expect(labels).toEqual(serverRequires.map(([, label]) => label));
  });

  it("drops a field once it is filled in", () => {
    const filled = form({ address: "12 Clifton Road, Karachi" });
    expect(missingFields(filled).map((item) => item.label[0])).not.toContain("Address");
  });

  it("says nothing is outstanding once every required field is filled", () => {
    const complete = form(
      Object.fromEntries(serverRequires.map(([key]) => [key, "x"])) as Partial<FormState>,
    );
    expect(missingFields(complete)).toEqual([]);
  });

  it("points each field at the step that holds it", () => {
    const steps = new Map(missingFields(form()).map((item) => [item.label[0], item.step]));
    expect(steps.get("Full name")).toBe(0);
    expect(steps.get("Address")).toBe(0);
    expect(steps.get("Specialization")).toBe(1);
    expect(steps.get("Consultation fee")).toBe(1);
  });
});
