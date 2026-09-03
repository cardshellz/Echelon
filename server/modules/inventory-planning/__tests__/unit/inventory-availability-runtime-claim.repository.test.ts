import { describe, expect, it, vi } from "vitest";

import type { ReservationServiceContract } from "../../../channels/reservation.service";
import { InventoryAvailabilityClaimService } from "../../application/inventory-availability-claim.service";
import { PostgresInventoryAvailabilityRuntimeClaimExecutor } from "../../infrastructure/inventory-availability-runtime-claim.repository";

describe("PostgresInventoryAvailabilityRuntimeClaimExecutor", () => {
  it("holds one validated authority revision until the selected operation commits", async () => {
    const client = fakeClient({
      authority: "legacy",
      authority_revision: "1",
      activation_run_id: null,
    });
    const executor = new PostgresInventoryAvailabilityRuntimeClaimExecutor(
      fakeLegacy(),
      fakeCanonical(),
      { connect: vi.fn(async () => client) } as never,
    );

    await expect(executor.execute(async (context) => ({
      authority: context.authority,
      authorityRevision: context.authorityRevision,
      activationRunId: context.activationRunId,
    }))).resolves.toEqual({ authority: "legacy", authorityRevision: "1", activationRunId: null });
    expect(client.query.mock.calls.map((call) => String(call[0]).trim())).toEqual([
      "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ",
      expect.stringContaining("FOR SHARE"),
      "COMMIT",
    ]);
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("binds legacy work to the authority transaction instead of reacquiring the pool", async () => {
    const client = fakeClient({
      authority: "legacy",
      authority_revision: "1",
      activation_run_id: null,
    });
    const legacy = fakeLegacy();
    vi.mocked(legacy.reserveOrder).mockResolvedValue({
      orderId: 42,
      reserved: 0,
      promised: 0,
      failed: [],
      totalBaseUnits: 0,
      totalPromisedBaseUnits: 0,
    });
    const connect = vi.fn(async () => client);
    const executor = new PostgresInventoryAvailabilityRuntimeClaimExecutor(
      legacy,
      fakeCanonical(),
      { connect } as never,
    );

    await executor.execute((context) => context.legacy.reserveOrder(42));

    expect(connect).toHaveBeenCalledOnce();
    expect(legacy.reserveOrder).toHaveBeenCalledWith(42, undefined, expect.any(Object));
  });

  it("rejects caller-owned transactions before delegated legacy work", async () => {
    const client = fakeClient({
      authority: "legacy",
      authority_revision: "1",
      activation_run_id: null,
    });
    const legacy = fakeLegacy();
    const executor = new PostgresInventoryAvailabilityRuntimeClaimExecutor(
      legacy,
      fakeCanonical(),
      { connect: vi.fn(async () => client) } as never,
    );

    await expect(executor.execute((context) => context.legacy.reserveOrder(
      42,
      undefined,
      { execute: vi.fn() },
    ))).rejects.toMatchObject({
      code: "LEGACY_EXTERNAL_RESERVATION_TRANSACTION_UNSUPPORTED",
    });
    expect(legacy.reserveOrder).not.toHaveBeenCalled();
    expect(client.query.mock.calls.at(-1)?.[0]).toBe("ROLLBACK");
  });

  it("exposes validated claim cursor and variant evidence from the pinned snapshot", async () => {
    const client = fakeClient({
      authority: "canonical",
      authority_revision: "9",
      activation_run_id: "44",
    }, {
      claim: {
        id: "70",
        revision: 3,
        status: "active",
        plan_payload: plan(),
      },
      variants: [{ id: 101, sku: "EA", units_per_variant: 1 }],
      orderId: 42,
    });
    const connect = vi.fn(async () => client);
    const executor = new PostgresInventoryAvailabilityRuntimeClaimExecutor(
      fakeLegacy(),
      fakeCanonical(),
      { connect } as never,
    );

    const result = await executor.execute(async (context) => ({
      claim: await context.getLatestClaim(42),
      variants: await context.getVariantMetadata([101]),
      orderId: await context.getOrderIdByShopifyOrderId("9001"),
    }));

    expect(result.claim).toMatchObject({ claimId: "70", revision: 3, status: "active" });
    expect(result.variants.get(101)).toEqual({
      productVariantId: 101,
      sku: "EA",
      unitsPerVariant: 1,
    });
    expect(result.orderId).toBe(42);
    expect(client.query.mock.calls.slice(0, 3).map((call) => String(call[0]).trim())).toEqual([
      "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ",
      expect.stringContaining("FOR SHARE"),
      "COMMIT",
    ]);
    expect(connect).toHaveBeenCalledTimes(4);
    expect(client.release).toHaveBeenCalledTimes(4);
  });

  it("fails at composition when the configured pool cannot support post-commit work", () => {
    expect(() => new PostgresInventoryAvailabilityRuntimeClaimExecutor(
      fakeLegacy(),
      fakeCanonical(),
      { connect: vi.fn(), options: { max: 1 } } as never,
    )).toThrow(expect.objectContaining({
      code: "INVENTORY_CLAIM_RUNTIME_POOL_TOO_SMALL",
    }));
  });

  it("reserves half of the configured pool for nested side effects under concurrency", async () => {
    let active = 0;
    let peak = 0;
    let signalTwoEntered!: () => void;
    const twoEntered = new Promise<void>((resolve) => { signalTwoEntered = resolve; });
    let unblock!: () => void;
    const blocked = new Promise<void>((resolve) => { unblock = resolve; });
    const legacy = fakeLegacy();
    vi.mocked(legacy.reserveOrder).mockImplementation(async (orderId) => {
      active += 1;
      peak = Math.max(peak, active);
      if (active === 2) signalTwoEntered();
      await blocked;
      active -= 1;
      return {
        orderId,
        reserved: 0,
        promised: 0,
        failed: [],
        totalBaseUnits: 0,
        totalPromisedBaseUnits: 0,
      };
    });
    const connect = vi.fn(async () => fakeClient({
      authority: "legacy",
      authority_revision: "1",
      activation_run_id: null,
    }));
    const executor = new PostgresInventoryAvailabilityRuntimeClaimExecutor(
      legacy,
      fakeCanonical(),
      { connect, options: { max: 4 } } as never,
    );

    const operations = [1, 2, 3].map((orderId) => executor.execute(
      (context) => context.legacy.reserveOrder(orderId),
    ));
    await twoEntered;
    expect(connect).toHaveBeenCalledTimes(2);
    expect(peak).toBe(2);
    unblock();
    await expect(Promise.all(operations)).resolves.toHaveLength(3);
    expect(connect).toHaveBeenCalledTimes(3);
  });

  it("rolls back and fails closed when the authority singleton is invalid", async () => {
    const client = fakeClient(null);
    const executor = new PostgresInventoryAvailabilityRuntimeClaimExecutor(
      fakeLegacy(),
      fakeCanonical(),
      { connect: vi.fn(async () => client) } as never,
    );

    await expect(executor.execute(async () => "unreachable")).rejects.toMatchObject({
      code: "INVENTORY_CLAIM_RUNTIME_AUTHORITY_INVALID",
    });
    expect(client.query.mock.calls.map((call) => String(call[0]).trim())).toEqual([
      "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ",
      expect.stringContaining("FOR SHARE"),
      "ROLLBACK",
    ]);
    expect(client.release).toHaveBeenCalledOnce();
  });
});

function fakeClient(
  authority: Record<string, unknown> | null,
  evidence: {
    claim?: Record<string, unknown>;
    variants?: Record<string, unknown>[];
    orderId?: number;
  } = {},
) {
  const query = vi.fn(async (statement: unknown) => {
    const sql = String(statement).trim();
    if (sql.startsWith("SELECT authority")) return { rows: authority ? [authority] : [] };
    if (sql.includes("FROM inventory.availability_claims")) {
      return { rows: evidence.claim ? [evidence.claim] : [] };
    }
    if (sql.includes("FROM catalog.product_variants")) return { rows: evidence.variants ?? [] };
    if (sql.includes("FROM wms.orders")) {
      return { rows: evidence.orderId == null ? [] : [{ id: evidence.orderId }] };
    }
    if (sql.startsWith("BEGIN") || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [] };
    throw new Error(`Unexpected SQL: ${sql}`);
  });
  return { query, release: vi.fn() };
}

function fakeCanonical(): InventoryAvailabilityClaimService {
  return new InventoryAvailabilityClaimService({
    claimOrder: vi.fn(),
    replaceOrderClaim: vi.fn(),
    releaseOrderClaim: vi.fn(),
    executePackageOperation: vi.fn(),
    executeBuildOperation: vi.fn(),
    handoffBuildOperation: vi.fn(),
    pickClaimLine: vi.fn(),
    unpickClaimLine: vi.fn(),
  });
}

function fakeLegacy(): ReservationServiceContract {
  return {
    reserveForOrder: vi.fn(),
    reserveOrder: vi.fn(),
    releaseOrderReservation: vi.fn(),
    releaseOrderItemReservation: vi.fn(),
    reconcileOrderDemand: vi.fn(),
    reallocateOrphaned: vi.fn(),
    getOrderReservationStatus: vi.fn(),
    autoReserveOnSync: vi.fn(),
  };
}

function plan() {
  return {
    requestKey: "order:42:availability:revision:3",
    scope: { kind: "warehouse", warehouseId: 1 },
    status: "satisfied",
    lines: [{
      lineKey: "order-item:11",
      targetVariantId: 101,
      requestedQty: "1",
      plannedQty: "1",
      shortfallQty: "0",
    }],
    resourceClaims: [],
    operations: [],
    fulfillmentGroups: [],
    modelEvidence: [],
    blockers: [],
    snapshotFingerprint: "a".repeat(64),
  };
}
