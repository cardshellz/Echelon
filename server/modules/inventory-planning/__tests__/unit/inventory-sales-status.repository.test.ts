import type { Pool } from "pg";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SalesStatusChangeResult } from "@shared/types/inventory-sales-status";

import type { SalesStatusCommand } from "../../application/inventory-sales-status.service";
import { InventoryAvailabilityRuntimePublicationError } from "../../application/inventory-availability-runtime-publication.service";
import {
  PostgresSalesStatusStore,
  SALES_STATUS_INLINE_REPUBLISH_MAX_PRODUCTS,
} from "../../infrastructure/inventory-sales-status.repository";

const { publishProduct } = vi.hoisted(() => ({ publishProduct: vi.fn() }));
vi.mock("../../infrastructure/inventory-availability-runtime-publication.repository", () => ({
  createTransactionScopedInventoryPublicationService: vi.fn(() => ({ publishProduct })),
}));
vi.mock("../../../../db", () => ({ pool: {}, db: {} }));

const NOW = new Date("2026-11-07T15:00:00.000Z");
const HASH = "c".repeat(64);
const SKU_EVERYWHERE = { channelId: null, productId: 11, productVariantId: 22 };
const SKU_ON_SHOPIFY = { channelId: 36, productId: 11, productVariantId: 22 };

function command(overrides: Partial<SalesStatusCommand> = {}): SalesStatusCommand {
  return {
    changes: [{ scope: SKU_EVERYWHERE, status: "stopped", expectedRevision: null }],
    note: "Supplier recall",
    idempotencyKey: "sales-status:test-1",
    actorId: "admin",
    requestHash: HASH,
    occurredAt: NOW,
    ...overrides,
  };
}

function setting(input: { id: number; channelId: number | null; productVariantId: number | null; status: string; revision: string }) {
  return {
    id: input.id, channel_id: input.channelId, item_product_id: 11, product_variant_id: input.productVariantId,
    status: input.status, note: null, revision: input.revision, updated_by: "operator-2", updated_at: new Date("2026-11-06T10:00:00.000Z"),
  };
}

interface FakeOptions {
  authority?: "canonical" | "legacy";
  receipt?: { request_hash: string; response_body: unknown };
  settings?: ReturnType<typeof setting>[];
  products?: number[];
  variants?: Array<{ id: number; product_id: number }>;
  channels?: number[];
  updateRowCount?: number;
  failOn?: (sql: string) => unknown;
}

function fakeDatabase(options: FakeOptions = {}) {
  const statements: Array<{ sql: string; params: unknown[] }> = [];
  let revision = 100;
  const query = vi.fn(async (text: string, params: unknown[] = []) => {
    const sql = text.trim().replace(/\s+/g, " ");
    statements.push({ sql, params });
    const failure = options.failOn?.(sql);
    if (failure) throw failure;
    if (/^(BEGIN|SET LOCAL|COMMIT|ROLLBACK|SAVEPOINT|RELEASE SAVEPOINT)/.test(sql)) return { rows: [], rowCount: 0 };
    if (sql.startsWith("SELECT request_hash, response_body FROM public.idempotency_keys")) {
      return { rows: options.receipt ? [options.receipt] : [] };
    }
    if (sql.startsWith("INSERT INTO public.idempotency_keys") || sql.startsWith("UPDATE public.idempotency_keys")) return { rows: [], rowCount: 1 };
    if (sql.startsWith("SELECT authority FROM inventory.availability_runtime_authority")) return { rows: [{ authority: options.authority ?? "canonical" }] };
    if (sql.startsWith("SELECT id FROM catalog.products")) return { rows: (options.products ?? [11, 12]).map((id) => ({ id })) };
    if (sql.startsWith("SELECT id, product_id FROM catalog.product_variants")) {
      return { rows: options.variants ?? [{ id: 21, product_id: 11 }, { id: 22, product_id: 11 }] };
    }
    if (sql.startsWith("SELECT id FROM channels.channels")) return { rows: (options.channels ?? [36, 67]).map((id) => ({ id })) };
    if (sql.includes("FROM inventory.sales_statuses AS setting") && sql.includes("FOR UPDATE OF setting")) return { rows: options.settings ?? [] };
    if (sql.startsWith("INSERT INTO inventory.sales_statuses")) return { rows: [{ revision: String(++revision) }], rowCount: 1 };
    if (sql.startsWith("UPDATE inventory.sales_statuses")) {
      return options.updateRowCount === 0 ? { rows: [], rowCount: 0 } : { rows: [{ revision: String(++revision) }], rowCount: 1 };
    }
    if (sql.startsWith("DELETE FROM inventory.sales_statuses")) return { rows: [], rowCount: 1 };
    if (sql.startsWith("INSERT INTO inventory.sales_status_events")) return { rows: [], rowCount: 1 };
    if (sql.startsWith("SELECT inventory.invalidate_publication_selection_product")) return { rows: [] };
    throw new Error(`Unexpected SQL: ${sql}`);
  });
  const client = { query, release: vi.fn() };
  // Only query/release are used; the store never touches the rest of a PoolClient.
  return { pool: { connect: vi.fn(async () => client) } as unknown as Pick<Pool, "connect">, client, statements };
}

const canonicalPublication = (productId: number, overrides: Record<string, unknown> = {}) => ({
  authority: "canonical",
  publication: { productId, enqueuedRows: 2, blockedTargets: [], ...overrides },
});

const kinds = (statements: Array<{ sql: string }>) => statements.map(({ sql }) => sql.split(" WHERE")[0]!);
const writes = (statements: Array<{ sql: string; params: unknown[] }>, prefix: string) =>
  statements.filter(({ sql }) => sql.startsWith(prefix));

describe("PostgresSalesStatusStore.change", () => {
  beforeEach(() => {
    publishProduct.mockReset().mockImplementation(async ({ productId }: { productId: number }) => canonicalPublication(productId));
  });

  it("stops a SKU everywhere in one serializable transaction: key first, setting, history, republish, receipt", async () => {
    publishProduct.mockResolvedValueOnce(canonicalPublication(11, { blockedTargets: [{ publicationTargetId: 3, channelId: 67,
      channelName: "Ebay", errorCode: "CANONICAL_PUBLICATION_MAPPING_MISSING", blockerCodes: [], productVariantIds: [], isolation: "target" }] }));
    const database = fakeDatabase();

    const result = await new PostgresSalesStatusStore(database.pool).change(command());

    expect(result).toEqual({
      changes: [{ scopeKey: "all:variant:22", scope: SKU_EVERYWHERE, before: null, after: { status: "stopped", revision: "101" }, changed: true }],
      affectedProductIds: [11],
      republished: [{ productId: 11, publicationRows: 2, skippedDestinations: [
        { publicationTargetId: 3, channelId: 67, channelName: "Ebay", errorCode: "CANONICAL_PUBLICATION_MAPPING_MISSING" }] }],
      queued: [],
      alreadyApplied: false,
      providerWriteAttempted: false,
    } satisfies SalesStatusChangeResult);
    const sql = database.statements.map(({ sql }) => sql);
    expect(sql[0]).toBe("BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE");
    const order = ["INSERT INTO public.idempotency_keys", "SELECT authority FROM inventory.availability_runtime_authority",
      "INSERT INTO inventory.sales_statuses", "INSERT INTO inventory.sales_status_events", "SAVEPOINT sales_status_product",
      "RELEASE SAVEPOINT sales_status_product", "UPDATE public.idempotency_keys", "COMMIT"]
      .map((prefix) => sql.findIndex((statement) => statement.startsWith(prefix)));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((left, right) => left - right)).toEqual(order);
    expect(sql.find((statement) => statement.startsWith("SELECT authority"))).toContain("FOR SHARE");
    // A SKU setting stores only the SKU; the product id stays on the history row.
    expect(writes(database.statements, "INSERT INTO inventory.sales_statuses")[0]!.params)
      .toEqual([null, null, 22, "stopped", "Supplier recall", "admin", NOW]);
    expect(writes(database.statements, "INSERT INTO inventory.sales_status_events")[0]!.params)
      .toEqual(["sales-status:test-1", HASH, null, 11, 22, null, "stopped", null, "101", "Supplier recall", "admin", NOW]);
    expect(publishProduct).toHaveBeenCalledWith(
      { productId: 11, dryRun: false, triggeredBy: "sales_status_change", blockedTargets: "isolate" }, expect.any(Function));
    const receipt = writes(database.statements, "UPDATE public.idempotency_keys")[0]!.params;
    expect(receipt[0]).toBe("inventory-sales-status:sales-status:test-1");
    expect(JSON.parse(String(receipt[1]))).toEqual({ commandType: "inventory_sales_status_change", result });
    expect(database.client.release).toHaveBeenCalledWith(undefined);
  });

  it("updates an existing channel setting only at the revision the operator saw, and records before and after", async () => {
    const database = fakeDatabase({ settings: [setting({ id: 7, channelId: 36, productVariantId: 22, status: "selling", revision: "55" })] });

    const result = await new PostgresSalesStatusStore(database.pool).change(command({
      changes: [{ scope: SKU_ON_SHOPIFY, status: "stopped", expectedRevision: "55" }], note: null,
    }));

    expect(result.changes).toEqual([{ scopeKey: "channel:36:variant:22", scope: SKU_ON_SHOPIFY,
      before: { status: "selling", revision: "55" }, after: { status: "stopped", revision: "101" }, changed: true }]);
    expect(writes(database.statements, "UPDATE inventory.sales_statuses")[0]!.params).toEqual([7, "55", "stopped", null, "admin", NOW]);
    expect(writes(database.statements, "INSERT INTO inventory.sales_status_events")[0]!.params)
      .toEqual(["sales-status:test-1", HASH, 36, 11, 22, "selling", "stopped", "55", "101", null, "admin", NOW]);
  });

  it("resumes by removing the setting at its revision, and records the removal", async () => {
    const database = fakeDatabase({ settings: [setting({ id: 9, channelId: null, productVariantId: 22, status: "stopped", revision: "60" })] });

    const result = await new PostgresSalesStatusStore(database.pool).change(command({
      changes: [{ scope: SKU_EVERYWHERE, status: "inherit", expectedRevision: "60" }],
    }));

    expect(result.changes[0]).toMatchObject({ before: { status: "stopped", revision: "60" }, after: null, changed: true });
    expect(writes(database.statements, "DELETE FROM inventory.sales_statuses")[0]!.params).toEqual([9, "60"]);
    expect(writes(database.statements, "INSERT INTO inventory.sales_status_events")[0]!.params.slice(5, 9))
      .toEqual(["stopped", null, "60", null]);
    expect(publishProduct).toHaveBeenCalledTimes(1);
  });

  it("leaves a scope already in the requested state alone: no write, no history, no republish", async () => {
    const database = fakeDatabase({ settings: [setting({ id: 9, channelId: null, productVariantId: 22, status: "stopped", revision: "60" })] });

    const result = await new PostgresSalesStatusStore(database.pool).change(command({
      changes: [{ scope: SKU_EVERYWHERE, status: "stopped", expectedRevision: "60" }],
    }));

    expect(result).toMatchObject({ affectedProductIds: [], republished: [], queued: [],
      changes: [{ before: { status: "stopped", revision: "60" }, after: { status: "stopped", revision: "60" }, changed: false }] });
    expect(database.statements.some(({ sql }) => /^(INSERT INTO inventory|UPDATE inventory|DELETE FROM inventory)/.test(sql))).toBe(false);
    expect(publishProduct).not.toHaveBeenCalled();
  });

  it("refuses a stale view, writes nothing and rolls back", async () => {
    const database = fakeDatabase({ settings: [setting({ id: 9, channelId: null, productVariantId: 22, status: "stopped", revision: "61" })] });

    await expect(new PostgresSalesStatusStore(database.pool).change(command({
      changes: [{ scope: SKU_EVERYWHERE, status: "inherit", expectedRevision: "60" }],
    }))).rejects.toMatchObject({ status: 409, code: "SALES_STATUS_CHANGED", classification: "permanent",
      context: { conflicts: [{ scopeKey: "all:variant:22", expectedRevision: "60", currentRevision: "61" }] } });

    expect(database.statements.some(({ sql }) => sql.startsWith("DELETE FROM inventory.sales_statuses"))).toBe(false);
    expect(database.statements.at(-1)!.sql).toBe("ROLLBACK");
  });

  it("refuses while legacy authority publishes, before any setting is written", async () => {
    const database = fakeDatabase({ authority: "legacy" });
    await expect(new PostgresSalesStatusStore(database.pool).change(command()))
      .rejects.toMatchObject({ status: 409, code: "SALES_STATUS_CANONICAL_REQUIRED" });
    expect(database.statements.some(({ sql }) => sql.startsWith("INSERT INTO inventory.sales_statuses"))).toBe(false);
    expect(database.statements.at(-1)!.sql).toBe("ROLLBACK");
  });

  it("refuses a SKU named with another product, and products, SKUs or channels that do not exist", async () => {
    await expect(new PostgresSalesStatusStore(fakeDatabase({ variants: [{ id: 22, product_id: 12 }] }).pool).change(command()))
      .rejects.toMatchObject({ status: 400, code: "SALES_STATUS_SCOPE_MISMATCH", context: { productVariantIds: [22] } });
    await expect(new PostgresSalesStatusStore(fakeDatabase({ products: [], channels: [] }).pool).change(command({
      changes: [{ scope: SKU_ON_SHOPIFY, status: "stopped", expectedRevision: null }],
    }))).rejects.toMatchObject({ status: 404, code: "SALES_STATUS_SCOPE_NOT_FOUND",
      context: { productIds: [11], productVariantIds: [], channelIds: [36] } });
  });

  it("replays the stored result for the same key and input without writing again", async () => {
    const stored = { changes: [{ scopeKey: "all:variant:22", scope: SKU_EVERYWHERE, before: null,
      after: { status: "stopped", revision: "101" }, changed: true }], affectedProductIds: [11],
      republished: [{ productId: 11, publicationRows: 2, skippedDestinations: [] }], queued: [], alreadyApplied: false,
      providerWriteAttempted: false };
    const database = fakeDatabase({ receipt: { request_hash: HASH,
      response_body: { commandType: "inventory_sales_status_change", result: stored } } });

    await expect(new PostgresSalesStatusStore(database.pool).change(command())).resolves.toEqual({ ...stored, alreadyApplied: true });

    expect(kinds(database.statements)).toEqual([
      "BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE", "SET LOCAL lock_timeout = '5s'", "SET LOCAL statement_timeout = '60s'",
      "SELECT request_hash, response_body FROM public.idempotency_keys", "COMMIT",
    ]);
    expect(publishProduct).not.toHaveBeenCalled();
  });

  it("refuses a reused key with different input, and an unreadable receipt", async () => {
    await expect(new PostgresSalesStatusStore(fakeDatabase({ receipt: { request_hash: "d".repeat(64), response_body: null } }).pool)
      .change(command())).rejects.toMatchObject({ status: 409, code: "SALES_STATUS_IDEMPOTENCY_CONFLICT" });
    await expect(new PostgresSalesStatusStore(fakeDatabase({ receipt: { request_hash: HASH, response_body: { commandType: "other" } } }).pool)
      .change(command())).rejects.toMatchObject({ status: 500, code: "SALES_STATUS_RECEIPT_INVALID" });
  });

  it("hands a product the planner refuses to the stock-update worker instead of failing the stop", async () => {
    publishProduct.mockRejectedValueOnce(new InventoryAvailabilityRuntimePublicationError("CANONICAL_CHANNEL_EXPOSURE_VARIANT_MISMATCH", "No."));
    const database = fakeDatabase();

    const result = await new PostgresSalesStatusStore(database.pool).change(command());

    expect(result).toMatchObject({ republished: [], queued: [{ productId: 11, reason: "could_not_republish",
      errorCode: "CANONICAL_CHANNEL_EXPOSURE_VARIANT_MISMATCH" }], changes: [{ changed: true }] });
    const sql = database.statements.map(({ sql: statement }) => statement);
    const rolledBack = sql.indexOf("ROLLBACK TO SAVEPOINT sales_status_product");
    const marked = sql.findIndex((statement) => statement.startsWith("SELECT inventory.invalidate_publication_selection_product"));
    expect(rolledBack).toBeGreaterThan(0);
    expect(marked).toBeGreaterThan(rolledBack);
    expect(database.statements[marked]!.params).toEqual([11]);
    expect(sql.at(-1)).toBe("COMMIT");
  });

  it("rolls the whole change back on a database failure inside republish, as a retryable refusal", async () => {
    publishProduct.mockRejectedValueOnce(Object.assign(new Error("could not serialize access"), { code: "40001" }));
    const database = fakeDatabase();

    await expect(new PostgresSalesStatusStore(database.pool).change(command()))
      .rejects.toMatchObject({ status: 409, code: "SALES_STATUS_BUSY", classification: "transient", context: { sqlstate: "40001" } });

    expect(database.statements.some(({ sql }) => sql === "COMMIT")).toBe(false);
    expect(database.statements.at(-1)!.sql).toBe("ROLLBACK");
  });

  it("queues a large change for the worker instead of planning every product inline", async () => {
    const productIds = Array.from({ length: SALES_STATUS_INLINE_REPUBLISH_MAX_PRODUCTS + 1 }, (_, index) => 100 + index);
    const database = fakeDatabase({ products: productIds });

    const result = await new PostgresSalesStatusStore(database.pool).change(command({
      changes: productIds.map((productId) => ({ scope: { channelId: null, productId, productVariantId: null },
        status: "stopped" as const, expectedRevision: null })),
    }));

    expect(publishProduct).not.toHaveBeenCalled();
    expect(result.queued).toEqual(productIds.map((productId) => ({ productId, reason: "large_change", errorCode: null })));
    expect(writes(database.statements, "SELECT inventory.invalidate_publication_selection_product").map(({ params }) => params[0]))
      .toEqual(productIds);
  });

  it("turns a concurrent insert of the same scope into a retryable refusal", async () => {
    const database = fakeDatabase({ failOn: (sql) => sql.startsWith("INSERT INTO inventory.sales_statuses")
      ? Object.assign(new Error("duplicate key"), { code: "23505" }) : undefined });
    await expect(new PostgresSalesStatusStore(database.pool).change(command()))
      .rejects.toMatchObject({ status: 409, code: "SALES_STATUS_BUSY", classification: "transient" });
  });

  it("refuses when the row changed between lock and write", async () => {
    const database = fakeDatabase({ updateRowCount: 0,
      settings: [setting({ id: 7, channelId: 36, productVariantId: 22, status: "selling", revision: "55" })] });
    await expect(new PostgresSalesStatusStore(database.pool).change(command({
      changes: [{ scope: SKU_ON_SHOPIFY, status: "stopped", expectedRevision: "55" }],
    }))).rejects.toMatchObject({ status: 409, code: "SALES_STATUS_BUSY" });
  });

  it("discards the connection when rollback itself fails", async () => {
    const database = fakeDatabase({ authority: "legacy", failOn: (sql) => sql === "ROLLBACK" ? new Error("socket closed") : undefined });
    await expect(new PostgresSalesStatusStore(database.pool).change(command())).rejects.toMatchObject({ code: "SALES_STATUS_CANONICAL_REQUIRED" });
    expect(database.client.release).toHaveBeenCalledWith(expect.any(Error));
  });
});

describe("PostgresSalesStatusStore reads", () => {
  it("reads a product's SKUs, channels, settings and other holders in one read-only snapshot", async () => {
    const statements: string[] = [];
    const client = {
      release: vi.fn(),
      query: vi.fn(async (text: string) => {
        const sql = text.trim().replace(/\s+/g, " ");
        statements.push(sql);
        if (/^(BEGIN|SET LOCAL|COMMIT)/.test(sql)) return { rows: [] };
        if (sql.startsWith("SELECT id, sku, name FROM catalog.products")) return { rows: [{ id: 11, sku: "TOP-40PT", name: "40PT Toploader" }] };
        if (sql.startsWith("SELECT authority")) return { rows: [{ authority: "canonical" }] };
        if (sql.startsWith("SELECT id, sku, name, units_per_variant")) return { rows: [
          { id: 21, sku: "P25", name: "Pack of 25", units_per_variant: 25, sellable: true },
          { id: 22, sku: "C1000", name: "Case of 1000", units_per_variant: 1000, sellable: true }] };
        if (sql.startsWith("SELECT channel.id")) return { rows: [{ id: 36, name: "Shopify", provider: "shopify", status: "active", publishes_stock: true }] };
        if (sql.includes("FROM inventory.sales_statuses AS setting")) return { rows: [setting({ id: 1, channelId: null, productVariantId: 22, status: "stopped", revision: "5" })] };
        if (sql.includes("inventory_publication_target_variant_holds")) return { rows: [{ publication_target_id: 4, channel_id: 103,
          product_variant_id: 22, reason: "Dropship vendor 10: case tier below minimum", held_by: "dropship-listing-tiers",
          held_at: new Date("2026-11-01T00:00:00.000Z") }] };
        throw new Error(`Unexpected SQL: ${sql}`);
      }),
    };

    const view = await new PostgresSalesStatusStore({ connect: vi.fn(async () => client) } as never).readProduct(11);

    expect(statements[0]).toBe("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    expect(view).toMatchObject({
      runtimeAuthority: "canonical",
      product: { id: 11, sku: "TOP-40PT" },
      variants: [{ id: 21, unitsPerVariant: 25, sellable: true }, { id: 22, unitsPerVariant: 1000, sellable: true }],
      channels: [{ id: 36, publishesStock: true }],
      entries: [{ scopeKey: "all:variant:22", status: "stopped", revision: "5", updatedBy: "operator-2" }],
      otherHolds: [{ publicationTargetId: 4, channelId: 103, productVariantId: 22, heldBy: "dropship-listing-tiers",
        heldAt: "2026-11-01T00:00:00.000Z" }],
    });
    expect(client.release).toHaveBeenCalledWith(undefined);
  });

  it("reports a missing product as not found", async () => {
    const client = { release: vi.fn(), query: vi.fn(async (text: string) => /^(BEGIN|SET LOCAL|ROLLBACK)/.test(text.trim()) ? { rows: [] } : { rows: [] }) };
    await expect(new PostgresSalesStatusStore({ connect: vi.fn(async () => client) } as never).readProduct(404))
      .rejects.toMatchObject({ status: 404, code: "SALES_STATUS_PRODUCT_NOT_FOUND" });
  });

  it("lists the newest settings and says when the list was cut", async () => {
    const row = (id: number) => ({ ...setting({ id, channelId: 36, productVariantId: 22, status: "stopped", revision: String(id) }),
      product_name: "40PT Toploader", product_sku: "TOP-40PT", variant_sku: "C1000", channel_name: "Shopify" });
    const client = { release: vi.fn(), query: vi.fn(async (text: string, params?: unknown[]) => {
      if (/^(BEGIN|SET LOCAL|COMMIT)/.test(text.trim())) return { rows: [] };
      // The store asks for one row more than it returns.
      return { rows: Array.from({ length: Number(params![1]) }, (_, index) => row(index + 1)) };
    }) };
    const list = await new PostgresSalesStatusStore({ connect: vi.fn(async () => client) } as never).list("stopped");
    expect(list.truncated).toBe(true);
    expect(list.entries).toHaveLength(500);
    expect(list.entries[0]).toMatchObject({ productName: "40PT Toploader", variantSku: "C1000", channelName: "Shopify",
      entry: { scopeKey: "channel:36:variant:22" } });
  });
});
