import { afterEach, describe, expect, it, vi } from "vitest";
import { CanonicalClaimQuantityPosting } from "../../infrastructure/canonical-claim-quantity-posting";
import { PostgresInventoryQuantityLedger } from "../../infrastructure/quantity-ledger.repository";

const command = { key: "canonical:pick:operator-command", kind: "pick" as const, actor: "operator",
  reason: "Exact claim pick", occurredAt: new Date("2026-09-10T12:00:00Z"),
  reference: { type: "availability_claim_pick", id: "9" } };
const movement = { inventoryLotId: 4, inventoryLevelId: 10, productVariantId: 101, warehouseLocationId: 100,
  delta: { onHand: -1, reserved: -1, picked: 1, packed: 0 } };
function fixture(active = true) {
  const client = { query: vi.fn(async (text: string) => {
    if (text.startsWith("SAVEPOINT") || text.startsWith("RELEASE SAVEPOINT")) return { rows: [] };
    if (text.includes("quantity_ledger_opening")) return { rows: active ? [{ command_id: "1" }] : [] };
    if (text.includes("warehouse.warehouse_locations")) return { rows: [{ id: 100, warehouse_id: 1 }] };
    throw new Error(`Unexpected query: ${text}`);
  }) };
  return client;
}

afterEach(() => vi.restoreAllMocks());
describe("explicit canonical quantity command plan", () => {
  it("returns legacy compatibility only when the installed opening table is empty", async () => {
    const client = fixture(false);
    expect(await CanonicalClaimQuantityPosting.forCommand(client, { ...command, key: undefined })).toBeNull();
    expect(client.query).toHaveBeenCalledExactlyOnceWith("SELECT command_id FROM inventory.quantity_ledger_opening WHERE singleton_key = true");
  });
  it("does not convert a missing migration into legacy write authority", async () => {
    const client = { query: vi.fn().mockRejectedValue(Object.assign(new Error("missing relation"), { code: "42P01" })) };
    await expect(CanonicalClaimQuantityPosting.forCommand(client, command)).rejects.toMatchObject({ code: "42P01" });
  });
  it.each([undefined, "", "  "])("requires a stable active business command key: %s", async key => {
    await expect(CanonicalClaimQuantityPosting.forCommand(fixture(), { ...command, key }))
      .rejects.toMatchObject({ code: "CANONICAL_QUANTITY_COMMAND_REQUIRED" });
  });
  it("aggregates exact allocations once per physical lot without mutating the caller", async () => {
    const post = vi.spyOn(PostgresInventoryQuantityLedger.prototype, "postInsideTransaction").mockResolvedValue({
      commandId: "2", requestHash: "a".repeat(64), alreadyApplied: false, balances: [],
    });
    const client = fixture();
    const posting = (await CanonicalClaimQuantityPosting.forCommand(client, command))!;
    const original = structuredClone(movement);
    posting.add(movement); posting.add(movement); await posting.post();
    expect(post).toHaveBeenCalledOnce();
    expect(post.mock.calls[0][1]).toMatchObject({ idempotencyKey: command.key, kind: "pick",
      movements: [{ ...movement, warehouseId: 1, delta: { onHand: -2, reserved: -2, picked: 2, packed: 0 } }] });
    expect(movement).toEqual(original);
    expect(() => posting.add(movement)).toThrow(/already posted/);
    await expect(posting.post()).rejects.toMatchObject({ code: "QUANTITY_POSTING_CLOSED" });
  });
  it("rejects conflicting physical identities within a single command", async () => {
    const posting = (await CanonicalClaimQuantityPosting.forCommand(fixture(), command))!;
    posting.add(movement);
    expect(() => posting.add({ ...movement, warehouseLocationId: 101 })).toThrow(/multiple physical locations/);
  });
  it("requires nonzero movement and does not fabricate a no-op quantity event", async () => {
    const posting = (await CanonicalClaimQuantityPosting.forCommand(fixture(), command))!;
    await expect(posting.post()).rejects.toMatchObject({ code: "QUANTITY_MOVEMENT_REQUIRED" });
  });
  it("rejects low-level replay so the outer owner must replay its complete business receipt", async () => {
    vi.spyOn(PostgresInventoryQuantityLedger.prototype, "postInsideTransaction").mockResolvedValue({
      commandId: "2", requestHash: "a".repeat(64), alreadyApplied: true, balances: [],
    });
    const posting = (await CanonicalClaimQuantityPosting.forCommand(fixture(), command))!;
    posting.add(movement);
    await expect(posting.post()).rejects.toMatchObject({ code: "CANONICAL_QUANTITY_REPLAY_REQUIRED" });
  });
});
