import { getTableConfig } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { omsOrderEvents, omsOrderLines, omsOrders, webhookRetryQueue } from "@shared/schema/oms.schema";
import { outboundShipmentItems, outboundShipments, wmsOrderItems, wmsOrders } from "@shared/schema";
import {
  createQuantityLedgerTestContext,
  type QuantityLedgerTestContext,
} from "../../../inventory/__tests__/fixtures/quantity-ledger-database";
import { PostgresCanonicalClaimInventoryRepository } from "../../../inventory/infrastructure/canonical-claim-inventory.repository";
import { InventoryAvailabilityClaimService } from "../../../inventory-planning/application/inventory-availability-claim.service";
import { AuthorityAwareReservationService } from "../../../inventory-planning/application/inventory-availability-runtime-claim.service";
import { PostgresInventoryAvailabilityClaimRepository } from "../../../inventory-planning/infrastructure/inventory-availability-claim.repository";
import { PostgresInventoryAvailabilityRuntimeClaimExecutor } from "../../../inventory-planning/infrastructure/inventory-availability-runtime-claim.repository";
import { acquireInventoryCutoverFenceInsideTransaction } from "../../../inventory-planning/infrastructure/inventory-cutover-admission-fence.repository";
import { promoteInventoryCutoverDefinitionsInsideTransaction } from "../../../inventory-planning/infrastructure/inventory-cutover-definitions.repository";
import type { ReservationServiceContract } from "../../../channels/reservation.service";
import { OrderEditOmsSynchronizer } from "../../../order-edits/infrastructure/order-edit-oms-synchronizer";
import { baseline } from "../../../order-edits/__tests__/fixtures/order-edit-service.fixture";
import { WmsSyncService } from "../../wms-sync.service";
import { settledRefundEditFixture } from "../../../order-edits/__tests__/fixtures/settled-refund-edit.fixture";

const database = vi.hoisted(() => ({
  current: null as ReturnType<typeof drizzle> | null,
}));
vi.mock("../../../../db", () => ({
  pool: {},
  db: new Proxy(
    {},
    {
      get(_target, property) {
        if (!database.current)
          throw new Error("Disposable WMS test database is not initialized");
        const member = Reflect.get(database.current, property);
        return typeof member === "function"
          ? member.bind(database.current)
          : member;
      },
    },
  ),
}));

const databaseUrl = process.env.ECHELON_TEST_DATABASE_URL;
const disposable = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
const suite = databaseUrl && disposable ? describe : describe.skip;
const now = new Date("2026-10-21T18:00:00Z");
const operationId = "11111111-1111-4111-8111-111111111111";

interface ReconciliationPort {
  reserveBeforeShipmentProcessing(orderId: number, omsOrderId: number, context: string): Promise<void>;
  reconcileExistingWmsOrderLines(
    omsOrderId: number,
    wmsOrderId: number,
  ): Promise<{ insertedItems: number; updatedShipments: number }>;
}

// The quantity fixture owns the real canonical migrations. Add the ordinary
// read-model columns selected by WMS without replacing any claim/ledger logic.
async function installWmsReadColumns(pool: Pool): Promise<void> {
  for (const table of [omsOrders, omsOrderLines, wmsOrders, wmsOrderItems]) {
    const definition = getTableConfig(table);
    const relation = `"${definition.schema}"."${definition.name}"`;
    for (const column of definition.columns) {
      await pool.query(
        `ALTER TABLE ${relation} ADD COLUMN IF NOT EXISTS "${column.name}" ${column.getSQLType()}`,
      );
    }
  }
}

suite.sequential("existing shipment inventory demand reconciliation", () => {
  let context: QuantityLedgerTestContext;
  let reservations: AuthorityAwareReservationService;
  let reconciler: ReconciliationPort;

  beforeEach(async () => {
    context = await createQuantityLedgerTestContext(databaseUrl, disposable);
    await installWmsReadColumns(context.pool);
    await context.open();
    // Promote the fixture's reviewed definitions through their real owner;
    // never bypass immutable definitions or disable configuration guards.
    await context.transaction(async (client) => {
      const freezes = (
        await client.query<{ id: string }>(
          "SELECT activation_run_id::text AS id FROM inventory.availability_activation_freezes WHERE released_at IS NULL",
        )
      ).rows;
      expect(freezes).toHaveLength(1);
      await acquireInventoryCutoverFenceInsideTransaction(client, {
        expectedAuthority: "canonical",
        expectedConfigurationRunId: freezes[0].id,
      });
      const selections = (
        await client.query<{
          kind: "model" | "safety_policy";
          key: string;
          definition_id: number;
          definition_hash: string;
        }>(`
        SELECT 'model' AS kind,head.product_id::text AS key,definition.id AS definition_id,definition.definition_hash
          FROM inventory.transformation_model_heads head JOIN inventory.transformation_model_versions definition ON definition.id=head.draft_model_id
        UNION ALL
        SELECT 'safety_policy',head.scope_key,definition.id,definition.definition_hash
          FROM inventory.promise_safety_policy_heads head JOIN inventory.promise_safety_policy_versions definition ON definition.id=head.draft_policy_id
      `)
      ).rows.map((row) => ({
        kind: row.kind,
        key: row.key,
        definitionId: row.definition_id,
        definitionHash: row.definition_hash,
      }));
      await promoteInventoryCutoverDefinitionsInsideTransaction(
        client,
        {
          contractVersion: "inventory_cutover_selection_manifest_v1",
          productIds: [20],
          publicationTargetIds: [],
          selections,
        },
        {
          actor: "operator",
          reason: "Reviewed synthetic inventory configuration",
          occurredAt: now,
        },
      );
    });
    database.current = drizzle(context.pool);
    const claims = new InventoryAvailabilityClaimService(
      new PostgresInventoryAvailabilityClaimRepository(
        new PostgresCanonicalClaimInventoryRepository(),
        context.pool,
        () => now,
      ),
    );
    const legacy = new Proxy({} as ReservationServiceContract, {
      get() {
        throw new Error("Canonical test must never enter legacy reservations");
      },
    });
    reservations = new AuthorityAwareReservationService(
      new PostgresInventoryAvailabilityRuntimeClaimExecutor(
        legacy,
        claims,
        context.pool,
      ),
    );
    reconciler = new WmsSyncService({
      reservation: reservations,
    } as unknown as ConstructorParameters<
      typeof WmsSyncService
    >[0]) as unknown as ReconciliationPort;
    await context.pool.query(`
      INSERT INTO oms.oms_orders(id,status,channel_id,external_order_id,currency,total_cents,financial_status)
        VALUES(2,'confirmed',36,'100','USD',2000,'paid');
      INSERT INTO oms.oms_order_lines(id,order_id,external_line_item_id,product_variant_id,sku,requires_shipping,quantity,
        authority_fulfillable_quantity,wms_materialized_quantity,authorization_status,paid_price_cents,total_price_cents)
        VALUES(21,2,'201',101,'P5',true,1,1,1,'authorized',1000,1000);
      INSERT INTO wms.orders(id,warehouse_id,warehouse_status,on_hold,channel_id,source,external_order_id,
        oms_fulfillment_order_id,source_table_id,order_edit_operation_id) VALUES(2,1,'ready',0,36,'oms','100','2','2','${operationId}');
      INSERT INTO wms.order_items(id,order_id,oms_order_line_id,sku,product_id,catalog_product_id,inventory_tracking,
        quantity,picked_quantity,fulfilled_quantity,status,on_hold,requires_shipping)
        VALUES(21,2,21,'P5',101,20,true,1,0,0,'pending',false,1);
    `);
    try {
      await reservations.reserveOrder(2);
      // Ordinary synchronization already replayed the original active claim
      // before the edit. Its cached receipt must not certify later demand.
      await reservations.reserveOrder(2);
    } catch (error) {
      throw new Error(
        `Initial fixture reservation failed: ${JSON.stringify((error as { context?: unknown }).context)}`,
        { cause: error },
      );
    }
    // Reproduce the production mismatch: both items are in the shipment, but
    // only the original item exists in the previously satisfied claim.
    await context.pool.query(`
      INSERT INTO oms.oms_order_lines(id,order_id,external_line_item_id,product_variant_id,sku,requires_shipping,quantity,
        authority_fulfillable_quantity,wms_materialized_quantity,authorization_status,paid_price_cents,total_price_cents)
        VALUES(22,2,'202',101,'P5',true,1,1,1,'authorized',1000,1000);
      INSERT INTO wms.order_items(id,order_id,oms_order_line_id,sku,product_id,catalog_product_id,inventory_tracking,
        quantity,picked_quantity,fulfilled_quantity,status,on_hold,requires_shipping)
        VALUES(22,2,22,'P5',101,20,true,1,0,0,'pending',false,1);
      INSERT INTO wms.outbound_shipments(id,order_id,status) VALUES(2,2,'queued');
      INSERT INTO wms.outbound_shipment_items(id,shipment_id,order_item_id,product_variant_id,qty)
        VALUES(21,2,21,101,1),(22,2,22,101,1);
    `);
  }, 60_000);

  afterEach(async () => {
    vi.restoreAllMocks();
    database.current = null;
    await context?.close();
  });

  async function inventoryEvidence() {
    return {
      claims: (
        await context.pool.query(
          "SELECT id,revision,status FROM inventory.availability_claims WHERE order_id=2 ORDER BY revision",
        )
      ).rows,
      lines: (
        await context.pool
          .query(`SELECT line.order_item_id,line.requested_qty::text,line.planned_qty::text
        FROM inventory.availability_claim_lines line JOIN inventory.availability_claims claim ON claim.id=line.claim_id
        WHERE claim.order_id=2 AND claim.status='active' ORDER BY line.order_item_id`)
      ).rows,
      reserved: (
        await context.pool.query(
          "SELECT reserved_qty FROM inventory.inventory_levels WHERE id=10",
        )
      ).rows[0].reserved_qty,
      shipment: (
        await context.pool.query(
          "SELECT order_item_id,qty FROM wms.outbound_shipment_items WHERE shipment_id=2 ORDER BY order_item_id",
        )
      ).rows,
      holds: (
        await context.pool.query(
          "SELECT on_hold,order_edit_operation_id FROM wms.orders WHERE id=2",
        )
      ).rows,
      quantityEntries: (
        await context.pool.query(
          "SELECT count(*)::int AS count FROM inventory.quantity_entries",
        )
      ).rows[0].count,
    };
  }

  it.each(["pending", "awaiting_3pl", "cancelled"])(
    "does not reserve inventory for an order in %s status",
    async (status) => {
      await context.pool.query("UPDATE wms.orders SET warehouse_status=$1 WHERE id=2", [status]);
      const before = await inventoryEvidence();
      const reserve = vi.spyOn(reservations, "reserveOrder");
      await reconciler.reconcileExistingWmsOrderLines(2, 2);
      expect(reserve).not.toHaveBeenCalled();
      expect(await inventoryEvidence()).toEqual(before);
    },
    30_000,
  );

  it("replaces the stale claim through the canonical owner even when the shipment already contains every item", async () => {
    const before = await inventoryEvidence();
    expect(before.lines).toHaveLength(1);
    const snapshot = baseline();
    snapshot.lines = ["201", "202"].map((id) => ({
      ...snapshot.lines[0],
      id: `gid://shopify/LineItem/${id}`,
      variantId: "gid://shopify/ProductVariant/101",
      quantity: 1,
      unfulfilledQuantity: 1,
      totalCents: 1000,
    }));
    const synchronize = new OrderEditOmsSynchronizer(
      context.pool,
      {
        syncOmsOrderToWms: async (id) => {
          await reconciler.reconcileExistingWmsOrderLines(id, 2);
          return 2;
        },
      },
      reservations,
      async () => {
        /* Fixture OMS rows already contain certified paid authority. */
      },
    );
    await synchronize.synchronize(2, snapshot, operationId);
    const after = await inventoryEvidence();
    expect(after.claims.map((claim) => claim.status)).toEqual([
      "superseded",
      "active",
    ]);
    expect(after.lines).toEqual([
      { order_item_id: 21, requested_qty: "1", planned_qty: "1" },
      { order_item_id: 22, requested_qty: "1", planned_qty: "1" },
    ]);
    expect(after.reserved).toBe(before.reserved + 1);
    expect(after.shipment).toEqual(before.shipment);
    await synchronize.synchronize(2, snapshot, operationId);
    expect(await inventoryEvidence()).toEqual(after);
  }, 30_000);

  it("rebuilds only the channel's remaining units into a new shipment after a verified stopped-edit recovery, once across retries", async () => {
    // The gateway suite proves refund settlement, remote cancellation and the
    // owned header restoration. Start here after that proof, retaining manual
    // and edit holds, and exercise the ordinary materializer and real claims.
    await context.pool.query(`CREATE TABLE IF NOT EXISTS oms.webhook_retry_queue(id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS oms.oms_order_events(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY);
      CREATE TABLE oms.order_edit_operations(id uuid PRIMARY KEY,oms_order_id bigint,status text,document jsonb);
      CREATE TABLE oms.order_edit_events(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,operation_id uuid,connection_id integer,
        actor_id text,action text,before_state jsonb,after_state jsonb,occurred_at timestamptz,
        customer_actor_channel_id integer,customer_actor_external_id text);`);
    const operation = { ...settledRefundEditFixture(operationId, now), omsOrderId: 2 };
    await context.pool.query("INSERT INTO oms.order_edit_operations VALUES($1,2,'synchronizing',$2::jsonb)", [operationId, JSON.stringify(operation)]);
    await context.pool.query(`INSERT INTO oms.order_edit_events(operation_id,action,after_state)
      VALUES($1,'stopped_refund_warehouse_restored','{"restoredOrderIds":[2]}')`, [operationId]);
    reconciler = new WmsSyncService({ reservation: reservations, useChannelMerchandise: () => true, clock: () => now } as unknown as
      ConstructorParameters<typeof WmsSyncService>[0]) as unknown as ReconciliationPort;
    for (const table of [outboundShipments, outboundShipmentItems, webhookRetryQueue, omsOrderEvents]) {
      const definition = getTableConfig(table);
      for (const column of definition.columns) await context.pool.query(
        `ALTER TABLE "${definition.schema}"."${definition.name}" ADD COLUMN IF NOT EXISTS "${column.name}" ${column.getSQLType()}`,
      );
    }
    await context.pool.query(`ALTER TABLE wms.outbound_shipments ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (START WITH 1000);
      ALTER TABLE wms.outbound_shipment_items ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (START WITH 1000);
      UPDATE oms.oms_orders SET external_order_id='1',total_cents=900 WHERE id=2;
      UPDATE oms.oms_order_lines SET quantity=0,authority_fulfillable_quantity=0,external_line_item_id='101' WHERE id=21;
      UPDATE oms.oms_order_lines SET external_line_item_id='102' WHERE id=22;
      UPDATE wms.order_items SET quantity=0,status='cancelled' WHERE id=21;
      UPDATE wms.orders SET on_hold=1 WHERE id=2;
      UPDATE wms.outbound_shipments SET status='cancelled',shipping_engine='shipstation',shipstation_order_id=55 WHERE id=2;`);
    await reconciler.reconcileExistingWmsOrderLines(2, 2);
    const first = await inventoryEvidence();
    expect(first.lines).toEqual([{ order_item_id: 22, requested_qty: "1", planned_qty: "1" }]);
    expect(first.holds).toEqual([{ on_hold: 1, order_edit_operation_id: operationId }]);
    const shipment = (await context.pool.query("SELECT id,status FROM wms.outbound_shipments WHERE order_id=2 AND status<>'cancelled'")).rows;
    expect(shipment).toHaveLength(1);
    expect(shipment[0].status).toBe("planned");
    expect((await context.pool.query("SELECT order_item_id,qty FROM wms.outbound_shipment_items WHERE shipment_id=$1", [shipment[0].id])).rows)
      .toEqual([{ order_item_id: 22, qty: 1 }]);
    await reconciler.reconcileExistingWmsOrderLines(2, 2);
    expect(await inventoryEvidence()).toEqual(first);
    expect((await context.pool.query("SELECT count(*)::int AS n FROM wms.outbound_shipments WHERE order_id=2 AND status<>'cancelled'")).rows[0].n).toBe(1);
    expect((await context.pool.query("SELECT count(*)::int AS n FROM oms.webhook_retry_queue WHERE topic='shipstation_shipment_push'")).rows[0].n).toBe(0);
    expect((await context.pool.query("SELECT count(*)::int AS n FROM oms.order_edit_events WHERE action='stopped_refund_new_shipment_deferred'")).rows[0].n).toBe(1);
  }, 30_000);

  it("reconciles another demand change after the replacement claim's receipt was cached", async () => {
    await reconciler.reconcileExistingWmsOrderLines(2, 2);
    await reconciler.reconcileExistingWmsOrderLines(2, 2);
    const before = await inventoryEvidence();
    await context.pool.query(`
      UPDATE oms.oms_orders SET total_cents=3000 WHERE id=2;
      UPDATE oms.oms_order_lines SET quantity=2,authority_fulfillable_quantity=2,
        wms_materialized_quantity=2,total_price_cents=2000 WHERE id=22;
      UPDATE wms.order_items SET quantity=2 WHERE id=22;
      UPDATE wms.outbound_shipment_items SET qty=2 WHERE order_item_id=22;
    `);
    await reconciler.reconcileExistingWmsOrderLines(2, 2);
    const after = await inventoryEvidence();
    expect(after.claims.map(claim => claim.status)).toEqual(["superseded", "superseded", "active"]);
    expect(after.lines).toEqual([
      { order_item_id: 21, requested_qty: "1", planned_qty: "1" },
      { order_item_id: 22, requested_qty: "2", planned_qty: "2" },
    ]);
    expect(after.reserved).toBe(before.reserved + 1);
    expect(after.holds).toEqual(before.holds);
    await reconciler.reconcileExistingWmsOrderLines(2, 2);
    expect(await inventoryEvidence()).toEqual(after);
  }, 30_000);

  it("keeps unchanged inventory stable across initial and existing sync contexts", async () => {
    await reconciler.reconcileExistingWmsOrderLines(2, 2);
    const before = await inventoryEvidence();
    await reconciler.reserveBeforeShipmentProcessing(2, 2, "post_create");
    await reconciler.reconcileExistingWmsOrderLines(2, 2);
    await reconciler.reserveBeforeShipmentProcessing(2, 2, "post_create");
    expect(await inventoryEvidence()).toEqual(before);
  }, 30_000);

  it("retains the original claim on a failed replacement, then repairs once on retry", async () => {
    const before = await inventoryEvidence();
    const replace = vi
      .spyOn(reservations, "reconcileOrderDemand")
      .mockRejectedValueOnce(
        new Error("Synthetic replacement transport failure"),
      );
    await expect(
      reconciler.reconcileExistingWmsOrderLines(2, 2),
    ).rejects.toMatchObject({ code: "WMS_SHIPMENT_PREREQUISITE_FAILED" });
    expect(await inventoryEvidence()).toEqual(before);
    await reconciler.reconcileExistingWmsOrderLines(2, 2);
    expect((await inventoryEvidence()).lines).toHaveLength(2);
    expect(replace).toHaveBeenCalledTimes(2);
  }, 30_000);

  it("rolls back released stock and claim lineage if saving the replacement fails", async () => {
    const before = await inventoryEvidence();
    await context.pool.query(`
      CREATE FUNCTION inventory.reject_synthetic_new_claim_line() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.order_item_id=22 THEN RAISE EXCEPTION 'Synthetic replacement persistence failure' USING ERRCODE='23514'; END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER reject_synthetic_new_claim_line BEFORE INSERT ON inventory.availability_claim_lines
        FOR EACH ROW EXECUTE FUNCTION inventory.reject_synthetic_new_claim_line();
    `);
    await expect(
      reconciler.reconcileExistingWmsOrderLines(2, 2),
    ).rejects.toMatchObject({ code: "WMS_SHIPMENT_PREREQUISITE_FAILED" });
    expect(await inventoryEvidence()).toEqual(before);
    await context.pool.query(
      "DROP TRIGGER reject_synthetic_new_claim_line ON inventory.availability_claim_lines",
    );
    await reconciler.reconcileExistingWmsOrderLines(2, 2);
    const after = await inventoryEvidence();
    expect(after.lines).toHaveLength(2);
    expect(after.reserved).toBe(before.reserved + 1);
    expect(after.holds).toEqual(before.holds);
  }, 30_000);

  it("converges concurrent synchronization attempts without allocating twice", async () => {
    const before = await inventoryEvidence();
    const attempts = await Promise.allSettled([
      reconciler.reconcileExistingWmsOrderLines(2, 2),
      reconciler.reconcileExistingWmsOrderLines(2, 2),
    ]);
    expect(attempts.some((attempt) => attempt.status === "fulfilled")).toBe(
      true,
    );
    for (const attempt of attempts) {
      if (attempt.status === "rejected")
        expect(attempt.reason).toMatchObject({
          code: "WMS_SHIPMENT_PREREQUISITE_FAILED",
        });
    }
    await reconciler.reconcileExistingWmsOrderLines(2, 2);
    const after = await inventoryEvidence();
    expect(after.claims.map((claim) => claim.status)).toEqual([
      "superseded",
      "active",
    ]);
    expect(after.lines).toHaveLength(2);
    expect(after.reserved).toBe(before.reserved + 1);
    expect(after.shipment).toEqual(before.shipment);
    expect(after.holds).toEqual(before.holds);
    await reconciler.reconcileExistingWmsOrderLines(2, 2);
    expect(await inventoryEvidence()).toEqual(after);
  }, 30_000);
});
