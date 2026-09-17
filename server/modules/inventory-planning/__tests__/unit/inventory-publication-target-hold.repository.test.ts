import { describe, expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
import { InventoryAvailabilityRuntimePublicationError } from "../../application/inventory-availability-runtime-publication.service";
import { PostgresInventoryPublicationTargetHoldStore } from "../../infrastructure/inventory-publication-target-hold.repository";

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
const HASH = "b".repeat(64);

function command(overrides: Record<string, unknown> = {}) {
  return {
    destination: { destinationKind: "dropship_store_connection" as const, connectionId: 77 },
    reason: "Vendor 10 paused: card declined",
    idempotencyKey: "vendor-standing:10:hold:1",
    command: "hold" as const,
    actorId: "dropship-vendor-standing",
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
  updateRows?: number;
  productIds?: number[];
}

function fakeClient(scenario: Scenario = {}) {
  const statements: string[] = [];
  const params: unknown[][] = [];
  const query = vi.fn(async (sql: string, values?: unknown[]) => {
    const text = String(sql);
    statements.push(text.trim().split(/\s+/).slice(0, 2).join(" "));
    params.push(values ?? []);
    if (text.includes("FROM public.idempotency_keys")) return { rows: scenario.receipt ? [scenario.receipt] : [] };
    if (text.includes("FROM inventory.inventory_publication_targets AS target") && text.includes("FOR UPDATE OF target")) {
      return { rows: scenario.targets ?? [targetRow()] };
    }
    if (text.includes("publication_variant_mapping_heads AS head") || text.includes("outbox.external_inventory_item_id_snapshot")) {
      return { rows: [{ external_inventory_item_id: "SKU-1" }] };
    }
    if (text.includes("pg_try_advisory_lock")) return { rows: [{ acquired: scenario.lockAcquired ?? true }] };
    if (text.includes("pg_advisory_unlock")) return { rows: [{ released: true }] };
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

describe("PostgresInventoryPublicationTargetHoldStore", () => {
  it("holds a live destination, republishes its products at zero, audits and receipts it in one transaction", async () => {
    publishProduct.mockReset();
    publisherOptions.length = 0;
    publishProduct.mockResolvedValue(canonicalPublication(2));
    const { pool, statements, params, release } = fakeClient({ productIds: [10, 11] });

    const result = await new PostgresInventoryPublicationTargetHoldStore(pool).apply(command());

    expect(result).toEqual({
      destination: { destinationKind: "dropship_store_connection", connectionId: 77 },
      command: "hold",
      targets: [{ publicationTargetId: 5, revision: "4", changed: true, publicationRows: 4, blockedProductIds: [] }],
      alreadyApplied: false,
      runtimeAuthorityChanged: false,
      providerWriteAttempted: false,
      outboxEnqueued: true,
    });
    expect(statements[0]).toBe("BEGIN TRANSACTION");
    expect(statements).toContain("INSERT INTO");
    expect(statements.filter((statement) => statement === "SAVEPOINT publication_target_hold_product")).toHaveLength(2);
    expect(statements.filter((statement) => statement === "RELEASE SAVEPOINT")).toHaveLength(2);
    expect(statements.at(-2)).toBe("COMMIT");
    expect(statements.at(-1)).toBe("SELECT pg_advisory_unlock(hashtextextended($1,$2))");
    const update = params[statements.indexOf("UPDATE inventory.inventory_publication_targets")];
    expect(update).toEqual([5, "3", "Vendor 10 paused: card declined", NOW, "dropship-vendor-standing"]);
    expect(publisherOptions).toEqual([{ channelId: 7 }]);
    expect(publishProduct).toHaveBeenCalledTimes(2);
    expect(publishProduct.mock.calls[0][0]).toEqual({
      productId: 10, publicationTargetId: 5, channelId: 7, dryRun: false, triggeredBy: "publication_target_hold",
    });
    const auditParams = params.find((values) => values[2] === "inventory_availability.publication_target.held");
    expect(auditParams).toBeDefined();
    expect(JSON.parse(String(auditParams![4]))).toEqual({
      before: { hold: null, revision: "3" },
      after: { hold: { reason: "Vendor 10 paused: card declined" }, revision: "4" },
    });
    expect(release).toHaveBeenCalledWith(undefined);
  });

  it("releases a held destination with the release statement and trigger, and skips targets already released", async () => {
    publishProduct.mockReset();
    publishProduct.mockResolvedValue(canonicalPublication(1));
    const { pool, statements, params } = fakeClient({
      targets: [targetRow({ id: 5, hold_reason: "Vendor 10 paused: card declined" }), targetRow({ id: 6, revision: "9", hold_reason: null })],
    });

    const result = await new PostgresInventoryPublicationTargetHoldStore(pool).apply(command({ command: "release" }));

    expect(result.targets).toEqual([
      { publicationTargetId: 5, revision: "4", changed: true, publicationRows: 1, blockedProductIds: [] },
      { publicationTargetId: 6, revision: "9", changed: false, publicationRows: 0, blockedProductIds: [] },
    ]);
    const updateIndex = statements.indexOf("UPDATE inventory.inventory_publication_targets");
    expect(params[updateIndex]).toEqual([5, "3", null, NOW]);
    expect(publishProduct.mock.calls[0][0]).toMatchObject({ triggeredBy: "publication_target_release" });
    expect(params.some((values) => values[2] === "inventory_availability.publication_target.released")).toBe(true);
  });

  it("is a no-op when every target is already in the requested state, still writing the receipt", async () => {
    publishProduct.mockReset();
    const { pool, statements } = fakeClient({ targets: [targetRow({ hold_reason: "already held" })] });

    const result = await new PostgresInventoryPublicationTargetHoldStore(pool).apply(command());

    expect(result).toMatchObject({ alreadyApplied: false, outboxEnqueued: false, targets: [{ publicationTargetId: 5, changed: false, revision: "3" }] });
    expect(statements).not.toContain("UPDATE inventory.inventory_publication_targets");
    expect(statements.filter((statement) => statement === "INSERT INTO")).toHaveLength(1);
    expect(publishProduct).not.toHaveBeenCalled();
  });

  it("succeeds with no targets when the destination has no live canonical target yet", async () => {
    publishProduct.mockReset();
    const { pool } = fakeClient({ targets: [] });

    await expect(new PostgresInventoryPublicationTargetHoldStore(pool).apply(command()))
      .resolves.toMatchObject({ targets: [], outboxEnqueued: false, alreadyApplied: false });
  });

  it("replays the receipt for a repeated key and refuses the key with different inputs", async () => {
    publishProduct.mockReset();
    const stored = {
      destination: { destinationKind: "dropship_store_connection", connectionId: 77 },
      command: "hold",
      targets: [{ publicationTargetId: 5, revision: "4", changed: true, publicationRows: 2, blockedProductIds: [] }],
      alreadyApplied: false,
      runtimeAuthorityChanged: false,
      providerWriteAttempted: false,
      outboxEnqueued: true,
    };
    const replay = fakeClient({ receipt: { request_hash: HASH, response_body: { result: stored } } });
    await expect(new PostgresInventoryPublicationTargetHoldStore(replay.pool).apply(command()))
      .resolves.toEqual({ ...stored, alreadyApplied: true });
    expect(replay.statements).not.toContain("UPDATE inventory.inventory_publication_targets");
    expect(publishProduct).not.toHaveBeenCalled();

    const conflict = fakeClient({ receipt: { request_hash: "c".repeat(64), response_body: null } });
    await expect(new PostgresInventoryPublicationTargetHoldStore(conflict.pool).apply(command()))
      .rejects.toMatchObject({ status: 409, code: "INVENTORY_PUBLICATION_TARGET_IDEMPOTENCY_CONFLICT" });
    expect(conflict.statements).toContain("ROLLBACK");
  });

  it("refuses to change a destination while a provider quantity request is in flight", async () => {
    publishProduct.mockReset();
    const { pool, statements } = fakeClient({ lockAcquired: false });

    await expect(new PostgresInventoryPublicationTargetHoldStore(pool).apply(command()))
      .rejects.toMatchObject({ status: 409, code: "INVENTORY_PUBLICATION_TARGET_BUSY" });
    expect(statements).toContain("ROLLBACK");
    expect(statements).not.toContain("UPDATE inventory.inventory_publication_targets");
  });

  it("fails closed on a concurrent revision change", async () => {
    publishProduct.mockReset();
    const { pool, statements } = fakeClient({ updateRows: 0 });

    await expect(new PostgresInventoryPublicationTargetHoldStore(pool).apply(command()))
      .rejects.toMatchObject({ status: 409, code: "INVENTORY_PUBLICATION_TARGET_HOLD_CONCURRENT_CHANGE" });
    expect(statements).toContain("ROLLBACK");
  });

  it("records a product the planner refuses under a savepoint and keeps the hold", async () => {
    publishProduct.mockReset();
    publishProduct
      .mockRejectedValueOnce(new InventoryAvailabilityRuntimePublicationError(
        "CANONICAL_PUBLICATION_BLOCKED", "blocked", {} as never,
      ))
      .mockResolvedValueOnce(canonicalPublication(3));
    const { pool, statements } = fakeClient({ productIds: [10, 11] });

    const result = await new PostgresInventoryPublicationTargetHoldStore(pool).apply(command());

    expect(result.targets[0]).toMatchObject({ changed: true, publicationRows: 3, blockedProductIds: [10] });
    expect(statements).toContain("ROLLBACK TO");
    expect(statements.at(-2)).toBe("COMMIT");
  });

  it("records the hold without enqueuing while legacy authority owns publication", async () => {
    publishProduct.mockReset();
    publishProduct.mockResolvedValue({ authority: "legacy", legacyResult: null });
    const { pool, statements } = fakeClient({ productIds: [10, 11] });

    const result = await new PostgresInventoryPublicationTargetHoldStore(pool).apply(command());

    expect(result.targets[0]).toMatchObject({ changed: true, publicationRows: 0, blockedProductIds: [] });
    expect(result.outboxEnqueued).toBe(false);
    expect(publishProduct).toHaveBeenCalledTimes(1);
    expect(statements.at(-2)).toBe("COMMIT");
  });
});
