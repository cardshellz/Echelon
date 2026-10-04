import { z } from "zod";

/**
 * What a vendor may see of one order: the response of
 * GET /api/dropship/orders/:intakeId (the vendor portal's order detail).
 *
 * This schema is the list. The server parses Card Shellz's internal order
 * detail through it. Zod objects drop every key they do not name, at every
 * depth, so a field added to the internal detail later stays internal
 * until someone adds it here. The portal's types are inferred from this
 * schema, so the page can only read what the server sends.
 *
 * Shipping is one amount. Card Shellz prices shipping from parts: the
 * carrier rate, the markup, dunnage and the insurance pool fee
 * (server dropship-shipping-quote-service.ts). The vendor pays their sum.
 * Acceptance records that sum as `shippingCents` and debits it once
 * (server dropship-order-acceptance-service.ts). The parts are not listed
 * here, and neither are the snapshots that repeat them (`pricingSnapshot`,
 * `quotePayload`). Staff see them on the admin order detail, which does not
 * use this schema.
 *
 * The fields are those the portal was typed to receive before this schema
 * existed (client DropshipOrderDetail), less the parts above. Leaf types
 * mirror the server's detail types. The route also checks at compile time
 * that the internal detail fits this schema's input.
 */

/** Database ids and counts: int4 columns, or values the server converts to safe integers. */
const integerSchema = z.number().int().safe();
/** Signed integer cents: a wallet debit is negative. Never a float. */
const centsSchema = z.number().int().safe();

/**
 * A point in time, sent as an ISO-8601 string. The server's detail holds a
 * Date (node-postgres returns timestamptz columns as Date); an ISO string
 * is accepted too, so the wire form parses as well.
 */
const instantSchema = z
  .union([z.date(), z.string().datetime({ offset: true })])
  .transform((value) => (value instanceof Date ? value.toISOString() : value));

/**
 * The audit payload keys the portal shows, and the only ones sent. Audit
 * payloads are open JSON written by many services. A key a writer adds
 * later stays internal unless it is listed here.
 */
export const VENDOR_ORDER_AUDIT_PAYLOAD_KEYS = Object.freeze([
  "errorCode",
  "errorMessage",
  "reason",
  "shippingQuoteSnapshotId",
  "omsOrderId",
  "walletLedgerEntryId",
  "totalDebitCents",
  "availableBalanceCents",
  "paymentHoldExpiresAt",
] as const);

export type VendorOrderAuditPayloadValue = string | number | boolean | null;

/**
 * Keeps the listed keys whose values are plain values. A nested object or
 * array under a listed key is dropped, since nothing in it was reviewed.
 * A payload that is not an object yields {}.
 */
export function pickVendorOrderAuditPayload(payload: unknown): Record<string, VendorOrderAuditPayloadValue> {
  const kept: Record<string, VendorOrderAuditPayloadValue> = {};
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return kept;
  const source = payload as Record<string, unknown>;
  for (const key of VENDOR_ORDER_AUDIT_PAYLOAD_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
    const value = source[key];
    if (value === null || typeof value === "string" || typeof value === "boolean"
      || (typeof value === "number" && Number.isFinite(value))) {
      kept[key] = value;
    }
  }
  return kept;
}

const vendorSummarySchema = z.object({
  vendorId: integerSchema,
  memberId: z.string(),
  businessName: z.string().nullable(),
  email: z.string().nullable(),
  status: z.string(),
  entitlementStatus: z.string(),
});

const storeConnectionSchema = z.object({
  storeConnectionId: integerSchema,
  platform: z.string(),
  status: z.string(),
  setupStatus: z.string(),
  launchReady: z.boolean(),
  externalDisplayName: z.string().nullable(),
  shopDomain: z.string().nullable(),
});

const paymentHoldSchema = z.object({
  totalDebitCents: centsSchema,
  rewardsCents: centsSchema.nullable(),
  currency: z.string(),
  expiresAt: instantSchema.nullable(),
});

/** The buyer's address as the marketplace sent it; every part may be missing. */
const shipToSchema = z.object({
  name: z.string().optional(),
  company: z.string().optional(),
  address1: z.string().optional(),
  address2: z.string().optional(),
  city: z.string().optional(),
  region: z.string().optional(),
  postalCode: z.string().optional(),
  country: z.string().optional(),
  phone: z.string().optional(),
  email: z.string().optional(),
});

const totalsSchema = z.object({
  retailSubtotalCents: centsSchema.nullable(),
  shippingPaidCents: centsSchema.nullable(),
  taxCents: centsSchema.nullable(),
  discountCents: centsSchema.nullable(),
  grandTotalCents: centsSchema.nullable(),
  currency: z.string(),
});

const lineSchema = z.object({
  lineIndex: integerSchema,
  externalLineItemId: z.string().nullable(),
  externalListingId: z.string().nullable(),
  externalOfferId: z.string().nullable(),
  sku: z.string().nullable(),
  productVariantId: integerSchema.nullable(),
  quantity: integerSchema,
  unitRetailPriceCents: centsSchema.nullable(),
  lineRetailTotalCents: centsSchema.nullable(),
  title: z.string().nullable(),
});

/** What the order cost the vendor. `shippingCents` already holds the insurance pool fee. */
const economicsSchema = z.object({
  economicsSnapshotId: integerSchema,
  shippingQuoteSnapshotId: integerSchema.nullable(),
  warehouseId: integerSchema.nullable(),
  currency: z.string(),
  retailSubtotalCents: centsSchema,
  wholesaleSubtotalCents: centsSchema,
  shippingCents: centsSchema,
  feesCents: centsSchema,
  totalDebitCents: centsSchema,
  createdAt: instantSchema,
});

/** The shipping quote the order was accepted on, as one total. */
const shippingQuoteSchema = z.object({
  quoteSnapshotId: integerSchema,
  warehouseId: integerSchema,
  currency: z.string(),
  destinationCountry: z.string(),
  destinationPostalCode: z.string().nullable(),
  packageCount: integerSchema,
  totalShippingCents: centsSchema,
  createdAt: instantSchema,
});

const walletLedgerEntrySchema = z.object({
  walletLedgerEntryId: integerSchema,
  type: z.string(),
  status: z.string(),
  amountCents: centsSchema,
  currency: z.string(),
  availableBalanceAfterCents: centsSchema.nullable(),
  pendingBalanceAfterCents: centsSchema.nullable(),
  createdAt: instantSchema,
  settledAt: instantSchema.nullable(),
});

const walletRewardsEntrySchema = z.object({
  walletLedgerEntryId: integerSchema,
  amountCents: centsSchema,
  rewardsBalanceAfterCents: centsSchema.nullable(),
  createdAt: instantSchema,
});

const trackingLineItemSchema = z.object({
  externalLineItemId: z.string().nullable(),
  sku: z.string().nullable(),
  title: z.string().nullable(),
  productVariantId: integerSchema.nullable(),
  quantity: integerSchema,
});

const trackingPushSchema = z.object({
  pushId: integerSchema,
  wmsShipmentId: integerSchema.nullable(),
  platform: z.string(),
  status: z.string(),
  carrier: z.string(),
  trackingNumber: z.string(),
  shippedAt: instantSchema,
  externalFulfillmentId: z.string().nullable(),
  attemptCount: integerSchema,
  retryable: z.boolean(),
  lastErrorCode: z.string().nullable(),
  lastErrorMessage: z.string().nullable(),
  lineItems: z.array(trackingLineItemSchema),
  createdAt: instantSchema,
  updatedAt: instantSchema,
  completedAt: instantSchema.nullable(),
});

const auditEventSchema = z.object({
  eventType: z.string(),
  actorType: z.string(),
  actorId: z.string().nullable(),
  severity: z.string(),
  payload: z.unknown().transform(pickVendorOrderAuditPayload),
  createdAt: instantSchema,
});

export const dropshipVendorOrderDetailSchema = z.object({
  intakeId: integerSchema,
  vendor: vendorSummarySchema,
  storeConnection: storeConnectionSchema,
  platform: z.string(),
  externalOrderId: z.string(),
  externalOrderNumber: z.string().nullable(),
  status: z.string(),
  paymentHoldExpiresAt: instantSchema.nullable(),
  paymentHold: paymentHoldSchema.nullable(),
  rejectionReason: z.string().nullable(),
  cancellationStatus: z.string().nullable(),
  omsOrderId: integerSchema.nullable(),
  receivedAt: instantSchema,
  acceptedAt: instantSchema.nullable(),
  updatedAt: instantSchema,
  lineCount: integerSchema,
  totalQuantity: integerSchema,
  // The server's type allows undefined (the normalized payload's field is optional); the wire sends null.
  shipTo: shipToSchema.nullish().transform((value) => value ?? null),
  sourceOrderId: z.string().nullable(),
  orderedAt: z.string().nullable(),
  marketplaceStatus: z.string().nullable(),
  totals: totalsSchema.nullable(),
  lines: z.array(lineSchema),
  economicsSnapshot: economicsSchema.nullable(),
  shippingQuoteSnapshot: shippingQuoteSchema.nullable(),
  walletLedgerEntry: walletLedgerEntrySchema.nullable(),
  walletRewardsEntry: walletRewardsEntrySchema.nullable(),
  trackingPushes: z.array(trackingPushSchema),
  auditEvents: z.array(auditEventSchema),
});

export const dropshipVendorOrderDetailResponseSchema = z.object({
  order: dropshipVendorOrderDetailSchema,
});

/** The order as the vendor receives it (dates are ISO strings). */
export type DropshipVendorOrderDetail = z.output<typeof dropshipVendorOrderDetailSchema>;
export type DropshipVendorOrderDetailResponse = z.output<typeof dropshipVendorOrderDetailResponseSchema>;
/** What the server may hand the schema: its internal detail must be assignable to this. */
export type DropshipVendorOrderDetailResponseInput = z.input<typeof dropshipVendorOrderDetailResponseSchema>;
