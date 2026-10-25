import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";
import { InventoryLotService } from "../../lots.service";
import { COGSService } from "../../cogs.service";

vi.mock("../../../../db", () => ({ pool: {}, db: {} }));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(complete => { resolve = complete; });
  return { promise, resolve };
}

function fixture() {
  const lockEntered = deferred();
  const releaseLock = deferred();
  const inserted: Record<string, unknown>[] = [];
  const db: ConstructorParameters<typeof InventoryLotService>[0] = {
    select: vi.fn(), update: vi.fn(), delete: vi.fn(),
    transaction: vi.fn(async work => work(db)),
    execute: vi.fn(async query => {
      const statement = new PgDialect().sqlToQuery(query).sql;
      if (statement.includes("pg_advisory_xact_lock")) {
        lockEntered.resolve();
        await releaseLock.promise;
      }
      return { rows: statement.includes("AS suffix") ? [{ suffix: null }] : [] };
    }),
    insert: vi.fn(() => ({ values(value: Record<string, unknown>) {
      inserted.push(value);
      return { returning: async () => [{ id: 1, ...value }] };
    } })),
  };
  return { db, inserted, lockEntered, releaseLock };
}

const creators = [
  { name: "receiving lot", create(db: ConstructorParameters<typeof InventoryLotService>[0], clock: () => Date) {
    return new InventoryLotService(db, clock).createLot({ productVariantId: 1, warehouseLocationId: 2, qty: 3, unitCostCents: 4 });
  } },
  { name: "legacy cost lot", create(db: ConstructorParameters<typeof InventoryLotService>[0], clock: () => Date) {
    return new COGSService(db, clock).createLot({ productVariantId: 1, warehouseLocationId: 2, qtyPieces: 3, poUnitCostCents: 4 });
  } },
];

describe.each(creators)("$name command clock", creator => {
  it("retains a copied timestamp while waiting for the number lock across midnight", async () => {
    const f = fixture();
    const supplied = new Date("2026-10-25T23:59:59.123Z");
    const captured = new Date(supplied);
    const clock = vi.fn(() => supplied);
    const pending = creator.create(f.db, clock);
    try {
      await f.lockEntered.promise;
      supplied.setUTCDate(26);
    } finally { f.releaseLock.resolve(); }
    await pending;
    expect(clock).toHaveBeenCalledOnce();
    expect(f.inserted).toHaveLength(1);
    expect(f.inserted[0]).toMatchObject({ lotNumber: "LOT-20261025-001", receivedAt: captured });
    expect(f.inserted[0].receivedAt).not.toBe(supplied);
  });

  it("rejects an invalid clock before beginning a transaction or querying allocation", async () => {
    const f = fixture();
    await expect(creator.create(f.db, () => new Date("invalid"))).rejects.toThrow();
    expect(f.db.transaction).not.toHaveBeenCalled();
    expect(f.db.execute).not.toHaveBeenCalled();
    expect(f.db.insert).not.toHaveBeenCalled();
  });
});
