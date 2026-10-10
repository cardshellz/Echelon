import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { PgDropshipPricingRulesRepository } from "../../infrastructure/dropship-pricing-rules.repository";
import type { StoredPricingReview } from "../../application/dropship-pricing-rules-service";

vi.mock("../../../../db", () => ({ db: {}, pool: {} }));

const NOW = new Date("2026-10-10T12:00:00.000Z");
const STORE_REVIEW_ID = "00000000-0000-4000-8000-000000000001";
const PRODUCT_REVIEW_ID = "00000000-0000-4000-8000-000000000002";

const storeReview: StoredPricingReview = {
  id: STORE_REVIEW_ID,
  input: {
    expectedRevisionId: null,
    profile: { defaultRecipe: { basis: "product_cost", markupBps: 2_500, flatCents: 0, rounding: "cent" }, groups: [] },
    releaseFixedOverrides: false,
  },
  rows: [],
  hash: "a".repeat(64),
  createdAt: NOW,
};

interface StoredRow {
  id: string; vendor_id: number; store_connection_id: number; kind: string;
  input: unknown; rows: unknown; review_hash: string; created_at: Date;
}

/**
 * Answers the owner check, and answers the review SELECT the way PostgreSQL
 * would: by id, vendor and store, and by kind only when the SQL asks for it.
 */
class ScriptedClient {
  sql: string[] = [];
  params: unknown[][] = [];
  release = vi.fn();
  stored: StoredRow[] = [];

  async query<T>(text: string, params: unknown[] = []): Promise<{ rows: T[] }> {
    const sql = text.replace(/\s+/g, " ").trim();
    this.sql.push(sql);
    this.params.push(params);
    if (sql.includes("FROM dropship.dropship_vendors v")) return rows<T>([{ vendor_id: 10 }]);
    if (sql.startsWith("SELECT id, input, rows, review_hash, created_at FROM dropship.dropship_pricing_reviews")) {
      const storeDefaultOnly = sql.includes("AND kind = 'store_default'");
      return rows<T>(this.stored
        .filter((row) => row.id === params[0] && row.vendor_id === params[1] && row.store_connection_id === params[2])
        .filter((row) => !storeDefaultOnly || row.kind === "store_default")
        .map(({ id, input, rows: reviewRows, review_hash, created_at }) => ({ id, input, rows: reviewRows, review_hash, created_at })));
    }
    return rows<T>([]);
  }
}

function rows<T>(values: unknown[]): { rows: T[] } {
  return { rows: values as T[] };
}

function repositoryFor(client: ScriptedClient): PgDropshipPricingRulesRepository {
  return new PgDropshipPricingRulesRepository({ connect: vi.fn(async () => client) } as unknown as Pool);
}

function storedRow(id: string, kind: string, input: unknown): StoredRow {
  return { id, vendor_id: 10, store_connection_id: 44, kind, input, rows: [], review_hash: "a".repeat(64), created_at: NOW };
}

describe("PgDropshipPricingRulesRepository store default review loader (migration 0738)", () => {
  it("asks only for store default reviews, with today's three parameters, inside today's transaction", async () => {
    const client = new ScriptedClient();
    client.stored.push(storedRow(STORE_REVIEW_ID, "store_default", storeReview.input));

    const loaded = await repositoryFor(client).execute("member-1", 44, (tx) => tx.loadReview(STORE_REVIEW_ID));

    expect(loaded).toEqual(storeReview);
    const loadIndex = client.sql.findIndex((sql) => sql.includes("FROM dropship.dropship_pricing_reviews"));
    expect(client.sql[loadIndex]).toBe(
      "SELECT id, input, rows, review_hash, created_at FROM dropship.dropship_pricing_reviews "
      + "WHERE id = $1 AND vendor_id = $2 AND store_connection_id = $3 AND kind = 'store_default'",
    );
    expect(client.params[loadIndex]).toEqual([STORE_REVIEW_ID, 10, 44]);
    expect(client.sql[0]).toBe("BEGIN ISOLATION LEVEL SERIALIZABLE");
    expect(client.sql[1]).toContain("hashtext('dropship_listing_push_job')");
    expect(client.sql[2]).toContain("FOR SHARE OF v, sc");
    expect(client.sql.at(-1)).toBe("COMMIT");
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("reads a review of another kind as not found, never as a store review that fails its contract", async () => {
    const client = new ScriptedClient();
    // A product review's input is not a store profile input; parsing it as one would throw.
    client.stored.push(storedRow(PRODUCT_REVIEW_ID, "product_prices", { products: [7], recipe: storeReview.input.profile.defaultRecipe }));

    await expect(repositoryFor(client).execute("member-1", 44, (tx) => tx.loadReview(PRODUCT_REVIEW_ID))).resolves.toBeNull();
    expect(client.sql.at(-1)).toBe("COMMIT");
  });

  it("still refuses a store default review whose stored input breaks its contract", async () => {
    const client = new ScriptedClient();
    client.stored.push(storedRow(STORE_REVIEW_ID, "store_default", { profile: "broken" }));

    await expect(repositoryFor(client).execute("member-1", 44, (tx) => tx.loadReview(STORE_REVIEW_ID)))
      .rejects.toThrow("Persisted pricing review failed its contract.");
    expect(client.sql.at(-1)).toBe("ROLLBACK");
  });

  it("stores a review without naming a kind, as code deployed before 0738 does, so the column default records it", async () => {
    const client = new ScriptedClient();

    await repositoryFor(client).execute("member-1", 44, (tx) => tx.storeReview(storeReview));

    const insertIndex = client.sql.findIndex((sql) => sql.startsWith("INSERT INTO dropship.dropship_pricing_reviews"));
    expect(client.sql[insertIndex]).toBe(
      "INSERT INTO dropship.dropship_pricing_reviews "
      + "(id, vendor_id, store_connection_id, input, rows, review_hash, actor_id, created_at) VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7,$8)",
    );
    expect(client.params[insertIndex]).toEqual([
      STORE_REVIEW_ID, 10, 44, JSON.stringify(storeReview.input), JSON.stringify(storeReview.rows), storeReview.hash, "member-1", NOW,
    ]);
  });
});
