import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import type { ReplaceDropshipEbayStoreCategoryAssignmentRepositoryInput } from "../../application/dropship-ebay-store-category-service";
import { PgDropshipEbayStoreCategoryRepository } from "../../infrastructure/dropship-ebay-store-category.repository";

const NOW = new Date("2026-08-29T12:00:00.000Z");

describe("PgDropshipEbayStoreCategoryRepository", () => {
  it("locks and revalidates the member-owned connected eBay store before an audited upsert", async () => {
    const client = new ScriptedClient();
    const repository = new PgDropshipEbayStoreCategoryRepository(poolFor(client));

    const result = await repository.replaceAssignment(input());

    expect(result).toEqual({
      assignment: {
        productVariantId: 501,
        storeCategoryIds: ["22"],
        storeCategoryNames: ["Supplies:Toploaders"],
        updatedAt: NOW,
      },
      revisionId: 91,
      idempotentReplay: false,
    });
    expect(client.sql.some((query) => query.includes("FROM dropship.dropship_store_connections")
      && query.includes("FOR SHARE"))).toBe(true);
    expect(client.sql.some((query) => query.includes("dropship_audit_events"))).toBe(true);
    expect(client.sql.at(-1)).toBe("COMMIT");
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("returns the immutable original response for a matching idempotency replay", async () => {
    const client = new ScriptedClient();
    client.existingRevision = {
      id: 90,
      request_hash: "request-hash",
      store_category_ids: ["22"],
      store_category_names: ["Supplies:Toploaders"],
      created_at: NOW,
    };
    const repository = new PgDropshipEbayStoreCategoryRepository(poolFor(client));

    await expect(repository.replaceAssignment(input())).resolves.toMatchObject({
      revisionId: 90,
      idempotentReplay: true,
      assignment: {
        productVariantId: 501,
        storeCategoryIds: ["22"],
      },
    });
    expect(client.sql).not.toContainEqual(expect.stringContaining("INSERT INTO dropship.dropship_ebay_store_category_assignments"));
    expect(client.sql.at(-1)).toBe("COMMIT");
  });

  it("rolls back if the store disconnects between live category validation and persistence", async () => {
    const client = new ScriptedClient();
    client.storeStatus = "needs_reauth";
    const repository = new PgDropshipEbayStoreCategoryRepository(poolFor(client));

    await expect(repository.replaceAssignment(input())).rejects.toMatchObject({
      code: "DROPSHIP_EBAY_STORE_CONNECTION_BLOCKED",
    });
    expect(client.sql.at(-1)).toBe("ROLLBACK");
    expect(client.sql).not.toContainEqual(expect.stringContaining("INSERT INTO"));
  });

  it("rejects reuse of an idempotency key with a different request hash", async () => {
    const client = new ScriptedClient();
    client.existingRevision = {
      id: 90,
      request_hash: "different-hash",
      store_category_ids: ["22"],
      store_category_names: ["Supplies:Toploaders"],
      created_at: NOW,
    };
    const repository = new PgDropshipEbayStoreCategoryRepository(poolFor(client));

    await expect(repository.replaceAssignment(input())).rejects.toMatchObject({
      code: "DROPSHIP_IDEMPOTENCY_CONFLICT",
    });
    expect(client.sql.at(-1)).toBe("ROLLBACK");
  });
});

class ScriptedClient {
  sql: string[] = [];
  storeStatus = "connected";
  existingRevision: Record<string, unknown> | null = null;
  release = vi.fn();

  async query<T>(query: string): Promise<{ rows: T[] }> {
    const sql = query.trim();
    this.sql.push(sql);
    if (sql.includes("FROM dropship.dropship_store_connections")) {
      return rows<T>([{ platform: "ebay", status: this.storeStatus }]);
    }
    if (sql.includes("FROM dropship.dropship_ebay_store_category_assignment_revisions")) {
      return rows<T>(this.existingRevision ? [this.existingRevision] : []);
    }
    if (sql.includes("SELECT id FROM catalog.product_variants")) {
      return rows<T>([{ id: 501 }]);
    }
    if (sql.includes("FROM dropship.dropship_ebay_store_category_assignments")
      && sql.includes("FOR UPDATE")) {
      return rows<T>([]);
    }
    if (sql.includes("INSERT INTO dropship.dropship_ebay_store_category_assignment_revisions")) {
      return rows<T>([{ id: 91 }]);
    }
    if (sql.includes("INSERT INTO dropship.dropship_ebay_store_category_assignments")) {
      return rows<T>([{
        product_variant_id: 501,
        store_category_ids: ["22"],
        store_category_names: ["Supplies:Toploaders"],
        updated_at: NOW,
      }]);
    }
    return rows<T>([]);
  }
}

function rows<T>(values: unknown[]): { rows: T[] } {
  return { rows: values as T[] };
}

function poolFor(client: ScriptedClient): Pool {
  return {
    connect: vi.fn(async () => client),
  } as unknown as Pool;
}

function input(): ReplaceDropshipEbayStoreCategoryAssignmentRepositoryInput {
  return {
    vendorId: 10,
    storeConnectionId: 44,
    productVariantId: 501,
    storeCategoryIds: ["22"],
    storeCategoryNames: ["Supplies:Toploaders"],
    idempotencyKey: "store-category-repository-001",
    requestHash: "request-hash",
    actor: { actorType: "vendor", actorId: "member-1" },
    now: NOW,
  };
}
