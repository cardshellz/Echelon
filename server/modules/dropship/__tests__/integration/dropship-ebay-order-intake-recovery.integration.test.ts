import { resolve } from "node:path";
import { config } from "dotenv";
import pg, { type Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PgDropshipEbayOrderIntakeRepository } from "../../infrastructure/dropship-ebay-order-intake.repository";
import { PgDropshipOrderIntakeHealthRepository } from "../../infrastructure/dropship-order-intake-health.repository";
import { PgDropshipOrderCancellationRepository } from "../../infrastructure/dropship-order-cancellation.repository";
import { hasOpenStoreSetupBlockers } from "../../infrastructure/dropship-store-setup-blockers";
import {
  DropshipOrderCancellationService,
  NON_DROPSHIP_LINES_CANCELLATION_CODE,
} from "../../application/dropship-order-cancellation-service";
import type { DropshipMarketplaceOrderCancellationRequest } from "../../application/dropship-marketplace-order-cancellation-provider";
import type { DropshipOrderIntakeHealthPolicy } from "../../domain/dropship-order-intake-health";

vi.mock("../../../../db", () => ({ pool: {}, db: {} }));
config({ path: resolve(process.cwd(), ".env.test") });
const testUrl = process.env.ECHELON_TEST_DATABASE_URL;
const disposable = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
const describeDatabase = testUrl && disposable ? describe : describe.skip;

const now = new Date("2026-10-02T12:00:00.000Z");
const lastSuccess = new Date("2026-10-01T23:17:29.000Z");
const policy: DropshipOrderIntakeHealthPolicy = {
  degradedAfterFailures: 2,
  stoppedAfterFailures: 6,
  degradedAfterMs: 15 * 60_000,
  stoppedAfterMs: 30 * 60_000,
};

/**
 * The incident this guards: a vendor's eBay store stopped taking dropship
 * orders after its intake failed on an order that was not dropship at all, and
 * stayed stopped because a stopped intake made the store "attention_required",
 * which the poll skipped. These run the real SQL against PostgreSQL.
 */
describeDatabase.sequential("eBay dropship order intake store selection and recovery (PostgreSQL)", () => {
  const schema = `dropship_intake_recovery_${process.pid}`;
  let pool: pg.Pool | undefined;
  let created = false;
  let intakeRepository: PgDropshipEbayOrderIntakeRepository;
  let healthRepository: PgDropshipOrderIntakeHealthRepository;
  let cancellationRepository: PgDropshipOrderCancellationRepository;
  const qualify = (sql: string) => sql.replaceAll("dropship.", `"${schema}".`);

  beforeAll(async () => {
    if (!testUrl || !disposable || [process.env.DATABASE_URL, process.env.EXTERNAL_DATABASE_URL].includes(testUrl)) {
      throw new Error("Order intake recovery tests require a distinct explicitly disposable PostgreSQL database.");
    }
    if (!/^dropship_intake_recovery_\d+$/.test(schema)) throw new Error("Invalid isolated intake recovery schema.");
    pool = new pg.Pool({ connectionString: testUrl, max: 4, connectionTimeoutMillis: 3_000,
      ssl: /localhost|127\.0\.0\.1/.test(testUrl) ? false : { rejectUnauthorized: true } });
    await pool.query(`CREATE SCHEMA "${schema}"`);
    created = true;
    await pool.query(qualify(`
      CREATE TABLE dropship.dropship_store_connections (
        id integer PRIMARY KEY, vendor_id integer NOT NULL, platform varchar(30) NOT NULL,
        external_display_name varchar(255), shop_domain varchar(255),
        access_token_ref text, refresh_token_ref text,
        status varchar(30) NOT NULL, setup_status varchar(30) NOT NULL DEFAULT 'pending',
        last_sync_at timestamptz, last_order_sync_at timestamptz,
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE dropship.dropship_vendor_listings (
        id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        vendor_id integer NOT NULL, store_connection_id integer NOT NULL,
        product_variant_id integer NOT NULL, platform varchar(30) NOT NULL,
        external_listing_id varchar(255), status varchar(40) NOT NULL DEFAULT 'not_listed',
        UNIQUE (store_connection_id, product_variant_id)
      );
      CREATE TABLE dropship.dropship_store_setup_checks (
        id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        vendor_id integer NOT NULL, store_connection_id integer, check_key varchar(100) NOT NULL,
        status varchar(30) NOT NULL, severity varchar(20) NOT NULL, message text, details jsonb,
        last_checked_at timestamptz, resolved_at timestamptz,
        created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL
      );
      CREATE UNIQUE INDEX setup_check_identity ON dropship.dropship_store_setup_checks
        (store_connection_id, check_key) WHERE store_connection_id IS NOT NULL;
      CREATE TABLE dropship.dropship_store_order_intake_health (
        store_connection_id integer PRIMARY KEY, mode varchar(20) NOT NULL, status varchar(20) NOT NULL,
        consecutive_failures integer NOT NULL DEFAULT 0,
        last_attempt_at timestamptz, last_success_at timestamptz, last_failure_at timestamptz,
        last_failure_code varchar(100), last_failure_message text,
        status_changed_at timestamptz NOT NULL, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL
      );
      CREATE TABLE dropship.dropship_audit_events (
        id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        vendor_id integer, store_connection_id integer, entity_type varchar(80) NOT NULL,
        entity_id varchar(255), event_type varchar(120) NOT NULL, actor_type varchar(40) NOT NULL,
        actor_id varchar(255), severity varchar(20) NOT NULL, payload jsonb, created_at timestamptz NOT NULL
      );
      CREATE TABLE dropship.dropship_order_intake (
        id integer PRIMARY KEY, vendor_id integer NOT NULL, store_connection_id integer NOT NULL,
        platform varchar(30) NOT NULL, external_order_id varchar(255) NOT NULL,
        external_order_number varchar(255), source_order_id varchar(255),
        status varchar(30) NOT NULL, rejection_reason text, cancellation_status varchar(60),
        raw_payload jsonb, normalized_payload jsonb, oms_order_id bigint,
        updated_at timestamptz NOT NULL
      );
    `));
    const scopedPool = makeScopedPool(pool, qualify);
    intakeRepository = new PgDropshipEbayOrderIntakeRepository(scopedPool);
    healthRepository = new PgDropshipOrderIntakeHealthRepository(scopedPool);
    cancellationRepository = new PgDropshipOrderCancellationRepository(scopedPool);
  });

  beforeEach(async () => {
    await pool!.query(qualify(`TRUNCATE dropship.dropship_store_connections, dropship.dropship_vendor_listings,
      dropship.dropship_store_setup_checks, dropship.dropship_store_order_intake_health,
      dropship.dropship_audit_events, dropship.dropship_order_intake RESTART IDENTITY`));
  });

  afterAll(async () => {
    if (created && pool) await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
    await pool?.end();
  });

  it("polls ready stores with every listing each one published", async () => {
    await insertStore({ id: 22, vendorId: 10, setupStatus: "ready", lastOrderSyncAt: lastSuccess });
    // Two SKU variants on one eBay listing, an ended listing, a not-yet-listed
    // row, a blank id, and a row that names another vendor.
    await insertListing({ vendorId: 10, storeConnectionId: 22, variantId: 1, externalListingId: "168741367796", status: "active" });
    await insertListing({ vendorId: 10, storeConnectionId: 22, variantId: 2, externalListingId: "168741367796", status: "active" });
    await insertListing({ vendorId: 10, storeConnectionId: 22, variantId: 3, externalListingId: "111000111000", status: "ended" });
    await insertListing({ vendorId: 10, storeConnectionId: 22, variantId: 4, externalListingId: null, status: "not_listed" });
    await insertListing({ vendorId: 10, storeConnectionId: 22, variantId: 5, externalListingId: "  ", status: "failed" });
    await insertListing({ vendorId: 99, storeConnectionId: 22, variantId: 6, externalListingId: "999999999999", status: "active" });
    // Not polled: an order recorded for a store that is not ready is rejected.
    await insertStore({ id: 23, vendorId: 11, setupStatus: "attention_required" });
    await insertStore({ id: 25, vendorId: 13, status: "needs_reauth", setupStatus: "ready" });
    await insertStore({ id: 24, vendorId: 12, setupStatus: "ready" });

    const connections = await intakeRepository.listPollableStoreConnections({ limit: 25 });

    expect(connections).toEqual([
      {
        vendorId: 12,
        storeConnectionId: 24,
        platform: "ebay",
        lastOrderSyncAt: null,
        dropshipListingIds: [],
      },
      {
        vendorId: 10,
        storeConnectionId: 22,
        platform: "ebay",
        lastOrderSyncAt: lastSuccess,
        dropshipListingIds: ["111000111000", "168741367796"],
      },
    ]);
  });

  it("does not let the intake health check block a store, while every other open blocker still does", async () => {
    await insertStore({ id: 22, vendorId: 10, setupStatus: "ready" });
    await insertStoppedHealth(22, 10);
    await insertStore({ id: 23, vendorId: 11, setupStatus: "ready" });
    await insertStoppedHealth(23, 11);
    await insertCheck({ storeConnectionId: 23, vendorId: 11, checkKey: "post_connect_setup", status: "failed", severity: "blocker" });
    // A warning and a resolved blocker do not block a store.
    await insertStore({ id: 26, vendorId: 14, setupStatus: "ready" });
    await insertCheck({ storeConnectionId: 26, vendorId: 14, checkKey: "store_auth_health", status: "failed", severity: "warning" });
    await insertCheck({ storeConnectionId: 26, vendorId: 14, checkKey: "post_connect_setup", status: "failed", severity: "blocker", resolvedAt: now });

    const client = await pool!.connect();
    try {
      const scoped = {
        query: (sql: string, values?: unknown[]) => client.query(qualify(sql), values),
      } as unknown as PoolClient;
      expect(await hasOpenStoreSetupBlockers(scoped, 22)).toBe(false);
      expect(await hasOpenStoreSetupBlockers(scoped, 23)).toBe(true);
      expect(await hasOpenStoreSetupBlockers(scoped, 26)).toBe(false);
    } finally {
      client.release();
    }
  });

  it("puts a store held only by its stopped intake back to ready before the poll lists stores, with an audit event", async () => {
    // The incident: stopped intake left the store "attention_required".
    await insertStore({ id: 22, vendorId: 10, setupStatus: "attention_required", lastOrderSyncAt: lastSuccess });
    await insertStoppedHealth(22, 10);
    await insertListing({ vendorId: 10, storeConnectionId: 22, variantId: 1, externalListingId: "168741367796", status: "active" });
    // Each of these stays as it is.
    await insertStore({ id: 23, vendorId: 11, setupStatus: "attention_required" });
    await insertStoppedHealth(23, 11);
    await insertCheck({ storeConnectionId: 23, vendorId: 11, checkKey: "post_connect_setup", status: "failed", severity: "blocker" });
    await insertStore({ id: 25, vendorId: 13, status: "needs_reauth", setupStatus: "attention_required" });
    await insertStoppedHealth(25, 13);
    await insertStore({ id: 26, vendorId: 14, setupStatus: "attention_required" });
    await insertStore({ id: 27, vendorId: 15, setupStatus: "pending" });
    await insertStoppedHealth(27, 15);

    const restored = await healthRepository.restoreStoresHeldOnlyByOrderIntakeHealth({ platform: "ebay", limit: 25, now });

    expect(restored.map((store) => store.storeConnectionId)).toEqual([22]);
    expect(await rows(`SELECT id, setup_status FROM dropship.dropship_store_connections ORDER BY id`)).toEqual([
      { id: 22, setup_status: "ready" },
      { id: 23, setup_status: "attention_required" },
      { id: 25, setup_status: "attention_required" },
      { id: 26, setup_status: "attention_required" },
      { id: 27, setup_status: "pending" },
    ]);
    // The health check itself is untouched: only a successful poll clears it.
    expect(await one(`SELECT status, severity, resolved_at FROM dropship.dropship_store_setup_checks
      WHERE store_connection_id = 22 AND check_key = 'order_intake_health'`))
      .toEqual({ status: "failed", severity: "blocker", resolved_at: null });
    expect(await rows(`SELECT store_connection_id, entity_type, event_type, actor_type, actor_id, severity, payload
      FROM dropship.dropship_audit_events ORDER BY id`)).toEqual([{
      store_connection_id: 22,
      entity_type: "dropship_store_connection",
      event_type: "store_setup_status_restored",
      actor_type: "system",
      actor_id: "dropship_order_intake_health",
      severity: "info",
      payload: {
        previousSetupStatus: "attention_required",
        setupStatus: "ready",
        reason: "order_intake_health_does_not_block",
        healthStatus: "stopped",
        consecutiveFailures: 21,
        lastFailureCode: "DROPSHIP_EBAY_ORDER_MONEY_INVALID",
      },
    }]);

    // Now the poll picks it up, and a second run changes nothing more.
    expect((await intakeRepository.listPollableStoreConnections({ limit: 25 })).map((store) => store.storeConnectionId))
      .toEqual([22]);
    expect(await healthRepository.restoreStoresHeldOnlyByOrderIntakeHealth({ platform: "ebay", limit: 25, now })).toEqual([]);
    expect(await rows(`SELECT 1 FROM dropship.dropship_audit_events`)).toHaveLength(1);
  });

  it("clears the intake check on the first successful poll and leaves the setup status alone", async () => {
    await insertStore({ id: 22, vendorId: 10, setupStatus: "ready", lastOrderSyncAt: lastSuccess });
    await insertStoppedHealth(22, 10);

    const result = await healthRepository.recordPollSucceeded({
      vendorId: 10, storeConnectionId: 22, platform: "ebay", mode: "poll",
      syncedThrough: now, now, policy,
    });

    expect(result.transition).toMatchObject({ previousStatus: "stopped", current: { status: "healthy" } });
    expect(await one(`SELECT setup_status, last_order_sync_at FROM dropship.dropship_store_connections WHERE id = 22`))
      .toEqual({ setup_status: "ready", last_order_sync_at: now });
    expect(await one(`SELECT status, severity, resolved_at FROM dropship.dropship_store_setup_checks
      WHERE store_connection_id = 22 AND check_key = 'order_intake_health'`))
      .toEqual({ status: "passed", severity: "info", resolved_at: now });
  });

  it("once the store is ready again, sends eBay a cancellation only for orders made entirely of dropship listings", async () => {
    await insertStore({ id: 22, vendorId: 10, setupStatus: "ready" });
    await insertStore({ id: 30, vendorId: 20, setupStatus: "ready" });
    await insertListing({ vendorId: 10, storeConnectionId: 22, variantId: 1, externalListingId: "168741367796", status: "active" });
    // The vendor's own item number is a dropship listing on another store only.
    await insertListing({ vendorId: 20, storeConnectionId: 30, variantId: 1, externalListingId: "vendor-own-item", status: "active" });
    const lines = (...itemIds: Array<string | null>) => ({
      lineItems: itemIds.map((itemId, index) => ({ lineItemId: `line-${index}`, ...(itemId ? { legacyItemId: itemId } : {}) })),
    });
    await insertRejectedIntake(1, "vendor-own-sale", lines("vendor-own-item"));
    await insertRejectedIntake(2, "dropship-only", lines("168741367796"));
    await insertRejectedIntake(3, "mixed-cart", lines("168741367796", "vendor-own-item"));
    await insertRejectedIntake(4, "no-lines-recorded", {});
    await insertRejectedIntake(5, "empty-lines", { lineItems: [] });
    await insertRejectedIntake(6, "lines-not-a-list", { lineItems: { lineItemId: "line-0" } });
    await insertRejectedIntake(7, "line-without-item-number", lines(null));

    const cancelled: DropshipMarketplaceOrderCancellationRequest[] = [];
    const service = new DropshipOrderCancellationService({
      repository: cancellationRepository,
      marketplaceCancellation: {
        cancelOrder: async (request) => {
          cancelled.push(request);
          return { status: "cancelled", externalCancellationId: `cancel-${request.intakeId}`, rawResult: {} };
        },
      },
      clock: { now: () => now },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    const result = await service.processPendingCancellations({ workerId: "worker-1" });

    expect(cancelled.map((request) => request.externalOrderId)).toEqual(["dropship-only"]);
    expect(result).toMatchObject({ claimed: 7, succeeded: 1, retrying: 0, failed: 6 });
    const intakes = await rows(`SELECT external_order_id, status, cancellation_status, rejection_reason
      FROM dropship.dropship_order_intake ORDER BY id`);
    expect(intakes).toEqual([
      refused("vendor-own-sale"),
      { external_order_id: "dropship-only", status: "cancelled", cancellation_status: "marketplace_cancelled",
        rejection_reason: "Store connection is not launch-ready for dropship order intake." },
      refused("mixed-cart"),
      refused("no-lines-recorded"),
      refused("empty-lines"),
      refused("lines-not-a-list"),
      refused("line-without-item-number"),
    ]);
    const failures = await rows(`SELECT entity_id, event_type, severity, payload->>'errorCode' AS error_code
      FROM dropship.dropship_audit_events WHERE event_type = 'order_marketplace_cancellation_failed' ORDER BY id`);
    expect(failures).toHaveLength(6);
    expect(failures.every((row) => row.error_code === NON_DROPSHIP_LINES_CANCELLATION_CODE && row.severity === "error"))
      .toBe(true);

    // Refused orders are terminal: a second sweep claims nothing.
    expect(await service.processPendingCancellations({ workerId: "worker-1" })).toMatchObject({ claimed: 0 });
    expect(cancelled).toHaveLength(1);

    function refused(externalOrderId: string) {
      return {
        external_order_id: externalOrderId,
        status: "exception",
        cancellation_status: "marketplace_cancellation_failed",
        rejection_reason: expect.stringContaining(NON_DROPSHIP_LINES_CANCELLATION_CODE),
      };
    }
  });

  async function insertRejectedIntake(id: number, externalOrderId: string, rawPayload: Record<string, unknown>): Promise<void> {
    await pool!.query(qualify(`INSERT INTO dropship.dropship_order_intake
      (id, vendor_id, store_connection_id, platform, external_order_id, status, rejection_reason,
       cancellation_status, raw_payload, normalized_payload, updated_at)
      VALUES ($1, 10, 22, 'ebay', $2, 'rejected', 'Store connection is not launch-ready for dropship order intake.',
              'order_intake_rejected', $3::jsonb, '{"lines": []}'::jsonb, $4)`),
    [id, externalOrderId, JSON.stringify(rawPayload), lastSuccess]);
  }

  async function insertStore(input: {
    id: number;
    vendorId: number;
    status?: string;
    setupStatus: string;
    lastOrderSyncAt?: Date;
  }): Promise<void> {
    await pool!.query(qualify(`INSERT INTO dropship.dropship_store_connections
      (id, vendor_id, platform, external_display_name, access_token_ref, refresh_token_ref,
       status, setup_status, last_order_sync_at, updated_at)
      VALUES ($1, $2, 'ebay', 'seller', 'access-ref', 'refresh-ref', $3, $4, $5, $6)`),
    [input.id, input.vendorId, input.status ?? "connected", input.setupStatus, input.lastOrderSyncAt ?? null, lastSuccess]);
  }

  async function insertStoppedHealth(storeConnectionId: number, vendorId: number): Promise<void> {
    await pool!.query(qualify(`INSERT INTO dropship.dropship_store_order_intake_health
      (store_connection_id, mode, status, consecutive_failures, last_attempt_at, last_success_at,
       last_failure_at, last_failure_code, last_failure_message, status_changed_at, created_at, updated_at)
      VALUES ($1, 'poll', 'stopped', 21, $2, $3, $2, 'DROPSHIP_EBAY_ORDER_MONEY_INVALID',
              'eBay order money value must be a non-negative decimal.', $2, $3, $2)`),
    [storeConnectionId, new Date("2026-10-02T01:01:38.000Z"), lastSuccess]);
    await insertCheck({ storeConnectionId, vendorId, checkKey: "order_intake_health", status: "failed", severity: "blocker" });
  }

  async function insertCheck(input: {
    storeConnectionId: number;
    vendorId: number;
    checkKey: string;
    status: string;
    severity: string;
    resolvedAt?: Date;
  }): Promise<void> {
    await pool!.query(qualify(`INSERT INTO dropship.dropship_store_setup_checks
      (vendor_id, store_connection_id, check_key, status, severity, message, details,
       last_checked_at, resolved_at, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, 'check', '{}'::jsonb, $6, $7, $6, $6)`),
    [input.vendorId, input.storeConnectionId, input.checkKey, input.status, input.severity, lastSuccess, input.resolvedAt ?? null]);
  }

  async function insertListing(input: {
    vendorId: number;
    storeConnectionId: number;
    variantId: number;
    externalListingId: string | null;
    status: string;
  }): Promise<void> {
    await pool!.query(qualify(`INSERT INTO dropship.dropship_vendor_listings
      (vendor_id, store_connection_id, product_variant_id, platform, external_listing_id, status)
      VALUES ($1, $2, $3, 'ebay', $4, $5)`),
    [input.vendorId, input.storeConnectionId, input.variantId, input.externalListingId, input.status]);
  }

  async function rows(sql: string): Promise<Array<Record<string, unknown>>> {
    return (await pool!.query(qualify(sql))).rows;
  }

  async function one(sql: string): Promise<Record<string, unknown> | undefined> {
    return (await rows(sql))[0];
  }
});

/** A pool whose every statement runs in the isolated test schema. */
function makeScopedPool(pool: pg.Pool, qualify: (sql: string) => string): Pool {
  return {
    query: (sql: string, values?: unknown[]) => pool.query(qualify(sql), values),
    connect: async () => {
      const client = await pool.connect();
      return {
        query: (sql: string, values?: unknown[]) => client.query(qualify(sql), values),
        release: (destroy?: boolean) => client.release(destroy),
      };
    },
  } as unknown as Pool;
}
