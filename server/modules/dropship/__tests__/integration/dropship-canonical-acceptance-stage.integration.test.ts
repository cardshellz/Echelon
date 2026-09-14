import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createInventoryCutoverTestDatabase,
  type InventoryCutoverTestDatabase,
} from "../../../inventory/__tests__/fixtures/inventory-cutover-database";

const databaseUrl = process.env.ECHELON_TEST_DATABASE_URL;
const disposable = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
const describeDatabase = databaseUrl && disposable ? describe : describe.skip;
const migration = readFileSync(
  resolve(process.cwd(), "migrations/0667_dropship_canonical_acceptance_stages.sql"),
  "utf8",
);

const fixtureSql = `
  CREATE SCHEMA dropship;
  CREATE SCHEMA oms;
  CREATE SCHEMA warehouse;
  CREATE SCHEMA wms;
  CREATE SCHEMA inventory;
  CREATE TABLE dropship.dropship_order_intake (id integer PRIMARY KEY);
  CREATE TABLE dropship.dropship_vendors (id integer PRIMARY KEY);
  CREATE TABLE dropship.dropship_store_connections (id integer PRIMARY KEY);
  CREATE TABLE dropship.dropship_shipping_quote_snapshots (id integer PRIMARY KEY);
  CREATE TABLE dropship.dropship_wallet_accounts (id integer PRIMARY KEY);
  CREATE TABLE oms.oms_orders (id bigint PRIMARY KEY);
  CREATE TABLE warehouse.warehouses (id integer PRIMARY KEY);
  CREATE TABLE wms.orders (id integer PRIMARY KEY);
  CREATE TABLE inventory.availability_claims (
    id bigint PRIMARY KEY,
    order_id integer NOT NULL,
    status varchar(30) NOT NULL
  );
`;

describeDatabase.sequential("dropship canonical acceptance saga PostgreSQL constraints", () => {
  let database: InventoryCutoverTestDatabase | undefined;

  beforeAll(async () => {
    database = await createInventoryCutoverTestDatabase(databaseUrl, disposable, fixtureSql);
    await database.pool.query(migration);
  });

  beforeEach(async () => {
    await database!.pool.query(`
      TRUNCATE dropship.dropship_order_acceptance_stages,
        dropship.dropship_order_intake, dropship.dropship_vendors,
        dropship.dropship_store_connections, dropship.dropship_shipping_quote_snapshots,
        dropship.dropship_wallet_accounts, oms.oms_orders, warehouse.warehouses,
        wms.orders, inventory.availability_claims CASCADE;
      INSERT INTO dropship.dropship_order_intake VALUES (1);
      INSERT INTO dropship.dropship_vendors VALUES (10);
      INSERT INTO dropship.dropship_store_connections VALUES (22);
      INSERT INTO dropship.dropship_shipping_quote_snapshots VALUES (33);
      INSERT INTO dropship.dropship_wallet_accounts VALUES (44);
      INSERT INTO oms.oms_orders VALUES (1001);
      INSERT INTO warehouse.warehouses VALUES (3), (4);
      INSERT INTO wms.orders VALUES (9001);
      INSERT INTO inventory.availability_claims VALUES
        (7001, 9001, 'active'),
        (7002, 9001, 'active');
    `);
  });

  afterAll(async () => {
    await database?.close();
  });

  async function inTransaction(work: (client: PoolClient) => Promise<void>): Promise<void> {
    const client = await database!.pool.connect();
    try {
      await client.query("BEGIN");
      await work(client);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async function insertPrepared(): Promise<void> {
    await database!.pool.query(`
      INSERT INTO dropship.dropship_order_acceptance_stages
        (intake_id, oms_order_id, vendor_id, store_connection_id,
         shipping_quote_snapshot_id, warehouse_id, wallet_account_id, state,
         request_hash, submitted_idempotency_key, actor_type, actor_id,
         member_id, membership_plan_id, currency, retail_subtotal_cents,
         wholesale_subtotal_cents, shipping_cents, insurance_pool_cents,
         fees_cents, total_debit_cents, cost_evidence_hash, pricing_snapshot,
         prepared_at, updated_at)
      VALUES
        (1, 1001, 10, 22, 33, 3, 44, 'prepared', $1, 'accept-1', 'system', NULL,
         'member-1', 'ops', 'USD', 3000, 2000, 1000, 0, 0, 3000, $2, '{}'::jsonb,
         '2026-09-14T00:00:00Z', '2026-09-14T00:00:00Z')
    `, ["a".repeat(64), "b".repeat(64)]);
  }

  async function recordClaim(
    attemptNumber: number,
    claimedAt = "2026-09-14T00:01:00Z",
    inventoryClaimId: number | null = 7000 + attemptNumber,
  ): Promise<void> {
    await inTransaction(async (client) => {
      await client.query(`INSERT INTO dropship.dropship_order_acceptance_claim_attempts
        (intake_id, attempt_number, oms_order_id, wms_order_id, warehouse_id,
         claim_outcome, availability_claim_id, state, claimed_at, updated_at)
        VALUES (1, $1, 1001, 9001, 3, $2, $3, 'claimed', $4, $4)`, [
        attemptNumber,
        inventoryClaimId === null ? "no_claim_required" : "claimed",
        inventoryClaimId,
        claimedAt,
      ]);
      await client.query(`UPDATE dropship.dropship_order_acceptance_stages
        SET state='inventory_claimed', claim_attempt_number=$1, wms_order_id=9001,
            inventory_claimed_at=$2, updated_at=$2
        WHERE intake_id=1`, [attemptNumber, claimedAt]);
    });
  }

  async function requestRelease(
    attemptNumber: number,
    requestedAt = "2026-09-14T00:02:00Z",
  ): Promise<void> {
    await inTransaction(async (client) => {
      await client.query(`UPDATE dropship.dropship_order_acceptance_claim_attempts
        SET state='compensation_pending', release_requested_at=$2,
            release_reason='wallet_balance_changed_before_finalization', updated_at=$2
        WHERE intake_id=1 AND attempt_number=$1`, [attemptNumber, requestedAt]);
      await client.query(`UPDATE dropship.dropship_order_acceptance_stages
        SET state='compensation_pending', inventory_release_requested_at=$1,
            inventory_release_reason='wallet_balance_changed_before_finalization', updated_at=$1
        WHERE intake_id=1`, [requestedAt]);
    });
  }

  async function recordRelease(
    attemptNumber: number,
    releasedAt = "2026-09-14T00:03:00Z",
  ): Promise<void> {
    await inTransaction(async (client) => {
      await client.query(`UPDATE inventory.availability_claims
        SET status='released' WHERE id=$1 AND status='active'`, [7000 + attemptNumber]);
      await client.query(`UPDATE dropship.dropship_order_acceptance_claim_attempts
        SET state='released', released_at=$2, updated_at=$2
        WHERE intake_id=1 AND attempt_number=$1`, [attemptNumber, releasedAt]);
      await client.query(`UPDATE dropship.dropship_order_acceptance_stages
        SET state='inventory_released', inventory_released_at=$1, updated_at=$1
        WHERE intake_id=1`, [releasedAt]);
    });
  }

  it("supports claimed -> pending -> released -> expired with one immutable attempt identity", async () => {
    await insertPrepared();
    await recordClaim(1);
    await requestRelease(1);
    await recordRelease(1);
    await inTransaction(async (client) => {
      await client.query(`UPDATE dropship.dropship_order_acceptance_claim_attempts
        SET state='expired', expired_at='2026-09-14T00:04:00Z', updated_at='2026-09-14T00:04:00Z'
        WHERE intake_id=1 AND attempt_number=1`);
      await client.query(`UPDATE dropship.dropship_order_acceptance_stages
        SET state='expired', expired_at='2026-09-14T00:04:00Z', updated_at='2026-09-14T00:04:00Z'
        WHERE intake_id=1`);
    });

    expect((await database!.pool.query(`SELECT state, claim_attempt_number, wms_order_id,
      warehouse_id, inventory_release_reason FROM dropship.dropship_order_acceptance_stages`)).rows)
      .toEqual([{
        state: "expired",
        claim_attempt_number: 1,
        wms_order_id: 9001,
        warehouse_id: 3,
        inventory_release_reason: "wallet_balance_changed_before_finalization",
      }]);
    expect((await database!.pool.query(`SELECT attempt_number, state, wms_order_id
      FROM dropship.dropship_order_acceptance_claim_attempts`)).rows)
      .toEqual([{ attempt_number: 1, state: "expired", wms_order_id: 9001 }]);
  });

  it("rejects compensation intent without an auditable reason", async () => {
    await insertPrepared();
    await recordClaim(1);

    await expect(database!.pool.query(`UPDATE dropship.dropship_order_acceptance_claim_attempts
      SET state='compensation_pending', release_requested_at='2026-09-14T00:02:00Z',
          updated_at='2026-09-14T00:02:00Z'
      WHERE intake_id=1 AND attempt_number=1`))
      .rejects.toMatchObject({ code: "23514" });
  });

  it("records an explicit no-claim outcome for digital demand without inventing inventory ownership", async () => {
    await insertPrepared();
    await expect(recordClaim(1, "2026-09-14T00:01:00Z", null)).rejects.toMatchObject({
      code: "23514",
      message: "dropship acceptance no-claim attempt conflicts with active inventory ownership",
    });
    await database!.pool.query(`DELETE FROM inventory.availability_claims WHERE order_id=9001`);
    await recordClaim(1, "2026-09-14T00:01:00Z", null);

    expect((await database!.pool.query(`SELECT claim_outcome, availability_claim_id, state
      FROM dropship.dropship_order_acceptance_claim_attempts`)).rows)
      .toEqual([{
        claim_outcome: "no_claim_required",
        availability_claim_id: null,
        state: "claimed",
      }]);
  });

  it("reopens only after release and preserves the first attempt before a second claim finalizes", async () => {
    await insertPrepared();
    await recordClaim(1);
    await requestRelease(1);
    await recordRelease(1);
    await database!.pool.query(`UPDATE dropship.dropship_order_acceptance_stages
      SET state='prepared', claim_attempt_number=NULL, wms_order_id=NULL,
          inventory_claimed_at=NULL, inventory_release_requested_at=NULL,
          inventory_released_at=NULL, inventory_release_reason=NULL,
          updated_at='2026-09-14T00:04:00Z'
      WHERE intake_id=1`);
    await expect(database!.pool.query(`INSERT INTO dropship.dropship_order_acceptance_claim_attempts
      (intake_id, attempt_number, oms_order_id, wms_order_id, warehouse_id,
       claim_outcome, availability_claim_id, state, claimed_at, updated_at)
      VALUES (1, 2, 1001, 9001, 3, 'claimed', 7001, 'claimed',
              '2026-09-14T00:05:00Z', '2026-09-14T00:05:00Z')`))
      .rejects.toMatchObject({ code: "23514" });
    await recordClaim(2, "2026-09-14T00:05:00Z");
    await inTransaction(async (client) => {
      await client.query(`UPDATE dropship.dropship_order_acceptance_claim_attempts
        SET state='finalized', finalized_at='2026-09-14T00:06:00Z', updated_at='2026-09-14T00:06:00Z'
        WHERE intake_id=1 AND attempt_number=2`);
      await client.query(`UPDATE dropship.dropship_order_acceptance_stages
        SET state='finalized', finalized_at='2026-09-14T00:06:00Z', updated_at='2026-09-14T00:06:00Z'
        WHERE intake_id=1`);
    });

    expect((await database!.pool.query(`SELECT attempt_number, state
      FROM dropship.dropship_order_acceptance_claim_attempts ORDER BY attempt_number`)).rows)
      .toEqual([
        { attempt_number: 1, state: "released" },
        { attempt_number: 2, state: "finalized" },
      ]);
    expect((await database!.pool.query(`SELECT state, claim_attempt_number
      FROM dropship.dropship_order_acceptance_stages`)).rows)
      .toEqual([{ state: "finalized", claim_attempt_number: 2 }]);
  });

  it("rejects frozen quote evidence mutation and deletion of historical attempts", async () => {
    await insertPrepared();
    await recordClaim(1);

    await expect(database!.pool.query(`UPDATE dropship.dropship_order_acceptance_stages
      SET warehouse_id=4, updated_at='2026-09-14T00:02:00Z' WHERE intake_id=1`))
      .rejects.toMatchObject({
        code: "23514",
        message: "dropship acceptance stage frozen evidence is immutable",
      });
    await expect(database!.pool.query(`UPDATE dropship.dropship_order_acceptance_claim_attempts
      SET warehouse_id=4 WHERE intake_id=1 AND attempt_number=1`))
      .rejects.toMatchObject({ code: "23514" });
    await expect(database!.pool.query(`DELETE FROM dropship.dropship_order_acceptance_claim_attempts
      WHERE intake_id=1 AND attempt_number=1`))
      .rejects.toMatchObject({ code: "23514" });
  });

  it("serializes exact claim replays and rejects a parent state that outruns its attempt", async () => {
    await insertPrepared();
    await recordClaim(1);
    const replay = () => database!.pool.query(`UPDATE dropship.dropship_order_acceptance_stages
      SET state='inventory_claimed', claim_attempt_number=1, wms_order_id=9001,
          inventory_claimed_at='2026-09-14T00:01:00Z', updated_at='2026-09-14T00:01:00Z'
      WHERE intake_id=1`);

    await Promise.all([replay(), replay()]);
    await expect(database!.pool.query(`UPDATE dropship.dropship_order_acceptance_stages
      SET state='finalized', finalized_at='2026-09-14T00:02:00Z',
          updated_at='2026-09-14T00:02:00Z' WHERE intake_id=1`))
      .rejects.toMatchObject({
        code: "23514",
        message: "dropship acceptance stage does not match its current claim attempt",
      });
    expect((await database!.pool.query(`SELECT COUNT(*)::int AS count
      FROM dropship.dropship_order_acceptance_claim_attempts`)).rows[0]?.count).toBe(1);
  });
});
