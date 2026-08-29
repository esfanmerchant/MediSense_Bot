/**
 * AI assistant, in the browser (spec §19, Phase 14 "UI tests").
 *
 * The API already refuses to diagnose, to invent a medication, or to talk an
 * escalation down — and `test_assistant_safety.py` proves all of that. What no
 * server-side test can reach is whether the *screen* preserves it. A disclaimer
 * the server sends and the client drops has been lost just as completely as one
 * that was never sent.
 *
 * So these tests are about the last few inches: what renders, what is announced
 * to assistive technology, and what a patient can and cannot set in motion.
 */

import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { AssistantChat, SymptomReview } from "@/components/assistant";
import * as api from "@/lib/api";
import type { AssistantAnswer, SymptomProposal } from "@/lib/api";

const DISCLAIMER =
  "This information is for preliminary guidance only and does not replace " +
  "evaluation by a licensed healthcare professional.";

function answer(overrides: Partial<AssistantAnswer> = {}): AssistantAnswer {
  return {
    sessionId: "session-1",
    answer: "Rest and drink fluids. See a doctor if it gets worse.",
    urgency: "ROUTINE",
    emergency: false,
    suggestedDepartment: null,
    extractedSymptoms: [],
    disclaimer: DISCLAIMER,
    safetyInterventions: [],
    ...overrides,
  };
}

function proposal(overrides: Partial<SymptomProposal> = {}): SymptomProposal {
  return {
    ...answer(),
    saved: false,
    reviewPrompt: "Are these the symptoms you meant? Edit anything that is wrong.",
    extractedSymptoms: ["headache", "dizziness"],
    ...overrides,
  } as SymptomProposal;
}

describe("the disclaimer", () => {
  it("renders with every answer", async () => {
    vi.spyOn(api.assistant, "chat").mockResolvedValue(answer());
    const user = userEvent.setup();
    render(<AssistantChat />);

    await user.type(screen.getByLabelText("Your question"), "what is this tablet for");
    await user.click(screen.getByRole("button", { name: "Send" }));

    expect(await screen.findByText(DISCLAIMER)).toBeInTheDocument();
  });

  it("cannot be dismissed", async () => {
    // There is no control to hide it — the server sends it with every answer
    // precisely so no client can render guidance without it.
    vi.spyOn(api.assistant, "chat").mockResolvedValue(answer());
    const user = userEvent.setup();
    render(<AssistantChat />);

    await user.type(screen.getByLabelText("Your question"), "hello");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await screen.findByText(DISCLAIMER);

    const dismissers = screen
      .getAllByRole("button")
      .filter((button) => /dismiss|hide|close|got it/i.test(button.textContent ?? ""));
    expect(dismissers).toHaveLength(0);
  });
});

describe("an emergency answer", () => {
  it("is announced, not merely coloured", async () => {
    // A red border is invisible to a screen reader and ambiguous to a
    // colour-blind reader. role="alert" is what actually reaches them.
    vi.spyOn(api.assistant, "chat").mockResolvedValue(
      answer({ emergency: true, urgency: "EMERGENCY" }),
    );
    const user = userEvent.setup();
    render(<AssistantChat />);

    await user.type(screen.getByLabelText("Your question"), "crushing chest pain");
    await user.click(screen.getByRole("button", { name: "Send" }));

    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText(/emergency care/i)).toBeInTheDocument();
  });

  it("does not offer to book an appointment instead", async () => {
    // "Book an appointment" next to a possible heart attack is advice to wait.
    vi.spyOn(api.assistant, "chat").mockResolvedValue(
      answer({ emergency: true, urgency: "EMERGENCY" }),
    );
    const user = userEvent.setup();
    render(<AssistantChat />);

    await user.type(screen.getByLabelText("Your question"), "crushing chest pain");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await screen.findByRole("alert");

    expect(screen.queryByRole("link", { name: /book an appointment/i })).toBeNull();
  });

  it("offers booking for a routine answer", async () => {
    vi.spyOn(api.assistant, "chat").mockResolvedValue(answer({ urgency: "ROUTINE" }));
    const user = userEvent.setup();
    render(<AssistantChat />);

    await user.type(screen.getByLabelText("Your question"), "sore knee");
    await user.click(screen.getByRole("button", { name: "Send" }));

    expect(
      await screen.findByRole("link", { name: /book an appointment/i }),
    ).toBeInTheDocument();
  });
});

describe("describing symptoms", () => {
  it("saves nothing on its own", async () => {
    // Extraction is a proposal. The spec requires the patient to correct it
    // before anything is stored, so analysing must not write.
    const analyse = vi.spyOn(api.assistant, "analyseSymptoms").mockResolvedValue(proposal());
    const confirm = vi.spyOn(api.assistant, "confirmSymptoms");
    const user = userEvent.setup();
    render(<SymptomReview />);

    await user.type(
      screen.getByLabelText(/what are you experiencing/i),
      "headache since yesterday",
    );
    await user.click(screen.getByRole("button", { name: /review my symptoms/i }));

    await screen.findByDisplayValue("headache");
    expect(analyse).toHaveBeenCalledOnce();
    expect(confirm).not.toHaveBeenCalled();
  });

  it("puts the extraction into editable fields, not read-only text", async () => {
    // A screen showing finished-looking values invites clicking through. The
    // correction step only exists if the values can actually be corrected.
    vi.spyOn(api.assistant, "analyseSymptoms").mockResolvedValue(proposal());
    const user = userEvent.setup();
    render(<SymptomReview />);

    await user.type(
      screen.getByLabelText(/what are you experiencing/i),
      "headache since yesterday",
    );
    await user.click(screen.getByRole("button", { name: /review my symptoms/i }));

    const [field] = await screen.findAllByLabelText(/^symptom$/i);
    expect(field).toBeEnabled();
    expect(field).toHaveValue("headache");
    await user.clear(field);
    await user.type(field, "migraine");
    expect(field).toHaveValue("migraine");
  });

  it("sends the corrected list, not the extracted one", async () => {
    vi.spyOn(api.assistant, "analyseSymptoms").mockResolvedValue(proposal());
    const confirm = vi
      .spyOn(api.assistant, "confirmSymptoms")
      .mockResolvedValue({ saved: 2, source: "PATIENT_REPORTED", note: "Saved." });
    const user = userEvent.setup();
    render(<SymptomReview />);

    await user.type(
      screen.getByLabelText(/what are you experiencing/i),
      "headache since yesterday",
    );
    await user.click(screen.getByRole("button", { name: /review my symptoms/i }));

    const [field] = await screen.findAllByLabelText(/^symptom$/i);
    await user.clear(field);
    await user.type(field, "migraine");
    await user.click(screen.getByRole("button", { name: /this is correct/i }));

    const sent = confirm.mock.calls[0][0];
    expect(sent.symptoms.map((s) => s.symptom)).toContain("migraine");
    expect(sent.symptoms.map((s) => s.symptom)).not.toContain("headache");
  });

  it("still offers the list when extraction fails", async () => {
    // The error copy promises the patient can list symptoms themselves. If the
    // fields only appeared on success, that promise would be a lie.
    vi.spyOn(api.assistant, "analyseSymptoms").mockRejectedValue(
      new api.ApiError("SERVICE_UNAVAILABLE", "The assistant is unavailable.", 503),
    );
    const user = userEvent.setup();
    render(<SymptomReview />);

    await user.type(screen.getByLabelText(/what are you experiencing/i), "headache");
    await user.click(screen.getByRole("button", { name: /review my symptoms/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/unavailable/i);
    expect(screen.getByLabelText(/^symptom$/i)).toBeInTheDocument();
  });

  it("will not save an empty list", async () => {
    vi.spyOn(api.assistant, "analyseSymptoms").mockResolvedValue(
      proposal({ extractedSymptoms: [] }),
    );
    const user = userEvent.setup();
    render(<SymptomReview />);

    await user.type(screen.getByLabelText(/what are you experiencing/i), "not sure");
    await user.click(screen.getByRole("button", { name: /review my symptoms/i }));

    expect(await screen.findByRole("button", { name: /this is correct/i })).toBeDisabled();
  });
});

describe("provenance", () => {
  it("marks typed symptoms as text", async () => {
    vi.spyOn(api.assistant, "analyseSymptoms").mockResolvedValue(proposal());
    const confirm = vi
      .spyOn(api.assistant, "confirmSymptoms")
      .mockResolvedValue({ saved: 1, source: "PATIENT_REPORTED", note: "Saved." });
    const user = userEvent.setup();
    render(<SymptomReview />);

    await user.type(
      screen.getByLabelText(/what are you experiencing/i),
      "headache since yesterday",
    );
    await user.click(screen.getByRole("button", { name: /review my symptoms/i }));
    await screen.findAllByLabelText(/^symptom$/i);
    await user.click(screen.getByRole("button", { name: /this is correct/i }));

    // TEXT, so the server stores PATIENT_REPORTED rather than AI_ASSISTED —
    // the distinction spec §21 turns on.
    expect(confirm.mock.calls[0][0].inputType).toBe("TEXT");
  });
});
