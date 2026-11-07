import { DEFAULT_SALES_STATUS, levelSetting, resolveSalesStatus, salesStatusScopeKey } from "@shared/inventory/sales-status-resolution";
import type {
  SalesStatus,
  SalesStatusChange,
  SalesStatusChangeResult,
  SalesStatusEntry,
  SalesStatusProductView,
  SalesStatusScope,
  SalesStatusTarget,
} from "@shared/types/inventory-sales-status";

/**
 * Pure presentation and command rules for the all-channels sales status. The
 * server decides and records; this module explains the current state with
 * the same resolution the planner uses (shared/inventory/sales-status-resolution.ts:
 * a SKU sells only if its product and the SKU are both Selling) and builds the
 * exact changes a click asks for, each pinned to the revision on screen.
 */

export type SalesStatusChannel = SalesStatusProductView["channels"][number];
export type SalesStatusVariant = SalesStatusProductView["variants"][number];

/** The item a control acts on: the whole product (null) or one SKU. */
export type SalesStatusItem = { productVariantId: number | null };

export interface ChannelStatus {
  channel: SalesStatusChannel;
  status: SalesStatus;
  source: SalesStatusEntry | null;
  /** The SKU is stopped here because its product is (never true for the product itself). */
  stoppedByProduct: boolean;
}

export interface StatusSummary {
  tone: "selling" | "stopped" | "mixed";
  text: string;
}

/** Shown wherever a SKU is stopped by its product rather than by its own setting. */
export const STOPPED_BY_PRODUCT = "Stopped because the product is stopped";

function scopeOf(view: SalesStatusProductView, item: SalesStatusItem, channelId: number | null): SalesStatusScope {
  return { channelId, productId: view.product.id, productVariantId: item.productVariantId };
}

/** The setting stored exactly at this scope, if any. */
export function entryAt(view: SalesStatusProductView, item: SalesStatusItem, channelId: number | null): SalesStatusEntry | null {
  const key = salesStatusScopeKey(scopeOf(view, item, channelId));
  return view.entries.find((entry) => entry.scopeKey === key) ?? null;
}

/**
 * The channels a summary speaks for: those Echelon sends stock to. A channel
 * whose stock Echelon does not send still gets its setting, but saying a
 * product "sells" there would be a claim Echelon cannot back.
 */
export function summaryChannels(view: SalesStatusProductView): SalesStatusChannel[] {
  const publishing = view.channels.filter((channel) => channel.publishesStock);
  return publishing.length > 0 ? publishing : view.channels;
}

/** The product's own status on each channel: its channel exception, else its all-channels setting, else Selling. */
export function productStatuses(view: SalesStatusProductView, channels = view.channels): ChannelStatus[] {
  return channels.map((channel) => {
    const source = levelSetting(view.entries, { channelId: channel.id, productId: view.product.id, productVariantId: null });
    return { channel, status: source?.status ?? DEFAULT_SALES_STATUS, source, stoppedByProduct: false };
  });
}

/** One SKU's effective status on each channel, exactly as the planner resolves it. */
export function skuStatuses(view: SalesStatusProductView, productVariantId: number, channels = view.channels): ChannelStatus[] {
  return channels.map((channel) => {
    const resolution = resolveSalesStatus({
      channelId: channel.id, productId: view.product.id, productVariantId, entries: view.entries,
    });
    return { channel, status: resolution.status, source: resolution.source, stoppedByProduct: resolution.stoppedByProduct };
  });
}

export function itemStatuses(view: SalesStatusProductView, item: SalesStatusItem, channels = view.channels): ChannelStatus[] {
  return item.productVariantId === null ? productStatuses(view, channels) : skuStatuses(view, item.productVariantId, channels);
}

/**
 * "Selling everywhere", "Stopped everywhere except Shopify", "Selling
 * everywhere except eBay and Walmart". A mixed state is phrased from the
 * item's all-channels status, so it reads the way it was set up.
 */
export function summarizeStatuses(statuses: readonly ChannelStatus[], allChannels: SalesStatus): StatusSummary {
  const stopped = statuses.filter((entry) => entry.status === "stopped");
  const selling = statuses.filter((entry) => entry.status === "selling");
  if (stopped.length === 0) return { tone: "selling", text: "Selling everywhere" };
  if (selling.length === 0) return { tone: "stopped", text: "Stopped everywhere" };
  const names = (entries: readonly ChannelStatus[]) => listNames(entries.map((entry) => entry.channel.name));
  return allChannels === "stopped"
    ? { tone: "mixed", text: `Stopped everywhere except ${names(selling)}` }
    : { tone: "mixed", text: `Selling everywhere except ${names(stopped)}` };
}

/**
 * The item's status on all channels before channel exceptions. A SKU is
 * stopped everywhere when its product or the SKU itself is.
 */
export function allChannelsStatus(view: SalesStatusProductView, item: SalesStatusItem): SalesStatus {
  const productStopped = entryAt(view, { productVariantId: null }, null)?.status === "stopped";
  if (item.productVariantId === null) return productStopped ? "stopped" : DEFAULT_SALES_STATUS;
  return productStopped || entryAt(view, item, null)?.status === "stopped" ? "stopped" : DEFAULT_SALES_STATUS;
}

export function summarizeItem(view: SalesStatusProductView, item: SalesStatusItem): StatusSummary {
  return summarizeStatuses(itemStatuses(view, item, summaryChannels(view)), allChannelsStatus(view, item));
}

/** Why one channel's status is what it is, in the operator's words. */
export function describeChannelStatus(view: SalesStatusProductView, status: ChannelStatus): string {
  if (status.stoppedByProduct) return STOPPED_BY_PRODUCT;
  const state = status.status === "stopped" ? "Stopped" : "Selling";
  if (!status.source) return `${state} · Default`;
  const item = status.source.scope.productVariantId === null ? "Product setting" : "SKU setting";
  const where = status.source.scope.channelId === null
    ? "all channels"
    : `${view.channels.find((channel) => channel.id === status.source!.scope.channelId)?.name ?? `channel ${status.source.scope.channelId}`} only`;
  return `${state} · ${item}, ${where}`;
}

/** The channels where this SKU is stopped because its product is. */
export function channelsStoppedByProduct(view: SalesStatusProductView, productVariantId: number): SalesStatusChannel[] {
  return skuStatuses(view, productVariantId).filter((entry) => entry.stoppedByProduct).map((entry) => entry.channel);
}

/** Whether the item has a stop of its own (all channels or any channel) that resuming would remove. */
export function hasOwnStop(view: SalesStatusProductView, item: SalesStatusItem): boolean {
  return entryAt(view, item, null)?.status === "stopped"
    || view.channels.some((channel) => entryAt(view, item, channel.id)?.status === "stopped");
}

function change(view: SalesStatusProductView, item: SalesStatusItem, channelId: number | null, status: SalesStatusTarget): SalesStatusChange[] {
  const current = entryAt(view, item, channelId);
  const unchanged = status === "inherit" ? current === null : current?.status === status;
  return unchanged ? [] : [{ scope: scopeOf(view, item, channelId), status, expectedRevision: current?.revision ?? null }];
}

/** The change one exception control asks for: follow, sell or stop on one channel. */
export function channelChanges(view: SalesStatusProductView, item: SalesStatusItem, channelId: number, status: SalesStatusTarget): SalesStatusChange[] {
  return change(view, item, channelId, status);
}

/**
 * The item's own all-channels setting. Selling everywhere is the default, so
 * it is stored as no setting at all; only Stopped is stored.
 */
export function allChannelsChanges(view: SalesStatusProductView, item: SalesStatusItem, status: SalesStatusTarget): SalesStatusChange[] {
  return change(view, item, null, status === "selling" ? "inherit" : status);
}

/** Every channel exception set on this item, removed. */
function clearChannelExceptions(view: SalesStatusProductView, item: SalesStatusItem): SalesStatusChange[] {
  return view.channels.flatMap((channel) => change(view, item, channel.id, "inherit"));
}

/**
 * Stop everywhere: this item is stopped on every channel, so its own channel
 * exceptions go too. Stopping a product stops all its SKUs.
 */
export function stopEverywhereChanges(view: SalesStatusProductView, item: SalesStatusItem): SalesStatusChange[] {
  return [...change(view, item, null, "stopped"), ...clearChannelExceptions(view, item)];
}

/**
 * Resume everywhere: removes the item's own settings. A SKU whose product is
 * stopped stays stopped where the product is; only resuming the product sells
 * it there.
 */
export function resumeEverywhereChanges(view: SalesStatusProductView, item: SalesStatusItem): SalesStatusChange[] {
  return [...change(view, item, null, "inherit"), ...clearChannelExceptions(view, item)];
}

export function bulkChanges(view: SalesStatusProductView, productVariantIds: readonly number[], action: "stop" | "resume"): SalesStatusChange[] {
  return productVariantIds.flatMap((productVariantId) => action === "stop"
    ? stopEverywhereChanges(view, { productVariantId })
    : resumeEverywhereChanges(view, { productVariantId }));
}

/** Automation holds on this item that keep stock at zero whatever the sales status says. */
export function otherHoldsFor(view: SalesStatusProductView, item: SalesStatusItem): SalesStatusProductView["otherHolds"] {
  return view.otherHolds.filter((hold) => hold.productVariantId === null
    || item.productVariantId === null || hold.productVariantId === item.productVariantId);
}

/** One sentence on what a completed change did to stock, for the confirmation toast. */
export function describeChangeResult(result: SalesStatusChangeResult): string {
  if (result.affectedProductIds.length === 0) return "Nothing needed to change; it was already set that way.";
  const rows = result.republished.reduce((total, product) => total + product.publicationRows, 0);
  const parts = [rows > 0 ? `${rows} stock update${rows === 1 ? "" : "s"} queued for the channels.` : "Marketplace quantities were already right."];
  const skipped = result.republished.flatMap((product) => product.skippedDestinations);
  if (skipped.length > 0) {
    parts.push(`Not sent to ${listNames([...new Set(skipped.map((destination) => destination.channelName))])} until that listing is fixed.`);
  }
  if (result.queued.length > 0) {
    parts.push(`${result.queued.length} product${result.queued.length === 1 ? "" : "s"} will update within a few minutes.`);
  }
  return parts.join(" ");
}

export function listNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}
