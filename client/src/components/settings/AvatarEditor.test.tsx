/**
 * The profile picture control (spec §34, Phase 14 "UI tests").
 *
 * Two things are worth holding still here, and neither is about pixels.
 *
 * **The edit affordance is not hover-only.** It is revealed by hover, but it is
 * a real button in the tab order with a name, and it opens with Enter like any
 * other. A regression that swapped `opacity-0` for `hidden` would look identical
 * to a mouse and would delete the control for everybody else, so the tests query
 * it the way assistive technology does — by role and name — rather than by class.
 *
 * **The server is the authority.** The client check exists to save an upload,
 * not to decide one, so there are tests for both halves: a file the client can
 * refuse never reaches the API, and a refusal the client did not predict is
 * still shown in the server's own words.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AvatarEditor, localRejection } from "@/components/settings/AvatarEditor";
import { ToastProvider } from "@/components/overlays";
import { ApiError, account } from "@/lib/api";

const PICTURE = "https://storage.example/avatars/u1/a1.png?token=abc";

/** A File of a stated size without allocating the bytes for it. */
function fileOf(name: string, type: string, size = 1024): File {
  const file = new File(["x"], name, { type });
  Object.defineProperty(file, "size", { value: size });
  return file;
}

function mount(props: Partial<Parameters<typeof AvatarEditor>[0]> = {}) {
  const onChanged = vi.fn();
  const view = render(
    <ToastProvider>
      <AvatarEditor name="Priya Sharma" avatarUrl={null} onChanged={onChanged} {...props} />
    </ToastProvider>,
  );
  return { ...view, onChanged };
}

function editButton() {
  return screen.getByRole("button", { name: "Edit profile picture" });
}

function fileInput(container: HTMLElement): HTMLInputElement {
  const input = container.querySelector('input[type="file"]');
  if (!input) throw new Error("no file input");
  return input as HTMLInputElement;
}

beforeEach(() => {
  // jsdom implements neither, and the preview would throw without them.
  Object.assign(URL, {
    createObjectURL: vi.fn(() => "blob:preview"),
    revokeObjectURL: vi.fn(),
  });
});

describe("the edit affordance", () => {
  it("is a named button, not a hover-only decoration", () => {
    mount();
    const button = editButton();
    expect(button).toBeInTheDocument();
    // `hidden` or `display:none` would take it out of the tab order entirely;
    // the design reveals it with opacity precisely so that it survives here.
    expect(button).toBeVisible();
    expect(button).not.toBeDisabled();
  });

  it("opens with the keyboard and offers the picture actions", async () => {
    const user = userEvent.setup();
    mount({ avatarUrl: PICTURE });

    await user.tab();
    expect(editButton()).toHaveFocus();
    await user.keyboard("{Enter}");

    expect(screen.getByRole("button", { name: /change picture/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /remove picture/i })).toBeInTheDocument();
  });

  it("moves focus into the panel it just opened", async () => {
    const user = userEvent.setup();
    mount({ avatarUrl: PICTURE });

    await user.click(editButton());
    expect(screen.getByRole("button", { name: /change picture/i })).toHaveFocus();
  });

  it("closes on Escape and hands focus back to the trigger", async () => {
    const user = userEvent.setup();
    mount({ avatarUrl: PICTURE });

    await user.click(editButton());
    await user.keyboard("{Escape}");

    expect(screen.queryByRole("button", { name: /change picture/i })).not.toBeInTheDocument();
    expect(editButton()).toHaveFocus();
  });

  it("offers no removal when there is nothing to remove", async () => {
    const user = userEvent.setup();
    mount({ avatarUrl: null });

    await user.click(editButton());

    expect(screen.getByRole("button", { name: /add picture/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /remove picture/i })).not.toBeInTheDocument();
  });
});

describe("the circle itself", () => {
  it("shows the picture when there is one", () => {
    const { container } = mount({ avatarUrl: PICTURE });
    const image = container.querySelector("img");
    expect(image).toHaveAttribute("src", PICTURE);
    // Decorative: the person's name is always rendered beside the circle, so
    // announcing it again here would only repeat it.
    expect(image).toHaveAttribute("alt", "");
  });

  it("draws initials when there is none", () => {
    const { container } = mount({ avatarUrl: null });
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText("PS")).toBeInTheDocument();
  });

  it("falls back to initials when the link has expired", () => {
    // A signed link lives minutes and a tab lives hours, so a picture that
    // fails to load is an ordinary event, not a bug. An empty circle or a
    // broken-image glyph would read as one.
    const { container } = mount({ avatarUrl: PICTURE });
    fireEvent.error(container.querySelector("img") as HTMLImageElement);

    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText("PS")).toBeInTheDocument();
  });
});

describe("the client's own check", () => {
  it("names the limit and sends nothing when the file is too large", async () => {
    const setAvatar = vi.spyOn(account, "setAvatar");
    const { container } = mount();

    fireEvent.change(fileInput(container), {
      target: { files: [fileOf("me.png", "image/png", 6 * 1024 * 1024)] },
    });

    expect(await screen.findByText(/5 MB or smaller/)).toBeInTheDocument();
    expect(setAvatar).not.toHaveBeenCalled();
  });

  it("refuses a PDF without asking the server", async () => {
    const setAvatar = vi.spyOn(account, "setAvatar");
    const { container } = mount();

    fireEvent.change(fileInput(container), {
      target: { files: [fileOf("scan.pdf", "application/pdf")] },
    });

    expect(await screen.findByText(/JPEG, PNG or WebP/)).toBeInTheDocument();
    expect(setAvatar).not.toHaveBeenCalled();
  });

  it("passes a file the browser could not type, and lets the server decide", () => {
    // Some pickers report an empty type. The bytes still identify the file
    // server-side, so refusing here would block a good JPEG on a guess.
    expect(localRejection(fileOf("me", "", 1024))).toBeNull();
    expect(localRejection(fileOf("me.png", "image/png"))).toBeNull();
    expect(localRejection(fileOf("me.webp", "image/webp"))).toBeNull();
    expect(localRejection(fileOf("me.gif", "image/gif"))).toBe("type");
    expect(localRejection(fileOf("me.png", "image/png", 5 * 1024 * 1024 + 1))).toBe("size");
  });
});

describe("uploading", () => {
  it("sends the file, confirms it, and refreshes the session", async () => {
    const setAvatar = vi
      .spyOn(account, "setAvatar")
      .mockResolvedValue({ avatarUrl: PICTURE, expiresInSeconds: 300 });
    const { container, onChanged } = mount();
    const file = fileOf("me.png", "image/png");

    fireEvent.change(fileInput(container), { target: { files: [file] } });

    await waitFor(() => expect(setAvatar).toHaveBeenCalledWith(file));
    expect(await screen.findByText("Profile picture updated")).toBeInTheDocument();
    // The rail, the header and the profile menu all read the session, so one
    // refresh is what makes the change appear everywhere at once.
    expect(onChanged).toHaveBeenCalled();
  });

  it("previews the chosen file while the upload runs, then revokes it", async () => {
    vi.spyOn(account, "setAvatar").mockResolvedValue({
      avatarUrl: PICTURE,
      expiresInSeconds: 300,
    });
    const { container, onChanged } = mount();

    fireEvent.change(fileInput(container), {
      target: { files: [fileOf("me.png", "image/png")] },
    });

    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    // A preview that is created and never revoked is a leaked blob per upload.
    await waitFor(() => expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:preview"));
  });

  it("renders the server's refusal in the server's own words", async () => {
    vi.spyOn(account, "setAvatar").mockRejectedValue(
      new ApiError("UNSUPPORTED_FILE", "That file is not what it says it is.", 400),
    );
    const { container, onChanged } = mount();

    fireEvent.change(fileInput(container), {
      target: { files: [fileOf("me.png", "image/png")] },
    });

    expect(await screen.findByText("That file is not what it says it is.")).toBeInTheDocument();
    expect(onChanged).not.toHaveBeenCalled();
  });
});

describe("removing", () => {
  it("asks the server, confirms it, and refreshes the session", async () => {
    const user = userEvent.setup();
    const removeAvatar = vi.spyOn(account, "removeAvatar").mockResolvedValue({ removed: true });
    const { onChanged } = mount({ avatarUrl: PICTURE });

    await user.click(editButton());
    await user.click(screen.getByRole("button", { name: /remove picture/i }));

    await waitFor(() => expect(removeAvatar).toHaveBeenCalled());
    expect(await screen.findByText("Profile picture removed")).toBeInTheDocument();
    expect(onChanged).toHaveBeenCalled();
    // The panel closed and the trigger was disabled while the request ran, so
    // focus had nowhere to be. It must not be left on the document body.
    await waitFor(() => expect(editButton()).toHaveFocus());
  });

  it("reports a failure rather than pretending the picture went", async () => {
    const user = userEvent.setup();
    vi.spyOn(account, "removeAvatar").mockRejectedValue(
      new ApiError("SERVICE_UNAVAILABLE", "Storage is unavailable. Try again shortly.", 503),
    );
    const { onChanged } = mount({ avatarUrl: PICTURE });

    await user.click(editButton());
    await user.click(screen.getByRole("button", { name: /remove picture/i }));

    expect(
      await screen.findByText("Storage is unavailable. Try again shortly."),
    ).toBeInTheDocument();
    expect(onChanged).not.toHaveBeenCalled();
  });
});
