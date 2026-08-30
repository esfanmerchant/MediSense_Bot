"use client";

/**
 * Sign in.
 *
 * Two decisions are worth naming. The first is that the role tabs are *copy*,
 * not data: the server decides what an account is from the account, and a role
 * a browser could assert would be a role a browser could claim. They change the
 * words and nothing else, and nothing on this page sends them.
 *
 * The second is that every refusal here is a door rather than a wall. An
 * unverified email, a doctor still awaiting approval, a half-finished profile —
 * each of those is a real state with a real next step, so each gets a banner
 * that carries the step instead of a sentence that ends the conversation.
 */

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState, type FormEvent } from "react";

import { AuthPanel } from "@/components/AuthPanel";
import { Icon } from "@/components/Icon";
import { AUTH_LINK, AuthHeading, AuthNotice, MarkBadge, PasswordField } from "@/components/auth/parts";
import { Segmented } from "@/components/forms";
import { Button, Field, Input, Loading, cx } from "@/components/ui";
import { ApiError, auth, type DeviceClass } from "@/lib/api";
import { useTr } from "@/lib/lang";
import { homePathFor, useSession, useStoredDeviceClass } from "@/lib/session";

/** Which words this visit gets. Never sent anywhere — see the note above. */
type Audience = "PATIENT" | "DOCTOR" | "ADMIN";

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
      <legend className="mb-2.5 block text-[15px] font-semibold text-strong">
        {tr("Where are you signing in from?", "Aap kahan se login kar rahe hain?")}
      </legend>
      <div className="grid gap-2">
        {options.map((option) => {
          const active = option.value === value;
          return (
            <label
              key={option.value}
              className={cx(
                "relative flex cursor-pointer items-start gap-3 rounded-xl p-3 transition-[border-color,background-color,box-shadow] has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-primary",
                active
                  ? "border-[1.5px] border-primary bg-primary-soft shadow-sm"
                  : "border-[1.5px] border-line-strong bg-card hover:border-faint",
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
                  active ? "bg-gradient-brand text-white shadow-sm" : "bg-sunken text-muted",
                )}
              >
                <Icon name={option.icon} filled={active} className="text-[20px]" />
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-semibold text-strong">{option.title}</span>
                <span className="block text-[12.5px] leading-snug text-muted">{option.hint}</span>
              </span>
              {active && (
                <span
                  aria-hidden
                  className="bg-gradient-brand pop-scale absolute -right-2 -top-2 grid h-5 w-5 place-items-center rounded-full text-white shadow-sm ring-2 ring-card"
                >
                  <Icon name="check" className="text-[13px]" />
                </span>
              )}
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

  const [audience, setAudience] = useState<Audience>("PATIENT");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<ApiError | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [resending, setResending] = useState(false);

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
    reset: tr(
      "Your password has been changed. Sign in with the new one.",
      "Aap ka password badal diya gaya hai. Naye password se login karein.",
    ),
  };

  const copy: Record<Audience, { subtitle: string; hint?: string }> = {
    PATIENT: {
      subtitle: tr("Sign in to your account.", "Apne account mein login karein."),
    },
    DOCTOR: {
      subtitle: tr("Sign in to your clinical dashboard.", "Apne clinical dashboard mein login karein."),
      hint: tr("You can only sign in once your account is approved.", "Account approval ke baad hi login hoga."),
    },
    ADMIN: {
      subtitle: tr("Sign in to the administration console.", "Intezamia console mein login karein."),
      hint: tr("Administrator accounts are created by the hospital.", "Intezamia ke accounts hospital banata hai."),
    },
  };

  // Already signed in — do not show the form again.
  useEffect(() => {
    if (!loading && user) router.replace(homePathFor(user.role));
  }, [user, loading, router]);

  /** The way out of `EMAIL_NOT_VERIFIED`: a fresh code, then the code screen. */
  async function sendVerificationCode() {
    setResending(true);
    try {
      await auth.resendCode({ email: email.trim() });
    } catch {
      // A refused resend is not a reason to strand anyone: an earlier code may
      // still be in the inbox, and the verify screen can ask for another.
    } finally {
      setResending(false);
      router.push(`/verify-email?email=${encodeURIComponent(email.trim())}`);
    }
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      // Note what is *not* here: the audience tabs. The account decides the role.
      const result = await signIn(email, password, deviceClass);
      if (result.requires2FA) {
        // Not a failure — the second factor is the rest of signing in.
        router.push(
          `/login/2fa?challenge=${encodeURIComponent(result.challengeId)}&method=${result.method}` +
            (deviceClass === "SHARED_TERMINAL" ? "&shared=1" : ""),
        );
        return;
      }
      // The server's answer, not the role's default: an unapproved doctor
      // goes to their application, not to a dashboard that refuses them.
      router.replace(result.redirectTo || homePathFor(result.user.role));
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
      <AuthHeading
        badge={<MarkBadge />}
        title={tr("Welcome back", "Khush aamdeed")}
        subtitle={copy[audience].subtitle}
      />

      <Segmented<Audience>
        className="mb-2 w-full"
        label={tr("Who is signing in", "Kaun login kar raha hai")}
        value={audience}
        onChange={setAudience}
        options={[
          { value: "PATIENT", label: tr("Patient", "Mareez"), icon: "person" },
          { value: "DOCTOR", label: tr("Doctor", "Doctor"), icon: "stethoscope" },
          { value: "ADMIN", label: tr("Admin", "Admin"), icon: "admin_panel_settings" },
        ]}
      />
      <p className="mb-5 min-h-[18px] px-1 text-[13px] leading-snug text-muted">{copy[audience].hint}</p>

      {reason && reasons[reason] && (
        <AuthNotice tone={reason === "reset" ? "success" : "warning"} live="status" icon="info">
          {reasons[reason]}
        </AuthNotice>
      )}

      {error?.code === "EMAIL_NOT_VERIFIED" && (
        <AuthNotice
          tone="warning"
          title={tr("This email is not verified yet", "Yeh email abhi tasdeeq nahi hui")}
          action={
            <Button type="button" variant="secondary" loading={resending} onClick={sendVerificationCode}>
              {tr("Send a code", "Code bhejein")}
            </Button>
          }
        >
          {tr(
            "We will send a fresh six-digit code to this address.",
            "Hum is pate par naya chhe hindson ka code bhejenge.",
          )}
        </AuthNotice>
      )}

      {(error?.code === "PENDING_APPROVAL" || error?.code === "APPLICATION_REJECTED") && (
        <AuthNotice
          tone={error.code === "PENDING_APPROVAL" ? "warning" : "critical"}
          title={
            error.code === "PENDING_APPROVAL"
              ? tr("Your application is still being reviewed", "Aap ki darkhwast abhi zer-e-ghaur hai")
              : tr("Your application was not approved", "Aap ki darkhwast manzoor nahi hui")
          }
          action={
            <Link href="/doctor/pending" className={cx(AUTH_LINK, "inline-flex items-center gap-1")}>
              {tr("See your application", "Apni darkhwast dekhein")}
              <Icon name="arrow_forward" className="text-[16px]" />
            </Link>
          }
        >
          {error.code === "PENDING_APPROVAL"
            ? tr(
                "An administrator has to approve the account before it can sign in.",
                "Login se pehle intezamia ko account manzoor karna hoga.",
              )
            : tr(
                "The reason, and what to do next, are on your application page.",
                "Wajah aur agla qadam aap ki darkhwast ke safhe par hai.",
              )}
        </AuthNotice>
      )}

      {error?.code === "PROFILE_INCOMPLETE" && (
        <AuthNotice
          tone="warning"
          title={tr("Your profile is not finished", "Aap ki profile mukammal nahi hui")}
          action={
            <Link
              href="/doctor/onboarding"
              className={cx(AUTH_LINK, "inline-flex items-center gap-1")}
            >
              {tr("Finish your profile", "Profile mukammal karein")}
              <Icon name="arrow_forward" className="text-[16px]" />
            </Link>
          }
        >
          {tr(
            "Fill in the remaining details and the account goes for approval.",
            "Baqi tafseelat bhar dein, phir account manzoori ke liye chala jayega.",
          )}
        </AuthNotice>
      )}

      {error?.code === "ACCOUNT_LOCKED" && (
        <AuthNotice tone="critical" title={tr("This account is locked", "Yeh account band hai")}>
          {tr(
            "Too many failed attempts. Contact the hospital to have it unlocked.",
            "Bohat zyada nakaam koshishein. Khulwane ke liye hospital se rabta karein.",
          )}
        </AuthNotice>
      )}

      {error?.code === "RATE_LIMITED" && (
        <AuthNotice tone="warning" title={tr("Too many attempts", "Bohat zyada koshishein")}>
          {tr("Wait a moment and try again.", "Thora intezaar karein aur dobara koshish karein.")}
        </AuthNotice>
      )}

      {error?.code === "INVALID_CREDENTIALS" && (
        <AuthNotice tone="critical">
          {tr(
            "That email and password do not match an account.",
            "Yeh email aur password kisi account se nahi milte.",
          )}
        </AuthNotice>
      )}

      {error && !HANDLED.has(error.code) && <AuthNotice tone="critical">{error.message}</AuthNotice>}

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

        <div className="space-y-1.5">
          <PasswordField
            id="password"
            label={tr("Password", "Password")}
            value={password}
            onChange={setPassword}
            error={error?.fieldError("password")}
          />
          <p className="text-right">
            <Link href="/forgot-password" className={cx(AUTH_LINK, "text-sm")}>
              {tr("Forgot your password?", "Password bhool gaye?")}
            </Link>
          </p>
        </div>

        <DeviceChoice value={deviceClass} onChange={setChosen} />

        <Button type="submit" size="lg" className="btn-shine w-full" loading={submitting}>
          {submitting ? tr("Signing in…", "Login ho raha hai…") : tr("Sign in", "Login karein")}
          {!submitting && <Icon name="arrow_forward" className="text-[20px]" />}
        </Button>
      </form>

      <p className="mt-7 border-t border-line pt-5 text-center text-sm text-muted">
        {tr("New patient?", "Naye mareez hain?")}{" "}
        <Link href="/register" className={AUTH_LINK}>
          {tr("Create an account", "Account banayein")}
        </Link>
      </p>
    </div>
  );
}

/** Codes that get their own banner above; anything else falls back to the
    server's own message rather than being silently swallowed. */
const HANDLED = new Set<ApiError["code"]>([
  "EMAIL_NOT_VERIFIED",
  "PENDING_APPROVAL",
  "APPLICATION_REJECTED",
  "PROFILE_INCOMPLETE",
  "ACCOUNT_LOCKED",
  "RATE_LIMITED",
  "INVALID_CREDENTIALS",
]);

export default function LoginPage() {
  return (
    <AuthPanel>
      <Suspense fallback={<Loading />}>
        <LoginForm />
      </Suspense>
    </AuthPanel>
  );
}
