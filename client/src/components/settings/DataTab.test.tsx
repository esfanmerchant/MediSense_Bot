/**
 * Taking your record away.
 *
 * The behaviour worth holding still is not the wording — it is that the press
 * produces a file. A regression that fetched the bundle and forgot to save it
 * would look completely successful: the request goes out, the toast appears,
 * and nothing lands on the person's device. So these tests assert the download
 * itself, not the request that precedes it.
 *
 * The other half is who gets the section at all. A doctor's account holds no
 * chart of its own, and an administrator copying somebody else's record is
 * access rather than export — so the tab exists for patients and nobody else.
 */

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { tabsFor } from "@/components/settings/AccountSettings";
import { DataTab } from "@/components/settings/DataTab";
import { ToastProvider } from "@/components/overlays";
import { ApiError, patients } from "@/lib/api";
import type { PatientExport } from "@/lib/api";

const BUNDLE = {
  format: "medisense.patient-export",
  formatVersion: 1,
  exportedAt: "2026-09-03T09:30:00Z",
  source: { system: "MediSense", timezone: "Asia/Karachi" },
  patient: { medicalRecordNumber: "MRN-000123", name: "Ayesha Khan" },
  appointments: [],
  medicalRecords: [{ id: "r1", diagnosis: "Type 2 diabetes mellitus" }],
  prescriptions: [],
  medicationReminders: [],
  vitals: [],
  reportedSymptoms: [],
  documents: [],
  invoices: [],
  documentsNote: "…",
  counts: { medicalRecords: 1 },
  truncated: [],
} as unknown as PatientExport;

let anchor: HTMLAnchorElement;
let clicked: number;

beforeEach(() => {
  clicked = 0;
  Object.assign(URL, {
    createObjectURL: vi.fn(() => "blob:record"),
    revokeObjectURL: vi.fn(),
  });
  // jsdom has no navigation, so a real `.click()` on an anchor warns and does
  // nothing useful. Standing in for it is also what lets the test read back the
  // filename and the href the component actually set.
  const create = document.createElement.bind(document);
  vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
    const element = create(tag);
    if (tag === "a") {
      anchor = element as HTMLAnchorElement;
      anchor.click = () => {
        clicked += 1;
      };
    }
    return element;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function mount() {
  return render(
    <ToastProvider>
      <DataTab />
    </ToastProvider>,
  );
}

function downloadButton() {
  return screen.getByRole("button", { name: /download my record/i });
}

describe("before anything is pressed", () => {
  it("asks the server for nothing", () => {
    const call = vi.spyOn(patients, "exportRecord");
    mount();
    // The export is the heaviest read in the portal. Opening settings to change
    // a password must not cost a full clinical history.
    expect(call).not.toHaveBeenCalled();
  });

  it("says what the file will contain", () => {
    mount();
    expect(screen.getByText(/consultation notes/i)).toBeInTheDocument();
    expect(screen.getByText(/vital-sign readings/i)).toBeInTheDocument();
  });

  it("offers the printable summary as a link, not a button", () => {
    mount();
    // A link so middle-click and "open in new tab" both work — it goes
    // somewhere rather than doing something.
    const link = screen.getByRole("link", { name: /printable summary/i });
    expect(link).toHaveAttribute("href", "/patient/export");
  });
});

describe("pressing download", () => {
  it("saves a file, not just a request", async () => {
    vi.spyOn(patients, "exportRecord").mockResolvedValue(BUNDLE);
    mount();
    await userEvent.click(downloadButton());

    await waitFor(() => expect(clicked).toBe(1));
    expect(anchor.download).toMatch(/^medisense-record-MRN-000123-\d{4}-\d{2}-\d{2}\.json$/);
    expect(anchor.href).toContain("blob:record");
  });

  it("puts the whole bundle in the file", async () => {
    vi.spyOn(patients, "exportRecord").mockResolvedValue(BUNDLE);
    mount();
    await userEvent.click(downloadButton());

    await waitFor(() => expect(URL.createObjectURL).toHaveBeenCalled());
    const blob = vi.mocked(URL.createObjectURL).mock.calls[0][0] as Blob;
    expect(blob.type).toBe("application/json");
    const written = JSON.parse(await blob.text());
    // The diagnosis arrives as prose. It is encrypted in the database, and a
    // patient's own copy of their own record that came out as ciphertext would
    // be a file nobody can use.
    expect(written.medicalRecords[0].diagnosis).toBe("Type 2 diabetes mellitus");
    expect(written.format).toBe("medisense.patient-export");
  });

  it("releases the object URL", async () => {
    vi.spyOn(patients, "exportRecord").mockResolvedValue(BUNDLE);
    mount();
    await userEvent.click(downloadButton());
    await waitFor(() => expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:record"));
  });

  it("shows a failure where the person is looking, and stays usable", async () => {
    vi.spyOn(patients, "exportRecord").mockRejectedValue(
      new ApiError("RATE_LIMITED", "Too many exports. Try again in an hour.", 429),
    );
    mount();
    await userEvent.click(downloadButton());

    // In the card, not only in a toast: they came here to do this and will try
    // again from this exact spot.
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/too many exports/i);
    expect(downloadButton()).toBeEnabled();
  });
});

describe("who has this section", () => {
  it("is offered to a patient", () => {
    expect(tabsFor("PATIENT")).toContain("data");
  });

  it("is not offered to a doctor, a nurse or an administrator", () => {
    // An administrator copying somebody else's record is access, not export:
    // it goes through the chart, where it is recorded as reading a chart.
    for (const role of ["DOCTOR", "ADMIN", "NURSE"] as const) {
      expect(tabsFor(role)).not.toContain("data");
    }
  });

  it("leaves the other sections alone for everyone", () => {
    for (const role of ["PATIENT", "DOCTOR", "ADMIN"] as const) {
      expect(tabsFor(role)).toEqual(
        expect.arrayContaining(["profile", "security", "notifications", "appearance"]),
      );
    }
  });
});
