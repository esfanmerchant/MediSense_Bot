"use client";

/**
 * What the system will tell you about — and nothing you can switch.
 *
 * **One real switch, and no fake ones.** Push on this device is a thing the
 * server can genuinely act on, so it gets a control. Per-type preferences have
 * no endpoint to save to, so they get none: a row of toggles that looks live
 * and saves nowhere is worse than no toggles at all — it teaches someone they
 * have turned off a vital-sign alert they will still be sent, and the first
 * time that matters is the time it matters most. For those, this tab does the
 * one honest thing available: it says exactly what the server sends, to whom,
 * and by which channel.
 *
 * The list is not decoration: it is read off the notification types the API
 * actually dispatches, so a reader can predict their inbox.
 */

import { Icon } from "@/components/Icon";
import { PushToggle } from "@/components/settings/PushToggle";
import { Badge, Card, cx } from "@/components/ui";
import { useTr } from "@/lib/lang";
import type { Role } from "@/lib/api";

interface NotificationKind {
  icon: string;
  title: [string, string];
  description: [string, string];
  /** Also sent by email — deliberately saying less than the in-app copy. */
  emailed: boolean;
  /** Also pushed to enrolled devices. Reserved for what is useless seen late. */
  pushed: boolean;
  roles: Role[];
}

const KINDS: NotificationKind[] = [
  {
    icon: "calendar_today",
    title: ["Appointments", "Appointments"],
    description: [
      "Booked, moved, cancelled, and a reminder before the visit. Both the patient and the doctor are told.",
      "Book hona, waqt badalna, cancel hona, aur visit se pehle reminder. Mareez aur doctor dono ko jata hai.",
    ],
    emailed: true,
    pushed: true,
    roles: ["PATIENT", "DOCTOR"],
  },
  {
    icon: "monitor_heart",
    title: ["Vital alerts", "Vitals ke alerts"],
    description: [
      "A recorded reading crossing its configured threshold. It goes to the treating doctor, with the measured value in it.",
      "Koi reading apni muqarrar hadd paar kare to. Yeh ilaaj karne wale doctor ko jata hai, reading ke saath.",
    ],
    emailed: true,
    pushed: true,
    roles: ["DOCTOR"],
  },
  {
    icon: "e911_emergency",
    title: ["Emergency access", "Emergency access"],
    description: [
      "Your record being opened under break-glass access — you are told, and so is an administrator, who reviews it.",
      "Aap ka record emergency mein khola jaye to — aap ko bhi bataya jata hai aur admin ko bhi, jo isay review karta hai.",
    ],
    emailed: true,
    pushed: true,
    roles: ["PATIENT", "ADMIN"],
  },
  {
    icon: "payments",
    title: ["Invoices", "Invoices"],
    description: [
      "A new invoice issued for a completed consultation.",
      "Mukammal consultation ke liye nayi invoice bane to.",
    ],
    emailed: true,
    pushed: false,
    roles: ["PATIENT", "ADMIN"],
  },
  {
    icon: "description",
    title: ["New documents", "Naye documents"],
    description: [
      "A report or scan added to your record. In the portal only — a result never leaves it.",
      "Aap ke record mein report ya scan add ho to. Sirf portal mein — result kabhi bahar nahi jata.",
    ],
    emailed: false,
    pushed: false,
    roles: ["PATIENT"],
  },
  {
    icon: "medication",
    title: ["Medication reminders", "Dawa ke reminders"],
    description: [
      "A dose due, at times you set yourself on the prescription. Pushed to your devices — never emailed.",
      "Dose ka waqt, jo aap khud prescription par muqarrar karte hain. Aap ke devices par push hota hai — email kabhi nahi.",
    ],
    emailed: false,
    pushed: true,
    roles: ["PATIENT"],
  },
  {
    icon: "shield_person",
    title: ["Account security", "Account ki hifazat"],
    description: [
      "A password change, a new sign-in, two-factor being turned on or off.",
      "Password badalna, naya sign-in, ya two-factor on/off hona.",
    ],
    emailed: true,
    pushed: true,
    roles: ["PATIENT", "DOCTOR", "ADMIN", "NURSE"],
  },
];

export function NotificationsTab({ role }: { role: Role }) {
  const tr = useTr();
  const kinds = KINDS.filter((kind) => kind.roles.includes(role));

  return (
    <div className="space-y-6">
      {/* role="status": the tab is a statement, and the statement is the point. */}
      <div
        role="status"
        className="border-gradient flex items-start gap-3 rounded-2xl p-4 shadow-card"
      >
        <span
          aria-hidden
          className="bg-gradient-soft grid h-10 w-10 shrink-0 place-items-center rounded-xl text-primary"
        >
          <Icon name="info" className="text-[22px]" />
        </span>
        <p className="text-sm leading-relaxed text-strong">
          <strong className="font-semibold">
            {tr(
              "You can switch this device on or off. Which notifications you get is not yet a choice.",
              "Is device ko on ya off aap kar sakte hain. Kaun se notifications aayenge, yeh abhi tabdeel nahi hota.",
            )}
          </strong>{" "}
          <span className="text-muted">
            {tr(
              "There is nowhere to save per-notification preferences yet, so the list below describes what the system actually sends rather than pretending to control it. All of it is on.",
              "Har notification ki alag setting save karne ki abhi koi jagah nahi, is liye neeche di gayi fehrist sirf yeh batati hai ke system asal mein kya bhejta hai — control ka jhoota wada nahi karti. Yeh sab on hai.",
            )}
          </span>
        </p>
      </div>

      <PushToggle />

      <Card
        title={tr("What you are notified about", "Aap ko kis cheez ki ittila di jati hai")}
        description={tr(
          "Every one of these reaches you in the portal. The badges say which also travel by email or to your devices.",
          "In sab ki ittila portal mein milti hai. Nishaan batate hain ke kaun se email ya aap ke devices par bhi jate hain.",
        )}
        icon="notifications"
        flush
      >
        <ul className="divide-y divide-line">
          {kinds.map((kind) => (
            <li key={kind.title[0]} className="flex items-start gap-4 px-6 py-4">
              <span
                aria-hidden
                className="bg-gradient-soft grid h-10 w-10 shrink-0 place-items-center rounded-xl text-primary"
              >
                <Icon name={kind.icon} className="text-[20px]" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-[0.9375rem] font-semibold text-strong">{tr(...kind.title)}</p>
                <p className="mt-0.5 text-sm leading-relaxed text-muted">
                  {tr(...kind.description)}
                </p>
              </div>
              <div className="flex shrink-0 flex-col items-end gap-1">
                <Badge tone="good">
                  <Icon name="check" className="text-[14px]" />
                  {tr("In app", "App mein")}
                </Badge>
                {kind.emailed && (
                  <Badge tone="info">
                    <Icon name="mail" className="text-[14px]" />
                    {tr("Email", "Email")}
                  </Badge>
                )}
                {kind.pushed && (
                  <Badge tone="info">
                    <Icon name="notifications_active" className="text-[14px]" />
                    {tr("Push", "Push")}
                  </Badge>
                )}
              </div>
            </li>
          ))}
        </ul>
      </Card>

      <Card
        title={tr("Why an email says less", "Email kam kyun kehti hai")}
        icon="lock"
      >
        <p className={cx("text-sm leading-relaxed text-muted")}>
          {tr(
            "An in-app notification is read inside your session, behind a sign-in. An email crosses to a mail provider, sits on their servers and lands on a lock screen anyone nearby can read. So an email names the kind of thing that happened and where to go and see it — appointment times and invoice numbers included, because a reminder that withholds the time is not a reminder. Diagnoses, symptoms and results stay in the portal. A push is different again: it is encrypted to your device before it leaves us, and the service that carries it cannot read it — which is why a dose reminder may name the medicine, and an email never does.",
            "App ke andar notification aap ke session mein, sign-in ke peeche parhi jati hai. Email mail provider tak jati hai, un ke servers par rehti hai, aur lock screen par aati hai jahan qareeb khara koi bhi parh sakta hai. Is liye email sirf yeh batati hai ke kis qism ka waqia hua aur kahan dekhna hai — appointment ka waqt aur invoice number shamil, kyunke waqt chhupane wala reminder reminder nahi hota. Tashkhees, alamat aur results portal hi mein rehte hain. Push is se mukhtalif hai: woh aap ke device ke liye yahan se hi encrypt ho kar jata hai, aur beech mein le jane wali service usay parh nahi sakti — is liye dawa ka reminder dawa ka naam le sakta hai, aur email kabhi nahi.",
          )}
        </p>
      </Card>
    </div>
  );
}
