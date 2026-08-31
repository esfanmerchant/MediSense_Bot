"use client";

/**
 * Writing to an administrator from inside the portal.
 *
 * This replaces a `mailto:` link, and the link was the problem. It depends on
 * the person having a mail client configured; on a phone or on webmail it
 * frequently does nothing at all; and whatever they eventually compose arrives
 * without the registration number the reviewer needs to find them by — which
 * the page was reduced to *asking* them to remember.
 *
 * So the message goes through the API. The sender's name, address and
 * registration number are read server-side from their own record, never sent
 * from here: a form that lets somebody state who they are is a form that can be
 * used to write to an administrator as somebody else.
 */

import { useState } from "react";

import { Icon } from "@/components/Icon";
import { Dialog, useToast } from "@/components/overlays";
import { Button, Field, Textarea } from "@/components/ui";
import { ApiError, doctorApplication } from "@/lib/api";
import { useTr } from "@/lib/lang";

const MIN = 10;
const MAX = 2000;

export function ContactAdminDialog({
  open,
  onClose,
  registrationNumber,
}: {
  open: boolean;
  onClose: () => void;
  /** Shown so the applicant can see it is already attached for them. */
  registrationNumber: string | null;
}) {
  const tr = useTr();
  const toast = useToast();
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  const ready = message.trim().length >= MIN;

  async function send() {
    if (!ready) return;
    setBusy(true);
    try {
      await doctorApplication.contact(message.trim());
      toast.show({
        tone: "success",
        title: tr("Message sent", "Paigham bhej diya"),
        body: tr(
          "An administrator will see it with your application.",
          "Admin ko aap ki darkhwast ke saath nazar aa jaye ga.",
        ),
      });
      setMessage("");
      onClose();
    } catch (cause) {
      toast.show({
        tone: "critical",
        title: tr("Could not send", "Bhej nahi saka"),
        body: cause instanceof ApiError ? cause.message : String(cause),
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      icon="mail"
      title={tr("Write to an administrator", "Admin ko likhein")}
      description={tr(
        "About your registration. They will reply to your email.",
        "Apni registration ke bare mein. Jawab aap ki email par aaye ga.",
      )}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {tr("Cancel", "Cancel")}
          </Button>
          <Button onClick={send} loading={busy} disabled={!ready}>
            <Icon name="send" className="text-[20px]" />
            {tr("Send", "Bhejein")}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {/* Said rather than left to be hoped for: the page used to ask the
            applicant to quote this number themselves. */}
        <p className="flex items-start gap-2 rounded-xl border border-line bg-sunken p-3 text-sm text-muted">
          <Icon name="info" className="mt-0.5 shrink-0 text-[18px] text-primary" />
          <span>
            {registrationNumber
              ? tr(
                  `Your name and registration number (${registrationNumber}) are attached automatically.`,
                  `Aap ka naam aur registration number (${registrationNumber}) khud lag jaate hain.`,
                )
              : tr(
                  "Your name and email are attached automatically.",
                  "Aap ka naam aur email khud lag jaate hain.",
                )}
          </span>
        </p>

        <Field
          label={tr("Your message", "Aap ka paigham")}
          htmlFor="admin-message"
          hint={tr(
            `At least ${MIN} characters.`,
            `Kam az kam ${MIN} harf.`,
          )}
        >
          <Textarea
            id="admin-message"
            rows={6}
            maxLength={MAX}
            autoFocus
            value={message}
            onChange={(event) => setMessage(event.target.value)}
          />
        </Field>
      </div>
    </Dialog>
  );
}
