import { DEFAULT_SALES_STATUS, resolveSalesStatus, salesStatusScopeKey } from "@shared/inventory/sales-status-resolution";
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
 * server decides and records; this module only explains the current state
 * with the same precedence the planner uses
 * (shared/inventory/sales-status-resolution.ts) and builds the exact changes
 * a click asks for, each pinned to the revision on screen.
 */

export type SalesStatusChannel = SalesStatusProductView["channels"][number];
export type SalesStatusVariant = SalesStatusProductView["variants"][number];

/** The item a control acts on: the whole product (null) or one SKU. */
export type SalesStatusItem = { productVariantId: number | null };

export interface ChannelStatus {
  channel: SalesStatusChannel;
  status: SalesStatus;
  source: SalesStatusEntry | null;
}

export interface StatusSummary {
  tone: "selling" | "stopped" | "mixed";
  text: string;
}

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

/** What the product's own settings decide on each channel, before any SKU setting. */
export function productStatuses(view: SalesStatusProductView, channels = view.channels): ChannelStatus[] {
  return channels.map((channel) => {
    const source = entryAt(view, { productVariantId: null }, channel.id) ?? entryAt(view, { productVariantId: null }, null);
    return { channel, status: source?.status ?? DEFAULT_SALES_STATUS, source };
  });
}

/** One SKU's effective status on each channel, exactly as the planner resolves it. */
export function skuStatuses(view: SalesStatusProductView, productVariantId: number, channels = view.channels): ChannelStatus[] {
  return channels.map((channel) => {
    const resolution = resolveSalesStatus({
      channelId: channel.id, productId: view.product.id, productVariantId, entries: view.entries,
    });
    return { channel, status: resolution.status, source: resolution.source };
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

/** The item's status on all channels before channel exceptions: its own setting, else its product's, else Selling. */
export function allChannelsStatus(view: SalesStatusProductView, item: SalesStatusItem): SalesStatus {
  const own = entryAt(view, item, null);
  if (own) return own.status;
  if (item.productVariantId !== null) return entryAt(view, { productVariantId: null }, null)?.status ?? DEFAULT_SALES_STATUS;
  return DEFAULT_SALES_STATUS;
}

export function summarizeItem(view: SalesStatusProductView, item: SalesStatusItem): StatusSummary {
  return summarizeStatuses(itemStatuses(view, item, summaryChannels(view)), allChannelsStatus(view, item));
}

/** Which setting decides a status, in the operator's words. */
export function describeSource(view: SalesStatusProductView, source: SalesStatusEntry | null): string {
  if (!source) return "Default";
  const item = source.scope.productVariantId === null ? "Product" : "SKU";
  if (source.scope.channelId === null) return `${item} setting, all channels`;
  const channel = view.channels.find((entry) => entry.id === source.scope.channelId);
  return `${item} setting, ${channel?.name ?? `channel ${source.scope.channelId}`} only`;
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
 * The item's own all-channels setting. A product has no "follow": with nothing
 * set it sells, so selling is stored as no setting at all.
 */
export function allChannelsChanges(view: SalesStatusProductView, item: SalesStatusItem, status: SalesStatusTarget): SalesStatusChange[] {
  const target = item.productVariantId === null && status === "selling" ? "inherit" : status;
  return change(view, item, null, target);
}

/** Every channel exception set on this item, removed. */
function clearChannelExceptions(view: SalesStatusProductView, item: SalesStatusItem): SalesStatusChange[] {
  return view.channels.flatMap((channel) => change(view, item, channel.id, "inherit"));
}

/**
 * Stop everywhere: this item is stopped on every channel, so its own channel
 * exceptions go too. A product's SKUs keep their own settings; the panel lists
 * any SKU that still sells because of one.
 */
export function stopEverywhereChanges(view: SalesStatusProductView, item: SalesStatusItem): SalesStatusChange[] {
  return [...change(view, item, null, "stopped"), ...clearChannelExceptions(view, item)];
}

/**
 * Resume everywhere: this item sells on every channel. A product's settings
 * are removed (it then sells by default). A SKU's settings are removed when
 * its product would then sell everywhere; otherwise the SKU is set to sell on
 * all channels, which outranks its product's settings.
 */
export function resumeEverywhereChanges(view: SalesStatusProductView, item: SalesStatusItem): SalesStatusChange[] {
  const productSellsEverywhere = productStatuses(view).every((entry) => entry.status === "selling");
  const allChannels = item.productVariantId === null || productSellsEverywhere ? "inherit" : "selling";
  return [...change(view, item, null, allChannels), ...clearChannelExceptions(view, item)];
}

export function bulkChanges(view: SalesStatusProductView, productVariantIds: readonly number[], action: "stop" | "resume"): SalesStatusChange[] {
  return productVariantIds.flatMap((productVariantId) => action === "stop"
    ? stopEverywhereChanges(view, { productVariantId })
    : resumeEverywhereChanges(view, { productVariantId }));
}

/** SKUs a product-level stop does not reach because a SKU setting keeps them selling somewhere. */
export function skusSellingDespiteProductStop(view: SalesStatusProductView): SalesStatusVariant[] {
  const channels = summaryChannels(view);
  const productStopped = productStatuses(view, channels).filter((entry) => entry.status === "stopped").map((entry) => entry.channel.id);
  if (productStopped.length === 0) return [];
  return view.variants.filter((variant) => variant.sellable && skuStatuses(view, variant.id, channels)
    .some((entry) => productStopped.includes(entry.channel.id) && entry.status === "selling"));
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

function listNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}
