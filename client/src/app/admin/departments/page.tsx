"use client";

/**
 * The specialities a doctor can be filed under, as an administrator maintains them.
 *
 * The endpoints for this have existed since the schema did; what was missing was
 * any screen that called them, so the system shipped with the four departments
 * somebody seeded — Cardiology, General Medicine, Paediatrics, Pulmonology — and
 * no way to add a fifth. A dermatologist registering had nothing to be filed
 * under, and the only fix was a hand-written SQL statement.
 *
 * **A department is deactivated, never deleted.** Doctors are filed under it and
 * appointments were booked against those doctors, so removing the row would
 * either fail on a foreign key or orphan real history. Deactivating takes it out
 * of the choices without rewriting what already happened — which is the same
 * reasoning the rest of this system applies to anything a patient has touched.
 *
 * The code is fixed once created, for the same reason: it is the department's
 * identity, and editing it in place would silently move everyone filed under it.
 */

import { useCallback, useState } from "react";

import { AppShell } from "@/components/AppShell";
import { Icon } from "@/components/Icon";
import { PageHeader } from "@/components/PageHeader";
import { useToast } from "@/components/overlays";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Field,
  Input,
  SkeletonRows,
  cx,
} from "@/components/ui";
import { ApiError, departments, type Department } from "@/lib/api";
import { useTr } from "@/lib/lang";
import { useAsync } from "@/lib/useAsync";

/**
 * A code the server will accept, derived from the name so nobody has to invent
 * one. `DERMATOLOGY` from "Dermatology", `GEN_MED` is still theirs to type.
 */
function codeFor(name: string): string {
  return name
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 16);
}

function AddDepartment({ onAdded }: { onAdded: () => void }) {
  const tr = useTr();
  const toast = useToast();
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [location, setLocation] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The code follows the name until somebody edits it, and then stops — so the
  // common case needs no thought and the unusual one is still possible.
  const [codeTouched, setCodeTouched] = useState(false);
  const effectiveCode = codeTouched ? code : codeFor(name);

  const valid = name.trim().length >= 2 && effectiveCode.length >= 2;

  async function submit() {
    setSaving(true);
    setError(null);
    try {
      await departments.create({
        name: name.trim(),
        code: effectiveCode,
        location: location.trim() || undefined,
      });
      toast.show({
        tone: "success",
        title: tr("Department added", "Department shamil ho gaya"),
        body: tr(
          `Doctors can now be filed under ${name.trim()}.`,
          `Ab doctors ko ${name.trim()} mein rakha ja sakta hai.`,
        ),
      });
      setName("");
      setCode("");
      setLocation("");
      setCodeTouched(false);
      onAdded();
    } catch (cause) {
      const message = cause instanceof ApiError ? cause.message : String(cause);
      setError(message);
      toast.show({ tone: "critical", title: tr("Not added", "Shamil nahi hua"), body: message });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card
      icon="add_circle"
      title={tr("Add a department", "Naya department")}
      description={tr(
        "Dermatology, Psychiatry, Orthopaedics — whatever this hospital actually has.",
        "Dermatology, Psychiatry, Orthopaedics — jo bhi is hospital mein waqai hai.",
      )}
    >
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label={tr("Name", "Naam")} htmlFor="department-name">
          <Input
            id="department-name"
            maxLength={120}
            placeholder={tr("Dermatology", "Dermatology")}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </Field>

        <Field
          label={tr("Code", "Code")}
          htmlFor="department-code"
          hint={tr("Fixed once created.", "Banne ke baad tabdeel nahi hota.")}
        >
          <Input
            id="department-code"
            maxLength={16}
            className="font-mono uppercase"
            value={effectiveCode}
            onChange={(event) => {
              setCodeTouched(true);
              setCode(codeFor(event.target.value));
            }}
          />
        </Field>

        <Field
          label={tr("Location", "Jagah")}
          htmlFor="department-location"
          hint={tr("Optional — the floor or wing.", "Ikhtiyari — manzil ya wing.")}
        >
          <Input
            id="department-location"
            maxLength={120}
            placeholder={tr("2nd floor, B block", "Doosri manzil, B block")}
            value={location}
            onChange={(event) => setLocation(event.target.value)}
          />
        </Field>
      </div>

      {error && (
        <p role="alert" className="mt-3 text-sm font-medium text-critical">
          {error}
        </p>
      )}

      <div className="mt-4">
        <Button onClick={submit} loading={saving} disabled={!valid}>
          <Icon name="add" className="text-[20px]" />
          {tr("Add department", "Department shamil karein")}
        </Button>
      </div>
    </Card>
  );
}

function DepartmentRow({
  department,
  onChanged,
}: {
  department: Department;
  onChanged: () => void;
}) {
  const tr = useTr();
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  async function setActive(active: boolean) {
    setBusy(true);
    try {
      await departments.update(department.id, { active });
      toast.show({
        tone: "success",
        title: active
          ? tr("Department reopened", "Department dobara khul gaya")
          : tr("Department closed", "Department band kar diya"),
        body: active
          ? tr(
              `${department.name} can be chosen again.`,
              `${department.name} dobara chuna ja sakta hai.`,
            )
          : tr(
              `${department.name} is no longer offered. Doctors already in it keep their history.`,
              `${department.name} ab pesh nahi hota. Jo doctors pehle se is mein hain, un ka record wahi rehta hai.`,
            ),
      });
      onChanged();
    } catch (cause) {
      toast.show({
        tone: "critical",
        title: tr("That did not work", "Yeh nahi ho saka"),
        body: cause instanceof ApiError ? cause.message : String(cause),
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <li
      className={cx(
        "flex flex-wrap items-center gap-3 rounded-2xl border border-line bg-card p-4 shadow-card",
        !department.active && "opacity-70",
      )}
    >
      <span className="bg-gradient-soft grid h-10 w-10 shrink-0 place-items-center rounded-xl text-primary">
        <Icon name="domain" className="text-[20px]" />
      </span>

      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-2">
          <span className="font-display text-base font-bold text-strong">{department.name}</span>
          <span className="font-mono text-[11px] font-semibold text-faint">{department.code}</span>
          {!department.active && <Badge tone="neutral">{tr("Closed", "Band")}</Badge>}
        </span>
        <span className="mt-0.5 block text-sm text-muted">
          {/* The count is the reason deactivating is not deleting. */}
          {department.doctorCount === 1
            ? tr("1 doctor", "1 doctor")
            : tr(`${department.doctorCount} doctors`, `${department.doctorCount} doctors`)}
          {department.location ? ` · ${department.location}` : ""}
        </span>
      </span>

      <Button
        variant="secondary"
        loading={busy}
        onClick={() => setActive(!department.active)}
      >
        {department.active ? tr("Close", "Band karein") : tr("Reopen", "Dobara kholein")}
      </Button>
    </li>
  );
}

export default function AdminDepartments() {
  const tr = useTr();
  const [refresh, setRefresh] = useState(0);
  const reload = useCallback(() => setRefresh((n) => n + 1), []);
  const list = useAsync(() => departments.list(), [refresh]);

  const rows = list.data?.data ?? [];

  return (
    <AppShell role="ADMIN">
      <div id="main" className="page-enter space-y-6">
        <PageHeader
          eyebrow={tr("Administration", "Intezamia")}
          title={tr("Departments", "Departments")}
          subtitle={tr(
            "The specialities a doctor can be filed under.",
            "Woh specialities jin mein doctor rakha ja sakta hai.",
          )}
        />

        <AddDepartment onAdded={reload} />

        <Card icon="list" title={tr("All departments", "Sab departments")}>
          {list.loading && <SkeletonRows rows={4} />}
          {list.error && <ErrorState message={list.error.message} onRetry={list.reload} />}
          {list.data && rows.length === 0 && (
            <EmptyState
              icon="domain"
              title={tr("No departments yet", "Abhi koi department nahi")}
              description={tr(
                "Add the first one above. A doctor cannot be filed until one exists.",
                "Pehla department upar se shamil karein. Is ke baghair doctor kisi mein nahi rakha ja sakta.",
              )}
            />
          )}
          {rows.length > 0 && (
            <ul className="stagger space-y-3">
              {rows.map((department) => (
                <DepartmentRow key={department.id} department={department} onChanged={reload} />
              ))}
            </ul>
          )}
        </Card>
      </div>
    </AppShell>
  );
}
