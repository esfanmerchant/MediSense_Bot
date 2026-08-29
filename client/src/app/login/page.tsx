"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState, type FormEvent } from "react";

import { ApiError, type DeviceClass } from "@/lib/api";
import { homePathFor, useSession, useStoredDeviceClass } from "@/lib/session";
import { Button, Field, Input, Loading } from "@/components/ui";

const REASONS: Record<string, string> = {
  expired: "You were signed out after a period of inactivity. Sign in again to continue.",
    "signed-out":"Your session ended. Sign in again to continue.",
};

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const { signIn, user, loading } = useSession();

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

  if (loading) return <Loading label="Checking your session" />;

  return (
    <div className="w-full max-w-md">
      <div className="mb-8">
        <h1 className="text-3xl font-semibold text-strong">MediSense</h1>
        <p className="mt-1 text-muted">
          Sign in to your account.
        </p>
      </div>

      {reason && REASONS[reason] && (
        <p
          role="status"
          className="mb-5 rounded-md border border-warning/50 bg-warning-soft px-4 py-3 text-sm text-warning"
        >
          {REASONS[reason]}
        </p>
      )}

      {error && (
        <p
          role="alert"
          className="mb-5 rounded-md border border-critical/50 bg-critical-soft px-4 py-3 text-sm font-medium text-critical"
        >
          {error.message}
        </p>
      )}

      <form onSubmit={onSubmit} className="space-y-5" noValidate>
        <Field label="Email" htmlFor="email" error={error?.fieldError("email")}>
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

        <Field label="Password" htmlFor="password" error={error?.fieldError("password")}>
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
          label="Where are you signing in from?"
          htmlFor="deviceClass"
          hint={
            deviceClass === "SHARED_TERMINAL"
              ? "Shared terminals sign out after 2 minutes of inactivity."
              : "Your own device stays signed in for 15 minutes of inactivity."
          }
        >
          <select
            id="deviceClass"
            value={deviceClass}
            onChange={(event) => setChosen(event.target.value as DeviceClass)}
            className="block min-h-11 w-full rounded-md border border-line-strong bg-card px-3 py-2.5 text-base text-strong focus:outline-2 focus:outline-primary"
          >
            <option value="PERSONAL">My own device</option>
            <option value="SHARED_TERMINAL">A shared hospital terminal</option>
          </select>
        </Field>

        <Button type="submit" size="lg" className="w-full" disabled={submitting}>
          {submitting ? "Signing in…" : "Sign in"}
        </Button>
      </form>

      <p className="mt-6 text-sm text-muted">
        New patient?{" "}
        <a
          href="/register"
          className="font-medium text-teal-800 underline underline-offset-2"
        >
          Create an account
        </a>
      </p>
    </div>
  );
}

export default function LoginPage() {
  return (
    <main id="main" className="flex min-h-screen items-center justify-center px-4 py-12">
      <Suspense fallback={<Loading />}>
        <LoginForm />
      </Suspense>
    </main>
  );
}
