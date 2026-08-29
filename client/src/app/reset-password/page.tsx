"use client";

/**
 * The second half of a password reset: the emailed link lands here with a
 * token in the query, and this screen trades it for a new password.
 *
 * A used or stale token is the normal case rather than the exception — links
 * sit in inboxes — so it gets a real state with the one action that helps,
 * instead of a generic failure. And the destination is the sign-in page rather
 * than a dashboard: setting a password does not sign anyone in, and a flow
 * that silently did would be a flow that hands the account to whoever had the
 * link.
 */

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState, type FormEvent } from "react";

import { AuthPanel } from "@/components/AuthPanel";
import { Icon } from "@/components/Icon";
import { AUTH_LINK, AuthHeading, AuthNotice, IconBadge, PasswordField } from "@/components/auth/parts";
import { PasswordStrength, strengthOf } from "@/components/forms";
import { Button, Loading } from "@/components/ui";
import { ApiError, auth } from "@/lib/api";
import { useTr } from "@/lib/lang";

/** Codes that mean "this link is no longer any good", whichever the API sends. */
const DEAD_LINK = new Set<ApiError["code"]>([
  "INVALID_CODE",
  "CODE_EXPIRED",
  "NOT_FOUND",
  "UNAUTHENTICATED",
]);

function ResetPasswordForm() {
  const router = useRouter();
  const params = useSearchParams();
  const tr = useTr();

  const token = params.get("token") ?? "";

  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<ApiError | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const mismatch = confirm.length > 0 && confirm !== password;
  const dead = !token || (error !== null && DEAD_LINK.has(error.code));

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (mismatch) return;
    setSubmitting(true);
    setError(null);
    try {
      await auth.resetPassword({ token, password });
      router.replace("/login?reason=reset");
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? caught
          : new ApiError("INTERNAL_ERROR", "Something went wrong. Try again.", 500),
      );
    } finally {
      setSubmitting(false);
    }
  }

  if (dead) {
    return (
      <div className="w-full">
        <AuthHeading
          badge={<IconBadge name="link_off" />}
          title={tr("This link no longer works", "Yeh link ab nahi chalta")}
          subtitle={tr(
            "Reset links expire, and each one can be used only once. Ask for a fresh one and it will arrive in a moment.",
            "Reset link khatam ho jate hain aur sirf ek baar chalte hain. Naya mangwayein, foran aa jayega.",
          )}
        />
        <Link
          href="/forgot-password"
          className="btn-gradient btn-shine focus-visible:outline-primary flex min-h-14 w-full items-center justify-center gap-2 rounded-xl px-6 text-lg font-semibold text-white focus-visible:outline-2 focus-visible:outline-offset-2"
        >
          {tr("Send a new link", "Naya link bhejein")}
          <Icon name="arrow_forward" className="text-[20px]" />
        </Link>
        <p className="mt-6 text-center text-sm text-muted">
          <Link href="/login" className={AUTH_LINK}>
            {tr("Back to sign in", "Login par wapas")}
          </Link>
        </p>
      </div>
    );
  }

  return (
    <div className="w-full">
      <AuthHeading
        badge={<IconBadge name="password" />}
        title={tr("Set a new password", "Naya password rakhein")}
        subtitle={tr(
          "Choose something you have not used here before.",
          "Aisa password chunein jo pehle yahan istemal na kiya ho.",
        )}
      />

      {error && <AuthNotice tone="critical">{error.message}</AuthNotice>}

      <form onSubmit={onSubmit} className="space-y-5" noValidate>
        <div className="space-y-2">
          <PasswordField
            id="password"
            label={tr("New password", "Naya password")}
            autoComplete="new-password"
            autoFocus
            value={password}
            onChange={setPassword}
            error={error?.fieldError("password")}
            hint={tr(
              "At least 8 characters, with letters and a number.",
              "Kam az kam 8 huroof — letters aur ek number ke saath.",
            )}
          />
          {password && (
            <PasswordStrength
              value={password}
              labels={[
                tr("Weak", "Kamzor"),
                tr("Fair", "Theek-thaak"),
                tr("Good", "Achha"),
                tr("Strong", "Mazboot"),
              ]}
            />
          )}
        </div>

        <PasswordField
          id="confirm"
          label={tr("Confirm password", "Password dobara likhein")}
          autoComplete="new-password"
          value={confirm}
          onChange={setConfirm}
          error={
            mismatch
              ? tr("The two passwords do not match.", "Dono password aik jaise nahi hain.")
              : undefined
          }
        />

        <Button
          type="submit"
          size="lg"
          className="btn-shine w-full"
          loading={submitting}
          disabled={mismatch || strengthOf(password) === 0 || confirm.length === 0}
        >
          {tr("Save the new password", "Naya password mehfooz karein")}
          <Icon name="arrow_forward" className="text-[20px]" />
        </Button>
      </form>

      <p className="mt-6 text-center text-sm text-muted">
        <Link href="/login" className={AUTH_LINK}>
          {tr("Back to sign in", "Login par wapas")}
        </Link>
      </p>
    </div>
  );
}

export default function ResetPasswordPage() {
  return (
    <AuthPanel>
      <Suspense fallback={<Loading />}>
        <ResetPasswordForm />
      </Suspense>
    </AuthPanel>
  );
}
