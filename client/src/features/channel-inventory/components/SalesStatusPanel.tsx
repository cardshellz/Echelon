import { useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react";
import { SALES_STATUS_NOTE_MAX_LENGTH, type ChangeSalesStatusRequest, type SalesStatusChange, type SalesStatusProductView, type SalesStatusTarget } from "@shared/types/inventory-sales-status";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useToast } from "@/hooks/use-toast";

import { ChannelInventoryApiError, describeError } from "../api";
import { isDefinitiveDraftRejection } from "../draft-session";
import { useDraftNavigationBlock } from "../DraftNavigation";
import { formatAbsoluteTime, pluralize } from "../format";
import { invalidateChannelInventory } from "../hooks";
import { SALES_STATUS_QUERY_ROOT, changeSalesStatus, fetchSalesStatusProduct } from "../sales-status-api";
import {
  STOPPED_BY_PRODUCT,
  allChannelsChanges,
  bulkChanges,
  channelChanges,
  channelsStoppedByProduct,
  describeChangeResult,
  describeChannelStatus,
  entryAt,
  hasOwnStop,
  itemStatuses,
  listNames,
  otherHoldsFor,
  resumeEverywhereChanges,
  stopEverywhereChanges,
  summarizeItem,
  type SalesStatusItem,
  type StatusSummary,
} from "../sales-status-model";
import { Callout, EvidenceNote, NoteField, StatePill } from "./primitives";

export const salesStatusProductQueryKey = (productId: number) => [...SALES_STATUS_QUERY_ROOT, "product", productId] as const;

const SUMMARY_TONE = { selling: "live", stopped: "blocked", mixed: "held" } as const satisfies Record<StatusSummary["tone"], string>;

/** The chosen option must read at a glance; the default toggle "on" colour is nearly white. Same palette as StatePill. */
const OPTION_ON_CLASS: Record<SalesStatusTarget, string> = {
  stopped: "data-[state=on]:border-rose-300 data-[state=on]:bg-rose-50 data-[state=on]:text-rose-800 dark:data-[state=on]:border-rose-800 dark:data-[state=on]:bg-rose-950/40 dark:data-[state=on]:text-rose-200",
  selling: "data-[state=on]:border-emerald-300 data-[state=on]:bg-emerald-50 data-[state=on]:text-emerald-800 dark:data-[state=on]:border-emerald-800 dark:data-[state=on]:bg-emerald-950/40 dark:data-[state=on]:text-emerald-200",
  inherit: "data-[state=on]:border-sky-300 data-[state=on]:bg-sky-50 data-[state=on]:text-sky-800 dark:data-[state=on]:border-sky-800 dark:data-[state=on]:bg-sky-950/40 dark:data-[state=on]:text-sky-200",
};

type CommandState =
  | { kind: "idle" }
  | { kind: "busy" }
  /** Nothing was saved and the same change may simply be sent again. */
  | { kind: "retry"; message: string }
  /** The change may have been saved: only the same change may be sent, to read its result. */
  | { kind: "uncertain"; message: string }
  | { kind: "refused"; message: string };

/**
 * Sales status for one product or SKU on every channel at once (owner
 * decision 2026-11-07). A click takes effect immediately: no draft and no
 * review. Stopped publishes 0 and keeps the listing; per-channel exceptions
 * override the item's all-channels setting. A SKU sells only if its product
 * and the SKU are both Selling, so a SKU under a stopped product says so
 * instead of offering a resume that could not help. The server resolves
 * stock with the same rules; this panel sends exactly the changes a click
 * asks for, pinned to the revisions on screen.
 */
export function SalesStatusPanel({ productId, productVariantId, canChange, onFocusVariant }: {
  productId: number;
  /** Null: the whole product, with its SKUs listed for bulk changes. */
  productVariantId: number | null;
  /** A change publishes stock, so it needs inventory planning activate. */
  canChange: boolean;
  /** When given, SKU rows open that SKU's own settings, and a SKU view can return to the product. */
  onFocusVariant?(productVariantId: number | null): void;
}) {
  const query = useQuery({
    queryKey: salesStatusProductQueryKey(productId),
    queryFn: ({ signal }) => fetchSalesStatusProduct(productId, signal),
    retry: false,
  });
  const command = useSalesStatusCommand(productId);
  const [note, setNote] = useState("");

  if (query.isLoading) {
    return <section aria-label="Sales status" aria-busy="true" className="space-y-2 rounded-md border p-3">
      <Skeleton className="h-5 w-40" /><Skeleton className="h-16 w-full" />
    </section>;
  }
  if (!query.data) {
    return <Callout tone="danger" title="Sales status could not be loaded"
      action={<Button type="button" size="sm" variant="outline" onClick={() => void query.refetch()}>Try again</Button>}>
      {describeError(query.error).message}
    </Callout>;
  }
  const view = query.data;
  if (view.runtimeAuthority !== "canonical") {
    return <Callout title="Sales status starts after inventory cutover">
      Stopping a SKU here takes effect only when Echelon owns channel stock. Nothing is stopped by this panel yet.
    </Callout>;
  }
  const item: SalesStatusItem = { productVariantId };
  const variant = productVariantId === null ? null : view.variants.find((entry) => entry.id === productVariantId) ?? null;
  const locked = !canChange || command.state.kind === "busy" || command.state.kind === "uncertain";
  const send = (changes: SalesStatusChange[], title: string) => command.run(changes, note, title, () => setNote(""));
  const summary = summarizeItem(view, item);
  const itemName = variant ? (variant.sku ?? variant.name) : (view.product.sku ?? view.product.name);
  const byProduct = productVariantId === null ? [] : channelsStoppedByProduct(view, productVariantId);

  return (
    <section aria-label="Sales status" className="space-y-4 rounded-md border p-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          {variant && onFocusVariant && (
            <button type="button" className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
              onClick={() => onFocusVariant(null)}>
              <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />Whole product
            </button>
          )}
          <p className="text-sm font-medium">Sales status · <span className="font-mono-sku">{itemName}</span></p>
          <p className="text-xs text-muted-foreground">
            Stopped sends 0 and keeps the listing. A change takes effect as soon as you click.
          </p>
        </div>
        <StatePill tone={SUMMARY_TONE[summary.tone]}>{summary.text}</StatePill>
      </div>

      {byProduct.length > 0 && (
        <Callout title={STOPPED_BY_PRODUCT}>
          {byProduct.length === view.channels.length ? "On every channel." : `On ${listNames(byProduct.map((channel) => channel.name))}.`}
          {" "}This SKU sells there only after the product is resumed.
          {onFocusVariant && (
            <>{" "}<button type="button" className="underline" onClick={() => onFocusVariant(null)}>Open the whole product</button></>
          )}
        </Callout>
      )}

      {canChange ? (
        <div className="flex flex-wrap gap-2">
          {summary.tone !== "stopped" && (
            <Button type="button" size="sm" variant="destructive" disabled={locked}
              onClick={() => void send(stopEverywhereChanges(view, item), `${itemName} stopped on every channel`)}>
              Stop everywhere
            </Button>
          )}
          {/* Resume removes this item's own stops; a product's stop on a SKU is resumed on the product. */}
          {hasOwnStop(view, item) && (
            <Button type="button" size="sm" variant="outline" disabled={locked}
              onClick={() => void send(resumeEverywhereChanges(view, item), `${itemName} resumed on every channel`)}>
              Resume everywhere
            </Button>
          )}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">Changing a sales status needs inventory activation permission.</p>
      )}

      <CommandFeedback state={command.state} onRetry={() => void command.retry()} />

      <ScopeSettings view={view} item={item} disabled={locked}
        onChange={(changes, title) => void send(changes, title)} itemName={itemName} />

      <OtherHolds view={view} item={item} />

      {productVariantId === null && (
        <SkuList view={view} disabled={locked} canChange={canChange} onFocusVariant={onFocusVariant}
          onBulk={(ids, action) => void send(bulkChanges(view, ids, action),
            `${pluralize(ids.length, "SKU")} ${action === "stop" ? "stopped" : "selling"} on every channel`)} />
      )}

      {canChange && <NoteField id={`sales-status-note-${productId}-${productVariantId ?? "product"}`} value={note}
        onChange={setNote} disabled={locked} maxLength={SALES_STATUS_NOTE_MAX_LENGTH} />}
      <EvidenceNote>
        A SKU sells only if its product and the SKU are both Selling. On each, a channel exception beats the
        all-channels setting. Every change is recorded with who made it and when.
      </EvidenceNote>
    </section>
  );
}

/** The item's all-channels setting and one exception control per channel. */
function ScopeSettings({ view, item, disabled, onChange, itemName }: {
  view: SalesStatusProductView;
  item: SalesStatusItem;
  disabled: boolean;
  onChange(changes: SalesStatusChange[], title: string): void;
  itemName: string;
}) {
  const statuses = itemStatuses(view, item);
  const allChannels = entryAt(view, item, null);
  const isSku = item.productVariantId !== null;
  const apply = (changes: SalesStatusChange[], title: string) => { if (changes.length > 0) onChange(changes, title); };
  return (
    <div className="space-y-1" role="list" aria-label="Sales status by channel">
      <SettingRow
        label="All channels"
        detail={allChannels ? `Stopped ${formatAbsoluteTime(allChannels.updatedAt)} by ${allChannels.updatedBy}`
          : isSku ? "Nothing set on this SKU" : "Nothing set: selling"}
        // Selling everywhere is the default, so only Stopped is ever stored here.
        value={allChannels?.status === "stopped" ? "stopped" : "selling"}
        options={[["selling", "Sell"], ["stopped", "Stop"]]}
        disabled={disabled}
        groupLabel="Sales status on all channels"
        onValue={(next) => apply(allChannelsChanges(view, item, next),
          `${itemName}: ${next === "stopped" ? "stopped" : "resumed"} on all channels`)}
      />
      {statuses.map((status) => {
        const { channel } = status;
        const exception = entryAt(view, item, channel.id);
        return (
          <SettingRow
            key={channel.id}
            label={channel.name}
            detail={`${describeChannelStatus(view, status)}${channel.publishesStock ? "" : " · Echelon does not send stock to this channel"}`}
            value={exception?.status ?? "inherit"}
            options={[["inherit", "Same"], ["selling", "Sell"], ["stopped", "Stop"]]}
            disabled={disabled}
            groupLabel={`Sales status on ${channel.name}`}
            tone={status.status}
            onValue={(next) => apply(channelChanges(view, item, channel.id, next),
              `${itemName}: ${next === "inherit" ? "same as all channels" : next === "stopped" ? "stopped" : "selling"} on ${channel.name}`)}
          />
        );
      })}
    </div>
  );
}

function SettingRow({ label, detail, value, options, disabled, groupLabel, tone, onValue }: {
  label: string;
  detail: string;
  value: SalesStatusTarget;
  options: ReadonlyArray<readonly [SalesStatusTarget, string]>;
  disabled: boolean;
  groupLabel: string;
  tone?: "selling" | "stopped";
  onValue(value: SalesStatusTarget): void;
}) {
  return (
    <div role="listitem" className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 rounded-md px-2 py-1.5 odd:bg-muted/40">
      <div className="min-w-[10rem] flex-1">
        <p className="text-sm font-medium">
          {label}
          {tone === "stopped" && <span className="ml-2 text-xs font-normal text-rose-700 dark:text-rose-300">Sends 0</span>}
        </p>
        <p className="text-xs text-muted-foreground">{detail}</p>
      </div>
      <ToggleGroup type="single" variant="outline" size="sm" value={value} aria-label={groupLabel} disabled={disabled}
        onValueChange={(next) => { if (next && next !== value) onValue(next as SalesStatusTarget); }}>
        {options.map(([option, text]) => (
          <ToggleGroupItem key={option} value={option} className={`px-2.5 text-xs ${OPTION_ON_CLASS[option]}`}>{text}</ToggleGroupItem>
        ))}
      </ToggleGroup>
    </div>
  );
}

/** Automation holds keep stock at 0 whatever the sales status says; resuming here does not release them. */
function OtherHolds({ view, item }: { view: SalesStatusProductView; item: SalesStatusItem }) {
  const holds = otherHoldsFor(view, item);
  if (holds.length === 0) return null;
  const channelName = (id: number) => view.channels.find((channel) => channel.id === id)?.name ?? `Channel ${id}`;
  const sku = (id: number | null) => id === null ? "every SKU" : view.variants.find((variant) => variant.id === id)?.sku ?? `SKU #${id}`;
  return (
    <Callout tone="warning" title="Also held at 0 by another process">
      <ul className="list-disc space-y-1 pl-5">
        {holds.map((hold) => (
          <li key={`${hold.publicationTargetId}:${hold.productVariantId ?? "all"}`}>
            {channelName(hold.channelId)} · {sku(hold.productVariantId)}: {hold.reason} ({hold.heldBy})
          </li>
        ))}
      </ul>
      <p className="mt-1">Resuming here does not release these holds.</p>
    </Callout>
  );
}

function SkuList({ view, disabled, canChange, onFocusVariant, onBulk }: {
  view: SalesStatusProductView;
  disabled: boolean;
  canChange: boolean;
  onFocusVariant?(productVariantId: number): void;
  onBulk(productVariantIds: number[], action: "stop" | "resume"): void;
}) {
  const sellable = useMemo(() => view.variants.filter((variant) => variant.sellable), [view.variants]);
  const [selected, setSelected] = useState<ReadonlySet<number>>(new Set());
  const chosen = sellable.filter((variant) => selected.has(variant.id)).map((variant) => variant.id);
  const toggle = (id: number, checked: boolean) => setSelected((current) => {
    const next = new Set(current);
    if (checked) next.add(id); else next.delete(id);
    return next;
  });
  if (sellable.length === 0) return <p className="text-sm text-muted-foreground">This product has no sellable SKUs.</p>;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium">SKUs</p>
        {canChange && chosen.length > 0 && (
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" variant="destructive" disabled={disabled}
              onClick={() => { onBulk(chosen, "stop"); setSelected(new Set()); }}>
              Stop {pluralize(chosen.length, "selected SKU")} everywhere
            </Button>
            <Button type="button" size="sm" variant="outline" disabled={disabled}
              onClick={() => { onBulk(chosen, "resume"); setSelected(new Set()); }}>
              Resume {pluralize(chosen.length, "selected SKU")} everywhere
            </Button>
          </div>
        )}
      </div>
      <ul className="divide-y rounded-md border" aria-label="SKU sales status">
        {canChange && (
          <li className="flex items-center gap-3 px-3 py-2 text-xs text-muted-foreground">
            <Checkbox aria-label="Select every SKU" disabled={disabled}
              checked={chosen.length === sellable.length ? true : chosen.length > 0 ? "indeterminate" : false}
              onCheckedChange={(checked) => setSelected(checked === true ? new Set(sellable.map((variant) => variant.id)) : new Set())} />
            Select SKUs to stop or resume together
          </li>
        )}
        {sellable.map((variant) => {
          const summary = summarizeItem(view, { productVariantId: variant.id });
          const label = variant.sku ?? variant.name;
          return (
            <li key={variant.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
              {canChange && <Checkbox aria-label={`Select ${label}`} disabled={disabled} checked={selected.has(variant.id)}
                onCheckedChange={(checked) => toggle(variant.id, checked === true)} />}
              <span className="min-w-[8rem] flex-1">
                <span className="block font-mono-sku text-sm">{label}</span>
                <span className="block text-xs text-muted-foreground">{variant.name}</span>
              </span>
              <StatePill tone={SUMMARY_TONE[summary.tone]}>{summary.text}</StatePill>
              {onFocusVariant && (
                <Button type="button" size="sm" variant="ghost" onClick={() => onFocusVariant(variant.id)}
                  aria-label={`Channel settings for ${label}`}>Channels</Button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function CommandFeedback({ state, onRetry }: { state: CommandState; onRetry(): void }) {
  if (state.kind === "idle" || state.kind === "busy") {
    return state.kind === "busy" ? <p role="status" className="text-sm text-muted-foreground">Saving…</p> : null;
  }
  if (state.kind === "refused") return <Callout tone="warning">{state.message}</Callout>;
  return (
    <Callout tone={state.kind === "uncertain" ? "danger" : "warning"}
      action={<Button type="button" size="sm" variant="outline" onClick={onRetry}>Retry same change</Button>}>
      {state.message}
    </Callout>
  );
}

/**
 * Sends one change at a time. The exact request (and its idempotency key) is
 * kept until its outcome is known, so a lost response or a busy refusal is
 * retried as the same command and can never apply twice.
 */
function useSalesStatusCommand(productId: number) {
  const client = useQueryClient();
  const { toast } = useToast();
  const pending = useRef<{ request: ChangeSalesStatusRequest; title: string; onDone(): void } | null>(null);
  const [state, setState] = useState<CommandState>({ kind: "idle" });
  useDraftNavigationBlock(false, state.kind === "busy" || state.kind === "uncertain");

  const refresh = () => Promise.all([
    client.invalidateQueries({ queryKey: SALES_STATUS_QUERY_ROOT }),
    invalidateChannelInventory(client),
  ]);

  const send = async () => {
    const current = pending.current;
    if (!current) return;
    setState({ kind: "busy" });
    let saved = false;
    try {
      const result = await changeSalesStatus(current.request);
      saved = true;
      pending.current = null;
      setState({ kind: "idle" });
      current.onDone();
      toast({ title: current.title, description: describeChangeResult(result) });
    } catch (failure) {
      const status = failure instanceof ChannelInventoryApiError ? failure.status : null;
      const code = failure instanceof ChannelInventoryApiError ? failure.code : null;
      if (code === "SALES_STATUS_BUSY") {
        setState({ kind: "retry", message: `${describeError(failure).message}` });
        return;
      }
      if (!isDefinitiveDraftRejection(status)) {
        setState({ kind: "uncertain", message: "The result of this change is unknown. Retry the same change to read its recorded result before changing anything else." });
        return;
      }
      pending.current = null;
      setState({ kind: "refused", message: code === "SALES_STATUS_CHANGED"
        ? "Someone changed this sales status first. Nothing was saved; the latest status is shown."
        : describeError(failure).message });
    }
    try {
      await refresh();
    } catch {
      // The change's own outcome is already reported above; only the follow-up
      // display refresh failed, so say that rather than hide it.
      if (saved) setState({ kind: "refused", message: "Saved, but the latest status could not be loaded. Reload to see it." });
    }
  };

  return {
    state,
    async run(changes: SalesStatusChange[], note: string, title: string, onDone: () => void) {
      if (state.kind === "busy" || state.kind === "uncertain" || changes.length === 0) return;
      pending.current = {
        request: { changes, note: note.trim() || null, idempotencyKey: `sales-status:${productId}:${crypto.randomUUID()}` },
        title,
        onDone,
      };
      await send();
    },
    retry: send,
  };
}
