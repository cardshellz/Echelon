import type { PoolClient } from "pg";
import { describe, expect, it } from "vitest";
import { listingSettingChildKeyPrefix } from "../../domain/listing-setting-values";
import { DropshipError } from "../../domain/errors";
import {
  CLEAR_CONTENT_LEFTOVERS_SQL,
  CLEAR_POLICY_LEFTOVERS_SQL,
  CLEAR_SHELF_LEFTOVERS_SQL,
  POLICY_FEATURE_LOCK_SQL,
  SHELF_FEATURE_LOCK_SQL,
  clearSizeLeftoversWithClient,
} from "../../infrastructure/dropship-listing-setting-leftovers.repository";
import type { ListingSettingWriteScope } from "../../infrastructure/dropship-listing-setting-shared.repository";

/**
 * The per-size leftover clean-ups' statement script (plan PR 9, P17, 6.6):
 * feature locks policy then shelf, one set-based statement per kind, every
 * statement scoped to the vendor and the store, ids and counts only. The SQL
 * itself runs in the PostgreSQL suite.
 */

const NOW = new Date("2026-10-12T09:00:00.000Z");
const KEY = "product-settings:7f9c2ba4-e88f-4a5e-9d1b-1c2d3e4f5a6b";
const HASH = "a".repeat(64);
const SCOPE: ListingSettingWriteScope = { vendorId: 10, storeConnectionId: 22, actor: { actorType: "vendor", actorId: "member-1" }, requestKey: KEY };
const ALL_FIELDS = ["shippingPolicy", "returnPolicy", "paymentPolicy", "storeShelf", "mainText"] as const;

class ScriptedClient {
  sql: string[] = [];
  params: unknown[][] = [];
  /** Each kind's answer: the sizes it cleared, and how many rows it wrote of each kind (all equal unless a test breaks one). */
  answers: Record<"policy" | "shelf" | "content", { size_ids: unknown; revisions: unknown; current_rows: unknown; audits: unknown }> = {
    policy: { size_ids: [101, 103], revisions: 2, current_rows: 2, audits: 2 },
    shelf: { size_ids: [102], revisions: 1, current_rows: 1, audits: 1 },
    content: { size_ids: [101], revisions: 1, current_rows: 1, audits: 1 },
  };

  async query(text: string, params: unknown[] = []) {
    this.sql.push(text);
    this.params.push(params);
    if (text === CLEAR_POLICY_LEFTOVERS_SQL) return { rows: [this.answers.policy] };
    if (text === CLEAR_SHELF_LEFTOVERS_SQL) return { rows: [this.answers.shelf] };
    if (text === CLEAR_CONTENT_LEFTOVERS_SQL) return { rows: [this.answers.content] };
    return { rows: [] };
  }
}

function setup() {
  const client = new ScriptedClient();
  return { client, query: client as unknown as Pick<PoolClient, "query"> };
}

async function invariant(promise: Promise<unknown>): Promise<DropshipError> {
  const error = await promise.then(() => null, (reason: unknown) => reason);
  expect(error).toBeInstanceOf(DropshipError);
  expect((error as DropshipError).code).toBe("DROPSHIP_LISTING_SETTINGS_INVARIANT_FAILED");
  return error as DropshipError;
}

describe("clearSizeLeftoversWithClient (plan PR 9, P17, 6.6)", () => {
  it("takes the policy then the shelf feature lock, then one statement per kind, and counts each size once", async () => {
    const { client, query } = setup();

    const result = await clearSizeLeftoversWithClient(query, SCOPE, { productIds: [8, 7, 8], fields: ALL_FIELDS, requestHash: HASH, now: NOW });

    expect(client.sql).toEqual([POLICY_FEATURE_LOCK_SQL, SHELF_FEATURE_LOCK_SQL, CLEAR_POLICY_LEFTOVERS_SQL, CLEAR_SHELF_LEFTOVERS_SQL,
      CLEAR_CONTENT_LEFTOVERS_SQL]);
    expect(POLICY_FEATURE_LOCK_SQL).toBe("SELECT pg_advisory_xact_lock(hashtext('dropship_ebay_listing_policy_override'), $1::integer)");
    expect(SHELF_FEATURE_LOCK_SQL).toBe("SELECT pg_advisory_xact_lock(hashtext('dropship_ebay_store_category_assignment'), $1::integer)");
    expect(client.params[0]).toEqual([22]);
    expect(client.params[1]).toEqual([22]);
    expect(result).toEqual({ clearedSizeCount: 3, byKind: { policy: 2, shelf: 1, content: 1 }, productVariantIds: [101, 102, 103] });
  });

  it("passes each kind its vendor, store, ascending products, child key prefix, parent hash, actor and clock", async () => {
    const { client, query } = setup();
    await clearSizeLeftoversWithClient(query, SCOPE, { productIds: [8, 7], fields: ALL_FIELDS, requestHash: HASH, now: NOW });

    expect(client.params[2]).toEqual([10, 22, [7, 8], true, true, true, listingSettingChildKeyPrefix(KEY, "policy"), HASH, "vendor",
      "member-1", NOW, KEY, JSON.stringify(["shippingPolicy", "returnPolicy", "paymentPolicy"])]);
    expect(client.params[3]).toEqual([10, 22, [7, 8], listingSettingChildKeyPrefix(KEY, "shelf"), HASH, "vendor", "member-1", NOW, KEY]);
    expect(client.params[4]).toEqual([10, 22, [7, 8], listingSettingChildKeyPrefix(KEY, "content"), HASH, "member-1", NOW, "vendor", KEY]);
  });

  it.each([
    ["one policy", ["returnPolicy"], [POLICY_FEATURE_LOCK_SQL, CLEAR_POLICY_LEFTOVERS_SQL]],
    ["the shelf", ["storeShelf"], [SHELF_FEATURE_LOCK_SQL, CLEAR_SHELF_LEFTOVERS_SQL]],
    ["the main text (its writer is held off by the store lock, so no feature lock)", ["mainText"], [CLEAR_CONTENT_LEFTOVERS_SQL]],
    ["a policy and the main text", ["mainText", "paymentPolicy"], [POLICY_FEATURE_LOCK_SQL, CLEAR_POLICY_LEFTOVERS_SQL, CLEAR_CONTENT_LEFTOVERS_SQL]],
  ] as const)("clears only %s", async (_label, fields, script) => {
    const { client, query } = setup();
    await clearSizeLeftoversWithClient(query, SCOPE, { productIds: [7], fields, requestHash: HASH, now: NOW });
    expect(client.sql).toEqual(script);
  });

  it("clears only the policy fields named, keeping the others on the row", async () => {
    const { client, query } = setup();
    await clearSizeLeftoversWithClient(query, SCOPE, { productIds: [7], fields: ["returnPolicy"], requestHash: HASH, now: NOW });
    expect(client.params[1].slice(3, 6)).toEqual([false, true, false]);
    expect(client.params[1][12]).toBe(JSON.stringify(["returnPolicy"]));
  });

  it("scopes every statement to the vendor and the store, joins the products' sizes, and locks rows in size order", () => {
    for (const [sql, tables] of [
      [CLEAR_POLICY_LEFTOVERS_SQL, ["o"]],
      [CLEAR_SHELF_LEFTOVERS_SQL, ["a"]],
      [CLEAR_CONTENT_LEFTOVERS_SQL, ["s"]],
    ] as const) {
      expect(sql).toMatch(/JOIN catalog\.product_variants pv ON pv\.id = \w\.product_variant_id AND pv\.product_id = ANY\(\$3::int\[\]\)/);
      for (const alias of tables) {
        expect(sql).toContain(`WHERE ${alias}.vendor_id = $1 AND ${alias}.store_connection_id = $2`);
        expect(sql).toMatch(new RegExp(`ORDER BY ${alias}\\.product_variant_id\\s+FOR UPDATE OF ${alias}\\b`));
      }
      // Every write is the vendor's and the store's: each revision and audit row carries $1, $2, and each current-row change filters them.
      expect(sql.match(/SELECT \$1::integer, \$2::integer,/g)).toHaveLength(2);
      for (const change of sql.match(/(?:DELETE FROM|UPDATE) dropship\.[a-z_]+ \w[\s\S]*?RETURNING/g) ?? []) {
        expect(change).toMatch(/\w\.vendor_id = \$1 AND \w\.store_connection_id = \$2/);
      }
      // Ids and counts only come back; no text column is selected by the outer query.
      expect(sql.slice(sql.lastIndexOf("\nSELECT"))).toMatch(/^\nSELECT \(SELECT COALESCE\(array_agg\(product_variant_id ORDER BY product_variant_id\)/);
      expect(sql).not.toMatch(/\bLIKE\b/);
    }
  });

  it("keeps the old writers' audit shapes, with the request key, and names a main text by its bytes and digest only", () => {
    expect(CLEAR_POLICY_LEFTOVERS_SQL).toMatch(/'dropship_ebay_listing_policy_override', t\.product_variant_id::text,\s+'ebay_listing_policy_override_replaced'/);
    expect(CLEAR_POLICY_LEFTOVERS_SQL).toContain("'requestKey', $12::text, 'cleared', $13::jsonb");
    expect(CLEAR_SHELF_LEFTOVERS_SQL).toMatch(/'dropship_ebay_store_category_assignment', t\.product_variant_id::text,\s+'ebay_store_category_assignment_replaced'/);
    expect(CLEAR_SHELF_LEFTOVERS_SQL).toContain("'storeCategoryIds', t.before_ids, 'storeCategoryNames', t.before_names");
    expect(CLEAR_CONTENT_LEFTOVERS_SQL).toContain("'dropship_listing_content_setting', t.product_variant_id::text, 'listing_content_saved'");
    expect(CLEAR_CONTENT_LEFTOVERS_SQL).toContain("'bytes', octet_length(convert_to(t.custom_text, 'UTF8'))");
    expect(CLEAR_CONTENT_LEFTOVERS_SQL).toContain("'sha256', encode(sha256(convert_to(t.custom_text, 'UTF8')), 'hex')");
    // The text itself goes nowhere but those two functions.
    expect(CLEAR_CONTENT_LEFTOVERS_SQL.match(/custom_text/g)).toHaveLength(5);
    // A reset is a successor revision with no text (the coherence trigger), never a delete.
    expect(CLEAR_CONTENT_LEFTOVERS_SQL).toContain("SELECT $1::integer, $2::integer, t.product_variant_id, t.revision_id, NULL, t.catalog_hash, t.profile_revision_id");
    expect(CLEAR_CONTENT_LEFTOVERS_SQL).not.toMatch(/DELETE FROM/);
  });

  it("refuses a statement that wrote a different number of rows than it cleared", async () => {
    for (const broken of [{ revisions: 1 }, { current_rows: 0 }, { audits: 3 }, { size_ids: [101, 101] }, { size_ids: "101" }]) {
      const { client, query } = setup();
      client.answers.policy = { ...client.answers.policy, ...broken };
      const error = await invariant(clearSizeLeftoversWithClient(query, SCOPE, { productIds: [7], fields: ["shippingPolicy"], requestHash: HASH, now: NOW }));
      expect(error.context).toMatchObject({ kind: "policy", classification: "fatal" });
    }
  });

  it("names at most 100 cleared sizes, with the full count", async () => {
    const { client, query } = setup();
    const ids = Array.from({ length: 150 }, (_, index) => 1_000 + index);
    client.answers.content = { size_ids: ids, revisions: 150, current_rows: 150, audits: 150 };
    const result = await clearSizeLeftoversWithClient(query, SCOPE, { productIds: [7], fields: ["mainText"], requestHash: HASH, now: NOW });
    expect(result.clearedSizeCount).toBe(150);
    expect(result.productVariantIds).toEqual(ids.slice(0, 100));
  });

  it.each([
    ["no fields", { fields: [] }],
    ["an unknown field", { fields: ["price"] }],
    ["no products", { productIds: [] }],
    ["a product id of 0", { productIds: [0] }],
    ["a bad request hash", { requestHash: "A".repeat(64) }],
    ["an invalid clock", { now: new Date(Number.NaN) }],
  ])("refuses %s before any statement", async (_label, fields) => {
    const { client, query } = setup();
    await invariant(clearSizeLeftoversWithClient(query, SCOPE,
      { productIds: [7], fields: ["mainText"], requestHash: HASH, now: NOW, ...fields } as Parameters<typeof clearSizeLeftoversWithClient>[2]));
    expect(client.sql).toEqual([]);
  });

  it("refuses a scope outside its contract before any statement", async () => {
    const { client, query } = setup();
    await invariant(clearSizeLeftoversWithClient(query, { ...SCOPE, requestKey: "short" },
      { productIds: [7], fields: ["mainText"], requestHash: HASH, now: NOW }));
    expect(client.sql).toEqual([]);
  });
});
