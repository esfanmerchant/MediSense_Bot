"use client";

/**
 * Unread notifications, in a panel that opens from the header.
 *
 * Notification text is deliberately thin — an appointment moved, a booking was
 * confirmed — because these strings also reach places outside the access-control
 * boundary once email delivery lands. Anything clinical stays behind the link.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";

import { Button, cx } from "@/components/ui";
import { notifications, type Notification, type Role } from "@/lib/api";
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

export function NotificationBell({ role }: { role: Role }) {
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
          "relative inline-flex min-h-11 min-w-11 items-center justify-center rounded-md",
            "text-muted hover:bg-sunken",
              "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary",
        )}
      >
        <svg aria-hidden viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor">
          <path
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M6 8a6 6 0 1 1 12 0c0 4 1.5 5.5 1.5 5.5h-15S6 12 6 8Z M10 18a2 2 0 0 0 4 0"
          />
        </svg>
        {unread > 0 && (
          <span className="absolute right-1 top-1 min-w-5 rounded-full bg-primary px-1.5 text-xs font-semibold tabular-nums text-white">
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Notifications"
          className="absolute right-0 z-50 mt-2 w-80 max-w-[calc(100vw-2rem)] rounded-lg border border-line bg-card shadow-lg "
        >
          <div className="flex items-center gap-2 border-b border-line px-4 py-3">
            <p className="font-medium text-strong">Notifications</p>
            {unread > 0 && (
              <Button variant="ghost" className="ml-auto !min-h-9 px-2 text-sm" onClick={() => void markAll()}>
                Mark all read
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
              <p className="px-4 py-6 text-center text-sm text-muted">
                Nothing to catch up on.
              </p>
            )}
            <ul className="divide-y divide-line">
              {items.map((item) => (
                <li
                  key={item.id}
                  className={cx("px-4 py-3", !item.readAt && "bg-accent-soft/60")}
                >
                  <div className="flex items-start gap-2">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-strong">
                        {item.title}
                      </p>
                      <p className="mt-0.5 text-sm text-muted">
                        {item.body}
                      </p>
                      <p className="mt-1 text-xs text-faint">
                        {timeAgo(item.createdAt)}
                      </p>
                    </div>
                    {!item.readAt && (
                      <button
                        type="button"
                        onClick={() => {
                          void notifications.markRead(item.id).then(load);
                        }}
                        className="shrink-0 rounded px-1.5 py-1 text-xs font-medium text-teal-800 hover:bg-teal-100 focus-visible:outline-2 focus-visible:outline-primary dark:hover:bg-teal-950"
                      >
                        Mark read
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </div>

          {APPOINTMENTS_PATH[role] && (
            <div className="border-t border-line px-4 py-2">
              <Link
                href={APPOINTMENTS_PATH[role]}
                onClick={() => setOpen(false)}
                className="text-sm font-medium text-teal-800 hover:underline"
              >
                View appointments
              </Link>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
