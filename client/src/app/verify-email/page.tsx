"use client";

/**
 * Proving the address.
 *
 * The account already exists by the time anyone arrives here; what does not
 * exist yet is any evidence that the person typing owns the inbox. So this is
 * the one screen in the sign-up flow with no way around it, and the whole job
 * is to make the only path through it short: the code auto-submits on the
 * sixth digit, the clock says out loud how long it is still good for, and the
 * two failures that actually happen — a wrong code and a stale one — are told
 * apart, because "try again" and "ask for a new one" are different actions.
 */

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";

import { AuthPanel } from "@/components/AuthPanel";
import { Icon } from "@/components/Icon";
import { AUTH_LINK, AuthHeading, AuthNotice, MarkBadge } from "@/components/auth/parts";
import { ResendControl, formatClock, useCountdown } from "@/components/auth/timers";
import { OtpInput, SuccessPanel } from "@/components/forms";
import { useToast } from "@/components/overlays";
import { Button, Loading } from "@/components/ui";
import { ApiError, auth } from "@/lib/api";
import { useTr } from "@/lib/lang";
import { useSession } from "@/lib/session";

/** How long a code lives, and how long before another may be asked for. */
const CODE_LIFETIME = 600;
const RESEND_WAIT = 60;

function VerifyEmailForm() {
  const router = useRouter();
  const params = useSearchParams();
  const toast = useToast();
  const { adoptSession } = useSession();
  const tr = useTr();

  const email = params.get("email") ?? "";

  const [code, setCode] = useState("");
  const [error, setError] = useState<ApiError | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [resending, setResending] = useState(false);
  const [done, setDone] = useState<{ redirectTo: string } | null>(null);

  const life = useCountdown(CODE_LIFETIME);
  const resend = useCountdown(RESEND_WAIT);

  // The mark draws itself, and only then does the app move — a verification
  // that vanishes the instant it succeeds never actually says that it did.
  useEffect(() => {
    if (!done) return;
    const id = window.setTimeout(() => {
      toast.show({
        title: tr("Email verified — welcome!", "Email tasdeeq ho gayi — khush aamdeed!"),
      });
      router.replace(done.redirectTo);
    }, 1100);
    return () => window.clearTimeout(id);
  }, [done, router, toast, tr]);

  if (!email) {
    return (
      <div className="w-full">
        <AuthHeading
          badge={<MarkBadge />}
          title={tr(
            "Which address should we verify?",
            "Kaunsi email tasdeeq karni hai?",
          )}
          subtitle={tr(
            "This page needs to know the address the code was sent to. Sign in, or create your account again.",
            "Is safhe ko wo pata chahiye jahan code gaya tha. Login karein, ya account dobara banayein.",
          )}
        />
        <div className="flex flex-col gap-3">
          <Link
            href="/login"
            className="btn-gradient btn-shine flex min-h-14 w-full items-center justify-center gap-2 rounded-xl px-6 text-lg font-semibold text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
          >
            {tr("Back to sign in", "Login par wapas")}
            <Icon name="arrow_forward" className="text-[20px]" />
          </Link>
          <p className="text-center text-sm text-muted">
            <Link href="/register" className={AUTH_LINK}>
              {tr("Create an account", "Account banayein")}
            </Link>
          </p>
        </div>
      </div>
    );
  }

  async function submit(value: string) {
    if (value.length < 6 || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await auth.verifyEmail({ email, code: value });
      adoptSession(result.user, result.session);
      setDone({ redirectTo: result.redirectTo });
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? caught
          : new ApiError("INTERNAL_ERROR", "Something went wrong. Try again.", 500),
      );
      setCode("");
      // A new key remounts the boxes, which replays the shake and puts the
      // caret back in the first one.
      setAttempt((current) => current + 1);
    } finally {
      setSubmitting(false);
    }
  }

  async function onResend() {
    setResending(true);
    setError(null);
    try {
      const result = await auth.resendCode({ email });
      resend.restart(result.resendAfterSeconds || RESEND_WAIT);
      life.restart(CODE_LIFETIME);
      setCode("");
      setAttempt((current) => current + 1);
    } catch (caught) {
      if (caught instanceof ApiError) {
        setError(caught);
        resend.restart(RESEND_WAIT);
      }
    } finally {
      setResending(false);
    }
  }

  if (done) {
    return (
      <SuccessPanel
        title={tr("Email verified", "Email tasdeeq ho gayi")}
        description={tr("Taking you to your dashboard…", "Aap ko dashboard par le ja rahe hain…")}
      />
    );
  }

  const wrongCode = error?.code === "INVALID_CODE";
  const staleCode = error?.code === "CODE_EXPIRED" || life.remaining <= 0;

  return (
    <div className="w-full">
      <AuthHeading
        badge={<MarkBadge />}
        title={tr("Verify your email", "Apni email tasdeeq karein")}
        subtitle={
          <>
            {tr("We sent a six-digit code to", "Hum ne chhe hindson ka code bheja hai")}{" "}
            <span className="font-semibold text-strong">{email}</span>
          </>
        }
      />

      {wrongCode && (
        <AuthNotice tone="critical" title={tr("That code is not right", "Yeh code sahih nahi hai")}>
          {tr(
            "Check the six digits in the email and type them again.",
            "Email mein diye chhe hindse dobara dekh kar likhein.",
          )}
        </AuthNotice>
      )}

      {staleCode && !wrongCode && (
        <AuthNotice
          tone="warning"
          title={tr("That code has expired", "Yeh code khatam ho chuka hai")}
        >
          {tr(
            "Codes last ten minutes. Send yourself a new one below.",
            "Code das minute chalta hai. Neeche se naya code mangwayein.",
          )}
        </AuthNotice>
      )}

      {error && !wrongCode && error.code !== "CODE_EXPIRED" && (
        <AuthNotice tone="critical">{error.message}</AuthNotice>
      )}

      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit(code);
        }}
        className="space-y-6"
        noValidate
      >
        <OtpInput
          key={attempt}
          value={code}
          onChange={setCode}
          onComplete={(value) => void submit(value)}
          invalid={wrongCode}
          disabled={submitting}
          label={tr("Verification code", "Tasdeeqi code")}
        />

        {/* The ticking clock is not a live region — a screen reader counting
            down second by second would talk over everything else. Only the
            moment it runs out is worth announcing, which the span below does. */}
        <p className="flex items-center justify-center gap-1.5 text-center text-sm text-muted">
          <Icon name="schedule" className="text-[16px]" />
          {life.remaining > 0
            ? tr(
                `Code expires in ${formatClock(life.remaining)}`,
                `Code ${formatClock(life.remaining)} mein expire hoga`,
              )
            : tr("This code has expired", "Yeh code khatam ho chuka hai")}
        </p>
        <span role="status" className="sr-only">
          {life.remaining <= 0
            ? tr("This code has expired", "Yeh code khatam ho chuka hai")
            : ""}
        </span>

        <Button
          type="submit"
          size="lg"
          className="btn-shine w-full"
          loading={submitting}
          disabled={code.length < 6}
        >
          {tr("Verify email", "Email tasdeeq karein")}
          <Icon name="arrow_forward" className="text-[20px]" />
        </Button>
      </form>

      <div className="mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-5">
        <span className="text-sm text-muted">
          {tr("No code yet?", "Code nahi aaya?")}
        </span>
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
      </div>

      <p className="mt-6 text-center text-sm text-muted">
        {tr("Wrong address?", "Ghalat email?")}{" "}
        <Link href="/register" className={AUTH_LINK}>
          {tr("Start again", "Dobara shuru karein")}
        </Link>
      </p>
    </div>
  );
}

export default function VerifyEmailPage() {
  return (
    <AuthPanel>
      <Suspense fallback={<Loading />}>
        <VerifyEmailForm />
      </Suspense>
    </AuthPanel>
  );
}
