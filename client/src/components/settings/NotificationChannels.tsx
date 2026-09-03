"use client";

/**
 * Two switches: whether notifications also travel by email, and to devices.
 *
 * **The portal list is not one of them.** It is the record that somebody was
 * told, and a portal that could quietly stop keeping it would be unable to
 * answer "was I notified?" — which is a question that matters most when the
 * answer is disputed. So these govern where a notice *also* goes, never
 * whether it happened.
 *
 * **Two kinds of notice ignore both switches**, and the page says so rather
 * than accepting a setting it will not honour: a break-glass access to your
 * record, and a change to this account's security. Turning email off means
 * "stop telling me about appointments"; it does not mean "do not tell me if
 * somebody opened my medical record in an emergency" — and the person who
 * would want that silenced is not the patient. The list is read from the
 * server rather than written here, so it cannot drift out of date.
 *
 * **The push switch is not the same thing as the device switch below it.**
 * This one is the account saying "I want push at all"; that one is this
 * browser saying "me too". Turning this off stops every device; turning that
 * off stops this one.
 */

import { useState } from "react";

import { Icon } from "@/components/Icon";
import { Card, cx } from "@/components/ui";
import { notificationChannels, type NotificationChannels as Channels } from "@/lib/api";
import { useTr } from "@/lib/lang";
import { useAsync } from "@/lib/useAsync";

/** How the server spells a type, and how a person would say it. */
const ALWAYS_LABELS: Record<string, [string, string]> = {
  EMERGENCY_ACCESS: [
    "your record being opened in an emergency",
    "emergency mein aap ka record khulna",
  ],
  ACCOUNT_SECURITY: [
    "a change to your account's security",
    "aap ke account ki hifazat mein tabdeeli",
  ],
};

function Switch({
  id,
  label,
  description,
  icon,
  checked,
  busy,
  onChange,
}: {
  id: string;
  label: string;
  description: string;
  icon: string;
  checked: boolean;
  busy: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <div className="flex items-start gap-4 px-6 py-4">
      <span
        aria-hidden
        className="bg-gradient-soft grid h-10 w-10 shrink-0 place-items-center rounded-xl text-primary"
      >
        <Icon name={icon} className="text-[20px]" />
      </span>
      <div className="min-w-0 flex-1">
        <label htmlFor={id} className="text-[0.9375rem] font-semibold text-strong">
          {label}
        </label>
        <p className="mt-0.5 text-sm leading-relaxed text-muted">{description}</p>
      </div>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={busy}
        onClick={() => onChange(!checked)}
        className={cx(
          "relative mt-0.5 h-6 w-11 shrink-0 rounded-full transition-colors",
          // The visual track stays switch-sized; the hit area is extended so a
          // thumb has 44px to aim at without the control looking wrong.
          "before:absolute before:-inset-2.5 before:content-['']",
          "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary",
          "disabled:opacity-60",
          checked ? "bg-primary" : "bg-line-strong",
        )}
      >
        <span
          aria-hidden
          className={cx(
            "absolute top-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition-[left] duration-200",
            checked ? "left-[1.375rem]" : "left-0.5",
          )}
        />
      </button>
    </div>
  );
}

export function NotificationChannels() {
  const tr = useTr();
  const server = useAsync(() => notificationChannels.get(), [], { live: false });

  /** What the last press set, which is newer than the fetch. */
  const [saved, setSaved] = useState<Channels | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const channels = saved ?? server.data ?? null;
  if (!channels) return null;

  const change = async (patch: { notifyByEmail?: boolean; notifyByPush?: boolean }) => {
    // Optimistic, then reconciled: it is the person's own switch, so showing it
    // immediately is honest, and a failure puts back what was really stored.
    const previous = channels;
    setSaved({ ...channels, ...patch });
    setBusy(true);
    setError(null);
    try {
      setSaved(await notificationChannels.set(patch));
    } catch {
      setSaved(previous);
      setError(tr("Could not save. Try again.", "Save nahi hua. Dobara koshish karein."));
    } finally {
      setBusy(false);
    }
  };

  const always = channels.alwaysSent
    .map((kind) => ALWAYS_LABELS[kind])
    .filter(Boolean)
    .map((pair) => tr(...pair));

  return (
    <Card
      title={tr("Where notifications go", "Notifications kahan jate hain")}
      description={tr(
        "Everything is always listed in the portal. These decide what else it reaches.",
        "Har cheez portal mein hamesha darj hoti hai. Yeh tay karta hai ke aur kahan pohanche.",
      )}
      icon="tune"
      flush
    >
      <div className="divide-y divide-line">
        <Switch
          id="notify-push"
          icon="notifications_active"
          label={tr("On your devices", "Aap ke devices par")}
          description={tr(
            "Everything the system tells you — a dose that is due, an appointment, a new report, a bill.",
            "Jo kuch bhi system aap ko batata hai — dawa ka waqt, appointment, nayi report, bill.",
          )}
          checked={channels.notifyByPush}
          busy={busy}
          onChange={(next) => void change({ notifyByPush: next })}
        />
        <Switch
          id="notify-email"
          icon="mail"
          label={tr("By email", "Email se")}
          description={tr(
            "Only what you may need without the app open, or months later: appointments, bills, your record being opened.",
            "Sirf woh jo app khole baghair — ya maheenon baad — darkar ho: appointments, bills, aap ka record khulna.",
          )}
          checked={channels.notifyByEmail}
          busy={busy}
          onChange={(next) => void change({ notifyByEmail: next })}
        />
      </div>

      {always.length > 0 && (
        <div className="border-t border-line px-6 py-4">
          <p className="flex items-start gap-2.5 text-sm leading-relaxed text-muted">
            <Icon name="shield_person" className="mt-0.5 shrink-0 text-[18px] text-primary" />
            <span>
              <strong className="font-semibold text-strong">
                {tr("Two things are sent whatever these say:", "Do cheezein in ke bawajood jati hain:")}
              </strong>{" "}
              {always.join(tr(", and ", ", aur "))}
              {tr(
                ". Those reach you when you are not looking at the app, which is exactly when they matter.",
                ". Yeh tab pohanchti hain jab aap app nahi dekh rahe hote — aur asal mein wahi waqt hai jab yeh ahem hoti hain.",
              )}
            </span>
          </p>
        </div>
      )}

      {error && (
        <p role="alert" className="border-t border-line px-6 py-3 text-sm font-medium text-critical">
          {error}
        </p>
      )}
    </Card>
  );
}
