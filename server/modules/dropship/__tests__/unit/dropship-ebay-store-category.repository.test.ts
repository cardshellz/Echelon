import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { PgDropshipEbayStoreCategoryRepository } from "../../infrastructure/dropship-ebay-store-category.repository";

const NOW = new Date("2026-08-29T12:00:00.000Z");

// The per-size shelf writer (replaceAssignment) was deleted in Listing settings PR 12;
// the shelves read (GET /api/dropship/ebay/store-categories/:id) still lists the rows.
describe("PgDropshipEbayStoreCategoryRepository", () => {
  it("lists one vendor's store's assignments in size order, trimmed, and releases its client", async () => {
    const client = new ScriptedClient([{
      product_variant_id: 501,
      store_category_ids: [" 22 ", "23"],
      store_category_names: ["Supplies:Toploaders ", "Supplies:Sleeves"],
      updated_at: NOW,
    }]);
    const repository = new PgDropshipEbayStoreCategoryRepository(poolFor(client));

    await expect(repository.listAssignments({ vendorId: 10, storeConnectionId: 44 })).resolves.toEqual([{
      productVariantId: 501,
      storeCategoryIds: ["22", "23"],
      storeCategoryNames: ["Supplies:Toploaders", "Supplies:Sleeves"],
      updatedAt: NOW,
    }]);
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0].sql).toContain("WHERE vendor_id = $1 AND store_connection_id = $2");
    expect(client.calls[0].sql).toContain("ORDER BY product_variant_id ASC");
    expect(client.calls[0].sql).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/);
    expect(client.calls[0].values).toEqual([10, 44]);
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("answers an empty size list with no rows and no connection", async () => {
    const client = new ScriptedClient([]);
    const pool = poolFor(client);
    const repository = new PgDropshipEbayStoreCategoryRepository(pool);

    await expect(repository.listAssignments({ vendorId: 10, storeConnectionId: 44, productVariantIds: [] })).resolves.toEqual([]);
    expect(pool.connect).not.toHaveBeenCalled();
  });
});

class ScriptedClient {
  calls: Array<{ sql: string; values: unknown[] | undefined }> = [];
  release = vi.fn();

  constructor(private readonly rows: unknown[]) {}

  async query<T>(query: string, values?: unknown[]): Promise<{ rows: T[] }> {
    this.calls.push({ sql: query.trim(), values });
    return { rows: this.rows as T[] };
  }
}

function poolFor(client: ScriptedClient): Pool {
  return {
    connect: vi.fn(async () => client),
  } as unknown as Pool;
}
