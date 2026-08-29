"use client";

/**
 * The design system, on one page.
 *
 * Not a demo — a check. Every token, primitive and control renders here, so a
 * change to `globals.css` can be seen in both themes in one scroll instead of
 * being discovered later on a screen nobody thought to open. The theme toggle
 * at the top switches the whole page, which is the only honest way to review a
 * dark palette.
 *
 * It is deliberately public and unlinked: it holds no data, and a reviewer
 * should be able to open it without an account.
 */

import { useState } from "react";

import { CircuitNodes } from "@/components/brand/CircuitNodes";
import { EcgBeat, EcgLine } from "@/components/brand/EcgLine";
import { GradientText } from "@/components/brand/GradientText";
import { Logo, LogoMark } from "@/components/brand/Logo";
import { Icon } from "@/components/Icon";
import { LanguageToggle } from "@/components/LanguageToggle";
import { ThemeToggle } from "@/components/ThemeToggle";
import {
  OtpInput,
  PasswordStrength,
  Segmented,
  Stepper,
  SuccessMark,
  Switch,
} from "@/components/forms";
import { Dialog, Drawer, useToast } from "@/components/overlays";
import {
  Avatar,
  Badge,
  Button,
  Card,
  Checkbox,
  EmptyState,
  ErrorState,
  Field,
  IconButton,
  Input,
  Loading,
  PillGroup,
  QuickAction,
  Select,
  Skeleton,
  SkeletonTable,
  StatTile,
  Textarea,
  cx,
} from "@/components/ui";

function Section({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="scroll-mt-24 border-t border-line pt-10">
      <h2 className="font-display text-xl font-bold text-strong">{title}</h2>
      {subtitle && <p className="mt-1 text-sm text-muted">{subtitle}</p>}
      <div className="mt-6">{children}</div>
    </section>
  );
}

function Swatch({ name, className }: { name: string; className: string }) {
  return (
    <div className="min-w-0">
      <div className={cx("h-16 rounded-xl border border-line", className)} />
      <p className="mono-caps mt-1.5 truncate text-[10px] text-faint">{name}</p>
    </div>
  );
}

export default function StyleGuide() {
  const toast = useToast();
  const [dialog, setDialog] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [otp, setOtp] = useState("");
  const [password, setPassword] = useState("");
  const [range, setRange] = useState<"24H" | "7D" | "30D">("7D");
  const [tab, setTab] = useState<"one" | "two" | "three">("one");
  const [step, setStep] = useState(1);
  const [on, setOn] = useState(true);
  const [invalid, setInvalid] = useState(false);

  return (
    <main id="main" className="mx-auto max-w-5xl px-4 py-10 sm:px-8">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <p className="mono-caps text-[11px] text-accent">Design system</p>
          <h1 className="font-display text-3xl font-bold text-strong">
            MediSense <GradientText>style guide</GradientText>
          </h1>
          <p className="mt-1 text-sm text-muted">
            Every token and control, in whichever theme you are testing.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <LanguageToggle />
          <ThemeToggle />
        </div>
      </header>

      <div className="mt-10 space-y-12">
        <Section title="Brand" subtitle="The logo, the pulse, the nodes.">
          <div className="space-y-6">
            <div className="flex flex-wrap items-center gap-8">
              <Logo variant="full" size="lg" />
              <LogoMark className="h-12 w-auto" />
              <div className="brand-panel relative overflow-hidden rounded-2xl px-6 py-5">
                <CircuitNodes density="med" tone="white" />
                <Logo variant="white" size="md" className="relative" />
              </div>
            </div>
            <div className="rounded-2xl border border-line bg-card p-5">
              <EcgLine loop height={48} />
              <p className="mono-caps mt-2 text-[10px] text-faint">EcgLine · loop</p>
            </div>
            <div className="flex items-center gap-6">
              <span className="text-accent">
                <EcgBeat />
              </span>
              <p className="text-sm text-muted">EcgBeat — the empty-state illustration.</p>
            </div>
          </div>
        </Section>

        <Section title="Colour" subtitle="Brand ramp, surfaces, and the semantic set.">
          <div className="space-y-6">
            <div className="bg-gradient-brand h-20 rounded-2xl" />
            <div className="grid grid-cols-3 gap-3 sm:grid-cols-6">
              <Swatch name="primary" className="bg-primary" />
              <Swatch name="primary-soft" className="bg-primary-soft" />
              <Swatch name="accent" className="bg-accent" />
              <Swatch name="accent-bright" className="bg-accent-bright" />
              <Swatch name="accent-soft" className="bg-accent-soft" />
              <Swatch name="gradient-soft" className="bg-gradient-soft" />
              <Swatch name="canvas" className="bg-canvas" />
              <Swatch name="card" className="bg-card" />
              <Swatch name="sunken" className="bg-sunken" />
              <Swatch name="raised" className="bg-raised" />
              <Swatch name="line" className="bg-line" />
              <Swatch name="line-strong" className="bg-line-strong" />
              <Swatch name="stable" className="bg-stable" />
              <Swatch name="warning" className="bg-warning" />
              <Swatch name="critical" className="bg-critical" />
              <Swatch name="info" className="bg-info" />
            </div>
            <div className="flex flex-wrap gap-4 text-sm">
              <span className="text-strong">text-strong</span>
              <span className="text-muted">text-muted</span>
              <span className="text-faint">text-faint</span>
              <span className="text-primary">text-primary</span>
              <span className="text-accent">text-accent</span>
              <span className="text-stable">text-stable</span>
              <span className="text-warning">text-warning</span>
              <span className="text-critical">text-critical</span>
            </div>
          </div>
        </Section>

        <Section title="Type" subtitle="Sora for headings, Inter for reading, JetBrains Mono for data.">
          <div className="space-y-3">
            <p className="font-display text-4xl font-bold text-strong">Aap ki sehat, ek jagah</p>
            <p className="font-display text-2xl font-semibold text-strong">Section heading</p>
            <p className="max-w-[52ch] text-[15px] leading-relaxed text-muted">
              Body text sits at a comfortable measure — around 52 characters — because a line
              longer than that is one the eye loses its place in.
            </p>
            <p className="mono-caps text-[11px] text-faint">Mono caps label · 0.7rem</p>
            <p className="font-mono text-2xl font-bold tabular-nums text-strong">126 / 82 mmHg</p>
          </div>
        </Section>

        <Section title="Buttons">
          <div className="flex flex-wrap items-center gap-3">
            <Button>Primary</Button>
            <Button variant="secondary">Outline</Button>
            <Button variant="ghost">Ghost</Button>
            <Button variant="danger">Danger</Button>
            <Button loading>Saving</Button>
            <Button disabled>Disabled</Button>
            <Button size="lg" className="btn-shine">
              Large with shine
              <Icon name="arrow_forward" className="text-[20px]" />
            </Button>
            <IconButton label="Add" icon="add" tone="primary" />
            <IconButton label="More" icon="more_horiz" />
          </div>
        </Section>

        <Section title="Inputs" subtitle="Floating labels, a brand focus ring, and an honest error.">
          <div className="grid gap-5 sm:grid-cols-2">
            <Field label="Email" htmlFor="sg-email">
              <Input id="sg-email" type="email" />
            </Field>
            <Field
              label="Password"
              htmlFor="sg-password"
              error={invalid ? "That password is too short." : undefined}
            >
              <Input
                id="sg-password"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </Field>
            <Field label="Department" htmlFor="sg-select">
              <Select id="sg-select" defaultValue="cardiology">
                <option value="cardiology">Cardiology</option>
                <option value="general">General Medicine</option>
              </Select>
            </Field>
            <Field label="Notes" htmlFor="sg-notes">
              <Textarea id="sg-notes" rows={3} />
            </Field>
            <div className="space-y-3">
              <PasswordStrength value={password} labels={["Weak", "Fair", "Good", "Strong"]} />
              <Checkbox label="I have saved my backup codes" defaultChecked />
              <Switch checked={on} onChange={setOn} label="Email me about alerts" />
              <Button variant="secondary" onClick={() => setInvalid((value) => !value)}>
                Toggle the error state
              </Button>
            </div>
            <div className="space-y-3">
              <OtpInput value={otp} onChange={setOtp} label="Verification code" autoFocus={false} />
              <p className="text-center text-sm text-muted">
                {otp.length}/6 — paste, backspace and arrows all work.
              </p>
            </div>
          </div>
        </Section>

        <Section title="Selection" subtitle="Segmented, pills, and the stepper.">
          <div className="space-y-6">
            <Segmented
              label="Example tabs"
              value={tab}
              onChange={setTab}
              options={[
                { value: "one", label: "Mareez", icon: "person" },
                { value: "two", label: "Doctor", icon: "stethoscope" },
                { value: "three", label: "Admin", icon: "shield_person" },
              ]}
            />
            <PillGroup
              label="Range"
              value={range}
              onChange={setRange}
              options={[
                { value: "24H", label: "24H" },
                { value: "7D", label: "7D" },
                { value: "30D", label: "30D" },
              ]}
            />
            <div className="rounded-2xl border border-line bg-card p-5">
              <Stepper
                current={step}
                onJump={setStep}
                steps={[
                  { label: "Doctor" },
                  { label: "Date" },
                  { label: "Time" },
                  { label: "Confirm" },
                ]}
              />
              <div className="mt-4 flex gap-2">
                <Button variant="secondary" onClick={() => setStep((s) => Math.max(0, s - 1))}>
                  Back
                </Button>
                <Button onClick={() => setStep((s) => Math.min(3, s + 1))}>Next</Button>
              </div>
            </div>
          </div>
        </Section>

        <Section title="Surfaces">
          <div className="grid gap-4 sm:grid-cols-2">
            <Card title="Default card" description="A bordered surface on the canvas." icon="dashboard">
              <p className="text-sm text-muted">Content sits on generous padding.</p>
            </Card>
            <Card title="Featured" description="Gradient border, for the thing that matters." variant="featured" icon="star">
              <p className="text-sm text-muted">Used for a next appointment, or a chosen plan.</p>
            </Card>
            <Card title="Interactive" description="Lifts and tilts under the cursor." interactive icon="touch_app">
              <p className="text-sm text-muted">Only for cards that lead somewhere.</p>
            </Card>
            <Card title="Glass" description="For anything floating over content." variant="glass" icon="layers">
              <p className="text-sm text-muted">Blurred, translucent, still readable.</p>
            </Card>
          </div>
        </Section>

        <Section title="Data">
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
              <StatTile label="Patients" value={734} icon={<Icon name="personal_injury" />} />
              <StatTile label="Today" value={12} icon={<Icon name="calendar_today" />} trend={{ delta: 8 }} />
              <StatTile label="Open alerts" value={3} tone="critical" icon={<Icon name="notifications_active" />} />
              <StatTile label="Unpaid" value={2} tone="warning" icon={<Icon name="receipt_long" />} href="/styleguide" />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <QuickAction href="/styleguide" icon="calendar_add_on" title="Book a visit" description="Pick a doctor and a time" />
              <QuickAction href="/styleguide" icon="smart_toy" tone="accent" title="Ask the assistant" description="Prescriptions, reports, departments" />
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <Avatar name="Priya Sharma" />
              <Avatar name="Imran Khan" ring="active" />
              <Avatar name="Sara Ali" size="lg" ring="inactive" />
              <Badge tone="good">Confirmed</Badge>
              <Badge tone="warning">Pending</Badge>
              <Badge tone="critical">Critical</Badge>
              <Badge tone="info">Routine</Badge>
              <Badge tone="neutral">Draft</Badge>
            </div>
            <div className="overflow-hidden rounded-2xl border border-line bg-card">
              <table className="table-modern">
                <thead>
                  <tr>
                    <th>Patient</th>
                    <th>Reading</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td className="font-medium text-strong">Priya Sharma</td>
                    <td className="font-mono tabular-nums">126/82</td>
                    <td>
                      <Badge tone="good">In range</Badge>
                    </td>
                  </tr>
                  <tr>
                    <td className="font-medium text-strong">Imran Khan</td>
                    <td className="font-mono tabular-nums">158/97</td>
                    <td>
                      <Badge tone="critical">Out of range</Badge>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </Section>

        <Section title="States" subtitle="Loading, empty, error — every list must handle all three.">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="rounded-2xl border border-line bg-card p-5">
              <Loading label="Loading your readings" />
              <div className="mt-2 space-y-2">
                <Skeleton className="h-4 w-2/3" />
                <Skeleton className="h-4 w-1/2" />
              </div>
            </div>
            <div className="rounded-2xl border border-line bg-card">
              <SkeletonTable rows={3} />
            </div>
            <div className="rounded-2xl border border-line bg-card">
              <EmptyState
                icon="event_available"
                title="No upcoming appointments"
                description="When you book a visit it will appear here."
                action={<Button>Book your first appointment</Button>}
              />
            </div>
            <ErrorState message="We could not reach the server. Check your connection and try again." onRetry={() => {}} />
          </div>
        </Section>

        <Section title="Overlays" subtitle="Dialog, drawer, toast — all portalled, all focus-trapped.">
          <div className="flex flex-wrap gap-3">
            <Button onClick={() => setDialog(true)}>Open dialog</Button>
            <Button variant="secondary" onClick={() => setDrawer(true)}>
              Open drawer
            </Button>
            <Button variant="ghost" onClick={() => toast.show({ title: "Save ho gaya", body: "Aap ki tabdeeli mehfooz hai." })}>
              Success toast
            </Button>
            <Button variant="ghost" onClick={() => toast.show({ tone: "warning", title: "Code expire ho gaya" })}>
              Warning toast
            </Button>
            <Button variant="ghost" onClick={() => toast.show({ tone: "critical", title: "Server tak nahi pahunch sake" })}>
              Critical toast
            </Button>
          </div>

          <Dialog
            open={dialog}
            onClose={() => setDialog(false)}
            title="Do-qadmi tasdeeq"
            description="An example of the dialog's shape."
            icon="shield_person"
            footer={
              <>
                <Button variant="ghost" onClick={() => setDialog(false)}>
                  Cancel
                </Button>
                <Button onClick={() => setDialog(false)}>Confirm</Button>
              </>
            }
          >
            <p className="text-sm text-muted">
              Escape closes, focus is trapped, and the backdrop blurs what is behind.
            </p>
          </Dialog>

          <Drawer
            open={drawer}
            onClose={() => setDrawer(false)}
            title="Review panel"
            description="The shape the admin review uses."
            footer={
              <>
                <Button variant="ghost" onClick={() => setDrawer(false)}>
                  Close
                </Button>
                <Button onClick={() => setDrawer(false)}>Approve</Button>
              </>
            }
          >
            <p className="text-sm text-muted">Slides in with a spring and slides back out.</p>
          </Drawer>
        </Section>

        <Section title="Moments" subtitle="What a completed action looks like.">
          <div className="flex flex-wrap items-center gap-8 rounded-2xl border border-line bg-card p-8">
            <SuccessMark />
            <div>
              <p className="font-display text-lg font-bold text-strong">Appointment booked!</p>
              <p className="text-sm text-muted">The pulse draws itself into a check.</p>
            </div>
          </div>
        </Section>
      </div>

      <footer className="mt-16 border-t border-line pt-6">
        <EcgLine height={28} />
        <p className="mt-3 text-xs text-faint">
          This page is not linked from the product. It exists so the system can be reviewed in one
          place, in both themes.
        </p>
      </footer>
    </main>
  );
}
