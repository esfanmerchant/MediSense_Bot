"use client";

/**
 * Where a doctor waits.
 *
 * The screen exists because "your application is with an administrator" is a
 * real state that can last days, and a person in it deserves better than a
 * login that keeps refusing. So it answers the three questions someone in a
 * queue actually has: where is it, what happens next, and who do I ask.
 *
 * The rejected variant is the same page with the answer already given — the
 * reason, in full, and the way back into the form.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { Icon } from "@/components/Icon";
import { EcgLine } from "@/components/brand/EcgLine";
import { ContactAdminDialog } from "@/components/doctorApplication/ContactAdminDialog";
import { Button, ErrorState, Loading, Unauthorized, cx } from "@/components/ui";
import { doctorApplication } from "@/lib/api";
import { useTr } from "@/lib/lang";
import { useSession } from "@/lib/session";
import { useAsync } from "@/lib/useAsync";

import {
  RedirectNotice,
  SlimHeader,
  StatusChip,
  formatDateTime,
} from "@/components/doctorApplication/shared";

export default function DoctorPendingPage() {
  const tr = useTr();
  const router = useRouter();
  const { user, loading, signOut } = useSession();

  useEffect(() => {
    if (!loading && !user) router.replace("/login");
  }, [loading, user, router]);

  return (
    <div className="flex min-h-screen flex-col">
      <SlimHeader onSignOut={() => void signOut()} />
      {loading ? (
        <main className="mx-auto w-full max-w-2xl px-4 py-20">
          <Loading label={tr("Checking your session", "Aap ka session check ho raha hai")} />
        </main>
      ) : !user ? null : user.role !== "DOCTOR" ? (
        <main id="main" className="mx-auto w-full max-w-2xl px-4 py-16">
          <Unauthorized
            message={tr(
              "This page belongs to a doctor's application.",
              "Yeh safha doctor ki darkhwast ka hai.",
            )}
          />
        </main>
      ) : (
        <Status name={user.name} />
      )}
    </div>
  );
}

function Status({ name }: { name: string }) {
  const [writing, setWriting] = useState(false);
  const tr = useTr();
  const router = useRouter();
  const { signOut } = useSession();
  const application = useAsync(() => doctorApplication.mine(), []);
  const data = application.data;

  // Nothing has been sent yet: the form, not the waiting room.
  useEffect(() => {
    if (data?.status === "DRAFT") router.replace("/doctor/onboarding");
  }, [data?.status, router]);

  if (application.loading) {
    return (
      <main className="mx-auto w-full max-w-2xl px-4 py-20">
        <Loading label={tr("Checking your application", "Aap ki darkhwast dekhi ja rahi hai")} />
      </main>
    );
  }

  if (application.error) {
    return (
      <main id="main" className="mx-auto w-full max-w-2xl px-4 py-16">
        <ErrorState message={application.error.message} onRetry={application.reload} />
      </main>
    );
  }

  if (!data) return null;

  if (data.status === "DRAFT") {
    return (
      <RedirectNotice label={tr("Taking you to the form…", "Aap ko form par le ja rahe hain…")} />
    );
  }

  const rejected = data.status === "REJECTED";
  const approved = data.status === "APPROVED";
  const displayName = data.fullName?.trim() || name;

  return (
    <main id="main" className="mx-auto w-full max-w-3xl flex-1 px-4 py-10 sm:px-8">
      {/* Mounted once here rather than beside each button: both the rejected
          and the under-review branch open the same dialog. */}
      <ContactAdminDialog
        open={writing}
        onClose={() => setWriting(false)}
        registrationNumber={data.registrationNumber ?? null}
      />
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="mono-caps text-[0.68rem] text-accent">
            {tr("Doctor registration", "Doctor registration")}
          </p>
          <h1 className="mt-1.5 font-display text-[1.75rem] font-bold leading-tight text-strong">
            {rejected
              ? tr("Your application was not approved", "Aap ki darkhwast manzoor nahi hui")
              : approved
                ? tr("You are approved", "Aap manzoor ho gaye")
                : tr("Your application is with an administrator", "Aap ki darkhwast admin ke paas hai")}
          </h1>
        </div>
        <StatusChip status={data.status} />
      </header>

      {rejected ? (
        <section
          role="alert"
          className="mt-6 rounded-2xl border border-critical/40 bg-critical-soft p-6"
        >
          <div className="flex items-start gap-3">
            <Icon name="cancel" filled className="mt-0.5 shrink-0 text-[26px] text-critical" />
            <div className="min-w-0">
              <h2 className="font-display text-lg font-bold text-critical">
                {tr("Why it was refused", "Kyun manzoor nahi hui")}
              </h2>
              <p className="mt-2 text-[15px] leading-relaxed text-strong">
                {data.rejectionReason ??
                  tr("No reason was recorded.", "Koi wajah darj nahi ki gayi.")}
              </p>
              {data.reviewNotes && (
                <p className="mt-2 text-sm text-muted">{data.reviewNotes}</p>
              )}
              {data.reviewedAt && (
                <p className="mono-caps mt-3 text-[10px] text-faint">
                  {tr("Reviewed", "Review hui")} · {formatDateTime(data.reviewedAt)}
                </p>
              )}
            </div>
          </div>
          <div className="mt-6 flex flex-wrap gap-3">
            <Link
              href="/doctor/onboarding"
              className="btn-gradient inline-flex min-h-11 items-center gap-2 rounded-xl px-4 text-base font-semibold text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
            >
              <Icon name="restart_alt" className="text-[20px]" />
              {tr("Apply again", "Dobara apply karein")}
            </Link>
            <Button variant="secondary" onClick={() => setWriting(true)}>
              <Icon name="mail" className="text-[20px]" />
              {tr("Contact an administrator", "Admin se raabta karein")}
            </Button>
          </div>
        </section>
      ) : (
        <section className="border-gradient relative mt-6 overflow-hidden rounded-2xl shadow-card">
          <div aria-hidden className="bg-gradient-soft absolute inset-0" />
          <div className="relative p-6 sm:p-8">
            <ol className="timeline">
              <TimelineStep
                state="done"
                title={tr("Application sent", "Darkhwast bhej di gayi")}
                detail={
                  data.submittedAt
                    ? formatDateTime(data.submittedAt)
                    : tr("Sent", "Bhej di gayi")
                }
                body={tr(
                  "Everything you filled in is with us, documents included.",
                  "Aap ne jo kuchh bhara, documents samet, hamare paas aa gaya hai.",
                )}
              />
              <TimelineStep
                state={approved ? "done" : "current"}
                title={tr("Under review", "Zer-e-ghaur")}
                detail={
                  approved
                    ? data.reviewedAt
                      ? formatDateTime(data.reviewedAt)
                      : tr("Done", "Mukammal")
                    : tr("Happening now", "Abhi ho raha hai")
                }
                body={tr(
                  "An administrator opens each document and checks your registration number.",
                  "Admin har document kholta hai aur aap ka registration number check karta hai.",
                )}
              />
              <TimelineStep
                state={approved ? "done" : "todo"}
                title={tr("Approved", "Manzoori")}
                detail={
                  approved
                    ? tr("You can sign in", "Aap sign in kar sakte hain")
                    : tr("Waiting", "Intezar")
                }
                body={tr(
                  "You get an email, and your account opens straight into the doctor portal.",
                  "Aap ko email milegi, aur aap ka account seedha doctor portal mein khul jaye ga.",
                )}
                last
              />
            </ol>

            {approved && (
              <Link
                href="/doctor"
                className="btn-gradient mt-6 inline-flex min-h-11 items-center gap-2 rounded-xl px-4 text-base font-semibold text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
              >
                <Icon name="dashboard" className="text-[20px]" />
                {tr("Go to your dashboard", "Apne dashboard par jayein")}
              </Link>
            )}
          </div>
          <EcgLine className="opacity-60" height={28} loop={!approved} />
        </section>
      )}

      {!rejected && (
        <div className="mt-6 grid gap-4 sm:grid-cols-2">
          <div className="rounded-2xl border border-line bg-card p-5 shadow-card">
            <h2 className="flex items-center gap-2 font-display text-base font-bold text-strong">
              <Icon name="schedule" filled className="text-[20px] text-primary" />
              {tr("What happens next", "Aage kya hoga")}
            </h2>
            <ul className="mt-3 space-y-2 text-sm text-muted">
              <li className="flex gap-2">
                <Icon name="check" className="mt-0.5 shrink-0 text-[16px] text-accent" />
                {tr(
                  "Your documents are checked one by one.",
                  "Aap ke documents ek ek kar ke check hote hain.",
                )}
              </li>
              <li className="flex gap-2">
                <Icon name="check" className="mt-0.5 shrink-0 text-[16px] text-accent" />
                {tr(
                  "You are emailed either way — approved or not.",
                  "Manzoori ho ya na ho, aap ko email zaroor aayegi.",
                )}
              </li>
              <li className="flex gap-2">
                <Icon name="check" className="mt-0.5 shrink-0 text-[16px] text-accent" />
                {tr(
                  "You do not need to keep this page open.",
                  "Yeh safha khula rakhne ki zaroorat nahi.",
                )}
              </li>
            </ul>
          </div>

          <div className="rounded-2xl border border-line bg-card p-5 shadow-card">
            <h2 className="flex items-center gap-2 font-display text-base font-bold text-strong">
              <Icon name="support_agent" filled className="text-[20px] text-primary" />
              {tr("Something looks wrong?", "Kuchh ghalat lag raha hai?")}
            </h2>
            <p className="mt-2 text-sm text-muted">
              {tr(
                "Write to an administrator and quote your registration number.",
                "Admin ko likhein aur apna registration number zaroor likhein.",
              )}
            </p>
            {data.registrationNumber && (
              <p className="mt-3 font-mono text-sm text-strong">{data.registrationNumber}</p>
            )}
            <Button variant="secondary" className="mt-4" onClick={() => setWriting(true)}>
              <Icon name="mail" className="text-[20px]" />
              {tr("Contact admin", "Admin se raabta")}
            </Button>
          </div>
        </div>
      )}

      <div className="mt-8 flex flex-wrap items-center gap-3 border-t border-line pt-6">
        <p className="text-sm text-muted">
          {tr("Signed in as", "Signed in:")} <span className="font-semibold text-strong">{displayName}</span>
        </p>
        <Button variant="ghost" className="ml-auto" onClick={() => void signOut()}>
          <Icon name="logout" className="text-[20px]" />
          {tr("Sign out", "Sign out")}
        </Button>
      </div>
    </main>
  );
}

function TimelineStep({
  state,
  title,
  detail,
  body,
  last = false,
}: {
  state: "done" | "current" | "todo";
  title: string;
  detail: string;
  body: string;
  last?: boolean;
}) {
  return (
    <li className={cx("relative", last ? "pb-0" : "pb-7")}>
      <span
        aria-hidden
        className={cx(
          "timeline-node grid place-items-center",
          state === "done" && "bg-gradient-brand border-transparent",
          state === "current" && "is-accent pulse-dot-brand",
          state === "todo" && "border-line-strong",
        )}
      >
        {state === "done" && <Icon name="check" className="text-[12px] leading-none text-white" />}
      </span>
      <div className="min-w-0">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <h3
            className={cx(
              "font-display text-base font-bold",
              state === "todo" ? "text-faint" : "text-strong",
            )}
          >
            {title}
          </h3>
          <span className="font-mono text-[11px] text-muted">{detail}</span>
        </div>
        <p className={cx("mt-1 text-sm", state === "todo" ? "text-faint" : "text-muted")}>{body}</p>
      </div>
    </li>
  );
}
