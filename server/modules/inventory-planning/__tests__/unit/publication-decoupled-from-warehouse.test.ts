import { beforeEach, describe, expect, it, vi } from "vitest";

// #64414: a channel listing that was not safe to publish failed a committed pick
// in B-12. Warehouse operations now only mark the product changed; the
// publication worker publishes and isolates broken listings.

const publishProduct = vi.fn();
vi.mock("../../infrastructure/inventory-availability-runtime-publication.repository", () => ({
  createTransactionScopedInventoryPublicationService: () => ({ publishProduct }),
}));

import { InventoryPublicationWorkCoordinator } from "../../application/inventory-publication-work-coordinator.service";
import { markPublicationProductsChanged } from "../../infrastructure/publication-product-change";
import { publishOperationalShipmentInsideTransaction } from "../../infrastructure/inventory-availability-dispatch-publication";
import { PostgresPublicationSelectionWork } from "../../infrastructure/publication-selection-work.repository";

const NOW = new Date("2026-10-19T16:00:00.000Z");

function coordinator(authority: "legacy" | "canonical", withMarker = true) {
  const markProductsChanged = vi.fn(async () => undefined);
  const orchestrator = {
    syncInventoryForProduct: vi.fn(async () => []),
    syncInventoryForChannelProduct: vi.fn(async () => []),
    syncInventoryForAllProducts: vi.fn(async () => []),
  };
  const work = new InventoryPublicationWorkCoordinator(
    { readAuthority: vi.fn(async () => authority) },
    { getGlobalSettings: vi.fn(async () => ({ globalEnabled: true }) as never), listEffectiveSyncStates: vi.fn(async () => []) },
    orchestrator,
    withMarker ? { markProductsChanged } : undefined,
  );
  return { work, markProductsChanged, orchestrator };
}

describe("recording a warehouse inventory change", () => {
  it("only marks the affected products under canonical authority and never publishes inline", async () => {
    const { work, markProductsChanged, orchestrator } = coordinator("canonical");
    await expect(work.recordInventoryChange([12, 7, 12], "inventory_change:pick"))
      .resolves.toEqual({ mode: "marked", productIds: [7, 12] });
    expect(markProductsChanged).toHaveBeenCalledExactlyOnceWith([7, 12]);
    expect(orchestrator.syncInventoryForProduct).not.toHaveBeenCalled();
  });

  it("keeps inline publication under legacy authority, which has no worker-owned planner", async () => {
    const { work, markProductsChanged, orchestrator } = coordinator("legacy");
    orchestrator.syncInventoryForChannelProduct.mockResolvedValue([]);
    const recorded = await work.recordInventoryChange([7], "inventory_change:pick");
    expect(recorded.mode).toBe("published");
    expect(markProductsChanged).not.toHaveBeenCalled();
  });

  it("is a no-op for a change that affects no product", async () => {
    const { work, markProductsChanged } = coordinator("canonical");
    await expect(work.recordInventoryChange([], "inventory_change:pick")).resolves.toEqual({ mode: "marked", productIds: [] });
    expect(markProductsChanged).not.toHaveBeenCalled();
  });
});

describe("marking products changed", () => {
  function pool() {
    const queries: Array<{ text: string; values?: unknown[] }> = [];
    const client = {
      query: vi.fn(async (text: string, values?: unknown[]) => { queries.push({ text, values }); return { rows: [] }; }),
      release: vi.fn(),
    };
    return { pool: { connect: vi.fn(async () => client) } as never, client, queries };
  }

  it("marks each product once, in id order, in one short bounded transaction", async () => {
    const { pool: p, client, queries } = pool();
    await markPublicationProductsChanged(p, [30, 4, 30]);
    expect(queries.map(query => query.text)).toEqual(["BEGIN", "SET LOCAL lock_timeout='5s'",
      "SELECT inventory.invalidate_publication_selection_product($1)",
      "SELECT inventory.invalidate_publication_selection_product($1)", "COMMIT"]);
    expect(queries.filter(query => query.values).map(query => query.values)).toEqual([[4], [30]]);
    expect(client.release).toHaveBeenCalledWith(false);
  });

  it("rolls back and rethrows when a mark fails, so the caller's outbox retries it", async () => {
    const { pool: p, client } = pool();
    client.query.mockImplementation(async (text: string) => {
      if (text.startsWith("SELECT inventory.invalidate")) throw Object.assign(new Error("lock timeout"), { code: "55P03" });
      return { rows: [] };
    });
    await expect(markPublicationProductsChanged(p, [4])).rejects.toMatchObject({ code: "55P03" });
    expect(client.query).toHaveBeenCalledWith("ROLLBACK");
  });

  it("rejects an invalid product id before touching the database", async () => {
    const { pool: p } = pool();
    await expect(markPublicationProductsChanged(p, [0])).rejects.toThrow();
    expect((p as unknown as { connect: ReturnType<typeof vi.fn> }).connect).not.toHaveBeenCalled();
  });
});

describe("shipment dispatch publication", () => {
  beforeEach(() => publishProduct.mockReset());
  const client = () => ({ query: vi.fn(async (text: string) => text.startsWith("SELECT product_id")
    ? { rows: [{ product_id: 10 }] } : { rows: [] }) });
  const request = { productVariantId: 101 } as never;

  it("isolates a broken listing so it cannot roll back shipment custody, and hands it to the work row", async () => {
    publishProduct.mockResolvedValue({ authority: "canonical", publication: { blockedTargets: [{ publicationTargetId: 34 }] } });
    const tx = client();
    await publishOperationalShipmentInsideTransaction({ client: tx, request } as never);
    expect(publishProduct).toHaveBeenCalledWith(expect.objectContaining({ productId: 10, blockedTargets: "isolate" }), expect.any(Function));
    expect(tx.query).toHaveBeenCalledWith("SELECT inventory.invalidate_publication_selection_product($1)", [10]);
  });

  it("does not mark the work row when every destination published", async () => {
    publishProduct.mockResolvedValue({ authority: "canonical", publication: { blockedTargets: [] } });
    const tx = client();
    await publishOperationalShipmentInsideTransaction({ client: tx, request } as never);
    expect(tx.query).not.toHaveBeenCalledWith("SELECT inventory.invalidate_publication_selection_product($1)", [10]);
  });
});

describe("publication worker recording an isolated destination", () => {
  function workPool() {
    const queries: Array<{ text: string; values?: unknown[] }> = [];
    const client = {
      query: vi.fn(async (text: string, values?: unknown[]) => {
        queries.push({ text, values });
        if (text.includes("pg_try_advisory_xact_lock_shared")) return { rows: [{ acquired: true }] };
        if (text.includes("FOR UPDATE SKIP LOCKED")) return { rows: [{ product_id: 10, revision: "3",
          acknowledged_revision: "2", attempt_count: 0, boundary_due: false }] };
        if (text.includes("SELECT product_id FROM inventory.publication_selection_work")) return { rows: [{ product_id: 10 }] };
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    return { pool: { connect: vi.fn(async () => client) } as never, queries };
  }

  it("commits the safe destinations, ACKs the revision and keeps the code for review instead of hot-retrying", async () => {
    const { pool: p, queries } = workPool();
    const work = new PostgresPublicationSelectionWork(p, () => NOW,
      async () => ({ blockedErrorCode: "CANONICAL_PUBLICATION_MAPPING_MISSING" }));
    await expect(work.processDue()).resolves.toEqual({ planned: 0, blocked: 1, skipped: 0 });
    const texts = queries.map(query => query.text);
    expect(texts.some(text => text.includes("ROLLBACK TO SAVEPOINT"))).toBe(false);
    expect(queries.find(query => query.text.includes("INSERT INTO inventory.publication_selection_attempts"))?.values)
      .toEqual([10, "3", "blocked", "CANONICAL_PUBLICATION_MAPPING_MISSING", NOW]);
    const ack = queries.find(query => query.text.includes("SET acknowledged_revision"));
    expect(ack?.values).toEqual([10, "3", NOW, "CANONICAL_PUBLICATION_MAPPING_MISSING"]);
    expect(texts).toContain("COMMIT");
  });

  it("still retries with backoff when planning throws and commits nothing", async () => {
    const { pool: p, queries } = workPool();
    const work = new PostgresPublicationSelectionWork(p, () => NOW,
      async () => { throw Object.assign(new Error("authority changed"), { code: "PUBLICATION_SELECTION_AUTHORITY_CHANGED" }); });
    await expect(work.processDue()).resolves.toEqual({ planned: 0, blocked: 1, skipped: 0 });
    const texts = queries.map(query => query.text);
    expect(texts).toContain("ROLLBACK TO SAVEPOINT selection_plan");
    expect(texts.some(text => text.includes("SET acknowledged_revision"))).toBe(false);
    expect(texts.some(text => text.includes("SET attempt_count=attempt_count+1"))).toBe(true);
  });

  it("clears the review code once every destination plans", async () => {
    const { pool: p, queries } = workPool();
    const work = new PostgresPublicationSelectionWork(p, () => NOW, async () => ({ blockedErrorCode: null }));
    await expect(work.processDue()).resolves.toEqual({ planned: 1, blocked: 0, skipped: 0 });
    expect(queries.find(query => query.text.includes("SET acknowledged_revision"))?.values).toEqual([10, "3", NOW, null]);
  });
});
