import { z } from "zod";

/**
 * Channel return-intake provider port (design spec D2a; build spec
 * "Channel return intake adapters").
 *
 * Every vendor channel pipes return events + label costs via its API. A
 * per-channel provider (eBay Post-Order return cases, Shopify Admin
 * returns/refunds) polls one store connection and yields normalized RMA
 * drafts; the channel-agnostic poll service + intake service turn drafts
 * into RMA rows. Manual entry is rejected as a design input (D2a).
 *
 * Money is always integer cents. `labelCostCents` is nullable: eBay exposes
 * the actual return label cost on the case; Shopify exposes it only when the
 * vendor bought the label via Shopify Shipping (best-effort otherwise). The
 * fee engine treats null as "unknown" — never zero.
 */

const positiveIdSchema = z.number().int().positive();
const nonnegativeCentsSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

export const dropshipReturnIntakeItemDraftSchema = z.object({
  /** Channel-side line reference (eBay lineItemId, Shopify line item gid). */
  channelLineId: z.string().trim().min(1).max(255),
  /** Original order's external line item id when the channel exposes it. */
  externalLineItemId: z.string().trim().min(1).max(255).nullable().optional(),
  sku: z.string().trim().min(1).max(255).nullable().optional(),
  quantity: z.number().int().positive(),
}).strict();
export type DropshipReturnIntakeItemDraft = z.infer<typeof dropshipReturnIntakeItemDraftSchema>;

export const dropshipReturnTrackingDraftSchema = z.object({
  carrier: z.string().trim().min(1).max(80).nullable(),
  trackingNumber: z.string().trim().min(1).max(120),
  expectedDeliveryAt: z.coerce.date().nullable(),
  status: z.string().trim().min(1).max(80).nullable(),
}).strict();
export type DropshipReturnTrackingDraft = z.infer<typeof dropshipReturnTrackingDraftSchema>;

export const dropshipReturnIntakeDraftSchema = z.object({
  /** Channel-side return/case/refund identifier. Dedupe key per store. */
  channelReturnId: z.string().trim().min(1).max(120),
  /** Original order reference as the channel knows it (external order id). */
  orderRef: z.string().trim().min(1).max(255),
  items: z.array(dropshipReturnIntakeItemDraftSchema).min(1).max(200),
  /** Actual return label cost in cents; null when the channel doesn't expose it. */
  labelCostCents: nonnegativeCentsSchema.nullable(),
  /** Channel-provided reason mapped to a fault hint; never authoritative. */
  faultHint: z.enum(["card_shellz", "vendor", "customer", "marketplace", "carrier"]).nullable(),
  /** Channel-provided reason text, preserved for audit. */
  reasonText: z.string().trim().min(1).max(1000).nullable(),
  /** Raw channel payload + extracted fields, stored on the RMA (D2a evidence). */
  evidence: z.record(z.unknown()),
  returnTracking: dropshipReturnTrackingDraftSchema.nullable(),
}).strict();
export type DropshipReturnIntakeDraft = z.infer<typeof dropshipReturnIntakeDraftSchema>;

export interface DropshipReturnIntakeStoreConnection {
  vendorId: number;
  storeConnectionId: number;
  lastReturnSyncAt: Date | null;
}

export interface DropshipReturnIntakeFetchResult {
  drafts: DropshipReturnIntakeDraft[];
  /** Returns the provider saw but intentionally skipped (e.g. non-return refunds). */
  ignored: number;
}

/**
 * Implemented per channel (eBay, Shopify). fetchReturns must be a pure read
 * of the channel API for the window [since, until]; all persistence happens
 * in the poll service / intake service.
 */
export interface DropshipReturnIntakeProvider {
  fetchReturns(input: {
    connection: DropshipReturnIntakeStoreConnection;
    since: Date;
    until: Date;
  }): Promise<DropshipReturnIntakeFetchResult>;
}
