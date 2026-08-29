"use client";

/**
 * Things that float over the page: dialogs, drawers, and toasts.
 *
 * All three share one set of rules. They render into `document.body` through a
 * portal, so no ancestor's `overflow` or stacking context can clip them. They
 * trap focus while open and return it where it was on close, because a control
 * that steals focus and does not give it back strands a keyboard user. And they
 * animate in *and out* — an element that vanishes reads as a bug, however fast
 * it appeared.
 */

import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

import { Icon } from "@/components/Icon";
import { cx } from "@/components/ui";
// Portals need the document, which the server does not have.
import { useHydrated as useMounted } from "@/lib/useHydrated";

const SPRING = { type: "spring", stiffness: 420, damping: 34, mass: 0.85 } as const;

/**
 * Keeps Tab inside `ref` while `active`, and restores focus on unmount.
 *
 * Written by hand rather than pulled in: the whole behaviour is "find the
 * focusable children, wrap at the ends", and a dependency for that would be
 * larger than the code.
 */
function useFocusTrap(ref: React.RefObject<HTMLElement | null>, active: boolean) {
  useEffect(() => {
    if (!active) return;
    const previous = document.activeElement as HTMLElement | null;
    const container = ref.current;

    const focusables = () =>
      Array.from(
        container?.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      ).filter((element) => element.offsetParent !== null);

    // Focus the first control, or the panel itself when it holds none.
    const first = focusables()[0] ?? container;
    first?.focus({ preventScroll: true });

    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const items = focusables();
      if (items.length === 0) return;
      const start = items[0];
      const end = items[items.length - 1];
      if (event.shiftKey && document.activeElement === start) {
        event.preventDefault();
        end.focus();
      } else if (!event.shiftKey && document.activeElement === end) {
        event.preventDefault();
        start.focus();
      }
    };

    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      previous?.focus?.({ preventScroll: true });
    };
  }, [active, ref]);
}

/** Escape closes; the page behind stops scrolling. */
function useDismiss(open: boolean, onClose: () => void) {
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
    };
  }, [open, onClose]);
}

// ---------------------------------------------------------------------------
// Dialog
// ---------------------------------------------------------------------------

export function Dialog({
  open,
  onClose,
  title,
  description,
  icon,
  children,
  footer,
  size = "md",
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  /** A Material Symbol, shown in a gradient square beside the title. */
  icon?: string;
  children: ReactNode;
  /** Actions. Right-aligned by convention: ghost cancel, then the commit. */
  footer?: ReactNode;
  size?: "sm" | "md" | "lg";
}) {
  const mounted = useMounted();
  const reduced = useReducedMotion();
  const panel = useRef<HTMLDivElement>(null);
  const labelId = useId();
  useFocusTrap(panel, open);
  useDismiss(open, onClose);

  const widths = { sm: "max-w-sm", md: "max-w-lg", lg: "max-w-2xl" } as const;
  if (!mounted) return null;

  return createPortal(
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
          <motion.button
            type="button"
            aria-label="Close"
            tabIndex={-1}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="absolute inset-0 cursor-default bg-[#071129]/55 backdrop-blur-sm"
          />
          <motion.div
            ref={panel}
            role="dialog"
            aria-modal="true"
            aria-labelledby={labelId}
            tabIndex={-1}
            initial={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.95, y: 8 }}
            animate={reduced ? { opacity: 1 } : { opacity: 1, scale: 1, y: 0 }}
            exit={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.96, y: 6 }}
            transition={SPRING}
            className={cx(
              "relative max-h-[calc(100dvh-2rem)] w-full overflow-y-auto rounded-2xl border border-line bg-card shadow-float",
              widths[size],
            )}
          >
            <header className="flex items-start gap-3 border-b border-line px-6 py-5">
              {icon && (
                <span
                  aria-hidden
                  className="bg-gradient-brand grid h-11 w-11 shrink-0 place-items-center rounded-xl text-white shadow-sm"
                >
                  <Icon name={icon} filled className="text-[22px]" />
                </span>
              )}
              <div className="min-w-0 flex-1">
                <h2 id={labelId} className="font-display text-lg font-bold text-strong">
                  {title}
                </h2>
                {description && <p className="mt-1 text-sm text-muted">{description}</p>}
              </div>
              <button
                type="button"
                aria-label="Close"
                onClick={onClose}
                className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-muted transition-[background-color,color,transform] hover:rotate-90 hover:scale-110 hover:bg-sunken hover:text-strong focus-visible:outline-2 focus-visible:outline-primary"
              >
                <Icon name="close" className="text-[20px]" />
              </button>
            </header>

            <div className="px-6 py-5">{children}</div>

            {footer && (
              <footer className="flex flex-wrap items-center justify-end gap-2 border-t border-line px-6 py-4">
                {footer}
              </footer>
            )}
          </motion.div>
        </div>
      )}
    </AnimatePresence>,
    document.body,
  );
}

// ---------------------------------------------------------------------------
// Drawer
// ---------------------------------------------------------------------------

export function Drawer({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  side = "right",
  width = 560,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
  /** Sticky, so the commit stays reachable in a long panel. */
  footer?: ReactNode;
  side?: "right" | "left";
  width?: number;
}) {
  const mounted = useMounted();
  const reduced = useReducedMotion();
  const panel = useRef<HTMLDivElement>(null);
  const labelId = useId();
  useFocusTrap(panel, open);
  useDismiss(open, onClose);

  if (!mounted) return null;
  const offset = side === "right" ? width : -width;

  return createPortal(
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-[100]">
          <motion.button
            type="button"
            aria-label="Close"
            tabIndex={-1}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="absolute inset-0 cursor-default bg-[#071129]/55 backdrop-blur-sm"
          />
          <motion.aside
            ref={panel}
            role="dialog"
            aria-modal="true"
            aria-labelledby={labelId}
            tabIndex={-1}
            initial={reduced ? { opacity: 0 } : { x: offset }}
            animate={reduced ? { opacity: 1 } : { x: 0 }}
            exit={reduced ? { opacity: 0 } : { x: offset }}
            transition={{ type: "spring", stiffness: 360, damping: 36 }}
            style={{ width }}
            className={cx(
              "absolute inset-y-0 flex max-w-[92vw] flex-col border-line bg-card shadow-float",
              side === "right" ? "right-0 border-l" : "left-0 border-r",
            )}
          >
            <header className="flex items-start gap-3 border-b border-line px-5 py-4">
              <div className="min-w-0 flex-1">
                <h2 id={labelId} className="font-display text-lg font-bold text-strong">
                  {title}
                </h2>
                {description && <p className="mt-0.5 text-sm text-muted">{description}</p>}
              </div>
              <button
                type="button"
                aria-label="Close"
                onClick={onClose}
                className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-muted transition-[background-color,color,transform] hover:rotate-90 hover:bg-sunken hover:text-strong focus-visible:outline-2 focus-visible:outline-primary"
              >
                <Icon name="close" className="text-[20px]" />
              </button>
            </header>

            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">{children}</div>

            {footer && (
              <footer className="flex flex-wrap items-center justify-end gap-2 border-t border-line bg-card px-5 py-4">
                {footer}
              </footer>
            )}
          </motion.aside>
        </div>
      )}
    </AnimatePresence>,
    document.body,
  );
}

// ---------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------

export type ToastTone = "success" | "warning" | "critical" | "info";

interface Toast {
  id: number;
  tone: ToastTone;
  title: string;
  body?: string;
  duration: number;
}

interface ToastApi {
  show: (toast: { tone?: ToastTone; title: string; body?: string; duration?: number }) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

/**
 * Confirms what just happened, in the words of the button that did it.
 *
 * Deliberately not a place for errors that need a decision: those belong in the
 * form, next to the control. A toast is for "it worked", and for the rare
 * failure a person cannot act on from here.
 */
export function useToast(): ToastApi {
  const context = useContext(ToastContext);
  // A no-op rather than a throw: a component that toasts should still render
  // in a test that did not mount the provider.
  return context ?? { show: () => {} };
}

const TONES: Record<ToastTone, { icon: string; bar: string; text: string }> = {
  success: { icon: "check_circle", bar: "bg-stable", text: "text-stable" },
  warning: { icon: "warning", bar: "bg-warning", text: "text-warning" },
  critical: { icon: "error", bar: "bg-critical", text: "text-critical" },
  info: { icon: "info", bar: "bg-info", text: "text-info" },
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const mounted = useMounted();
  const reduced = useReducedMotion();
  const nextId = useRef(0);

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const show = useCallback<ToastApi["show"]>(
    ({ tone = "success", title, body, duration = 5000 }) => {
      const id = (nextId.current += 1);
      setToasts((current) => [...current.slice(-2), { id, tone, title, body, duration }]);
      window.setTimeout(() => dismiss(id), duration);
    },
    [dismiss],
  );

  const api = useMemo(() => ({ show }), [show]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      {mounted &&
        createPortal(
          <div
            aria-live="polite"
            className="pointer-events-none fixed right-4 top-4 z-[110] flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-2"
          >
            <AnimatePresence initial={false}>
              {toasts.map((toast, index) => {
                const tone = TONES[toast.tone];
                // Older toasts recede: the newest is at full size in front.
                const depth = toasts.length - 1 - index;
                return (
                  <motion.div
                    key={toast.id}
                    layout
                    initial={reduced ? { opacity: 0 } : { opacity: 0, x: 40, scale: 0.95 }}
                    animate={
                      reduced
                        ? { opacity: 1 }
                        : { opacity: 1, x: 0, scale: 1 - depth * 0.03, y: depth * 2 }
                    }
                    exit={reduced ? { opacity: 0 } : { opacity: 0, x: 40, scale: 0.95 }}
                    transition={SPRING}
                    className="glass pointer-events-auto relative overflow-hidden rounded-2xl"
                  >
                    <span aria-hidden className={cx("absolute inset-y-0 left-0 w-1", tone.bar)} />
                    <div className="flex items-start gap-3 py-3 pl-5 pr-3">
                      <span aria-hidden className={cx("pop-scale mt-0.5 shrink-0", tone.text)}>
                        <Icon name={tone.icon} filled className="text-[22px]" />
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-semibold text-strong">{toast.title}</p>
                        {toast.body && <p className="mt-0.5 text-sm text-muted">{toast.body}</p>}
                      </div>
                      <button
                        type="button"
                        aria-label="Dismiss"
                        onClick={() => dismiss(toast.id)}
                        className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-faint transition-colors hover:bg-sunken hover:text-strong focus-visible:outline-2 focus-visible:outline-primary"
                      >
                        <Icon name="close" className="text-[18px]" />
                      </button>
                    </div>
                    {/* How long is left, as a line that runs out. */}
                    <motion.span
                      aria-hidden
                      initial={{ scaleX: 1 }}
                      animate={{ scaleX: 0 }}
                      transition={{ duration: toast.duration / 1000, ease: "linear" }}
                      className={cx("absolute bottom-0 left-0 h-0.5 w-full origin-left", tone.bar)}
                    />
                  </motion.div>
                );
              })}
            </AnimatePresence>
          </div>,
          document.body,
        )}
    </ToastContext.Provider>
  );
}
