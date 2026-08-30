"use client";

/**
 * Registration — for patients, and now for doctors applying to join.
 *
 * The endpoint creates the account but issues no session, deliberately: an
 * address has to be proved before it can receive anything, so the next screen
 * is always the code we just emailed rather than a dashboard.
 *
 * The role tab here is real — unlike the one on the sign-in screen it *is*
 * sent — but it grants nothing. `DOCTOR` creates an application, not a doctor;
 * an administrator is still what turns it into one. That is why the doctor tab
 * asks for less rather than more: the credentials, the registration number and
 * the certificates all belong in the review that follows, not in a signup form
 * that anyone can fill in.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import { AuthPanel } from "@/components/AuthPanel";
import { Icon } from "@/components/Icon";
import {
  AUTH_LINK,
  AuthHeading,
  AuthNotice,
  IconBadge,
  PasswordField,
  PhoneField,
} from "@/components/auth/parts";
import { PasswordStrength, Segmented, strengthOf } from "@/components/forms";
import { Button, Checkbox, Field, Input } from "@/components/ui";
import { ApiError, auth } from "@/lib/api";
import { useTr } from "@/lib/lang";

type Role = "PATIENT" | "DOCTOR";

export default function RegisterPage() {
  const router = useRouter();
  const tr = useTr();

  const [role, setRole] = useState<Role>("PATIENT");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [accepted, setAccepted] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [blocked, setBlocked] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const mismatch = confirm.length > 0 && confirm !== password;

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (mismatch) return;
    if (!accepted) {
      setBlocked(
        tr(
          "Please agree to the terms before creating your account.",
          "Account banane se pehle shara-it se ittefaq karein.",
        ),
      );
      return;
    }

    setBlocked(null);
    setSubmitting(true);
    setError(null);
    try {
      const digits = phone.replace(/^0+/, "");
      await auth.register({
        name: name.trim(),
        email: email.trim(),
        password,
        role,
        // Only patients are asked for a number, and a blank one is left out
        // entirely rather than sent as an empty string.
        ...(role === "PATIENT" && digits ? { phone: `+92${digits}` } : {}),
      });
      router.replace(`/verify-email?email=${encodeURIComponent(email.trim())}`);
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
      <div className="w-full">
        <AuthHeading
          badge={<IconBadge name="person_add" />}
          title={tr("Create your account", "Apna account banayein")}
          subtitle={
            role === "PATIENT"
              ? tr("Then we verify your email.", "Phir email tasdeeq karte hain.")
              : tr(
                  "Name, email, a password — nothing else.",
                  "Naam, email aur ek password — bas itna hi.",
                )
          }
        />

        <Segmented<Role>
          className="mb-5 w-full"
          label={tr("Account type", "Account ki qisam")}
          value={role}
          onChange={(next) => {
            setRole(next);
            setBlocked(null);
          }}
          options={[
            { value: "PATIENT", label: tr("Patient", "Mareez"), icon: "person" },
            { value: "DOCTOR", label: tr("Doctor", "Doctor"), icon: "stethoscope" },
          ]}
        />

        {role === "DOCTOR" && (
          <AuthNotice
            tone="info"
            live="status"
            icon="how_to_reg"
            title={tr("An administrator approves doctor accounts", "Doctor ke account ko intezamia manzoor karti hai")}
          >
            {tr(
              "Registration number, documents and availability come afterwards.",
              "Registration number, dastavezaat aur availability baad mein.",
            )}
          </AuthNotice>
        )}

        {error && (
          <AuthNotice tone="critical">{error.message}</AuthNotice>
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

          {role === "PATIENT" && (
            <PhoneField
              id="phone"
              label={tr("Phone (optional)", "Phone (ikhtiyari)")}
              hint={tr("Without the leading zero.", "Shuru ke sifar ke baghair.")}
              value={phone}
              onChange={setPhone}
              error={error?.fieldError("phone")}
            />
          )}

          <div className="space-y-2">
            <PasswordField
              id="password"
              label={tr("Password", "Password")}
              autoComplete="new-password"
              value={password}
              onChange={setPassword}
              error={error?.fieldError("password")}
              // The server's own rule, word for word. It said eight and the
              // server refused fewer than ten, so anyone who did exactly as
              // they were told was rejected for it.
              hint={tr(
                "10+ characters, with a capital, a small letter and a number.",
                "10+ huroof, ek bara, ek chhota aur ek number.",
              )}
            />
            {password && (
              <PasswordStrength
                value={password}
                labels={[
                  // Zero now means the server would refuse it, so the word
                  // says that rather than grading it.
                  tr("Not enough", "Kaafi nahi"),
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

          <Checkbox
            checked={accepted}
            onChange={(event) => {
              setAccepted(event.target.checked);
              if (event.target.checked) setBlocked(null);
            }}
            label={tr(
              "MediSense may store my health information to provide my care.",
              "MediSense meri sehat ki maloomat ilaj ke liye mehfooz rakh sakta hai.",
            )}
          />

          {blocked && (
            <p role="alert" className="pop-in px-1 text-sm font-medium text-critical">
              {blocked}
            </p>
          )}

          <Button
            type="submit"
            size="lg"
            className="btn-shine w-full"
            loading={submitting}
            disabled={mismatch || strengthOf(password) === 0}
          >
            {submitting
              ? tr("Creating your account…", "Account ban raha hai…")
              : tr("Create account", "Account banayein")}
            {!submitting && <Icon name="arrow_forward" className="text-[20px]" />}
          </Button>
        </form>

        <p className="mt-6 text-center text-sm text-muted">
          {tr("Already have an account?", "Pehle se account hai?")}{" "}
          <Link href="/login" className={AUTH_LINK}>
            {tr("Sign in", "Login karein")}
          </Link>
        </p>

        <p className="mt-4 flex items-start gap-2 text-xs leading-relaxed text-faint">
          <Icon name="shield_person" className="mt-px shrink-0 text-[16px]" />
          {role === "PATIENT"
            ? tr(
                "Only your clinicians can read your record. Every access is logged.",
                "Record sirf aap ke doctor parh sakte hain. Har rasai darj hoti hai.",
              )
            : tr(
                "Administrator accounts are created by the hospital, never here.",
                "Intezamia ke accounts hospital banata hai, yahan se kabhi nahi.",
              )}
        </p>
      </div>
    </AuthPanel>
  );
}
