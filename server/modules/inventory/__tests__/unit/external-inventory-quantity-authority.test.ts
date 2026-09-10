import { afterEach, describe, expect, it, vi } from "vitest";
import { InventoryUseCases } from "../../application/inventory.use-cases";

vi.mock("../../../../db", () => ({ db: {}, pool: {} }));

function createSubject(execute: ReturnType<typeof vi.fn>) {
  const warehouse = { id: 1, code: "LOCAL", inventorySourceType: "internal" };
  const chain = { from: vi.fn(), where: vi.fn(), limit: vi.fn(async () => [warehouse]) };
  chain.from.mockReturnValue(chain);
  chain.where.mockReturnValue(chain);
  const database = { execute, select: vi.fn(() => chain), update: vi.fn(), insert: vi.fn(), transaction: vi.fn() };
  const subject = new InventoryUseCases(database as never, {} as never);
  const adjust = vi.spyOn(subject, "adjustInventory");
  return { database, subject, adjust };
}

afterEach(() => vi.unstubAllGlobals());

describe("legacy external sync quantity authority", () => {
  it("rejects after opening before warehouse updates, provider reads or physical adjustment", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const { database, subject, adjust } = createSubject(vi.fn(async () => ({ rows: [{ command_id: "1" }] })));
    await expect(subject.syncWarehouse(1)).rejects.toMatchObject({ code: "QUANTITY_LEGACY_WRITER_RETIRED" });
    expect(database.select).not.toHaveBeenCalled();
    expect(database.update).not.toHaveBeenCalled();
    expect(database.insert).not.toHaveBeenCalled();
    expect(adjust).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("retains pre-opening source eligibility behavior", async () => {
    const { database, subject } = createSubject(vi.fn(async () => ({ rows: [] })));
    await expect(subject.syncWarehouse(1)).resolves.toMatchObject({ synced: 0, errors: ["Warehouse LOCAL has source type 'internal'"] });
    expect(database.select).toHaveBeenCalledOnce();
  });

  it("fails closed when the opening query fails", async () => {
    const error = Object.assign(new Error("opening relation missing"), { code: "42P01" });
    const { database, subject } = createSubject(vi.fn(async () => { throw error; }));
    await expect(subject.syncWarehouse(1)).rejects.toBe(error);
    expect(database.select).not.toHaveBeenCalled();
  });
});
