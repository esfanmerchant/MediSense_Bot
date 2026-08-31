"use client";

/**
 * The doctor's caseload.
 *
 * Scoped by care relationship, not by role — the API returns only patients this
 * doctor is assigned to or is consulting on, so there is no "all patients" view
 * to accidentally render.
 */

import { useMemo, useState } from "react";
import Link from "next/link";

import { AppShell } from "@/components/AppShell";
import { Icon } from "@/components/Icon";
import { PageHeader } from "@/components/PageHeader";
import {
  Avatar,
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Field,
  Input,
  SkeletonTable,
} from "@/components/ui";
import { doctors } from "@/lib/api";
import { useTr } from "@/lib/lang";
import { useAsync } from "@/lib/useAsync";

export default function DoctorPatients() {
  const tr = useTr();
  const [search, setSearch] = useState("");
  const list = useAsync(() => doctors.myPatients({ limit: 100 }), []);

  const rows = useMemo(() => list.data?.data ?? [], [list.data]);
  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter(
      (patient) =>
        patient.name.toLowerCase().includes(needle) ||
        patient.medicalRecordNumber.toLowerCase().includes(needle),
    );
  }, [rows, search]);

  const primaryCount = useMemo(() => rows.filter((patient) => patient.isPrimary).length, [rows]);

  return (
    <AppShell role="DOCTOR">
      <div id="main" className="page-enter">
        <PageHeader
          eyebrow={tr("Doctor portal", "Doctor ka portal")}
          title={tr("My patients", "Mere mareez")}
          subtitle={tr(
            "Patients you are assigned to or currently treating.",
            "Woh mareez jo aap ke supurd hain ya jin ka aap is waqt ilaaj kar rahe hain.",
          )}
        />

        {list.loading && (
          <div role="status" aria-live="polite" className="mt-6">
            <span className="sr-only">
              {tr("Loading your caseload", "Mareezon ki fehrist load ho rahi hai")}…
            </span>
            <div className="rounded-2xl border border-line bg-card shadow-card">
              <SkeletonTable rows={5} columns={4} />
            </div>
          </div>
        )}
        {list.error && (
          <div className="mt-6">
            <ErrorState message={list.error.message} onRetry={list.reload} />
          </div>
        )}

        {list.data && (
          <div className="mt-6 space-y-4">
            <div className="flex flex-wrap items-end justify-between gap-4">
              <div className="w-full max-w-sm">
                <Field label="Find a patient" htmlFor="patient-search">
                  <Input
                    id="patient-search"
                    type="search"
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder="Name or record number"
                  />
                </Field>
              </div>
              <div className="flex flex-wrap gap-2">
                <Badge tone="neutral">
                  <Icon name="group" className="text-[14px]" />
                  <span className="tabular-nums">{rows.length}</span> {tr("in your care", "aap ki nigrani mein")}
                </Badge>
                {primaryCount > 0 && (
                  <Badge tone="info">
                    <Icon name="star" filled className="text-[14px]" />
                    <span className="tabular-nums">{primaryCount}</span> {tr("primary", "buniyadi")}
                  </Badge>
                )}
              </div>
            </div>

            <Card
              title="Caseload"
              description={`${filtered.length} of ${rows.length} patient${rows.length === 1 ? "" : "s"}`}
              icon="patient_list"
              flush
            >
              {filtered.length === 0 ? (
                <EmptyState
                  icon={rows.length === 0 ? "group_off" : "search_off"}
                  title={rows.length === 0 ? "No patients assigned" : "No matches"}
                  description={
                    rows.length === 0
                      ? "Patients appear here once you are assigned to them or they book with you."
                      : tr(
                          "Try a different name or record number.",
                          "Koi aur naam ya record number aazmayein.",
                        )
                  }
                  action={
                    rows.length > 0 && (
                      <Button variant="secondary" onClick={() => setSearch("")}>
                        <Icon name="close" className="text-[18px]" />
                        {tr("Clear search", "Talaash saaf karein")}
                      </Button>
                    )
                  }
                />
              ) : (
                <div className="overflow-x-auto p-2">
                  <table className="table-modern min-w-[44rem]">
                    <thead>
                      <tr>
                        <th scope="col">{tr("Patient", "Mareez")}</th>
                        <th scope="col">{tr("Record", "Record")}</th>
                        <th scope="col">{tr("Last seen", "Aakhri baar")}</th>
                        <th scope="col">{tr("Blood group", "Blood group")}</th>
                        <th scope="col">{tr("Allergies", "Allergies")}</th>
                        <th scope="col">{tr("Conditions", "Bimariyan")}</th>
                        <th scope="col">
                          <span className="sr-only">{tr("Open chart", "Chart kholein")}</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody className="stagger">
                      {filtered.map((patient) => (
                        <tr key={patient.id} className="group">
                          <td>
                            <div className="flex items-center gap-3">
                              <Avatar
                                name={patient.name}
                                ring={patient.isPrimary ? "active" : undefined}
                              />
                              <div className="min-w-0">
                                <Link
                                  href={`/doctor/patients/${patient.id}`}
                                  className="font-semibold text-strong transition-colors hover:text-primary hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                                >
                                  {patient.name}
                                </Link>
                                {patient.isPrimary && (
                                  <div className="mt-1">
                                    <Badge tone="info">
                                      <Icon name="star" filled className="text-[12px]" />
                                      Primary
                                    </Badge>
                                  </div>
                                )}
                              </div>
                            </div>
                          </td>
                          <td className="whitespace-nowrap tabular-nums text-muted">
                            {patient.medicalRecordNumber}
                          </td>
                          {/* The caseload now holds past patients as well as
                              current ones, and this is what tells them apart —
                              "who have I not seen in a while" is the question a
                              doctor scans this list with. */}
                          <td className="whitespace-nowrap text-muted">
                            {patient.lastSeenAt ? (
                              new Date(patient.lastSeenAt).toLocaleDateString(undefined, {
                                day: "numeric",
                                month: "short",
                                year: "numeric",
                              })
                            ) : (
                              <span className="text-faint">
                                {tr("Not yet", "Abhi nahi")}
                              </span>
                            )}
                          </td>
                          <td>
                            {patient.bloodGroup ? (
                              <Badge tone="info">
                                <Icon name="bloodtype" filled className="text-[12px]" />
                                {patient.bloodGroup}
                              </Badge>
                            ) : (
                              <span className="text-faint">—</span>
                            )}
                          </td>
                          <td className="max-w-[14rem]">
                            {patient.allergies ? (
                              <span className="inline-flex max-w-full items-start gap-1.5 rounded-full bg-critical-soft px-2.5 py-1 text-xs font-semibold text-critical">
                                <Icon name="warning" filled className="mt-px shrink-0 text-[14px]" />
                                <span className="truncate" title={patient.allergies}>
                                  {patient.allergies}
                                </span>
                              </span>
                            ) : (
                              <span className="text-faint">—</span>
                            )}
                          </td>
                          <td className="max-w-[14rem] text-muted">
                            {patient.chronicConditions ? (
                              <span className="block truncate" title={patient.chronicConditions}>
                                {patient.chronicConditions}
                              </span>
                            ) : (
                              <span className="text-faint">—</span>
                            )}
                          </td>
                          <td className="w-12 text-right">
                            <Link
                              href={`/doctor/patients/${patient.id}`}
                              aria-label={`${tr("Open chart for", "Chart kholein")} ${patient.name}`}
                              className="inline-grid h-9 w-9 place-items-center rounded-full text-faint transition-[background-color,color,transform] duration-200 hover:bg-gradient-soft hover:text-primary group-hover:translate-x-0.5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                            >
                              <Icon name="arrow_forward" className="text-[20px]" />
                            </Link>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
          </div>
        )}
      </div>
    </AppShell>
  );
}
