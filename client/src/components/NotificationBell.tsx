"use client";

/**
 * Unread notifications, in a panel that opens from the header.
 *
 * Notification text is deliberately thin — an appointment moved, a booking was
 * confirmed — because these strings also reach places outside the access-control
 * boundary once email delivery lands. Anything clinical stays behind the link.
 */

import { AnimatePresence, motion } from "framer-motion";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";

import { Icon } from "@/components/Icon";
import { Button, EmptyState, cx } from "@/components/ui";
import { notifications, type Notification, type Role } from "@/lib/api";
import { useTr } from "@/lib/lang";
import { useAsync } from "@/lib/useAsync";

/** Every role that receives appointment notifications has its own list page. */
const APPOINTMENTS_PATH: Partial<Record<Role, string>> = {
  PATIENT: "/patient/appointments",
  DOCTOR: "/doctor/appointments",
  ADMIN: "/admin/appointments",
};

function timeAgo(iso: string): string {
  const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** An icon for the kind of thing that happened. */
function iconFor(type: string): string {
  const key = type.toLowerCase();
  if (key.includes("appointment")) return "calendar_today";
  if (key.includes("alert") || key.includes("vital")) return "monitor_heart";
  if (key.includes("invoice") || key.includes("billing")) return "receipt_long";
  if (key.includes("emergency")) return "e911_emergency";
  if (key.includes("document")) return "description";
  return "notifications";
}

export function NotificationBell({ role }: { role: Role }) {
  const tr = useTr();
  const [open, setOpen] = useState(false);
  const panel = useRef<HTMLDivElement>(null);

  // useAsync writes state only from its async continuation, which is what keeps
  // this out of the cascading-render pattern React 19 warns about. A 401 is
  // swallowed there and handled globally by SessionProvider — the bell is
  // peripheral and must never take a page down with it.
  const { data, error, reload } = useAsync(() => notifications.list({ limit: 15 }), []);
  const items: Notification[] = data?.data ?? [];
  const unread = data?.meta.unread ?? 0;

  const load = useCallback(() => reload(), [reload]);

  // Close on outside click and on Escape, the two ways people expect to dismiss
  // a popover.
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => {
      if (panel.current && !panel.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const markAll = async () => {
    await notifications.markAllRead();
    load();
  };

  return (
    <div ref={panel} className="relative">
      <button
        type="button"
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={unread > 0 ? `Notifications, ${unread} unread` : "Notifications"}
        onClick={() => {
          setOpen((value) => !value);
          if (!open) void load();
        }}
        className={cx(
          "group relative grid h-11 w-11 place-items-center rounded-full text-muted transition-[background-color,color,transform] duration-200 hover:scale-105 hover:bg-gradient-soft hover:text-primary",
          "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary",
          open && "bg-gradient-soft text-primary",
        )}
      >
        <Icon name="notifications" filled={open || unread > 0} className="icon-ring text-[24px]" />
        {unread > 0 && (
          <span className="absolute right-2 top-2 flex h-2.5 w-2.5">
            <span className="pulse-dot absolute inline-flex h-full w-full rounded-full bg-critical" />
            <span className="sr-only">{unread}</span>
          </span>
        )}
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            role="dialog"
            aria-label="Notifications"
            initial={{ opacity: 0, scale: 0.92, y: -6 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: -4 }}
            transition={{ type: "spring", stiffness: 420, damping: 34, mass: 0.8 }}
            style={{ transformOrigin: "top right" }}
            className="glass absolute right-0 z-50 mt-2 w-[22rem] max-w-[calc(100vw-2rem)] overflow-hidden rounded-2xl"
          >
            <div className="flex items-center gap-2 border-b border-line/70 px-4 py-3">
              <Icon name="notifications" className="text-[20px] text-primary" />
              <p className="font-display font-bold text-strong">{tr("Notifications", "Ittilaat")}</p>
              {unread > 0 && (
                <span className="rounded-full bg-critical-soft px-2 py-px text-xs font-bold tabular-nums text-critical">
                  {unread}
                </span>
              )}
              {unread > 0 && (
                <Button variant="ghost" className="ml-auto !min-h-9 px-2 text-sm" onClick={() => void markAll()}>
                  {tr("Mark all read", "Sab parh liye")}
                </Button>
              )}
            </div>

            <div className="max-h-96 overflow-y-auto">
              {error && (
                <p role="alert" className="px-4 py-3 text-sm text-critical">
                  {error.message}
                </p>
              )}
              {!error && items.length === 0 && (
                <div className="px-4">
                  <EmptyState
                    icon="notifications_off"
                    title={tr("Nothing to catch up on", "Kuchh naya nahi")}
                    description={tr("You are up to date.", "Aap up to date hain.")}
                  />
                </div>
              )}
              <ul className="divide-y divide-line/70">
                {items.map((item, index) => (
                  <motion.li
                    key={item.id}
                    initial={{ opacity: 0, y: -6 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: Math.min(index, 6) * 0.04 }}
                    className={cx("px-4 py-3 transition-colors", !item.readAt && "bg-gradient-soft")}
                  >
                    <div className="flex items-start gap-3">
                      <span
                        aria-hidden
                        className={cx(
                          "mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-xl",
                          item.readAt ? "bg-sunken text-faint" : "bg-gradient-brand text-white shadow-sm",
                        )}
                      >
                        <Icon name={iconFor(item.type)} className="text-[20px]" />
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-semibold text-strong">{item.title}</p>
                        <p className="mt-0.5 text-sm text-muted">{item.body}</p>
                        <p className="mt-1 text-xs text-faint">{timeAgo(item.createdAt)}</p>
                      </div>
                      {!item.readAt && (
                        <button
                          type="button"
                          onClick={() => {
                            void notifications.markRead(item.id).then(load);
                          }}
                          className="shrink-0 rounded-full px-2 py-1 text-xs font-semibold text-primary transition-colors hover:bg-primary-soft focus-visible:outline-2 focus-visible:outline-primary"
                        >
                          {tr("Mark read", "Parh liya")}
                        </button>
                      )}
                    </div>
                  </motion.li>
                ))}
              </ul>
            </div>

            {APPOINTMENTS_PATH[role] && (
              <div className="border-t border-line/70 px-4 py-2.5">
                <Link
                  href={APPOINTMENTS_PATH[role]}
                  onClick={() => setOpen(false)}
                  className="inline-flex items-center gap-1 text-sm font-semibold text-primary hover:underline"
                >
                  {tr("View appointments", "Appointments dekhein")}
                  <Icon name="arrow_forward" className="text-[16px]" />
                </Link>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
