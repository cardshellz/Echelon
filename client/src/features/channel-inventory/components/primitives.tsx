import { useState, type ReactNode } from "react";
import { AlertTriangle, ChevronDown, Info, RefreshCw } from "lucide-react";

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

import type { DefinitionAuthority, StateTone } from "../model";
import { SOURCE_KIND_LABELS } from "../model";

/** Shared visual vocabulary for the Channel Inventory workspace. */

const TONE_CLASSES: Record<StateTone | "draft" | "blocked" | "neutral", string> = {
  live: "border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200",
  preview: "border-sky-300 bg-sky-50 text-sky-800 dark:border-sky-800 dark:bg-sky-950/40 dark:text-sky-200",
  off: "border-slate-300 bg-slate-100 text-slate-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300",
  external: "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200",
  draft: "border-violet-300 bg-violet-50 text-violet-800 dark:border-violet-800 dark:bg-violet-950/40 dark:text-violet-200",
  blocked: "border-rose-300 bg-rose-50 text-rose-800 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-200",
  neutral: "border-border bg-muted text-muted-foreground",
};

const TONE_DOT: Record<StateTone, string> = {
  live: "bg-emerald-500",
  preview: "bg-sky-500",
  off: "bg-slate-400",
  external: "bg-amber-500",
};

export function StatePill({ tone, children, className, title }: {
  tone: keyof typeof TONE_CLASSES;
  children: ReactNode;
  className?: string;
  title?: string;
}) {
  return (
    <span
      title={title}
      data-tone={tone}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap",
        TONE_CLASSES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

export function ToneDot({ tone, className }: { tone: StateTone; className?: string }) {
  return <span aria-hidden="true" className={cn("inline-block h-2 w-2 rounded-full", TONE_DOT[tone], className)} />;
}

/** Marks saved-but-not-active configuration. */
export function PendingPill({ children = "Saved, pending activation" }: { children?: ReactNode }) {
  return <StatePill tone="draft">{children}</StatePill>;
}

export function ActivePill({ children = "Active" }: { children?: ReactNode }) {
  return <StatePill tone="neutral">{children}</StatePill>;
}

/** Names which saved rule supplies a field: "channel default · saved draft". */
export function SourceTag({ kind, authority }: {
  kind: keyof typeof SOURCE_KIND_LABELS;
  authority?: DefinitionAuthority;
}) {
  return (
    <span className="text-xs text-muted-foreground">
      {SOURCE_KIND_LABELS[kind]}
      {authority ? ` · ${authority === "draft" ? "saved draft" : "active"}` : ""}
    </span>
  );
}

export function EvidenceNote({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <p className={cn("flex items-start gap-2 text-xs text-muted-foreground", className)}>
      <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span>{children}</span>
    </p>
  );
}

export function Callout({ tone = "info", title, children, action }: {
  tone?: "info" | "warning" | "danger";
  title?: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  const classes = tone === "danger"
    ? "border-rose-300 bg-rose-50 text-rose-900 dark:border-rose-800 dark:bg-rose-950/30 dark:text-rose-100"
    : tone === "warning"
      ? "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-100"
      : "border-border bg-muted/40 text-foreground";
  return (
    <div role={tone === "danger" ? "alert" : "note"} className={cn("rounded-md border p-3 text-sm", classes)}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-2">
          {tone === "info"
            ? <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            : <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />}
          <div className="space-y-1">
            {title && <p className="font-medium">{title}</p>}
            <div className="text-sm leading-relaxed">{children}</div>
          </div>
        </div>
        {action}
      </div>
    </div>
  );
}

export function SectionCard({ title, description, actions, children, className }: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Card className={className}>
      <CardHeader className="pb-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <CardTitle className="text-base">{title}</CardTitle>
            {description && <CardDescription className="max-w-3xl leading-relaxed">{description}</CardDescription>}
          </div>
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">{children}</CardContent>
    </Card>
  );
}

/**
 * Optional note for the audit trail. Collapsed by default: routine saves must
 * never look like they require a justification.
 */
export function NoteField({ id, value, onChange, disabled }: {
  id: string;
  value: string;
  onChange(value: string): void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(value.length > 0);
  return (
    <div className="space-y-2">
      <button
        type="button"
        className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((current) => !current)}
      >
        <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", open && "rotate-180")} aria-hidden="true" />
        {open ? "Hide note" : "Add a note (optional)"}
      </button>
      {open && (
        <div className="space-y-1">
          <Label htmlFor={id} className="sr-only">Note for the audit trail (optional)</Label>
          <Textarea
            id={id}
            value={value}
            maxLength={1000}
            rows={2}
            placeholder="Optional context for the audit trail"
            disabled={disabled}
            onChange={(event) => onChange(event.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            Who, when, and what changed are recorded automatically.
          </p>
        </div>
      )}
    </div>
  );
}

export function ConflictAlert({ message, onReload, reloading }: {
  message: string;
  onReload(): void;
  reloading?: boolean;
}) {
  return (
    <Callout
      tone="warning"
      title="Someone changed this since you loaded it"
      action={(
        <Button type="button" size="sm" variant="outline" onClick={onReload} disabled={reloading}>
          <RefreshCw className={cn("mr-1 h-3.5 w-3.5", reloading && "animate-spin")} aria-hidden="true" />
          Reload to compare
        </Button>
      )}
    >
      {message} Your entries stay on screen; reload to see the latest saved values before saving again.
    </Callout>
  );
}

export function InlineError({ children, id }: { children: ReactNode; id?: string }) {
  return <p id={id} role="alert" className="text-xs text-destructive">{children}</p>;
}

/**
 * Sensitive publication commands keep their required reason (owner decision:
 * the routine-edit exemption does not rescind activation/readiness gates).
 * The reason is asked for at the moment of the action, never as a permanent
 * field on the page.
 */
export function ReasonDialog({ open, onOpenChange, title, description, confirmLabel, destructive, pending, onConfirm }: {
  open: boolean;
  onOpenChange(open: boolean): void;
  title: string;
  description: ReactNode;
  confirmLabel: string;
  destructive?: boolean;
  pending?: boolean;
  onConfirm(reason: string): void;
}) {
  const [reason, setReason] = useState("");
  const trimmed = reason.trim();
  return (
    <AlertDialog open={open} onOpenChange={(next) => { if (!pending) { onOpenChange(next); if (!next) setReason(""); } }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2 text-sm text-muted-foreground">{description}</div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="space-y-2">
          <Label htmlFor="publication-command-reason">Reason (required for this publishing command)</Label>
          <Textarea
            id="publication-command-reason"
            value={reason}
            rows={3}
            maxLength={1000}
            disabled={pending}
            onChange={(event) => setReason(event.target.value)}
          />
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <Button
            type="button"
            variant={destructive ? "destructive" : "default"}
            disabled={pending || trimmed.length === 0}
            onClick={() => onConfirm(trimmed)}
          >
            {pending ? "Working…" : confirmLabel}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/**
 * Thrown inside a mutation when client-side validation fails, so the mutation
 * settles without a network call and error handlers can ignore it. Never
 * shown to the operator; the field errors are.
 */
export class FormValidationStop extends Error {
  constructor(message = "validation") {
    super(message);
    this.name = "FormValidationStop";
  }
}

export function KeyValue({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-0.5">
      <dt className="text-xs uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="text-sm">{children}</dd>
    </div>
  );
}
