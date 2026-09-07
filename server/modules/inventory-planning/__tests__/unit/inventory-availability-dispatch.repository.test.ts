import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import { canonicalJson } from "@shared/utils/canonical-json";
import { PostgresCanonicalClaimDispatchRepository } from "../../infrastructure/inventory-availability-dispatch.repository";
import { canonicalClaimDispatchPlanHash, planCanonicalClaimDispatch } from "../../domain/inventory-availability-dispatch";
import { inventoryDispatchFixture } from "../fixtures/inventory-dispatch.fixture";

function setup() {
  const f = inventoryDispatchFixture();
  const state = { authority: "canonical", priorQuantity: "0", replay: [] as unknown[],
    claims: [f.evidence.claim], lines: [f.evidence.line], resources: f.evidence.resources,
    updateCount: 1, failure: null as null | ((sql: string) => void) };
  const calls: string[] = [];
  const query = vi.fn(async (sql: string, _values?: unknown[]) => {
    calls.push(sql); state.failure?.(sql);
    if (sql.includes("SELECT command_type")) return { rows: state.replay };
    if (sql.includes("FROM inventory.availability_runtime_authority")) return { rows: [{ authority: state.authority, activation_run_id: "1", revision: "2" }] };
    if (sql.includes("FROM inventory.availability_claims WHERE")) return { rows: state.claims };
    if (sql.includes("FROM inventory.availability_claim_lines WHERE")) return { rows: state.lines };
    if (sql.includes("FROM inventory.availability_claim_resources WHERE")) return { rows: state.resources.map(({ lots, ...resource }) => resource) };
    if (sql.includes("FROM inventory.availability_claim_lot_allocations WHERE")) return { rows: f.evidence.resources.flatMap((resource) => resource.lots) };
    if (sql.includes("FROM inventory.availability_claim_pick_movements pick")) return { rows: f.evidence.pickMovements.map(({ cost, ...pick }) => ({ ...pick, orderItemCostId: cost.id })) };
    if (sql.includes("SELECT COALESCE(sum(quantity)")) return { rows: [{ quantity: state.priorQuantity }] };
    if (sql.startsWith("UPDATE inventory.availability_claim")) return { rows: [], rowCount: state.updateCount };
    if (sql.startsWith("INSERT INTO inventory.availability_claim_commands")) return { rows: [{ id: "80" }], rowCount: 1 };
    if (sql.startsWith("INSERT INTO inventory.availability_claim_dispatch_receipts")) return { rows: [{ id: "81" }], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  });
  const release = vi.fn();
  const client = { query, release } as unknown as PoolClient;
  const connect = vi.fn(async () => client);
  const { dispatchedQuantity: _prior, ...source } = f.evidence.source;
  const sourceOwner = { lockDispatchSource: vi.fn(async () => source) };
  const writer = { loadDispatchCosts: vi.fn(async () => f.evidence.pickMovements.map((pick) => pick.cost)),
    dispatchPickedResources: vi.fn(async () => ({ inventoryTransactionId: 500, quantity: "3", physicalOnHandDelta: "0" as const,
      reservedQuantityDelta: "0" as const, pickedQuantityDelta: "-3" })) };
  const beforeCommit = vi.fn(async () => { calls.push("BEFORE_COMMIT"); });
  const clock = vi.fn(() => new Date("2026-09-07T12:00:00.000Z"));
  const repo = new PostgresCanonicalClaimDispatchRepository({ connect } as unknown as Pick<Pool, "connect">, sourceOwner, writer, beforeCommit, clock);
  return { ...f, state, query, calls, release, client, connect, sourceOwner, source, writer, beforeCommit, clock, repo };
}
function storedReplay(f: ReturnType<typeof setup>) {
  const plan = planCanonicalClaimDispatch(f.command, f.evidence);
  const receipt = { contractVersion: "canonical_claim_dispatch_receipt_v1", commandHash: plan.commandHash,
    planHash: canonicalClaimDispatchPlanHash(plan), plan, occurredAt: "2026-09-07T12:00:00.000Z" };
  return { command_type: "dispatch", request_hash: plan.commandHash,
    result_hash: createHash("sha256").update(canonicalJson(receipt)).digest("hex"), result_payload: receipt };
}

describe("canonical dispatch transaction repository", () => {
  it("commits exact owner custody, claim counters, immutable lineage and awaited publication hook together", async () => {
    const f = setup(); const receipt = await f.repo.dispatch(f.command);
    expect(receipt.plan.pickedTargetQtyAfter).toBe("0");
    expect(f.calls[0]).toBe("BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE");
    expect(f.calls.slice(-2)).toEqual(["BEFORE_COMMIT", "COMMIT"]);
    expect(f.writer.dispatchPickedResources).toHaveBeenCalledExactlyOnceWith({ client: f.client, plan: receipt.plan, occurredAt: f.clock() });
    expect(f.beforeCommit).toHaveBeenCalledExactlyOnceWith({ client: f.client, receipt, inventoryTransactionId: 500 });
    expect(f.calls.filter((sql) => sql.startsWith("UPDATE inventory.availability_claim"))).toHaveLength(3);
    expect(f.calls.filter((sql) => sql.startsWith("INSERT INTO inventory.availability_claim_dispatch_movements"))).toHaveLength(1);
    expect(f.calls.some((sql) => sql.includes("UPDATE inventory.inventory_levels"))).toBe(false);
    expect(f.release).toHaveBeenCalledWith(undefined);
  });
  it("returns exact committed replay before current source/authority and without another write or callback", async () => {
    const f = setup(); const replay = storedReplay(f); f.state.replay = [replay]; f.state.authority = "legacy";
    expect(await f.repo.dispatch(f.command)).toEqual(replay.result_payload);
    expect(f.sourceOwner.lockDispatchSource).not.toHaveBeenCalled();
    expect(f.writer.dispatchPickedResources).not.toHaveBeenCalled(); expect(f.beforeCommit).not.toHaveBeenCalled();
  });
  it.each(["reason", "actor", "quantity"] as const)("rejects changed %s under the same command key", async (field) => {
    const f = setup(); f.state.replay = [storedReplay(f)];
    await expect(f.repo.dispatch({ ...f.command, [field]: field === "quantity" ? "2" : "different" })).rejects.toMatchObject({ code: "CLAIM_DISPATCH_IDEMPOTENCY_CONFLICT" });
    expect(f.calls.at(-1)).toBe("ROLLBACK");
  });
  it("rejects a corrupted immutable result hash", async () => {
    const f = setup(); f.state.replay = [{ ...storedReplay(f), result_hash: "0".repeat(64) }];
    await expect(f.repo.dispatch(f.command)).rejects.toMatchObject({ code: "CLAIM_DISPATCH_RECEIPT_INVALID" });
  });
  it("requires canonical authority before asking any mutation/source owner", async () => {
    const f = setup(); f.state.authority = "legacy";
    await expect(f.repo.dispatch(f.command)).rejects.toMatchObject({ code: "CANONICAL_AUTHORITY_NOT_ACTIVE" });
    expect(f.sourceOwner.lockDispatchSource).not.toHaveBeenCalled();
  });
  it.each(["claims", "lines"] as const)("rejects missing %s", async (field) => {
    const f = setup(); f.state[field] = [];
    await expect(f.repo.dispatch(f.command)).rejects.toMatchObject({ code: field === "claims" ? "CLAIM_DISPATCH_CLAIM_MISSING" : "CLAIM_DISPATCH_LINE_MISSING" });
    expect(f.writer.dispatchPickedResources).not.toHaveBeenCalled();
  });
  it("rejects already-dispatched sources under another key", async () => {
    const f = setup(); f.state.priorQuantity = "3";
    await expect(f.repo.dispatch(f.command)).rejects.toBeDefined(); expect(f.writer.dispatchPickedResources).not.toHaveBeenCalled();
  });
  it("does not apply a partial source or wrong persisted location", async () => {
    for (const change of [{ quantity: "2" }, { warehouseLocationId: 51 }]) {
      const f = setup(); await expect(f.repo.dispatch({ ...f.command, ...change })).rejects.toBeDefined();
      expect(f.writer.dispatchPickedResources).not.toHaveBeenCalled();
    }
  });
  it("rejects missing or duplicated cost evidence without writes", async () => {
    for (const duplicate of [false, true]) {
      const f = setup(); const cost = f.evidence.pickMovements[0].cost;
      f.writer.loadDispatchCosts.mockResolvedValue(duplicate ? [cost, cost] : []);
      await expect(f.repo.dispatch(f.command)).rejects.toMatchObject({ code: duplicate ? "CLAIM_DISPATCH_COST_DUPLICATE" : "CLAIM_DISPATCH_COST_MISSING" });
      expect(f.writer.dispatchPickedResources).not.toHaveBeenCalled();
    }
  });
  it("rejects incomplete bounded resource capture", async () => {
    const f = setup(); f.state.resources = Array.from({ length: 1001 }, () => f.evidence.resources[0]);
    await expect(f.repo.dispatch(f.command)).rejects.toMatchObject({ code: "CLAIM_DISPATCH_EVIDENCE_LIMIT" });
  });
  it("rolls back any owner result that differs from the exact requested effect", async () => {
    const f = setup(); f.writer.dispatchPickedResources.mockResolvedValue({ inventoryTransactionId: 500, quantity: "2",
      physicalOnHandDelta: "0", reservedQuantityDelta: "0", pickedQuantityDelta: "-2" });
    await expect(f.repo.dispatch(f.command)).rejects.toMatchObject({ code: "CLAIM_DISPATCH_INVALID_MUTATION_RESULT" });
    expect(f.beforeCommit).not.toHaveBeenCalled(); expect(f.calls.at(-1)).toBe("ROLLBACK");
  });
  it("rolls back when conditional claim custody changed", async () => {
    const f = setup(); f.state.updateCount = 0;
    await expect(f.repo.dispatch(f.command)).rejects.toMatchObject({ code: "CLAIM_DISPATCH_STATE_CHANGED" });
    expect(f.beforeCommit).not.toHaveBeenCalled(); expect(f.calls.at(-1)).toBe("ROLLBACK");
  });
  it("awaits and rolls back failure of the before-commit owner callback", async () => {
    const f = setup(); f.beforeCommit.mockRejectedValue(new Error("publication persistence failed"));
    await expect(f.repo.dispatch(f.command)).rejects.toThrow("publication persistence failed");
    expect(f.calls).not.toContain("COMMIT"); expect(f.calls.at(-1)).toBe("ROLLBACK");
  });
  it.each(["40001", "40P01"])("retries %s with a fresh transaction and fixed command timestamp", async (code) => {
    const f = setup(); f.writer.dispatchPickedResources.mockRejectedValueOnce(Object.assign(new Error("retry"), { code }));
    await f.repo.dispatch(f.command); expect(f.connect).toHaveBeenCalledTimes(2);
    expect(f.clock).toHaveBeenCalledTimes(1); expect(f.calls.filter((sql) => sql === "ROLLBACK")).toHaveLength(1);
  });
  it("bounds serialization retries and never labels an exhausted dispatch successful", async () => {
    const f = setup(); f.writer.dispatchPickedResources.mockRejectedValue(Object.assign(new Error("retry"), { code: "40001" }));
    await expect(f.repo.dispatch(f.command)).rejects.toMatchObject({ code: "40001" });
    expect(f.connect).toHaveBeenCalledTimes(3); expect(f.calls).not.toContain("COMMIT");
  });
  it("does not assume an ambiguous COMMIT failed or automatically issue another dispatch", async () => {
    const f = setup(); f.state.failure = (sql) => { if (sql === "COMMIT") throw new Error("connection lost"); };
    await expect(f.repo.dispatch(f.command)).rejects.toThrow("connection lost"); expect(f.connect).toHaveBeenCalledTimes(1);
  });
  it("discards an ambiguous BEGIN connection", async () => {
    const f = setup(); f.state.failure = (sql) => { if (sql.startsWith("BEGIN")) throw new Error("begin lost"); };
    await expect(f.repo.dispatch(f.command)).rejects.toThrow("begin lost");
    expect(f.release).toHaveBeenCalledWith(expect.any(Error)); expect(f.calls).not.toContain("ROLLBACK");
  });
  it("discards failed rollback sessions without retrying them", async () => {
    const f = setup(); f.state.authority = "legacy";
    f.state.failure = (sql) => { if (sql === "ROLLBACK") throw new Error("rollback failed"); };
    await expect(f.repo.dispatch(f.command)).rejects.toBeInstanceOf(AggregateError);
    expect(f.release).toHaveBeenCalledWith(expect.any(Error)); expect(f.connect).toHaveBeenCalledTimes(1);
  });
  it("rejects invalid commands/clocks before acquiring a connection", async () => {
    const f = setup(); await expect(f.repo.dispatch({ ...f.command, quantity: "0" })).rejects.toBeDefined();
    f.clock.mockReturnValue(new Date("invalid")); await expect(f.repo.dispatch(f.command)).rejects.toMatchObject({ code: "CLAIM_DISPATCH_INVALID_CLOCK" });
    expect(f.connect).not.toHaveBeenCalled();
  });
});
