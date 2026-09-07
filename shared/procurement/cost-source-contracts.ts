import { z } from "zod";

/** Mills are 1/100 of a cent in the existing inventory owners. */
export const COST_COMPONENTS = ["product", "packaging", "landed"] as const;
export const COST_SOURCE_EVIDENCE_STATES = ["estimated", "confirmed", "unknown", "review_required"] as const;
export const COST_APPLICATION_STATES = ["pending", "applied", "retry_required", "review_required"] as const;
export const COST_READINESS_STATES = [
  "estimated", "awaiting_source", "ready_to_apply", "applied", "retry_required", "review_required",
] as const;

const POSTGRES_INTEGER_MAX = 2_147_483_647;
const MAX_SOURCE_REFERENCES = 1_000;
const resourceId = z.number().int().positive().max(POSTGRES_INTEGER_MAX);
const positiveInteger = z.number().int().positive().safe();
const nonnegativeInteger = z.number().int().nonnegative().safe();

// Never coerce JSON strings, booleans or null into an economic amount. Negative
// source credits remain negative; compatibility with a posting owner is separate.
export const costMillsSchema = z.number().int().safe();
export const costComponentSchema = z.enum(COST_COMPONENTS);
export const costFingerprintSchema = z.string().regex(/^[0-9a-f]{64}$/);
export const costCurrencySchema = z.string().regex(/^[A-Z]{3}$/);
export const costIssueSchema = z.object({
  code: z.string().regex(/^[A-Z][A-Z0-9_]{0,99}$/),
  message: z.string().trim().min(1).max(2_000),
}).strict();

export const costSourceScopeSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("purchase_order_line"),
    purchaseOrderId: resourceId,
    purchaseOrderLineId: resourceId,
  }).strict(),
  z.object({
    kind: z.literal("shipment_line"),
    purchaseOrderId: resourceId,
    purchaseOrderLineId: resourceId,
    inboundShipmentId: resourceId,
    inboundShipmentLineId: resourceId,
  }).strict(),
]);

export const costSourceReferenceSchema = z.object({
  kind: z.enum(["purchase_order_line", "vendor_invoice_line", "shipment_cost", "manual_override"]),
  documentId: resourceId,
  lineId: resourceId,
  // The source owner fingerprints the captured immutable economic inputs. A
  // mutable row ID, timestamp, or equal numeric price is not a source version.
  version: costFingerprintSchema,
}).strict();

export const costManualOverrideSchema = z.object({
  actorId: z.string().trim().min(1).max(200),
  reason: z.string().trim().min(1).max(2_000),
  recordedAt: z.string().datetime({ offset: true }),
}).strict();

export const costSourceRevisionSchema = z.object({
  contractVersion: z.literal(1),
  revision: positiveInteger,
  fingerprint: costFingerprintSchema,
  component: costComponentSchema,
  scope: costSourceScopeSchema,
  sources: z.array(costSourceReferenceSchema).min(1).max(MAX_SOURCE_REFERENCES),
  // Unknown historical currency is readable, but cannot be applied as USD.
  currency: costCurrencySchema.nullable(),
  totalMills: costMillsSchema.nullable(),
  // The exact extended amount belongs to this many base pieces, not cartons or
  // today's catalog variant factor. Unknown history must retain null.
  basePieces: positiveInteger.nullable(),
  evidence: z.enum(COST_SOURCE_EVIDENCE_STATES),
  packagingTreatment: z.enum(["separate", "included_in_product", "not_applicable", "unknown"]),
  issue: costIssueSchema.nullable(),
  manualOverride: costManualOverrideSchema.nullable(),
}).strict().superRefine((source, context) => {
  const knownAmount = source.evidence === "estimated" || source.evidence === "confirmed";
  if (knownAmount && (source.totalMills === null || source.basePieces === null)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: source.totalMills === null ? ["totalMills"] : ["basePieces"],
      message: "Estimated or confirmed evidence requires an explicit amount and base-piece denominator",
    });
  }
  if ((source.evidence === "unknown" || source.evidence === "review_required") && source.issue === null) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["issue"],
      message: "Unresolved source evidence requires an actionable reason",
    });
  }
  const hasManualSource = source.sources.some((reference) => reference.kind === "manual_override");
  if (hasManualSource !== (source.manualOverride !== null)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["manualOverride"],
      message: "A manual override requires both a versioned source and explicit actor, reason, and time",
    });
  }
  const sourceKeys = new Set<string>();
  for (const [index, reference] of source.sources.entries()) {
    const key = `${reference.kind}:${reference.documentId}:${reference.lineId}`;
    if (sourceKeys.has(key)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["sources", index],
        message: "A source line can appear only once in a revision",
      });
    }
    sourceKeys.add(key);
  }
});

export const costApplicationEvidenceSchema = z.object({
  inventoryLotId: resourceId,
  component: costComponentSchema,
  sourceRevision: positiveInteger,
  sourceFingerprint: costFingerprintSchema,
  applicationVersion: nonnegativeInteger,
  state: z.enum(COST_APPLICATION_STATES),
  issue: costIssueSchema.nullable(),
}).strict().superRefine((application, context) => {
  if (application.state === "applied" && application.applicationVersion === 0) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["applicationVersion"], message: "Applied evidence requires a persisted positive application version" });
  }
  if ((application.state === "retry_required" || application.state === "review_required") && application.issue === null) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["issue"], message: "An unsuccessful application requires an actionable reason" });
  }
});

export const costReadinessSchema = z.object({
  state: z.enum(COST_READINESS_STATES),
  sourceEvidence: z.enum(COST_SOURCE_EVIDENCE_STATES),
  applicationState: z.enum(["not_requested", ...COST_APPLICATION_STATES]),
  currentRevisionApplied: z.boolean(),
  issues: z.array(costIssueSchema),
}).strict();

export const costComponentAmountsSchema = z.object({
  productMills: costMillsSchema,
  packagingMills: costMillsSchema,
  landedMills: costMillsSchema,
}).strict();

export type CostComponent = z.infer<typeof costComponentSchema>;
export type CostSourceScope = z.infer<typeof costSourceScopeSchema>;
export type CostSourceReference = z.infer<typeof costSourceReferenceSchema>;
export type CostSourceRevision = z.infer<typeof costSourceRevisionSchema>;
export type CostApplicationEvidence = z.infer<typeof costApplicationEvidenceSchema>;
export type CostIssue = z.infer<typeof costIssueSchema>;
export type CostReadiness = z.infer<typeof costReadinessSchema>;
export type CostComponentAmounts = z.infer<typeof costComponentAmountsSchema>;
