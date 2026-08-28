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
import { Badge, Card, EmptyState, ErrorState, Input, Loading } from "@/components/ui";
import { doctors } from "@/lib/api";
import { useAsync } from "@/lib/useAsync";

export default function DoctorPatients() {
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

  return (
    <AppShell role="DOCTOR">
      <div id="main">
        <h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-50">My patients</h1>
        <p className="mt-1 text-slate-600 dark:text-slate-400">
          Patients you are assigned to or currently treating.
        </p>

        {list.loading && <Loading label="Loading your caseload" />}
        {list.error && <ErrorState message={list.error.message} onRetry={list.reload} />}

        {list.data && (
          <div className="mt-6 space-y-4">
            <div className="max-w-sm">
              <label
                htmlFor="patient-search"
                className="block text-sm font-medium text-slate-800 dark:text-slate-200"
              >
                Find a patient
              </label>
              <Input
                id="patient-search"
                className="mt-1.5"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Name or record number"
              />
            </div>

            <Card
              title="Caseload"
              description={`${filtered.length} of ${rows.length} patient${rows.length === 1 ? "" : "s"}`}
            >
              {filtered.length === 0 ? (
                <EmptyState
                  title={rows.length === 0 ? "No patients assigned" : "No matches"}
                  description={
                    rows.length === 0
                      ? "Patients appear here once you are assigned to them or they book with you."
                      : undefined
                  }
                />
              ) : (
                <ul className="divide-y divide-slate-200 dark:divide-slate-700">
                  {filtered.map((patient) => (
                    <li key={patient.id} className="flex flex-wrap items-center gap-3 py-3">
                      <div className="min-w-0">
                        <Link
                          href={`/doctor/patients/${patient.id}`}
                          className="font-medium text-teal-800 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600 dark:text-teal-300"
                        >
                          {patient.name}
                        </Link>
                        <p className="text-sm tabular-nums text-slate-600 dark:text-slate-400">
                          {patient.medicalRecordNumber}
                          {patient.bloodGroup ? ` · ${patient.bloodGroup}` : ""}
                        </p>
                        {patient.allergies && (
                          <p className="mt-1 text-sm font-medium text-red-700 dark:text-red-400">
                            Allergies: {patient.allergies}
                          </p>
                        )}
                      </div>
                      {patient.isPrimary && (
                        <div className="ml-auto">
                          <Badge tone="info">Primary</Badge>
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>
        )}
      </div>
    </AppShell>
  );
}
