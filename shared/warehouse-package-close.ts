import { z } from "zod";
import { workEvidenceIdSchema } from "./warehouse-assembly-work";

const positiveInt = z.number().int().positive().max(2_147_483_647);
const quantity = z.number().int().min(0).max(2_147_483_647);
const nonblank = (max: number) => z.string().trim().min(1).max(max);
export const packageCloseEvidenceHashSchema = z.string().regex(/^[a-f0-9]{64}$/);

/** Proposed owner DTO, not a claim that these facts are already available at runtime. */
export const packageCloseSourceLineSchema = z.object({
  sourceShipmentItemId: positiveInt,
  orderId: positiveInt,
  orderItemId: positiveInt,
  warehouseId: positiveInt,
  productVariantId: positiveInt,
  sku: nonblank(100),
  quantity: positiveInt,
  authorizedSourceQuantity: positiveInt,
  // Exclusively assigned to this source by the pick owner, NOT the raw order-line total.
  pickedQuantity: quantity,
  // Quantity already closed across OTHER packages for this exact source line.
  otherClosedQuantity: quantity,
  held: z.boolean(),
  cancelled: z.boolean(),
  requiresShipping: z.boolean(),
}).strict();

export const packageCloseLabelSchema = z.object({
  id: workEvidenceIdSchema,
  provider: nonblank(40),
  providerAccountId: nonblank(200),
  providerPackageId: nonblank(200),
  revision: positiveInt,
  status: z.enum(["active", "unknown", "voided", "superseded"]),
  direction: z.enum(["outbound", "return", "unknown"]),
  normalizedTrackingNumber: z.string().regex(/^[A-Z0-9]{4,200}$/),
}).strict();

/**
 * Shipping owns package/label/source identity; WMS owns picks and close history.
 * Only trusted owner reads may construct this DTO. Never accept it in an HTTP body.
 * A consistent read is enough for preview; close requires the owner's write fence.
 */
export const packageCloseEvidenceSchema = z.object({
  contractVersion: z.literal(1),
  packageId: workEvidenceIdSchema,
  packageVersion: positiveInt,
  warehouseId: positiveInt,
  provider: nonblank(40),
  providerAccountId: nonblank(200),
  providerPackageId: nonblank(200),
  authorityMode: z.enum(["live", "shadow_only", "unavailable"]),
  contentsComplete: z.boolean(),
  cancelled: z.boolean(),
  carrierPossessionConfirmed: z.boolean(),
  currentCloseReceiptId: workEvidenceIdSchema.nullable(),
  // Multiple active candidates must remain visible, never choose the first one.
  labels: z.array(packageCloseLabelSchema).max(100),
  lines: z.array(packageCloseSourceLineSchema).max(500),
}).strict();

export const packageCloseActorSchema = z.object({
  actorId: nonblank(100),
  assignedActorId: nonblank(100).nullable(),
  warehouseId: positiveInt,
  canPack: z.boolean(),
  stationEnabled: z.boolean(),
  stationSupportsPacking: z.boolean(),
}).strict();

/** Explicit operator acknowledgment only; no client-supplied quantities or authority. */
export const packageCloseCommandSchema = z.object({
  commandId: z.string().uuid(),
  packageId: workEvidenceIdSchema,
  expectedEvidenceHash: packageCloseEvidenceHashSchema,
  labelId: workEvidenceIdSchema,
  expectedLabelRevision: positiveInt,
  scannedTrackingNumber: nonblank(200),
  confirmExactContents: z.literal(true),
  confirmLabelApplied: z.literal(true),
  reason: nonblank(1000),
}).strict();

export const packageCloseBlockerSchema = z.enum([
  "PACKAGE_AUTHORITY_UNAVAILABLE", "PACKAGE_CONTENTS_UNPROVEN", "PACKAGE_CANCELLED",
  "PACKAGE_ALREADY_CLOSED", "CARRIER_ALREADY_HAS_PACKAGE", "PACKAGE_SCOPE_MISMATCH",
  "PACKING_NOT_AUTHORIZED", "PACKING_WORKER_MISMATCH", "PACKING_STATION_UNAVAILABLE",
  "PACKAGE_SOURCE_DUPLICATE", "PACKAGE_ORDER_LINE_AMBIGUOUS", "PACKAGE_LINE_INELIGIBLE",
  "PACKAGE_QUANTITY_EXCEEDS_AUTHORITY", "PACKAGE_QUANTITY_NOT_PICKED",
  "PACKAGE_LABEL_MISSING", "PACKAGE_LABEL_AMBIGUOUS", "PACKAGE_LABEL_IDENTITY_MISMATCH",
  "PACKAGE_LABEL_NOT_OUTBOUND", "PACKAGE_EVIDENCE_CHANGED", "PACKAGE_COMMAND_IDENTITY_MISMATCH",
  "PACKAGE_LABEL_CHANGED", "PACKAGE_TRACKING_MISMATCH",
]);

export type PackageCloseEvidence = z.infer<typeof packageCloseEvidenceSchema>;
export type PackageCloseActor = z.infer<typeof packageCloseActorSchema>;
export type PackageCloseCommand = z.infer<typeof packageCloseCommandSchema>;
export type PackageCloseBlocker = z.infer<typeof packageCloseBlockerSchema>;

export const packageCloseDecisionSchema = z.object({
  contractVersion: z.literal(1),
  packageId: workEvidenceIdSchema,
  evidenceHash: packageCloseEvidenceHashSchema,
  eligible: z.boolean(),
  blockers: z.array(packageCloseBlockerSchema),
}).strict().refine((value) => value.eligible === (value.blockers.length === 0), "Eligibility must match blockers");
export type PackageCloseDecision = z.infer<typeof packageCloseDecisionSchema>;
