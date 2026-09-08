import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createInventoryCutoverTestDatabase, type InventoryCutoverTestDatabase } from "../../../inventory/__tests__/fixtures/inventory-cutover-database";
import { dispatchPlan, DISPATCH_TIME } from "../../../inventory/__tests__/fixtures/canonical-claim-dispatch";
import { PostgresCanonicalClaimInventoryRepository } from "../../../inventory/infrastructure/canonical-claim-inventory.repository";
import { WmsCanonicalClaimDispatchSourceOwner } from "../../../wms/canonical-claim-dispatch-source";
import type { CanonicalClaimDispatchBeforeCommit } from "../../application/inventory-availability-dispatch.port";
import { PostgresCanonicalClaimDispatchRepository } from "../../infrastructure/inventory-availability-dispatch.repository";
import {
  PostgresInventoryAvailabilityRuntimePublicationExecutor,
  PostgresTransactionScopedInventoryPublicationExecutor,
} from "../../infrastructure/inventory-availability-runtime-publication.repository";
import { PostgresInventoryPublicationOutboxRepository } from "../../infrastructure/inventory-publication-outbox.repository";
import { dispatchRuntimeFixtureSql, dispatchRuntimeSeedSql } from "../fixtures/inventory-availability-dispatch-runtime-fixture";
import { shipmentPublicationFixtureSql, shipmentPublicationIntent } from "../fixtures/shipment-publication.fixture";

const databaseUrl = process.env.ECHELON_TEST_DATABASE_URL;
const disposable = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
const describeDatabase = databaseUrl && disposable ? describe : describe.skip;
const migration = readFileSync(resolve(process.cwd(), "migrations/0662_inventory_availability_claim_dispatch.sql"), "utf8");

/** Actual dispatch/stock/WMS/queue owners; reduced publication tables, actual0662. */
describeDatabase.sequential("shipment publication caller-owned PostgreSQL transaction", () => {
  let database: InventoryCutoverTestDatabase;
  let pool: Pool;
  const enqueue: CanonicalClaimDispatchBeforeCommit = async ({ client }) => {
    await new PostgresTransactionScopedInventoryPublicationExecutor(client).execute(context =>
      context.enqueueFullPublications("1", [shipmentPublicationIntent()]));
  };
  const dispatch = (hook: CanonicalClaimDispatchBeforeCommit = enqueue) =>
    new PostgresCanonicalClaimDispatchRepository(pool, new WmsCanonicalClaimDispatchSourceOwner(),
      new PostgresCanonicalClaimInventoryRepository(), hook, () => DISPATCH_TIME);

  beforeAll(async () => {
    database = await createInventoryCutoverTestDatabase(databaseUrl, disposable,
      dispatchRuntimeFixtureSql + shipmentPublicationFixtureSql);
    pool = database.pool;
    await pool.query(migration);
  });
  beforeEach(async () => {
    await pool.query(`TRUNCATE inventory.inventory_publication_attempts, inventory.inventory_publication_readbacks,
      inventory.inventory_publication_outbox, inventory.availability_activation_runs RESTART IDENTITY;
      ${dispatchRuntimeSeedSql}
      INSERT INTO inventory.availability_activation_runs(id,mode,state) VALUES(1,'activation','active');`);
  });
  afterAll(async () => { await database?.close(); });

  async function state() {
    return {
      level: (await pool.query("SELECT variant_qty,reserved_qty,picked_qty FROM inventory.inventory_levels WHERE id=60")).rows[0],
      claim: (await pool.query("SELECT picked_target_qty::text,consumed_target_qty::text FROM inventory.availability_claim_lines WHERE id=20")).rows[0],
      receipts: (await pool.query("SELECT count(*)::int AS count FROM inventory.availability_claim_dispatch_receipts")).rows[0]?.count,
      shipments: (await pool.query("SELECT count(*)::int AS count FROM inventory.inventory_transactions WHERE transaction_type='ship'")).rows[0]?.count,
      outbox: (await pool.query("SELECT desired_quantity::text,desired_revision::text,state FROM inventory.inventory_publication_outbox ORDER BY id")).rows,
      activation: (await pool.query("SELECT outbox_enqueued FROM inventory.availability_activation_runs WHERE id=1")).rows[0],
    };
  }

  it("commits dispatch and durable queue together; exact command replay never inserts another desired row", async () => {
    const hook = vi.fn<CanonicalClaimDispatchBeforeCommit>(async input => {
      await enqueue(input);
      expect((await input.client.query("SELECT count(*)::int AS count FROM inventory.inventory_publication_outbox")).rows[0]?.count).toBe(1);
      expect((await pool.query("SELECT count(*)::int AS count FROM inventory.inventory_publication_outbox")).rows[0]?.count).toBe(0);
    });
    const repository = dispatch(hook);
    const result = await repository.dispatch(dispatchPlan().command);
    expect(await state()).toMatchObject({ receipts: 1, shipments: 1,
      claim: { picked_target_qty: "0", consumed_target_qty: "5" },
      outbox: [{ desired_quantity: "6", desired_revision: "1", state: "queued" }], activation: { outbox_enqueued: true } });
    const committed = await state();
    expect(await repository.dispatch(dispatchPlan().command)).toEqual(result);
    expect(await state()).toEqual(committed);
    expect(hook).toHaveBeenCalledOnce();
  });

  it("rolls back dispatch, physical custody, receipt and already-staged publication if any later owner fails", async () => {
    const before = await state();
    await expect(dispatch(async input => {
      await enqueue(input);
      throw new Error("later owner rejected");
    }).dispatch(dispatchPlan().command)).rejects.toThrow("later owner rejected");
    expect(await state()).toEqual(before);
  });

  it("rolls back earlier shipment writes when the real outbox queue transition fails", async () => {
    const before = await state();
    await pool.query(`CREATE FUNCTION inventory.reject_test_queue() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.state='queued' THEN RAISE EXCEPTION 'test queue rejected'; END IF; RETURN NEW; END; $$;
      CREATE TRIGGER reject_test_queue BEFORE UPDATE ON inventory.inventory_publication_outbox
      FOR EACH ROW EXECUTE FUNCTION inventory.reject_test_queue();`);
    try {
      await expect(dispatch().dispatch(dispatchPlan().command)).rejects.toThrow("test queue rejected");
      expect(await state()).toEqual(before);
    } finally {
      await pool.query("DROP TRIGGER reject_test_queue ON inventory.inventory_publication_outbox; DROP FUNCTION inventory.reject_test_queue()");
    }
  });

  it("rejects inactive activation without leaving dispatched stock or queue changes", async () => {
    await pool.query("UPDATE inventory.availability_activation_runs SET state='activating'");
    const before = await state();
    await expect(dispatch().dispatch(dispatchPlan().command))
      .rejects.toMatchObject({ code: "INVENTORY_PUBLICATION_ACTIVATION_NOT_ACTIVE" });
    expect(await state()).toEqual(before);
  });

  it("breaks the real worker target-lock/activation-acknowledgement cycle by failing the owner immediately", async () => {
    const standalone = new PostgresInventoryAvailabilityRuntimePublicationExecutor(pool);
    await standalone.execute(context => context.enqueueFullPublications("1", [shipmentPublicationIntent()]));
    const worker = new PostgresInventoryPublicationOutboxRepository(pool);
    const now = new Date("2099-01-01T00:00:00.000Z");
    const [claim] = await worker.claimDue({ batchSize: 1, leaseSeconds: 120, leaseToken: "test-worker", now });
    expect(claim).toBeDefined();
    const client = await pool.connect();
    let acknowledgement: Promise<unknown> | undefined;
    try {
      await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      await client.query("SET LOCAL statement_timeout='5s'");
      const executor = new PostgresTransactionScopedInventoryPublicationExecutor(client);
      await expect(executor.execute(async context => {
        // runIfCurrent really holds its session target lock while recordVerified
        // opens a second connection and waits on our active-run FOR SHARE lock.
        acknowledgement = worker.runIfCurrent(claim!, () => worker.recordVerified(claim!, {
          observedQuantity: 6, providerResponse: { fixture: true }, completedAt: now,
        }));
        await vi.waitFor(async () => {
          const waiting = await pool.query(`SELECT count(*)::int AS total FROM pg_stat_activity
            WHERE datname=current_database() AND wait_event_type='Lock'
              AND query LIKE 'SELECT id FROM inventory.availability_activation_runs%FOR UPDATE%'
              AND pid <> pg_backend_pid()`);
          expect(waiting.rows[0]?.total).toBe(1);
        }, { timeout: 2_000, interval: 10 });
        return context.enqueueFullPublications("1", [shipmentPublicationIntent("4")]);
      })).rejects.toMatchObject({ code: "INVENTORY_PUBLICATION_TARGET_BUSY", context: { retryable: true } });
    } finally {
      await client.query("ROLLBACK");
      client.release();
      if (acknowledgement) await acknowledgement;
    }
    await expect(acknowledgement).resolves.toEqual({ status: "current", value: "verified" });
    expect((await state()).outbox).toEqual([{ desired_quantity: "6", desired_revision: "1", state: "verified" }]);
    // Retry is a NEW owning transaction after releasing its activation/stock locks.
    await standalone.execute(context => context.enqueueFullPublications("1", [shipmentPublicationIntent("4")]));
    expect((await state()).outbox.at(-1)).toEqual({ desired_quantity: "4", desired_revision: "2", state: "queued" });
  }, 10_000);
});
