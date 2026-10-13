import type { Pool, PoolClient } from "pg";
import { beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import type { SaveListingContentInput } from "../../../../../shared/dropship/listing-content";
import type {
  ListingSettingPreflightTransaction,
  ListingSettingSystemTransaction,
  ListingSettingWriteTransaction,
} from "../../application/dropship-listing-setting-writes";
import { DropshipError } from "../../domain/errors";
import { listingSettingChildKey, listingSettingChildKeyPrefix } from "../../domain/listing-setting-values";
import {
  PgDropshipListingSettingWritesRepository,
  mapListingSettingWriteError,
} from "../../infrastructure/dropship-listing-setting-writes.repository";

vi.mock("../../../../db", () => ({ db: {}, pool: {} }));

type QueryClient = Pick<PoolClient, "query">;

/**
 * The writers behind the transaction are mocked: their SQL is pinned by their
 * own unit tests and the PostgreSQL suite. Each mock writes one marker
 * statement through the client it was given, so the order of the wrapper's
 * statements around it, and that the writer got the transaction's client, are
 * visible here.
 */
const writers = vi.hoisted(() => {
  const marker = (name: string, result: unknown) => async (client: QueryClient) => {
    await client.query(`-- writer: ${name}`);
    return result;
  };
  return {
    marker,
    readProductListingSettings: vi.fn(),
    saveProductListingSettingWithClient: vi.fn(),
    saveProductListingSettingsBulkWithClient: vi.fn(),
    readCategoryListingSettings: vi.fn(),
    saveCategoryListingSettingWithClient: vi.fn(),
    readProductCategoryMarks: vi.fn(),
    acknowledgeCategoryMovesWithClient: vi.fn(),
    insertFirstCategoryMarksWithClient: vi.fn(),
    saveEbayCategoryRulesProfileWithClient: vi.fn(),
    saveListingContentWithClient: vi.fn(),
    clearSizeLeftoversWithClient: vi.fn(),
  };
});

vi.mock("../../infrastructure/dropship-product-listing-settings.repository", () => ({
  readProductListingSettings: writers.readProductListingSettings,
  saveProductListingSettingWithClient: writers.saveProductListingSettingWithClient,
  saveProductListingSettingsBulkWithClient: writers.saveProductListingSettingsBulkWithClient,
}));
vi.mock("../../infrastructure/dropship-category-listing-settings.repository", () => ({
  readCategoryListingSettings: writers.readCategoryListingSettings,
  saveCategoryListingSettingWithClient: writers.saveCategoryListingSettingWithClient,
}));
vi.mock("../../infrastructure/dropship-product-category-marks.repository", () => ({
  readProductCategoryMarks: writers.readProductCategoryMarks,
  acknowledgeCategoryMovesWithClient: writers.acknowledgeCategoryMovesWithClient,
  insertFirstCategoryMarksWithClient: writers.insertFirstCategoryMarksWithClient,
}));
vi.mock("../../infrastructure/dropship-ebay-category-rules.repository", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infrastructure/dropship-ebay-category-rules.repository")>()),
  saveEbayCategoryRulesProfileWithClient: writers.saveEbayCategoryRulesProfileWithClient,
}));
vi.mock("../../infrastructure/dropship-listing-setting-leftovers.repository", () => ({
  clearSizeLeftoversWithClient: writers.clearSizeLeftoversWithClient,
}));
vi.mock("../../infrastructure/dropship-listing-content.repository", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infrastructure/dropship-listing-content.repository")>()),
  saveListingContentWithClient: writers.saveListingContentWithClient,
}));

const NOW = new Date("2026-10-10T12:00:00.000Z");
const MEMBER = "member-1";
const VENDOR = 10;
const STORE = 22;
const KEY = "listing-settings:7f9c2ba4-e88f-4a5e-9d1b-1c2d3e4f5a6b";
const HASH = "a".repeat(64);
const INPUT = { memberId: MEMBER, storeConnectionId: STORE, idempotencyKey: KEY };

class ScriptedClient {
  sql: string[] = [];
  params: unknown[][] = [];
  release = vi.fn();
  ownerFound = true;
  failRollback = false;
  /** Sizes that exist in the catalog; lockCatalog locks only these. */
  existingVariantIds = new Set([101, 102, 103]);
  /** Products that exist in the catalog; lockCatalog locks only these. */
  existingProductIds = new Set([7, 8]);
  /** Each product's sellable sizes, as listProductSizes reads them. */
  productSizes = new Map<number, number[]>([[7, [101, 102]], [8, [103]]]);
  /** What the store text byte count answers. */
  textBytes: Record<string, unknown> = { utf8: true, store_bytes: "1200", kept_store_bytes: "1000", target_bytes: "300" };
  /** What the replay probe (findRequestKeyUse) answers. */
  probeRows: Array<Record<string, unknown>> = [];

  async query<T>(text: string, params: unknown[] = []): Promise<{ rows: T[] }> {
    const sql = text.replace(/\s+/g, " ").trim();
    this.sql.push(sql);
    this.params.push(params);
    if (sql === "ROLLBACK" && this.failRollback) throw new Error("connection lost during rollback");
    if (sql.includes("FROM dropship.dropship_vendors v") || sql.includes("FROM dropship.dropship_store_connections sc")) {
      return rows<T>(this.ownerFound ? [{ vendor_id: VENDOR }] : []);
    }
    if (sql.startsWith("SELECT id FROM catalog.product_variants WHERE product_id = ANY")) {
      return rows<T>((params[0] as number[]).flatMap((productId) => this.productSizes.get(productId) ?? []).sort((a, b) => a - b)
        .map((id) => ({ id })));
    }
    if (sql.startsWith("SELECT id FROM catalog.product_variants")) {
      return rows<T>((params[0] as number[]).filter((id) => this.existingVariantIds.has(id)).map((id) => ({ id })));
    }
    if (sql.startsWith("SELECT id FROM catalog.products")) {
      return rows<T>((params[0] as number[]).filter((id) => this.existingProductIds.has(id)).map((id) => ({ id })));
    }
    if (sql.startsWith("SELECT current_setting('server_encoding')")) return rows<T>([this.textBytes]);
    if (sql.startsWith("INSERT INTO dropship.dropship_listing_price_revisions")) return rows<T>([{ id: 31 }]);
    if (sql.startsWith("SELECT 'product' AS source")) return rows<T>(this.probeRows);
    return rows<T>([]);
  }

  /** Statements after BEGIN, the two locks and the owner read. */
  afterOwner(): string[] {
    const owner = this.sql.findIndex((sql) => sql.includes("FOR SHARE OF v, sc"));
    return this.sql.slice(owner + 1);
  }
}

function rows<T>(values: unknown[]): { rows: T[] } {
  return { rows: values as T[] };
}

function setup() {
  const client = new ScriptedClient();
  const connect = vi.fn(async () => client);
  const repository = new PgDropshipListingSettingWritesRepository({ connect } as unknown as Pool);
  return { client, connect, repository };
}

async function expectInvariant(promise: Promise<unknown>): Promise<DropshipError> {
  const error = await promise.then(() => null, (reason: unknown) => reason);
  expect(error).toBeInstanceOf(DropshipError);
  expect((error as DropshipError).code).toBe("DROPSHIP_LISTING_SETTINGS_INVARIANT_FAILED");
  expect((error as DropshipError).context).toMatchObject({ retryable: false, classification: "fatal" });
  return error as DropshipError;
}

const productSave = { productId: 7, expectedRevisionId: null, patch: { storeShelf: { mode: "none" as const } }, requestHash: HASH, now: NOW };
const bulkSave = {
  operation: "product_settings_bulk" as const, products: [{ productId: 7, expectedRevisionId: null }],
  patch: { storeShelf: { mode: "none" as const } }, requestHash: HASH, now: NOW,
};
const categorySave = { categoryId: 3, expectedRevisionId: null, patch: { storeShelf: { mode: "none" as const } }, requestHash: HASH, now: NOW };
const acknowledge = { items: [{ productId: 7, shownCategoryId: 3 }], requestHash: HASH, now: NOW };

/** Each parent-key writer called once, as a PR 9 service would. */
const PARENT_KEY_WRITERS: ReadonlyArray<[string, (tx: ListingSettingWriteTransaction) => Promise<unknown>]> = [
  ["saveProduct", (tx) => tx.saveProduct(productSave)],
  ["saveProductsBulk", (tx) => tx.saveProductsBulk(bulkSave)],
  ["saveCategory", (tx) => tx.saveCategory(categorySave)],
  ["acknowledgeCategoryMoves", (tx) => tx.acknowledgeCategoryMoves(acknowledge)],
];

function contentSave(idempotencyKey: string): SaveListingContentInput {
  return { idempotencyKey, customText: null, expectedRevisionId: null, expectedCatalogHash: "c".repeat(64), expectedProfileRevisionId: null };
}

beforeEach(() => {
  vi.clearAllMocks();
  writers.readProductListingSettings.mockImplementation(writers.marker("readProducts", new Map()));
  writers.readCategoryListingSettings.mockImplementation(writers.marker("readCategories", new Map()));
  writers.readProductCategoryMarks.mockImplementation(writers.marker("readMarks", new Map()));
  writers.saveProductListingSettingWithClient.mockImplementation(writers.marker("saveProduct", { outcome: "changed" }));
  writers.saveProductListingSettingsBulkWithClient.mockImplementation(writers.marker("saveProductsBulk", { outcome: "changed" }));
  writers.saveCategoryListingSettingWithClient.mockImplementation(writers.marker("saveCategory", { outcome: "changed" }));
  writers.acknowledgeCategoryMovesWithClient.mockImplementation(writers.marker("acknowledgeCategoryMoves", { outcome: "acknowledged" }));
  writers.insertFirstCategoryMarksWithClient.mockImplementation(writers.marker("insertFirstCategoryMarks", { insertedProductIds: [7] }));
  writers.saveEbayCategoryRulesProfileWithClient.mockImplementation(writers.marker("saveEbayCategoryRulesProfile", { revisionId: 4 }));
  writers.saveListingContentWithClient.mockImplementation(writers.marker("saveListingContent", undefined));
  writers.clearSizeLeftoversWithClient.mockImplementation(writers.marker("clearSizeLeftovers",
    { clearedSizeCount: 1, byKind: { policy: 1, shelf: 0, content: 0 }, productVariantIds: [101] }));
});

describe("PgDropshipListingSettingWritesRepository.execute", () => {
  it("opens a plain READ COMMITTED transaction, then the request lock, the store lock and the owner rows", async () => {
    const { client, repository } = setup();

    await expect(repository.execute(INPUT, async () => "done")).resolves.toBe("done");

    expect(client.sql[0]).toBe("BEGIN");
    expect(client.sql[1]).toBe("SELECT pg_advisory_xact_lock(hashtext('dropship_listing_settings_request'), hashtext($1))");
    expect(client.params[1]).toEqual([`${MEMBER}:${KEY}`]);
    expect(client.sql[2]).toBe("SELECT pg_advisory_xact_lock(hashtext('dropship_listing_push_job'), $1::integer)");
    expect(client.params[2]).toEqual([STORE]);
    expect(client.sql[3]).toContain("WHERE v.member_id::text = $1 AND sc.id = $2 FOR SHARE OF v, sc");
    expect(client.params[3]).toEqual([MEMBER, STORE]);
    expect(client.sql.slice(4)).toEqual(["COMMIT"]);
    expect(client.sql.some((sql) => sql.includes("ISOLATION LEVEL"))).toBe(false);
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("gives the operation the owner's ids, the member as a vendor actor and the request key", async () => {
    const { repository } = setup();

    const seen = await repository.execute(INPUT, async (tx) => ({
      vendorId: tx.vendorId, storeConnectionId: tx.storeConnectionId, actor: tx.actor, requestKey: tx.requestKey,
    }));

    expect(seen).toEqual({ vendorId: VENDOR, storeConnectionId: STORE, actor: { actorType: "vendor", actorId: MEMBER }, requestKey: KEY });
  });

  it("answers another member's store as DROPSHIP_STORE_CONNECTION_REQUIRED without running the operation", async () => {
    const { client, repository } = setup();
    client.ownerFound = false;
    const operation = vi.fn(async () => "never");

    await expect(repository.execute(INPUT, operation)).rejects.toMatchObject({
      code: "DROPSHIP_STORE_CONNECTION_REQUIRED",
      context: { storeConnectionId: STORE, retryable: false, classification: "permanent" },
    });
    expect(operation).not.toHaveBeenCalled();
    expect(client.sql.at(-1)).toBe("ROLLBACK");
    expect(client.release).toHaveBeenCalledOnce();
  });

  it.each([
    ["a blank member", { ...INPUT, memberId: " " }],
    ["a store id of 0", { ...INPUT, storeConnectionId: 0 }],
    ["a key shorter than 8 characters", { ...INPUT, idempotencyKey: "short" }],
    ["a key with a space", { ...INPUT, idempotencyKey: "listing settings:1" }],
  ])("refuses %s before taking a connection", async (_label, input) => {
    const { connect, repository } = setup();

    await expectInvariant(repository.execute(input, async () => "never"));
    expect(connect).not.toHaveBeenCalled();
  });

  it("rolls back, releases once and keeps the operation's error when the rollback itself fails", async () => {
    const { client, repository } = setup();
    client.failRollback = true;
    const failure = new Error("the operation failed");

    await expect(repository.execute(INPUT, async () => { throw failure; })).rejects.toBe(failure);
    expect(client.sql.at(-1)).toBe("ROLLBACK");
    expect(client.sql).not.toContain("COMMIT");
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("refuses every call on a transaction kept after it ended, without a statement", async () => {
    const { client, repository } = setup();
    let kept: ListingSettingWriteTransaction | undefined;
    await repository.execute(INPUT, async (tx) => { kept = tx; });
    const statements = client.sql.length;

    await expectInvariant(kept!.loadProducts([7]));
    await expectInvariant(kept!.saveProduct(productSave));
    await expectInvariant(kept!.lockCatalog({ productIds: [7] }));
    await expectInvariant(kept!.listVariantIds(0, 10));
    expect(() => kept!.sizePrice(101)).toThrow(DropshipError);
    expect(client.sql).toHaveLength(statements);
    expect(writers.saveProductListingSettingWithClient).not.toHaveBeenCalled();
  });

  it("refuses a transaction kept after a failed operation as well", async () => {
    const { client, repository } = setup();
    let kept: ListingSettingWriteTransaction | undefined;
    await expect(repository.execute(INPUT, async (tx) => { kept = tx; throw new Error("stop"); })).rejects.toThrow("stop");
    const statements = client.sql.length;

    await expectInvariant(kept!.loadCategoryMarks([7]));
    expect(client.sql).toHaveLength(statements);
  });
});

describe("lockCatalog", () => {
  it("takes the selection SHARE locks, then categories, products and sizes FOR SHARE in ascending distinct ids", async () => {
    const { client, repository } = setup();

    await repository.execute(INPUT, (tx) => tx.lockCatalog({
      categoryIds: [5, 3, 5], productIds: [8, 7], productVariantIds: [102, 101, 102],
    }));

    expect(client.afterOwner()).toEqual([
      "LOCK TABLE dropship.dropship_catalog_rules, dropship.dropship_vendor_selection_rules, "
        + "dropship.dropship_vendor_variant_overrides, catalog.product_line_products IN SHARE MODE",
      "SELECT id FROM catalog.product_categories WHERE id = ANY($1::int[]) ORDER BY id FOR SHARE",
      "SELECT id FROM catalog.products WHERE id = ANY($1::int[]) ORDER BY id FOR SHARE",
      "SELECT id FROM catalog.product_variants WHERE id = ANY($1::int[]) ORDER BY id FOR SHARE",
      "COMMIT",
    ]);
    const lockParams = client.params.slice(-4, -1);
    expect(lockParams).toEqual([[[3, 5]], [[7, 8]], [[101, 102]]]);
  });

  it("takes only the selection locks when it is given no ids", async () => {
    const { client, repository } = setup();

    await repository.execute(INPUT, (tx) => tx.lockCatalog({}));

    expect(client.afterOwner()).toEqual([expect.stringContaining("IN SHARE MODE"), "COMMIT"]);
  });

  it("is refused after a write, after a target row lock, and a second time; a plain read keeps it open", async () => {
    const afterWrite = setup();
    await expectInvariant(afterWrite.repository.execute(INPUT, async (tx) => {
      await tx.saveProduct(productSave);
      await tx.lockCatalog({ productIds: [7] });
    }));
    expect(afterWrite.client.sql.some((sql) => sql.startsWith("LOCK TABLE"))).toBe(false);
    expect(afterWrite.client.sql.at(-1)).toBe("ROLLBACK");

    const afterTargetLock = setup();
    await expectInvariant(afterTargetLock.repository.execute(INPUT, async (tx) => {
      await tx.loadProducts([7], { forUpdate: true });
      await tx.lockCatalog({ productIds: [7] });
    }));
    expect(afterTargetLock.client.sql.some((sql) => sql.startsWith("LOCK TABLE"))).toBe(false);

    const twice = setup();
    await expectInvariant(twice.repository.execute(INPUT, async (tx) => {
      await tx.lockCatalog({ categoryIds: [3] });
      await tx.lockCatalog({ productIds: [7] });
    }));
    expect(twice.client.sql.filter((sql) => sql.startsWith("LOCK TABLE"))).toHaveLength(1);

    const afterRead = setup();
    await afterRead.repository.execute(INPUT, async (tx) => {
      await tx.loadProducts([7]);
      await tx.loadCategories([3]);
      await tx.loadCategoryMarks([7]);
      await tx.lockCatalog({ productIds: [7] });
    });
    expect(afterRead.client.sql.at(-1)).toBe("COMMIT");
  });

  it.each([[[0]], [[-1]], [[1.5]], [[2_147_483_648]]])("refuses id %j before any lock", async (ids) => {
    const { client, repository } = setup();

    await expectInvariant(repository.execute(INPUT, (tx) => tx.lockCatalog({ productVariantIds: ids })));
    expect(client.sql.some((sql) => sql.startsWith("LOCK TABLE"))).toBe(false);
  });
});

describe("the transaction's writers", () => {
  it("run on the transaction's client with its scope: own key, vendor actor", async () => {
    const scope = { vendorId: VENDOR, storeConnectionId: STORE, actor: { actorType: "vendor", actorId: MEMBER }, requestKey: KEY };

    for (const [writer, call] of PARENT_KEY_WRITERS) {
      const { client, repository } = setup();
      await repository.execute(INPUT, call);
      expect(client.afterOwner()).toEqual([`-- writer: ${writer}`, "COMMIT"]);
    }

    expect(writers.saveProductListingSettingWithClient).toHaveBeenCalledWith(expect.anything(), scope, productSave);
    expect(writers.saveProductListingSettingsBulkWithClient).toHaveBeenCalledWith(expect.anything(), scope, bulkSave);
    expect(writers.saveCategoryListingSettingWithClient).toHaveBeenCalledWith(expect.anything(), scope, categorySave);
    expect(writers.acknowledgeCategoryMovesWithClient).toHaveBeenCalledWith(expect.anything(), scope, acknowledge);
  });

  it("lets a single product save and a category save join the one ledger writer", async () => {
    const { client, repository } = setup();

    await repository.execute(INPUT, async (tx) => {
      await tx.saveProduct(productSave);
      await tx.saveCategory(categorySave);
      await tx.acknowledgeCategoryMoves(acknowledge);
    });

    expect(client.afterOwner()).toEqual([
      "-- writer: saveProduct", "-- writer: saveCategory", "-- writer: acknowledgeCategoryMoves", "COMMIT",
    ]);
  });

  it.each([
    ["saveProductsBulk", "acknowledgeCategoryMoves"],
    ["acknowledgeCategoryMoves", "saveProductsBulk"],
  ])("refuses a second ledger writer (%s, then %s) before any SQL", async (first, second) => {
    const { client, repository } = setup();
    const call = (writer: string) => PARENT_KEY_WRITERS.find(([name]) => name === writer)![1];

    const error = await expectInvariant(repository.execute(INPUT, async (tx) => {
      await call(first)(tx);
      await call(second)(tx);
    }));

    // Both write the one ledger row keyed (vendor, request key): the second would be a misleading key conflict.
    expect(error.context).toMatchObject({ writer: second, ledgerWriter: first });
    expect(client.afterOwner()).toEqual([`-- writer: ${first}`, "ROLLBACK"]);
  });

  it("passes the reads the transaction's target and lock choice", async () => {
    const { repository } = setup();
    const target = { vendorId: VENDOR, storeConnectionId: STORE };

    await repository.execute(INPUT, async (tx) => {
      await tx.loadProducts([7, 8], { forUpdate: true });
      await tx.loadCategories([3]);
      await tx.loadCategoryMarks([7]);
    });

    expect(writers.readProductListingSettings).toHaveBeenCalledWith(expect.anything(), { ...target, productIds: [7, 8], forUpdate: true });
    expect(writers.readCategoryListingSettings).toHaveBeenCalledWith(expect.anything(), { ...target, categoryIds: [3], forUpdate: undefined });
    expect(writers.readProductCategoryMarks).toHaveBeenCalledWith(expect.anything(), { ...target, productIds: [7] });
  });

  it.each(PARENT_KEY_WRITERS)("refuses a second %s in one transaction before any SQL", async (writer, call) => {
    const { client, repository } = setup();

    const error = await expectInvariant(repository.execute(INPUT, async (tx) => {
      await call(tx);
      await call(tx);
    }));

    expect(error.context).toMatchObject({ writer });
    expect(client.sql.filter((sql) => sql === `-- writer: ${writer}`)).toHaveLength(1);
    expect(client.sql.at(-1)).toBe("ROLLBACK");
  });

  it("lets W12 run one category save and one bulk clear in the same transaction", async () => {
    const { client, repository } = setup();

    await repository.execute(INPUT, async (tx) => {
      await tx.saveCategory(categorySave);
      await tx.saveProductsBulk({ ...bulkSave, operation: "category_settings_clear", patch: { storeShelf: null } });
    });

    expect(client.sql.at(-1)).toBe("COMMIT");
  });
});

describe("sizePrice (W9's own transaction for one size)", () => {
  it("refuses a size lockCatalog was not given as a fault, and one missing from the catalog as not available", async () => {
    const { client, repository } = setup();
    client.existingVariantIds = new Set([101]);

    const unlocked = await expectInvariant(repository.execute(INPUT, async (tx) => {
      await tx.lockCatalog({ productVariantIds: [101, 104] });
      tx.sizePrice(102);
    }));
    expect(unlocked.context).toMatchObject({ productVariantId: "102" });
    await expectInvariant(repository.execute(INPUT, async (tx) => { tx.sizePrice(101); }));

    // Deleted from the catalog, or a bad id in a request: the vendor's data, answered with W9's own permanent code.
    await expect(repository.execute(INPUT, async (tx) => {
      await tx.lockCatalog({ productVariantIds: [101, 104] });
      tx.sizePrice(104);
    })).rejects.toMatchObject({
      code: "DROPSHIP_LISTING_PRICE_NOT_AVAILABLE",
      context: { productVariantId: 104, retryable: false, classification: "permanent" },
    });
    expect(client.sql.some((sql) => sql.includes("dropship_listing_price"))).toBe(false);
  });

  it("saves a size's price at most once per transaction: one replay read, one save, nothing after the save", async () => {
    const childKey = listingSettingChildKey(KEY, "size", 101);
    const save = (idempotencyKey: string) => ({ idempotencyKey, priceCents: 1299, expectedRevisionId: null, requestHash: HASH, now: NOW });
    const revisionInserts = (client: ScriptedClient) =>
      client.sql.filter((sql) => sql.startsWith("INSERT INTO dropship.dropship_listing_price_revisions")).length;

    // W9's flow twice for size 101: the second replay read would find the first save under the same child key.
    const flowTwice = setup();
    const second = await expectInvariant(flowTwice.repository.execute(INPUT, async (tx) => {
      await tx.lockCatalog({ productVariantIds: [101, 102] });
      const first = tx.sizePrice(101);
      await first.loadReplay({ idempotencyKey: childKey, requestHash: HASH });
      await first.save(save(childKey));
      await tx.sizePrice(102).save(save(listingSettingChildKey(KEY, "size", 102)));
      await tx.sizePrice(101).loadReplay({ idempotencyKey: childKey, requestHash: HASH });
    }));
    expect(second.context).toMatchObject({ productVariantId: "101" });
    expect(revisionInserts(flowTwice.client)).toBe(2);

    const saveTwice = setup();
    await expectInvariant(saveTwice.repository.execute(INPUT, async (tx) => {
      await tx.lockCatalog({ productVariantIds: [101] });
      await tx.sizePrice(101).save(save(childKey));
      await tx.sizePrice(101).save(save(childKey));
    }));
    expect(revisionInserts(saveTwice.client)).toBe(1);

    const replayTwice = setup();
    await expectInvariant(replayTwice.repository.execute(INPUT, async (tx) => {
      await tx.lockCatalog({ productVariantIds: [101] });
      await tx.sizePrice(101).loadReplay({ idempotencyKey: childKey, requestHash: HASH });
      await tx.sizePrice(101).loadReplay({ idempotencyKey: childKey, requestHash: HASH });
    }));
    expect(replayTwice.client.sql.filter((sql) => sql.includes("FROM dropship.dropship_listing_price_revisions"))).toHaveLength(1);
  });

  it("writes only with the size's child key, on this client, audited as the member", async () => {
    const { client, repository } = setup();
    const childKey = listingSettingChildKey(KEY, "size", 101);
    const save = (idempotencyKey: string) => ({ idempotencyKey, priceCents: 1299, expectedRevisionId: null, requestHash: HASH, now: NOW });

    await expect(repository.execute(INPUT, async (tx) => {
      await tx.lockCatalog({ productVariantIds: [101, 102] });
      await tx.sizePrice(101).save(save(KEY));
    })).rejects.toMatchObject({ code: "DROPSHIP_IDEMPOTENCY_CONFLICT" });
    await expect(repository.execute(INPUT, async (tx) => {
      await tx.lockCatalog({ productVariantIds: [101, 102] });
      await tx.sizePrice(101).save(save(listingSettingChildKey(KEY, "size", 102)));
    })).rejects.toMatchObject({ code: "DROPSHIP_IDEMPOTENCY_CONFLICT" });
    await expect(repository.execute(INPUT, async (tx) => {
      await tx.lockCatalog({ productVariantIds: [101] });
      await tx.sizePrice(101).loadReplay({ idempotencyKey: KEY, requestHash: HASH });
    })).rejects.toMatchObject({ code: "DROPSHIP_IDEMPOTENCY_CONFLICT" });
    expect(client.sql.some((sql) => sql.startsWith("INSERT INTO"))).toBe(false);

    const result = await repository.execute(INPUT, async (tx) => {
      await tx.lockCatalog({ productVariantIds: [101] });
      return tx.sizePrice(101).save(save(childKey));
    });

    expect(result).toMatchObject({ saved: { productVariantId: 101, revisionId: 31, overridePriceCents: 1299 }, idempotentReplay: false });
    const insert = client.sql.findIndex((sql) => sql.startsWith("INSERT INTO dropship.dropship_listing_price_revisions"));
    expect(client.params[insert]).toEqual([VENDOR, STORE, 101, null, 1299, childKey, HASH, MEMBER, NOW, "fixed"]);
    const audit = client.sql.findIndex((sql) => sql.includes("'listing_price_saved','vendor'"));
    expect(client.params[audit].slice(0, 4)).toEqual([VENDOR, STORE, "101", MEMBER]);
    expect(client.sql.at(-1)).toBe("COMMIT");
  });

  it("ends lockCatalog's window once it reads the size's price row for update", async () => {
    const { repository } = setup();

    await expectInvariant(repository.execute(INPUT, async (tx) => {
      await tx.lockCatalog({ productVariantIds: [101] });
      await tx.sizePrice(101).loadSaved();
      await tx.lockCatalog({});
    }));
  });
});

describe("the eBay category rules and description delegates", () => {
  it("save the store's rules only with the request's ebay_rules child key for this store", async () => {
    const { repository } = setup();
    const save = (idempotencyKey: string) => ({
      expectedRevisionId: null, profile: { version: 1, defaultCategory: null, rules: [] }, idempotencyKey, requestHash: HASH, now: NOW,
    }) as unknown as Parameters<ListingSettingWriteTransaction["saveEbayCategoryRulesProfile"]>[0];

    for (const key of [KEY, listingSettingChildKey(KEY, "content", STORE), listingSettingChildKey(KEY, "ebay_rules", STORE + 1)]) {
      await expectInvariant(repository.execute(INPUT, (tx) => tx.saveEbayCategoryRulesProfile(save(key))));
    }
    expect(writers.saveEbayCategoryRulesProfileWithClient).not.toHaveBeenCalled();

    const childKey = listingSettingChildKey(KEY, "ebay_rules", STORE);
    await expect(repository.execute(INPUT, (tx) => tx.saveEbayCategoryRulesProfile(save(childKey)))).resolves.toEqual({ revisionId: 4 });
    expect(writers.saveEbayCategoryRulesProfileWithClient).toHaveBeenCalledWith(
      expect.anything(), { vendorId: VENDOR, storeConnectionId: STORE, actorId: MEMBER }, save(childKey));

    // The child key names one revision: a second save in the same transaction is refused before SQL.
    await expectInvariant(repository.execute(INPUT, async (tx) => {
      await tx.saveEbayCategoryRulesProfile(save(childKey));
      await tx.saveEbayCategoryRulesProfile(save(childKey));
    }));
    expect(writers.saveEbayCategoryRulesProfileWithClient).toHaveBeenCalledTimes(2);
  });

  it("save a size's description only for a locked size with its content child key", async () => {
    const { repository } = setup();
    const childKey = listingSettingChildKey(KEY, "content", 101);

    await expectInvariant(repository.execute(INPUT, (tx) => tx.saveListingContent(101, contentSave(childKey), HASH, NOW)));
    for (const key of [KEY, listingSettingChildKey(KEY, "content", 102), listingSettingChildKey(KEY, "size", 101)]) {
      await expectInvariant(repository.execute(INPUT, async (tx) => {
        await tx.lockCatalog({ productVariantIds: [101, 102] });
        await tx.saveListingContent(101, contentSave(key), HASH, NOW);
      }));
    }
    expect(writers.saveListingContentWithClient).not.toHaveBeenCalled();

    // A size lockCatalog did not find is not available (permanent), as the content service answers it.
    const missing = setup();
    missing.client.existingVariantIds = new Set([101]);
    await expect(missing.repository.execute(INPUT, async (tx) => {
      await tx.lockCatalog({ productVariantIds: [101, 104] });
      await tx.saveListingContent(104, contentSave(listingSettingChildKey(KEY, "content", 104)), HASH, NOW);
    })).rejects.toMatchObject({
      code: "DROPSHIP_CONTENT_NOT_AVAILABLE",
      context: { productVariantId: 104, retryable: false, classification: "permanent" },
    });
    expect(writers.saveListingContentWithClient).not.toHaveBeenCalled();

    await repository.execute(INPUT, async (tx) => {
      await tx.lockCatalog({ productVariantIds: [101] });
      await tx.saveListingContent(101, contentSave(childKey), HASH, NOW);
    });
    expect(writers.saveListingContentWithClient).toHaveBeenCalledWith(
      expect.anything(), { vendorId: VENDOR, storeConnectionId: STORE, actorId: MEMBER }, 101, contentSave(childKey), HASH, NOW);

    // One description per size per transaction; another size has its own child key.
    const twice = await expectInvariant(repository.execute(INPUT, async (tx) => {
      await tx.lockCatalog({ productVariantIds: [101, 102] });
      await tx.saveListingContent(102, contentSave(listingSettingChildKey(KEY, "content", 102)), HASH, NOW);
      await tx.saveListingContent(101, contentSave(childKey), HASH, NOW);
      await tx.saveListingContent(101, contentSave(childKey), HASH, NOW);
    }));
    expect(twice.context).toMatchObject({ productVariantId: "101" });
    expect(writers.saveListingContentWithClient).toHaveBeenCalledTimes(3);
  });
});

describe("error mapping (plan 3.9)", () => {
  const pgError = (fields: Record<string, unknown>) => Object.assign(new Error(String(fields.message ?? "database error")), fields);

  it.each([
    ["a reused ledger key", { code: "23505", constraint: "dropship_product_listing_setting_requests_key_idx" }, "DROPSHIP_IDEMPOTENCY_CONFLICT", "permanent"],
    ["a reused product revision key", { code: "23505", constraint: "dropship_product_listing_setting_revision_key_uk" }, "DROPSHIP_IDEMPOTENCY_CONFLICT", "permanent"],
    ["a reused category revision key", { code: "23505", constraint: "dropship_category_listing_setting_revision_key_uk" }, "DROPSHIP_IDEMPOTENCY_CONFLICT", "permanent"],
    // Plan PR 9, P32: PR 9's routes never reach these (one member per vendor, the request lock is member:key); an older
    // per-size policy or shelf route given a child-key-shaped key can, between a PR 9 write's probe and its insert (no
    // store lock); the size and content keys are a backstop (their older routes take the store lock). Real constraint names.
    ["a reused size price child key", { code: "23505", constraint: "dropship_listing_price_revision_idempotency_uk" }, "DROPSHIP_IDEMPOTENCY_CONFLICT", "permanent"],
    ["a reused policy child key", { code: "23505", constraint: "dropship_ebay_listing_policy_override_revision_idem_uk" }, "DROPSHIP_IDEMPOTENCY_CONFLICT", "permanent"],
    ["a reused shelf child key", { code: "23505", constraint: "dropship_ebay_store_category_revision_idem_uk" }, "DROPSHIP_IDEMPOTENCY_CONFLICT", "permanent"],
    // 0660 leaves it unnamed; PostgreSQL's generated name, read from pg_constraint by the PostgreSQL suite.
    ["a reused content child key", { code: "23505", constraint: "dropship_listing_content_revision_vendor_id_idempotency_key_key" }, "DROPSHIP_IDEMPOTENCY_CONFLICT", "permanent"],
    ["a missing product on a revision", { code: "23503", constraint: "dropship_product_listing_setting_revision_product_fk" }, "DROPSHIP_LISTING_SETTINGS_PRODUCT_NOT_FOUND", "permanent"],
    ["a missing product on a current row", { code: "23503", constraint: "dropship_product_listing_setting_product_fk" }, "DROPSHIP_LISTING_SETTINGS_PRODUCT_NOT_FOUND", "permanent"],
    ["a missing category on a revision", { code: "23503", constraint: "dropship_category_listing_setting_revision_category_fk" }, "DROPSHIP_LISTING_SETTINGS_CATEGORY_NOT_FOUND", "permanent"],
    ["a missing category on a current row", { code: "23503", constraint: "dropship_category_listing_setting_category_fk" }, "DROPSHIP_LISTING_SETTINGS_CATEGORY_NOT_FOUND", "permanent"],
    ["a CHECK", { code: "23514", constraint: "dropship_product_listing_setting_revision_price_chk", table: "dropship_product_listing_setting_revisions" }, "DROPSHIP_LISTING_SETTINGS_INVARIANT_FAILED", "fatal"],
    ["a guard trigger", { code: "23514", message: "Product listing setting predecessor does not match the current setting" }, "DROPSHIP_LISTING_SETTINGS_INVARIANT_FAILED", "fatal"],
    ["a deadlock", { code: "40P01" }, "DROPSHIP_LISTING_SETTINGS_BUSY", "transient"],
    ["a serialization failure", { code: "40001" }, "DROPSHIP_LISTING_SETTINGS_BUSY", "transient"],
    // A dropped or refused connection: retryable, since a same-key retry is answered by the replay probe (plan P16).
    ["a dropped connection", { code: "08006" }, "DROPSHIP_LISTING_SETTINGS_BUSY", "transient"],
    ["an administrator shutdown", { code: "57P01" }, "DROPSHIP_LISTING_SETTINGS_BUSY", "transient"],
    ["too many connections", { code: "53300" }, "DROPSHIP_LISTING_SETTINGS_BUSY", "transient"],
    ["a reset socket", { code: "ECONNRESET" }, "DROPSHIP_LISTING_SETTINGS_BUSY", "transient"],
  ])("maps %s after the rollback", async (_label, fields, code, classification) => {
    const { client, repository } = setup();

    const error = await repository.execute(INPUT, async () => { throw pgError(fields); }).then(() => null, (reason: unknown) => reason);

    expect(error).toBeInstanceOf(DropshipError);
    expect(error).toMatchObject({ code, context: { classification, retryable: classification === "transient" } });
    expect(client.sql.at(-1)).toBe("ROLLBACK");
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("names the missing product or category from PostgreSQL's detail, and nothing else from the row", () => {
    expect(mapListingSettingWriteError(pgError({
      code: "23503", constraint: "dropship_product_listing_setting_revision_product_fk",
      detail: "Key (product_id)=(999) is not present in table \"products\".",
    }))).toMatchObject({ context: { productId: 999, constraint: "dropship_product_listing_setting_revision_product_fk" } });
    expect(mapListingSettingWriteError(pgError({
      code: "23503", constraint: "dropship_category_listing_setting_category_fk",
      detail: "Key (category_id)=(55) is not present in table \"product_categories\".",
    }))).toMatchObject({ context: { categoryId: 55 } });
    const check = mapListingSettingWriteError(pgError({
      code: "23514", constraint: "dropship_product_listing_setting_revision_text_chk",
      detail: "Failing row contains (1, 10, 22, 7, vendor text ...).",
    })) as DropshipError;
    expect(JSON.stringify(check.context)).not.toContain("vendor text");
  });

  it.each([
    // The size price revision's own identity: no request key is in it, so it is not a key reuse.
    ["a unique violation on another constraint", { code: "23505", constraint: "dropship_listing_price_revision_identity_uk" }],
    ["a foreign key violation on the owner", { code: "23503", constraint: "dropship_product_listing_setting_owner_fk" }],
    ["a lock timeout", { code: "55P03" }],
  ])("rethrows %s unchanged", (_label, fields) => {
    const error = pgError(fields);
    expect(mapListingSettingWriteError(error)).toBe(error);
  });

  it("answers a pool that hands out no connection in time, or a refused connection, as BUSY without a statement", async () => {
    for (const failure of [new Error("timeout exceeded when trying to connect"), pgError({ code: "ECONNREFUSED", message: "connect ECONNREFUSED" }),
      pgError({ code: "53300", message: "sorry, too many clients already" })]) {
      const connect = vi.fn(async () => { throw failure; });
      const repository = new PgDropshipListingSettingWritesRepository({ connect } as unknown as Pool);
      const operation = vi.fn(async () => "never");

      const error = await repository.execute(INPUT, operation).then(() => null, (reason: unknown) => reason);

      expect(error).toBeInstanceOf(DropshipError);
      expect(error).toMatchObject({ code: "DROPSHIP_LISTING_SETTINGS_BUSY", context: { retryable: true, classification: "transient" } });
      expect(operation).not.toHaveBeenCalled();
    }
  });

  it("rethrows any other failure to connect unchanged: a wrong password is a fault, not a busy database", async () => {
    const failure = pgError({ code: "28P01", message: "password authentication failed" });
    const connect = vi.fn(async () => { throw failure; });
    const repository = new PgDropshipListingSettingWritesRepository({ connect } as unknown as Pool);

    await expect(repository.execute(INPUT, async () => "never")).rejects.toBe(failure);
  });

  it("passes a DropshipError and a plain error through unchanged", async () => {
    const dropshipError = new DropshipError("DROPSHIP_PRODUCT_LISTING_SETTINGS_VERSION_CONFLICT", "stale", { retryable: false });
    const plain = new Error("boom");
    expect(mapListingSettingWriteError(dropshipError)).toBe(dropshipError);
    expect(mapListingSettingWriteError(plain)).toBe(plain);

    const { repository } = setup();
    await expect(repository.execute(INPUT, async () => { throw dropshipError; })).rejects.toBe(dropshipError);
  });
});

describe("PgDropshipListingSettingWritesRepository.executeForSystem", () => {
  const SYSTEM_INPUT = { storeConnectionId: STORE, jobKey: "category-marks:first:2026-10-10" };

  it("takes the store lock and the owner rows by store, with no request lock", async () => {
    const { client, repository } = setup();

    await repository.executeForSystem(SYSTEM_INPUT, async () => undefined);

    expect(client.sql[0]).toBe("BEGIN");
    expect(client.sql[1]).toBe("SELECT pg_advisory_xact_lock(hashtext('dropship_listing_push_job'), $1::integer)");
    expect(client.params[1]).toEqual([STORE]);
    expect(client.sql[2]).toContain("WHERE sc.id = $1 FOR SHARE OF v, sc");
    expect(client.params[2]).toEqual([STORE]);
    expect(client.sql.slice(3)).toEqual(["COMMIT"]);
    expect(client.sql.some((sql) => sql.includes("dropship_listing_settings_request"))).toBe(false);
  });

  it("has no price, rules, content or vendor writers, and writes first marks as the job", async () => {
    const { repository } = setup();
    let seen: ListingSettingSystemTransaction | undefined;

    await repository.executeForSystem(SYSTEM_INPUT, async (tx) => {
      seen = tx;
      await tx.insertFirstCategoryMarks({ productIds: [7], jobKey: SYSTEM_INPUT.jobKey, now: NOW });
    });

    const keys = Object.keys(seen!);
    for (const absent of ["sizePrice", "saveListingContent", "saveEbayCategoryRulesProfile", "saveProduct", "saveProductsBulk",
      "saveCategory", "acknowledgeCategoryMoves", "lockCatalog"]) {
      expect(keys).not.toContain(absent);
    }
    expect(writers.insertFirstCategoryMarksWithClient).toHaveBeenCalledWith(expect.anything(), {
      vendorId: VENDOR, storeConnectionId: STORE, actor: { actorType: "system", actorId: SYSTEM_INPUT.jobKey },
    }, { productIds: [7], jobKey: SYSTEM_INPUT.jobKey, now: NOW });
  });

  it("refuses first marks for another job key, a blank job key and an unknown store", async () => {
    const other = setup();
    await expectInvariant(other.repository.executeForSystem(SYSTEM_INPUT,
      (tx) => tx.insertFirstCategoryMarks({ productIds: [7], jobKey: "another-job", now: NOW })));
    expect(writers.insertFirstCategoryMarksWithClient).not.toHaveBeenCalled();

    const blank = setup();
    await expectInvariant(blank.repository.executeForSystem({ ...SYSTEM_INPUT, jobKey: " " }, async () => undefined));
    expect(blank.connect).not.toHaveBeenCalled();

    const missing = setup();
    missing.client.ownerFound = false;
    await expect(missing.repository.executeForSystem(SYSTEM_INPUT, async () => undefined))
      .rejects.toMatchObject({ code: "DROPSHIP_STORE_CONNECTION_REQUIRED" });
    expect(missing.client.sql.at(-1)).toBe("ROLLBACK");
  });
});

describe("the replay probe, findRequestKeyUse (plan PR 9, section 4.6)", () => {
  const probeIndex = (client: ScriptedClient) => client.sql.findIndex((sql) => sql.startsWith("SELECT 'product' AS source"));
  const row = (fields: Record<string, unknown>) => ({
    source: "size", id: 31, store_connection_id: STORE, target_id: 101, request_hash: HASH, request_id: null, operation: null, ...fields,
  });

  it("is one statement on the transaction's client, every branch the vendor's, with the key and its four child prefixes", async () => {
    const { client, repository } = setup();

    const use = await repository.execute(INPUT, (tx) => tx.findRequestKeyUse());

    expect(use).toEqual({ productRevision: null, categoryRevision: null, ledger: null, children: [] });
    const statements = client.sql.filter((sql) => sql.startsWith("SELECT 'product' AS source"));
    expect(statements).toHaveLength(1);
    const index = probeIndex(client);
    expect(client.params[index]).toEqual([VENDOR, KEY,
      listingSettingChildKeyPrefix(KEY, "size"), listingSettingChildKeyPrefix(KEY, "policy"),
      listingSettingChildKeyPrefix(KEY, "shelf"), listingSettingChildKeyPrefix(KEY, "content")]);
    const sql = client.sql[index];
    const branches = sql.split(" UNION ALL ");
    expect(branches).toHaveLength(7);
    for (const branch of branches) expect(branch).toMatch(/WHERE [rq]\.vendor_id = \$1 AND /);
    // The parent tables by the key itself, the child tables by prefix, compared with left(), never LIKE.
    expect(branches.slice(0, 3).every((branch) => / [rq]\.idempotency_key = \$2$/.test(branch))).toBe(true);
    expect(branches.slice(3).map((branch) => /left\(r\.idempotency_key, length\((\$\d)::text\)\) = \1::text$/.exec(branch)?.[1]))
      .toEqual(["$3", "$4", "$5", "$6"]);
    expect(sql).not.toMatch(/\b(LIKE|FOR UPDATE|FOR SHARE|LOCK TABLE|pg_advisory)/i);
    for (const table of ["dropship_product_listing_setting_revisions", "dropship_category_listing_setting_revisions",
      "dropship_product_listing_setting_requests", "dropship_listing_price_revisions", "dropship_ebay_listing_policy_override_revisions",
      "dropship_ebay_store_category_assignment_revisions", "dropship_listing_content_revisions"]) {
      expect(sql).toContain(`FROM dropship.${table} `);
    }
    // Between the owner rows and COMMIT, the probe is the only statement.
    expect(client.afterOwner()).toEqual([sql, "COMMIT"]);
  });

  it("runs before lockCatalog without taking its place: the catalog can still be locked after it", async () => {
    const { client, repository } = setup();

    await repository.execute(INPUT, async (tx) => {
      await tx.findRequestKeyUse();
      await tx.lockCatalog({ productIds: [7], productVariantIds: [101] });
    });

    const after = client.afterOwner();
    expect(after[0]).toMatch(/^SELECT 'product' AS source/);
    expect(after[1]).toMatch(/^LOCK TABLE/);
  });

  it("parses every source, bigint ids as strings included, and lists children by kind, size and revision", async () => {
    const { client, repository } = setup();
    client.probeRows = [
      row({ source: "content", id: 90, target_id: 102 }),
      row({ source: "size", id: 41, target_id: 102 }),
      row({ source: "size", id: 40, target_id: 101 }),
      row({ source: "policy", id: 70, target_id: 101 }),
      row({ source: "shelf", id: 80, target_id: 101 }),
      row({ source: "product", id: "12", target_id: 7, request_id: null }),
      row({ source: "category", id: 13, target_id: 3 }),
      row({ source: "ledger", id: "9007199254740991", target_id: null, operation: "category_settings_clear" }),
    ];

    const use = await repository.execute(INPUT, (tx) => tx.findRequestKeyUse());

    expect(use).toEqual({
      productRevision: { revisionId: 12, productId: 7, storeConnectionId: STORE, requestHash: HASH, requestId: null },
      categoryRevision: { revisionId: 13, categoryId: 3, storeConnectionId: STORE, requestHash: HASH },
      ledger: { requestId: 9_007_199_254_740_991, operation: "category_settings_clear", storeConnectionId: STORE, requestHash: HASH },
      children: [
        { kind: "size", revisionId: 40, productVariantId: 101, storeConnectionId: STORE, requestHash: HASH },
        { kind: "size", revisionId: 41, productVariantId: 102, storeConnectionId: STORE, requestHash: HASH },
        { kind: "policy", revisionId: 70, productVariantId: 101, storeConnectionId: STORE, requestHash: HASH },
        { kind: "shelf", revisionId: 80, productVariantId: 101, storeConnectionId: STORE, requestHash: HASH },
        { kind: "content", revisionId: 90, productVariantId: 102, storeConnectionId: STORE, requestHash: HASH },
      ],
    });
    expect(client.sql.at(-1)).toBe("COMMIT");
  });

  it("keeps a product revision's ledger id", async () => {
    const { client, repository } = setup();
    client.probeRows = [row({ source: "product", id: 12, target_id: 7, request_id: "55" })];
    const use = await repository.execute(INPUT, (tx) => tx.findRequestKeyUse());
    expect(use.productRevision).toMatchObject({ requestId: 55 });
  });

  it.each([
    ["an unknown source", row({ source: "listing" }), "source"],
    ["a zero id", row({ id: 0 }), "id"],
    ["a fractional id", row({ id: 1.5 }), "id"],
    ["an id that is not a number", row({ id: "12a" }), "id"],
    ["a bigint past the safe integers", row({ id: "9007199254740993" }), "id"],
    ["a missing store", row({ store_connection_id: null }), "store_connection_id"],
    ["a size with no id", row({ target_id: null }), "target_id"],
    ["a hash that is not 64 hex characters", row({ request_hash: "A".repeat(64) }), "request_hash"],
    ["a ledger operation the ledger never holds", row({ source: "ledger", target_id: null, operation: "price_change_apply" }), "operation"],
    ["a product revision with a bad ledger id", row({ source: "product", target_id: 7, request_id: "0" }), "request_id"],
  ])("refuses %s as a broken contract, and rolls back", async (_label, bad, column) => {
    const { client, repository } = setup();
    client.probeRows = [bad];

    const error = await expectInvariant(repository.execute(INPUT, (tx) => tx.findRequestKeyUse()));

    expect(error.context).toMatchObject({ column });
    expect(client.sql.at(-1)).toBe("ROLLBACK");
  });

  it("refuses a second product revision, category revision or ledger row under one key", async () => {
    for (const source of ["product", "category", "ledger"]) {
      const { client, repository } = setup();
      const one = row({ source, target_id: source === "ledger" ? null : 7, operation: source === "ledger" ? "product_settings_bulk" : null });
      client.probeRows = [one, { ...one, id: 32 }];
      await expectInvariant(repository.execute(INPUT, (tx) => tx.findRequestKeyUse()));
    }
  });

  it("refuses to run after the transaction ended", async () => {
    const { repository } = setup();
    let kept: ListingSettingWriteTransaction | undefined;
    await repository.execute(INPUT, async (tx) => { kept = tx; });
    await expectInvariant(kept!.findRequestKeyUse());
  });
});

describe("lockCatalog's locked products (plan PR 9, 6.2 #3, C-money-2)", () => {
  it("returns exactly the products the lock statement found, ascending: a deleted product is not among them", async () => {
    const { client, repository } = setup();
    client.existingProductIds = new Set([7]);

    const locked = await repository.execute(INPUT, (tx) => tx.lockCatalog({ productIds: [9, 7, 7] }));

    expect(locked).toEqual({ lockedProductIds: [7] });
    expect(await repository.execute(INPUT, (tx) => tx.lockCatalog({ productVariantIds: [101] }))).toEqual({ lockedProductIds: [] });
  });
});

describe("clearSizeLeftovers (plan PR 9, P17, 6.2 #3)", () => {
  const clear = { productIds: [7], fields: ["storeShelf"] as const, requestHash: HASH, now: NOW };

  it("runs the clean-up on the transaction's client with its scope, for products lockCatalog locked", async () => {
    const { client, repository } = setup();

    const result = await repository.execute(INPUT, async (tx) => {
      await tx.lockCatalog({ productIds: [7, 8] });
      return tx.clearSizeLeftovers({ ...clear, productIds: [7, 8] });
    });

    expect(result).toEqual({ clearedSizeCount: 1, byKind: { policy: 1, shelf: 0, content: 0 }, productVariantIds: [101] });
    expect(writers.clearSizeLeftoversWithClient).toHaveBeenCalledWith(expect.anything(),
      { vendorId: VENDOR, storeConnectionId: STORE, actor: { actorType: "vendor", actorId: MEMBER }, requestKey: KEY },
      { ...clear, productIds: [7, 8] });
    expect(client.sql.at(-2)).toBe("-- writer: clearSizeLeftovers");
    expect(client.sql.at(-1)).toBe("COMMIT");
  });

  it("is refused a second time, with no fields, with no products, and for a product lockCatalog did not lock", async () => {
    const twice = setup();
    await expectInvariant(twice.repository.execute(INPUT, async (tx) => {
      await tx.lockCatalog({ productIds: [7] });
      await tx.clearSizeLeftovers(clear);
      await tx.clearSizeLeftovers(clear);
    }));
    expect(writers.clearSizeLeftoversWithClient).toHaveBeenCalledTimes(1);

    for (const input of [{ ...clear, fields: [] }, { ...clear, productIds: [] }, { ...clear, productIds: [7, 9] }]) {
      vi.mocked(writers.clearSizeLeftoversWithClient).mockClear();
      const { client, repository } = setup();
      client.existingProductIds = new Set([7]);
      await expectInvariant(repository.execute(INPUT, async (tx) => {
        await tx.lockCatalog({ productIds: [7, 9] });
        await tx.clearSizeLeftovers(input);
      }));
      expect(writers.clearSizeLeftoversWithClient).not.toHaveBeenCalled();
    }

    // Without lockCatalog nothing is locked, so nothing may be cleaned.
    const unlocked = setup();
    await expectInvariant(unlocked.repository.execute(INPUT, (tx) => tx.clearSizeLeftovers(clear)));
  });

  it("never shares a transaction's content child keys: a main-text clean-up and a description save refuse each other (D30)", async () => {
    const content = (id: number) => contentSave(listingSettingChildKey(KEY, "content", id));
    const mainText = { ...clear, fields: ["mainText"] as const };

    const saveFirst = setup();
    await expectInvariant(saveFirst.repository.execute(INPUT, async (tx) => {
      await tx.lockCatalog({ productIds: [7], productVariantIds: [101] });
      await tx.saveListingContent(101, content(101), HASH, NOW);
      await tx.clearSizeLeftovers(mainText);
    }));
    expect(writers.clearSizeLeftoversWithClient).not.toHaveBeenCalled();

    vi.clearAllMocks();
    const clearFirst = setup();
    const refused = await expectInvariant(clearFirst.repository.execute(INPUT, async (tx) => {
      await tx.lockCatalog({ productIds: [7], productVariantIds: [101] });
      await tx.clearSizeLeftovers(mainText);
      await tx.saveListingContent(101, content(101), HASH, NOW);
    }));
    expect(refused.context).toMatchObject({ productVariantId: "101" });
    expect(writers.saveListingContentWithClient).not.toHaveBeenCalled();

    vi.clearAllMocks();
    // A clean-up that leaves the main text alone writes no content key, so a description save may share its transaction.
    const other = setup();
    await other.repository.execute(INPUT, async (tx) => {
      await tx.lockCatalog({ productIds: [7], productVariantIds: [101] });
      await tx.saveListingContent(101, content(101), HASH, NOW);
      await tx.clearSizeLeftovers(clear);
    });
    expect(writers.saveListingContentWithClient).toHaveBeenCalledTimes(1);
    expect(writers.clearSizeLeftoversWithClient).toHaveBeenCalledTimes(1);
  });

  it("ends lockCatalog's window: a clean-up is a write", async () => {
    const { repository } = setup();
    await expectInvariant(repository.execute(INPUT, async (tx) => {
      await tx.lockCatalog({ productIds: [7] });
      await tx.clearSizeLeftovers(clear);
      await tx.lockCatalog({});
    }));
  });
});

describe("the W5 reads (plan PR 9, 6.2 #1, #2, #6)", () => {
  it("lists the products' sellable sizes ascending with the selected-catalog scan's filter, and reads nothing for no products", async () => {
    const { client, repository } = setup();

    const sizes = await repository.execute(INPUT, (tx) => tx.listProductSizes([8, 7, 8]));

    expect(sizes).toEqual([101, 102, 103]);
    const index = client.sql.findIndex((sql) => sql.startsWith("SELECT id FROM catalog.product_variants WHERE product_id"));
    expect(client.sql[index]).toBe("SELECT id FROM catalog.product_variants WHERE product_id = ANY($1::int[]) AND requires_shipping = true "
      + "AND COALESCE(track_inventory, true) = true AND sales_eligibility = 'sellable' ORDER BY id");
    expect(client.params[index]).toEqual([[7, 8]]);
    expect(client.sql[index]).not.toMatch(/FOR (SHARE|UPDATE)/);

    const none = setup();
    await expect(none.repository.execute(INPUT, (tx) => tx.listProductSizes([]))).resolves.toEqual([]);
    expect(none.client.afterOwner()).toEqual(["COMMIT"]);
  });

  it("refuses a size id the catalog read returned out of contract", async () => {
    const { client, repository } = setup();
    client.productSizes = new Map([[7, [0]]]);
    await expectInvariant(repository.execute(INPUT, (tx) => tx.listProductSizes([7])));
  });

  it("reads the pricing profile and the .ops costs on the transaction's client, the costs in a savepoint, never a BEGIN", async () => {
    const { client, repository } = setup();

    await repository.execute(INPUT, async (tx) => {
      await expect(tx.loadPricingProfile()).resolves.toEqual({ revisionId: null, profile: null, updatedAt: null });
      await tx.loadProductCosts([101]);
    });

    const after = client.afterOwner();
    expect(after[0]).toContain("FROM dropship.dropship_pricing_profiles p");
    expect(client.params[client.sql.indexOf(after[0])]).toEqual([STORE, VENDOR]);
    expect(after).toContain("SAVEPOINT dropship_product_cost_read");
    expect(after.filter((sql) => sql.startsWith("BEGIN"))).toEqual([]);
    expect(after.at(-1)).toBe("COMMIT");
  });

  it("counts the store's saved product text in one statement: vendor and store scoped, no text selected, the UTF8 check returned", async () => {
    const { client, repository } = setup();

    const bytes = await repository.execute(INPUT, (tx) => tx.readListingTextBytes({ productIds: [8, 7],
      replacedFields: { textAbove: true, textBelow: false, mainText: true } }));

    expect(bytes).toEqual({ storeBytes: 1_200, keptStoreBytes: 1_000, targetBytes: 300 });
    const index = client.sql.findIndex((sql) => sql.startsWith("SELECT current_setting('server_encoding')"));
    const sql = client.sql[index];
    expect(client.params[index]).toEqual([VENDOR, STORE, [7, 8], true, false, true]);
    expect(sql).toMatch(/WHERE s\.vendor_id = \$1 AND s\.store_connection_id = \$2$/);
    // Lengths only: every text column appears inside octet_length(...), none is selected.
    expect(sql.replace(/octet_length\(r\.(text_above|text_below|body_text)\)/g, "")).not.toMatch(/text_above|text_below|body_text/);
    expect(sql).not.toMatch(/convert_to|FOR (SHARE|UPDATE)/);
    expect(client.afterOwner()).toEqual([sql, "COMMIT"]);
  });

  it.each([
    ["a server that is not UTF8", { utf8: false }],
    ["a missing encoding check", { utf8: null }],
    ["a sum that is not a whole number", { store_bytes: "12.5" }],
    ["a negative sum", { kept_store_bytes: "-1" }],
    ["a sum past the safe integers", { target_bytes: "90071992547409930" }],
    ["a sum sent as a number", { store_bytes: 12 }],
  ])("refuses %s as a broken contract", async (_label, fields) => {
    const { client, repository } = setup();
    client.textBytes = { ...client.textBytes, ...fields };
    await expectInvariant(repository.execute(INPUT, (tx) => tx.readListingTextBytes({ productIds: [7],
      replacedFields: { textAbove: false, textBelow: false, mainText: false } })));
    expect(client.sql.at(-1)).toBe("ROLLBACK");
  });

  it("types tx.catalog without the five readers that commit on the transaction's client (plan 6.2 #2, R9)", () => {
    type Catalog = ListingSettingWriteTransaction["catalog"];
    expectTypeOf<keyof Catalog>().toEqualTypeOf<"loadStoreContext" | "listCatalogCandidates" | "listCatalogExposureRules"
      | "listSelectionRules" | "listVariantOverrides" | "listExistingListings" | "listSavedListingPrices" | "listPricingPolicies"
      | "getStoreListingConfig">();
    expectTypeOf<keyof ListingSettingPreflightTransaction["catalog"]>().toEqualTypeOf<"loadStoreContext" | "getStoreListingConfig">();
    // Never called: these lines are checked by the compiler (npm run check:tests), each a self-committing reader.
    const unreachable = (catalog: Catalog) => [
      // @ts-expect-error loadRulePrices runs its own BEGIN ... COMMIT on the transaction's client.
      catalog.loadRulePrices,
      // @ts-expect-error loadListingSettingLayers runs its own BEGIN ... COMMIT on the transaction's client.
      catalog.loadListingSettingLayers,
      // @ts-expect-error loadListingContents runs its own BEGIN ... COMMIT on the transaction's client.
      catalog.loadListingContents,
      // @ts-expect-error loadEbayCategories runs its own BEGIN ... COMMIT on the transaction's client.
      catalog.loadEbayCategories,
      // @ts-expect-error createListingPushJob runs its own BEGIN ... COMMIT on the transaction's client.
      catalog.createListingPushJob,
    ];
    expect(typeof unreachable).toBe("function");
  });
});

describe("PgDropshipListingSettingWritesRepository.preflight (plan PR 9, 6.2 #4)", () => {
  const PREFLIGHT = { memberId: MEMBER, storeConnectionId: STORE, idempotencyKey: KEY };

  it("opens a read-only snapshot, reads the owner rows without a lock, and takes no advisory lock", async () => {
    const { client, repository } = setup();

    await repository.preflight(PREFLIGHT, async (tx) => {
      expect({ vendorId: tx.vendorId, storeConnectionId: tx.storeConnectionId }).toEqual({ vendorId: VENDOR, storeConnectionId: STORE });
      await tx.findRequestKeyUse();
      await tx.loadProducts([7]);
      await tx.loadCategories([3]);
    });

    expect(client.sql[0]).toBe("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    expect(client.sql[1]).toBe("SELECT v.id AS vendor_id FROM dropship.dropship_vendors v "
      + "JOIN dropship.dropship_store_connections sc ON sc.vendor_id = v.id WHERE v.member_id::text = $1 AND sc.id = $2");
    expect(client.params[1]).toEqual([MEMBER, STORE]);
    expect(client.sql[2]).toMatch(/^SELECT 'product' AS source/);
    expect(client.sql.slice(3)).toEqual(["-- writer: readProducts", "-- writer: readCategories", "COMMIT"]);
    expect(client.sql.some((sql) => /pg_advisory|FOR SHARE|FOR UPDATE|LOCK TABLE/.test(sql))).toBe(false);
    expect(writers.readProductListingSettings).toHaveBeenCalledWith(expect.anything(), { vendorId: VENDOR, storeConnectionId: STORE, productIds: [7] });
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("has no writer, no lockCatalog and no size price, and refuses the probe without a key", async () => {
    const { repository } = setup();
    let seen: ListingSettingPreflightTransaction | undefined;
    await repository.preflight({ ...PREFLIGHT, idempotencyKey: null }, async (tx) => { seen = tx; });
    for (const absent of ["saveProduct", "saveProductsBulk", "saveCategory", "lockCatalog", "sizePrice", "clearSizeLeftovers",
      "readListingTextBytes"]) {
      expect(Object.keys(seen!)).not.toContain(absent);
    }
    await expectInvariant(repository.preflight({ ...PREFLIGHT, idempotencyKey: null }, (tx) => tx.findRequestKeyUse()));
  });

  it("answers another member's store as not found, and refuses a bad input before taking a connection", async () => {
    const missing = setup();
    missing.client.ownerFound = false;
    await expect(missing.repository.preflight(PREFLIGHT, async () => "never")).rejects.toMatchObject({ code: "DROPSHIP_STORE_CONNECTION_REQUIRED" });
    expect(missing.client.sql.at(-1)).toBe("ROLLBACK");

    for (const input of [{ ...PREFLIGHT, memberId: " " }, { ...PREFLIGHT, storeConnectionId: 0 }, { ...PREFLIGHT, idempotencyKey: "short" }]) {
      const { connect, repository } = setup();
      await expectInvariant(repository.preflight(input, async () => "never"));
      expect(connect).not.toHaveBeenCalled();
    }
  });

  it("refuses every call once it ended", async () => {
    const { repository } = setup();
    let kept: ListingSettingPreflightTransaction | undefined;
    await repository.preflight(PREFLIGHT, async (tx) => { kept = tx; });
    await expectInvariant(kept!.loadProducts([7]));
    await expectInvariant(kept!.findRequestKeyUse());
  });
});
