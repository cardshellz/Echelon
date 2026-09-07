import { describe, expect, it } from "vitest";
import {
  canonicalClaimDispatchCommandSchema, canonicalClaimDispatchPlanSchema,
  type CanonicalClaimDispatchCommand, type CanonicalClaimDispatchEvidence, type CanonicalClaimDispatchReceipt,
} from "@shared/types/inventory-availability-dispatch";
import {
  canonicalClaimDispatchCommandHash, canonicalClaimDispatchPlanHash,
  planCanonicalClaimDispatch, validateCanonicalClaimDispatchReplay,
} from "../../domain/inventory-availability-dispatch";

function fixture() {
  const command: CanonicalClaimDispatchCommand = { claimId: "10", orderId: 70, orderItemId: 71,
    warehouseId: 1, warehouseLocationId: 50, productVariantId: 105, outboundShipmentId: 90, sourceShipmentItemId: 101,
    physicalShipmentId: null, physicalShipmentItemId: null, quantity: "3", idempotencyKey: "dispatch:90:101:1",
    actor: "shipping-worker", reason: "Confirmed source dispatch" };
  const evidence: CanonicalClaimDispatchEvidence = {
    coverage: "complete_final_target_line", source: { orderId: 70, orderItemId: 71, warehouseId: 1, warehouseLocationId: 50,
      productVariantId: 105, outboundShipmentId: 90, sourceShipmentItemId: 101, physicalShipmentId: null,
      physicalShipmentItemId: null, physicalShipmentItemQuantity: null, quantity: "3", dispatchedQuantity: "0",
      readiness: "authorized", orderStatus: "ready_to_ship" },
    claim: { id: "10", orderId: 70, status: "active" },
    line: { id: "20", claimId: "10", orderItemId: 71, targetVariantId: 105, plannedQty: "5",
      releasedTargetQty: "0", consumedTargetQty: "0", pickedTargetQty: "5" },
    resources: [{ id: "30", claimId: "10", claimLineId: "20", warehouseId: 1, warehouseLocationId: 50,
      inventoryLevelId: 60, sourceVariantId: 105, consumerOperationKey: null, producerOperationKey: null,
      claimedQty: "5", releasedQty: "0", consumedQty: "0", pickedQty: "5", lots: [
        { id: "40", claimId: "10", claimResourceId: "30", inventoryLotId: 401, claimedQty: "3", releasedQty: "0", consumedQty: "0", pickedQty: "3" },
        { id: "41", claimId: "10", claimResourceId: "30", inventoryLotId: 402, claimedQty: "2", releasedQty: "0", consumedQty: "0", pickedQty: "2" },
      ] }],
    pickMovements: [
      { id: "50", claimId: "10", claimLineId: "20", claimResourceId: "30", claimLotAllocationId: "40", inventoryLotId: 401,
        quantity: "3", reversedQuantity: "0", dispatchedQuantity: "0",
        cost: { id: 301, orderId: 70, orderItemId: 71, productVariantId: 105, inventoryLotId: 401, quantity: "3", unitCostMills: "100", totalCostMills: "300" } },
      { id: "51", claimId: "10", claimLineId: "20", claimResourceId: "30", claimLotAllocationId: "41", inventoryLotId: 402,
        quantity: "2", reversedQuantity: "0", dispatchedQuantity: "0",
        cost: { id: 302, orderId: 70, orderItemId: 71, productVariantId: 105, inventoryLotId: 402, quantity: "2", unitCostMills: "200", totalCostMills: "400" } },
    ],
  };
  return { command, evidence };
}
function receipt(): { command: CanonicalClaimDispatchCommand; receipt: CanonicalClaimDispatchReceipt } {
  const f = fixture(); const plan = planCanonicalClaimDispatch(f.command, f.evidence);
  return { command: f.command, receipt: { contractVersion: "canonical_claim_dispatch_receipt_v1", commandHash: plan.commandHash,
    planHash: canonicalClaimDispatchPlanHash(plan), plan, occurredAt: "2026-09-07T12:00:00.000Z" } };
}
function fails(change: (f: ReturnType<typeof fixture>) => void, code: string) {
  const f = fixture(); change(f);
  expect(() => planCanonicalClaimDispatch(f.command, f.evidence)).toThrowError(expect.objectContaining({ code, classification: "permanent" }));
}

describe("canonical picked-stock dispatch plan", () => {
  it("moves only exact picked ownership to consumed without another on-hand deduction, reserve or COGS posting", () => {
    const f = fixture(); const before = structuredClone(f); const plan = planCanonicalClaimDispatch(f.command, f.evidence);
    expect(plan).toMatchObject({ quantity: "3", pickedTargetQtyBefore: "5", pickedTargetQtyAfter: "2",
      consumedTargetQtyBefore: "0", consumedTargetQtyAfter: "3", sourceRemainingQuantity: "0",
      sourceDispositionAfter: "fully_dispatched", physicalOnHandDelta: "0", reservedQuantityDelta: "0", createsPick: false, createsCogs: false,
      resources: [{ claimResourceId: "30", warehouseId: 1, warehouseLocationId: 50, inventoryLevelId: 60, sourceVariantId: 105,
        quantity: "3", pickedQtyBefore: "5", pickedQtyAfter: "2", consumedQtyAfter: "3",
        lots: [{ claimLotAllocationId: "40", inventoryLotId: 401, quantity: "3", pickedQtyAfter: "0", consumedQtyAfter: "3",
          picks: [{ pickMovementId: "50", orderItemCostId: 301, quantity: "3", unitCostMills: "100" }] }] }] });
    expect(f).toEqual(before);
  });
  it("consumes a complete source across exact lots deterministically even when input arrays are reordered", () => {
    const f = fixture(); f.command.quantity = "5"; f.evidence.source.quantity = "5";
    const original = planCanonicalClaimDispatch(f.command, f.evidence);
    f.evidence.resources.reverse(); f.evidence.resources[0].lots.reverse(); f.evidence.pickMovements.reverse();
    const reordered = planCanonicalClaimDispatch(f.command, f.evidence);
    expect(reordered).toEqual(original); expect(original.sourceDispositionAfter).toBe("fully_dispatched");
    expect(original.resources[0].lots.map((lot) => lot.inventoryLotId)).toEqual([401, 402]);
  });
  it("subtracts prior unpick and dispatch allocations from each original pick without changing its COGS row", () => {
    const f = fixture(); f.command.quantity = "2"; f.evidence.source.quantity = "2";
    f.evidence.line.pickedTargetQty = "3"; f.evidence.line.consumedTargetQty = "1";
    f.evidence.resources[0].pickedQty = "3"; f.evidence.resources[0].consumedQty = "1";
    f.evidence.resources[0].lots[0].pickedQty = "1"; f.evidence.resources[0].lots[0].consumedQty = "1";
    f.evidence.pickMovements[0].reversedQuantity = "1"; f.evidence.pickMovements[0].dispatchedQuantity = "1";
    const plan = planCanonicalClaimDispatch(f.command, f.evidence);
    expect(plan.resources[0].lots.map((lot) => lot.quantity)).toEqual(["1", "1"]);
    expect(plan).toMatchObject({ pickedTargetQtyAfter: "1", consumedTargetQtyAfter: "3", sourceRemainingQuantity: "0" });
    expect(f.evidence.pickMovements[0].cost.quantity).toBe("3");
  });
  it("keeps direct and transformed target ownership separate when they share the same bin and variant", () => {
    const f = fixture(); f.command.quantity = "5"; f.evidence.source.quantity = "5";
    const direct = f.evidence.resources[0];
    const built = structuredClone(direct);
    built.id = "31"; built.producerOperationKey = "build:target:1";
    built.claimedQty = "2"; built.pickedQty = "2";
    built.lots = [direct.lots[1]]; built.lots[0].claimResourceId = "31";
    direct.lots = [direct.lots[0]]; direct.claimedQty = "3"; direct.pickedQty = "3";
    f.evidence.resources = [built, direct]; f.evidence.pickMovements[1].claimResourceId = "31";
    const plan = planCanonicalClaimDispatch(f.command, f.evidence);
    expect(plan.resources.map((resource) => [resource.claimResourceId, resource.quantity])).toEqual([["30", "3"], ["31", "2"]]);
    built.producerOperationKey = null;
    expect(() => planCanonicalClaimDispatch(f.command, f.evidence)).toThrowError(expect.objectContaining({ code: "CLAIM_DISPATCH_RESOURCE_IDENTITY_INVALID" }));
  });
  it.each(["active", "released", "superseded"] as const)("allows retained picked custody on %s claims only with current WMS authorization", (status) => {
    const f = fixture(); f.evidence.claim.status = status;
    expect(planCanonicalClaimDispatch(f.command, f.evidence).quantity).toBe("3");
  });
  it.each(["held", "unverified"] as const)("blocks %s source evidence", (readiness) => {
    fails((f) => { f.evidence.source.readiness = readiness; }, readiness === "held" ? "CLAIM_DISPATCH_HELD" : "CLAIM_DISPATCH_UNVERIFIED");
  });
  it.each(["cancelled", "failed"] as const)("blocks new dispatch on a %s claim", (status) => {
    fails((f) => { f.evidence.claim.status = status; }, "CLAIM_DISPATCH_TERMINAL_OWNER");
  });
  it("blocks cancelled orders even when source authorization and retained picked counters exist", () => {
    fails((f) => { f.evidence.source.orderStatus = "cancelled"; }, "CLAIM_DISPATCH_TERMINAL_OWNER");
  });
  it.each(["orderId", "orderItemId", "warehouseId", "warehouseLocationId", "productVariantId", "outboundShipmentId", "sourceShipmentItemId"] as const)("rejects a different source %s", (field) => {
    fails((f) => { f.evidence.source[field] += 1; }, "CLAIM_DISPATCH_SOURCE_IDENTITY_MISMATCH");
  });
  it("requires any known physical item pair and its exact quantity rather than inventing identifiers", () => {
    const f = fixture(); f.command.physicalShipmentId = "700"; f.command.physicalShipmentItemId = "701";
    Object.assign(f.evidence.source, { physicalShipmentId: "700", physicalShipmentItemId: "701", physicalShipmentItemQuantity: "3" });
    expect(planCanonicalClaimDispatch(f.command, f.evidence).command.physicalShipmentItemId).toBe("701");
    f.evidence.source.physicalShipmentItemQuantity = "4";
    expect(() => planCanonicalClaimDispatch(f.command, f.evidence)).toThrowError(expect.objectContaining({ code: "CLAIM_DISPATCH_PHYSICAL_QUANTITY_MISMATCH" }));
    expect(canonicalClaimDispatchCommandSchema.safeParse({ ...f.command, physicalShipmentItemId: null }).success).toBe(false);
  });
  it("rejects a new command for an already dispatched source, even if picked units remain on the claim", () => {
    fails((f) => { f.evidence.source.dispatchedQuantity = "3"; }, "CLAIM_DISPATCH_SOURCE_ALREADY_DISPATCHED");
  });
  it("reports an already spent source before picked shortfall when prior dispatch exhausted the claim", () => {
    fails((f) => {
      f.evidence.source.dispatchedQuantity = "3";
      f.evidence.line.pickedTargetQty = "0"; f.evidence.line.consumedTargetQty = "5";
      f.evidence.resources[0].pickedQty = "0"; f.evidence.resources[0].consumedQty = "5";
      for (const lot of f.evidence.resources[0].lots) { lot.pickedQty = "0"; lot.consumedQty = lot.claimedQty; }
      for (const pick of f.evidence.pickMovements) pick.dispatchedQuantity = pick.quantity;
    }, "CLAIM_DISPATCH_SOURCE_ALREADY_DISPATCHED");
  });
  it.each(["2", "4"])("rejects incomplete or excess quantity %s against the same outbound source", (quantity) => {
    fails((f) => { f.command.quantity = quantity; }, "CLAIM_DISPATCH_SOURCE_QUANTITY_MISMATCH");
  });
  it.each(["warehouseId", "warehouseLocationId"] as const)("cannot draw another %s's picked stock", (field) => {
    fails((f) => { f.evidence.resources[0][field] += 1; }, "CLAIM_DISPATCH_PICKED_SHORTFALL");
  });
  it("has no direct-on-hand fallback even when all source units remain openly reserved", () => {
    fails((f) => { f.evidence.line.pickedTargetQty = "0"; f.evidence.resources[0].pickedQty = "0";
      f.evidence.resources[0].lots.forEach((lot) => { lot.pickedQty = "0"; }); f.evidence.pickMovements = []; }, "CLAIM_DISPATCH_PICKED_SHORTFALL");
  });
  it.each(["0", "-1", "1.5", "01", "9223372036854775808", "not-a-number"])("rejects invalid quantity %s", (quantity) => {
    fails((f) => { f.command.quantity = quantity; }, "CLAIM_DISPATCH_INVALID_INPUT");
  });
  it("does not accept authorization or quantity fallback flags in the command", () => {
    const f = fixture();
    for (const patch of [{ readiness: "authorized" }, { allowOnHand: true }, { createsCogs: true }]) {
      expect(() => planCanonicalClaimDispatch({ ...f.command, ...patch }, f.evidence)).toThrowError(expect.objectContaining({ code: "CLAIM_DISPATCH_INVALID_INPUT" }));
    }
  });
  it.each(["claim", "line", "variant"])("rejects foreign %s ownership", (kind) => {
    fails((f) => { if (kind === "claim") f.evidence.claim.orderId = 999;
      if (kind === "line") f.evidence.line.orderItemId = 999; if (kind === "variant") f.evidence.line.targetVariantId = 999;
    }, "CLAIM_DISPATCH_CLAIM_IDENTITY_MISMATCH");
  });
  it.each(["duplicate", "operation", "variant", "claim"])("rejects invalid final resource identity: %s", (kind) => {
    fails((f) => { const resource = f.evidence.resources[0];
      if (kind === "duplicate") f.evidence.resources.push(structuredClone(resource));
      if (kind === "operation") resource.consumerOperationKey = "component-build:1";
      if (kind === "variant") resource.sourceVariantId = 999;
      if (kind === "claim") resource.claimId = "999";
    }, "CLAIM_DISPATCH_RESOURCE_IDENTITY_INVALID");
  });
  it("validates whole-line totals rather than treating an incomplete warehouse projection as complete custody", () => {
    fails((f) => { f.evidence.line.pickedTargetQty = "6"; f.evidence.line.plannedQty = "6"; }, "CLAIM_DISPATCH_LINE_RESOURCE_MISMATCH");
  });
  it("requires every lot counter, not just open or picked totals, to reconcile", () => {
    fails((f) => { f.evidence.resources[0].claimedQty = "6"; }, "CLAIM_DISPATCH_LOT_RESOURCE_MISMATCH");
  });
  it("rejects original picked movement overconsumption by reversal plus prior dispatch", () => {
    fails((f) => { f.evidence.pickMovements[0].reversedQuantity = "2"; f.evidence.pickMovements[0].dispatchedQuantity = "2"; }, "CLAIM_DISPATCH_PICK_OVERSPENT");
  });
  it.each(["missing", "reversed", "dispatched"])("requires complete current pick/lot lineage: %s", (kind) => {
    fails((f) => { if (kind === "missing") f.evidence.pickMovements.pop();
      if (kind === "reversed") f.evidence.pickMovements[0].reversedQuantity = "1";
      if (kind === "dispatched") f.evidence.pickMovements[0].dispatchedQuantity = "1";
    }, "CLAIM_DISPATCH_PICK_LOT_MISMATCH");
  });
  it.each(["orderId", "orderItemId", "productVariantId", "inventoryLotId", "quantity", "totalCostMills"] as const)("rejects mismatched original COGS %s without replacing it", (field) => {
    fails((f) => { const cost = f.evidence.pickMovements[0].cost;
      if (field === "quantity" || field === "totalCostMills") cost[field] = "999"; else cost[field] = 999;
    }, "CLAIM_DISPATCH_COGS_IDENTITY_INVALID");
  });
  it("rejects duplicated cost or movement ownership", () => {
    fails((f) => { f.evidence.pickMovements[1].cost.id = f.evidence.pickMovements[0].cost.id; }, "CLAIM_DISPATCH_PICK_IDENTITY_INVALID");
  });
});

describe("canonical dispatch command and committed replay contracts", () => {
  it("replays an exact immutable result without current lifecycle state or additional planning", () => {
    const f = receipt(); expect(validateCanonicalClaimDispatchReplay(f.command, f.receipt)).toEqual(f.receipt);
    expect(validateCanonicalClaimDispatchReplay(f.command, null)).toBeNull();
  });
  it.each(["quantity", "actor", "reason", "idempotencyKey", "physicalShipmentItemId", "warehouseLocationId"] as const)("binds immutable replay to %s", (field) => {
    const f = receipt(); const command = { ...f.command };
    if (field === "warehouseLocationId") command[field] = 51;
    else if (field === "physicalShipmentItemId") { command.physicalShipmentId = "700"; command.physicalShipmentItemId = "701"; }
    else command[field] = field === "quantity" ? "2" : "changed";
    expect(() => validateCanonicalClaimDispatchReplay(command, f.receipt)).toThrowError(expect.objectContaining({ code: "CLAIM_DISPATCH_IDEMPOTENCY_CONFLICT" }));
  });
  it("detects corrupt persisted plan content even if the outer command identity matches", () => {
    const f = receipt(); f.receipt.plan.resources[0].lots[0].picks[0].unitCostMills = "101";
    expect(() => validateCanonicalClaimDispatchReplay(f.command, f.receipt)).toThrowError(expect.objectContaining({ code: "CLAIM_DISPATCH_RECEIPT_INVALID" }));
  });
  it("rejects a tampered quantity plan before it can be used as inventory mutation instructions", () => {
    const f = receipt(); f.receipt.plan.resources[0].quantity = "4";
    expect(canonicalClaimDispatchPlanSchema.safeParse(f.receipt.plan).success).toBe(false);
  });
  it.each(["1.5", "not-a-number", "-1", "9223372036854775808"])("returns contract issues rather than throwing on malformed output quantity %s", (quantity) => {
    const f = receipt(); f.receipt.plan.resources[0].quantity = quantity;
    expect(canonicalClaimDispatchPlanSchema.safeParse(f.receipt.plan).success).toBe(false);
  });
  it("hashes normalized command content independently of object-key ordering", () => {
    const f = fixture(); const reordered = Object.fromEntries(Object.entries(f.command).reverse());
    expect(canonicalClaimDispatchCommandHash(reordered)).toBe(canonicalClaimDispatchCommandHash(f.command));
  });
});
