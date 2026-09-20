import { describe, expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
import { InventoryAvailabilityRuntimePublicationError } from "../../application/inventory-availability-runtime-publication.service";
import { PostgresInventoryPublicationTargetVariantHoldStore } from "../../infrastructure/inventory-publication-target-variant-hold.repository";

const { publishProduct, publisherOptions } = vi.hoisted(() => ({
  publishProduct: vi.fn(),
  publisherOptions: [] as unknown[],
}));

vi.mock("../../infrastructure/inventory-availability-runtime-publication.repository", () => ({
  createTransactionScopedInventoryPublicationService: (_client: unknown, options: unknown) => {
    publisherOptions.push(options);
    return { publishProduct };
  },
}));

vi.hoisted(() => {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "postgres://test:test@localhost:5432/test";
});

const NOW = new Date("2026-09-17T12:00:00.000Z");
const HASH = "c".repeat(64);

function command(overrides: Record<string, unknown> = {}) {
  return {
    destination: { destinationKind: "dropship_store_connection" as const, connectionId: 77 },
    productVariantIds: [102, 105],
    reason: "Dropship vendor 10: case tier below minimum",
    idempotencyKey: "dropship-listing-tiers:10:3:case:hold:77:abcd1234",
    command: "hold" as const,
    actorId: "dropship-listing-tiers",
    requestHash: HASH,
    occurredAt: NOW,
    ...overrides,
  };
}

function targetRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 5,
    state: "live",
    revision: "3",
    channel_id: 7,
    destination_kind: "dropship_store_connection",
    channel_connection_id: null,
    dropship_store_connection_id: 77,
    provider_key: "ebay",
    provider_scope_type: "account",
    external_scope_id: "ebay-account-1",
    hold_reason: null,
    ...overrides,
  };
}

function canonicalPublication(enqueuedRows: number) {
  return {
    authority: "canonical" as const,
    publication: { enqueuedRows, coalescedRows: 0, rows: [] },
  };
}

interface Scenario {
  targets?: Record<string, unknown>[];
  receipt?: { request_hash: string; response_body: unknown } | null;
  lockAcquired?: boolean;
  /** SKUs already held on the target before the command. */
  heldVariantIds?: number[];
  writtenRows?: number;
  updateRows?: number;
  productIds?: number[];
}

function fakeClient(scenario: Scenario = {}) {
  const statements: string[] = [];
  const params: unknown[][] = [];
  const query = vi.fn(async (sql: string, values?: unknown[]) => {
    const text = String(sql);
    // Two-word labels, except the SKU-hold writes, which share their first two
    // words with the receipt insert and the outbox statements.
    const words = text.trim().split(/\s+/);
    statements.push(/^(INSERT|DELETE)$/.test(words[0]) && text.includes("inventory_publication_target_variant_holds")
      ? `${words[0]} VARIANT_HOLDS`
      : words.slice(0, 2).join(" "));
    params.push(values ?? []);
    if (text.includes("FROM public.idempotency_keys")) return { rows: scenario.receipt ? [scenario.receipt] : [] };
    if (text.includes("FROM inventory.inventory_publication_targets AS target") && text.includes("FOR UPDATE OF target")) {
      return { rows: scenario.targets ?? [targetRow()] };
    }
    if (text.includes("FROM inventory.inventory_publication_target_variant_holds") && text.includes("FOR UPDATE")) {
      return { rows: (scenario.heldVariantIds ?? []).map((product_variant_id) => ({ product_variant_id })) };
    }
    if (text.includes("publication_variant_mapping_heads AS head") || text.includes("outbox.external_inventory_item_id_snapshot")) {
      return { rows: [{ external_inventory_item_id: "SKU-1" }] };
    }
    if (text.includes("pg_try_advisory_lock")) return { rows: [{ acquired: scenario.lockAcquired ?? true }] };
    if (text.includes("pg_advisory_unlock")) return { rows: [{ released: true }] };
    if (text.startsWith("INSERT INTO inventory.inventory_publication_target_variant_holds")
      || text.startsWith("DELETE FROM inventory.inventory_publication_target_variant_holds")) {
      const changing = (values?.[1] as number[] | undefined) ?? [];
      return { rowCount: scenario.writtenRows ?? changing.length, rows: [] };
    }
    if (text.startsWith("UPDATE inventory.inventory_publication_targets")) {
      const rowCount = scenario.updateRows ?? 1;
      return { rowCount, rows: rowCount === 1 ? [{ revision: "4" }] : [] };
    }
    if (text.includes("FROM inventory.publication_variant_mapping_heads AS mapping_head")) {
      return { rows: (scenario.productIds ?? [10]).map((product_id) => ({ product_id })) };
    }
    return { rows: [], rowCount: 0 };
  });
  const release = vi.fn();
  const client = { query, release } as unknown as PoolClient;
  const pool = { connect: vi.fn(async () => client) } as unknown as Pick<Pool, "connect">;
  return { pool, query, release, statements, params };
}

describe("PostgresInventoryPublicationTargetVariantHoldStore", () => {
  it("holds the named SKUs of a live destination, republishes only their products at zero, audits and receipts it in one transaction", async () => {
    publishProduct.mockReset();
    publisherOptions.length = 0;
    publishProduct.mockResolvedValue(canonicalPublication(1));
    const { pool, statements, params, release } = fakeClient({ productIds: [10, 11] });

    const result = await new PostgresInventoryPublicationTargetVariantHoldStore(pool).apply(command());

    expect(result).toEqual({
      destination: { destinationKind: "dropship_store_connection", connectionId: 77 },
      command: "hold",
      productVariantIds: [102, 105],
      targets: [{ publicationTargetId: 5, revision: "4", changedProductVariantIds: [102, 105], publicationRows: 2, blockedProductIds: [] }],
      alreadyApplied: false,
      runtimeAuthorityChanged: false,
      providerWriteAttempted: false,
      outboxEnqueued: true,
    });
    expect(statements[0]).toBe("BEGIN TRANSACTION");
    expect(statements.filter((statement) => statement === "SAVEPOINT publication_target_variant_hold_product")).toHaveLength(2);
    expect(statements.at(-2)).toBe("COMMIT");
    expect(statements.at(-1)).toBe("SELECT pg_advisory_unlock(hashtextextended($1,$2))");
    const insert = params[statements.indexOf("INSERT VARIANT_HOLDS")];
    expect(insert).toEqual([5, [102, 105], "Dropship vendor 10: case tier below minimum", NOW, "dropship-listing-tiers"]);
    const bump = params[statements.indexOf("UPDATE inventory.inventory_publication_targets")];
    expect(bump).toEqual([5, "3", NOW]);
    expect(params[statements.indexOf("SELECT DISTINCT")]).toEqual([5, [102, 105]]);
    expect(publisherOptions).toEqual([{ channelId: 7 }]);
    expect(publishProduct).toHaveBeenCalledTimes(2);
    expect(publishProduct.mock.calls[0][0]).toEqual({
      productId: 10, publicationTargetId: 5, channelId: 7, dryRun: false, triggeredBy: "publication_target_variant_hold",
    });
    const auditParams = params.find((values) => values[2] === "inventory_availability.publication_target.variants_held");
    expect(auditParams).toBeDefined();
    expect(JSON.parse(String(auditParams![4]))).toEqual({
      before: { heldProductVariantIds: [], revision: "3" },
      after: { heldProductVariantIds: [102, 105], revision: "4" },
    });
    expect(JSON.parse(String(auditParams![5]))).toMatchObject({
      reason: "Dropship vendor 10: case tier below minimum",
      productVariantIds: [102, 105],
      changedProductVariantIds: [102, 105],
      publicationRows: 2,
    });
    const receiptUpdate = params[statements.lastIndexOf("UPDATE public.idempotency_keys")];
    expect(JSON.parse(String(receiptUpdate[1]))).toMatchObject({ commandType: "inventory_publication_target_variant_hold" });
    expect(release).toHaveBeenCalledWith(undefined);
  });

  it("changes only the SKUs not already in the requested state and leaves an unchanged target alone", async () => {
    publishProduct.mockReset();
    publishProduct.mockResolvedValue(canonicalPublication(1));
    const { pool, statements, params } = fakeClient({ heldVariantIds: [102] });

    const result = await new PostgresInventoryPublicationTargetVariantHoldStore(pool).apply(command());

    expect(result.targets).toEqual([
      { publicationTargetId: 5, revision: "4", changedProductVariantIds: [105], publicationRows: 1, blockedProductIds: [] },
    ]);
    expect(params[statements.indexOf("INSERT VARIANT_HOLDS")]?.[1]).toEqual([105]);
    const auditParams = params.find((values) => values[2] === "inventory_availability.publication_target.variants_held");
    expect(JSON.parse(String(auditParams![4]))).toEqual({
      before: { heldProductVariantIds: [102], revision: "3" },
      after: { heldProductVariantIds: [102, 105], revision: "4" },
    });

    publishProduct.mockReset();
    const idle = fakeClient({ heldVariantIds: [102, 105] });
    const unchanged = await new PostgresInventoryPublicationTargetVariantHoldStore(idle.pool).apply(command());
    expect(unchanged.targets).toEqual([
      { publicationTargetId: 5, revision: "3", changedProductVariantIds: [], publicationRows: 0, blockedProductIds: [] },
    ]);
    expect(unchanged.outboxEnqueued).toBe(false);
    expect(idle.statements).not.toContain("UPDATE inventory.inventory_publication_targets");
    expect(idle.statements).not.toContain("SELECT pg_try_advisory_lock(hashtextextended($1,$2))");
    expect(idle.statements).toContain("INSERT INTO");
    expect(idle.statements).not.toContain("INSERT VARIANT_HOLDS");
    expect(publishProduct).not.toHaveBeenCalled();
  });

  it("releases held SKUs by deleting their rows and republishing their products with real quantities", async () => {
    publishProduct.mockReset();
    publishProduct.mockResolvedValue(canonicalPublication(3));
    const { pool, statements, params } = fakeClient({ heldVariantIds: [102, 105] });

    const result = await new PostgresInventoryPublicationTargetVariantHoldStore(pool).apply(command({ command: "release" }));

    expect(result).toMatchObject({
      command: "release",
      targets: [{ publicationTargetId: 5, revision: "4", changedProductVariantIds: [102, 105], publicationRows: 3 }],
    });
    expect(params[statements.indexOf("DELETE VARIANT_HOLDS")]).toEqual([5, [102, 105]]);
    expect(publishProduct.mock.calls[0][0]).toMatchObject({ triggeredBy: "publication_target_variant_release" });
    const auditParams = params.find((values) => values[2] === "inventory_availability.publication_target.variants_released");
    expect(JSON.parse(String(auditParams![4]))).toEqual({
      before: { heldProductVariantIds: [102, 105], revision: "3" },
      after: { heldProductVariantIds: [], revision: "4" },
    });
  });

  it("records a product the planner refuses and keeps the hold, instead of failing the safety action", async () => {
    publishProduct.mockReset();
    publishProduct
      .mockRejectedValueOnce(new InventoryAvailabilityRuntimePublicationError("CANONICAL_SHADOW_BLOCKED", "blocked"))
      .mockResolvedValueOnce(canonicalPublication(1));
    const { pool, statements } = fakeClient({ productIds: [10, 11] });

    const result = await new PostgresInventoryPublicationTargetVariantHoldStore(pool).apply(command());

    expect(result.targets[0]).toMatchObject({ changedProductVariantIds: [102, 105], publicationRows: 1, blockedProductIds: [10] });
    expect(statements.filter((statement) => statement === "ROLLBACK TO")).toHaveLength(1);
    expect(statements.at(-2)).toBe("COMMIT");
  });

  it("replays a receipt with the same hash and refuses one with a different hash", async () => {
    publishProduct.mockReset();
    const stored = {
      destination: { destinationKind: "dropship_store_connection", connectionId: 77 },
      command: "hold",
      productVariantIds: [102, 105],
      targets: [{ publicationTargetId: 5, revision: "4", changedProductVariantIds: [102, 105], publicationRows: 2, blockedProductIds: [] }],
      alreadyApplied: false,
      runtimeAuthorityChanged: false,
      providerWriteAttempted: false,
      outboxEnqueued: true,
    };
    const replay = fakeClient({ receipt: { request_hash: HASH, response_body: { result: stored } } });
    await expect(new PostgresInventoryPublicationTargetVariantHoldStore(replay.pool).apply(command()))
      .resolves.toEqual({ ...stored, alreadyApplied: true });
    expect(replay.statements).not.toContain("INSERT INTO");
    expect(publishProduct).not.toHaveBeenCalled();

    const conflict = fakeClient({ receipt: { request_hash: "d".repeat(64), response_body: null } });
    await expect(new PostgresInventoryPublicationTargetVariantHoldStore(conflict.pool).apply(command()))
      .rejects.toMatchObject({ status: 409, code: "INVENTORY_PUBLICATION_TARGET_IDEMPOTENCY_CONFLICT" });
    expect(conflict.statements.at(-1)).toBe("ROLLBACK");
  });

  it("refuses to race an in-flight provider request and rolls back without writing", async () => {
    publishProduct.mockReset();
    const { pool, statements, release } = fakeClient({ lockAcquired: false });

    await expect(new PostgresInventoryPublicationTargetVariantHoldStore(pool).apply(command()))
      .rejects.toMatchObject({ status: 409, code: "INVENTORY_PUBLICATION_TARGET_BUSY" });
    expect(statements).not.toContain("INSERT INTO");
    expect(statements.at(-1)).toBe("ROLLBACK");
    expect(release).toHaveBeenCalledWith(undefined);
  });

  it("treats a concurrent target or hold change as a retryable conflict", async () => {
    publishProduct.mockReset();
    const stale = fakeClient({ updateRows: 0 });
    await expect(new PostgresInventoryPublicationTargetVariantHoldStore(stale.pool).apply(command()))
      .rejects.toMatchObject({ status: 409, code: "INVENTORY_PUBLICATION_TARGET_VARIANT_HOLD_CONCURRENT_CHANGE" });
    expect(stale.statements.at(-2)).toBe("ROLLBACK");

    const partial = fakeClient({ writtenRows: 1 });
    await expect(new PostgresInventoryPublicationTargetVariantHoldStore(partial.pool).apply(command()))
      .rejects.toMatchObject({ status: 409, code: "INVENTORY_PUBLICATION_TARGET_VARIANT_HOLD_CONCURRENT_CHANGE" });
    expect(publishProduct).not.toHaveBeenCalled();
  });

  it("records the hold without enqueueing anything while legacy authority owns publication", async () => {
    publishProduct.mockReset();
    publishProduct.mockResolvedValue({ authority: "legacy", legacyResult: null });
    const { pool, statements } = fakeClient();

    const result = await new PostgresInventoryPublicationTargetVariantHoldStore(pool).apply(command());

    expect(result.targets[0]).toMatchObject({ changedProductVariantIds: [102, 105], publicationRows: 0, blockedProductIds: [] });
    expect(result.outboxEnqueued).toBe(false);
    expect(statements).toContain("INSERT VARIANT_HOLDS");
    expect(statements.at(-2)).toBe("COMMIT");
  });

  it("returns no targets for a destination with nothing live, and still receipts the command", async () => {
    publishProduct.mockReset();
    const { pool, statements } = fakeClient({ targets: [] });

    const result = await new PostgresInventoryPublicationTargetVariantHoldStore(pool).apply(command());

    expect(result.targets).toEqual([]);
    expect(result.outboxEnqueued).toBe(false);
    expect(statements).toContain("INSERT INTO");
    expect(statements.at(-1)).toBe("COMMIT");
  });
});
