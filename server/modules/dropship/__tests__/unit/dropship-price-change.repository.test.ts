import type { PoolClient } from "pg";
import { describe, expect, it } from "vitest";
import {
  storedInputSchemaFor,
  type PriceChangeRow,
  type StoredCategoryPriceInput,
  type StoredProductPricesInput,
} from "../../../../../shared/dropship/listing-setting-writes";
import type { StoredPriceChangeReview } from "../../application/dropship-listing-setting-writes";
import { DropshipError } from "../../domain/errors";
import {
  findPriceChangeApplyByReviewWithClient,
  insertPriceChangeApplyRequestWithClient,
  insertPriceChangeReviewWithClient,
  loadPriceChangeReviewWithClient,
  readPriceChangeReviewForMember,
} from "../../infrastructure/dropship-price-change.repository";

/**
 * W7's own SQL (plan PR 9, 9.1): the review insert naming its kind, the
 * kind-filtered load, the owner-scoped page read, the apply-only ledger
 * insert and the by-review read, each scoped and checked before any SQL.
 * Their PostgreSQL behavior is pinned by the writes suite (cases 1-4).
 */

const NOW = new Date("2026-10-13T09:00:00.000Z");
const VENDOR = 10;
const STORE = 22;
const MEMBER = "member-1";
const REVIEW = "7d1b5e0a-3c4f-4a8b-9e2d-0f1a2b3c4d5e";
const KEY = "price-changes:4a2f9c1e-8b7d-4e6f-a5c3-2d1e0f9a8b7c";
const HASH = "a".repeat(64);
const REVIEW_HASH = "b".repeat(64);
const RECIPE = { basis: "catalog_retail", markupBps: 2_000, flatCents: 0, rounding: "up_99" } as const;
const TARGET = { vendorId: VENDOR, storeConnectionId: STORE };
const ACTOR = { actorType: "vendor" as const, actorId: MEMBER };

const normalize = (sql: string) => sql.replace(/\s+/g, " ").trim();
const KINDS = "r.kind IN ('product_prices', 'category_price')";

class ScriptedClient {
  sql: string[] = [];
  params: unknown[][] = [];
  constructor(private readonly answer: (sql: string) => unknown[] = () => []) {}

  async query<T>(text: string, params: unknown[] = []): Promise<{ rows: T[] }> {
    const sql = normalize(text);
    this.sql.push(sql);
    this.params.push(params);
    return { rows: this.answer(sql) as T[] };
  }
}

function asClient(client: ScriptedClient): Pick<PoolClient, "query"> {
  return client as unknown as Pick<PoolClient, "query">;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function row(productVariantId: number, productId = 7, fields: Partial<PriceChangeRow> = {}): PriceChangeRow {
  return {
    productVariantId, title: "Toploader 3x4 - Pack of 25", sku: "TL-25", previousPriceCents: 1_199, priceCents: 1_040,
    productCostCents: 800, ruleName: "Product price", preserved: false, issues: [], settingRevisionId: null,
    evidenceHash: "e".repeat(64), productId, released: false, refusal: null, ...fields,
  };
}

const PRODUCTS_INPUT: StoredProductPricesInput = { productIds: [7, 8], price: RECIPE, releaseExactPrices: true };
const CATEGORY_INPUT: StoredCategoryPriceInput = {
  categoryId: 3, expectedRevisionId: null,
  patch: {
    price: RECIPE,
    ebayCategory: { categoryId: "183454", categoryName: "Vendor-visible eBay name", path: ["Collectibles", "Toploaders"] },
    shippingPolicy: { id: "ship-a", name: "Ships in one day" },
  },
  clear: { fields: ["price", "shippingPolicy"], products: [{ productId: 7, expectedRevisionId: 30 }, { productId: 8, expectedRevisionId: null }] },
};

function productsReview(fields: Partial<StoredPriceChangeReview> = {}): StoredPriceChangeReview {
  return { id: REVIEW, kind: "product_prices", input: PRODUCTS_INPUT, rows: [row(101), row(102), row(103, 8)],
    reviewHash: REVIEW_HASH, createdAt: NOW, ...fields } as StoredPriceChangeReview;
}
function categoryReview(fields: Partial<StoredPriceChangeReview> = {}): StoredPriceChangeReview {
  return { id: REVIEW, kind: "category_price", input: CATEGORY_INPUT, rows: [row(101, 7, { refusal: "DROPSHIP_LISTING_PRICE_WOULD_BE_LOST" })],
    reviewHash: REVIEW_HASH, createdAt: NOW, ...fields } as StoredPriceChangeReview;
}

/** octet_length(rows::text) as the apply's load reads it (any value in contract; PostgreSQL's own is pinned by the writes suite). */
const ROWS_BYTES = 2_345;
/** A stored row as PostgreSQL returns it: jsonb parsed back, its object keys in another order (jsonb keeps none). */
function storedRow(review: StoredPriceChangeReview): Record<string, unknown> {
  return {
    id: review.id, kind: review.kind, input: reversedKeys(JSON.parse(JSON.stringify(review.input))),
    rows: reversedKeys(JSON.parse(JSON.stringify(review.rows))), review_hash: review.reviewHash, created_at: review.createdAt,
    rows_bytes: ROWS_BYTES,
  };
}
function reversedKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reversedKeys);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).reverse().map(([key, child]) => [key, reversedKeys(child)]));
}

async function caught(promise: Promise<unknown>): Promise<DropshipError> {
  const error = await promise.then(() => null, (reason: unknown) => reason);
  expect(error).toBeInstanceOf(DropshipError);
  return error as DropshipError;
}
async function expectInvariant(promise: Promise<unknown>): Promise<DropshipError> {
  const error = await caught(promise);
  expect(error).toMatchObject({ code: "DROPSHIP_LISTING_SETTINGS_INVARIANT_FAILED", context: { retryable: false, classification: "fatal" } });
  return error;
}

describe("insertPriceChangeReviewWithClient (plan 9.5 step 7)", () => {
  it("names the kind, stores the parsed input and rows as JSON, the member as the actor, the injected time; answers the rows' size", async () => {
    const client = new ScriptedClient(() => [{ rows_bytes: ROWS_BYTES }]);
    const review = deepFreeze(categoryReview());

    const stored = await insertPriceChangeReviewWithClient(asClient(client), { ...TARGET, actorId: MEMBER }, review);

    // The rows' size as PostgreSQL stores them: the measure the apply's load reads (plan 9.7's memory stop rule).
    expect(stored).toEqual({ rowsBytes: ROWS_BYTES });
    expect(client.sql).toEqual([normalize(`INSERT INTO dropship.dropship_pricing_reviews
      (id, vendor_id, store_connection_id, kind, input, rows, review_hash, actor_id, created_at)
      VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, $9)
      RETURNING octet_length(rows::text) AS rows_bytes`)]);
    const [id, vendor, store, kind, input, rows, hash, actor, createdAt] = client.params[0];
    expect([id, vendor, store, kind, hash, actor, createdAt]).toEqual([REVIEW, VENDOR, STORE, "category_price", REVIEW_HASH, MEMBER, NOW]);
    // Exactly the stored contract's output: the hash at review is computed over the same values.
    expect(input).toBe(JSON.stringify(storedInputSchemaFor("category_price").parse(CATEGORY_INPUT)));
    expect(JSON.parse(String(rows))).toEqual(review.rows);
  });

  it.each<[string, Partial<StoredPriceChangeReview>, Record<string, unknown>]>([
    ["an id the server did not issue (upper case)", { id: REVIEW.toUpperCase() }, { column: "id" }],
    ["an id that is not a uuid", { id: "review-1" }, { column: "id" }],
    ["W1's store default kind", { kind: "store_default" as "product_prices" }, { column: "kind" }],
    ["a hash that is not 64 hex characters", { reviewHash: "B".repeat(64) }, { column: "review_hash" }],
    ["an invalid time", { createdAt: new Date("not a time") }, { column: "created_at" }],
    ["products out of order", { input: { ...PRODUCTS_INPUT, productIds: [8, 7] } }, { column: "input" }],
    ["a product twice", { input: { ...PRODUCTS_INPUT, productIds: [7, 7] } }, { column: "input" }],
    ["neither a price nor releases", { input: { productIds: [7] } }, { column: "input" }],
    ["the other kind's input", { input: CATEGORY_INPUT as unknown as StoredProductPricesInput }, { column: "input" }],
    ["rows out of order", { rows: [row(102), row(101)] }, { column: "rows" }],
    ["a row with a key of its own", { rows: [{ ...row(101), secret: "x" } as PriceChangeRow] }, { column: "rows" }],
    ["a row with a refusal W7 cannot raise", { rows: [row(101, 7, { refusal: "DROPSHIP_LISTING_PRICE_OUTSIDE_LIMIT" as "DROPSHIP_LISTING_PRICE_WOULD_BE_LOST" })] },
      { column: "rows" }],
    ["10,001 rows", { rows: Array.from({ length: 10_001 }, (_, index) => row(index + 1)) }, { column: "rows" }],
  ])("refuses %s before any SQL", async (_label, fields, context) => {
    const client = new ScriptedClient();
    const error = await expectInvariant(insertPriceChangeReviewWithClient(asClient(client), { ...TARGET, actorId: MEMBER },
      productsReview(fields)));
    expect(error.context).toMatchObject(context);
    expect(client.sql).toEqual([]);
  });

  it("refuses a category input that breaks its contract naming paths and codes, never an eBay name", async () => {
    const client = new ScriptedClient();
    const input = { ...CATEGORY_INPUT, clear: { ...CATEGORY_INPUT.clear!, fields: ["shippingPolicy", "price"] } } as StoredCategoryPriceInput;
    const error = await expectInvariant(insertPriceChangeReviewWithClient(asClient(client), { ...TARGET, actorId: MEMBER },
      categoryReview({ input })));
    expect(error.context).toMatchObject({ column: "input", issues: [{ path: "clear.fields", code: "custom" }] });
    expect(JSON.stringify(error.context)).not.toContain("Vendor-visible eBay name");
    // A cleared field the category does not set, and a category without its price, are refused too.
    for (const broken of [
      { ...CATEGORY_INPUT, clear: { fields: ["returnPolicy"], products: [{ productId: 7, expectedRevisionId: null }] } },
      { ...CATEGORY_INPUT, patch: { shippingPolicy: CATEGORY_INPUT.patch.shippingPolicy } },
    ]) {
      await expectInvariant(insertPriceChangeReviewWithClient(asClient(client), { ...TARGET, actorId: MEMBER },
        categoryReview({ input: broken as StoredCategoryPriceInput })));
    }
    expect(client.sql).toEqual([]);
  });

  it.each([["no row", []], ["a size that is not a number", [{ rows_bytes: "2345" }]], ["a size below an empty array's", [{ rows_bytes: 1 }]]] as const)(
    "refuses an insert answer with %s as a broken contract", async (_label, answer) => {
      const error = await expectInvariant(insertPriceChangeReviewWithClient(asClient(new ScriptedClient(() => [...answer])),
        { ...TARGET, actorId: MEMBER }, productsReview()));
      expect(error.context).toMatchObject({ reviewId: REVIEW, column: "rows_bytes" });
    });

  it("refuses a blank actor and a scope outside its contract before any SQL", async () => {
    const client = new ScriptedClient();
    await expectInvariant(insertPriceChangeReviewWithClient(asClient(client), { ...TARGET, actorId: "  " }, productsReview()));
    await expectInvariant(insertPriceChangeReviewWithClient(asClient(client), { vendorId: 0, storeConnectionId: STORE, actorId: MEMBER },
      productsReview()));
    expect(client.sql).toEqual([]);
  });
});

describe("loadPriceChangeReviewWithClient (plan 9.7 steps 2, 4)", () => {
  it("reads one review by id, vendor and store, of the two W7 kinds only, with no lock", async () => {
    const client = new ScriptedClient(() => [storedRow(productsReview())]);

    const review = await loadPriceChangeReviewWithClient(asClient(client), TARGET, REVIEW);

    expect(client.sql).toEqual([normalize(`SELECT r.id, r.kind, r.input, r.rows, r.review_hash, r.created_at,
      octet_length(r.rows::text) AS rows_bytes
      FROM dropship.dropship_pricing_reviews r
      WHERE r.id = $1 AND r.vendor_id = $2 AND r.store_connection_id = $3 AND ${KINDS}`)]);
    expect(client.params[0]).toEqual([REVIEW, VENDOR, STORE]);
    expect(client.sql[0]).not.toMatch(/FOR (UPDATE|SHARE)/);
    // With the rows' stored size, from the same statement (plan 9.7's memory stop rule).
    expect(review).toEqual({ ...productsReview(), rowsBytes: ROWS_BYTES });
  });

  it("parses each kind back to the values it stored, whatever key order jsonb hands back (plan P22, C-money-10)", async () => {
    for (const stored of [productsReview(), categoryReview()]) {
      const review = await loadPriceChangeReviewWithClient(asClient(new ScriptedClient(() => [storedRow(stored)])), TARGET, REVIEW);
      expect(review).toEqual({ ...stored, rowsBytes: ROWS_BYTES });
      // Zod rebuilds objects in shape order: the reloaded input and rows serialize byte for byte as stored, so they hash the same.
      expect(JSON.stringify(review!.input)).toBe(JSON.stringify(storedInputSchemaFor(stored.kind).parse(stored.input)));
      expect(JSON.stringify(review!.rows)).toBe(JSON.stringify(stored.rows));
    }
  });

  it("answers null for no row: a missing review, another vendor's or store's, and a store default review alike", async () => {
    await expect(loadPriceChangeReviewWithClient(asClient(new ScriptedClient()), TARGET, REVIEW)).resolves.toBeNull();
  });

  it.each<[string, Record<string, unknown>, Record<string, unknown>]>([
    ["another id", { id: "00000000-0000-4000-8000-000000000000" }, { column: "id" }],
    ["a kind it never stores", { kind: "store_default" }, { column: "kind" }],
    ["a broken input", { input: { productIds: [7], price: { ...RECIPE, basis: "shelf" } } }, { column: "input" }],
    ["rows that are not an array", { rows: {} }, { column: "rows" }],
    ["a time that is not a time", { created_at: "2026-10-13" }, { column: "created_at" }],
    ["no stored size", { rows_bytes: null }, { column: "rows_bytes" }],
    ["a stored size that is not a whole number", { rows_bytes: 12.5 }, { column: "rows_bytes" }],
  ])("refuses a stored review with %s as a broken contract", async (_label, overrides, context) => {
    const client = new ScriptedClient(() => [{ ...storedRow(productsReview()), ...overrides }]);
    const error = await expectInvariant(loadPriceChangeReviewWithClient(asClient(client), TARGET, REVIEW));
    expect(error.context).toMatchObject(context);
  });

  it("refuses an id the server never issues, and a bad scope, before any SQL", async () => {
    const client = new ScriptedClient();
    await expectInvariant(loadPriceChangeReviewWithClient(asClient(client), TARGET, "not-a-uuid"));
    await expectInvariant(loadPriceChangeReviewWithClient(asClient(client), TARGET, REVIEW.toUpperCase()));
    await expectInvariant(loadPriceChangeReviewWithClient(asClient(client), { vendorId: VENDOR, storeConnectionId: 1.5 }, REVIEW));
    expect(client.sql).toEqual([]);
  });
});

describe("readPriceChangeReviewForMember (plan 9.6)", () => {
  it("is one statement that finds the review by the member who owns its store, of a W7 kind, with no lock", async () => {
    const pool = new ScriptedClient(() => [storedRow(categoryReview())]);

    const review = await readPriceChangeReviewForMember(asClient(pool), { memberId: MEMBER, storeConnectionId: STORE, reviewId: REVIEW });

    expect(pool.sql).toEqual([normalize(`SELECT r.id, r.kind, r.input, r.rows, r.review_hash, r.created_at
      FROM dropship.dropship_pricing_reviews r
      JOIN dropship.dropship_store_connections sc ON sc.id = r.store_connection_id AND sc.vendor_id = r.vendor_id
      JOIN dropship.dropship_vendors v ON v.id = sc.vendor_id
      WHERE r.id = $1 AND r.store_connection_id = $2 AND v.member_id::text = $3 AND ${KINDS}`)]);
    expect(pool.params[0]).toEqual([REVIEW, STORE, MEMBER]);
    expect(pool.sql[0]).not.toMatch(/FOR (UPDATE|SHARE)|BEGIN|pg_advisory/);
    expect(review).toEqual(categoryReview());
    await expect(readPriceChangeReviewForMember(asClient(new ScriptedClient()), { memberId: MEMBER, storeConnectionId: STORE, reviewId: REVIEW }))
      .resolves.toBeNull();
  });

  it("refuses a blank member, a bad store and an id the server never issues, before any SQL", async () => {
    const pool = new ScriptedClient();
    for (const input of [
      { memberId: " ", storeConnectionId: STORE, reviewId: REVIEW },
      { memberId: MEMBER, storeConnectionId: 0, reviewId: REVIEW },
      { memberId: MEMBER, storeConnectionId: STORE, reviewId: "x" },
    ]) {
      await expectInvariant(readPriceChangeReviewForMember(asClient(pool), input));
    }
    expect(pool.sql).toEqual([]);
  });
});

describe("insertPriceChangeApplyRequestWithClient (plan P23, 9.7)", () => {
  const input = { vendorId: VENDOR, storeConnectionId: STORE, reviewId: REVIEW, idempotencyKey: KEY, requestHash: HASH,
    productCount: 2, actor: ACTOR, now: NOW };

  it("inserts 0738's ledger columns with the review id and the operation as a literal, returning the bigint id", async () => {
    const client = new ScriptedClient(() => [{ id: "9007199254740991" }]);

    const id = await insertPriceChangeApplyRequestWithClient(asClient(client), input);

    expect(id).toBe(9_007_199_254_740_991);
    expect(client.sql).toEqual([normalize(`INSERT INTO dropship.dropship_product_listing_setting_requests
      (vendor_id, store_connection_id, operation, review_id, idempotency_key, request_hash, product_count,
      actor_type, actor_id, created_at)
      VALUES ($1, $2, 'price_change_apply', $3, $4, $5, $6, $7, $8, $9)
      RETURNING id`)]);
    expect(client.params[0]).toEqual([VENDOR, STORE, REVIEW, KEY, HASH, 2, "vendor", MEMBER, NOW]);
  });

  it("accepts an apply that names no product (a count of 0) and 10,000 products", async () => {
    for (const productCount of [0, 10_000]) {
      await expect(insertPriceChangeApplyRequestWithClient(asClient(new ScriptedClient(() => [{ id: 4 }])), { ...input, productCount }))
        .resolves.toBe(4);
    }
  });

  it.each<[string, Record<string, unknown>, string[]]>([
    ["a review id the server did not issue", { reviewId: REVIEW.toUpperCase() }, ["reviewId"]],
    ["a short key", { idempotencyKey: "short" }, ["idempotencyKey"]],
    ["a malformed hash", { requestHash: "B".repeat(64) }, ["requestHash"]],
    ["10,001 products", { productCount: 10_001 }, ["productCount"]],
    ["a fractional count", { productCount: 0.5 }, ["productCount"]],
    ["an unknown actor", { actor: { actorType: "robot", actorId: "x" } }, ["actorType"]],
    ["a blank actor id", { actor: { actorType: "vendor", actorId: " " } }, ["actorId"]],
    ["an invalid time", { now: new Date("not a time") }, ["now"]],
    ["a vendor id of 0", { vendorId: 0 }, ["vendorId"]],
    ["a store past int4", { storeConnectionId: 2_147_483_648 }, ["storeConnectionId"]],
  ])("refuses %s before any SQL", async (_label, overrides, invalid) => {
    const client = new ScriptedClient(() => [{ id: 1 }]);
    const error = await expectInvariant(insertPriceChangeApplyRequestWithClient(asClient(client),
      { ...input, ...overrides } as Parameters<typeof insertPriceChangeApplyRequestWithClient>[1]));
    expect(error.context).toMatchObject({ invalid });
    expect(client.sql).toEqual([]);
  });

  it("refuses an insert that returns no identity, or one that is not a whole number", async () => {
    await expectInvariant(insertPriceChangeApplyRequestWithClient(asClient(new ScriptedClient()), input));
    await expectInvariant(insertPriceChangeApplyRequestWithClient(asClient(new ScriptedClient(() => [{ id: "12a" }])), input));
  });
});

describe("findPriceChangeApplyByReviewWithClient (plan 9.7 step 3; v3r, C-money-4)", () => {
  it("reads the row that applied the review, scoped by vendor and store, with no lock", async () => {
    const client = new ScriptedClient(() => [{ id: "77", operation: "price_change_apply", idempotency_key: KEY }]);

    const found = await findPriceChangeApplyByReviewWithClient(asClient(client), TARGET, REVIEW);

    expect(found).toEqual({ requestId: 77, idempotencyKey: KEY });
    expect(client.sql).toEqual([normalize(`SELECT id, operation, idempotency_key
      FROM dropship.dropship_product_listing_setting_requests
      WHERE vendor_id = $1 AND store_connection_id = $2 AND review_id = $3`)]);
    expect(client.params[0]).toEqual([VENDOR, STORE, REVIEW]);
    expect(client.sql[0]).not.toMatch(/FOR (UPDATE|SHARE)/);
  });

  it("answers null when the review was not applied by this vendor on this store", async () => {
    await expect(findPriceChangeApplyByReviewWithClient(asClient(new ScriptedClient()), TARGET, REVIEW)).resolves.toBeNull();
  });

  it.each<[string, Array<Record<string, unknown>>]>([
    ["two rows for one review", [{ id: 1, operation: "price_change_apply", idempotency_key: KEY },
      { id: 2, operation: "price_change_apply", idempotency_key: `${KEY}-2` }]],
    ["another operation", [{ id: 1, operation: "product_settings_bulk", idempotency_key: KEY }]],
    ["a key outside the ledger's CHECK", [{ id: 1, operation: "price_change_apply", idempotency_key: "short" }]],
    ["an id that is not a whole number", [{ id: "1.5", operation: "price_change_apply", idempotency_key: KEY }]],
  ])("refuses %s as a broken contract", async (_label, rows) => {
    await expectInvariant(findPriceChangeApplyByReviewWithClient(asClient(new ScriptedClient(() => rows)), TARGET, REVIEW));
  });

  it("refuses an id the server never issues before any SQL", async () => {
    const client = new ScriptedClient();
    await expectInvariant(findPriceChangeApplyByReviewWithClient(asClient(client), TARGET, "review"));
    expect(client.sql).toEqual([]);
  });
});
