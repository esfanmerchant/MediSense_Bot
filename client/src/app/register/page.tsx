"use client";

/**
 * Patient registration — the page the landing CTA pointed at before it existed.
 *
 * The API's register endpoint creates the account but issues no session, so the
 * flow is register → sign in with the same credentials → straight to the
 * dashboard. If the automatic sign-in fails for any reason, the account still
 * exists — the fallback is the login page with an honest "your account is
 * ready" notice, never a dead end.
 *
 * Only patients self-register. Doctors and administrators are created by an
 * administrator, because a role is a grant, not a checkbox on a signup form.
 */

import { useRouter } from "next/navigation";
import Link from "next/link";
import { useState, type FormEvent } from "react";

import { AuthPanel } from "@/components/AuthPanel";
import { Icon } from "@/components/Icon";
import { Button, Field, Input } from "@/components/ui";
import { ApiError, apiRequest } from "@/lib/api";
import { useTr } from "@/lib/lang";
import { homePathFor, useSession } from "@/lib/session";

export default function RegisterPage() {
  const router = useRouter();
  const { signIn } = useSession();
  const tr = useTr();

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await apiRequest("/auth/register", {
        method: "POST",
        body: { name: name.trim(), email: email.trim(), password },
      });
      try {
        const signedIn = await signIn(email.trim(), password, "PERSONAL");
        router.replace(homePathFor(signedIn.role));
      } catch {
        // The account exists; only the automatic sign-in failed.
        router.replace("/login?reason=registered");
      }
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

  return (
    <AuthPanel>
      <div className="page-enter w-full max-w-md">
        <div className="mb-7">
          <span
            aria-hidden
            className="bg-gradient-brand mb-4 grid h-12 w-12 place-items-center rounded-2xl text-white shadow-md"
          >
            <Icon name="person_add" filled className="text-[24px]" />
          </span>
          <h1 className="font-display text-3xl font-bold text-strong">
            {tr("Create your account", "Apna account banayein")}
          </h1>
          <p className="mt-1.5 text-muted">
            {tr(
              "Name, email, a password — nothing else.",
              "Naam, email aur ek password — bas itna hi.",
            )}
          </p>
        </div>

        {error && (
          <p
            role="alert"
            className="pop-in mb-5 flex items-start gap-2 rounded-xl border border-critical/50 bg-critical-soft px-4 py-3 text-sm font-medium text-critical"
          >
            <Icon name="error" className="mt-px shrink-0 text-[18px]" />
            {error.message}
          </p>
        )}

        <form onSubmit={onSubmit} className="space-y-5" noValidate>
          <Field
            label={tr("Full name", "Poora naam")}
            htmlFor="name"
            error={error?.fieldError("name")}
          >
            <Input
              id="name"
              name="name"
              autoComplete="name"
              required
              value={name}
              onChange={(event) => setName(event.target.value)}
              invalid={Boolean(error?.fieldError("name"))}
            />
          </Field>

          <Field label={tr("Email", "Email")} htmlFor="email" error={error?.fieldError("email")}>
            <Input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              invalid={Boolean(error?.fieldError("email"))}
            />
          </Field>

          <Field
            label={tr("Password", "Password")}
            htmlFor="password"
            error={error?.fieldError("password")}
            hint={tr(
              "At least 8 characters, with letters and a number.",
              "Kam az kam 8 huroof — letters aur ek number ke saath.",
            )}
          >
            <Input
              id="password"
              name="password"
              type={showPassword ? "text" : "password"}
              autoComplete="new-password"
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              invalid={Boolean(error?.fieldError("password"))}
              className="pr-12"
            />
            <button
              type="button"
              aria-label={showPassword ? tr("Hide password", "Password chhupayein") : tr("Show password", "Password dikhayein")}
              aria-pressed={showPassword}
              onClick={() => setShowPassword((current) => !current)}
              className="absolute right-2 top-1/2 grid h-9 w-9 -translate-y-1/2 place-items-center rounded-lg text-muted transition-colors hover:bg-sunken hover:text-strong focus-visible:outline-2 focus-visible:outline-primary"
            >
              <Icon name={showPassword ? "visibility_off" : "visibility"} className="text-[20px]" />
            </button>
          </Field>

          <Button type="submit" size="lg" className="w-full" disabled={submitting} loading={submitting}>
            {submitting ? tr("Creating your account…", "Account ban raha hai…")
              : tr("Create account", "Account banayein")}
            {!submitting && <Icon name="arrow_forward" className="text-[20px]" />}
          </Button>
        </form>

        <p className="mt-6 text-sm text-muted">
          {tr("Already have an account?", "Pehle se account hai?")}{" "}
          <Link
            href="/login"
            className="font-semibold text-primary underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
          >
            {tr("Sign in", "Login karein")}
          </Link>
        </p>

        <p className="mt-4 flex items-start gap-2 text-xs leading-relaxed text-faint">
          <Icon name="shield_person" className="mt-px shrink-0 text-[16px]" />
          {tr(
            "Patient accounts only. Doctors and administrators are added by the hospital.",
            "Sirf mareez ka account. Doctors aur intezamia hospital ki taraf se shamil kiye jate hain.",
          )}
        </p>
      </div>
    </AuthPanel>
  );
}
