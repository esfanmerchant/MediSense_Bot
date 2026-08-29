"use client";

/**
 * Turning the second factor on, and turning it off again.
 *
 * Enrolment is three steps and they are all necessary: choose a method, *prove
 * the method works*, then take the codes that get you back in when it does not.
 * Skipping the middle step is how a person locks themselves out of a medical
 * record with a mistyped authenticator; skipping the last is how they stay
 * locked out.
 *
 * Nothing is enabled until `confirmTwoFactor` succeeds — `startTwoFactor` mints
 * a challenge and a secret and changes nothing on the account, so abandoning
 * this dialog halfway leaves the account exactly as it was.
 *
 * Turning it off asks for the password *and* a live code, because an unlocked
 * session left on a ward terminal is the threat the second factor exists for.
 *
 * Neither dialog resets itself. The card that owns them changes their `key`
 * every time one is opened, so each run starts on a fresh mount — a
 * half-finished enrolment can never reappear holding a challenge the server has
 * already forgotten, and there is no reset code to keep in step with the state
 * it clears.
 */

import { useState } from "react";

import { Icon } from "@/components/Icon";
import { OtpInput, Stepper } from "@/components/forms";
import { Dialog } from "@/components/overlays";
import { Button, Checkbox, Field, Input, cx } from "@/components/ui";
import { ApiError, account, type TwoFactorMethod } from "@/lib/api";
import { useTr } from "@/lib/lang";

/**
 * The server's QR, checked before it is inlined.
 *
 * It is our own API's SVG over an authenticated request, so this is a belt on
 * top of braces rather than the only defence — but an SVG is a document that
 * can carry script, and `dangerouslySetInnerHTML` is exactly the wrong place to
 * find that out.
 */
function safeQr(svg: string | null): string | null {
  if (!svg || !/^\s*<svg[\s>]/i.test(svg)) return null;
  if (/<\s*(script|foreignobject|iframe|image|use)\b/i.test(svg)) return null;
  if (/\son\w+\s*=/i.test(svg) || /javascript:/i.test(svg)) return null;
  return svg;
}

function messageOf(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback;
}

/** Inline failure. Never a toast: this is something to act on, right here. */
function Problem({ children }: { children: string }) {
  return (
    <p role="alert" className="pop-in flex items-start gap-1.5 text-sm font-medium text-critical">
      <Icon name="error" className="mt-px shrink-0 text-[16px]" />
      {children}
    </p>
  );
}

const METHODS: {
  value: TwoFactorMethod;
  icon: string;
  title: [string, string];
  description: [string, string];
}[] = [
  {
    value: "EMAIL",
    icon: "mail",
    title: ["By email", "Email par"],
    description: [
      "A six-digit code is sent to your address each time you sign in.",
      "Har sign-in par aap ke email par chhe hindson ka code aata hai.",
    ],
  },
  {
    value: "TOTP",
    icon: "phone_iphone",
    title: ["Authenticator app", "Authenticator app"],
    description: [
      "A code your phone generates, with no email or signal needed.",
      "Code aap ka phone khud banata hai — na email chahiye na signal.",
    ],
  },
];

export function EnableTwoFactorDialog({
  open,
  onClose,
  onEnabled,
}: {
  open: boolean;
  onClose: () => void;
  /** Fired when the second factor is on and the codes have been acknowledged. */
  onEnabled: (method: TwoFactorMethod) => void;
}) {
  const tr = useTr();
  const [step, setStep] = useState(0);
  const [method, setMethod] = useState<TwoFactorMethod>("EMAIL");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [challengeId, setChallengeId] = useState("");
  const [secret, setSecret] = useState<string | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);

  const [code, setCode] = useState("");
  const [backupCodes, setBackupCodes] = useState<string[]>([]);
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await account.startTwoFactor({ method });
      setChallengeId(result.challengeId);
      setSecret(result.secret);
      setQr(safeQr(result.qrSvg));
      setSentTo(result.sentTo);
      setStep(1);
    } catch (caught) {
      setError(messageOf(caught, tr("Could not start. Try again.", "Shuru nahi ho saka. Dobara koshish karein.")));
    } finally {
      setBusy(false);
    }
  };

  const confirm = async () => {
    if (code.length < 6) return;
    setBusy(true);
    setError(null);
    try {
      const result = await account.confirmTwoFactor({ challengeId, code });
      setBackupCodes(result.backupCodes);
      setStep(2);
    } catch (caught) {
      setError(messageOf(caught, tr("That code was not accepted.", "Yeh code qubool nahi hua.")));
      setCode("");
    } finally {
      setBusy(false);
    }
  };

  const copyCodes = async () => {
    try {
      await navigator.clipboard.writeText(backupCodes.join("\n"));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setError(
        tr(
          "Copying is blocked in this browser — write them down instead.",
          "Is browser mein copy karna band hai — inhein likh lein.",
        ),
      );
    }
  };

  const downloadCodes = () => {
    const blob = new Blob([`${backupCodes.join("\n")}\n`], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "medisense-backup-codes.txt";
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const steps = [
    { label: tr("Method", "Tareeqa") },
    { label: tr("Verify", "Tasdeeq") },
    { label: tr("Backup codes", "Backup codes") },
  ];

  const footer =
    step === 0 ? (
      <>
        <Button variant="ghost" onClick={onClose}>
          {tr("Cancel", "Cancel")}
        </Button>
        <Button onClick={() => void start()} loading={busy}>
          {tr("Continue", "Aage barhein")}
        </Button>
      </>
    ) : step === 1 ? (
      <>
        <Button variant="ghost" onClick={() => setStep(0)} disabled={busy}>
          {tr("Back", "Wapas")}
        </Button>
        <Button onClick={() => void confirm()} loading={busy} disabled={code.length < 6}>
          {tr("Turn it on", "On karein")}
        </Button>
      </>
    ) : (
      <Button disabled={!saved} onClick={() => onEnabled(method)}>
        {tr("Done", "Ho gaya")}
      </Button>
    );

  return (
    <Dialog
      open={open}
      onClose={onClose}
      icon="encrypted"
      title={tr("Turn on two-factor sign-in", "Two-factor sign-in on karein")}
      description={tr(
        "A second step at sign-in, so a stolen password is not enough on its own.",
        "Sign-in par doosra qadam, taake churaya hua password akela kaafi na ho.",
      )}
      footer={footer}
    >
      <Stepper steps={steps} current={step} className="mb-6" />

      {step === 0 && (
        <div role="radiogroup" aria-label={tr("Method", "Tareeqa")} className="space-y-3">
          {METHODS.map((option) => {
            const selected = method === option.value;
            return (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => setMethod(option.value)}
                className={cx(
                  "flex w-full items-start gap-3 rounded-2xl p-4 text-left transition-[border-color,box-shadow]",
                  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary",
                  selected
                    ? "border-gradient-fill shadow-glow"
                    : "border border-line bg-card hover:border-line-strong",
                )}
              >
                <span
                  aria-hidden
                  className={cx(
                    "grid h-10 w-10 shrink-0 place-items-center rounded-xl",
                    selected ? "bg-gradient-brand text-white" : "bg-sunken text-muted",
                  )}
                >
                  <Icon name={option.icon} filled={selected} className="text-[20px]" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[0.9375rem] font-semibold text-strong">
                    {tr(...option.title)}
                  </span>
                  <span className="mt-0.5 block text-sm text-muted">{tr(...option.description)}</span>
                </span>
                <span
                  aria-hidden
                  className={cx(
                    "mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full border-2",
                    selected ? "border-transparent bg-gradient-brand text-white" : "border-line-strong",
                  )}
                >
                  {selected && <Icon name="check" className="text-[14px]" />}
                </span>
              </button>
            );
          })}
          {error && <Problem>{error}</Problem>}
        </div>
      )}

      {step === 1 && (
        <div className="space-y-5">
          {method === "TOTP" ? (
            <div className="space-y-3">
              <p className="text-sm text-muted">
                {tr(
                  "Scan this with your authenticator app, then type the code it shows.",
                  "Isay apni authenticator app se scan karein, phir jo code aaye woh likhein.",
                )}
              </p>
              {qr ? (
                // White, always: a QR needs a light quiet zone to be readable,
                // and the dark theme would otherwise invert it into a wall.
                <div className="flex justify-center">
                  <div
                    aria-label={tr("Two-factor QR code", "Two-factor QR code")}
                    role="img"
                    className="grid h-44 w-44 place-items-center rounded-xl bg-white p-3 shadow-card [&>svg]:h-full [&>svg]:w-full"
                    dangerouslySetInnerHTML={{ __html: qr }}
                  />
                </div>
              ) : (
                <p className="text-sm text-muted">
                  {tr(
                    "No QR was returned — enter the key below by hand instead.",
                    "QR nahi aaya — neeche di gayi key khud daal dein.",
                  )}
                </p>
              )}
              {secret && (
                <div className="flex items-center gap-2 rounded-xl border border-line bg-sunken/60 p-3">
                  <div className="min-w-0 flex-1">
                    <p className="mono-caps text-[0.68rem] text-faint">
                      {tr("Setup key", "Setup key")}
                    </p>
                    <p className="mt-1 break-all font-mono text-sm font-semibold text-strong">
                      {secret}
                    </p>
                  </div>
                  <Button
                    variant="secondary"
                    onClick={() => {
                      void navigator.clipboard?.writeText(secret);
                      setCopied(true);
                      window.setTimeout(() => setCopied(false), 2000);
                    }}
                  >
                    <Icon name={copied ? "check" : "content_copy"} className="text-[18px]" />
                    {copied ? tr("Copied", "Copy ho gaya") : tr("Copy", "Copy")}
                  </Button>
                </div>
              )}
            </div>
          ) : (
            <p className="text-sm text-muted">
              {sentTo
                ? `${tr("We sent a code to", "Hum ne code bheja hai")} ${sentTo}.`
                : tr("We sent a code to your email address.", "Hum ne aap ke email par code bheja hai.")}
            </p>
          )}

          <OtpInput
            value={code}
            onChange={setCode}
            onComplete={() => void confirm()}
            invalid={Boolean(error)}
            disabled={busy}
            label={tr("Verification code", "Tasdeeq ka code")}
          />

          {error && <Problem>{error}</Problem>}
        </div>
      )}

      {step === 2 && (
        <div className="space-y-4">
          <p role="status" className="flex items-start gap-2 text-sm font-semibold text-stable">
            <Icon name="check_circle" filled className="mt-px shrink-0 text-[18px]" />
            {tr("Two-factor sign-in is on.", "Two-factor sign-in on ho gaya.")}
          </p>
          <p className="text-sm leading-relaxed text-muted">
            {tr(
              "Each of these works once, and only when you cannot use your usual second step. This is the only time they are shown — keep them somewhere that is not this device.",
              "In mein se har code sirf ek baar chalta hai, aur sirf tab jab aap ka aam doosra qadam kaam na kare. Yeh sirf abhi dikhaye ja rahe hain — inhein is device se bahar kahin mehfooz rakhein.",
            )}
          </p>

          <ul className="grid grid-cols-2 gap-2 rounded-xl border border-line bg-sunken/60 p-3">
            {backupCodes.map((backupCode) => (
              <li
                key={backupCode}
                className="rounded-lg bg-card px-3 py-2 text-center font-mono text-sm font-semibold tracking-wider text-strong"
              >
                {backupCode}
              </li>
            ))}
          </ul>

          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" onClick={downloadCodes}>
              <Icon name="download" className="text-[18px]" />
              {tr("Download .txt", "Download .txt")}
            </Button>
            <Button variant="secondary" onClick={() => void copyCodes()}>
              <Icon name={copied ? "check" : "content_copy"} className="text-[18px]" />
              {copied ? tr("Copied", "Copy ho gaya") : tr("Copy", "Copy")}
            </Button>
          </div>

          <Checkbox
            checked={saved}
            onChange={(event) => setSaved(event.target.checked)}
            label={tr("I have saved these codes", "Maine save kar liye")}
          />

          {error && <Problem>{error}</Problem>}
        </div>
      )}
    </Dialog>
  );
}

export function DisableTwoFactorDialog({
  open,
  onClose,
  onDisabled,
}: {
  open: boolean;
  onClose: () => void;
  onDisabled: () => void;
}) {
  const tr = useTr();
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const disable = async () => {
    setBusy(true);
    setError(null);
    try {
      await account.disableTwoFactor({ password, code });
      onDisabled();
    } catch (caught) {
      setError(
        messageOf(caught, tr("That did not match. Try again.", "Yeh mel nahi khaya. Dobara koshish karein.")),
      );
      setCode("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      icon="lock_open"
      title={tr("Turn off two-factor sign-in", "Two-factor sign-in off karein")}
      description={tr(
        "Your password alone will get into this account again.",
        "Phir sirf password se hi is account mein aaya ja sakega.",
      )}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {tr("Keep it on", "On hi rehne dein")}
          </Button>
          <Button
            variant="danger"
            onClick={() => void disable()}
            loading={busy}
            disabled={!password || code.length < 6}
          >
            {tr("Turn it off", "Off karein")}
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <Field label={tr("Current password", "Mojooda password")} htmlFor="disable-2fa-password">
          <Input
            id="disable-2fa-password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </Field>

        <div>
          <p className="mb-3 text-sm text-muted">
            {tr(
              "And a live code from your second factor.",
              "Aur aap ke doosre qadam ka abhi ka code.",
            )}
          </p>
          <OtpInput
            value={code}
            onChange={setCode}
            invalid={Boolean(error)}
            disabled={busy}
            autoFocus={false}
            label={tr("Two-factor code", "Two-factor code")}
          />
        </div>

        {error && <Problem>{error}</Problem>}
      </div>
    </Dialog>
  );
}
