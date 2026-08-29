"use client";

/**
 * "I have forgotten my password."
 *
 * The whole design of this screen is one rule: the answer is the same whether
 * or not the address exists. A form that says "no account with that email" is
 * a free membership check — point it at a list of addresses and it tells you
 * which of them belong to patients of this hospital, which is a disclosure in
 * its own right before anybody's password is involved.
 *
 * So the confirmation is deliberately conditional in its wording, it is shown
 * on failure as well as success, and the only errors that ever surface are the
 * two that say nothing about the account: the network was unreachable, or the
 * request was rate-limited.
 */

import Link from "next/link";
import { useState, type FormEvent } from "react";

import { AuthPanel } from "@/components/AuthPanel";
import { Icon } from "@/components/Icon";
import { AUTH_LINK, AuthHeading, AuthNotice, IconBadge } from "@/components/auth/parts";
import { SuccessPanel } from "@/components/forms";
import { Button, Field, Input } from "@/components/ui";
import { ApiError, auth } from "@/lib/api";
import { useTr } from "@/lib/lang";

export default function ForgotPasswordPage() {
  const tr = useTr();

  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await auth.forgotPassword(email.trim());
      setSent(true);
    } catch (caught) {
      // Anything that could distinguish "no such account" from "sent" is
      // swallowed on purpose and lands on the same confirmation.
      if (
        caught instanceof ApiError &&
        (caught.code === "NETWORK_ERROR" || caught.code === "RATE_LIMITED")
      ) {
        setError(caught);
      } else {
        setSent(true);
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthPanel>
      <div className="w-full">
        {sent ? (
          <>
            <SuccessPanel
              title={tr("Check your inbox", "Apna inbox dekhein")}
              description={tr(
                "If an account exists for that address, we have sent it a link to set a new password. The link is good for one hour.",
                "Agar us pate ka account maujood hai to hum ne naya password banane ka link bhej diya hai. Link ek ghante tak chalega.",
              )}
            />
            <p className="mt-2 text-center text-sm text-muted">
              {tr("Nothing arrived?", "Kuchh nahi aaya?")}{" "}
              <button type="button" onClick={() => setSent(false)} className={AUTH_LINK}>
                {tr("Try another address", "Doosra pata azmayein")}
              </button>
            </p>
            <p className="mt-4 text-center text-sm text-muted">
              <Link href="/login" className={AUTH_LINK}>
                {tr("Back to sign in", "Login par wapas")}
              </Link>
            </p>
          </>
        ) : (
          <>
            <AuthHeading
              badge={<IconBadge name="lock_reset" />}
              title={tr("Reset your password", "Apna password reset karein")}
              subtitle={tr(
                "Give us the email on your account and we will send a link to set a new password.",
                "Apne account wali email likhein, hum naya password banane ka link bhej denge.",
              )}
            />

            {error?.code === "RATE_LIMITED" && (
              <AuthNotice tone="warning" title={tr("Too many attempts", "Bohat zyada koshishein")}>
                {tr(
                  "Wait a moment before asking for another link.",
                  "Dosra link mangne se pehle thora intezaar karein.",
                )}
              </AuthNotice>
            )}

            {error?.code === "NETWORK_ERROR" && (
              <AuthNotice tone="critical">{error.message}</AuthNotice>
            )}

            <form onSubmit={onSubmit} className="space-y-5" noValidate>
              <Field label={tr("Email", "Email")} htmlFor="email">
                <Input
                  id="email"
                  name="email"
                  type="email"
                  autoComplete="username"
                  required
                  autoFocus
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                />
              </Field>

              <Button
                type="submit"
                size="lg"
                className="btn-shine w-full"
                loading={submitting}
                disabled={email.trim().length === 0}
              >
                {tr("Send the link", "Link bhejein")}
                <Icon name="arrow_forward" className="text-[20px]" />
              </Button>
            </form>

            <p className="mt-6 text-center text-sm text-muted">
              {tr("Remembered it?", "Yaad aa gaya?")}{" "}
              <Link href="/login" className={AUTH_LINK}>
                {tr("Sign in", "Login karein")}
              </Link>
            </p>
          </>
        )}
      </div>
    </AuthPanel>
  );
}
