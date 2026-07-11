import { createHash } from "crypto";
import { z } from "zod";
import { DropshipError } from "../domain/errors";
import type {
  CarrierProtectionEventType,
  CarrierProtectionPolicyRecord,
} from "./dropship-carrier-protection-service";
import type { DropshipClock, DropshipLogger } from "./dropship-ports";

const positiveId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const actorSchema = z.object({
  actorType: z.enum(["admin", "system"]),
  actorId: z.string().trim().min(1).max(255).optional(),
}).strict().superRefine((actor, context) => {
  if (actor.actorType === "admin" && !actor.actorId) {
    context.addIssue({
      code: "custom",
      path: ["actorId"],
      message: "Admin carrier-claim commands require an authenticated actor ID.",
    });
  }
});

const createCarrierClaimSchema = z.object({
  wmsShipmentId: positiveId,
  eventType: z.enum(["loss", "misdelivery", "damage"]),
  occurredAt: z.coerce.date().optional(),
  rmaId: positiveId.optional(),
  externalClaimId: z.string().trim().min(1).max(255).optional(),
  notes: z.string().trim().min(1).max(2000).optional(),
  idempotencyKey: z.string().trim().min(8).max(200),
  actor: actorSchema,
}).strict();

const pricingSnapshotSchema = z.object({
  wholesale: z.object({
    lines: z.array(z.object({
      productVariantId: positiveId,
      quantity: positiveId,
      wholesaleUnitCostCents: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    }).passthrough()).min(1),
  }).passthrough(),
}).passthrough();

export type CarrierClaimStatus =
  | "waiting_period"
  | "awaiting_inspection"
  | "awaiting_carrier_claim"
  | "pending_approval";

export interface CarrierClaimRecord {
  claimId: number;
  intakeId: number;
  wmsShipmentId: number;
  eventType: CarrierProtectionEventType;
  status: string;
  policyId: number;
  assignmentId: number;
  shippingAllocationId: number;
  currency: string;
  carrier: string;
  trackingNumber: string;
  externalClaimId: string | null;
  wholesaleCostSnapshotCents: number;
  shippingChargeSnapshotCents: number;
  calculatedCreditCents: number;
  approvedCreditCents: number | null;
  occurredAt: Date;
  eligibleAt: Date;
  createdAt: Date;
}

export interface CarrierClaimMutationResult {
  record: CarrierClaimRecord;
  idempotentReplay: boolean;
}

export interface CarrierClaimCommandContext {
  idempotencyKey: string;
  requestHash: string;
  actor: { actorType: "admin" | "system"; actorId?: string };
  now: Date;
}

export interface NormalizedCreateCarrierClaim {
  wmsShipmentId: number;
  eventType: CarrierProtectionEventType;
  occurredAt: Date;
  rmaId: number | null;
  externalClaimId: string | null;
  notes: string | null;
}

export interface CarrierClaimRepository {
  createClaim(input: NormalizedCreateCarrierClaim & CarrierClaimCommandContext): Promise<CarrierClaimMutationResult>;
  listClaims(limit: number): Promise<CarrierClaimRecord[]>;
}

export class DropshipCarrierClaimService {
  constructor(private readonly deps: {
    repository: CarrierClaimRepository;
    clock: DropshipClock;
    logger: DropshipLogger;
  }) {}

  async createClaim(input: unknown): Promise<CarrierClaimMutationResult> {
    const parsed = createCarrierClaimSchema.parse(input);
    const now = this.deps.clock.now();
    const occurredAt = parsed.occurredAt ?? now;
    if (occurredAt.getTime() > now.getTime()) {
      throw new DropshipError(
        "DROPSHIP_CARRIER_CLAIM_INVALID_OCCURRED_AT",
        "Carrier claim occurrence time cannot be in the future.",
      );
    }
    const normalized: NormalizedCreateCarrierClaim = {
      wmsShipmentId: parsed.wmsShipmentId,
      eventType: parsed.eventType,
      occurredAt,
      rmaId: parsed.rmaId ?? null,
      externalClaimId: parsed.externalClaimId?.trim() ?? null,
      notes: parsed.notes?.trim() ?? null,
    };
    const requestHash = createHash("sha256")
      .update(JSON.stringify({
        command: "carrier_claim_created",
        ...normalized,
        occurredAt: normalized.occurredAt.toISOString(),
      }))
      .digest("hex");
    const result = await this.deps.repository.createClaim({
      ...normalized,
      idempotencyKey: parsed.idempotencyKey,
      requestHash,
      actor: parsed.actor,
      now,
    });
    this.deps.logger.info({
      code: result.idempotentReplay
        ? "DROPSHIP_CARRIER_CLAIM_CREATED_REPLAYED"
        : "DROPSHIP_CARRIER_CLAIM_CREATED",
      message: "Carrier claim intake completed.",
      context: {
        claimId: result.record.claimId,
        wmsShipmentId: result.record.wmsShipmentId,
        eventType: result.record.eventType,
        idempotentReplay: result.idempotentReplay,
      },
    });
    return result;
  }

  listClaims(input: unknown = {}): Promise<CarrierClaimRecord[]> {
    const parsed = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }).parse(input);
    return this.deps.repository.listClaims(parsed.limit);
  }
}

export interface CarrierCostAllocationInput {
  wmsShipmentId: number;
  carrierCostCents: number | null;
  costCaptured: boolean;
}

export interface CarrierCostAllocation {
  wmsShipmentId: number;
  carrierCostCents: number | null;
  allocatedShippingChargeCents: number;
}

export interface CarrierCostAllocationPlan {
  method:
    | "single_shipment_full_charge_v1"
    | "carrier_cost_proportional_largest_remainder_v1"
    | "zero_shipping_charge_v1";
  totalCarrierCostCents: number | null;
  allocations: CarrierCostAllocation[];
}

export function allocateVendorShippingCharge(input: {
  orderShippingChargeCents: number;
  shipments: readonly CarrierCostAllocationInput[];
}): CarrierCostAllocationPlan {
  assertNonnegativeMoney(input.orderShippingChargeCents, "orderShippingChargeCents");
  if (input.shipments.length === 0) {
    throw new DropshipError(
      "DROPSHIP_CARRIER_CLAIM_NO_SHIPPED_SHIPMENTS",
      "Carrier claim allocation requires at least one shipped fulfillment.",
    );
  }

  const shipments = [...input.shipments].sort((left, right) => left.wmsShipmentId - right.wmsShipmentId);
  const uniqueIds = new Set<number>();
  for (const shipment of shipments) {
    if (!Number.isSafeInteger(shipment.wmsShipmentId) || shipment.wmsShipmentId <= 0 || uniqueIds.has(shipment.wmsShipmentId)) {
      throw new DropshipError(
        "DROPSHIP_CARRIER_CLAIM_INVALID_SHIPMENT_SET",
        "Carrier claim allocation requires unique positive shipment IDs.",
      );
    }
    uniqueIds.add(shipment.wmsShipmentId);
  }

  if (input.orderShippingChargeCents === 0) {
    return {
      method: "zero_shipping_charge_v1",
      totalCarrierCostCents: null,
      allocations: shipments.map((shipment) => ({
        wmsShipmentId: shipment.wmsShipmentId,
        carrierCostCents: shipment.costCaptured ? shipment.carrierCostCents : null,
        allocatedShippingChargeCents: 0,
      })),
    };
  }

  if (shipments.length === 1) {
    const [shipment] = shipments;
    return {
      method: "single_shipment_full_charge_v1",
      totalCarrierCostCents: shipment.costCaptured ? shipment.carrierCostCents : null,
      allocations: [{
        wmsShipmentId: shipment.wmsShipmentId,
        carrierCostCents: shipment.costCaptured ? shipment.carrierCostCents : null,
        allocatedShippingChargeCents: input.orderShippingChargeCents,
      }],
    };
  }

  const missingCostIds = shipments
    .filter((shipment) => !shipment.costCaptured || shipment.carrierCostCents == null || shipment.carrierCostCents <= 0)
    .map((shipment) => shipment.wmsShipmentId);
  if (missingCostIds.length > 0) {
    throw new DropshipError(
      "DROPSHIP_CARRIER_CLAIM_SHIPMENT_COST_REQUIRED",
      "Every split shipment requires a captured positive label cost before shipping can be allocated.",
      { wmsShipmentIds: missingCostIds },
    );
  }

  let totalCarrierCostBig = BigInt(0);
  for (const shipment of shipments) {
    assertPositiveMoney(shipment.carrierCostCents, "carrierCostCents");
    totalCarrierCostBig += BigInt(shipment.carrierCostCents!);
  }
  if (totalCarrierCostBig > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new DropshipError(
      "DROPSHIP_CARRIER_CLAIM_MONEY_OVERFLOW",
      "Combined carrier label cost exceeds the supported range.",
    );
  }
  const totalCarrierCost = Number(totalCarrierCostBig);
  assertPositiveMoney(totalCarrierCost, "totalCarrierCostCents");

  const shipping = BigInt(input.orderShippingChargeCents);
  const costTotal = BigInt(totalCarrierCost);
  const interim = shipments.map((shipment) => {
    const numerator = shipping * BigInt(shipment.carrierCostCents!);
    return {
      shipment,
      allocated: Number(numerator / costTotal),
      remainder: numerator % costTotal,
    };
  });
  let centsRemaining = input.orderShippingChargeCents
    - interim.reduce((sum, row) => sum + row.allocated, 0);
  interim.sort((left, right) => {
    if (left.remainder === right.remainder) {
      return left.shipment.wmsShipmentId - right.shipment.wmsShipmentId;
    }
    return left.remainder > right.remainder ? -1 : 1;
  });
  for (const row of interim) {
    if (centsRemaining === 0) break;
    row.allocated += 1;
    centsRemaining -= 1;
  }
  const allocations = interim
    .sort((left, right) => left.shipment.wmsShipmentId - right.shipment.wmsShipmentId)
    .map((row) => ({
      wmsShipmentId: row.shipment.wmsShipmentId,
      carrierCostCents: row.shipment.carrierCostCents,
      allocatedShippingChargeCents: row.allocated,
    }));
  if (allocations.reduce((sum, row) => sum + row.allocatedShippingChargeCents, 0) !== input.orderShippingChargeCents) {
    throw new DropshipError(
      "DROPSHIP_CARRIER_CLAIM_ALLOCATION_MISMATCH",
      "Shipment shipping allocations do not reconcile to the order shipping charge.",
    );
  }
  return {
    method: "carrier_cost_proportional_largest_remainder_v1",
    totalCarrierCostCents: totalCarrierCost,
    allocations,
  };
}

export interface AffectedWholesaleLine {
  productVariantId: number;
  quantity: number;
  wholesaleUnitCostCents: number;
  wholesaleLineTotalCents: number;
}

export function calculateAffectedWholesaleCost(input: {
  pricingSnapshot: unknown;
  shipmentItems: ReadonlyArray<{ productVariantId: number; quantity: number }>;
}): { totalCents: number; lines: AffectedWholesaleLine[] } {
  const parsed = pricingSnapshotSchema.safeParse(input.pricingSnapshot);
  if (!parsed.success) {
    throw new DropshipError(
      "DROPSHIP_CARRIER_CLAIM_PRICING_SNAPSHOT_INVALID",
      "Accepted order pricing snapshot is missing valid wholesale line costs.",
      { issues: parsed.error.issues },
    );
  }
  if (input.shipmentItems.length === 0) {
    throw new DropshipError(
      "DROPSHIP_CARRIER_CLAIM_SHIPMENT_ITEMS_REQUIRED",
      "Affected shipment has no positive-quantity items.",
    );
  }

  const pricingByVariant = new Map<number, { quantity: number; unitCostCents: number }>();
  for (const line of parsed.data.wholesale.lines) {
    const current = pricingByVariant.get(line.productVariantId);
    if (current && current.unitCostCents !== line.wholesaleUnitCostCents) {
      throw new DropshipError(
        "DROPSHIP_CARRIER_CLAIM_AMBIGUOUS_WHOLESALE_COST",
        "Accepted pricing snapshot contains different wholesale costs for the same variant.",
        { productVariantId: line.productVariantId },
      );
    }
    pricingByVariant.set(line.productVariantId, {
      quantity: addQuantity(current?.quantity ?? 0, line.quantity),
      unitCostCents: line.wholesaleUnitCostCents,
    });
  }

  const quantityByVariant = new Map<number, number>();
  for (const item of input.shipmentItems) {
    if (!Number.isSafeInteger(item.productVariantId) || item.productVariantId <= 0
      || !Number.isSafeInteger(item.quantity) || item.quantity <= 0) {
      throw new DropshipError(
        "DROPSHIP_CARRIER_CLAIM_SHIPMENT_ITEMS_INVALID",
        "Affected shipment items require positive variant IDs and quantities.",
      );
    }
    quantityByVariant.set(
      item.productVariantId,
      addQuantity(quantityByVariant.get(item.productVariantId) ?? 0, item.quantity),
    );
  }

  const lines: AffectedWholesaleLine[] = [];
  let total = 0;
  for (const [productVariantId, quantity] of [...quantityByVariant.entries()].sort(([left], [right]) => left - right)) {
    const pricing = pricingByVariant.get(productVariantId);
    if (!pricing || quantity > pricing.quantity) {
      throw new DropshipError(
        "DROPSHIP_CARRIER_CLAIM_SHIPMENT_PRICING_MISMATCH",
        "Affected shipment quantities do not match the accepted pricing snapshot.",
        { productVariantId, shipmentQuantity: quantity, acceptedQuantity: pricing?.quantity ?? 0 },
      );
    }
    const lineTotal = multiplyMoney(pricing.unitCostCents, quantity);
    total = addMoney(total, lineTotal);
    lines.push({ productVariantId, quantity, wholesaleUnitCostCents: pricing.unitCostCents, wholesaleLineTotalCents: lineTotal });
  }
  return { totalCents: total, lines };
}

export function determineInitialCarrierClaimState(input: {
  eventType: CarrierProtectionEventType;
  policy: Pick<CarrierProtectionPolicyRecord,
    "lossWaitDays" | "misdeliveryWaitDays" | "damageInspectionRequired" | "carrierClaimRequired">;
  shippedAt: Date;
  now: Date;
  hasInspection: boolean;
  hasExternalCarrierClaim: boolean;
}): { status: CarrierClaimStatus; eligibleAt: Date } {
  const waitDays = input.eventType === "loss"
    ? input.policy.lossWaitDays
    : input.eventType === "misdelivery"
      ? input.policy.misdeliveryWaitDays
      : 0;
  const eligibleAt = new Date(input.shippedAt.getTime() + waitDays * 86_400_000);
  if (input.now.getTime() < eligibleAt.getTime()) return { status: "waiting_period", eligibleAt };
  if (input.eventType === "damage" && input.policy.damageInspectionRequired && !input.hasInspection) {
    return { status: "awaiting_inspection", eligibleAt };
  }
  if (input.policy.carrierClaimRequired && !input.hasExternalCarrierClaim) {
    return { status: "awaiting_carrier_claim", eligibleAt };
  }
  return { status: "pending_approval", eligibleAt };
}

export function assertCarrierClaimOccurredAfterShipment(input: {
  occurredAt: Date;
  shippedAt: Date;
}): void {
  if (Number.isNaN(input.occurredAt.getTime()) || Number.isNaN(input.shippedAt.getTime())) {
    throw new DropshipError(
      "DROPSHIP_CARRIER_CLAIM_INVALID_OCCURRED_AT",
      "Carrier claim timing requires valid occurrence and shipment timestamps.",
    );
  }
  if (input.occurredAt.getTime() < input.shippedAt.getTime()) {
    throw new DropshipError(
      "DROPSHIP_CARRIER_CLAIM_OCCURRED_BEFORE_SHIPMENT",
      "Carrier event occurrence time cannot precede the affected shipment.",
      {
        occurredAt: input.occurredAt.toISOString(),
        shippedAt: input.shippedAt.toISOString(),
      },
    );
  }
}

export function carrierClaimValidationError(error: unknown): DropshipError | null {
  return error instanceof z.ZodError
    ? new DropshipError(
      "DROPSHIP_CARRIER_CLAIM_INVALID_INPUT",
      "Carrier claim input failed validation.",
      { issues: error.issues },
    )
    : null;
}

function assertNonnegativeMoney(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new DropshipError(
      "DROPSHIP_CARRIER_CLAIM_INVALID_MONEY",
      `${field} must be non-negative integer cents.`,
    );
  }
}

function assertPositiveMoney(value: number | null, field: string): void {
  if (!Number.isSafeInteger(value) || value == null || value <= 0) {
    throw new DropshipError(
      "DROPSHIP_CARRIER_CLAIM_INVALID_MONEY",
      `${field} must be positive integer cents.`,
    );
  }
}

function multiplyMoney(cents: number, quantity: number): number {
  const result = BigInt(cents) * BigInt(quantity);
  if (result > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new DropshipError("DROPSHIP_CARRIER_CLAIM_MONEY_OVERFLOW", "Carrier claim money exceeds the supported range.");
  }
  return Number(result);
}

function addMoney(left: number, right: number): number {
  const result = BigInt(left) + BigInt(right);
  if (result > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new DropshipError("DROPSHIP_CARRIER_CLAIM_MONEY_OVERFLOW", "Carrier claim money exceeds the supported range.");
  }
  return Number(result);
}

function addQuantity(left: number, right: number): number {
  if (!Number.isSafeInteger(left) || left < 0 || !Number.isSafeInteger(right) || right <= 0) {
    throw new DropshipError(
      "DROPSHIP_CARRIER_CLAIM_SHIPMENT_ITEMS_INVALID",
      "Carrier claim quantities must be positive safe integers.",
    );
  }
  const result = BigInt(left) + BigInt(right);
  if (result > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new DropshipError(
      "DROPSHIP_CARRIER_CLAIM_QUANTITY_OVERFLOW",
      "Carrier claim quantity exceeds the supported range.",
    );
  }
  return Number(result);
}
