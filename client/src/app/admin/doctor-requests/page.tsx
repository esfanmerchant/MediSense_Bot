"use client";

/**
 * The administrator's queue of doctors asking to join.
 *
 * Three tabs rather than one list with a filter, because the three are three
 * different jobs: pending is work, approved is a record, rejected is a record
 * with a reason attached. Each tab fetches its own status, so a queue of four
 * never has to carry a year of decisions behind it.
 *
 * A decided row leaves the pending tab the way it leaves the queue — it slides
 * out, rather than blinking away, so the reviewer sees which one they just
 * finished with.
 */

import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useCallback, useEffect, useState } from "react";

import { AppShell } from "@/components/AppShell";
import { Icon } from "@/components/Icon";
import { PageHeader } from "@/components/PageHeader";
import { Segmented } from "@/components/forms";
import {
  Avatar,
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  SkeletonTable,
} from "@/components/ui";
import {
  ApiError,
  doctorRequests,
  type ApplicationStatus,
  type DoctorApplication,
} from "@/lib/api";
import { useTr } from "@/lib/lang";
import { QUEUE_REFRESH_MS } from "@/lib/useAsync";

import { ReviewDrawer } from "@/components/doctorApplication/ReviewDrawer";
import {
  RelativeTime,
  StatusChip,
  useDepartments,
} from "@/components/doctorApplication/shared";

type Tab = "pending" | "approved" | "rejected";

const TAB_STATUS: Record<Tab, ApplicationStatus> = {
  pending: "SUBMITTED",
  approved: "APPROVED",
  rejected: "REJECTED",
};

export default function DoctorRequestsPage() {
  const tr = useTr();
  const reduced = useReducedMotion();
  const departments = useDepartments();

  const [tab, setTab] = useState<Tab>("pending");
  const [nonce, setNonce] = useState(0);
  const [selected, setSelected] = useState<DoctorApplication | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);

  /**
   * One piece of state, stamped with the request that produced it.
   *
   * The stamp is what makes "loading" derivable rather than stored: while the
   * answer on hand belongs to a different tab, this tab is loading. Without it
   * the previous status's rows would sit under the new tab's heading for the
   * length of a request — approved doctors, shown as pending.
   */
  const requestKey = `${tab}:${nonce}`;
  const [answer, setAnswer] = useState<{
    key: string;
    rows: DoctorApplication[];
    pending: number | null;
    error: ApiError | null;
  } | null>(null);

  const fresh = answer?.key === requestKey ? answer : null;
  const loading = fresh === null;
  const rows = fresh?.error ? null : (fresh?.rows ?? null);
  const error = fresh?.error ?? null;
  const pending = fresh?.pending ?? null;

  useEffect(() => {
    let cancelled = false;
    const requested = `${tab}:${nonce}`;
    void doctorRequests
      .list({ status: TAB_STATUS[tab], limit: 100 })
      .then((result) => {
        if (cancelled) return;
        setAnswer({
          key: requested,
          rows: result.data,
          pending: result.meta.pending ?? null,
          error: null,
        });
      })
      .catch((caught: unknown) => {
        // A 401 is handled globally by the session provider; leaving this tab
        // on its skeleton is the honest state while the redirect happens.
        if (cancelled || (caught instanceof ApiError && caught.isAuthFailure)) return;
        setAnswer({
          key: requested,
          rows: [],
          pending: null,
          error:
            caught instanceof ApiError
              ? caught
              : new ApiError("INTERNAL_ERROR", "Something went wrong.", 500),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [tab, nonce]);

  /**
   * The queue keeps itself current, which is why there is no Refresh button.
   *
   * This deliberately does not bump the nonce. The nonce is part of the request
   * key, and the key is what makes "loading" derivable — bumping it every half
   * minute would blink the whole table back to a skeleton under a reviewer who
   * is reading a row. Instead the rows are replaced in place, and only when the
   * answer on hand still belongs to the tab that was asked about.
   */
  useEffect(() => {
    const ask = async () => {
      if (document.hidden) return;
      try {
        const result = await doctorRequests.list({ status: TAB_STATUS[tab], limit: 100 });
        setAnswer((current) =>
          current === null || !current.key.startsWith(`${tab}:`)
            ? current
            : {
                ...current,
                rows: result.data,
                pending: result.meta.pending ?? null,
                error: null,
              },
        );
      } catch {
        // Silent on purpose: what is already on screen is still the best answer
        // we have, and a failed background poll is not news.
      }
    };

    const timer = window.setInterval(() => void ask(), QUEUE_REFRESH_MS);
    const onVisibilityChange = () => {
      if (!document.hidden) void ask();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [tab]);

  const onDecided = useCallback((result: DoctorApplication) => {
    setAnswer((current) =>
      current === null
        ? current
        : {
            ...current,
            rows: current.rows.filter((row) => row.id !== result.id),
            // It has left the pending set, so the count on the tab must say so.
            pending:
              current.pending === null || !current.key.startsWith("pending:")
                ? current.pending
                : Math.max(0, current.pending - 1),
          },
    );
  }, []);

  const options: { value: Tab; label: string; icon: string }[] = [
    {
      value: "pending",
      label:
        pending !== null && pending > 0
          ? `${tr("Pending", "Zer-e-ghaur")} (${pending})`
          : tr("Pending", "Zer-e-ghaur"),
      icon: "hourglass_top",
    },
    { value: "approved", label: tr("Approved", "Manzoor"), icon: "check_circle" },
    { value: "rejected", label: tr("Rejected", "Na-manzoor"), icon: "cancel" },
  ];

  const empty: Record<Tab, { title: string; description: string; icon: string }> = {
    pending: {
      icon: "how_to_reg",
      title: tr("Nothing waiting", "Kuchh zer-e-ghaur nahi"),
      description: tr(
        "New doctor applications land here the moment they are sent.",
        "Doctors ki nayi darkhwastein bhejte hi yahan aa jati hain.",
      ),
    },
    approved: {
      icon: "verified",
      title: tr("No approved applications yet", "Abhi koi manzoor shuda darkhwast nahi"),
      description: tr(
        "Doctors you approve appear here with the date you approved them.",
        "Jin doctors ko aap manzoor karenge woh tareekh ke saath yahan aayenge.",
      ),
    },
    rejected: {
      icon: "block",
      title: tr("Nothing rejected", "Koi na-manzoor nahi"),
      description: tr(
        "Refused applications are kept here with the reason given.",
        "Na-manzoor darkhwastein wajah ke saath yahan mehfooz rehti hain.",
      ),
    },
  };

  return (
    <AppShell role="ADMIN">
      <div id="main" className="space-y-6">
        <PageHeader
          eyebrow={tr("Administration", "Intezamia")}
          title={tr("Doctor requests", "Doctors ki darkhwastein")}
          subtitle={tr(
            "Check each applicant's registration and documents before their account opens.",
            "Account kholne se pehle har applicant ki registration aur documents check karein.",
          )}
        />

        <Segmented
          options={options}
          value={tab}
          onChange={setTab}
          label={tr("Application status", "Darkhwast ki soorat-e-haal")}
        />

        <Card
          icon="how_to_reg"
          title={tr("Applications", "Darkhwastein")}
          description={
            rows
              ? tr(
                  `${rows.length} application${rows.length === 1 ? "" : "s"}`,
                  `${rows.length} darkhwast`,
                )
              : undefined
          }
          flush
        >
          {loading && <SkeletonTable rows={5} columns={5} />}

          {error && (
            <div className="p-6">
              <ErrorState
                message={error.message}
                onRetry={() => setNonce((value) => value + 1)}
              />
            </div>
          )}

          {rows && rows.length === 0 && !error && (
            <EmptyState
              icon={empty[tab].icon}
              title={empty[tab].title}
              description={empty[tab].description}
            />
          )}

          {rows && rows.length > 0 && (
            <div className="overflow-x-auto p-2">
              <table className="table-modern min-w-[52rem]">
                <thead>
                  <tr>
                    <th scope="col">{tr("Applicant", "Applicant")}</th>
                    <th scope="col">{tr("Specialization", "Specialization")}</th>
                    <th scope="col">{tr("Department", "Department")}</th>
                    <th scope="col">{tr("Registration", "Registration")}</th>
                    <th scope="col">{tr("Submitted", "Bheji gayi")}</th>
                    <th scope="col">{tr("Status", "Soorat-e-haal")}</th>
                    <th scope="col">
                      <span className="sr-only">{tr("Review", "Jaiza")}</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  <AnimatePresence initial={false}>
                    {rows.map((row) => {
                      const name = row.applicant?.name ?? row.fullName ?? "";
                      const department = departments.nameFor(row.departmentId);
                      return (
                        <motion.tr
                          key={row.id}
                          layout={!reduced}
                          initial={false}
                          exit={
                            reduced
                              ? { opacity: 0 }
                              : { opacity: 0, x: 48, transition: { duration: 0.28 } }
                          }
                        >
                          <td>
                            <div className="flex items-center gap-3">
                              <Avatar name={name || "?"} />
                              <div className="min-w-0">
                                <p className="truncate font-semibold text-strong">
                                  {name || tr("Unnamed applicant", "Naam nahi diya")}
                                </p>
                                {row.applicant?.email && (
                                  <p className="truncate font-mono text-[11px] text-faint">
                                    {row.applicant.email}
                                  </p>
                                )}
                              </div>
                            </div>
                          </td>
                          <td>
                            {row.specialization ? (
                              <Badge tone="info">{row.specialization}</Badge>
                            ) : (
                              <span className="text-faint">—</span>
                            )}
                          </td>
                          <td className="text-muted">
                            {department ?? <span className="text-faint">—</span>}
                          </td>
                          <td className="whitespace-nowrap font-mono text-xs text-muted">
                            {row.registrationNumber || "—"}
                          </td>
                          <td className="whitespace-nowrap text-muted">
                            {row.submittedAt ? (
                              <RelativeTime iso={row.submittedAt} />
                            ) : (
                              <span className="text-faint">—</span>
                            )}
                          </td>
                          <td>
                            <StatusChip status={row.status} />
                          </td>
                          <td className="text-right">
                            <Button
                              variant="secondary"
                              onClick={() => {
                                setSelected(row);
                                setDrawerOpen(true);
                              }}
                            >
                              <Icon name="visibility" className="text-[18px]" />
                              {tr("Review", "Jaiza lein")}
                            </Button>
                          </td>
                        </motion.tr>
                      );
                    })}
                  </AnimatePresence>
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>

      {/* Keyed by applicant: a different row mounts a fresh panel, so last
          review's notes and half-typed reason cannot follow it there. */}
      <ReviewDrawer
        key={selected?.id ?? "none"}
        open={drawerOpen}
        application={selected}
        departmentName={departments.nameFor(selected?.departmentId)}
        onClose={() => setDrawerOpen(false)}
        onDecided={onDecided}
      />
    </AppShell>
  );
}
