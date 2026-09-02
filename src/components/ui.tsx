"use client";

import { useEffect, useRef, useState } from "react";

export function Card({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`rounded-2xl border border-black/10 bg-white p-5 ${className}`}>
      {children}
    </div>
  );
}

export function Stat({
  label,
  value,
  hint,
}: {
  label: string;
  value: React.ReactNode;
  hint?: string;
}) {
  return (
    <div>
      <div className="tnum text-2xl font-semibold">{value}</div>
      <div className="text-sm text-black/50">{label}</div>
      {hint && <div className="mt-0.5 text-xs text-black/40">{hint}</div>}
    </div>
  );
}

/** Zapier's execution message explains most empty results — never hide it. */
export function Note({ children }: { children?: React.ReactNode }) {
  if (!children) return null;
  return (
    <p className="rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-900 ring-1 ring-amber-200">
      {children}
    </p>
  );
}

export function ErrorNote({ children }: { children?: React.ReactNode }) {
  if (!children) return null;
  return (
    <p className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700 ring-1 ring-red-200">
      {children}
    </p>
  );
}

export function OkNote({ children }: { children?: React.ReactNode }) {
  if (!children) return null;
  return (
    <p className="rounded-xl bg-emerald-50 px-4 py-3 text-sm text-emerald-800 ring-1 ring-emerald-200">
      {children}
    </p>
  );
}

export function Empty({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="rounded-2xl border border-dashed border-black/15 px-6 py-12 text-center">
      <p className="font-medium">{title}</p>
      {hint && <p className="mx-auto mt-1 max-w-md text-sm text-black/50">{hint}</p>}
    </div>
  );
}

export function Loading({ label = "Loading…" }: { label?: string }) {
  return <p className="py-8 text-sm text-black/45">{label}</p>;
}

export function Button({
  children,
  variant = "primary",
  className = "",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "ghost" | "danger" | "approve";
}) {
  const styles = {
    primary: "bg-brand text-white hover:bg-brand-ink",
    ghost:
      "border border-black/15 text-black hover:border-brand/50 hover:bg-brand/[0.04]",
    danger: "bg-red-600 text-white hover:bg-red-700",
    approve: "bg-emerald-600 text-white hover:bg-emerald-700",
  }[variant];
  return (
    <button
      {...props}
      className={`rounded-xl px-4 py-2 text-sm font-medium transition disabled:opacity-40 ${styles} ${className}`}
    >
      {children}
    </button>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block space-y-1.5">
      <span className="text-sm font-medium">{label}</span>
      {children}
      {hint && <span className="block text-xs text-black/45">{hint}</span>}
    </label>
  );
}

export const inputClass =
  "w-full rounded-xl border border-black/15 bg-white px-3.5 py-2.5 text-sm text-black outline-none placeholder:text-black/35 focus:border-brand/60";

/** Panel section heading with the brand rule, matching the landing page. */
export function SectionTitle({
  children,
  right,
}: {
  children: React.ReactNode;
  right?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h3 className="flex items-center gap-2.5 text-sm font-medium tracking-wide text-black/45 uppercase">
        <span className="h-3 w-1 rounded-full bg-brand" />
        {children}
      </h3>
      {right}
    </div>
  );
}

/** Shared tab bar so every panel looks and behaves the same. */
export function Tabs<T extends string>({
  tabs,
  active,
  onChange,
}: {
  tabs: readonly { id: T; label: string; badge?: number }[];
  active: T;
  onChange: (id: T) => void;
}) {
  return (
    <nav className="mb-6 flex flex-wrap gap-1 rounded-xl border border-black/8 bg-white p-1 shadow-sm">
      {tabs.map((t) => (
        <button
          key={t.id}
          onClick={() => onChange(t.id)}
          className={`flex items-center gap-1.5 rounded-lg px-3.5 py-2 text-sm font-medium transition ${
            active === t.id
              ? "bg-brand text-white"
              : "text-black/60 hover:bg-brand/[0.06] hover:text-brand-ink"
          }`}
        >
          {t.label}
          {t.badge ? (
            <span
              className={`tnum rounded-md px-1.5 text-[11px] ${
                active === t.id ? "bg-white/25" : "bg-black/[0.07] text-black/60"
              }`}
            >
              {t.badge}
            </span>
          ) : null}
        </button>
      ))}
    </nav>
  );
}

/**
 * Access state, told apart by word first and colour second.
 *
 * "Pending" and "revoked" being distinguishable only by hue is how someone
 * reads a revoked grant as live. Every pill carries its own label.
 */
const PILL: Record<string, string> = {
  active: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  provisioned: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  approved: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  keep: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  ready: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  ok: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  pending: "bg-amber-50 text-amber-800 ring-amber-200",
  // Workspace account state. Suspended reads as a warning rather than a
  // failure: it is a signal worth reviewing, not proof that anyone left.
  suspended: "bg-amber-50 text-amber-800 ring-amber-200",
  dormant: "bg-amber-50 text-amber-800 ring-amber-200",
  archived: "bg-black/[0.06] text-black/55 ring-black/10",
  admin: "bg-red-50 text-red-700 ring-red-200",
  "pending-revoke": "bg-amber-50 text-amber-800 ring-amber-200",
  open: "bg-amber-50 text-amber-800 ring-amber-200",
  due: "bg-amber-50 text-amber-800 ring-amber-200",
  unconfigured: "bg-amber-50 text-amber-800 ring-amber-200",
  revoked: "bg-black/[0.06] text-black/55 ring-black/10",
  denied: "bg-black/[0.06] text-black/55 ring-black/10",
  cancelled: "bg-black/[0.06] text-black/55 ring-black/10",
  closed: "bg-black/[0.06] text-black/55 ring-black/10",
  failed: "bg-red-50 text-red-700 ring-red-200",
  error: "bg-red-50 text-red-700 ring-red-200",
  unavailable: "bg-red-50 text-red-700 ring-red-200",
  revoke: "bg-red-50 text-red-700 ring-red-200",
  overdue: "bg-red-50 text-red-700 ring-red-200",
};

export function Pill({
  state,
  label,
  className = "",
}: {
  state: string;
  label?: string;
  className?: string;
}) {
  const tone = PILL[state] ?? "bg-black/[0.06] text-black/55 ring-black/10";
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium whitespace-nowrap ring-1 ${tone} ${className}`}
    >
      {label ?? state.replace(/-/g, " ")}
    </span>
  );
}

/** Horizontal scrolling belongs to the table, never to the page. */
export function Table({
  head,
  children,
}: {
  head: React.ReactNode[];
  children: React.ReactNode;
}) {
  return (
    <div className="overflow-x-auto rounded-2xl border border-black/10 bg-white">
      <table className="w-full min-w-[640px] text-left text-sm">
        <thead>
          <tr className="border-b border-black/8">
            {head.map((cell, i) => (
              <th
                key={i}
                className="px-4 py-3 text-xs font-medium tracking-wide text-black/45 uppercase"
              >
                {cell}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-black/5">{children}</tbody>
      </table>
    </div>
  );
}

export function Td({
  children,
  className = "",
}: {
  children?: React.ReactNode;
  className?: string;
}) {
  return <td className={`px-4 py-3 align-top ${className}`}>{children}</td>;
}

/**
 * The confirmation gate for anything irreversible.
 *
 * It states the consequence rather than asking "are you sure": revoking a
 * licence and removing a group membership look identical in a dialog that only
 * says "confirm", and they are not the same thing to undo.
 */
export function Confirm({
  open,
  title,
  consequence,
  confirmLabel,
  variant = "danger",
  busy,
  requirePassword = false,
  onConfirm,
  onCancel,
  children,
}: {
  open: boolean;
  title: string;
  consequence: string;
  confirmLabel: string;
  variant?: "danger" | "approve" | "primary";
  busy?: boolean;
  /**
   * Ask for the confirmation password before this can be confirmed.
   *
   * Set it on anything that changes real access or writes something untrue
   * into the register. The value is handed to `onConfirm`, which sends it to
   * the server — nothing here compares it, because a check in the browser
   * ships the secret to every visitor and stops nobody.
   */
  requirePassword?: boolean;
  onConfirm: (password: string) => void;
  onCancel: () => void;
  children?: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const [password, setPassword] = useState("");

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onCancel();
    window.addEventListener("keydown", onKey);
    // Focus the password box when there is one: it is the step that has to
    // happen, and hunting for it is friction with no safety value.
    (passwordRef.current ?? ref.current)?.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onCancel]);

  // Never leave a typed password sitting in memory behind a closed dialog.
  //
  // Cleared during render rather than in an effect: the dialog returns null
  // below, so an effect would set state on a component that renders nothing —
  // a cascading render for a value nobody can see. This is React's
  // adjust-state-during-render pattern, and it runs before the early return.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (!open && password !== "") setPassword("");
  }

  if (!open) return null;

  const blocked = requirePassword && password.length === 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4">
      <div
        ref={ref}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="w-full max-w-lg space-y-4 rounded-2xl border border-black/10 bg-white p-6 shadow-xl outline-none"
      >
        <h2 className="text-lg font-semibold">{title}</h2>
        <p className="text-sm leading-relaxed text-black/65">{consequence}</p>
        {children}

        {requirePassword ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (!blocked && !busy) onConfirm(password);
            }}
          >
            <Field
              label="Confirmation password"
              hint="Required for anything that changes access. It is checked on the server."
            >
              <input
                ref={passwordRef}
                type="password"
                autoComplete="off"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                disabled={busy}
                className={inputClass}
              />
            </Field>
          </form>
        ) : null}

        <div className="flex flex-wrap justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant={variant}
            onClick={() => onConfirm(password)}
            disabled={busy || blocked}
          >
            {busy ? "Working…" : confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}

/** Dates are shown in the viewer's timezone, never as a raw ISO string. */
export function When({ at, relative = true }: { at?: string; relative?: boolean }) {
  if (!at) return <span className="text-black/35">—</span>;
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return <span className="text-black/35">—</span>;

  const absolute = date.toLocaleString(undefined, {
    dateStyle: "medium",
    ...(relative ? { timeStyle: "short" } : {}),
  });
  return (
    <span title={date.toISOString()} className="whitespace-nowrap">
      {relative ? `${ago(date)} · ${absolute}` : absolute}
    </span>
  );
}

function ago(date: Date): string {
  const seconds = Math.round((Date.now() - date.getTime()) / 1000);
  const future = seconds < 0;
  const n = Math.abs(seconds);
  const units: [number, string][] = [
    [60, "s"],
    [3600, "m"],
    [86400, "h"],
    [2592000, "d"],
  ];
  let label = `${Math.round(n / 2592000)}mo`;
  for (const [limit, suffix] of units) {
    if (n < limit) {
      const divisor = limit === 60 ? 1 : limit === 3600 ? 60 : limit === 86400 ? 3600 : 86400;
      label = `${Math.round(n / divisor)}${suffix}`;
      break;
    }
  }
  return future ? `in ${label}` : `${label} ago`;
}
