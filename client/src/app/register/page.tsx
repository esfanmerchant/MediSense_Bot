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
      <div className="w-full max-w-md">
        <div className="mb-8">
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
            className="mb-5 rounded-lg border border-critical/50 bg-critical-soft px-4 py-3 text-sm font-medium text-critical"
          >
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
              type="password"
              autoComplete="new-password"
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              invalid={Boolean(error?.fieldError("password"))}
            />
          </Field>

          <Button type="submit" size="lg" className="w-full" disabled={submitting} loading={submitting}>
            {submitting ? tr("Creating your account…", "Account ban raha hai…")
              : tr("Create account", "Account banayein")}
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

        <p className="mt-4 text-xs leading-relaxed text-faint">
          {tr(
            "Patient accounts only. Doctors and administrators are added by the hospital.",
            "Sirf mareez ka account. Doctors aur intezamia hospital ki taraf se shamil kiye jate hain.",
          )}
        </p>
      </div>
    </AuthPanel>
  );
}
