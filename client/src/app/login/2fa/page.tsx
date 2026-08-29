"use client";

/**
 * The second factor.
 *
 * A challenge is not a failure, and this screen is written as the rest of
 * signing in rather than an obstacle: the same card, the same ramp, one field.
 *
 * Two details are load-bearing. "Remember this device" is *absent* — not
 * disabled, absent — when the sign-in declared a shared terminal, because a
 * ward workstation that skips the second step for thirty days is the exact
 * hole two-factor exists to close. And the backup code is always one link
 * away: the person who needs it is the one whose phone is gone, and hiding
 * that route behind a support call is how an account becomes unreachable.
 */

import { motion, useReducedMotion } from "framer-motion";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState, type FormEvent } from "react";

import { AuthPanel } from "@/components/AuthPanel";
import { Icon } from "@/components/Icon";
import {
  AUTH_LINK,
  AuthHeading,
  AuthNotice,
  BackupCodeField,
  IconBadge,
} from "@/components/auth/parts";
import { ResendControl, useCountdown } from "@/components/auth/timers";
import { OtpInput } from "@/components/forms";
import { Button, Checkbox, Loading, cx } from "@/components/ui";
import { ApiError, auth, type TwoFactorMethod } from "@/lib/api";
import { useTr } from "@/lib/lang";
import { useSession } from "@/lib/session";

/** Seconds before another code may be asked for. */
const RESEND_WAIT = 60;

function TwoFactorForm() {
  const router = useRouter();
  const params = useSearchParams();
  const reduced = useReducedMotion();
  const { adoptSession } = useSession();
  const tr = useTr();

  const challengeId = params.get("challenge") ?? "";
  const method = (params.get("method") === "TOTP" ? "TOTP" : "EMAIL") as TwoFactorMethod;
  const shared = params.get("shared") === "1";

  const [code, setCode] = useState("");
  const [backup, setBackup] = useState(false);
  const [remember, setRemember] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [resending, setResending] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [done, setDone] = useState<{ redirectTo: string } | null>(null);

  const resend = useCountdown(method === "EMAIL" ? RESEND_WAIT : 0);

  // The card leaves, then the app moves. Driven by a timer rather than the
  // animation's own callback so that a dropped frame cannot strand somebody
  // who is, by this point, already signed in.
  useEffect(() => {
    if (!leaving || !done) return;
    const id = window.setTimeout(() => router.replace(done.redirectTo), reduced ? 0 : 320);
    return () => window.clearTimeout(id);
  }, [leaving, done, reduced, router]);

  if (!challengeId) {
    return (
      <div className="w-full">
        <AuthHeading
          badge={<IconBadge name="lock_clock" />}
          title={tr("This sign-in has expired", "Yeh login khatam ho chuka hai")}
          subtitle={tr(
            "A code request only stays open for a few minutes. Start again and we will send a new one.",
            "Code ki darkhwast sirf chand minute khuli rehti hai. Dobara shuru karein, naya code aa jayega.",
          )}
        />
        <Link
          href="/login"
          className="btn-gradient btn-shine flex min-h-14 w-full items-center justify-center gap-2 rounded-xl px-6 text-lg font-semibold text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
        >
          {tr("Back to sign in", "Login par wapas")}
          <Icon name="arrow_forward" className="text-[20px]" />
        </Link>
      </div>
    );
  }

  async function submit(value: string) {
    if (!value || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await auth.verifyTwoFactor({
        challengeId,
        code: value.trim(),
        // Never offered on a shared terminal, so never sent from one either.
        rememberDevice: shared ? false : remember,
      });
      setDone({ redirectTo: result.redirectTo });
      adoptSession(result.user, result.session);
      setLeaving(true);
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? caught
          : new ApiError("INTERNAL_ERROR", "Something went wrong. Try again.", 500),
      );
      setCode("");
      // A new key remounts the boxes: the shake replays, and the caret is put
      // back where the next attempt starts.
      setAttempt((current) => current + 1);
    } finally {
      setSubmitting(false);
    }
  }

  async function onResend() {
    setResending(true);
    setError(null);
    try {
      const result = await auth.resendTwoFactor({ challengeId });
      resend.restart(result.resendAfterSeconds || RESEND_WAIT);
    } catch (caught) {
      if (caught instanceof ApiError) {
        setError(caught);
        resend.restart(RESEND_WAIT);
      }
    } finally {
      setResending(false);
    }
  }

  const wrongCode = error?.code === "INVALID_CODE";
  const expired = error?.code === "CODE_EXPIRED";

  return (
    <motion.div
      initial={false}
      animate={leaving ? { opacity: 0, scale: 0.97, y: -10 } : { opacity: 1, scale: 1, y: 0 }}
      transition={reduced ? { duration: 0 } : { duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
      className="w-full"
    >
      <AuthHeading
        badge={<IconBadge name="verified_user" />}
        title={tr("Enter your verification code", "Tasdeeqi code darj karein")}
        subtitle={
          method === "EMAIL"
            ? tr(
                "We sent a six-digit code to the address on your account.",
                "Hum ne aap ke account wale pate par chhe hindson ka code bheja hai.",
              )
            : tr(
                "Open your authenticator app and read the current code.",
                "Apni authenticator app kholein aur mojooda code dekhein.",
              )
        }
      />

      {wrongCode && (
        <AuthNotice tone="critical" title={tr("That code is not right", "Yeh code sahih nahi hai")}>
          {tr("Check the digits and try once more.", "Hindse dobara dekhein aur phir koshish karein.")}
        </AuthNotice>
      )}

      {expired && (
        <AuthNotice
          tone="warning"
          title={tr("That code has expired", "Yeh code khatam ho chuka hai")}
        >
          {method === "EMAIL"
            ? tr("Ask for a new one below.", "Neeche se naya code mangwayein.")
            : tr(
                "Wait for your app to show the next code.",
                "Apni app mein agla code aane ka intezaar karein.",
              )}
        </AuthNotice>
      )}

      {error && !wrongCode && !expired && <AuthNotice tone="critical">{error.message}</AuthNotice>}

      <form
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          void submit(code);
        }}
        className="space-y-6"
        noValidate
      >
        {backup ? (
          <BackupCodeField
            key={`backup-${attempt}`}
            value={code}
            onChange={setCode}
            invalid={wrongCode}
            disabled={submitting || leaving}
          />
        ) : (
          <OtpInput
            key={`otp-${attempt}`}
            value={code}
            onChange={setCode}
            onComplete={(value) => void submit(value)}
            invalid={wrongCode || expired}
            disabled={submitting || leaving}
            label={tr("Verification code", "Tasdeeqi code")}
          />
        )}

        {!shared && (
          <Checkbox
            checked={remember}
            onChange={(event) => setRemember(event.target.checked)}
            label={tr("Remember this device for 30 days", "Is device ko 30 din yaad rakhein")}
          />
        )}

        <Button
          type="submit"
          size="lg"
          className="btn-shine w-full"
          loading={submitting}
          disabled={backup ? code.trim().length === 0 : code.length < 6}
        >
          {tr("Verify", "Tasdeeq karein")}
          <Icon name="arrow_forward" className="text-[20px]" />
        </Button>
      </form>

      <div className="mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-5">
        <button
          type="button"
          onClick={() => {
            setBackup((current) => !current);
            setCode("");
            setError(null);
          }}
          className={cx(AUTH_LINK, "text-sm")}
        >
          {backup
            ? tr("Use the emailed code", "Email wala code istemal karein")
            : tr("Use a backup code", "Backup code istemal karein")}
        </button>

        {method === "EMAIL" && !backup && (
          <ResendControl
            remaining={resend.remaining}
            total={RESEND_WAIT}
            busy={resending}
            label={tr("Send it again", "Dobara bhejein")}
            waitingLabel={(seconds) =>
              tr(`Send it again in ${seconds}s`, `${seconds}s baad dobara bhejein`)
            }
            onResend={() => void onResend()}
          />
        )}
      </div>

      <p className="mt-6 text-center text-sm text-muted">
        <Link href="/login" className={AUTH_LINK}>
          {tr("Back to sign in", "Login par wapas")}
        </Link>
      </p>
    </motion.div>
  );
}

export default function TwoFactorPage() {
  return (
    <AuthPanel>
      <Suspense fallback={<Loading />}>
        <TwoFactorForm />
      </Suspense>
    </AuthPanel>
  );
}
