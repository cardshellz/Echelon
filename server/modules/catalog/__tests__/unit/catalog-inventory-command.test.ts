import { describe, expect, it, vi } from "vitest";
import { CatalogInventoryCommandService, type CatalogInventoryCommand, type CatalogInventoryUnitOfWork,
  type CatalogInventoryPosting } from "../../application/catalog-inventory-command.service";

const now = new Date("2026-09-10T16:00:00Z");
const command: CatalogInventoryCommand = { commandKey: "archive:1", operation: "product_archive",
  sourceId: 20, targetVariantId: 999, actor: "operator-1" };
const source = { id: 20, sku: "OLD", name: "Old product" };
const cell = (id: number, qty: number) => ({ productVariantId: id, onHand: qty, reserved: 0, picked: 0, packed: 0 });

function harness() {
  const events: string[] = [];
  const posting = {
    beginOperation: vi.fn(async (): Promise<{ result: Record<string, unknown> } | null> => { events.push("replay"); return null; }),
    post: vi.fn(async () => { events.push("post"); }),
    finishOperation: vi.fn(async () => { events.push("receipt"); }),
    finishNoMovement: vi.fn(async () => { events.push("no-movement"); }),
  } satisfies CatalogInventoryPosting;
  const unit = {
    posting: posting as CatalogInventoryPosting | null,
    loadSource: vi.fn(async () => { events.push("source"); return { source, sourceVariantIds: [102, 101] }; }),
    lockQuantities: vi.fn(async () => { events.push("locks"); return [cell(101, 5), cell(102, 7)]; }),
    convert: vi.fn(async (sourceId: number, _targetId: number, _key: string | undefined, _actor: string,
      defer: (effect: () => Promise<void>) => void) => {
      events.push(`convert:${sourceId}`);
      defer(async () => { events.push(`notify:${sourceId}`); });
      const qty = sourceId === 101 ? 5 : 7;
      return { totalConverted: qty, conversions: [{ locationCode: "PICK", qty }] };
    }),
    applyMetadata: vi.fn(async () => { events.push("metadata"); return { inventoryCleared: 0, binAssignmentsCleared: 2,
      channelFeedsDeactivated: 2, replenDeactivated: 1, replenTasksCancelled: 1, movedLocationCount: 0 }; }),
    recordAudit: vi.fn(async () => { events.push("audit"); }),
  } satisfies CatalogInventoryUnitOfWork;
  const transaction = vi.fn(async <T>(work: (value: CatalogInventoryUnitOfWork) => Promise<T>): Promise<T> => {
    events.push("begin");
    try { const result = await work(unit); events.push("commit"); return result; }
    catch (error) { events.push("rollback"); throw error; }
  });
  const log = vi.fn();
  return { unit, posting, events, transaction, log, service: new CatalogInventoryCommandService({ transaction }, () => now, log) };
}

describe("catalog inventory parent command", () => {
  it("locks the complete source/target set and commits one posting, audit and replay receipt before effects", async () => {
    const h = harness();
    const result = await h.service.execute(command);
    expect(h.events).toEqual(["begin", "replay", "source", "locks", "convert:101", "convert:102", "post", "metadata", "audit", "receipt", "commit", "notify:101", "notify:102"]);
    expect(h.unit.lockQuantities).toHaveBeenCalledWith([101, 102, 999]);
    expect(h.posting.post).toHaveBeenCalledExactlyOnceWith({ idempotencyKey: "archive:1", kind: "transform",
      actor: "operator-1", reason: "Catalog product_archive: 20", reference: { type: "catalog_inventory", id: "product_archive:20" }, occurredAt: now.toISOString() });
    expect(result).toMatchObject({ success: true, archived: { variants: 2, inventoryTransferred: 12, inventoryPreserved: 0 } });
    expect(h.posting.finishOperation).toHaveBeenCalledWith({ contractVersion: "catalog_inventory_v1", sourceVariantIds: [101, 102], response: result });
    expect(h.unit.recordAudit).toHaveBeenCalledWith(command, expect.objectContaining({ source,
      sourceVariantIds: [101, 102], sourceCells: [cell(101, 5), cell(102, 7)], response: result }), now);
    expect(h.unit.convert.mock.calls.map(call => call[2])).toHaveLength(2);
    expect(new Set(h.unit.convert.mock.calls.map(call => call[2])).size).toBe(2);
  });

  it("returns immutable parent result before source enumeration on retry", async () => {
    const initial = harness(); const result = await initial.service.execute(command);
    const h = harness();
    h.posting.beginOperation.mockResolvedValueOnce({ result: { contractVersion: "catalog_inventory_v1", sourceVariantIds: [101, 102], response: result } });
    expect(await h.service.execute(command)).toEqual(result);
    expect(h.events).toEqual(["begin", "commit"]);
    expect(h.posting.beginOperation).toHaveBeenCalledOnce();
    expect(h.unit.loadSource).not.toHaveBeenCalled();
    expect(h.unit.recordAudit).not.toHaveBeenCalled();
  });

  it("binds changed target and authenticated actor to the same caller-owned replay key", async () => {
    const h = harness();
    await h.service.execute({ ...command, targetVariantId: 998, actor: "operator-2" });
    expect(h.posting.beginOperation).toHaveBeenCalledWith("archive:1", {
      contractVersion: "catalog_inventory_v1", operation: "product_archive", sourceId: 20, targetVariantId: 998, actor: "operator-2",
    });
  });

  it("records an empty-source archive without fabricating a quantity event", async () => {
    const h = harness(); h.unit.lockQuantities.mockResolvedValueOnce([cell(101, 0), cell(102, 0)]);
    const result = await h.service.execute(command);
    expect(h.unit.convert).not.toHaveBeenCalled(); expect(h.posting.post).not.toHaveBeenCalled();
    expect(h.posting.finishOperation).not.toHaveBeenCalled();
    expect(h.posting.finishNoMovement).toHaveBeenCalledWith(expect.objectContaining({ response: result, sourceVariantIds: [101, 102] }));
    expect(h.unit.recordAudit).toHaveBeenCalledTimes(1);
  });

  it("preserves normal-archive stock and records only catalog intent", async () => {
    const h = harness();
    const result = await h.service.execute({ ...command, targetVariantId: null });
    expect(result).toMatchObject({ archived: { inventoryPreserved: 12, inventoryTransferred: 0 } });
    expect(h.unit.convert).not.toHaveBeenCalled(); expect(h.posting.post).not.toHaveBeenCalled();
    expect(h.posting.finishNoMovement).toHaveBeenCalledTimes(1);
    expect(h.unit.applyMetadata).toHaveBeenCalledWith(expect.objectContaining({ targetVariantId: null }), [101, 102], now);
  });

  it.each(["reserved", "picked", "packed"] as const)("rejects transfer of source with %s ownership", async bucket => {
    const h = harness(); h.unit.lockQuantities.mockResolvedValueOnce([{ ...cell(101, 5), [bucket]: 1 }]);
    await expect(h.service.execute(command)).rejects.toMatchObject({ code: "CATALOG_STOCK_IN_USE" });
    expect(h.unit.convert).not.toHaveBeenCalled(); expect(h.unit.applyMetadata).not.toHaveBeenCalled();
  });

  it.each(["actor", "quantity", "source", "target"])("rejects invalid %s without committing", async invalid => {
    const h = harness();
    if (invalid === "quantity") h.unit.lockQuantities.mockResolvedValueOnce([cell(101, -1)]);
    if (invalid === "source") h.unit.loadSource.mockResolvedValueOnce({ source, sourceVariantIds: [101, 101] });
    await expect(h.service.execute({ ...command, ...(invalid === "actor" ? { actor: "" } : {}),
      ...(invalid === "target" ? { targetVariantId: 101 } : {}) })).rejects.toThrow();
    expect(h.events).not.toContain("commit"); expect(h.unit.convert).not.toHaveBeenCalled();
  });

  it("rolls back all sources without notifications when later metadata fails", async () => {
    const h = harness(); h.unit.applyMetadata.mockRejectedValueOnce(new Error("Injected metadata failure"));
    await expect(h.service.execute(command)).rejects.toThrow("Injected metadata failure");
    expect(h.unit.convert).toHaveBeenCalledTimes(2); expect(h.posting.post).toHaveBeenCalledTimes(1);
    expect(h.posting.finishOperation).not.toHaveBeenCalled(); expect(h.events).toContain("rollback");
    expect(h.events.some(event => event.startsWith("notify:"))).toBe(false);
  });

  it("cannot archive if conversion returns less than the locked source quantity", async () => {
    const h = harness(); h.unit.convert.mockResolvedValueOnce({ totalConverted: 4, conversions: [{ locationCode: "PICK", qty: 4 }] });
    await expect(h.service.execute(command)).rejects.toMatchObject({ code: "CATALOG_TRANSFER_INCOMPLETE" });
    expect(h.unit.applyMetadata).not.toHaveBeenCalled(); expect(h.posting.post).not.toHaveBeenCalled();
  });

  it("preserves legacy transaction behavior before opening without inventing a receipt", async () => {
    const h = harness(); h.unit.posting = null;
    await h.service.execute({ ...command, commandKey: undefined });
    expect(h.events).toContain("commit"); expect(h.posting.post).not.toHaveBeenCalled();
    expect(h.posting.finishOperation).not.toHaveBeenCalled(); expect(h.unit.convert.mock.calls[0][2]).toBeUndefined();
  });
});
