"use client";

/**
 * The three things a person can actually do about their own security: change
 * the password, add a second factor, and throw a device off the account.
 *
 * All three are real endpoints. Where one is not deployed yet the card says so
 * in a sentence rather than throwing a red panel at somebody who did nothing
 * wrong — a 404 here is a server that has not shipped the route, not a failure
 * the reader can act on.
 */

import { useState, type FormEvent, type ReactNode } from "react";

import { Icon } from "@/components/Icon";
import { PasswordStrength } from "@/components/forms";
import { useToast } from "@/components/overlays";
import {
  DisableTwoFactorDialog,
  EnableTwoFactorDialog,
} from "@/components/settings/TwoFactorDialogs";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Field,
  Input,
  Skeleton,
  cx,
} from "@/components/ui";
import {
  ApiError,
  account,
  auth,
  type ActiveSession,
  type TwoFactorStatus,
} from "@/lib/api";
import { useTr } from "@/lib/lang";
import { useAsync } from "@/lib/useAsync";

type Tr = (en: string, ur: string) => string;

/**
 * A route the server has not shipped yet.
 *
 * Worth separating from a real failure: "not found" here means the feature is
 * on its way, and a retry button would only produce the same 404 again.
 */
function NotDeployed({ what }: { what: string }) {
  const tr = useTr();
  return (
    <div role="note" className="flex items-start gap-3 rounded-xl border border-line bg-sunken/60 p-4">
      <Icon name="pending" className="mt-0.5 shrink-0 text-[20px] text-muted" />
      <p className="text-sm leading-relaxed text-muted">
        <strong className="font-semibold text-strong">{what}</strong>{" "}
        {tr(
          "is not available on this server yet. Nothing is wrong with your account — the screen is ready and will work the moment the endpoint is live.",
          "abhi is server par mojood nahi. Aap ke account mein koi kharabi nahi — screen tayyar hai aur endpoint chalte hi kaam karne lagegi.",
        )}
      </p>
    </div>
  );
}

/** A panel body that picks the right one of loading / missing / broken / data. */
function Async<T>({
  state,
  what,
  children,
}: {
  state: { data: T | null; error: ApiError | null; loading: boolean; reload: () => void };
  what: string;
  children: (data: T) => ReactNode;
}) {
  const tr = useTr();
  if (state.loading) {
    return (
      <div className="space-y-3" aria-hidden>
        <Skeleton className="h-5 w-40" />
        <Skeleton className="h-11 w-full rounded-xl" />
      </div>
    );
  }
  if (state.error?.code === "NOT_FOUND") return <NotDeployed what={what} />;
  if (state.error) {
    return (
      <ErrorState
        title={tr("That did not load", "Yeh load nahi hua")}
        message={state.error.message}
        onRetry={state.reload}
      />
    );
  }
  if (!state.data) return null;
  return <>{children(state.data)}</>;
}

// ---------------------------------------------------------------------------
// Password
// ---------------------------------------------------------------------------

function PasswordCard() {
  const tr = useTr();
  const toast = useToast();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Which fields have been left. Telling somebody their password is too short
  // after one character is not help, it is nagging.
  const [left, setLeft] = useState({ next: false, confirm: false });

  const mismatch = confirm.length > 0 && confirm !== next;
  const tooWeak = next.length > 0 && next.length < 8;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (mismatch || tooWeak || !current || !next) return;
    setBusy(true);
    setError(null);
    try {
      await auth.changePassword(current, next);
      setCurrent("");
      setNext("");
      setConfirm("");
      toast.show({
        tone: "success",
        title: tr("Password changed", "Password badal gaya"),
        body: tr(
          "Use the new one the next time you sign in.",
          "Agli baar sign-in par naya password istemal karein.",
        ),
      });
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? caught.message
          : tr("Could not change the password.", "Password nahi badla ja saka."),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      title={tr("Password", "Password")}
      description={tr(
        "Changing it does not sign your other devices out — do that below.",
        "Isay badalne se doosre devices sign out nahi hote — woh neeche se karein.",
      )}
      icon="key"
    >
      <form onSubmit={(event) => void submit(event)} className="max-w-md space-y-4">
        <Field label={tr("Current password", "Mojooda password")} htmlFor="current-password">
          <Input
            id="current-password"
            type="password"
            autoComplete="current-password"
            value={current}
            onChange={(event) => setCurrent(event.target.value)}
            required
          />
        </Field>

        <div className="space-y-2">
          <Field
            label={tr("New password", "Naya password")}
            htmlFor="new-password"
            hint={tr("At least 8 characters.", "Kam az kam 8 characters.")}
            error={
              left.next && tooWeak
                ? tr("Too short — 8 characters or more.", "Bohat chhota — 8 ya zyada characters.")
                : undefined
            }
          >
            <Input
              id="new-password"
              type="password"
              autoComplete="new-password"
              value={next}
              onChange={(event) => setNext(event.target.value)}
              onBlur={() => setLeft((flags) => ({ ...flags, next: true }))}
              invalid={left.next && tooWeak}
              required
            />
          </Field>
          {next.length > 0 && (
            <PasswordStrength
              value={next}
              labels={[
                tr("Weak", "Kamzor"),
                tr("Fair", "Theek"),
                tr("Good", "Acha"),
                tr("Strong", "Mazboot"),
              ]}
            />
          )}
        </div>

        <Field
          label={tr("Repeat new password", "Naya password dobara")}
          htmlFor="confirm-password"
          error={left.confirm && mismatch ? tr("These do not match.", "Yeh mel nahi khate.") : undefined}
        >
          <Input
            id="confirm-password"
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(event) => setConfirm(event.target.value)}
            onBlur={() => setLeft((flags) => ({ ...flags, confirm: true }))}
            invalid={left.confirm && mismatch}
            required
          />
        </Field>

        {error && (
          <p role="alert" className="pop-in flex items-start gap-1.5 text-sm font-medium text-critical">
            <Icon name="error" className="mt-px shrink-0 text-[16px]" />
            {error}
          </p>
        )}

        <Button
          type="submit"
          loading={busy}
          disabled={!current || !next || mismatch || tooWeak}
        >
          {tr("Change password", "Password badlein")}
        </Button>
      </form>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Two-factor
// ---------------------------------------------------------------------------

function statusChip(status: TwoFactorStatus, tr: Tr) {
  if (!status.enabled) {
    return { tone: "neutral" as const, icon: "lock_open", text: tr("Off", "Off") };
  }
  return status.method === "TOTP"
    ? { tone: "good" as const, icon: "phone_iphone", text: tr("On — via app", "On — app se") }
    : { tone: "good" as const, icon: "mail", text: tr("On — via email", "On — email se") };
}

function TwoFactorCard() {
  const tr = useTr();
  const toast = useToast();
  const state = useAsync(() => account.twoFactor(), []);
  const [enabling, setEnabling] = useState(false);
  const [disabling, setDisabling] = useState(false);
  const [forgetting, setForgetting] = useState(false);
  // Bumped on every open so the dialog remounts: each enrolment starts from
  // nothing, without a pile of reset code inside the dialog itself.
  const [run, setRun] = useState(0);

  const forget = async () => {
    setForgetting(true);
    try {
      const { forgotten } = await account.forgetDevices();
      state.reload();
      toast.show({
        tone: "success",
        title: tr("Remembered devices forgotten", "Yaad rakhe hue devices bhula diye"),
        body:
          forgotten === 1
            ? tr("1 device will be asked for a code again.", "1 device se dobara code maanga jayega.")
            : `${forgotten} ${tr("devices will be asked for a code again.", "devices se dobara code maanga jayega.")}`,
      });
    } catch (caught) {
      toast.show({
        tone: "critical",
        title: tr("Could not do that", "Yeh nahi ho saka"),
        body: caught instanceof ApiError ? caught.message : tr("Try again.", "Dobara koshish karein."),
      });
    } finally {
      setForgetting(false);
    }
  };

  return (
    <Card
      title={tr("Two-factor sign-in", "Two-factor sign-in")}
      description={tr(
        "A second step after the password, so a leaked password is not a way in on its own.",
        "Password ke baad doosra qadam, taake leak hua password akela raasta na bane.",
      )}
      icon="encrypted"
    >
      <Async state={state} what={tr("Two-factor sign-in", "Two-factor sign-in")}>
        {(status) => {
          const chip = statusChip(status, tr);
          return (
            <div className="space-y-5">
              <div className="flex flex-wrap items-center gap-3">
                <Badge tone={chip.tone}>
                  <Icon name={chip.icon} className="text-[14px]" />
                  {chip.text}
                </Badge>
                {status.enabled && (
                  <span className="text-sm text-muted">
                    {status.backupCodesRemaining}{" "}
                    {tr("backup codes left", "backup codes bache hain")}
                  </span>
                )}
                <div className="ml-auto">
                  {status.enabled ? (
                    <Button
                      variant="secondary"
                      onClick={() => {
                        setRun((value) => value + 1);
                        setDisabling(true);
                      }}
                    >
                      {tr("Turn off", "Off karein")}
                    </Button>
                  ) : (
                    <Button
                      onClick={() => {
                        setRun((value) => value + 1);
                        setEnabling(true);
                      }}
                    >
                      {tr("Turn on", "On karein")}
                    </Button>
                  )}
                </div>
              </div>

              {status.enabled && status.backupCodesRemaining <= 2 && (
                <p
                  role="alert"
                  className="flex items-start gap-2 rounded-xl border border-warning/40 bg-warning-soft p-3 text-sm font-medium text-warning"
                >
                  <Icon name="warning" filled className="mt-px shrink-0 text-[18px]" />
                  {tr(
                    "Almost out of backup codes. Turn two-factor off and on again to be issued a fresh set.",
                    "Backup codes khatam hone wale hain. Two-factor off kar ke dobara on karein to naye codes mil jayenge.",
                  )}
                </p>
              )}

              <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-sunken/60 p-4">
                <div className="min-w-0">
                  <p className="text-[0.9375rem] font-semibold text-strong">
                    {tr("Remembered devices", "Yaad rakhe hue devices")}
                  </p>
                  <p className="mt-0.5 text-sm text-muted">
                    {status.trustedDevices === 0
                      ? tr(
                          "None. Every sign-in asks for the second step.",
                          "Koi nahi. Har sign-in par doosra qadam maanga jata hai.",
                        )
                      : `${status.trustedDevices} ${tr(
                          "browsers skip the second step for 30 days.",
                          "browsers 30 din tak doosra qadam chhod dete hain.",
                        )}`}
                  </p>
                </div>
                <Button
                  variant="secondary"
                  onClick={() => void forget()}
                  loading={forgetting}
                  disabled={status.trustedDevices === 0}
                >
                  {tr("Forget them all", "Sab bhula dein")}
                </Button>
              </div>

              <EnableTwoFactorDialog
                key={`enable-${run}`}
                open={enabling}
                onClose={() => {
                  setEnabling(false);
                  state.reload();
                }}
                onEnabled={(method) => {
                  setEnabling(false);
                  state.reload();
                  toast.show({
                    tone: "success",
                    title: tr("Two-factor sign-in is on", "Two-factor sign-in on hai"),
                    body:
                      method === "TOTP"
                        ? tr("Your app will supply the code.", "Aap ki app code degi.")
                        : tr("A code will be emailed each time.", "Har baar email par code aayega."),
                  });
                }}
              />

              <DisableTwoFactorDialog
                key={`disable-${run}`}
                open={disabling}
                onClose={() => setDisabling(false)}
                onDisabled={() => {
                  setDisabling(false);
                  state.reload();
                  toast.show({
                    tone: "warning",
                    title: tr("Two-factor sign-in is off", "Two-factor sign-in off hai"),
                    body: tr(
                      "Your password is now the only thing protecting this account.",
                      "Ab sirf password hi is account ki hifazat kar raha hai.",
                    ),
                  });
                }}
              />
            </div>
          );
        }}
      </Async>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

function deviceIcon(session: ActiveSession): string {
  if (session.deviceClass === "MONITOR") return "monitor_heart";
  if (session.deviceClass === "SHARED_TERMINAL") return "desktop_windows";
  const agent = (session.userAgent ?? "").toLowerCase();
  if (/ipad|tablet/.test(agent)) return "tablet_mac";
  if (/iphone|android|mobile/.test(agent)) return "smartphone";
  return "computer";
}

/** The readable half of a user-agent string: a browser, and what it runs on. */
function deviceName(userAgent: string | null, tr: Tr): string {
  if (!userAgent) return tr("Unknown device", "Anjaan device");
  const browser =
    /edg\//i.test(userAgent) ? "Edge"
    : /opr\/|opera/i.test(userAgent) ? "Opera"
    : /chrome|crios/i.test(userAgent) ? "Chrome"
    : /firefox|fxios/i.test(userAgent) ? "Firefox"
    : /safari/i.test(userAgent) ? "Safari"
    : tr("Browser", "Browser");
  const platform =
    /windows/i.test(userAgent) ? "Windows"
    : /iphone|ipad|ios/i.test(userAgent) ? "iOS"
    : /mac os|macintosh/i.test(userAgent) ? "macOS"
    : /android/i.test(userAgent) ? "Android"
    : /linux/i.test(userAgent) ? "Linux"
    : null;
  return platform ? `${browser} · ${platform}` : browser;
}

function timeAgo(iso: string, tr: Tr): string {
  const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return tr("just now", "abhi abhi");
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} ${tr("min ago", "minute pehle")}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ${tr("h ago", "ghante pehle")}`;
  const days = Math.floor(hours / 24);
  return `${days} ${tr("d ago", "din pehle")}`;
}

const DEVICE_CLASS_LABEL: Record<ActiveSession["deviceClass"], [string, string]> = {
  PERSONAL: ["Personal", "Zaati"],
  SHARED_TERMINAL: ["Shared terminal", "Mushtarka terminal"],
  MONITOR: ["Ward monitor", "Ward monitor"],
};

function SessionsCard() {
  const tr = useTr();
  const toast = useToast();
  const state = useAsync(() => account.sessions(), []);
  const [revoking, setRevoking] = useState<string | null>(null);

  const revoke = async (session: ActiveSession) => {
    setRevoking(session.id);
    try {
      await account.revokeSession(session.id);
      state.reload();
      toast.show({
        tone: "success",
        title: tr("Signed that device out", "Us device ko sign out kar diya"),
        body: deviceName(session.userAgent, tr),
      });
    } catch (caught) {
      toast.show({
        tone: "critical",
        title: tr("Could not sign it out", "Sign out nahi ho saka"),
        body: caught instanceof ApiError ? caught.message : tr("Try again.", "Dobara koshish karein."),
      });
    } finally {
      setRevoking(null);
    }
  };

  return (
    <Card
      title={tr("Where you are signed in", "Aap kahan kahan signed in hain")}
      description={tr(
        "Every browser holding a live session. Anything you do not recognise should go.",
        "Har browser jis ka session abhi chal raha hai. Jo pehchaan mein na aaye, usay hata dein.",
      )}
      icon="devices"
      flush
    >
      <div className="p-6">
        <Async state={state} what={tr("Active sessions", "Chalte hue sessions")}>
          {(sessions) =>
            sessions.length === 0 ? (
              <EmptyState
                icon="devices"
                title={tr("No other sessions", "Koi doosra session nahi")}
                description={tr(
                  "This browser is the only one signed in.",
                  "Sirf yeh browser signed in hai.",
                )}
              />
            ) : (
              <ul className="divide-y divide-line">
                {sessions.map((session) => (
                  <li key={session.id} className="flex flex-wrap items-center gap-4 py-4 first:pt-0 last:pb-0">
                    <span
                      aria-hidden
                      className={cx(
                        "grid h-11 w-11 shrink-0 place-items-center rounded-xl",
                        session.current ? "bg-gradient-brand text-white" : "bg-sunken text-muted",
                      )}
                    >
                      <Icon name={deviceIcon(session)} filled={session.current} className="text-[22px]" />
                    </span>

                    <div className="min-w-0 flex-1">
                      <p className="flex flex-wrap items-center gap-2 text-[0.9375rem] font-semibold text-strong">
                        {deviceName(session.userAgent, tr)}
                        {session.current && (
                          <Badge tone="good">
                            <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-stable" />
                            {tr("This device", "Yehi device")}
                          </Badge>
                        )}
                      </p>
                      <p className="mt-0.5 text-sm text-muted">
                        <span className="mono-caps text-[0.68rem] text-faint">
                          {tr(...DEVICE_CLASS_LABEL[session.deviceClass])}
                        </span>
                        {" · "}
                        {tr("last seen", "aakhri baar")} {timeAgo(session.lastSeenAt, tr)}
                        {session.ipAddress ? ` · ${session.ipAddress}` : ""}
                      </p>
                    </div>

                    {session.current ? (
                      <span className="text-sm text-faint">
                        {tr("Sign out from the menu", "Menu se sign out karein")}
                      </span>
                    ) : (
                      <Button
                        variant="secondary"
                        onClick={() => void revoke(session)}
                        loading={revoking === session.id}
                      >
                        {tr("Sign out this device", "Is device ko sign out karein")}
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            )
          }
        </Async>
      </div>
    </Card>
  );
}

export function SecurityTab() {
  return (
    <div className="space-y-6">
      <PasswordCard />
      <TwoFactorCard />
      <SessionsCard />
    </div>
  );
}
