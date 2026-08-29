"use client";

import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { Suspense, useEffect, useState, type FormEvent } from "react";

import { AuthPanel } from "@/components/AuthPanel";
import { Icon } from "@/components/Icon";
import { Button, Field, Input, Loading, cx } from "@/components/ui";
import { ApiError, type DeviceClass } from "@/lib/api";
import { useTr } from "@/lib/lang";
import { homePathFor, useSession, useStoredDeviceClass } from "@/lib/session";

/**
 * Where the person is signing in from, as two cards rather than a dropdown.
 *
 * The choice changes how long the session survives inactivity (R8), which is
 * worth a glance at both options — a `<select>` hides the one not chosen, and
 * the shared-terminal case is exactly the one people forget to pick.
 */
function DeviceChoice({
  value,
  onChange,
}: {
  value: DeviceClass;
  onChange: (next: DeviceClass) => void;
}) {
  const tr = useTr();
  const options: { value: DeviceClass; icon: string; title: string; hint: string }[] = [
    {
      value: "PERSONAL",
      icon: "smartphone",
      title: tr("My own device", "Mera apna device"),
      hint: tr("Stays signed in for 15 min of inactivity", "15 minute ki khamoshi tak signed in"),
    },
    {
      value: "SHARED_TERMINAL",
      icon: "desktop_windows",
      title: tr("A shared hospital terminal", "Hospital ka mushtarka computer"),
      hint: tr("Signs out after 2 min of inactivity", "2 minute ki khamoshi ke baad sign out"),
    },
  ];

  return (
    <fieldset>
      <legend className="mb-1.5 block text-sm font-semibold text-strong">
        {tr("Where are you signing in from?", "Aap kahan se login kar rahe hain?")}
      </legend>
      <div className="grid gap-2 sm:grid-cols-2">
        {options.map((option) => {
          const active = option.value === value;
          return (
            <label
              key={option.value}
              className={cx(
                "flex cursor-pointer items-start gap-3 rounded-xl border p-3 transition-[border-color,background-color,box-shadow] has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-primary",
                active
                  ? "border-primary bg-primary-soft/60 shadow-sm"
                  : "border-line-strong bg-card hover:border-faint",
              )}
            >
              <input
                type="radio"
                name="deviceClass"
                value={option.value}
                checked={active}
                onChange={() => onChange(option.value)}
                className="sr-only"
              />
              <span
                aria-hidden
                className={cx(
                  "grid h-9 w-9 shrink-0 place-items-center rounded-lg",
                  active ? "bg-primary text-white" : "bg-sunken text-muted",
                )}
              >
                <Icon name={option.icon} filled={active} className="text-[20px]" />
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-semibold text-strong">{option.title}</span>
                <span className="block text-xs text-muted">{option.hint}</span>
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const { signIn, user, loading } = useSession();
  const tr = useTr();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
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
    <div className="w-full">
      <div className="mb-7">
        <span
          aria-hidden
          className="bg-gradient-brand mb-4 grid h-12 w-12 place-items-center rounded-2xl text-white shadow-md"
        >
          <Icon name="waving_hand" filled className="text-[24px]" />
        </span>
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
          className="pop-in mb-5 flex items-start gap-2 rounded-xl border border-warning/50 bg-warning-soft px-4 py-3 text-sm text-warning"
        >
          <Icon name="info" className="mt-px shrink-0 text-[18px]" />
          {reasons[reason]}
        </p>
      )}

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
            type={showPassword ? "text" : "password"}
            autoComplete="current-password"
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

        <DeviceChoice value={deviceClass} onChange={setChosen} />

        <Button type="submit" size="lg" className="w-full" loading={submitting}>
          {submitting ? tr("Signing in…", "Login ho raha hai…") : tr("Sign in", "Login karein")}
          {!submitting && <Icon name="arrow_forward" className="text-[20px]" />}
        </Button>
      </form>

      <p className="mt-6 text-center text-sm text-muted">
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
