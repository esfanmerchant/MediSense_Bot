/**
 * Vitals and alerts, in the browser (spec §16-17, Phase 14 "UI tests").
 *
 * A monitoring surface fails differently from a document. The failures worth
 * testing here are the ones a clinician would not notice until it mattered:
 *
 * - a breaching value marked **only** by colour, invisible to a screen reader
 *   and ambiguous to a colour-blind reader;
 * - a critical alert that renders quietly instead of announcing itself;
 * - a dead live feed that looks identical to a quiet one, so "no alerts" and
 *   "not receiving alerts" become the same picture.
 */

import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { AlertsPanel, RecordVitals, VitalsTable } from "@/components/vitals";
import * as api from "@/lib/api";
import type { Alert, Vital, VitalThreshold } from "@/lib/api";

function vital(overrides: Partial<Vital> = {}): Vital {
  return {
    id: "v1",
    patientId: "p1",
    recordedById: "u1",
    source: "DEVICE",
    deviceId: null,
    heartRate: 72,
    systolicBp: 118,
    diastolicBp: 76,
    oxygenSaturation: 98,
    temperature: 36.8,
    respiratoryRate: 16,
    recordedAt: "2026-09-01T09:00:00Z",
    ...overrides,
  };
}

function threshold(overrides: Partial<VitalThreshold> = {}): VitalThreshold {
  return {
    id: "t1",
    vitalType: "HEART_RATE",
    patientId: null,
    scope: "HOSPITAL",
    minValue: 50,
    maxValue: 120,
    severity: "WARNING",
    enabled: true,
    sustainedReadings: 1,
    unit: "bpm",
    label: "Heart rate",
    ...overrides,
  };
}

function alert(overrides: Partial<Alert> = {}): Alert {
  return {
    id: "a1",
    patientId: "p1",
    vitalId: "v1",
    doctorId: "d1",
    vitalType: "HEART_RATE",
    measuredValue: 150,
    thresholdMin: 50,
    thresholdMax: 120,
    severity: "CRITICAL",
    status: "OPEN",
    message: "Heart rate 150 bpm is above the configured limit of 120 bpm.",
    acknowledgedById: null,
    acknowledgedAt: null,
    resolvedAt: null,
    escalationLevel: 0,
    createdAt: "2026-09-01T09:05:00Z",
    ...overrides,
  };
}

function mockVitals(rows: Vital[], thresholds: VitalThreshold[] = [threshold()]) {
  vi.spyOn(api.vitals, "list").mockResolvedValue({
    data: rows,
    meta: { total: rows.length, limit: 50, offset: 0, hasMore: false },
  });
  vi.spyOn(api.vitals, "thresholds").mockResolvedValue({ thresholds, unconfigured: [] });
}

function mockAlerts(rows: Alert[]) {
  vi.spyOn(api.alerts, "list").mockResolvedValue({
    data: rows,
    meta: { total: rows.length, limit: 50, offset: 0, hasMore: false },
  });
}

describe("a breaching reading", () => {
  it("is marked in words, not only in colour", async () => {
    // A red cell says nothing to a screen reader and little to a colour-blind
    // clinician. The sr-only text is what actually carries the meaning.
    mockVitals([vital({ heartRate: 150 })]);
    render(<VitalsTable patientId="p1" />);

    const cell = (await screen.findByText("150")).closest("span")!;
    expect(within(cell.parentElement!).getByText("(outside range)")).toBeInTheDocument();
  });

  it("leaves an in-range value unmarked", async () => {
    mockVitals([vital({ heartRate: 72 })]);
    render(<VitalsTable patientId="p1" />);

    await screen.findByText("72");
    expect(screen.queryByText("(outside range)")).toBeNull();
  });

  it("uses the patient's own rule when there is one", async () => {
    // Conflict C9: a COPD patient's ordinary saturation is not an emergency,
    // and a table that flags it anyway trains the ward to ignore the marks.
    mockVitals(
      [vital({ oxygenSaturation: 88 })],
      [
        threshold({
          vitalType: "OXYGEN_SATURATION",
          scope: "PATIENT",
          patientId: "p1",
          minValue: 85,
          maxValue: null,
          unit: "%",
          label: "Oxygen saturation",
        }),
      ],
    );
    render(<VitalsTable patientId="p1" />);

    await screen.findByText("88");
    expect(screen.queryByText("(outside range)")).toBeNull();
  });

  it("says so when a vital has no threshold at all", async () => {
    // Unconfigured is a gap where no alert will ever fire — silence would make
    // it look like everything is covered.
    vi.spyOn(api.vitals, "list").mockResolvedValue({
      data: [vital()],
      meta: { total: 1, limit: 50, offset: 0, hasMore: false },
    });
    vi.spyOn(api.vitals, "thresholds").mockResolvedValue({
      thresholds: [threshold()],
      unconfigured: ["TEMPERATURE"],
    });
    render(<VitalsTable patientId="p1" />);

    expect(await screen.findByText(/never raise an alert/i)).toBeInTheDocument();
  });
});

describe("an alert", () => {
  it("announces a critical one", async () => {
    mockAlerts([alert({ severity: "CRITICAL", status: "OPEN" })]);
    render(<AlertsPanel />);

    const alerts = await screen.findAllByRole("alert");
    expect(alerts.length).toBeGreaterThan(0);
  });

  it("does not announce a resolved one", async () => {
    // An alert somebody already dealt with must not keep interrupting.
    mockAlerts([alert({ severity: "CRITICAL", status: "RESOLVED", resolvedAt: "2026-09-01T10:00:00Z" })]);
    const user = userEvent.setup();
    render(<AlertsPanel />);

    await user.click(await screen.findByRole("button", { name: /show resolved/i }));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("separates acknowledging from resolving", async () => {
    // "Someone is looking at it" and "the patient is fine" are different
    // claims, and a ward needs to tell them apart.
    mockAlerts([alert({ status: "OPEN" })]);
    render(<AlertsPanel />);

    expect(await screen.findByRole("button", { name: /looking at this/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^resolve$/i })).toBeInTheDocument();
  });

  it("offers only resolve once acknowledged", async () => {
    mockAlerts([alert({ status: "ACKNOWLEDGED", acknowledgedAt: "2026-09-01T09:10:00Z" })]);
    render(<AlertsPanel />);

    await screen.findByRole("button", { name: /^resolve$/i });
    expect(screen.queryByRole("button", { name: /looking at this/i })).toBeNull();
  });

  it("hides resolved alerts by default", async () => {
    mockAlerts([
      alert({ id: "a1", status: "OPEN" }),
      alert({ id: "a2", status: "RESOLVED", message: "An older, handled problem." }),
    ]);
    render(<AlertsPanel />);

    await screen.findByText(/above the configured limit/i);
    expect(screen.queryByText("An older, handled problem.")).toBeNull();
  });
});

describe("the live feed", () => {
  it("shows its own connection state", async () => {
    // A dead feed must read as "not updating", never as "nothing is wrong".
    mockAlerts([]);
    render(<AlertsPanel />);

    const status = await screen.findByRole("status");
    expect(status).toHaveTextContent(/connecting|live|disconnected/i);
  });
});

describe("recording observations", () => {
  it("will not submit an empty reading", async () => {
    // A set of obs is whatever was actually measured; an empty one is not a
    // reading, and the server refuses it.
    render(<RecordVitals patientId="p1" />);

    expect(screen.getByRole("button", { name: /save reading/i })).toBeDisabled();
    expect(screen.getByText(/at least one measurement/i)).toBeInTheDocument();
  });

  it("enables saving once anything is entered", async () => {
    const user = userEvent.setup();
    render(<RecordVitals patientId="p1" />);

    await user.type(screen.getByLabelText(/heart rate/i), "72");
    expect(screen.getByRole("button", { name: /save reading/i })).toBeEnabled();
  });

  it("announces the alerts a reading raised", async () => {
    // The person who took the observation is standing next to the patient. If
    // it crossed a threshold, they need to know now rather than on a dashboard.
    vi.spyOn(api.vitals, "record").mockResolvedValue({
      ...vital({ heartRate: 150 }),
      alerts: [alert()],
    });
    const user = userEvent.setup();
    render(<RecordVitals patientId="p1" />);

    await user.type(screen.getByLabelText(/heart rate/i), "150");
    await user.click(screen.getByRole("button", { name: /save reading/i }));

    const raised = await screen.findByRole("alert");
    expect(within(raised).getByText(/alert was raised/i)).toBeInTheDocument();
    expect(within(raised).getByText(/doctor has been notified/i)).toBeInTheDocument();
  });

  it("says nothing about alerts when there were none", async () => {
    vi.spyOn(api.vitals, "record").mockResolvedValue({ ...vital(), alerts: [] });
    const user = userEvent.setup();
    render(<RecordVitals patientId="p1" />);

    await user.type(screen.getByLabelText(/heart rate/i), "72");
    await user.click(screen.getByRole("button", { name: /save reading/i }));

    expect(screen.queryByText(/alert was raised/i)).toBeNull();
  });
});
