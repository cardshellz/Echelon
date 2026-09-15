import { useEffect, useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, Search } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";

import { buildPolicyDraftRequest, describeError, isConflict, savePolicyDraft } from "../api";
import { invalidateChannelInventory, useCommandKey } from "../hooks";
import {
  findPolicyHead,
  listExceptions,
  missingChannelDefaultFields,
  policyFormToValue,
  policyValueToForm,
  samePolicyForm,
  savedPolicy,
  type Channel,
  type ExceptionRow,
  type PolicyForm,
  type PolicyFormError,
  type View,
} from "../model";
import { ExceptionSheet, type ExceptionSubject } from "./ExceptionSheet";
import { PolicyFields } from "./PolicyFields";
import { ActivePill, Callout, ConflictAlert, EvidenceNote, FormValidationStop, NoteField, PendingPill, SectionCard, StatePill } from "./primitives";

/** Channel default plus the product/SKU exceptions that override it. */
export function SellingRulesTab({ view, channel, canEdit, focusProductId, onFocusProduct, onReload, reloading }: {
  view: View;
  channel: Channel;
  canEdit: boolean;
  focusProductId: number | null;
  onFocusProduct(productId: number): void;
  onReload(): void;
  reloading: boolean;
}) {
  const [sheet, setSheet] = useState<{ open: boolean; subject: ExceptionSubject | null }>({ open: false, subject: null });
  return (
    <div className="space-y-4">
      <ChannelDefaultCard key={channel.id} view={view} channel={channel} canEdit={canEdit} onReload={onReload} reloading={reloading} />
      <ExceptionsCard
        view={view}
        channel={channel}
        canEdit={canEdit}
        onOpen={(subject) => setSheet({ open: true, subject })}
      />
      {sheet.open && (
        <ExceptionSheet
          open={sheet.open}
          onOpenChange={(open) => setSheet((current) => ({ ...current, open }))}
          view={view}
          channel={channel}
          subject={sheet.subject}
          canEdit={canEdit}
          focusProductId={focusProductId}
          onFocusProduct={onFocusProduct}
          onReload={onReload}
          reloading={reloading}
        />
      )}
    </div>
  );
}

function ChannelDefaultCard({ view, channel, canEdit, onReload, reloading }: {
  view: View;
  channel: Channel;
  canEdit: boolean;
  onReload(): void;
  reloading: boolean;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const command = useCommandKey();
  const scope = useMemo(() => ({ scopeType: "channel" as const, channelId: channel.id }), [channel.id]);
  const head = findPolicyHead(view.policyHeads, scope);
  const saved = savedPolicy(head);
  const savedForm = useMemo(() => policyValueToForm(saved?.value ?? null), [saved?.value]);
  const [form, setForm] = useState<PolicyForm>(savedForm);
  const [errors, setErrors] = useState<PolicyFormError[]>([]);
  const [note, setNote] = useState("");
  const [conflict, setConflict] = useState<string | null>(null);
  const fingerprint = `${head?.revision ?? "0"}:${head?.draftPolicy?.definitionHash ?? ""}:${head?.activePolicy?.definitionHash ?? ""}`;

  useEffect(() => {
    setForm(savedForm);
    setErrors([]);
    setConflict(null);
    command.clear();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fingerprint]);

  const save = useMutation({
    mutationFn: () => {
      const parsed = policyFormToValue(form);
      if (!parsed.ok) {
        setErrors(parsed.errors);
        return Promise.reject(new FormValidationStop());
      }
      setErrors([]);
      return savePolicyDraft(buildPolicyDraftRequest({
        scope,
        value: parsed.value,
        head,
        note,
        idempotencyKey: command.keyFor(JSON.stringify({ scope, value: parsed.value, note, fingerprint })),
      }));
    },
    onSuccess: async () => {
      command.clear();
      setNote("");
      await invalidateChannelInventory(queryClient);
      toast({
        title: `Channel default saved for ${channel.name}`,
        description: "Pending activation. Items with their own rule keep their explicit values.",
      });
    },
    onError: (error) => {
      if (error instanceof FormValidationStop) return;
      const described = describeError(error);
      if (isConflict(error)) { setConflict(described.message); return; }
      toast({ title: described.title, description: described.message, variant: "destructive" });
    },
  });

  const changed = !samePolicyForm(form, savedForm);
  const missing = missingChannelDefaultFields(saved?.value ?? null);
  const formError = errors.find((error) => error.field === "form")?.message ?? null;

  return (
    <SectionCard
      title={`Channel default for ${channel.name}`}
      description="The starting point for every product on this channel. A product or SKU exception replaces a field outright; percentages never multiply, and a channel default is not an emergency stop."
      actions={(
        <>
          {head?.activePolicy && <ActivePill>Active v{head.activePolicy.version}</ActivePill>}
          {head?.draftPolicy && <PendingPill>Draft v{head.draftPolicy.version} pending activation</PendingPill>}
        </>
      )}
    >
      {saved && missing.length > 0 && (
        <Callout tone="warning" title="Incomplete channel default">
          {missing.join(", ")} {missing.length === 1 ? "is" : "are"} not set. A channel default must set
          every field before it can be activated.
        </Callout>
      )}
      {!saved && (
        <Callout title="No channel default saved yet">
          Until a complete default exists, nothing on {channel.name} can be published.
        </Callout>
      )}
      {conflict && <ConflictAlert message={conflict} onReload={onReload} reloading={reloading} />}
      <PolicyFields
        idPrefix={`channel-${channel.id}`}
        form={form}
        onChange={(patch) => setForm((current) => ({ ...current, ...patch }))}
        scopeType="channel"
        inherited={null}
        errors={errors}
        disabled={!canEdit || save.isPending}
        unitNoun="units of each SKU"
      />
      {formError && <Callout tone="warning">{formError}</Callout>}
      {canEdit && (
        <div className="flex flex-col gap-3 border-t pt-4 sm:flex-row sm:items-end sm:justify-between">
          <NoteField id={`channel-default-note-${channel.id}`} value={note} onChange={setNote} disabled={save.isPending} />
          <div className="flex items-center gap-3">
            {changed && !save.isPending && <span className="text-xs text-muted-foreground">Unsaved changes</span>}
            <Button type="button" disabled={!changed || save.isPending} onClick={() => save.mutate()}>
              {save.isPending ? "Saving…" : "Save channel default"}
            </Button>
          </div>
        </div>
      )}
      <EvidenceNote>Applies to every destination of {channel.name}. Quantity fields are counted in units of each exact SKU (a pack of five is one unit).</EvidenceNote>
    </SectionCard>
  );
}

function ExceptionsCard({ view, channel, canEdit, onOpen }: {
  view: View;
  channel: Channel;
  canEdit: boolean;
  onOpen(subject: ExceptionSubject | null): void;
}) {
  const [query, setQuery] = useState("");
  const rows = useMemo(() => listExceptions(view, channel.id), [view, channel.id]);
  const needle = query.trim().toLowerCase();
  const visible = needle.length === 0
    ? rows
    : rows.filter((row) => `${row.title} ${row.subtitle}`.toLowerCase().includes(needle));
  return (
    <SectionCard
      title="Exceptions"
      description="Products or individual SKUs that need different settings on this channel. Only the fields set here change; the rest keep inheriting."
      actions={canEdit ? (
        <Button type="button" size="sm" onClick={() => onOpen(null)}>
          <Plus className="mr-1 h-4 w-4" aria-hidden="true" />
          Add exception
        </Button>
      ) : undefined}
    >
      {rows.length === 0 ? (
        <Callout>
          No exceptions on {channel.name}. Every product follows the channel default.
        </Callout>
      ) : (
        <>
          <div className="relative max-w-sm">
            <Label htmlFor={`exception-search-${channel.id}`} className="sr-only">Search exceptions</Label>
            <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" aria-hidden="true" />
            <Input
              id={`exception-search-${channel.id}`}
              value={query}
              placeholder="Search by product or SKU"
              className="pl-8"
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          {visible.length === 0 ? (
            <p className="text-sm text-muted-foreground">No exceptions match this search.</p>
          ) : (
            <ul className="divide-y rounded-md border">
              {visible.map((row) => <ExceptionListItem key={row.scopeKey} row={row} onOpen={onOpen} />)}
            </ul>
          )}
        </>
      )}
    </SectionCard>
  );
}

function ExceptionListItem({ row, onOpen }: { row: ExceptionRow; onOpen(subject: ExceptionSubject): void }) {
  return (
    <li>
      <button
        type="button"
        onClick={() => onOpen({ productId: row.productId, productVariantId: row.productVariantId })}
        className="flex w-full flex-wrap items-center gap-x-4 gap-y-2 px-3 py-2.5 text-left transition-colors hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="min-w-[12rem] flex-1">
          <span className="block truncate text-sm font-medium">{row.title}</span>
          <span className="block truncate text-xs text-muted-foreground">{row.subtitle}</span>
        </span>
        <span className="flex flex-wrap gap-1">
          {row.explicitFields.map((label) => <StatePill key={label} tone="neutral">{label}</StatePill>)}
        </span>
        <span className="flex gap-1">
          {row.active && <ActivePill />}
          {row.pending && <PendingPill>Pending</PendingPill>}
        </span>
      </button>
    </li>
  );
}
