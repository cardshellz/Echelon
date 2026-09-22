import { z } from "zod";

export const DEFAULT_CUSTOMER_RETURN_WINDOW_DAYS = 365;
const MAX_RETURN_WINDOW_DAYS = 3_650;
const MAX_FACTS_PER_COLLECTION = 200;
const MILLISECONDS_PER_DAY = 86_400_000;

const identitySchema = z.string().min(1).max(255).refine(
  (value) => value === value.trim(), "Identity must not contain surrounding whitespace.",
);
const quantitySchema = z.number().int().nonnegative().safe();
const positiveQuantitySchema = quantitySchema.refine((value) => value > 0, "Quantity must be positive.");
const timestampSchema = z.string().max(35).datetime({ offset: true }).refine(
  (value) => Number.isFinite(Date.parse(value)), "Timestamp must be a valid instant.",
);
const evidenceTextSchema = z.string().trim().min(1).max(2_000);

export const customerReturnDeliveryEvidenceSchema = z.object({
  evidenceId: identitySchema,
  source: z.enum(["shopify", "carrier"]),
  status: z.enum(["delivered", "in_transit", "unknown"]),
  occurredAt: timestampSchema,
  observedAt: timestampSchema,
}).strict();

export const customerReturnStaffDeliveryOverrideSchema = z.object({
  overrideId: identitySchema,
  quantity: positiveQuantitySchema,
  actor: identitySchema,
  approvedAt: timestampSchema,
  reason: evidenceTextSchema,
  verificationReference: evidenceTextSchema,
}).strict();

export const customerReturnFulfillmentAllocationSchema = z.object({
  allocationId: identitySchema,
  fulfillmentId: identitySchema,
  fulfillmentLineItemId: identitySchema,
  quantity: positiveQuantitySchema,
  status: z.enum(["active", "cancelled", "superseded"]),
  deliveryEvidence: z.array(customerReturnDeliveryEvidenceSchema).max(MAX_FACTS_PER_COLLECTION),
  // This is the one current audited decision, not additive snapshots of its revisions.
  staffDeliveryOverride: customerReturnStaffDeliveryOverrideSchema.nullable(),
}).strict();

export const customerReturnQuantityClaimSchema = z.object({
  claimId: identitySchema,
  allocationId: identitySchema.nullable(),
  // Reader supplies still-encumbered quantities, including already received units.
  // Time alone is never evidence that a claim has been released.
  quantity: positiveQuantitySchema,
}).strict();

export const customerReturnEligibilityLineSchema = z.object({
  lineId: identitySchema,
  sku: z.string().max(255).nullable(),
  requiresShipping: z.boolean(),
  purchasedQuantity: quantitySchema,
  allocations: z.array(customerReturnFulfillmentAllocationSchema).max(MAX_FACTS_PER_COLLECTION),
  claims: z.array(customerReturnQuantityClaimSchema).max(MAX_FACTS_PER_COLLECTION),
}).strict();

const inputShapeSchema = z.object({
  now: timestampSchema,
  policy: z.object({
    channelId: z.number().int().positive().safe(),
    version: z.number().int().positive().safe(),
    returnWindowDays: z.number().int().min(1).max(MAX_RETURN_WINDOW_DAYS),
  }).strict(),
  order: z.object({
    orderId: identitySchema,
    channelId: z.number().int().positive().safe(),
    provider: identitySchema,
    destinationCountryCode: z.string().regex(/^[A-Z]{2}$/).nullable(),
    purchasedAt: timestampSchema,
    lines: z.array(customerReturnEligibilityLineSchema).max(MAX_FACTS_PER_COLLECTION),
  }).strict(),
}).strict();

type EligibilityFacts = z.infer<typeof inputShapeSchema>;
type LineFacts = z.infer<typeof customerReturnEligibilityLineSchema>;
type AllocationFacts = z.infer<typeof customerReturnFulfillmentAllocationSchema>;

/** Validates structural and cross-record facts; no invalid evidence can grant units. */
export const customerReturnEligibilityInputSchema = inputShapeSchema.superRefine(validateSourceFacts);
export type CustomerReturnEligibilityInput = z.infer<typeof customerReturnEligibilityInputSchema>;

export const customerReturnEligibilityReasonSchema = z.enum([
  "provider_not_supported", "channel_not_supported", "destination_not_supported", "destination_unknown",
  "purchase_in_future", "return_window_elapsed", "non_physical_item", "no_purchased_quantity",
  "no_active_fulfillment", "delivery_unknown", "not_delivered", "delivery_evidence_conflict",
  "claim_allocation_unknown", "claim_on_inactive_allocation", "all_quantity_claimed",
]);
export type CustomerReturnEligibilityReason = z.infer<typeof customerReturnEligibilityReasonSchema>;

const allocationResultSchema = z.object({
  allocationId: identitySchema,
  fulfillmentId: identitySchema,
  fulfillmentLineItemId: identitySchema,
  sourceStatus: z.enum(["active", "cancelled", "superseded"]),
  deliveryStatus: z.enum(["delivered", "partially_verified", "in_transit", "unknown", "conflict", "inactive"]),
  deliveryBasis: z.enum(["provider", "staff", "none"]),
  quantity: quantitySchema,
  deliveredQuantity: quantitySchema,
  claimedQuantity: quantitySchema,
  eligibleQuantity: quantitySchema,
  evidenceIds: z.array(z.string().min(1).max(263)).max(MAX_FACTS_PER_COLLECTION),
  staffOverrideId: identitySchema.nullable(),
  reasons: z.array(customerReturnEligibilityReasonSchema).max(20),
}).strict();

const lineResultSchema = z.object({
  lineId: identitySchema,
  sku: z.string().max(255).nullable(),
  purchasedQuantity: quantitySchema,
  deliveredQuantity: quantitySchema,
  claimedQuantity: quantitySchema,
  remainingPurchasedQuantity: quantitySchema,
  eligibleQuantity: quantitySchema,
  reasons: z.array(customerReturnEligibilityReasonSchema).max(20),
  allocations: z.array(allocationResultSchema).max(MAX_FACTS_PER_COLLECTION),
}).strict();

export const customerReturnEligibilityOutputSchema = z.object({
  orderId: identitySchema,
  policyVersion: z.number().int().positive().safe(),
  evaluatedAt: timestampSchema,
  returnWindowEndsAt: timestampSchema,
  eligibleQuantity: quantitySchema,
  hasEligibleItems: z.boolean(),
  reasons: z.array(customerReturnEligibilityReasonSchema).max(20),
  lines: z.array(lineResultSchema).max(MAX_FACTS_PER_COLLECTION),
}).strict();
export type CustomerReturnEligibilityOutput = z.infer<typeof customerReturnEligibilityOutputSchema>;
type AllocationResult = z.infer<typeof allocationResultSchema>;

export class CustomerReturnEligibilityError extends Error {
  readonly code = "CUSTOMER_RETURN_ELIGIBILITY_FACTS_INVALID";
  readonly context: { issues: Array<{ path: string; message: string }> };

  constructor(error: z.ZodError) {
    super("Customer return eligibility requires valid, consistent source facts.");
    this.name = "CustomerReturnEligibilityError";
    // Never include the original order/evidence payload in errors or logs.
    this.context = { issues: error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })) };
  }
}

/**
 * Pure eligibility, not authorization or reservation. An authenticated application
 * reader must supply complete, trusted order/allocation/claim facts. A structurally
 * valid staff record does not authenticate its actor. Submission must reread and
 * reserve quantities under the shared order lock. Customer reasons are separate.
 */
export function evaluateCustomerReturnEligibility(rawInput: unknown): CustomerReturnEligibilityOutput {
  const parsed = customerReturnEligibilityInputSchema.safeParse(rawInput);
  if (!parsed.success) throw new CustomerReturnEligibilityError(parsed.error);
  const input = parsed.data;
  const deadline = Date.parse(input.order.purchasedAt) + input.policy.returnWindowDays * MILLISECONDS_PER_DAY;
  const reasons = orderReasons(input, deadline);
  const lines = input.order.lines.map((line) => evaluateLine(line, reasons));
  const eligibleQuantity = lines.reduce((total, line) => total + line.eligibleQuantity, 0);
  return customerReturnEligibilityOutputSchema.parse({
    orderId: input.order.orderId,
    policyVersion: input.policy.version,
    evaluatedAt: input.now,
    returnWindowEndsAt: new Date(deadline).toISOString(),
    eligibleQuantity,
    hasEligibleItems: eligibleQuantity > 0,
    reasons,
    lines,
  });
}

function orderReasons(input: EligibilityFacts, deadline: number): CustomerReturnEligibilityReason[] {
  const reasons: CustomerReturnEligibilityReason[] = [];
  if (input.order.provider !== "shopify") reasons.push("provider_not_supported");
  if (input.order.channelId !== input.policy.channelId) reasons.push("channel_not_supported");
  if (input.order.destinationCountryCode === null) reasons.push("destination_unknown");
  else if (input.order.destinationCountryCode !== "US") reasons.push("destination_not_supported");
  if (Date.parse(input.order.purchasedAt) > Date.parse(input.now)) reasons.push("purchase_in_future");
  // 365 elapsed days is a duration, not a calendar-year or DST-dependent rule.
  // The exact endpoint is inclusive; one millisecond beyond it is outside.
  if (Date.parse(input.now) > deadline) reasons.push("return_window_elapsed");
  return reasons;
}

function evaluateLine(line: LineFacts, orderBlockers: CustomerReturnEligibilityReason[]): z.infer<typeof lineResultSchema> {
  const reasons = [...orderBlockers];
  if (!line.requiresShipping) reasons.push("non_physical_item");
  if (line.purchasedQuantity === 0) reasons.push("no_purchased_quantity");
  if (!line.allocations.some((allocation) => allocation.status === "active")) reasons.push("no_active_fulfillment");
  if (line.claims.some((claim) => claim.allocationId === null)) reasons.push("claim_allocation_unknown");
  const activeIds = new Set(line.allocations.filter((allocation) => allocation.status === "active").map((allocation) => allocation.allocationId));
  if (line.claims.some((claim) => claim.allocationId !== null && !activeIds.has(claim.allocationId))) {
    reasons.push("claim_on_inactive_allocation");
  }
  const blockWholeLine = reasons.length > 0;
  const allocations = line.allocations.map((allocation) => evaluateAllocation(allocation, line.claims));
  if (blockWholeLine) {
    for (const allocation of allocations) allocation.eligibleQuantity = 0;
  }
  const claimedQuantity = sumQuantities(line.claims);
  const remainingPurchasedQuantity = line.purchasedQuantity - claimedQuantity;
  if (claimedQuantity > 0 && remainingPurchasedQuantity === 0) reasons.push("all_quantity_claimed");
  for (const allocation of allocations) reasons.push(...allocation.reasons);
  return {
    lineId: line.lineId,
    sku: line.sku,
    purchasedQuantity: line.purchasedQuantity,
    deliveredQuantity: allocations.reduce((total, allocation) => total + allocation.deliveredQuantity, 0),
    claimedQuantity,
    remainingPurchasedQuantity,
    eligibleQuantity: Math.min(remainingPurchasedQuantity, allocations.reduce((total, allocation) => total + allocation.eligibleQuantity, 0)),
    reasons: [...new Set(reasons)],
    allocations,
  };
}

function evaluateAllocation(allocation: AllocationFacts, claims: LineFacts["claims"]): AllocationResult {
  const claimedQuantity = sumQuantities(claims.filter((claim) => claim.allocationId === allocation.allocationId));
  const base: AllocationResult = {
    allocationId: allocation.allocationId,
    fulfillmentId: allocation.fulfillmentId,
    fulfillmentLineItemId: allocation.fulfillmentLineItemId,
    sourceStatus: allocation.status,
    deliveryStatus: "inactive",
    deliveryBasis: "none",
    quantity: allocation.quantity,
    deliveredQuantity: 0,
    claimedQuantity,
    eligibleQuantity: 0,
    evidenceIds: allocation.deliveryEvidence.map((evidence) => `${evidence.source}:${evidence.evidenceId}`),
    staffOverrideId: allocation.staffDeliveryOverride?.overrideId ?? null,
    reasons: [],
  };
  if (allocation.status !== "active") return base;
  const delivered = allocation.deliveryEvidence.filter((evidence) => evidence.status === "delivered");
  const inTransit = allocation.deliveryEvidence.filter((evidence) => evidence.status === "in_transit");
  // Observation lag is not a contradiction. Compare effective event time only;
  // a later unknown observation is not evidence that delivery was reversed.
  const firstDeliveredAt = delivered.length > 0 ? Math.min(...delivered.map((evidence) => Date.parse(evidence.occurredAt))) : null;
  if (firstDeliveredAt !== null && inTransit.some((evidence) => Date.parse(evidence.occurredAt) >= firstDeliveredAt)) {
    return { ...base, deliveryStatus: "conflict", reasons: ["delivery_evidence_conflict"] };
  }
  const deliveredQuantity = delivered.length > 0 ? allocation.quantity : (allocation.staffDeliveryOverride?.quantity ?? 0);
  const deliveryStatus = deliveredQuantity === allocation.quantity ? "delivered"
    : deliveredQuantity > 0 ? "partially_verified"
      : inTransit.length > 0 ? "in_transit" : "unknown";
  const reasons: CustomerReturnEligibilityReason[] = [];
  if (deliveredQuantity < allocation.quantity) reasons.push(inTransit.length > 0 ? "not_delivered" : "delivery_unknown");
  const eligibleQuantity = Math.max(deliveredQuantity - claimedQuantity, 0);
  if (deliveredQuantity > 0 && eligibleQuantity === 0) reasons.push("all_quantity_claimed");
  return { ...base, deliveryStatus, deliveredQuantity, eligibleQuantity, reasons,
    deliveryBasis: delivered.length > 0 ? "provider" : deliveredQuantity > 0 ? "staff" : "none" };
}

function sumQuantities(values: ReadonlyArray<{ quantity: number }>): number {
  return values.reduce((total, value) => total + value.quantity, 0);
}

function validateSourceFacts(input: EligibilityFacts, context: z.RefinementCtx): void {
  const now = Date.parse(input.now);
  const purchasedAt = Date.parse(input.order.purchasedAt);
  const deadline = purchasedAt + input.policy.returnWindowDays * MILLISECONDS_PER_DAY;
  const issue = (path: Array<string | number>, message: string): void => context.addIssue({ code: z.ZodIssueCode.custom, path, message });
  if (!Number.isFinite(deadline) || deadline > Date.parse("9999-12-31T23:59:59.999Z")) {
    issue(["order", "purchasedAt"], "Return window endpoint exceeds the supported timestamp range.");
  }
  const lineIds = new Set<string>();
  const allocationIds = new Set<string>();
  const fulfillmentLineIds = new Set<string>();
  const claimIds = new Set<string>();
  const overrideIds = new Set<string>();
  const evidenceFacts = new Map<string, string>();
  let purchasedTotal = 0;
  const unique = (ids: Set<string>, id: string, path: Array<string | number>): void => {
    if (ids.has(id)) issue(path, "Duplicate identity is not permitted.");
    ids.add(id);
  };
  for (const [lineIndex, line] of input.order.lines.entries()) {
    const path = ["order", "lines", lineIndex];
    unique(lineIds, line.lineId, [...path, "lineId"]);
    purchasedTotal += line.purchasedQuantity;
    const activeTotal = sumQuantities(line.allocations.filter((allocation) => allocation.status === "active"));
    if (!Number.isSafeInteger(activeTotal) || activeTotal > line.purchasedQuantity) {
      issue([...path, "allocations"], "Active fulfillment quantities exceed purchased units or the supported range.");
    }
    const claimedTotal = sumQuantities(line.claims);
    if (!Number.isSafeInteger(claimedTotal) || claimedTotal > line.purchasedQuantity) {
      issue([...path, "claims"], "Claim quantities exceed purchased units or the supported range.");
    }
    const allocationsById = new Map(line.allocations.map((allocation) => [allocation.allocationId, allocation]));
    for (const [claimIndex, claim] of line.claims.entries()) {
      unique(claimIds, claim.claimId, [...path, "claims", claimIndex, "claimId"]);
      if (claim.allocationId !== null && !allocationsById.has(claim.allocationId)) {
        issue([...path, "claims", claimIndex, "allocationId"], "Claim does not reference an allocation of this purchased line.");
      }
    }
    for (const [allocationIndex, allocation] of line.allocations.entries()) {
      const allocationPath = [...path, "allocations", allocationIndex];
      unique(allocationIds, allocation.allocationId, [...allocationPath, "allocationId"]);
      unique(fulfillmentLineIds, allocation.fulfillmentLineItemId, [...allocationPath, "fulfillmentLineItemId"]);
      const allocationClaims = sumQuantities(line.claims.filter((claim) => claim.allocationId === allocation.allocationId));
      if (!Number.isSafeInteger(allocationClaims) || allocationClaims > allocation.quantity) {
        issue([...path, "claims"], "Claim quantities exceed their fulfillment allocation.");
      }
      const evidenceIds = new Set<string>();
      for (const [evidenceIndex, evidence] of allocation.deliveryEvidence.entries()) {
        const evidencePath = [...allocationPath, "deliveryEvidence", evidenceIndex];
        const evidenceKey = `${evidence.source}:${evidence.evidenceId}`;
        unique(evidenceIds, evidenceKey, [...evidencePath, "evidenceId"]);
        // One package event can cover several purchased lines, but cannot have
        // different effective facts depending on the line where it was joined.
        const signature = JSON.stringify([evidence.status, evidence.occurredAt]);
        if (evidenceFacts.has(evidenceKey) && evidenceFacts.get(evidenceKey) !== signature) {
          issue(evidencePath, "One source evidence identity has contradictory effective facts.");
        }
        evidenceFacts.set(evidenceKey, signature);
        const occurredAt = Date.parse(evidence.occurredAt);
        const observedAt = Date.parse(evidence.observedAt);
        if (occurredAt < purchasedAt || occurredAt > observedAt || observedAt > now) {
          issue(evidencePath, "Delivery evidence must occur after purchase, before observation and no later than evaluation.");
        }
      }
      const override = allocation.staffDeliveryOverride;
      if (override) {
        unique(overrideIds, override.overrideId, [...allocationPath, "staffDeliveryOverride", "overrideId"]);
        if (override.quantity > allocation.quantity) issue([...allocationPath, "staffDeliveryOverride", "quantity"], "Staff verification exceeds fulfillment quantity.");
        if (Date.parse(override.approvedAt) < purchasedAt || Date.parse(override.approvedAt) > now) {
          issue([...allocationPath, "staffDeliveryOverride", "approvedAt"], "Staff verification must be after purchase and no later than evaluation.");
        }
      }
    }
  }
  if (!Number.isSafeInteger(purchasedTotal)) issue(["order", "lines"], "Purchased quantity total exceeds the supported range.");
}
