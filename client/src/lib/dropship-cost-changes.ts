/**
 * The vendor's view of .ops cost changes on their listings
 * (docs/DROPSHIP-COST-CHANGE-CONTROLS.md, C4): the response contract of
 * GET /api/dropship/cost-changes and the words the portal page uses. Pure:
 * money is integer cents, dates are ISO strings from the server.
 */

import { z } from "zod";
import { costChangeEventTypeValues, costDecreaseTimingValues, type CostChangeEventType } from "@shared/dropship/cost-change-policy";
import { catalogStepPath } from "./dropship-catalog-steps";
import { drawerSearch } from "./dropship-listing-settings-drawer";

export const DROPSHIP_COST_CHANGES_URL = "/api/dropship/cost-changes";

const noticeDecisionSchema = z.enum([
  "sent", "skipped_baseline", "skipped_decrease", "skipped_below_minimum", "skipped_channels_off", "skipped_unannounced",
]);

const announcedChangeSchema = z.object({
  entryId: z.number().int().positive(),
  productVariantId: z.number().int().positive(),
  variantSku: z.string().nullable(),
  variantName: z.string(),
  productName: z.string(),
  kind: z.enum(["increase", "decrease"]),
  fromCents: z.number().int().nonnegative(),
  unitCostCents: z.number().int().positive(),
  effectiveAt: z.string(),
  announcedAt: z.string(),
});

const recentChangeSchema = z.object({
  logId: z.number().int().positive(),
  productVariantId: z.number().int().positive(),
  variantSku: z.string().nullable(),
  variantName: z.string(),
  productName: z.string(),
  eventType: z.enum(costChangeEventTypeValues),
  fromCents: z.number().int().nonnegative().nullable(),
  toCents: z.number().int().nonnegative().nullable(),
  effectiveAt: z.string(),
  observedAt: z.string(),
  noticeDecision: noticeDecisionSchema.nullable(),
});

/** What an increase that took effect did to one of the vendor's listings (C5). */
const listingActionValues = [
  "reprice_queued", "reprice_refused", "awaiting_review", "price_covers_cost", "below_cost_recorded", "below_cost_warned", "below_cost_paused",
  "skipped_inactive_listing", "skipped_price_unavailable",
] as const;

const listingActionSchema = z.object({
  actionId: z.number().int().positive(),
  entryId: z.number().int().positive(),
  listingId: z.number().int().positive(),
  storeConnectionId: z.number().int().positive(),
  platform: z.string(),
  productVariantId: z.number().int().positive(),
  /** The size's product, from servers with PR 10h (D13b); the price link needs it, so an older answer shows none. */
  productId: z.number().int().positive().optional(),
  variantSku: z.string().nullable(),
  variantName: z.string(),
  productName: z.string(),
  action: z.enum(listingActionValues),
  detail: z.string().nullable(),
  listingPriceCents: z.number().int().positive().nullable(),
  unitCostCents: z.number().int().positive(),
  pushJobId: z.number().int().positive().nullable(),
  decidedAt: z.string(),
  holdReleasedAt: z.string().nullable(),
  holdReleaseReason: z.enum(["price_covers_cost", "listing_inactive"]).nullable(),
});

export const dropshipVendorCostChangesSchema = z.object({
  announced: z.array(announcedChangeSchema),
  recent: z.array(recentChangeSchema),
  listingActions: z.array(listingActionSchema),
  policy: z.object({
    increaseNoticeDays: z.number().int().nonnegative(),
    decreaseTiming: z.enum(costDecreaseTimingValues),
    priceProtection: z.boolean(),
    notifyByEmail: z.boolean(),
    notifyInPortal: z.boolean(),
    notifyOnDecrease: z.boolean(),
  }),
  generatedAt: z.string(),
});

export type DropshipVendorCostChanges = z.infer<typeof dropshipVendorCostChangesSchema>;
export type DropshipVendorAnnouncedChange = z.infer<typeof announcedChangeSchema>;
export type DropshipVendorRecentChange = z.infer<typeof recentChangeSchema>;
export type DropshipVendorListingAction = z.infer<typeof listingActionSchema>;

export function parseDropshipVendorCostChanges(value: unknown): DropshipVendorCostChanges {
  const result = dropshipVendorCostChangesSchema.safeParse(value);
  if (!result.success) {
    throw new Error(`The cost changes response did not match its contract: ${result.error.issues.map((issue) => issue.path.join(".")).join(", ")}`);
  }
  return result.data;
}

/** "$8.09" from integer cents, digit by digit. */
export function formatVendorCostCents(cents: number): string {
  if (!Number.isSafeInteger(cents) || cents < 0) return "$0.00";
  const whole = Math.trunc(cents / 100);
  const fraction = String(cents % 100).padStart(2, "0");
  return `$${whole.toLocaleString("en-US")}.${fraction}`;
}

export function formatVendorCostChangeVariant(change: { variantSku: string | null; variantName: string; productName: string }): string {
  const sku = change.variantSku?.trim();
  return `${sku ? sku : change.variantName} · ${change.productName}`;
}

/** The line the portal shows for a recorded change. */
export function describeVendorRecentChange(change: DropshipVendorRecentChange, formatDate: (iso: string) => string): string {
  const money = formatVendorCostCents;
  const date = formatDate(change.effectiveAt);
  switch (change.eventType) {
    case "baseline":
      return `Cost recorded at ${change.toCents !== null ? money(change.toCents) : "an unknown amount"}`;
    case "increase_announced":
    case "decrease_announced":
      return `${money(change.fromCents ?? 0)} → ${money(change.toCents ?? 0)} from ${date}`;
    case "increase_applied":
    case "decrease_applied":
      return `${money(change.fromCents ?? 0)} → ${money(change.toCents ?? 0)}, applied at once`;
    case "increase_reduced":
      return `The increase announced for ${date} is now ${money(change.toCents ?? 0)} instead of ${money(change.fromCents ?? 0)}`;
    case "change_withdrawn":
      return `The change to ${money(change.fromCents ?? 0)} announced for ${date} was withdrawn`;
  }
}

export function describeVendorNoticeDecision(decision: DropshipVendorRecentChange["noticeDecision"]): string {
  switch (decision) {
    case null:
      return "Notice pending";
    case "sent":
      return "You were notified";
    case "skipped_baseline":
      return "No notice: first reading";
    case "skipped_decrease":
      return "No notice: decreases are not announced";
    case "skipped_below_minimum":
      return "No notice: below the notice minimum";
    case "skipped_channels_off":
      return "No notice: notices are switched off";
    case "skipped_unannounced":
      return "No notice: the original change was not announced";
  }
}

/** How the policy's notice terms read to a vendor. */
export function describeVendorNoticeTerms(policy: DropshipVendorCostChanges["policy"]): string[] {
  const lines: string[] = [];
  lines.push(policy.increaseNoticeDays === 0
    ? "A higher .ops cost applies as soon as it is found."
    : `You get ${policy.increaseNoticeDays} ${policy.increaseNoticeDays === 1 ? "day" : "days"}' notice before a higher .ops cost is charged.`);
  lines.push(policy.decreaseTiming === "immediate"
    ? "A lower cost applies as soon as it is found."
    : "A lower cost applies after the same notice.");
  lines.push(policy.priceProtection
    ? "Orders accepted before a change takes effect are charged the cost in force at the time."
    : "Orders are charged the current catalog cost when they are accepted.");
  const channels = [policy.notifyByEmail ? "by email" : null, policy.notifyInPortal ? "in Alerts" : null].filter((value): value is string => value !== null);
  lines.push(channels.length === 0 ? "Changes are recorded here but not sent as notices." : `Notices reach you ${channels.join(" and ")}.`);
  return lines;
}

/** What happened to the listing, in the vendor's words. */
export function describeVendorListingAction(action: DropshipVendorListingAction["action"]): string {
  switch (action) {
    case "reprice_queued":
      return "Repriced by your pricing rules";
    case "reprice_refused":
      return "Reprice could not be queued";
    case "awaiting_review":
      return "Waiting for your price review";
    case "price_covers_cost":
      return "Your price still covers the cost";
    case "below_cost_recorded":
    case "below_cost_warned":
      return "Priced under the cost";
    case "below_cost_paused":
      return "Paused: priced under the cost";
    case "skipped_inactive_listing":
      return "Not live at the time";
    case "skipped_price_unavailable":
      return "Price could not be read";
  }
}

/** The line under the action: what to do, or what has happened since. */
export function describeVendorListingActionDetail(action: DropshipVendorListingAction, formatDate: (iso: string) => string): string | null {
  // Interim (PR 10 PROPOSAL): a row with a price link names the link's place, so the two lines don't
  // read as two instructions; a row without one (another platform, an older answer) still names the page.
  const place = vendorListingActionPriceLink(action) === null ? "on the Catalog page" : "in Listing settings";
  switch (action.action) {
    case "reprice_queued":
      return action.pushJobId !== null ? `Queued as push job ${action.pushJobId}; the result shows on the Catalog page.` : null;
    case "reprice_refused":
      return "Your store could not take a push at the time. Fix what the Onboarding page shows, then queue the listing again.";
    case "awaiting_review":
      return "Your listing price is unchanged. Queue the listing from the Catalog page to publish the price your rules now give.";
    case "below_cost_recorded":
    case "below_cost_warned":
      return `Each sale loses money until you raise the price ${place}.`;
    case "below_cost_paused":
      return action.holdReleasedAt !== null
        ? `Selling again since ${formatDate(action.holdReleasedAt)}.`
        : `It publishes zero quantity until the price covers the cost. Raise the price ${place} to resume.`;
    case "price_covers_cost":
    case "skipped_inactive_listing":
    case "skipped_price_unavailable":
      return null;
  }
}

// Interim (PR 10 PROPOSAL): the link under a below-cost action (REC:922 "links to that size"; plan 12.2 "Cost changes").
const COST_CHANGE_PRICE_LINK_WORDS = "Change its price in Listing settings";
export const COST_CHANGE_PRICE_LINK_LABEL = `${COST_CHANGE_PRICE_LINK_WORDS} ›`;

/** The actions whose way out is raising the size's price. */
const PRICE_LINK_ACTIONS: ReadonlySet<DropshipVendorListingAction["action"]> = new Set(["below_cost_recorded", "below_cost_warned", "below_cost_paused"]);

export interface VendorListingActionPriceLink {
  /** Portal-relative (`/catalog/setup?product=&size=`, D21); the page adds `dropshipPortalPath`. */
  href: string;
  label: string;
  /** The link's name for a screen reader: the label, then the size, so the rows' links tell apart (plan 3.4). */
  name: string;
  /** The store the Catalog page must open on before following the link (`rememberCatalogStore`, plan A4). */
  storeConnectionId: number;
}

/**
 * Where the vendor raises the price a below-cost action names: the size's
 * Exact price box in the product's drawer, Listing settings. Listing settings
 * is eBay-only, so only an eBay row gets a link, and only when the server
 * named the product (older answers don't); a pause already released needs none.
 */
export function vendorListingActionPriceLink(
  action: Pick<DropshipVendorListingAction, "action" | "platform" | "productId" | "productVariantId" | "storeConnectionId" | "holdReleasedAt"
    | "variantSku" | "variantName" | "productName">,
): VendorListingActionPriceLink | null {
  if (action.platform !== "ebay" || action.productId === undefined) return null;
  if (!PRICE_LINK_ACTIONS.has(action.action)) return null;
  if (action.action === "below_cost_paused" && action.holdReleasedAt !== null) return null;
  return {
    href: `${catalogStepPath("setup")}${drawerSearch("", { productId: action.productId, productVariantId: action.productVariantId })}`,
    label: COST_CHANGE_PRICE_LINK_LABEL,
    name: `${COST_CHANGE_PRICE_LINK_WORDS}: ${formatVendorCostChangeVariant(action)}`,
    storeConnectionId: action.storeConnectionId,
  };
}

/** "listed at $8.99, cost now $9.99", or just the cost when the price is unknown. */
export function describeVendorListingActionAmounts(action: { listingPriceCents: number | null; unitCostCents: number }): string {
  const cost = `cost now ${formatVendorCostCents(action.unitCostCents)}`;
  return action.listingPriceCents === null ? cost : `listed at ${formatVendorCostCents(action.listingPriceCents)}, ${cost}`;
}

export function isVendorListingActionAttention(action: DropshipVendorListingAction["action"]): boolean {
  return ["reprice_refused", "awaiting_review", "below_cost_recorded", "below_cost_warned", "below_cost_paused"].includes(action);
}

export function isVendorCostIncrease(eventType: CostChangeEventType): boolean {
  return eventType.startsWith("increase");
}
