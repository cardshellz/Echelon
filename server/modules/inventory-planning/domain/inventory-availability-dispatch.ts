import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJson } from "@shared/utils/canonical-json";
import {
  canonicalClaimDispatchCommandSchema, canonicalClaimDispatchEvidenceSchema,
  canonicalClaimDispatchPlanSchema, canonicalClaimDispatchReceiptSchema,
  type CanonicalClaimDispatchCommand, type CanonicalClaimDispatchEvidence,
  type CanonicalClaimDispatchPlan, type CanonicalClaimDispatchReceipt,
} from "@shared/types/inventory-availability-dispatch";

const ZERO = BigInt(0);
const COUNTERS = ["claimedQty", "releasedQty", "consumedQty", "pickedQty"] as const;
type Resource = CanonicalClaimDispatchEvidence["resources"][number];
type Lot = Resource["lots"][number];
type PickMovement = CanonicalClaimDispatchEvidence["pickMovements"][number];

export class CanonicalClaimDispatchError extends Error {
  readonly classification = "permanent";
  constructor(readonly code: string, message: string, readonly context: Readonly<Record<string, unknown>> = {}) {
    super(message); this.name = "CanonicalClaimDispatchError";
  }
}
function requireCondition(condition: boolean, code: string, message: string, context: Readonly<Record<string, unknown>> = {}): asserts condition {
  if (!condition) throw new CanonicalClaimDispatchError(code, message, context);
}
function parsed<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new CanonicalClaimDispatchError("CLAIM_DISPATCH_INVALID_INPUT", "Dispatch evidence or command violates its strict contract", { issues: result.error.issues });
  return result.data;
}
function digest(value: unknown): string { return createHash("sha256").update(canonicalJson(value)).digest("hex"); }
function compareId(left: string, right: string): number { return BigInt(left) < BigInt(right) ? -1 : BigInt(left) > BigInt(right) ? 1 : 0; }
function sum(values: readonly string[]): bigint { return values.reduce((total, value) => total + BigInt(value), ZERO); }
function validBalance(value: Pick<Resource, "claimedQty" | "releasedQty" | "consumedQty" | "pickedQty">): boolean {
  return BigInt(value.releasedQty) + BigInt(value.consumedQty) + BigInt(value.pickedQty) <= BigInt(value.claimedQty);
}

export function canonicalClaimDispatchCommandHash(input: unknown): string {
  return digest({ contractVersion: "canonical_claim_dispatch_command_v1", command: parsed(canonicalClaimDispatchCommandSchema, input) });
}
export function canonicalClaimDispatchPlanHash(input: unknown): string {
  return digest(parsed(canonicalClaimDispatchPlanSchema, input));
}

/**
 * Exact committed replay is checked before loading current held/cancelled source
 * state. This helper verifies immutable identity; authorization is still the
 * caller's job. An absent receipt is not evidence that another key did not spend
 * this source: repository uniqueness and current source totals remain mandatory.
 */
export function validateCanonicalClaimDispatchReplay(command: unknown, receipt: unknown): CanonicalClaimDispatchReceipt | null {
  const commandHash = canonicalClaimDispatchCommandHash(command);
  if (receipt === null) return null;
  const result = parsed(canonicalClaimDispatchReceiptSchema, receipt);
  requireCondition(result.commandHash === commandHash && result.plan.commandHash === commandHash
    && canonicalClaimDispatchCommandHash(result.plan.command) === commandHash,
  "CLAIM_DISPATCH_IDEMPOTENCY_CONFLICT", "Committed dispatch receipt belongs to a different command");
  requireCondition(canonicalClaimDispatchPlanHash(result.plan) === result.planHash,
    "CLAIM_DISPATCH_RECEIPT_INVALID", "Committed dispatch plan does not match its immutable hash");
  return result;
}

/** Pure all-or-nothing picked -> consumed plan. Never moves on-hand, reserves, or COGS. */
export function planCanonicalClaimDispatch(rawCommand: unknown, rawEvidence: unknown): CanonicalClaimDispatchPlan {
  const command = parsed(canonicalClaimDispatchCommandSchema, rawCommand);
  const evidence = parsed(canonicalClaimDispatchEvidenceSchema, rawEvidence);
  validateScope(command, evidence);
  const picksByLot = validateLineage(evidence);
  const requested = BigInt(command.quantity);
  // Existing ship journals are unique by shipment/item and shipment/order item
  // (143 and 0570). Partial order dispatch needs a separate explicit source row;
  // this command cannot post an incremental amount against an existing source.
  requireCondition(evidence.source.dispatchedQuantity === "0", "CLAIM_DISPATCH_SOURCE_ALREADY_DISPATCHED", "A new command cannot reuse a dispatched source; retry its exact committed command instead");
  requireCondition(command.quantity === evidence.source.quantity, "CLAIM_DISPATCH_SOURCE_QUANTITY_MISMATCH", "Dispatch must consume the complete exact outbound source quantity");
  requireCondition(BigInt(evidence.line.pickedTargetQty) >= requested, "CLAIM_DISPATCH_PICKED_SHORTFALL", "Claim line does not own enough picked stock");
  const resources: CanonicalClaimDispatchPlan["resources"] = [];
  let remaining = requested;
  const orderedResources = [...evidence.resources].sort((a, b) => a.warehouseId - b.warehouseId
    || a.warehouseLocationId - b.warehouseLocationId || a.inventoryLevelId - b.inventoryLevelId || compareId(a.id, b.id));
  for (const resource of orderedResources) {
    if (remaining === ZERO) break;
    if (resource.warehouseId !== command.warehouseId || resource.warehouseLocationId !== command.warehouseLocationId) continue;
    const lots: CanonicalClaimDispatchPlan["resources"][number]["lots"] = [];
    let resourceTaken = ZERO;
    for (const lot of [...resource.lots].sort((a, b) => a.inventoryLotId - b.inventoryLotId || compareId(a.id, b.id))) {
      if (remaining === ZERO) break;
      const picks: CanonicalClaimDispatchPlan["resources"][number]["lots"][number]["picks"] = [];
      let lotTaken = ZERO;
      for (const pick of [...(picksByLot.get(lot.id) ?? [])].sort((a, b) => compareId(a.id, b.id))) {
        if (remaining === ZERO) break;
        const available = BigInt(pick.quantity) - BigInt(pick.reversedQuantity) - BigInt(pick.dispatchedQuantity);
        const take = available < remaining ? available : remaining;
        if (take === ZERO) continue;
        picks.push({ pickMovementId: pick.id, orderItemCostId: pick.cost.id, quantity: take.toString(), unitCostMills: pick.cost.unitCostMills });
        lotTaken += take; remaining -= take;
      }
      if (lotTaken > ZERO) lots.push({ claimLotAllocationId: lot.id, inventoryLotId: lot.inventoryLotId,
        quantity: lotTaken.toString(), ...after(lot, lotTaken), picks });
      resourceTaken += lotTaken;
    }
    if (resourceTaken > ZERO) resources.push({ claimResourceId: resource.id, warehouseId: resource.warehouseId,
      warehouseLocationId: resource.warehouseLocationId, inventoryLevelId: resource.inventoryLevelId, sourceVariantId: resource.sourceVariantId,
      quantity: resourceTaken.toString(), ...after(resource, resourceTaken), lots });
  }
  requireCondition(remaining === ZERO, "CLAIM_DISPATCH_PICKED_SHORTFALL", "Exact source warehouse/location does not own the requested picked quantity; other stock is not a fallback", { remainingQuantity: remaining.toString() });
  return parsed(canonicalClaimDispatchPlanSchema, { contractVersion: "canonical_claim_dispatch_plan_v1",
    commandHash: canonicalClaimDispatchCommandHash(command), command, claimLineId: evidence.line.id, quantity: command.quantity,
    pickedTargetQtyBefore: evidence.line.pickedTargetQty, pickedTargetQtyAfter: (BigInt(evidence.line.pickedTargetQty) - requested).toString(),
    consumedTargetQtyBefore: evidence.line.consumedTargetQty, consumedTargetQtyAfter: (BigInt(evidence.line.consumedTargetQty) + requested).toString(),
    sourceRemainingQuantity: "0", sourceDispositionAfter: "fully_dispatched",
    resources, physicalOnHandDelta: "0", reservedQuantityDelta: "0", createsPick: false, createsCogs: false });
}

function after(value: { pickedQty: string; consumedQty: string }, take: bigint) {
  return { pickedQtyBefore: value.pickedQty, pickedQtyAfter: (BigInt(value.pickedQty) - take).toString(),
    consumedQtyBefore: value.consumedQty, consumedQtyAfter: (BigInt(value.consumedQty) + take).toString() };
}
function validateScope(command: CanonicalClaimDispatchCommand, evidence: CanonicalClaimDispatchEvidence): void {
  for (const key of ["orderId", "orderItemId", "warehouseId", "warehouseLocationId", "productVariantId", "outboundShipmentId", "sourceShipmentItemId", "physicalShipmentId", "physicalShipmentItemId"] as const) {
    requireCondition(command[key] === evidence.source[key], "CLAIM_DISPATCH_SOURCE_IDENTITY_MISMATCH", "Command does not match exact WMS-owned dispatch identity", { field: key });
  }
  requireCondition(command.claimId === evidence.claim.id && evidence.claim.orderId === command.orderId
    && evidence.line.claimId === command.claimId && evidence.line.orderItemId === command.orderItemId
    && evidence.line.targetVariantId === command.productVariantId,
  "CLAIM_DISPATCH_CLAIM_IDENTITY_MISMATCH", "Claim and target line do not belong to this exact order item and variant");
  requireCondition(evidence.source.readiness !== "held", "CLAIM_DISPATCH_HELD", "The WMS source is held");
  requireCondition(evidence.source.readiness === "authorized", "CLAIM_DISPATCH_UNVERIFIED", "The WMS owner has not authorized this exact source");
  requireCondition(evidence.source.orderStatus !== "cancelled" && !["cancelled", "failed"].includes(evidence.claim.status),
    "CLAIM_DISPATCH_TERMINAL_OWNER", "Cancelled orders or cancelled/failed claims cannot create dispatch consumption");
  requireCondition(evidence.source.physicalShipmentItemQuantity === null || evidence.source.physicalShipmentItemQuantity === command.quantity,
    "CLAIM_DISPATCH_PHYSICAL_QUANTITY_MISMATCH", "Command must consume the complete exact physical item quantity when its identity is known");
}

function validateLineage(evidence: CanonicalClaimDispatchEvidence): Map<string, PickMovement[]> {
  const { line, claim } = evidence;
  requireCondition(BigInt(line.releasedTargetQty) + BigInt(line.consumedTargetQty) + BigInt(line.pickedTargetQty) <= BigInt(line.plannedQty),
    "CLAIM_DISPATCH_LINE_BALANCE_INVALID", "Claim target counters exceed planned units");
  const resources = new Map<string, Resource>(); const lots = new Map<string, { lot: Lot; resource: Resource }>();
  const resourceKeys = new Set<string>();
  for (const resource of evidence.resources) {
    // 0642 permits direct stock and multiple operation outputs in the same bin.
    const resourceKey = canonicalJson([resource.warehouseId, resource.warehouseLocationId,
      resource.inventoryLevelId, resource.sourceVariantId, resource.consumerOperationKey, resource.producerOperationKey]);
    requireCondition(!resources.has(resource.id) && !resourceKeys.has(resourceKey) && resource.claimId === claim.id && resource.claimLineId === line.id
      && resource.consumerOperationKey === null && resource.sourceVariantId === line.targetVariantId,
    "CLAIM_DISPATCH_RESOURCE_IDENTITY_INVALID", "Dispatch requires unique final-target resources from this exact claim line");
    requireCondition(validBalance(resource), "CLAIM_DISPATCH_RESOURCE_BALANCE_INVALID", "Claim resource counters exceed claimed units");
    resources.set(resource.id, resource);
    resourceKeys.add(resourceKey);
    const inventoryLotIds = new Set<number>();
    for (const lot of resource.lots) {
      requireCondition(!lots.has(lot.id) && !inventoryLotIds.has(lot.inventoryLotId) && lot.claimId === claim.id && lot.claimResourceId === resource.id,
        "CLAIM_DISPATCH_LOT_IDENTITY_INVALID", "Claim lot allocation identity is duplicated or belongs to another resource");
      requireCondition(validBalance(lot), "CLAIM_DISPATCH_LOT_BALANCE_INVALID", "Claim lot counters exceed claimed units");
      lots.set(lot.id, { lot, resource });
      inventoryLotIds.add(lot.inventoryLotId);
    }
    for (const counter of COUNTERS) requireCondition(sum(resource.lots.map((lot) => lot[counter])) === BigInt(resource[counter]),
      "CLAIM_DISPATCH_LOT_RESOURCE_MISMATCH", "Full lot counters do not reconcile to their claim resource", { claimResourceId: resource.id, counter });
  }
  requireCondition(sum(evidence.resources.map((resource) => resource.pickedQty)) === BigInt(line.pickedTargetQty)
    && sum(evidence.resources.map((resource) => resource.consumedQty)) === BigInt(line.consumedTargetQty),
  "CLAIM_DISPATCH_LINE_RESOURCE_MISMATCH", "Complete final-resource picked/consumed balances do not reconcile to the claim line");
  const picksByLot = new Map<string, PickMovement[]>(); const pickIds = new Set<string>(); const costIds = new Set<number>();
  for (const pick of evidence.pickMovements) {
    const allocation = lots.get(pick.claimLotAllocationId);
    requireCondition(!pickIds.has(pick.id) && !costIds.has(pick.cost.id) && allocation !== undefined
      && pick.claimId === claim.id && pick.claimLineId === line.id
      && pick.claimResourceId === allocation.resource.id && pick.inventoryLotId === allocation.lot.inventoryLotId,
    "CLAIM_DISPATCH_PICK_IDENTITY_INVALID", "Pick/COGS identity is duplicated or does not belong to its exact claim allocation");
    pickIds.add(pick.id); costIds.add(pick.cost.id);
    requireCondition(BigInt(pick.reversedQuantity) + BigInt(pick.dispatchedQuantity) <= BigInt(pick.quantity),
      "CLAIM_DISPATCH_PICK_OVERSPENT", "Unpick and dispatch consumption exceed the original picked movement");
    requireCondition(pick.cost.orderId === claim.orderId && pick.cost.orderItemId === line.orderItemId
      && pick.cost.productVariantId === line.targetVariantId && pick.cost.inventoryLotId === pick.inventoryLotId
      && pick.cost.quantity === pick.quantity
      && BigInt(pick.cost.totalCostMills) === BigInt(pick.cost.unitCostMills) * BigInt(pick.quantity),
    "CLAIM_DISPATCH_COGS_IDENTITY_INVALID", "Original pick cost evidence does not match its immutable owner, quantity and cost");
    picksByLot.set(pick.claimLotAllocationId, [...(picksByLot.get(pick.claimLotAllocationId) ?? []), pick]);
  }
  for (const [id, { lot }] of lots) {
    const picks = picksByLot.get(id) ?? [];
    const remaining = picks.reduce((total, pick) => total + BigInt(pick.quantity) - BigInt(pick.reversedQuantity) - BigInt(pick.dispatchedQuantity), ZERO);
    requireCondition(remaining === BigInt(lot.pickedQty) && sum(picks.map((pick) => pick.dispatchedQuantity)) === BigInt(lot.consumedQty),
      "CLAIM_DISPATCH_PICK_LOT_MISMATCH", "Original picks, reversals and dispatch allocations do not reconcile to current lot custody", { claimLotAllocationId: id });
  }
  return picksByLot;
}
