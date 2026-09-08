import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { canonicalJson } from "@shared/utils/canonical-json";
import { canonicalClaimDispatchPlanHash } from "../../domain/inventory-availability-dispatch";
import { PostgresCanonicalClaimDispatchSourceCommandResolver } from "../../infrastructure/inventory-availability-dispatch-source-command.repository";
import { DISPATCH_TIME, dispatchPlan } from "../../../inventory/__tests__/fixtures/canonical-claim-dispatch";

const digest = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
function fixture() {
  const plan = dispatchPlan(); const command = plan.command;
  const receipt = { contractVersion: "canonical_claim_dispatch_receipt_v1", commandHash: plan.commandHash,
    planHash: canonicalClaimDispatchPlanHash(plan), plan, occurredAt: DISPATCH_TIME.toISOString() };
  const row = { id: "1", claim_id: command.claimId, order_id: command.orderId, command_type: "dispatch",
    idempotency_key: command.idempotencyKey, request_hash: plan.commandHash, result_hash: digest(receipt), request_payload: command, result_payload: receipt };
  const custody = { command_id: "1", claim_id: command.claimId, claim_line_id: plan.claimLineId,
    order_id: command.orderId, order_item_id: command.orderItemId, warehouse_id: command.warehouseId,
    warehouse_location_id: command.warehouseLocationId, product_variant_id: command.productVariantId,
    outbound_shipment_id: command.outboundShipmentId, source_shipment_item_id: command.sourceShipmentItemId,
    physical_shipment_id: command.physicalShipmentId, physical_shipment_item_id: command.physicalShipmentItemId, quantity: command.quantity };
  const commandRows = [row]; const custodyRows = [custody];
  const { orderId, orderItemId, outboundShipmentId, sourceShipmentItemId, productVariantId, quantity } = command;
  const request = { orderId, orderItemId, outboundShipmentId, sourceShipmentItemId, productVariantId, quantity, actor: "retry-worker", reason: "Retry after materialization" };
  const query = vi.fn(async (sql: string) => {
    if (sql.includes("current_setting")) return { rows: [{ isolation: "serializable", read_only: "off" }] };
    if (sql.includes("FROM inventory.availability_claim_commands")) return { rows: commandRows };
    if (sql.includes("FROM inventory.availability_claim_dispatch_receipts")) return { rows: custodyRows };
    throw new Error(`Replay must not read current authority or source: ${sql}`);
  });
  const owner = { lockSourceForPreparation: vi.fn(async () => { throw new Error("replay must not reload WMS"); }),
    bindSourceLocation: vi.fn(async () => { throw new Error("replay must not write WMS"); }) };
  const run = () => new PostgresCanonicalClaimDispatchSourceCommandResolver(owner).resolve({ query }, request);
  return { row, custody, commandRows, custodyRows, command, request, query, owner, run };
}

describe("canonical source resolver committed replay integrity", () => {
  it("returns original audited command before reading authority or current physical IDs", async () => {
    const f = fixture(); const before = structuredClone(f.command);
    expect(await f.run()).toEqual(before);
    expect(f.owner.lockSourceForPreparation).not.toHaveBeenCalled(); expect(f.owner.bindSourceLocation).not.toHaveBeenCalled();
    expect(f.query).toHaveBeenCalledTimes(3);
    expect(f.query.mock.calls[1][0]).toContain("FOR SHARE OF command");
    expect(f.query.mock.calls[1][0]).toContain("receipt.source_shipment_item_id=$2");
  });
  it.each(["request_hash", "result_hash", "command_type", "idempotency_key", "claim_id"] as const)("rejects corrupted %s", async (field) => {
    const f = fixture(); f.row[field] = field === "claim_id" ? "999" : "invalid";
    await expect(f.run()).rejects.toMatchObject({ code: "CLAIM_DISPATCH_SOURCE_REPLAY_INVALID" });
    expect(f.owner.lockSourceForPreparation).not.toHaveBeenCalled();
  });
  it("validates the inner immutable plan hash even when the outer result hash agrees", async () => {
    const f = fixture(); f.row.result_payload.planHash = "0".repeat(64); f.row.result_hash = digest(f.row.result_payload);
    await expect(f.run()).rejects.toMatchObject({ code: "CLAIM_DISPATCH_RECEIPT_INVALID" });
  });
  it("rejects altered result command identity even when the result hash was recomputed", async () => {
    const f = fixture(); f.row.result_payload = structuredClone(f.row.result_payload);
    f.row.result_payload.plan.command.actor = "tampered-actor"; f.row.result_hash = digest(f.row.result_payload);
    await expect(f.run()).rejects.toMatchObject({ code: "CLAIM_DISPATCH_IDEMPOTENCY_CONFLICT" });
  });
  it.each(["command_id", "claim_id", "claim_line_id", "quantity"] as const)("rejects mismatched custody receipt %s", async (field) => {
    const f = fixture(); f.custody[field] = "999";
    await expect(f.run()).rejects.toMatchObject({ code: "CLAIM_DISPATCH_SOURCE_REPLAY_INVALID" });
  });
  it("rejects absent, duplicate or unrelated custody receipt rows", async () => {
    for (const count of [0, 2]) {
      const f = fixture(); f.custodyRows.length = 0;
      for (let index = 0; index < count; index += 1) f.custodyRows.push(structuredClone(f.custody));
      await expect(f.run()).rejects.toMatchObject({ code: "CLAIM_DISPATCH_SOURCE_REPLAY_INVALID" });
    }
  });
  it("rejects a stable-key collision with a separate source-key receipt", async () => {
    const f = fixture(); f.commandRows.push({ ...f.row, id: "2" });
    await expect(f.run()).rejects.toMatchObject({ code: "CLAIM_DISPATCH_SOURCE_REPLAY_CONFLICT" });
  });
  it("rejects a changed requested source business identity without touching current WMS state", async () => {
    const f = fixture(); f.request.orderItemId = 99;
    await expect(f.run()).rejects.toMatchObject({ code: "CLAIM_DISPATCH_SOURCE_REPLAY_CONFLICT" });
    expect(f.owner.lockSourceForPreparation).not.toHaveBeenCalled();
  });
});
