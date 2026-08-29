"use client";

import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { Suspense, useEffect, useState, type FormEvent } from "react";

import { AuthPanel } from "@/components/AuthPanel";
import { Button, Field, Input, Loading } from "@/components/ui";
import { ApiError, type DeviceClass } from "@/lib/api";
import { useTr } from "@/lib/lang";
import { homePathFor, useSession, useStoredDeviceClass } from "@/lib/session";

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const { signIn, user, loading } = useSession();
  const tr = useTr();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<ApiError | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // The remembered choice comes from an external store, so it needs no effect;
  // an explicit pick in the form overrides it.
  const remembered = useStoredDeviceClass();
  const [chosen, setChosen] = useState<DeviceClass | null>(null);
  const deviceClass = chosen ?? remembered;

  const reason = params.get("reason");
  const reasons: Record<string, string> = {
    expired: tr(
      "You were signed out after a period of inactivity. Sign in again to continue.",
      "Ghair-faal rehne ki wajah se aap sign out ho gaye the. Jari rakhne ke liye dobara login karein.",
    ),
    "signed-out": tr(
      "Your session ended. Sign in again to continue.",
      "Aap ka session khatam ho gaya. Jari rakhne ke liye dobara login karein.",
    ),
    registered: tr(
      "Your account is ready. Sign in to continue.",
      "Aap ka account tayyar hai. Jari rakhne ke liye login karein.",
    ),
  };

  // Already signed in — do not show the form again.
  useEffect(() => {
    if (!loading && user) router.replace(homePathFor(user.role));
  }, [user, loading, router]);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const signedIn = await signIn(email, password, deviceClass);
      router.replace(homePathFor(signedIn.role));
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

  if (loading) return <Loading label={tr("Checking your session", "Session check ho raha hai")} />;

  return (
    <div className="w-full max-w-md">
      <div className="mb-8">
        <h1 className="font-display text-3xl font-bold text-strong">
          {tr("Welcome back", "Khush aamdeed")}
        </h1>
        <p className="mt-1.5 text-muted">
          {tr("Sign in to your account.", "Apne account mein login karein.")}
        </p>
      </div>

      {reason && reasons[reason] && (
        <p
          role="status"
          className="mb-5 rounded-lg border border-warning/50 bg-warning-soft px-4 py-3 text-sm text-warning"
        >
          {reasons[reason]}
        </p>
      )}

      {error && (
        <p
          role="alert"
          className="mb-5 rounded-lg border border-critical/50 bg-critical-soft px-4 py-3 text-sm font-medium text-critical"
        >
          {error.message}
        </p>
      )}

      <form onSubmit={onSubmit} className="space-y-5" noValidate>
        <Field label={tr("Email", "Email")} htmlFor="email" error={error?.fieldError("email")}>
          <Input
            id="email"
            name="email"
            type="email"
            autoComplete="username"
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
        >
          <Input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            invalid={Boolean(error?.fieldError("password"))}
          />
        </Field>

        <Field
          label={tr("Where are you signing in from?", "Aap kahan se login kar rahe hain?")}
          htmlFor="deviceClass"
          hint={
            deviceClass === "SHARED_TERMINAL"
              ? tr(
                  "Shared terminals sign out after 2 minutes of inactivity.",
                  "Mushtarka terminals 2 minute ki khamoshi ke baad sign out ho jate hain.",
                )
              : tr(
                  "Your own device stays signed in for 15 minutes of inactivity.",
                  "Apna device 15 minute ki khamoshi tak signed in rehta hai.",
                )
          }
        >
          <select
            id="deviceClass"
            value={deviceClass}
            onChange={(event) => setChosen(event.target.value as DeviceClass)}
            className="block min-h-11 w-full rounded-lg border border-line-strong bg-card px-3 py-2.5 text-base text-strong focus:outline-2 focus:outline-primary"
          >
            <option value="PERSONAL">{tr("My own device", "Mera apna device")}</option>
            <option value="SHARED_TERMINAL">
              {tr("A shared hospital terminal", "Hospital ka mushtarka computer")}
            </option>
          </select>
        </Field>

        <Button type="submit" size="lg" className="w-full" disabled={submitting}>
          {submitting ? tr("Signing in…", "Login ho raha hai…") : tr("Sign in", "Login karein")}
        </Button>
      </form>

      <p className="mt-6 text-sm text-muted">
        {tr("New patient?", "Naye mareez hain?")}{" "}
        <Link
          href="/register"
          className="font-semibold text-primary underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
        >
          {tr("Create an account", "Account banayein")}
        </Link>
      </p>
    </div>
  );
}

export default function LoginPage() {
  return (
    <AuthPanel>
      <Suspense fallback={<Loading />}>
        <LoginForm />
      </Suspense>
    </AuthPanel>
  );
}
