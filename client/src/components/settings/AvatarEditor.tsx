"use client";

/**
 * The profile picture, and the two things a person can do to it.
 *
 * Hovering the circle reveals a small edit button; activating it offers *change
 * picture* and — only when there is one — *remove picture*.
 *
 * **Hover is the reveal, never the route.** A control that exists only under a
 * pointer does not exist for somebody using a keyboard, a switch, or a phone.
 * So the button is always in the tab order and always operable: hover and focus
 * both bring it into view, `opacity-0` rather than `hidden` keeps it reachable
 * by Tab in between, and on a device with no hover at all it simply stays
 * visible. What hover buys is a quieter card, not a secret.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { Icon } from "@/components/Icon";
import { useToast } from "@/components/overlays";
import { Avatar, EkgBars, cx } from "@/components/ui";
import { ApiError, account } from "@/lib/api";
import { useTr } from "@/lib/lang";

/**
 * The three types the server takes, and the size it stops at.
 *
 * Declared here rather than in `lib/api.ts` because that file is the request
 * contract and these are this screen's copy of a server-side rule. They must be
 * kept in step with `api/app/services/avatars.py`, and the comment there
 * explains why the numbers are what they are.
 *
 * This check is a courtesy, not a control: it saves somebody watching five
 * megabytes upload before being told no. The server sniffs the bytes and is the
 * only thing that actually decides, so its refusal is rendered too.
 */
export const ACCEPTED_AVATAR_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export const MAX_AVATAR_BYTES = 5 * 1024 * 1024;
export const MAX_AVATAR_MB = 5;

export type Rejection = "type" | "size";

/**
 * Why this file should not be sent, or null to send it.
 *
 * A file the operating system could not type at all (`file.type === ""`, which
 * happens with some Linux pickers and with drag-and-drop from odd sources) is
 * *not* rejected here. The browser's guess is not evidence either way, and the
 * server identifies the file by its magic number regardless — refusing it on a
 * missing label would block a perfectly good JPEG on the client's opinion.
 */
export function localRejection(file: File): Rejection | null {
  const declared = file.type.split(";")[0]?.trim().toLowerCase() ?? "";
  if (declared && !ACCEPTED_AVATAR_TYPES.includes(declared as (typeof ACCEPTED_AVATAR_TYPES)[number])) {
    return "type";
  }
  if (file.size > MAX_AVATAR_BYTES) return "size";
  return null;
}

export function AvatarEditor({
  name,
  avatarUrl,
  onChanged,
}: {
  name: string;
  /** The short-lived signed link from the session, or null. */
  avatarUrl: string | null;
  /**
   * Called after a successful change. Wired to `refreshUser()`, so the rail,
   * the header and the profile menu all pick the new picture up at once rather
   * than only the circle that was clicked.
   */
  onChanged: () => Promise<void> | void;
}) {
  const tr = useTr();
  const toast = useToast();

  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<"upload" | "remove" | null>(null);
  const [preview, setPreview] = useState<string | null>(null);

  const shell = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const firstItem = useRef<HTMLButtonElement>(null);
  // Set when an action is started from the panel. The panel closes and the
  // trigger goes disabled, which leaves the browser with nowhere to put focus —
  // see the effect below, which puts it back once the work is done.
  const orphanedFocus = useRef(false);
  // The live object URL, held in a ref rather than derived from state: revoking
  // is a side effect and must happen exactly once per URL, which a state
  // updater — which React may run twice — cannot promise.
  const objectUrl = useRef<string | null>(null);

  const releasePreview = useCallback(() => {
    if (objectUrl.current) {
      URL.revokeObjectURL(objectUrl.current);
      objectUrl.current = null;
    }
    setPreview(null);
  }, []);

  // Unmounting mid-upload must not leak the blob.
  useEffect(() => releasePreview, [releasePreview]);

  // Escape closes and hands focus back; a click outside just closes. Same
  // behaviour as the account menu in the shell, so the two feel like one app.
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => {
      if (shell.current && !shell.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      trigger.current?.focus();
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Opening with a keyboard has to put focus somewhere useful, or the person is
  // left on a trigger whose panel they have to hunt for.
  useEffect(() => {
    if (open) firstItem.current?.focus();
  }, [open]);

  // Disabling the trigger mid-action drops focus to the document body, and a
  // keyboard user then restarts their journey through the page from the top.
  // Focus goes back to the button they pressed — but only if it really was
  // orphaned, never stolen back from wherever they have since moved to.
  useEffect(() => {
    if (busy !== null || !orphanedFocus.current) return;
    orphanedFocus.current = false;
    if (document.activeElement === null || document.activeElement === document.body) {
      trigger.current?.focus();
    }
  }, [busy]);

  const failed = useCallback(
    (error: unknown, fallback: string) => {
      toast.show({
        tone: "critical",
        title: tr("That did not work", "Yeh nahi ho saka"),
        // The server's own words when it has them: it knows why it refused, and
        // a generic message would hide a reason the person can act on.
        body: error instanceof ApiError ? error.message : fallback,
      });
    },
    [toast, tr],
  );

  const upload = useCallback(
    async (file: File) => {
      const rejection = localRejection(file);
      if (rejection) {
        toast.show({
          tone: "critical",
          title:
            rejection === "type"
              ? tr("That file is not a picture we can use", "Yeh file tasveer ke tor par nahi chalegi")
              : tr("That picture is too large", "Yeh tasveer bohat bari hai"),
          body:
            rejection === "type"
              ? tr(
                  "Choose a JPEG, PNG or WebP image.",
                  "JPEG, PNG ya WebP tasveer chunein.",
                )
              : tr(
                  `Pictures must be ${MAX_AVATAR_MB} MB or smaller.`,
                  `Tasveer ${MAX_AVATAR_MB} MB ya us se kam honi chahiye.`,
                ),
        });
        return;
      }

      orphanedFocus.current = true;
      // A preview while the bytes travel, so the circle answers immediately
      // rather than sitting on the old picture for the length of an upload.
      releasePreview();
      const local = URL.createObjectURL(file);
      objectUrl.current = local;
      setPreview(local);
      setBusy("upload");

      try {
        await account.setAvatar(file);
        toast.show({
          tone: "success",
          title: tr("Profile picture updated", "Profile tasveer update ho gayi"),
        });
        // Awaited before the preview goes, so the local image holds the circle
        // until the real one is in the session.
        await onChanged();
      } catch (error) {
        failed(error, tr("The picture could not be uploaded.", "Tasveer upload nahi ho saki."));
      } finally {
        releasePreview();
        setBusy(null);
      }
    },
    [failed, onChanged, releasePreview, toast, tr],
  );

  const remove = useCallback(async () => {
    orphanedFocus.current = true;
    setBusy("remove");
    try {
      await account.removeAvatar();
      toast.show({
        tone: "success",
        title: tr("Profile picture removed", "Profile tasveer hata di gayi"),
      });
      await onChanged();
    } catch (error) {
      failed(error, tr("The picture could not be removed.", "Tasveer hataai nahi ja saki."));
    } finally {
      setBusy(null);
    }
  }, [failed, onChanged, toast, tr]);

  const hasPicture = Boolean(avatarUrl);
  const itemClass =
    "flex min-h-11 w-full items-center gap-2.5 rounded-xl px-3 text-left text-sm font-semibold text-strong transition-colors hover:bg-gradient-soft hover:text-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary";

  return (
    <div ref={shell} className="group relative shrink-0">
      <span
        aria-hidden
        className="bg-gradient-brand grid shrink-0 place-items-center rounded-full p-[2px]"
      >
        <Avatar
          name={name}
          src={preview ?? avatarUrl}
          size="lg"
          className={cx(busy && "opacity-40")}
        />
      </span>

      {busy && (
        <span className="absolute inset-0 grid place-items-center rounded-full">
          <EkgBars />
        </span>
      )}
      {/* Announced rather than only drawn: the spinner sits inside an
          `aria-hidden` circle, so without this a screen-reader user gets no
          sign that anything is happening. */}
      <span role="status" aria-live="polite" className="sr-only">
        {busy === "upload"
          ? tr("Uploading your picture", "Aap ki tasveer upload ho rahi hai")
          : busy === "remove"
            ? tr("Removing your picture", "Aap ki tasveer hataai ja rahi hai")
            : ""}
      </span>

      <button
        ref={trigger}
        type="button"
        aria-haspopup="true"
        aria-expanded={open}
        disabled={busy !== null}
        onClick={() => setOpen((value) => !value)}
        title={tr("Edit profile picture", "Profile tasveer badlein")}
        aria-label={tr("Edit profile picture", "Profile tasveer badlein")}
        className={cx(
          "absolute -bottom-0.5 -right-0.5 grid h-8 w-8 place-items-center rounded-full",
          "border border-line bg-card text-muted shadow-card",
          "transition-[opacity,color,transform] hover:scale-105 hover:text-primary",
          "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary",
          "disabled:cursor-not-allowed disabled:opacity-40",
          // Hover reveals it. `opacity-0` and not `hidden`, so Tab still lands
          // on it while it is invisible — and focus then makes it visible.
          "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100",
          // A touch screen has no hover at all, so there it never hides.
          "[@media(hover:none)]:opacity-100",
          open && "opacity-100",
        )}
      >
        <Icon name="edit" className="text-[16px]" />
      </button>

      {open && (
        // Not `role="menu"`. That role promises arrow-key navigation between
        // items, and a promise the code does not keep is worse for a screen
        // reader than plain buttons: here Tab moves, Enter activates, Escape
        // closes and focus returns to the trigger.
        <div
          role="group"
          aria-label={tr("Profile picture", "Profile tasveer")}
          className="glass absolute left-0 top-full z-30 mt-2 w-60 rounded-2xl p-2 shadow-card"
        >
          <button
            ref={firstItem}
            type="button"
            className={itemClass}
            onClick={() => {
              setOpen(false);
              picker.current?.click();
            }}
          >
            <Icon name="photo_camera" className="text-[20px]" />
            {hasPicture
              ? tr("Change picture", "Tasveer badlein")
              : tr("Add picture", "Tasveer lagayein")}
          </button>

          {hasPicture && (
            <button
              type="button"
              className={cx(itemClass, "hover:text-critical")}
              onClick={() => {
                setOpen(false);
                void remove();
              }}
            >
              <Icon name="delete" className="text-[20px]" />
              {tr("Remove picture", "Tasveer hata dein")}
            </button>
          )}

          <p className="px-3 pb-1 pt-2 text-[0.7rem] leading-relaxed text-faint">
            {tr(
              `JPEG, PNG or WebP, up to ${MAX_AVATAR_MB} MB.`,
              `JPEG, PNG ya WebP, ${MAX_AVATAR_MB} MB tak.`,
            )}
          </p>
        </div>
      )}

      <input
        ref={picker}
        type="file"
        accept={ACCEPTED_AVATAR_TYPES.join(",")}
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          // Cleared before the upload starts, so picking the same file again
          // after a failure still fires a change event.
          event.target.value = "";
          if (file) void upload(file);
        }}
      />
    </div>
  );
}
