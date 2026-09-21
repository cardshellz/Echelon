import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJson } from "@shared/utils/canonical-json";
import { decideChannelFulfillmentInventoryPosting } from "./domain/channel-fulfillment-inventory-policy";

export const CHANNEL_FULFILLMENT_RECEIPT_RETRY = "CHANNEL_FULFILLMENT_RECEIPT_RETRY";

const positiveId = z.number().int().positive().safe();
const nullablePositiveId = positiveId.nullable();
const nonnegativeInteger = z.number().int().nonnegative().safe();
const nullableText = z.string().nullable();
const fingerprintSchema = z.string().regex(/^[0-9a-f]{64}$/);

export class ChannelFulfillmentReceiptRetryError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly context: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "ChannelFulfillmentReceiptRetryError";
  }
}

export const receiptRetryScopeSchema = z.object({
  receiptId: positiveId,
}).strict();

export const receiptRetryInputSchema = receiptRetryScopeSchema.extend({
  previewOnly: z.boolean().default(true),
  expectedStateFingerprint: fingerprintSchema.optional(),
  reason: z.string().trim().min(10).max(2_000).optional(),
}).strict().superRefine((input, context) => {
  if (!input.previewOnly && (!input.expectedStateFingerprint || !input.reason)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Execution requires the preview fingerprint and an operator reason",
    });
  }
});

export const receiptRetryLineSnapshotSchema = z.object({
  receiptItemId: positiveId,
  sourceFulfillmentLineId: nullableText,
  channelOrderLineId: z.string().min(1),
  quantity: positiveId,
  omsOrderLineId: nullablePositiveId,
  omsOrderId: nullablePositiveId,
  omsChannelOrderLineId: nullableText,
  omsProductVariantId: nullablePositiveId,
  omsSku: nullableText,
  omsRequiresShipping: z.boolean().nullable(),
  omsInventoryTracking: z.boolean().nullable().optional(),
  wmsInventoryTracking: z.boolean().nullable().optional(),
  omsCatalogProductId: nullablePositiveId.optional(),
  wmsCatalogProductId: nullablePositiveId.optional(),
  omsPaidQuantity: nonnegativeInteger.nullable(),
  omsMaxPaidQuantity: nonnegativeInteger.nullable(),
  wmsOrderItemId: nullablePositiveId,
  wmsOrderId: nullablePositiveId,
  wmsOmsOrderLineId: nullablePositiveId,
  wmsProductId: nullablePositiveId,
  wmsSku: nullableText,
  wmsQuantity: nonnegativeInteger.nullable(),
  wmsPickedQuantity: nonnegativeInteger.nullable(),
  wmsFulfilledQuantity: nonnegativeInteger.nullable(),
  wmsItemStatus: nullableText,
  wmsRequiresShipping: z.number().int().nullable(),
  wmsItemOnHold: z.boolean().nullable(),
  wmsOrderStatus: nullableText,
  wmsOrderOnHold: z.number().int().nullable(),
  catalogVariantId: nullablePositiveId,
  catalogProductId: nullablePositiveId,
  catalogSku: nullableText,
  catalogIsActive: z.boolean().nullable(),
  catalogRequiresShipping: z.boolean().nullable(),
  catalogTrackInventory: z.boolean().nullable(),
  sourceShipmentItemId: nullablePositiveId,
  sourceShipmentId: nullablePositiveId,
  sourceOrderItemId: nullablePositiveId,
  sourceHeaderOrderId: nullablePositiveId,
  sourceReplacementForOrderItemId: nullablePositiveId,
  sourceCorrectionForShipmentItemId: nullablePositiveId,
  sourceProductVariantId: nullablePositiveId,
  sourceQuantity: nonnegativeInteger.nullable(),
  sourcePurpose: nullableText,
  sourceFromLocationId: nullablePositiveId,
  sourceShipmentStatus: nullableText,
  sourceShipmentHeld: z.boolean().nullable(),
  physicalShipmentItemId: nullablePositiveId,
  physicalShipmentId: nullablePositiveId,
  physicalOrderItemId: nullablePositiveId,
  physicalLegacySourceShipmentItemId: nullablePositiveId,
  physicalReplacementForOrderItemId: nullablePositiveId,
  physicalCorrectionForShipmentItemId: nullablePositiveId,
  physicalPackageAllocationEntryId: nullablePositiveId,
  physicalProductVariantId: nullablePositiveId,
  physicalSku: nullableText,
  physicalQuantity: nonnegativeInteger.nullable(),
  physicalAdjustmentQuantity: z.number().int().safe().nullable(),
  physicalPurpose: nullableText,
  physicalShipmentStatus: nullableText,
  inventoryTransactionCount: nonnegativeInteger,
}).strict();

export const receiptRetrySnapshotSchema = z.object({
  receiptId: positiveId,
  receiptKey: z.string().min(1),
  requestHash: fingerprintSchema,
  sourceProvider: z.enum(["shopify", "ebay"]),
  sourceOrderId: z.string().min(1),
  sourceFulfillmentId: z.string().min(1),
  sourceEventId: nullableText,
  eventKind: z.string().min(1),
  processingStatus: z.string().min(1),
  attemptCount: nonnegativeInteger,
  retryFailureCount: nonnegativeInteger,
  leaseToken: nullableText,
  leaseExpiresAt: nullableText,
  errorCode: nullableText,
  errorMessage: nullableText,
  processedAt: nullableText,
  omsOrderId: nullablePositiveId,
  orderNumber: nullableText,
  externalOrderId: nullableText,
  physicalShipmentId: nullablePositiveId,
  trackingNumber: nullableText,
  physicalShipmentStatus: nullableText,
  items: z.array(receiptRetryLineSnapshotSchema).max(500),
}).strict();

export type ChannelFulfillmentReceiptRetrySnapshot = z.infer<typeof receiptRetrySnapshotSchema>;
export type ChannelFulfillmentReceiptRetryScope = z.infer<typeof receiptRetryScopeSchema>;

export interface ChannelFulfillmentReceiptRetryPreview {
  readonly receiptId: number;
  readonly eligibleForRetry: boolean;
  readonly blockers: readonly string[];
  readonly stateFingerprint: string;
  readonly snapshot: ChannelFulfillmentReceiptRetrySnapshot;
  readonly providerValidation: "not_performed";
  readonly inventoryImpact: "none";
}

export interface ChannelFulfillmentReceiptRetryResult extends ChannelFulfillmentReceiptRetryPreview {
  readonly mode: "preview" | "execute";
  readonly replayed: boolean;
  readonly requeued: boolean;
}

export interface ChannelFulfillmentReceiptRetryExecution extends ChannelFulfillmentReceiptRetryScope {
  readonly expectedStateFingerprint: string;
  readonly actor: string;
  readonly reason: string;
  readonly requeuedAt: Date;
}

export const receiptRetryExecutionSchema = receiptRetryScopeSchema.extend({
  expectedStateFingerprint: fingerprintSchema,
  actor: z.string().trim().min(1).max(200).refine((value) => value !== "unknown"),
  reason: z.string().trim().min(10).max(2_000),
  requeuedAt: z.date(),
}).strict();

function addLineBlockers(
  blockers: Set<string>,
  snapshot: ChannelFulfillmentReceiptRetrySnapshot,
  line: ChannelFulfillmentReceiptRetrySnapshot["items"][number],
): void {
  const requiredIds = [
    line.omsOrderLineId,
    line.omsOrderId,
    line.omsProductVariantId,
    line.wmsOrderItemId,
    line.wmsOrderId,
    line.wmsOmsOrderLineId,
    line.catalogVariantId,
    line.catalogProductId,
    line.sourceShipmentItemId,
    line.sourceShipmentId,
    line.sourceOrderItemId,
    line.sourceHeaderOrderId,
    line.sourceProductVariantId,
    line.physicalShipmentItemId,
    line.physicalShipmentId,
    line.physicalOrderItemId,
    line.physicalLegacySourceShipmentItemId,
    line.physicalProductVariantId,
  ];
  if (requiredIds.some((value) => value === null)
    || !line.omsChannelOrderLineId
    || !line.omsSku
    || !line.wmsSku
    || !line.catalogSku
    || !line.physicalSku) {
    blockers.add("LINE_IDENTITY_INCOMPLETE");
    return;
  }

  const variantId = line.omsProductVariantId!;
  const variantMatches = line.catalogVariantId === variantId
    && line.sourceProductVariantId === variantId
    && line.physicalProductVariantId === variantId
    && (line.wmsProductId === variantId || line.wmsProductId === line.catalogProductId);
  const lineageMatches = snapshot.omsOrderId === line.omsOrderId
    && snapshot.physicalShipmentId === line.physicalShipmentId
    && line.channelOrderLineId === line.omsChannelOrderLineId
    && line.wmsOmsOrderLineId === line.omsOrderLineId
    && line.sourceOrderItemId === line.wmsOrderItemId
    && line.sourceHeaderOrderId === line.wmsOrderId
    && line.physicalOrderItemId === line.wmsOrderItemId
    && line.physicalLegacySourceShipmentItemId === line.sourceShipmentItemId;
  const skuMatches = new Set([
    line.omsSku!.toUpperCase(),
    line.wmsSku!.toUpperCase(),
    line.catalogSku!.toUpperCase(),
    line.physicalSku!.toUpperCase(),
  ]).size === 1;
  if (!variantMatches || !lineageMatches || !skuMatches) {
    blockers.add("LINE_IDENTITY_CONFLICT");
  }

  const paidAuthority = Math.max(line.omsPaidQuantity ?? -1, line.omsMaxPaidQuantity ?? -1);
  if (line.quantity > paidAuthority
    || line.wmsQuantity !== line.quantity
    || line.wmsPickedQuantity !== line.quantity
    || line.wmsFulfilledQuantity !== line.quantity
    || line.sourceQuantity !== line.quantity
    || line.physicalQuantity !== line.quantity
    || line.physicalAdjustmentQuantity !== 0) {
    blockers.add("LINE_QUANTITY_CONFLICT");
  }

  if (line.wmsItemStatus !== "completed"
    || line.wmsItemOnHold !== false
    || line.wmsOrderOnHold !== 0
    || line.wmsOrderStatus === "cancelled"
    || line.sourceReplacementForOrderItemId !== null
    || line.sourceCorrectionForShipmentItemId !== null
    || line.sourceFromLocationId !== null
    || line.sourcePurpose !== "customer_fulfillment"
    || line.sourceShipmentStatus !== "shipped"
    || line.sourceShipmentHeld !== false
    || line.physicalReplacementForOrderItemId !== null
    || line.physicalCorrectionForShipmentItemId !== null
    || line.physicalPackageAllocationEntryId !== null
    || line.physicalPurpose !== "customer_fulfillment"
    || line.physicalShipmentStatus !== "shipped") {
    blockers.add("LINE_FULFILLMENT_STATE_CONFLICT");
  }

  const decision = decideChannelFulfillmentInventoryPosting({
    omsRequiresShipping: line.omsRequiresShipping,
    omsInventoryTracking: line.omsInventoryTracking, wmsInventoryTracking: line.wmsInventoryTracking,
    omsCatalogProductId: line.omsCatalogProductId, wmsCatalogProductId: line.wmsCatalogProductId,
    wmsRequiresShipping: line.wmsRequiresShipping ?? Number.NaN,
    productVariantId: line.omsProductVariantId,
    catalogVariantId: line.catalogVariantId,
    catalogRequiresShipping: line.catalogRequiresShipping,
    catalogTrackInventory: line.catalogTrackInventory,
  });
  if (decision.status === "conflict") blockers.add("INVENTORY_CONFIGURATION_CONFLICT");
  else if (decision.requiresInventoryPosting) blockers.add("INVENTORY_POSTING_REQUIRED");
  if (line.inventoryTransactionCount > 0) blockers.add("INVENTORY_TRANSACTION_EXISTS");
}

export function previewChannelFulfillmentReceiptRetry(
  rawSnapshot: ChannelFulfillmentReceiptRetrySnapshot,
): ChannelFulfillmentReceiptRetryPreview {
  const parsed = receiptRetrySnapshotSchema.parse(rawSnapshot);
  const snapshot: ChannelFulfillmentReceiptRetrySnapshot = {
    ...parsed,
    items: [...parsed.items].sort((left, right) => left.receiptItemId - right.receiptItemId),
  };
  const blockers = new Set<string>();
  if (snapshot.processingStatus !== "review") blockers.add("RECEIPT_NOT_IN_REVIEW");
  if (snapshot.leaseToken !== null || snapshot.leaseExpiresAt !== null) blockers.add("RECEIPT_HAS_ACTIVE_LEASE");
  if (snapshot.errorCode !== "INVENTORY_RECORD_FAILED") blockers.add("REVIEW_REASON_NOT_SUPPORTED");
  if (snapshot.omsOrderId === null || snapshot.physicalShipmentId === null) {
    blockers.add("RECEIPT_LINEAGE_INCOMPLETE");
  }
  if (snapshot.physicalShipmentStatus !== "shipped") blockers.add("PACKAGE_NOT_SHIPPED");
  if (snapshot.items.length === 0) blockers.add("RECEIPT_HAS_NO_ITEMS");

  const uniqueIdentityFields = [
    ["DUPLICATE_RECEIPT_ITEM", snapshot.items.map((item) => item.receiptItemId)],
    ["DUPLICATE_OMS_LINE", snapshot.items.map((item) => item.omsOrderLineId)],
    ["DUPLICATE_WMS_ITEM", snapshot.items.map((item) => item.wmsOrderItemId)],
    ["DUPLICATE_SOURCE_ITEM", snapshot.items.map((item) => item.sourceShipmentItemId)],
    ["DUPLICATE_PHYSICAL_ITEM", snapshot.items.map((item) => item.physicalShipmentItemId)],
  ] as const;
  for (const [code, values] of uniqueIdentityFields) {
    const complete = values.filter((value): value is number => value !== null);
    if (new Set(complete).size !== complete.length) blockers.add(code);
  }
  for (const line of snapshot.items) addLineBlockers(blockers, snapshot, line);

  const blockerList = Object.freeze([...blockers].sort());
  return Object.freeze({
    receiptId: snapshot.receiptId,
    eligibleForRetry: blockerList.length === 0,
    blockers: blockerList,
    stateFingerprint: createHash("sha256").update(canonicalJson(snapshot)).digest("hex"),
    snapshot,
    providerValidation: "not_performed" as const,
    inventoryImpact: "none" as const,
  });
}

export function receiptRetryIdempotencyKey(input: ChannelFulfillmentReceiptRetryExecution): string {
  const hash = createHash("sha256").update(canonicalJson({
    receiptId: input.receiptId,
    expectedStateFingerprint: input.expectedStateFingerprint,
    actor: input.actor,
    reason: input.reason,
  })).digest("hex");
  return `channel-fulfillment-receipt-retry:v1:${hash}`;
}
