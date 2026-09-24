import { z } from "zod";

const id = z.number().int().positive().safe();
const quantity = z.number().int().nonnegative().safe();
const identity = z.string().min(1).max(255);
const timestamp = z.string().datetime({ offset: true });
// Canonical catalog column is numeric(10,2), in grams per ordered variant.
export const MAX_CATALOG_RETURN_UNIT_WEIGHT_GRAMS = 99_999_999.99;

/** Inspection bounds are rejection limits, never permission to truncate evidence. */
export const CUSTOMER_RETURN_INSPECTION_LIMITS = Object.freeze({
  shops: 20, lines: 200, wmsItems: 2_000, claims: 5_000,
  bindings: 10_000, packageItems: 10_000, labels: 10_000, events: 20_000,
});

export const customerReturnInspectionShopSchema = z.object({
  channelId: id, connectionId: id, shopDomain: identity, displayName: z.string().min(1).max(100),
}).strict();
export type CustomerReturnInspectionShop = z.infer<typeof customerReturnInspectionShopSchema>;

export const customerReturnLocalOrderSchema = z.object({
  omsOrderId: id, channelId: id, externalOrderId: identity,
  externalOrderNumber: z.string().min(1).max(50), purchasedAt: timestamp,
  shipToCountry: z.string().max(100).nullable(), cancelledAt: timestamp.nullable(),
}).strict();
export const customerReturnLocalLineSchema = z.object({
  omsOrderLineId: id, externalLineItemId: identity.nullable(),
  title: z.string().max(300).nullable(), variantTitle: z.string().max(200).nullable(),
  sku: z.string().max(100).nullable(), quantity,
  requiresShipping: z.boolean().nullable(),
  unitWeightGrams: z.number().positive().finite().max(MAX_CATALOG_RETURN_UNIT_WEIGHT_GRAMS).nullable(),
}).strict();
export const customerReturnLocalWmsItemSchema = z.object({
  wmsOrderId: id, wmsOrderItemId: id, omsOrderLineId: id.nullable(),
  channelId: id.nullable(), source: identity, omsOrderReference: identity.nullable(),
  legacyOrderReference: identity.nullable(), externalOrderId: identity.nullable(),
  externalLineItemId: identity.nullable(), quantity, fulfilledQuantity: quantity,
  warehouseStatus: identity,
}).strict();
export const customerReturnLocalRootClaimSchema = z.object({
  claimId: id, authorizationId: id, authorizationLineId: id,
  channelId: id, omsOrderId: id, omsOrderLineId: id, externalLineItemId: identity,
  wmsOrderItemId: id, fulfillmentId: identity, fulfillmentLineItemId: identity,
  quantity: quantity.refine(value => value > 0),
}).strict();
export const customerReturnLocalLegacyClaimSchema = z.object({
  returnId: id, returnItemId: id, wmsOrderId: id, wmsOrderItemId: id.nullable(),
  omsOrderLineId: id.nullable(), externalLineItemId: identity.nullable(),
  expectedQuantity: quantity, receivedQuantity: quantity, status: identity,
  refundExternalId: identity.nullable(), source: identity,
}).strict();
export const customerReturnLocalUnallocatedReturnSchema = z.object({
  returnId: id, wmsOrderId: id, status: identity, refundExternalId: identity.nullable(),
}).strict();
export const customerReturnLocalInventoryReturnSchema = z.object({
  transactionId: id, wmsOrderId: id.nullable(), wmsOrderItemId: id.nullable(),
  quantityDelta: z.number().int().safe(), occurredAt: timestamp,
}).strict();

/** Raw retained provenance. receipt providerFulfillmentLineId may be a REST
 * purchased-line ID; only a complete provider snapshot can establish its type. */
export const customerReturnLocalBindingSchema = z.object({
  kind: z.enum(["receipt", "push"]), bindingId: id, parentId: id,
  provider: identity, sourceChannelId: id.nullable(), sourceOrderId: identity,
  fulfillmentId: identity.nullable(), providerFulfillmentLineId: identity.nullable(),
  purchasedLineId: identity.nullable(), omsOrderLineId: id.nullable(),
  wmsOrderItemId: id.nullable(), physicalShipmentId: id.nullable(),
  physicalShipmentItemId: id.nullable(), quantity,
  status: identity, source: identity,
}).strict();
export const customerReturnLocalPackageItemSchema = z.object({
  physicalShipmentItemId: id, physicalShipmentId: id,
  wmsOrderItemId: id.nullable(), omsOrderLineId: id.nullable(),
  legacyShipmentItemId: id.nullable(), legacyShipmentId: id.nullable(),
  purpose: identity, replacementForOrderItemId: id.nullable(),
  correctionForPhysicalShipmentItemId: id.nullable(),
  originalQuantity: quantity, effectiveQuantity: quantity,
  status: identity, provider: identity,
  providerPhysicalShipmentId: identity,
  trackingNumber: z.string().max(200).nullable(), carrier: z.string().max(100).nullable(),
}).strict();
export const customerReturnLocalPackageLabelSchema = z.object({
  linkId: id, labelId: id, physicalShipmentId: id,
  provider: identity, providerLabelId: identity, trackingNumber: identity,
  normalizedTrackingNumber: identity, carrier: z.string().max(100).nullable(),
  status: identity, direction: identity, voidedAt: timestamp.nullable(),
}).strict();
export const customerReturnLocalCarrierEventSchema = z.object({
  eventId: id, matchId: id, labelId: id, canonicalStatus: identity,
  dispatchEvidence: identity, occurredAt: timestamp.nullable(),
  actualDeliveryAt: timestamp.nullable(), receivedAt: timestamp,
}).strict();

export const customerReturnLocalInspectionIssueSchema = z.object({
  code: z.enum([
    "purchased_line_identity_missing", "purchased_line_identity_conflict",
    "wms_identity_conflict", "legacy_claim_allocation_unknown",
    "local_claim_identity_conflict", "local_claim_quantity_conflict",
    "unallocated_return_evidence", "inventory_return_correlation_unknown",
  ]),
  /** null means affected ownership cannot be narrowed safely to a purchased line. */
  omsOrderLineId: id.nullable(),
}).strict();

export const customerReturnLocalInspectionSnapshotSchema = z.object({
  observedAt: timestamp, shop: customerReturnInspectionShopSchema,
  order: customerReturnLocalOrderSchema,
  lines: z.array(customerReturnLocalLineSchema).max(CUSTOMER_RETURN_INSPECTION_LIMITS.lines),
  wmsItems: z.array(customerReturnLocalWmsItemSchema).max(CUSTOMER_RETURN_INSPECTION_LIMITS.wmsItems),
  rootClaims: z.array(customerReturnLocalRootClaimSchema).max(CUSTOMER_RETURN_INSPECTION_LIMITS.claims),
  legacyClaims: z.array(customerReturnLocalLegacyClaimSchema).max(CUSTOMER_RETURN_INSPECTION_LIMITS.claims),
  unallocatedReturns: z.array(customerReturnLocalUnallocatedReturnSchema).max(CUSTOMER_RETURN_INSPECTION_LIMITS.claims),
  inventoryReturnEvidence: z.array(customerReturnLocalInventoryReturnSchema).max(CUSTOMER_RETURN_INSPECTION_LIMITS.claims),
  fulfillmentBindings: z.array(customerReturnLocalBindingSchema).max(CUSTOMER_RETURN_INSPECTION_LIMITS.bindings),
  packageItems: z.array(customerReturnLocalPackageItemSchema).max(CUSTOMER_RETURN_INSPECTION_LIMITS.packageItems),
  packageLabels: z.array(customerReturnLocalPackageLabelSchema).max(CUSTOMER_RETURN_INSPECTION_LIMITS.labels),
  carrierEvents: z.array(customerReturnLocalCarrierEventSchema).max(CUSTOMER_RETURN_INSPECTION_LIMITS.events),
  issues: z.array(customerReturnLocalInspectionIssueSchema).max(CUSTOMER_RETURN_INSPECTION_LIMITS.lines * 8 + 8),
}).strict();
export type CustomerReturnLocalInspectionSnapshot = z.infer<typeof customerReturnLocalInspectionSnapshotSchema>;
export type CustomerReturnLocalInspectionIssue = z.infer<typeof customerReturnLocalInspectionIssueSchema>;

export interface CustomerReturnLocalInspectionReader {
  listShops(): Promise<readonly CustomerReturnInspectionShop[]>;
  read(input: { channelId: number; connectionId: number; orderReference: string }): Promise<CustomerReturnLocalInspectionSnapshot | null>;
}

export class CustomerReturnLocalInspectionError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "CustomerReturnLocalInspectionError";
  }
}
