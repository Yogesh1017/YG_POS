"use client";
// Small, dependency-free UI kit used across the app.
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import { Loader2, X } from "lucide-react";
import { useEffect, useId, useRef, useState, type ComponentProps, type ReactNode } from "react";

/** Join class names; later Tailwind classes override earlier conflicting ones (e.g. w-44 beats w-full). */
export const cn = (...inputs: ClassValue[]) => twMerge(clsx(inputs));

type ButtonProps = ComponentProps<"button"> & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "sm" | "md" | "lg";
  loading?: boolean;
};

export function Button({ variant = "secondary", size = "md", loading, className, children, disabled, type = "button", ...rest }: ButtonProps) {
  return (
    <button
      type={type}
      disabled={disabled || loading}
      className={cn(
        "inline-flex items-center justify-center gap-2 rounded-md font-medium whitespace-nowrap transition-colors select-none disabled:opacity-50",
        size === "sm" && "h-8 px-2.5 text-sm",
        size === "md" && "h-10 px-4 text-sm",
        size === "lg" && "h-12 px-5 text-base",
        variant === "primary" && "bg-primary text-primary-fg hover:bg-primary-hover",
        variant === "secondary" && "border border-border bg-surface hover:bg-surface-2",
        variant === "ghost" && "hover:bg-surface-2",
        variant === "danger" && "bg-danger text-white hover:opacity-90",
        className,
      )}
      {...rest}
    >
      {loading && <Loader2 className="size-4 animate-spin" aria-hidden />}
      {children}
    </button>
  );
}

const fieldBase =
  "h-10 w-full rounded-md border border-border bg-surface px-3 text-sm placeholder:text-muted/70 disabled:opacity-60 aria-[invalid=true]:border-danger";

export function Input({ className, ...rest }: ComponentProps<"input">) {
  return <input className={cn(fieldBase, className)} {...rest} />;
}
export function Select({ className, children, ...rest }: ComponentProps<"select">) {
  return (
    <select className={cn(fieldBase, "pr-8", className)} {...rest}>
      {children}
    </select>
  );
}
export function Textarea({ className, ...rest }: ComponentProps<"textarea">) {
  return <textarea className={cn(fieldBase, "h-auto min-h-20 py-2", className)} {...rest} />;
}

/** Label + control + hint/error, wired up for screen readers. */
export function Field({ label, error, hint, children, className }: {
  label: string; error?: string; hint?: string; className?: string;
  children: (props: { id: string; "aria-invalid": boolean; "aria-describedby"?: string }) => ReactNode;
}) {
  const id = useId();
  const descId = `${id}-desc`;
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <label htmlFor={id} className="text-sm font-medium">{label}</label>
      {children({ id, "aria-invalid": !!error, "aria-describedby": error || hint ? descId : undefined })}
      {error ? <p id={descId} className="text-xs text-danger">{error}</p> : hint ? <p id={descId} className="text-xs text-muted">{hint}</p> : null}
    </div>
  );
}

export function Checkbox({ label, hint, ...rest }: ComponentProps<"input"> & { label: string; hint?: string }) {
  return (
    <label className="flex items-start gap-2.5 text-sm">
      <input type="checkbox" className="mt-0.5 size-4 accent-(--primary)" {...rest} />
      <span>
        <span className="font-medium">{label}</span>
        {hint && <span className="block text-xs text-muted">{hint}</span>}
      </span>
    </label>
  );
}

export function Dialog({ open, onClose, title, children, footer, wide }: {
  open: boolean; onClose: () => void; title: string; children: ReactNode; footer?: ReactNode; wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);
  if (!open) return null;
  return (
    <dialog
      ref={ref}
      onCancel={(e) => { e.preventDefault(); onClose(); }}
      onMouseDown={(e) => e.target === ref.current && onClose()}
      className={cn("m-auto w-[calc(100vw-1.5rem)] rounded-xl border border-border bg-surface p-0 shadow-2xl", wide ? "max-w-3xl" : "max-w-lg")}
    >
      <div className="flex max-h-[calc(100dvh-2rem)] flex-col">
        <header className="flex items-center justify-between gap-4 border-b border-border px-5 py-3.5">
          <h2 className="text-base font-semibold">{title}</h2>
          <button onClick={onClose} aria-label="Close" className="rounded-md p-1.5 text-muted hover:bg-surface-2"><X className="size-4" /></button>
        </header>
        <div className="overflow-y-auto px-5 py-4">{children}</div>
        {footer && <footer className="flex flex-wrap justify-end gap-2 border-t border-border px-5 py-3">{footer}</footer>}
      </div>
    </dialog>
  );
}

export function Badge({ tone = "neutral", children }: { tone?: "neutral" | "success" | "warn" | "danger"; children: ReactNode }) {
  return (
    <span className={cn(
      "inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium",
      tone === "neutral" && "bg-surface-2 text-muted",
      tone === "success" && "bg-primary-soft text-primary",
      tone === "warn" && "bg-warn-soft text-warn",
      tone === "danger" && "bg-danger-soft text-danger",
    )}>{children}</span>
  );
}

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return <section className={cn("rounded-xl border border-border bg-surface", className)}>{children}</section>;
}

export function Spinner({ label = "Loading…" }: { label?: string }) {
  return (
    <div role="status" className="flex items-center justify-center gap-2 p-10 text-sm text-muted">
      <Loader2 className="size-4 animate-spin" aria-hidden /> {label}
    </div>
  );
}

export function EmptyState({ icon, title, children, action }: { icon?: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-14 text-center">
      {icon && <div className="mb-1 text-muted [&>svg]:size-8">{icon}</div>}
      <p className="font-medium">{title}</p>
      {children && <p className="max-w-sm text-sm text-muted">{children}</p>}
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}

export function ErrorNote({ children, onRetry }: { children: ReactNode; onRetry?: () => void }) {
  return (
    <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-danger/40 bg-danger-soft px-4 py-3 text-sm text-danger">
      <span>{children}</span>
      {onRetry && <Button size="sm" onClick={onRetry}>Try again</Button>}
    </div>
  );
}

export function PageHeader({ title, description, actions }: { title: string; description?: string; actions?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="mt-0.5 text-sm text-muted">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export const th = "px-3 py-2.5 text-left text-xs font-medium uppercase tracking-wide text-muted whitespace-nowrap";
export const td = "px-3 py-2.5 align-middle";

/** Ask for confirmation (optionally with a required typed reason) before a destructive action. */
export function ConfirmDialog({ open, title, message, confirmLabel = "Confirm", danger, reasonLabel, onConfirm, onClose }: {
  open: boolean; title: string; message: ReactNode; confirmLabel?: string; danger?: boolean;
  reasonLabel?: string; onConfirm: (reason: string) => Promise<void> | void; onClose: () => void;
}) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) setReason(""); }, [open]);
  const run = async () => {
    setBusy(true);
    try { await onConfirm(reason.trim()); } finally { setBusy(false); }
  };
  return (
    <Dialog open={open} onClose={onClose} title={title} footer={
      <>
        <Button onClick={onClose} disabled={busy}>Keep</Button>
        <Button variant={danger ? "danger" : "primary"} loading={busy} disabled={!!reasonLabel && reason.trim().length < 3} onClick={run}>{confirmLabel}</Button>
      </>
    }>
      <div className="space-y-4 text-sm">
        <div>{message}</div>
        {reasonLabel && (
          <Field label={reasonLabel}>{(p) => <Input {...p} value={reason} onChange={(e) => setReason(e.target.value)} autoFocus maxLength={200} />}</Field>
        )}
      </div>
    </Dialog>
  );
}
