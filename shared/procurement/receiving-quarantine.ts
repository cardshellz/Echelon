import { z } from "zod";

// These quantities and versions are persisted as PostgreSQL integers.
export const MAX_RECEIVING_CUSTODY_QUANTITY = 2_147_483_647;
const positiveInteger = z.number().int().positive().max(MAX_RECEIVING_CUSTODY_QUANTITY);
const nonnegativeInteger = z.number().int().min(0).max(MAX_RECEIVING_CUSTODY_QUANTITY);
const reason = z.string().trim().min(1).max(2000);
const reference = z.string().trim().min(1).max(200);
const optionalText = z.string().trim().max(200).nullable();
export const quarantineConditionSchema = z.enum(["damaged", "unexpected", "other"]);

const observationFields = {
  condition: quarantineConditionSchema,
  holdingLocationId: positiveInteger,
  reason,
  evidenceReference: reference,
};

export const receivingQuarantineIntakeSchema = z.discriminatedUnion("kind", [
  z.object({
    ...observationFields,
    kind: z.literal("receipt_line"),
    receivingLineId: positiveInteger,
    expectedUnitVersion: z.string().regex(/^[a-f0-9]{64}$/),
    acceptedQty: nonnegativeInteger,
    heldQty: positiveInteger,
    // Counts are explicitly re-observed; old damagedQty is not added/subtracted.
    countsReviewed: z.literal(true),
  }).strict(),
  z.object({
    ...observationFields,
    kind: z.literal("unidentified"),
    quantity: positiveInteger,
    unitLabel: z.string().trim().min(1).max(80),
    description: z.string().trim().min(1).max(500),
    observedSku: optionalText,
  }).strict(),
]);
export type ReceivingQuarantineIntake = z.infer<typeof receivingQuarantineIntakeSchema>;

export const prepareQuarantineAcceptanceSchema = z.object({
  expectedVersion: nonnegativeInteger,
  observationQty: positiveInteger,
  targetReceivingOrderId: positiveInteger.nullable(),
  targetSourceReceivingLineId: positiveInteger,
  expectedTargetUnitVersion: z.string().regex(/^[a-f0-9]{64}$/),
  productVariantId: positiveInteger,
  expectedUnitsPerVariant: positiveInteger,
  acceptedVariantQty: positiveInteger,
  purchaseOrderLineId: positiveInteger.nullable(),
  inboundShipmentLineId: positiveInteger.nullable(),
  putawayLocationId: positiveInteger,
  reason,
  countConversionReviewed: z.literal(true),
}).strict();
export type PrepareQuarantineAcceptance = z.infer<typeof prepareQuarantineAcceptanceSchema>;

export const returnQuarantineCustodySchema = z.object({
  expectedVersion: nonnegativeInteger,
  observationQty: positiveInteger,
  reason,
  evidenceReference: reference,
}).strict();
export type ReturnQuarantineCustody = z.infer<typeof returnQuarantineCustodySchema>;

export const cancelQuarantineAcceptanceSchema = z.object({
  expectedVersion: nonnegativeInteger,
  acceptanceId: positiveInteger,
  reason,
}).strict();
export type CancelQuarantineAcceptance = z.infer<typeof cancelQuarantineAcceptanceSchema>;

export const receivingCustodyCapabilitySchema = z.object({
  allowed: z.boolean(),
  reason: z.string().nullable(),
}).strict();

export const receivingQuarantineAcceptanceSchema = z.object({
  id: positiveInteger,
  observationQty: positiveInteger,
  receivingOrderId: positiveInteger,
  receiptNumber: z.string(),
  receivingLineId: positiveInteger,
  productVariantId: positiveInteger,
  unitsPerVariant: positiveInteger,
  acceptedVariantQty: positiveInteger,
  status: z.enum(["awaiting_receipt", "received", "cancelled"]),
  createdAt: z.string().datetime(),
  canCancel: receivingCustodyCapabilitySchema,
}).strict();

export const receivingQuarantineDispositionSchema = z.object({
  id: positiveInteger,
  kind: z.enum(["prepare_acceptance", "cancel_acceptance", "receive", "return"]),
  observationQty: positiveInteger,
  actorId: z.string(),
  recordedAt: z.string().datetime(),
  reason: z.string(),
  evidenceReference: z.string().nullable(),
  acceptanceId: positiveInteger.nullable(),
}).strict();

export const receivingQuarantineObservationSchema = z.object({
  id: positiveInteger,
  receivingOrderId: positiveInteger,
  receivingLineId: positiveInteger.nullable(),
  warehouseId: positiveInteger,
  holdingLocationId: positiveInteger,
  holdingLocationLabel: z.string(),
  productId: positiveInteger.nullable(),
  productVariantId: positiveInteger.nullable(),
  unitsPerVariant: positiveInteger.nullable(),
  purchaseOrderLineId: positiveInteger.nullable(),
  inboundShipmentLineId: positiveInteger.nullable(),
  description: z.string(),
  observedSku: z.string().nullable(),
  unitLabel: z.string(),
  condition: quarantineConditionSchema,
  observedQty: positiveInteger,
  unallocatedQty: nonnegativeInteger,
  awaitingReceiptQty: nonnegativeInteger,
  receivedQty: nonnegativeInteger,
  returnedQty: nonnegativeInteger,
  physicalHeldQty: nonnegativeInteger,
  version: nonnegativeInteger,
  reason: z.string(),
  evidenceReference: z.string(),
  actorId: z.string(),
  recordedAt: z.string().datetime(),
  canPrepareAcceptance: receivingCustodyCapabilitySchema,
  canReturn: receivingCustodyCapabilitySchema,
  acceptances: z.array(receivingQuarantineAcceptanceSchema),
  dispositions: z.array(receivingQuarantineDispositionSchema),
}).strict();
export type ReceivingQuarantineObservation = z.infer<typeof receivingQuarantineObservationSchema>;

export const receivingQuarantineViewSchema = z.object({
  receivingOrderId: positiveInteger,
  warehouseId: positiveInteger.nullable(),
  canRecord: receivingCustodyCapabilitySchema,
  canAcceptAll: receivingCustodyCapabilitySchema,
  observations: z.array(receivingQuarantineObservationSchema),
}).strict();
export type ReceivingQuarantineView = z.infer<typeof receivingQuarantineViewSchema>;

export const receivingQuarantineCommandResultSchema = z.object({
  observation: receivingQuarantineObservationSchema,
  acceptance: receivingQuarantineAcceptanceSchema.nullable(),
}).strict();
export type ReceivingQuarantineCommandResult = z.infer<typeof receivingQuarantineCommandResultSchema>;

export const receivingQuarantineAcceptanceOptionSchema = z.object({
  receivingLineId: positiveInteger,
  unitVersion: z.string().regex(/^[a-f0-9]{64}$/),
  targetReceivingOrderId: positiveInteger.nullable(),
  receiptNumber: z.string(),
  productId: positiveInteger,
  productVariantId: positiveInteger,
  sku: z.string().nullable(),
  productName: z.string(),
  unitsPerVariant: positiveInteger,
  purchaseOrderLineId: positiveInteger.nullable(),
  inboundShipmentLineId: positiveInteger.nullable(),
  putawayLocationId: positiveInteger.nullable(),
}).strict();
export const receivingQuarantineAcceptanceOptionsSchema = z.object({
  items: z.array(receivingQuarantineAcceptanceOptionSchema),
  nextCursor: positiveInteger.nullable(),
}).strict();
export type ReceivingQuarantineAcceptanceOption = z.infer<typeof receivingQuarantineAcceptanceOptionSchema>;
