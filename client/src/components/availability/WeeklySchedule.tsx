"use client";

/**
 * The hours patients can book — the thing that was missing.
 *
 * `Doctor.availability` is what the booking screen turns into slots, and until
 * this screen existed nothing in the doctor's portal ever set it. An approved
 * doctor therefore had an empty availability, produced no slots, appeared on no
 * patient's calendar, and was told none of that anywhere. So the empty state
 * here is not decoration: it is the whole diagnosis, and it carries the fix.
 *
 * **Two saves would be a bug, not a convenience.** The weekly hours and the
 * "accepting new bookings" flag both change what a patient can do, and they are
 * read together — hours with the flag off is a different situation from no
 * hours at all. One explicit Save covers both, and nothing here autosaves:
 * a half-typed 1 in "1_:00" must never reach the booking screen.
 *
 * Everything this screen refuses, it refuses because the server would; see
 * `./schedule.ts`, which mirrors `api/app/modules/appointments/schedule.py`.
 * When the two ever disagree, the server's own message is what gets rendered.
 */

import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useCallback, useMemo, useState, type ReactNode } from "react";

import { Icon } from "@/components/Icon";
import {
  DAY_NAMES,
  DAY_ORDER,
  DAY_SHORT,
  WEEKDAYS,
  copyDay,
  draftFrom,
  isSendable,
  issuesById,
  nextWindowFor,
  overlaps,
  sameSchedule,
  slotCount,
  slotStarts,
  sortWindows,
  standardWeek,
  toPayload,
  totalSlots,
  windowSummary,
  windowsOn,
  type Bilingual,
  type DraftWindow,
} from "@/components/availability/schedule";
import { Switch } from "@/components/forms";
import { Dialog, useToast } from "@/components/overlays";
import {
  Badge,
  Button,
  Card,
  Checkbox,
  EmptyState,
  ErrorState,
  Field,
  IconButton,
  Input,
  Select,
  SkeletonRows,
  cx,
} from "@/components/ui";
import {
  ApiError,
  SLOT_MINUTES,
  appointments,
  doctors,
  type AvailabilityWindow,
  type DoctorProfile,
} from "@/lib/api";
import { useTr } from "@/lib/lang";
import { useSession } from "@/lib/session";
import { useAsync } from "@/lib/useAsync";

const EASE = [0.16, 1, 0.3, 1] as const;

type Tr = (en: string, ur: string) => string;

/** A tinted panel that says one thing. Tone is the design system's, not a hue. */
function Notice({
  tone,
  icon,
  title,
  children,
  action,
}: {
  tone: "critical" | "warning" | "info";
  icon: string;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  const tones = {
    critical: "border-critical/40 bg-critical-soft text-critical",
    warning: "border-warning/40 bg-warning-soft text-warning",
    info: "border-info/40 bg-info-soft text-info",
  } as const;

  return (
    <div
      role="status"
      className={cx("pop-in flex flex-wrap items-start gap-3 rounded-2xl border p-4", tones[tone])}
    >
      <Icon name={icon} filled className="mt-0.5 shrink-0 text-[22px]" />
      <div className="min-w-0 flex-1">
        <p className="font-semibold">{title}</p>
        {children && <div className="mt-1 text-sm text-strong">{children}</div>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

/** "09:00 · 09:30 · 10:00 … 16:30" — the abstract count made concrete. */
function previewOf(window: DraftWindow): string {
  const starts = slotStarts(window);
  if (starts.length === 0) return "";
  if (starts.length <= 4) return starts.join(" · ");
  return `${starts.slice(0, 3).join(" · ")} … ${starts[starts.length - 1]}`;
}

// ---------------------------------------------------------------------------
// One window
// ---------------------------------------------------------------------------

function WindowRow({
  window,
  issue,
  tr,
  onChange,
  onRemove,
}: {
  window: DraftWindow;
  issue: Bilingual | undefined;
  tr: Tr;
  onChange: (patch: Partial<DraftWindow>) => void;
  onRemove: () => void;
}) {
  const words = {
    minutes: "min",
    slot: tr("slot", "slot"),
    slots: tr("slots", "slots"),
    invalid: tr("no slots", "koi slot nahi"),
  };
  const count = slotCount(window);
  const preview = previewOf(window);

  return (
    <div
      className={cx(
        "rounded-xl border bg-card p-3 transition-colors",
        issue ? "border-critical" : "border-line",
      )}
    >
      <div className="flex flex-wrap items-start gap-3">
        <div className="grid min-w-0 flex-1 gap-3 sm:grid-cols-3">
          <Field label={tr("Start", "Shuru")} htmlFor={`${window.id}-start`}>
            <Input
              id={`${window.id}-start`}
              type="time"
              step={300}
              value={window.startTime}
              invalid={Boolean(issue)}
              onChange={(event) => onChange({ startTime: event.target.value })}
            />
          </Field>
          <Field label={tr("End", "Khatam")} htmlFor={`${window.id}-end`}>
            <Input
              id={`${window.id}-end`}
              type="time"
              step={300}
              value={window.endTime}
              invalid={Boolean(issue)}
              onChange={(event) => onChange({ endTime: event.target.value })}
            />
          </Field>
          <Field label={tr("Slot length", "Slot ki lambai")} htmlFor={`${window.id}-slot`}>
            <Select
              id={`${window.id}-slot`}
              value={String(window.slotMinutes)}
              invalid={Boolean(issue)}
              onChange={(event) => onChange({ slotMinutes: Number(event.target.value) })}
            >
              {SLOT_MINUTES.map((minutes) => (
                <option key={minutes} value={minutes}>
                  {minutes} {tr("minutes", "minute")}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <IconButton
          label={tr(
            `Remove the ${window.startTime} to ${window.endTime} window`,
            `${window.startTime} se ${window.endTime} wali window hatayein`,
          )}
          icon="delete"
          size="sm"
          onClick={onRemove}
          className="mt-1"
        />
      </div>

      <div className="mt-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <p className="text-sm font-semibold tabular-nums text-strong">
          {windowSummary(window, words)}
        </p>
        {preview && (
          <p className="text-xs tabular-nums text-faint" aria-hidden>
            {preview}
          </p>
        )}
        {count > 0 && !issue && (
          <span className="sr-only">
            {tr(
              `${count} bookable appointments on this window.`,
              `Is window par ${count} appointments book ho sakti hain.`,
            )}
          </span>
        )}
      </div>

      {issue && (
        <p role="alert" className="pop-in mt-2 flex items-start gap-1.5 text-sm font-medium text-critical">
          <Icon name="error" className="mt-px shrink-0 text-[16px]" />
          {tr(...issue)}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// One day
// ---------------------------------------------------------------------------

function DayRow({
  day,
  windows,
  issues,
  tr,
  reduce,
  onAdd,
  onCopy,
  onClear,
  onChange,
  onRemove,
}: {
  day: number;
  windows: DraftWindow[];
  issues: Map<string, Bilingual>;
  tr: Tr;
  reduce: boolean | null;
  onAdd: () => void;
  onCopy: () => void;
  onClear: () => void;
  onChange: (id: string, patch: Partial<DraftWindow>) => void;
  onRemove: (id: string) => void;
}) {
  const dayName = tr(...DAY_NAMES[day]);
  const slots = windows.reduce((sum, window) => sum + slotCount(window), 0);

  return (
    <li className="rounded-2xl border border-line bg-sunken/40 p-4">
      <div className="flex flex-wrap items-center gap-3">
        <h3 className="w-24 shrink-0 font-display text-base font-bold text-strong">{dayName}</h3>
        {windows.length === 0 ? (
          <Badge tone="neutral">{tr("Closed", "Band")}</Badge>
        ) : (
          <Badge tone={slots > 0 ? "good" : "warning"}>
            {tr(
              `${slots} ${slots === 1 ? "slot" : "slots"}`,
              `${slots} ${slots === 1 ? "slot" : "slots"}`,
            )}
          </Badge>
        )}

        <div className="ml-auto flex flex-wrap items-center gap-1">
          <Button variant="ghost" onClick={onAdd}>
            <Icon name="add" className="text-[20px]" />
            {tr("Add hours", "Auqat shamil karein")}
          </Button>
          <IconButton
            label={tr(`Copy ${dayName} to other days`, `${dayName} ko doosre dinon par copy karein`)}
            icon="content_copy"
            size="sm"
            disabled={windows.length === 0}
            onClick={onCopy}
          />
          <IconButton
            label={tr(`Clear ${dayName}`, `${dayName} khali karein`)}
            icon="backspace"
            size="sm"
            disabled={windows.length === 0}
            onClick={onClear}
          />
        </div>
      </div>

      <AnimatePresence initial={false}>
        {windows.map((window) => (
          <motion.div
            key={window.id}
            layout={!reduce}
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: reduce ? 0 : 0.28, ease: EASE }}
            className="overflow-hidden"
          >
            <div className="pt-3">
              <WindowRow
                window={window}
                issue={issues.get(window.id)}
                tr={tr}
                onChange={(patch) => onChange(window.id, patch)}
                onRemove={() => onRemove(window.id)}
              />
            </div>
          </motion.div>
        ))}
      </AnimatePresence>

      {windows.length === 0 && (
        <p className="mt-2 text-sm text-muted">
          {tr(
            "No hours — nothing can be booked on this day.",
            "Koi auqat nahi — is din kuchh book nahi ho sakta.",
          )}
        </p>
      )}
    </li>
  );
}

// ---------------------------------------------------------------------------
// Copy a day
// ---------------------------------------------------------------------------

/**
 * Mounted only while it is open, and keyed on the source day: the last copy's
 * targets are not a suggestion for the next one, and remounting is a cheaper
 * way to say that than an effect that resets state after the fact.
 */
function CopyDialog({
  day,
  windows,
  tr,
  onClose,
  onApply,
}: {
  day: number;
  windows: DraftWindow[];
  tr: Tr;
  onClose: () => void;
  onApply: (targets: number[]) => void;
}) {
  const [targets, setTargets] = useState<number[]>([]);

  const dayName = tr(...DAY_NAMES[day]);
  const others = DAY_ORDER.filter((other) => other !== day);
  const source = windowsOn(windows, day);

  const toggle = (other: number) =>
    setTargets((current) =>
      current.includes(other) ? current.filter((value) => value !== other) : [...current, other],
    );

  return (
    <Dialog
      open
      onClose={onClose}
      icon="content_copy"
      title={tr(`Copy ${dayName} to…`, `${dayName} yahan copy karein…`)}
      description={tr(
        "The days you pick will be replaced by these hours, not added to.",
        "Chune gaye din in auqat se badal diye jayenge, shamil nahi kiye jayenge.",
      )}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {tr("Cancel", "Mansookh")}
          </Button>
          <Button disabled={targets.length === 0} onClick={() => onApply(targets)}>
            {tr(
              `Copy to ${targets.length} ${targets.length === 1 ? "day" : "days"}`,
              `${targets.length} ${targets.length === 1 ? "din" : "dinon"} par copy karein`,
            )}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="rounded-xl border border-line bg-sunken/60 p-3">
          <p className="text-sm font-semibold text-strong">
            {tr(`${dayName} is`, `${dayName} yeh hai`)}
          </p>
          <ul className="mt-1 space-y-0.5">
            {source.map((window) => (
              <li key={window.id} className="text-sm tabular-nums text-muted">
                {windowSummary(window, {
                  minutes: "min",
                  slot: tr("slot", "slot"),
                  slots: tr("slots", "slots"),
                  invalid: tr("no slots", "koi slot nahi"),
                })}
              </li>
            ))}
          </ul>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button
            variant="secondary"
            onClick={() => setTargets(WEEKDAYS.filter((weekday) => weekday !== day))}
          >
            {tr("Rest of the working week", "Baqi kaam ke din")}
          </Button>
          <Button variant="secondary" onClick={() => setTargets([...others])}>
            {tr("Rest of the week", "Baqi poora hafta")}
          </Button>
        </div>

        <fieldset className="space-y-2">
          <legend className="mb-1 text-sm font-semibold text-strong">
            {tr("Copy to these days", "In dinon par copy karein")}
          </legend>
          {others.map((other) => (
            <Checkbox
              key={other}
              label={tr(...DAY_NAMES[other])}
              checked={targets.includes(other)}
              onChange={() => toggle(other)}
            />
          ))}
        </fieldset>
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// The screen
// ---------------------------------------------------------------------------

/**
 * Fetches, then hands a loaded profile to the editor below.
 *
 * The split is not cosmetic. The editor seeds its draft from the profile in a
 * `useState` initializer and is mounted only once there is one, so there is no
 * effect copying fetched data into state — the pattern that turns one render
 * into three and, on this screen, would have raced a doctor's first keystroke.
 */
export function WeeklySchedule() {
  const tr = useTr();
  const { user } = useSession();

  const profile = useAsync(() => doctors.me());

  /**
   * The clinic's zone, read from the same endpoint the patient's booking
   * screen calls — it is the only place the API publishes it. Hard-coding
   * "Asia/Karachi" here would be a lie the day the deployment moves, and these
   * times are wall-clock at the clinic, not in the doctor's browser.
   *
   * One day is requested rather than the default fortnight: nothing on this
   * screen needs the slot grid, only the zone name beside it.
   */
  const today = useMemo(() => new Date().toLocaleDateString("en-CA"), []);
  const clinic = useAsync(
    async () => (user?.doctorId ? appointments.availability(user.doctorId, today, today) : null),
    [user?.doctorId, today],
  );

  const title = tr("Weekly schedule", "Haftawar schedule");

  if (profile.loading) {
    return (
      <Card title={title} icon="calendar_month">
        <div role="status" aria-live="polite">
          <span className="sr-only">
            {tr("Loading your schedule", "Aap ka schedule load ho raha hai")}…
          </span>
          <SkeletonRows rows={4} title={false} />
        </div>
      </Card>
    );
  }

  if (!profile.data) {
    // A 401 is handled globally by the session provider, which is already
    // redirecting; there is nothing useful to draw in that moment.
    return profile.error ? (
      <Card title={title} icon="calendar_month">
        <ErrorState message={profile.error.message} onRetry={profile.reload} />
      </Card>
    ) : null;
  }

  return <ScheduleEditor profile={profile.data} timezone={clinic.data?.timezone ?? null} />;
}

function ScheduleEditor({
  profile,
  timezone,
}: {
  profile: DoctorProfile;
  timezone: string | null;
}) {
  const tr = useTr();
  const toast = useToast();
  const reduce = useReducedMotion();

  const [draft, setDraft] = useState<DraftWindow[]>(() => draftFrom(profile.availability));
  /** What patients can book right now — the saved hours, not what is on screen. */
  const [published, setPublished] = useState<AvailabilityWindow[]>(() =>
    sortWindows([...profile.availability]),
  );
  const [accepting, setAccepting] = useState(profile.acceptingPatients);
  const [publishedAccepting, setPublishedAccepting] = useState(profile.acceptingPatients);
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [copyFrom, setCopyFrom] = useState<number | null>(null);

  const payload = useMemo(() => toPayload(draft), [draft]);
  const issues = useMemo(() => issuesById(draft), [draft]);
  const clashes = useMemo(() => overlaps(draft), [draft]);
  const sendable = useMemo(() => isSendable(draft), [draft]);
  const weekSlots = totalSlots(draft);

  const dirty = !sameSchedule(payload, published) || accepting !== publishedAccepting;
  const publishedEmpty = published.length === 0;

  const change = useCallback((id: string, patch: Partial<DraftWindow>) => {
    setDraft((current) =>
      current.map((window) => (window.id === id ? { ...window, ...patch } : window)),
    );
  }, []);

  const remove = useCallback((id: string) => {
    setDraft((current) => current.filter((window) => window.id !== id));
  }, []);

  const add = useCallback((day: number) => {
    setDraft((current) => sortWindows([...current, nextWindowFor(current, day)]));
  }, []);

  const clearDay = useCallback((day: number) => {
    setDraft((current) => current.filter((window) => window.dayOfWeek !== day));
  }, []);

  const discard = () => {
    setDraft(draftFrom(published));
    setAccepting(publishedAccepting);
    setServerError(null);
  };

  const save = async () => {
    setBusy(true);
    setServerError(null);
    try {
      const updated = await doctors.updateMe({
        availability: payload,
        acceptingPatients: accepting,
      });
      // The draft is left alone rather than rebuilt from the response: the
      // server stores exactly what it was sent, and re-minting every row id
      // would replay the whole week's entrance animation on a successful save.
      setPublished(sortWindows([...updated.availability]));
      setPublishedAccepting(updated.acceptingPatients);
      toast.show({
        title: tr("Schedule saved", "Schedule mehfooz ho gaya"),
        body:
          updated.availability.length === 0
            ? tr(
                "You have no hours published, so patients still cannot book you.",
                "Koi auqat shaya nahi, is liye mareez abhi bhi book nahi kar sakte.",
              )
            : tr(
                `Patients can now book ${weekSlots} ${weekSlots === 1 ? "appointment" : "appointments"} a week.`,
                `Ab mareez har hafte ${weekSlots} ${weekSlots === 1 ? "appointment" : "appointments"} book kar sakte hain.`,
              ),
      });
    } catch (caught) {
      // The server is the authority on this; its wording names the day and both
      // windows, which is more use than anything generic said here.
      setServerError(
        caught instanceof ApiError
          ? caught.message
          : tr("Could not save your schedule.", "Aap ka schedule mehfooz nahi ho saka."),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Card
        icon="calendar_month"
        title={tr("Weekly schedule", "Haftawar schedule")}
        description={tr(
          "The hours patients can book, repeating every week.",
          "Woh auqat jin mein mareez appointment book kar sakte hain, har hafte.",
        )}
        action={
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Badge tone="info">
              <Icon name="schedule" className="text-[14px]" />
              {timezone ?? tr("Clinic time", "Clinic ka waqt")}
            </Badge>
            <Badge tone={weekSlots > 0 ? "good" : "neutral"}>
              {tr(
                `${weekSlots} ${weekSlots === 1 ? "slot" : "slots"} a week`,
                `Har hafte ${weekSlots} ${weekSlots === 1 ? "slot" : "slots"}`,
              )}
            </Badge>
          </div>
        }
      >
        <div className="space-y-4">
          {/* What a patient sees right now, said before anything on screen. */}
          {publishedEmpty && (
            <Notice
              tone="critical"
              icon="event_busy"
              title={tr(
                "Patients cannot book you at the moment.",
                "Is waqt mareez aap ki appointment book nahi kar sakte.",
              )}
            >
              {tr(
                "You have no hours published, so no appointment slots exist and you do not appear on the booking screen. Set your working hours below and save.",
                "Aap ne koi auqat shaya nahi kiye, is liye koi slot maujood nahi aur aap booking screen par nazar nahi aate. Neeche apne auqat set kar ke save karein.",
              )}
            </Notice>
          )}

          {!publishedEmpty && !publishedAccepting && (
            <Notice
              tone="warning"
              icon="pause_circle"
              title={tr(
                "New bookings are paused.",
                "Nayi bookings roki gayi hain.",
              )}
            >
              {tr(
                "Your hours are published, but you are not accepting new patients, so no one can book them.",
                "Aap ke auqat shaya hain, magar aap naye mareez qubool nahi kar rahe, is liye koi book nahi kar sakta.",
              )}
            </Notice>
          )}

          {draft.length === 0 && (
            <EmptyState
              icon="event_available"
              title={tr("No hours set yet", "Abhi koi auqat set nahi")}
              description={tr(
                "Start from a normal clinic week and adjust it, or add hours to any day below.",
                "Aam clinic hafte se shuru karein aur tabdeeli karein, ya neeche kisi bhi din auqat shamil karein.",
              )}
              action={
                <Button onClick={() => setDraft(standardWeek())}>
                  <Icon name="auto_awesome" className="text-[20px]" />
                  {tr(
                    "Mon–Fri, 09:00–17:00, 30 min",
                    "Peer–Juma, 09:00–17:00, 30 min",
                  )}
                </Button>
              }
            />
          )}

          <ul className="space-y-3">
            {DAY_ORDER.map((day) => (
              <DayRow
                key={day}
                day={day}
                windows={windowsOn(draft, day)}
                issues={issues}
                tr={tr}
                reduce={reduce}
                onAdd={() => add(day)}
                onCopy={() => setCopyFrom(day)}
                onClear={() => clearDay(day)}
                onChange={change}
                onRemove={remove}
              />
            ))}
          </ul>

          {/* The clashes again, gathered: a doctor who has scrolled past the
              rows still needs to know why Save is refusing. */}
          {clashes.length > 0 && (
            <div role="alert" className="rounded-2xl border border-critical/40 bg-critical-soft p-4">
              <p className="flex items-center gap-2 font-semibold text-critical">
                <Icon name="error" filled className="text-[20px]" />
                {tr(
                  `${clashes.length} ${clashes.length === 1 ? "overlap" : "overlaps"} to fix`,
                  `${clashes.length} ${clashes.length === 1 ? "overlap" : "overlaps"} theek karni hain`,
                )}
              </p>
              <ul className="mt-2 space-y-1">
                {clashes.map((clash) => (
                  <li
                    key={`${clash.earlierId}-${clash.laterId}`}
                    className="text-sm tabular-nums text-strong"
                  >
                    {tr(...clash.message)}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="rounded-2xl border border-line bg-sunken/40 p-4">
            <Switch
              checked={accepting}
              onChange={setAccepting}
              label={tr("Accepting new bookings", "Nayi bookings qubool kar rahe hain")}
              description={tr(
                "Turn this off when your list is full. Your hours stay published and appointments already booked are unaffected — patients simply cannot book new ones.",
                "Jab aap ki list bhar jaye to ise band kar dein. Aap ke auqat shaya rahenge aur pehle se booked appointments par koi asar nahi — mareez sirf nayi book nahi kar payenge.",
              )}
            />
            <p className="mt-3 border-t border-line pt-3 text-sm text-muted">
              <Icon name="info" className="mr-1 align-[-3px] text-[16px]" />
              {tr(
                "This is not the same as having no hours. With no hours there is nothing to book either way; this switch pauses bookings against hours you have already set.",
                "Yeh auqat na hone jaisa nahi hai. Auqat na hon to kisi soorat kuchh book nahi ho sakta; yeh switch pehle se set auqat par booking rokta hai.",
              )}
            </p>
          </div>

          {serverError && <ErrorState message={serverError} />}

          <div className="sticky bottom-0 -mx-6 -mb-6 flex flex-wrap items-center gap-3 rounded-b-2xl border-t border-line bg-card/95 px-6 py-4 backdrop-blur">
            <div className="min-w-0 flex-1">
              <p role="status" className="text-sm font-semibold">
                {dirty ? (
                  <span className="flex items-center gap-2 text-warning">
                    <span aria-hidden className="pulse-dot h-2 w-2 shrink-0 rounded-full bg-warning" />
                    {tr(
                      "Unsaved changes — patients still see your last saved hours.",
                      "Tabdeeliyan mehfooz nahi — mareezon ko abhi bhi purane auqat nazar aate hain.",
                    )}
                  </span>
                ) : (
                  <span className="text-muted">
                    {tr("Everything here is saved.", "Sab kuchh mehfooz hai.")}
                  </span>
                )}
              </p>
              {dirty && !sendable && (
                <p className="mt-0.5 text-sm font-medium text-critical">
                  {tr(
                    "Fix the highlighted windows before saving.",
                    "Save se pehle nishaan-zada windows theek karein.",
                  )}
                </p>
              )}
            </div>
            <Button variant="ghost" disabled={!dirty || busy} onClick={discard}>
              {tr("Discard changes", "Tabdeeliyan hatayein")}
            </Button>
            <Button loading={busy} disabled={!dirty || !sendable} onClick={() => void save()}>
              <Icon name="save" className="text-[20px]" />
              {tr("Save schedule", "Schedule mehfooz karein")}
            </Button>
          </div>
        </div>
      </Card>

      {copyFrom !== null && (
        <CopyDialog
          key={copyFrom}
          day={copyFrom}
          windows={draft}
          tr={tr}
          onClose={() => setCopyFrom(null)}
          onApply={(targets) => {
            setDraft((current) => copyDay(current, copyFrom, targets));
            setCopyFrom(null);
            toast.show({
              tone: "info",
              title: tr(
                `${tr(...DAY_SHORT[copyFrom])} copied to ${targets.length} ${targets.length === 1 ? "day" : "days"}`,
                `${tr(...DAY_SHORT[copyFrom])} ${targets.length} ${targets.length === 1 ? "din" : "dinon"} par copy ho gaya`,
              ),
              body: tr(
                "Not saved yet — press Save schedule.",
                "Abhi mehfooz nahi — Save schedule dabayein.",
              ),
            });
          }}
        />
      )}
    </>
  );
}
