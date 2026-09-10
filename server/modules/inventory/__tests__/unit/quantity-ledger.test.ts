import { describe, expect, it } from "vitest";
import { applyQuantityDelta, emptyQuantityBalance, MAX_INVENTORY_QUANTITY, normalizeQuantityCommand,
  replayQuantityMovements, type QuantityCommand, type QuantityMovement } from "../../domain/quantity-ledger";
import { quantityCommandHash } from "../../infrastructure/quantity-ledger.repository";

const movement = (delta: QuantityMovement["delta"], inventoryLotId = 1): QuantityMovement => ({
  inventoryLotId, inventoryLevelId: 10, productVariantId: 100, warehouseLocationId: 200, warehouseId: 300, delta,
});
const command = (kind: QuantityCommand["kind"], movements: QuantityMovement[]): QuantityCommand => ({
  contractVersion: "inventory_quantity_v1", idempotencyKey: "test-posting", kind, actor: "operator:1",
  reason: "Recorded exact physical movement", occurredAt: "2026-09-10T16:00:00Z",
  reference: { type: "test", id: "test-1" }, reversesCommandId: null, movements,
});
const d = (onHand = 0, reserved = 0, picked = 0, packed = 0) => ({ onHand, reserved, picked, packed });

describe("single inventory quantity contract", () => {
  it("replays receive, reserve, pick, pack and ship without a second on-hand debit", () => {
    const postings = [command("receive", [movement(d(25))]), command("reserve", [movement(d(0,5))]),
      command("pick", [movement(d(-5,-5,5))]), command("pack", [movement(d(0,0,-5,5))]),
      command("ship", [movement(d(0,0,0,-5))])];
    const replay = replayQuantityMovements(postings.flatMap(posting => normalizeQuantityCommand(posting).movements));
    expect(replay.get(1)).toEqual(d(20));
  });
  it("keeps reservation inside physical on-hand and restores both on an owned unpick", () => {
    const picked = applyQuantityDelta(d(20,8), movement(d(-5,-5,5)));
    expect(picked).toEqual(d(15,3,5));
    expect(applyQuantityDelta(picked, movement(d(5,5,-5)))).toEqual(d(20,8));
  });
  it("permits unpick without restoring a cancelled reservation", () => {
    expect(normalizeQuantityCommand(command("unpick", [movement(d(2,0,-2))])).kind).toBe("unpick");
    expect(applyQuantityDelta(d(0,0,2), movement(d(2,0,-2)))).toEqual(d(2));
  });
  it.each([
    ["receive", d(-1)], ["receipt_reversal", d(1)], ["return", d(1,1)],
    ["reserve", d(1,1)], ["release", d(0,1)], ["pick", d(0,0,1)],
    ["pick", d(-1,-2,1)], ["unpick", d(1,2,-1)], ["pack", d(0,0,-1,2)],
    ["unpack", d(0,0,2,-1)], ["ship", d(1)], ["ship", d(0,-1)],
    ["ship", d(0,0,0,0)], ["opening", d(1,2)], ["opening", d(-1)],
  ] as const)("rejects invalid %s bucket semantics (%j)", (kind, delta) => {
    expect(() => normalizeQuantityCommand(command(kind, [movement(delta)]))).toThrow();
  });
  it.each([NaN, Infinity, -Infinity, 0.5, MAX_INVENTORY_QUANTITY+1, -MAX_INVENTORY_QUANTITY-1])("rejects invalid integer %s", qty => {
    expect(() => normalizeQuantityCommand(command("adjust", [movement(d(qty))]))).toThrow();
  });
  it("allows maximum exact quantity but not overflow or negative custody", () => {
    expect(applyQuantityDelta(emptyQuantityBalance(), movement(d(MAX_INVENTORY_QUANTITY)))).toEqual(d(MAX_INVENTORY_QUANTITY));
    expect(() => applyQuantityDelta(d(MAX_INVENTORY_QUANTITY), movement(d(1)))).toThrow(/invalid physical custody/);
    expect(() => applyQuantityDelta(d(), movement(d(-1)))).toThrow(/invalid physical custody/);
    expect(() => applyQuantityDelta(d(5,5), movement(d(-1)))).toThrow(/held by another owner/);
  });
  it("rejects duplicate lots and contradictory level identities", () => {
    const first = movement(d(1));
    expect(() => normalizeQuantityCommand(command("receive", [first, first]))).toThrow(/one exact identity/);
    expect(() => normalizeQuantityCommand(command("receive", [first, { ...movement(d(1),2), warehouseId: 2 }]))).toThrow();
    expect(() => normalizeQuantityCommand(command("receive", [first, { ...movement(d(1),2), inventoryLevelId: 11 }]))).toThrow();
  });
  it("conserves every exact SKU bucket in a transfer, not just a product's total", () => {
    const source = movement(d(-5,-2));
    const target = { ...movement(d(5,2),2), inventoryLevelId: 11, warehouseLocationId: 201 };
    expect(normalizeQuantityCommand(command("transfer", [source,target])).movements).toHaveLength(2);
    expect(() => normalizeQuantityCommand(command("transfer", [source,{ ...target, delta: d(5) }]))).toThrow(/conserve/);
    expect(() => normalizeQuantityCommand(command("transfer", [source,{ ...target, productVariantId: 101 }]))).toThrow(/conserve/);
  });
  it("does not mutate or reorder the supplied plan", () => {
    const input = command("receive", [movement(d(1),2), movement(d(2),1)]);
    const original = structuredClone(input);
    expect(normalizeQuantityCommand(input).movements.map(row => row.inventoryLotId)).toEqual([1,2]);
    expect(input).toEqual(original);
  });
  it("hashes semantic intent independently of retry clock and input ordering", () => {
    const input = command("receive", [movement(d(1),2), movement(d(2),1)]);
    const retry = { ...input, occurredAt: "2026-09-10T16:01:00Z", movements: [...input.movements].reverse() };
    expect(quantityCommandHash(input)).toBe(quantityCommandHash(retry));
    expect(quantityCommandHash({ ...input, actor: "other" })).not.toBe(quantityCommandHash(input));
    expect(quantityCommandHash({ ...input, movements: [movement(d(3))] })).not.toBe(quantityCommandHash(input));
  });
  it("rejects hidden extra fields and empty audit identities", () => {
    expect(() => normalizeQuantityCommand({ ...command("receive", [movement(d(1))]), actor: " " })).toThrow();
    expect(() => normalizeQuantityCommand({ ...command("receive", [movement(d(1))]), bypass: true })).toThrow();
  });
  it("can open an empty warehouse but cannot post an empty operational command", () => {
    expect(normalizeQuantityCommand(command("opening", [])).movements).toEqual([]);
    expect(() => normalizeQuantityCommand(command("receive", []))).toThrow(/requires a quantity movement/);
  });
  it("does not silently move a previously posted lot to another identity on replay", () => {
    expect(() => replayQuantityMovements([movement(d(5)), { ...movement(d(-1)), warehouseLocationId: 201 }])).toThrow(/change identity/);
  });
});
