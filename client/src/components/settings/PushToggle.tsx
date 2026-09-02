"use client";

/**
 * Turning push notifications on for *this* device.
 *
 * The wording is deliberately per-device, not per-account, because that is
 * what a push subscription is: enabling it on a phone says nothing about the
 * laptop, and a switch labelled as an account setting would be a lie the first
 * time somebody signs in somewhere else and finds it off.
 *
 * A denied permission is a dead end the page cannot reopen — the browser stops
 * asking, and only its own settings can undo it. So the denied state stops
 * offering a button and says where to go instead, which is the only useful
 * thing left to say.
 */

import { useState } from "react";

import { Icon } from "@/components/Icon";
import { Badge, Button, Card } from "@/components/ui";
import { useTr } from "@/lib/lang";
import * as push from "@/lib/push";
import { useAsync } from "@/lib/useAsync";

type Busy = "idle" | "enabling" | "disabling";

export function PushToggle() {
  const tr = useTr();
  const [busy, setBusy] = useState<Busy>("idle");

  // A permission state does not change behind the page's back, so there is
  // nothing for a timer to catch — only what this component itself did.
  const server = useAsync(() => push.status(), [], { live: false });

  /** The outcome of the last button press, which is newer than the fetch. */
  const [acted, setActed] = useState<{ state: push.PushState; devices: number } | null>(null);

  const state: push.PushState | "loading" =
    acted?.state ?? (server.loading ? "loading" : (server.data?.state ?? "unsupported"));
  const devices = acted?.devices ?? server.data?.devices ?? 0;

  const enable = async () => {
    setBusy("enabling");
    const result = await push.enable();
    // Ask the server rather than assuming: the device count is its answer, and
    // this browser may already have been enrolled before today.
    const after = result === "granted" ? await push.status() : null;
    setActed({ state: result, devices: after?.devices ?? devices });
    setBusy("idle");
  };

  const disable = async () => {
    setBusy("disabling");
    await push.disable();
    const after = await push.status();
    setActed(after);
    setBusy("idle");
  };

  // Nothing to offer: an old browser, an iPhone that has not been added to the
  // home screen, or a deployment with no push keys. Saying nothing beats a
  // switch that cannot work.
  if (state === "loading" || state === "unsupported") return null;

  return (
    <Card
      title={tr("Notifications on this device", "Is device par notifications")}
      description={tr(
        "Reminders reach you even when the app is closed — a dose that is due, an appointment tomorrow, a sign-in you may not have made.",
        "App band ho tab bhi reminder pohanchte hain — dawa ka waqt, kal ki appointment, ya koi sign-in jo shayad aap ne na kiya ho.",
      )}
      icon="notifications_active"
      action={
        state === "granted" ? (
          <Badge tone="good">
            <Icon name="check_circle" className="text-[14px]" />
            {tr("On", "On")}
          </Badge>
        ) : undefined
      }
    >
      {state === "denied" ? (
        <p className="text-sm leading-relaxed text-muted">
          {tr(
            "This browser has blocked notifications for MediSense. Only the browser can undo that — open the padlock beside the address bar, allow notifications, and reload this page.",
            "Is browser ne MediSense ke notifications rok rakhe hain. Yeh sirf browser hi wapas khol sakta hai — address bar ke paas taala kholein, notifications ki ijazat dein, aur is safhe ko reload karein.",
          )}
        </p>
      ) : (
        <div className="flex flex-wrap items-center gap-4">
          <Button
            variant={state === "granted" ? "ghost" : "primary"}
            onClick={state === "granted" ? disable : enable}
            loading={busy !== "idle"}
          >
            <Icon
              name={state === "granted" ? "notifications_off" : "notifications_active"}
              className="text-[18px]"
            />
            {state === "granted"
              ? tr("Turn off on this device", "Is device par band karein")
              : tr("Turn on notifications", "Notifications on karein")}
          </Button>
          {devices > 0 && (
            <p className="text-sm text-muted">
              {devices === 1
                ? tr("Enrolled on 1 device.", "1 device par chalu hai.")
                : tr(
                    `Enrolled on ${devices} devices.`,
                    `${devices} devices par chalu hai.`,
                  )}
            </p>
          )}
        </div>
      )}
    </Card>
  );
}
