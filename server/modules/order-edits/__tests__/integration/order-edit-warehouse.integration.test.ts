import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { readFile } from "node:fs/promises";
import {
  createInventoryCutoverTestDatabase,
  type InventoryCutoverTestDatabase,
} from "../../../inventory/__tests__/fixtures/inventory-cutover-database";
import {
  finalizeOrderEditWarehouseRelease,
  OrderEditWarehouseGateway,
} from "../../infrastructure/order-edit-warehouse.gateway";
import { PostgresOrderEditStore } from "../../infrastructure/postgres-order-edit.store";
import type { OrderEditRecord } from "../../application/order-edit-store";
import type { OrderEditSnapshot } from "../../application/order-edit-provider";
import { drizzle } from "drizzle-orm/node-postgres";
import type { SQL } from "drizzle-orm";
import { guardOrderEditShopifyIngress } from "../../infrastructure/order-edit-ingress-guard";
import { OrderEditOmsSynchronizer } from "../../infrastructure/order-edit-oms-synchronizer";
import type { CanonicalAvailabilityReservationStatusProjection } from "@shared/types/inventory-availability-claims";
import { buildOrderEditFinancials } from "../../domain/order-edit-financials";

const url = process.env.ECHELON_TEST_DATABASE_URL;
const disposable = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
const OP = "00000000-0000-4000-8000-000000000001";
// Minimal prerequisite tables; the new 0723 migration is executed verbatim.
const prerequisites = `
CREATE SCHEMA identity; CREATE SCHEMA channels; CREATE SCHEMA oms; CREATE SCHEMA wms; CREATE SCHEMA inventory; CREATE SCHEMA catalog;
CREATE TABLE catalog.product_variants(id integer PRIMARY KEY,product_id integer NOT NULL,sku text,is_active boolean NOT NULL DEFAULT true);
INSERT INTO catalog.product_variants(id,product_id,sku) VALUES(100,200,'SKU'),(101,200,'OTHER-PACK'),(999,999,'OTHER');
CREATE TABLE identity.users(id varchar(255) PRIMARY KEY);
CREATE TABLE channels.channels(id integer PRIMARY KEY,name text DEFAULT 'Shopify',provider text DEFAULT 'shopify',status text DEFAULT 'active');
CREATE TABLE channels.channel_connections(id integer PRIMARY KEY, channel_id integer REFERENCES channels.channels(id),shop_domain text DEFAULT 'example.myshopify.com');
CREATE TABLE oms.oms_orders(id bigint PRIMARY KEY,channel_id integer,external_order_id text,status text,financial_status text,updated_at timestamptz,
  external_customer_id text,external_order_number text,customer_name text DEFAULT 'Test Customer',customer_email text,
  currency text DEFAULT 'USD',total_cents integer DEFAULT 1000,cancelled_at timestamptz);
CREATE TABLE oms.oms_order_lines(id bigint PRIMARY KEY,order_id bigint REFERENCES oms.oms_orders(id),external_line_item_id text,
  quantity integer,paid_quantity integer,authority_fulfillable_quantity integer,product_variant_id integer DEFAULT 100,authority_source_topic text);
CREATE TABLE wms.orders(id integer PRIMARY KEY,source text,oms_fulfillment_order_id text,source_table_id text,channel_id integer,
  external_order_id text,warehouse_status text NOT NULL DEFAULT 'ready',on_hold integer NOT NULL DEFAULT 0,
  assigned_picker_id text,started_at timestamptz,picked_count integer NOT NULL DEFAULT 0,combined_group_id integer,cancelled_at timestamptz);
CREATE TABLE wms.order_items(id integer PRIMARY KEY,order_id integer REFERENCES wms.orders(id),oms_order_line_id bigint,
  quantity integer,picked_quantity integer DEFAULT 0,fulfilled_quantity integer DEFAULT 0,status text DEFAULT 'pending',on_hold boolean DEFAULT false,
  product_id integer DEFAULT 100,catalog_product_id integer DEFAULT 200,sku text DEFAULT 'SKU');
CREATE TABLE wms.outbound_shipments(id integer PRIMARY KEY,order_id integer REFERENCES wms.orders(id),status text DEFAULT 'planned',
  held boolean DEFAULT false,requires_review boolean DEFAULT false,shipstation_order_id integer,shipping_engine text,engine_order_ref text,
  tracking_number text,shipped_at timestamptz);
CREATE TABLE wms.outbound_shipment_items(id integer PRIMARY KEY,shipment_id integer REFERENCES wms.outbound_shipments(id),order_item_id integer,qty integer);
CREATE TABLE inventory.availability_runtime_authority(singleton_key boolean PRIMARY KEY,authority text,activation_run_id bigint,revision bigint);
CREATE TABLE inventory.availability_claims(id bigint PRIMARY KEY,order_id integer REFERENCES wms.orders(id),status text,revision integer,plan_status text,runtime_authority_revision bigint,activation_run_id bigint,plan_hash text);
CREATE TABLE inventory.availability_claim_lines(id bigint PRIMARY KEY,claim_id bigint REFERENCES inventory.availability_claims(id),order_item_id integer,target_variant_id integer,requested_qty bigint,planned_qty bigint,shortfall_qty bigint,released_target_qty bigint,consumed_target_qty bigint,picked_target_qty bigint);
CREATE TABLE inventory.availability_claim_resources(id bigint PRIMARY KEY,claim_id bigint REFERENCES inventory.availability_claims(id),claimed_qty bigint);
CREATE TABLE inventory.availability_claim_lot_allocations(id bigint PRIMARY KEY,claim_id bigint REFERENCES inventory.availability_claims(id),claimed_qty bigint);
CREATE TABLE oms.webhook_retry_queue(id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,provider text,topic text,payload jsonb,attempts integer,status text,last_error text,next_retry_at timestamptz);
INSERT INTO inventory.availability_runtime_authority VALUES(true,'canonical',1,1);
INSERT INTO identity.users VALUES('staff'); INSERT INTO channels.channels(id) VALUES(36),(37);
INSERT INTO channels.channel_connections(id,channel_id) VALUES(4,36),(5,37);
`;
function snapshot(): OrderEditSnapshot {
  return {
    connectionId: 4,
    channelId: 36,
    orderId: "gid://shopify/Order/1",
    name: "#1",
    customerId: null,
    currency: "USD",
    updatedAt: "2026-10-05T00:00:00.000Z",
    editable: true,
    editableErrors: [],
    cancelled: false,
    closed: false,
    fullyPaid: true,
    totalCents: 1000,
    outstandingCents: 0,
    subtotalCents: 1000,
    taxCents: 0,
    netPaidCents: 1000,
    capturableCents: 0,
    shippingCents: 0,
    paymentUrl: null,
    memberPlan: null,
    memberPricingEnabled: false,
    discountsPresent: false,
    lines: [
      {
        id: "gid://shopify/LineItem/101",
        variantId: "gid://shopify/ProductVariant/100",
        title: "Product",
        variantTitle: null,
        sku: "SKU",
        quantity: 1,
        unfulfilledQuantity: 1,
        originalUnitPriceCents: 1000,
        discountedUnitPriceCents: 1000,
        totalCents: 1000,
        discountFingerprint: "a".repeat(64),
        unsupported: false,
      },
    ],
    transactions: [],
    refunds: [],
    contentFingerprint: "b".repeat(64),
    fingerprint: "c".repeat(64),
    evidence: {
      countryCode: "US",
      shippingAddressFingerprint: "d".repeat(64),
      discountApplications: [],
      unsupportedPaymentTerms: false,
    },
  };
}
function record(): OrderEditRecord {
  return {
    id: OP,
    omsOrderId: 20,
    connectionId: 4,
    requestKey: "00000000-0000-4000-8000-000000000002",
    requestHash: "a".repeat(64),
    actorId: "staff",
    status: "preparing",
    version: 0,
    createdAt: "2026-10-05T00:00:00.000Z",
    updatedAt: "2026-10-05T00:00:00.000Z",
    baseline: snapshot(),
    quote: null,
    paymentWindowMinutes: 30,
    quoteDeadline: "2026-10-05T00:10:00.000Z",
    paymentDeadline: null,
    commitKey: null,
    commitStartedAt: null,
    refundIntent: null,
    refundStartedAt: null,
    lastSnapshot: null,
    recoveryStartedAt: null,
    error: null,
    input: {
      connectionId: 4,
      omsOrderId: 20,
      expectedRevision: "c".repeat(64),
      requestKey: "00000000-0000-4000-8000-000000000002",
      changes: [{ lineItemId: "gid://shopify/LineItem/101", quantity: 2 }],
      additions: [],
    },
  };
}

function fulfilledSnapshot(): OrderEditSnapshot {
  const original = snapshot();
  return {
    ...original,
    closed: true,
    editable: false,
    updatedAt: "2026-10-06T00:00:00.000Z",
    fingerprint: "e".repeat(64),
    lines: original.lines.map((line) => ({
      ...line,
      unfulfilledQuantity: 0,
      totalCents: 0,
    })),
  };
}

function inventoryProjection(): CanonicalAvailabilityReservationStatusProjection {
  return {
    schemaVersion: "inventory_availability_reservation_status_v1",
    authority: "canonical",
    authorityRevision: "1",
    activationRunId: "1",
    orderId: 10,
    claim: {
      claimId: "1",
      claimKey: "order:10",
      revision: 1,
      activationRunId: "1",
      runtimeAuthorityRevision: "1",
      planStatus: "satisfied",
      scope: { kind: "warehouse", warehouseId: 1 },
      planHash: "f".repeat(64),
      snapshotFingerprint: "b".repeat(64),
      lines: [
        {
          claimLineId: "1",
          lineKey: "item:40",
          orderItemId: 40,
          sku: "SKU",
          targetVariantId: 100,
          requestedQty: "1",
          plannedQty: "1",
          shortfallQty: "0",
          releasedTargetQty: "0",
          consumedTargetQty: "0",
          pickedTargetQty: "0",
          openPlannedQty: "1",
          resources: [],
          operations: [],
        },
      ],
    },
  };
}

(url && disposable ? describe : describe.skip).sequential(
  "order edit migration and warehouse locks in real PostgreSQL",
  () => {
    let database: InventoryCutoverTestDatabase;
    let gateway: OrderEditWarehouseGateway;
    async function saveProjection() {
      await database.pool.query(
        `INSERT INTO oms.order_edit_paid_projections(oms_order_id,operation_id,source_updated_at,fingerprint,snapshot,projected_at)
      VALUES(20,$1,'2026-10-05T00:00:00Z',$2,$3,'2026-10-05T00:00:00Z')`,
        [OP, snapshot().fingerprint, JSON.stringify(snapshot())],
      );
    }
    function rawOrder(patch: Record<string, unknown> = {}) {
      return {
        updated_at: "2026-10-05T00:01:00Z",
        financial_status: "paid",
        current_total_price: "10.00",
        line_items: [
          { id: 101, variant_id: 100, current_quantity: 1, price: "10.00" },
        ],
        ...patch,
      };
    }
    async function ingress(
      payload: unknown,
      write?: (execute: (statement: SQL) => Promise<any>) => Promise<void>,
    ) {
      return drizzle(database.pool).transaction(async (tx) => {
        // Exercise the production transaction shape: Drizzle has both execute()
        // and a non-callable relational `query` namespace.
        const decision = await guardOrderEditShopifyIngress(
          tx,
          20,
          payload,
          new Date("2026-10-05T00:02:00Z"),
        );
        if (write && !decision.skipLines)
          await write((statement) => tx.execute(statement));
        return decision;
      });
    }
    beforeAll(async () => {
      database = await createInventoryCutoverTestDatabase(
        url,
        disposable,
        prerequisites,
      );
      await database.pool.query(
        await readFile(
          new URL(
            "../../../../../migrations/0723_shopify_order_edit_pilot.sql",
            import.meta.url,
          ),
          "utf8",
        ),
      );
      gateway = new OrderEditWarehouseGateway(
        database.pool,
        { isConfigured: () => true, synchronizeOrderEditShipment: vi.fn() },
        vi.fn(),
      );
    }, 30000);
    afterAll(async () => {
      await database?.close();
    });
    beforeEach(async () => {
      await database.pool.query(
        "TRUNCATE oms.order_edit_operations,wms.orders,oms.oms_orders,oms.webhook_retry_queue CASCADE",
      );
      await database.pool.query(`TRUNCATE catalog.product_variants;
        INSERT INTO catalog.product_variants(id,product_id,sku) VALUES(100,200,'SKU'),(101,200,'OTHER-PACK'),(999,999,'OTHER')`);
      await database.pool
        .query(`INSERT INTO oms.oms_orders(id,channel_id,external_order_id,status,financial_status,updated_at) VALUES(20,36,'1','open','paid','2026-10-05T00:00:00Z');
      INSERT INTO oms.oms_order_lines(id,order_id,external_line_item_id,quantity,paid_quantity,authority_fulfillable_quantity) VALUES(30,20,'101',1,1,1);
      INSERT INTO wms.orders(id,source,oms_fulfillment_order_id,channel_id,external_order_id) VALUES(10,'oms','20',36,'1');
      INSERT INTO wms.order_items(id,order_id,oms_order_line_id,quantity) VALUES(40,10,30,1);`);
      await new PostgresOrderEditStore(database.pool).create(record());
      await database.pool
        .query(`INSERT INTO inventory.availability_claims VALUES(1,10,'active',1,'satisfied',1,1,repeat('f',64));
      INSERT INTO inventory.availability_claim_lines VALUES(1,1,40,100,1,1,0,0,0,0);`);
    });
    function synchronizer() {
      const reservation = vi.fn(async () => inventoryProjection());
      return {
        service: new OrderEditOmsSynchronizer(
          database.pool,
          { syncOmsOrderToWms: vi.fn(async () => 10) },
          { getOrderReservationStatus: reservation },
          vi.fn(),
        ),
        reservation,
      };
    }
    async function fulfillHeldOrder() {
      await database.pool.query("UPDATE wms.orders SET on_hold=1 WHERE id=10");
      await gateway.acquire(20, OP);
      await database.pool.query(`
        UPDATE oms.oms_orders SET status='shipped' WHERE id=20;
        UPDATE oms.oms_order_lines SET authority_fulfillable_quantity=0 WHERE id=30;
        UPDATE wms.orders SET warehouse_status='shipped',picked_count=1 WHERE id=10;
        UPDATE wms.order_items SET status='completed',picked_quantity=1,fulfilled_quantity=1 WHERE id=40;
        INSERT INTO wms.outbound_shipments(id,order_id,status,shipping_engine,shipstation_order_id,engine_order_ref)
          VALUES(1,10,'queued','shipstation',55,'55');`);
      await database.pool.query(
        "INSERT INTO oms.order_edit_provider_holds(operation_id,shipment_id,provider_order_id,was_held) VALUES($1,1,55,false)",
        [OP],
      );
      const provider = vi.fn(async () => {});
      const synchronize = vi.fn();
      return {
        gateway: new OrderEditWarehouseGateway(
          database.pool,
          { isConfigured: () => true, synchronizeOrderEditShipment: provider },
          synchronize,
        ),
        provider,
        synchronize,
      };
    }
    async function physicalState() {
      const tables = [
        "oms.oms_orders",
        "oms.oms_order_lines",
        "wms.orders",
        "wms.order_items",
        "wms.outbound_shipments",
        "inventory.availability_claims",
        "inventory.availability_claim_lines",
        "inventory.availability_claim_resources",
        "inventory.availability_claim_lot_allocations",
      ];
      return Promise.all(
        tables.map(
          async (table) =>
            (await database.pool.query(`SELECT * FROM ${table} ORDER BY id`))
              .rows,
        ),
      );
    }
    it("closes a fully fulfilled unsubmitted edit atomically without changing physical or financial records", async () => {
      const fulfilled = await fulfillHeldOrder();
      const before = await physicalState();
      const proof = await fulfilled.gateway.releaseFulfilledUnsubmitted(20, OP);
      expect(proof).toMatchObject({
        fulfilledCancellation: true,
        wmsOrderIds: [10],
        shipmentIds: [1],
      });
      expect(fulfilled.provider).toHaveBeenCalledExactlyOnceWith({
        shipmentId: 1,
        operationId: OP,
        mode: "verify_shipped",
      });
      expect(fulfilled.synchronize).not.toHaveBeenCalled();
      expect(await physicalState()).toEqual(before);
      const store = new PostgresOrderEditStore(database.pool);
      const after = {
        ...record(),
        status: "expired" as const,
        version: 1,
        lastSnapshot: fulfilledSnapshot(),
      };
      await store.save(
        after,
        0,
        "staff",
        "uncommitted_edit_abandoned_after_fulfillment",
        proof,
      );
      const expected = before.map((rows, index) =>
        index === 2
          ? rows.map((row) => ({ ...row, order_edit_operation_id: null }))
          : rows,
      );
      expect(await physicalState()).toEqual(expected);
      expect(await store.get(OP)).toEqual(after);
      expect(
        (
          await database.pool.query(
            "SELECT action,before_state,after_state FROM oms.order_edit_events WHERE action='uncommitted_edit_abandoned_after_fulfillment'",
          )
        ).rows,
      ).toEqual([
        {
          action: "uncommitted_edit_abandoned_after_fulfillment",
          before_state: record(),
          after_state: after,
        },
      ]);
      await expect(
        store.save(after, 0, "staff", "duplicate", proof),
      ).rejects.toMatchObject({ code: "ORDER_EDIT_CONCURRENT_CHANGE" });
    });
    it.each([
      "UPDATE wms.order_items SET fulfilled_quantity=0 WHERE id=40",
      "UPDATE oms.oms_order_lines SET authority_fulfillable_quantity=1 WHERE id=30",
      "UPDATE oms.oms_order_lines SET paid_quantity=2 WHERE id=30",
      "UPDATE oms.oms_orders SET financial_status='partially_paid' WHERE id=20",
      "UPDATE oms.oms_order_lines SET paid_quantity=2,quantity=2 WHERE id=30; UPDATE wms.order_items SET quantity=2,fulfilled_quantity=2,picked_quantity=2 WHERE id=40",
      "UPDATE oms.oms_order_lines SET external_line_item_id='999' WHERE id=30",
    ])(
      "retains the edit ownership when completed fulfillment is not proven: %s",
      async (change) => {
        const fulfilled = await fulfillHeldOrder();
        await database.pool.query(change);
        const before = await physicalState();
        await expect(
          fulfilled.gateway.releaseFulfilledUnsubmitted(20, OP),
        ).rejects.toMatchObject({
          code: "ORDER_EDIT_FULFILLMENT_NOT_COMPLETE",
        });
        expect(fulfilled.provider).not.toHaveBeenCalled();
        expect(await physicalState()).toEqual(before);
        expect(
          (await new PostgresOrderEditStore(database.pool).get(OP)).status,
        ).toBe("preparing");
      },
    );
    it.each([
      "commitStartedAt",
      "commitKey",
      "refundIntent",
      "refundStartedAt",
      "recoveryStartedAt",
    ])(
      "rejects fulfilled cleanup if %s records a financial attempt",
      async (field) => {
        const fulfilled = await fulfillHeldOrder();
        await database.pool.query(
          "UPDATE oms.order_edit_operations SET document=jsonb_set(document,ARRAY[$2::text],to_jsonb($3::text)) WHERE id=$1",
          [OP, field, "persisted-intent"],
        );
        const before = await physicalState();
        await expect(
          fulfilled.gateway.releaseFulfilledUnsubmitted(20, OP),
        ).rejects.toMatchObject({ code: "ORDER_EDIT_ALREADY_SUBMITTED" });
        expect(fulfilled.provider).not.toHaveBeenCalled();
        expect(await physicalState()).toEqual(before);
      },
    );
    it("retains ownership on failed provider verification and rejects a new partition before terminal save", async () => {
      const fulfilled = await fulfillHeldOrder();
      fulfilled.provider.mockRejectedValueOnce(
        new Error("provider unavailable"),
      );
      const before = await physicalState();
      await expect(
        fulfilled.gateway.releaseFulfilledUnsubmitted(20, OP),
      ).rejects.toThrow("provider unavailable");
      expect(await physicalState()).toEqual(before);
      const proof = await fulfilled.gateway.releaseFulfilledUnsubmitted(20, OP);
      await database.pool.query(
        "INSERT INTO wms.orders(id,source,oms_fulfillment_order_id,channel_id,external_order_id) VALUES(11,'oms','20',36,'1')",
      );
      const store = new PostgresOrderEditStore(database.pool);
      await expect(
        store.save(
          {
            ...record(),
            status: "expired",
            version: 1,
            lastSnapshot: fulfilledSnapshot(),
          },
          0,
          "staff",
          "abandoned",
          proof,
        ),
      ).rejects.toMatchObject({ code: "ORDER_EDIT_FULFILLMENT_NOT_COMPLETE" });
      expect(
        (
          await database.pool.query(
            "SELECT order_edit_operation_id FROM wms.orders ORDER BY id",
          )
        ).rows,
      ).toEqual([
        { order_edit_operation_id: OP },
        { order_edit_operation_id: OP },
      ]);
      expect((await store.get(OP)).status).toBe("preparing");
    });
    it("rolls back fulfilled cancellation on audit failure and prevents using cleanup proof for an applied edit", async () => {
      const fulfilled = await fulfillHeldOrder();
      const proof = await fulfilled.gateway.releaseFulfilledUnsubmitted(20, OP);
      const before = await physicalState();
      const store = new PostgresOrderEditStore(database.pool);
      const next = {
        ...record(),
        version: 1,
        lastSnapshot: fulfilledSnapshot(),
      };
      await expect(
        store.save(
          { ...next, status: "expired" },
          0,
          "unknown-user",
          "abandoned",
          proof,
        ),
      ).rejects.toMatchObject({ code: "23503" });
      expect(await physicalState()).toEqual(before);
      expect(await store.get(OP)).toEqual(record());
      expect(
        (
          await database.pool.query(
            "SELECT action FROM oms.order_edit_events ORDER BY id",
          )
        ).rows,
      ).toEqual([{ action: "created" }]);
      await expect(
        store.save(
          { ...next, status: "completed" },
          0,
          "staff",
          "completed",
          proof,
        ),
      ).rejects.toMatchObject({ code: "ORDER_EDIT_FULFILLED_CANCEL_INVALID" });
      expect(await physicalState()).toEqual(before);
    });
    it("round-trips new discount and payment evidence alongside legacy operations", async () => {
      const store = new PostgresOrderEditStore(database.pool);
      expect((await store.get(OP)).baseline.financials).toBeUndefined();
      await database.pool.query(
        "INSERT INTO oms.oms_orders(id,channel_id,external_order_id,status,financial_status,updated_at) VALUES(21,36,'2','open','paid','2026-10-05T00:00:00Z')",
      );
      const financials = buildOrderEditFinancials({
        lines: [
          { id: snapshot().lines[0].id, grossCents: 1100, netCents: 1000 },
        ],
        itemsNetCents: 1000,
        itemDiscountLabels: ["Member discount"],
        itemDiscounts: [
          {
            key: "code:credit",
            label: "Member discount",
            amountCents: 100,
            value: { type: "fixed", amountCents: 100 },
          },
        ],
        shippingGrossCents: 500,
        shippingCents: 0,
        shippingDiscountLabels: ["Free shipping"],
        taxCents: 0,
        taxesIncluded: false,
        totalCents: 1000,
      });
      const newId = "00000000-0000-4000-8000-000000000003";
      const requestKey = "00000000-0000-4000-8000-000000000004";
      const operation = {
        ...record(),
        id: newId,
        omsOrderId: 21,
        requestKey,
        input: { ...record().input, omsOrderId: 21, requestKey },
        baseline: {
          ...snapshot(),
          orderId: "gid://shopify/Order/2",
          financials,
          discountsPresent: true,
          lines: [{ ...snapshot().lines[0], originalUnitPriceCents: 1100 }],
          paymentDates: {},
          discountRules: [],
        },
      };
      await store.create(operation);
      expect((await store.get(newId)).baseline).toEqual(operation.baseline);
      const nextRequestKey = "00000000-0000-4000-8000-000000000006";
      const contradictory = {
        ...operation,
        id: "00000000-0000-4000-8000-000000000005",
        requestKey: nextRequestKey,
        input: { ...operation.input, requestKey: nextRequestKey },
        baseline: { ...operation.baseline, totalCents: 999 },
      };
      await expect(store.create(contradictory)).rejects.toThrow(
        /Snapshot financial breakdown/,
      );
      expect(
        (
          await database.pool.query(
            "SELECT count(*)::int AS count FROM oms.order_edit_operations",
          )
        ).rows[0].count,
      ).toBe(2);
    });
    it.each(["completed", "recovered"] as const)(
      "synchronizes paid contents and atomically releases %s against the real WMS identity columns",
      async (status) => {
        const sync = synchronizer();
        const actualGateway = new OrderEditWarehouseGateway(
          database.pool,
          { isConfigured: () => true, synchronizeOrderEditShipment: vi.fn() },
          (id, expected, operation) =>
            sync.service.synchronize(id, expected, operation),
        );
        await actualGateway.acquire(20, OP);
        const proof = await actualGateway.reconcileAndRelease(
          20,
          OP,
          snapshot(),
        );
        await new PostgresOrderEditStore(database.pool).save(
          { ...record(), status, version: 1 },
          0,
          "staff",
          status,
          proof,
        );
        expect(sync.reservation).toHaveBeenCalledWith(10);
        expect(
          (
            await database.pool.query(
              "SELECT order_edit_operation_id FROM wms.orders WHERE id=10",
            )
          ).rows[0],
        ).toEqual({ order_edit_operation_id: null });
        expect(
          (
            await database.pool.query(
              "SELECT status FROM oms.order_edit_operations WHERE id=$1",
              [OP],
            )
          ).rows[0].status,
        ).toBe(status);
      },
    );
    it.each([
      [
        "missing source line",
        "UPDATE wms.order_items SET oms_order_line_id=NULL WHERE id=40",
      ],
      [
        "other order's source line",
        `INSERT INTO oms.oms_orders(id,channel_id,external_order_id) VALUES(21,36,'2');
        INSERT INTO oms.oms_order_lines(id,order_id,external_line_item_id,quantity,paid_quantity,authority_fulfillable_quantity) VALUES(31,21,'102',1,1,1);
        UPDATE wms.order_items SET oms_order_line_id=31 WHERE id=40`,
      ],
      [
        "unresolved WMS variant",
        "UPDATE wms.order_items SET product_id=NULL WHERE id=40",
      ],
      [
        "different pack variant",
        "UPDATE wms.order_items SET product_id=101 WHERE id=40",
      ],
      [
        "different root product",
        "UPDATE wms.order_items SET catalog_product_id=999 WHERE id=40",
      ],
      [
        "ambiguous legacy SKU",
        "UPDATE wms.order_items SET catalog_product_id=NULL WHERE id=40; UPDATE catalog.product_variants SET sku='SKU' WHERE id=101",
      ],
      ["missing WMS line", "DELETE FROM wms.order_items WHERE id=40"],
      [
        "extra WMS quantity",
        "UPDATE wms.order_items SET quantity=2 WHERE id=40",
      ],
    ])(
      "keeps the hold and refuses inventory certification for %s",
      async (_label, statement) => {
        await gateway.acquire(20, OP);
        await database.pool.query(statement);
        const sync = synchronizer();
        await expect(
          sync.service.synchronize(20, snapshot(), OP),
        ).rejects.toMatchObject({ code: "ORDER_EDIT_INVENTORY_PENDING" });
        expect(sync.reservation).not.toHaveBeenCalled();
        expect(
          (
            await database.pool.query(
              "SELECT order_edit_operation_id FROM wms.orders WHERE id=10",
            )
          ).rows[0].order_edit_operation_id,
        ).toBe(OP);
      },
    );
    it("resolves a legacy root-product identity by its single active SKU consistently with canonical allocation", async () => {
      await database.pool.query(
        "UPDATE wms.order_items SET product_id=200,catalog_product_id=NULL WHERE id=40",
      );
      await expect(
        synchronizer().service.synchronize(20, snapshot(), OP),
      ).resolves.toBeUndefined();
      await gateway.acquire(20, OP);
      expect(
        (await gateway.reconcileAndRelease(20, OP, snapshot()))
          .allocationRequired,
      ).toBe(true);
    });
    it("does not borrow fulfillment quantities from another WMS order linked to this source line", async () => {
      await database.pool
        .query(`INSERT INTO oms.oms_orders(id,channel_id,external_order_id) VALUES(21,36,'2');
        INSERT INTO wms.orders(id,source,oms_fulfillment_order_id,channel_id,external_order_id) VALUES(11,'oms','21',36,'2');
        UPDATE wms.order_items SET order_id=11 WHERE id=40`);
      await expect(
        synchronizer().service.synchronize(20, snapshot(), OP),
      ).rejects.toMatchObject({ code: "ORDER_EDIT_INVENTORY_PENDING" });
    });
    it("invalidates a release fingerprint if the catalog identity changes after provider verification", async () => {
      await gateway.acquire(20, OP);
      const proof = await gateway.reconcileAndRelease(20, OP, snapshot());
      await database.pool.query(
        "UPDATE catalog.product_variants SET product_id=999 WHERE id=100",
      );
      await expect(
        new PostgresOrderEditStore(database.pool).save(
          { ...record(), status: "completed", version: 1 },
          0,
          "staff",
          "completed",
          proof,
        ),
      ).rejects.toMatchObject({ code: "ORDER_EDIT_INVENTORY_PENDING" });
      expect(
        (
          await database.pool.query(
            "SELECT order_edit_operation_id FROM wms.orders WHERE id=10",
          )
        ).rows[0].order_edit_operation_id,
      ).toBe(OP);
    });
    it("inherits an active edit on a new fulfillment partition and protects source identity", async () => {
      await gateway.acquire(20, OP);
      await database.pool.query(
        "INSERT INTO wms.orders(id,source,oms_fulfillment_order_id,channel_id,external_order_id) VALUES(11,'oms','20',36,'1')",
      );
      expect(
        (
          await database.pool.query(
            "SELECT order_edit_operation_id FROM wms.orders ORDER BY id",
          )
        ).rows,
      ).toEqual([
        { order_edit_operation_id: OP },
        { order_edit_operation_id: OP },
      ]);
      await expect(
        database.pool.query("UPDATE wms.orders SET channel_id=37 WHERE id=11"),
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        database.pool.query(
          "INSERT INTO wms.orders(id,source,oms_fulfillment_order_id,channel_id,external_order_id) VALUES(12,'oms','20',37,'1')",
        ),
      ).rejects.toMatchObject({ code: "23514" });
    });
    it("blocks a picking claim after acquisition even if a manual hold is released", async () => {
      await gateway.acquire(20, OP);
      await database.pool.query("UPDATE wms.orders SET on_hold=0 WHERE id=10");
      const claim = await database.pool.query(
        "UPDATE wms.orders SET assigned_picker_id='picker',started_at=now(),warehouse_status='in_progress' WHERE id=10 AND on_hold=0 AND order_edit_operation_id IS NULL",
      );
      expect(claim.rowCount).toBe(0);
    });
    it("observes a concurrent picking start under the warehouse row lock", async () => {
      const picker = await database.pool.connect();
      try {
        await picker.query("BEGIN");
        await picker.query(
          "UPDATE wms.orders SET assigned_picker_id='picker',started_at=now(),warehouse_status='in_progress' WHERE id=10",
        );
        const acquisition = gateway.acquire(20, OP);
        const rejected = expect(acquisition).rejects.toMatchObject({
          code: "ORDER_EDIT_PICKING_CUTOFF",
        });
        const pickerPid = (await picker.query("SELECT pg_backend_pid() AS pid"))
          .rows[0].pid;
        await vi.waitFor(
          async () => {
            const waiting = await database.pool.query(
              "SELECT count(*)::int AS count FROM pg_stat_activity WHERE $1::int=ANY(pg_blocking_pids(pid))",
              [pickerPid],
            );
            expect(waiting.rows[0].count).toBeGreaterThan(0);
          },
          { timeout: 3000, interval: 10 },
        );
        await picker.query("COMMIT");
        await rejected;
        expect(
          (
            await database.pool.query(
              "SELECT order_edit_operation_id FROM wms.orders WHERE id=10",
            )
          ).rows[0].order_edit_operation_id,
        ).toBeNull();
      } finally {
        await picker.query("ROLLBACK");
        picker.release();
      }
    });
    it("requires exact release proof after a new inherited partition appears", async () => {
      await gateway.acquire(20, OP);
      const proof = await gateway.releaseUnchanged(20, OP);
      await database.pool.query(
        "INSERT INTO wms.orders(id,source,oms_fulfillment_order_id,channel_id,external_order_id) VALUES(11,'oms','20',36,'1')",
      );
      const terminal = await database.pool.connect();
      try {
        await terminal.query("BEGIN");
        await expect(
          finalizeOrderEditWarehouseRelease(terminal, 20, OP, proof),
        ).rejects.toMatchObject({ code: "ORDER_EDIT_RELEASE_CHANGED" });
        await terminal.query("ROLLBACK");
        expect(
          (
            await database.pool.query(
              "SELECT count(*)::int AS count FROM wms.orders WHERE order_edit_operation_id=$1",
              [OP],
            )
          ).rows[0].count,
        ).toBe(2);
      } finally {
        terminal.release();
      }
    });
    it("atomically completes and clears only the edit hold, with rollback safety", async () => {
      await database.pool.query("UPDATE wms.orders SET on_hold=1 WHERE id=10");
      await gateway.acquire(20, OP);
      const proof = await gateway.releaseUnchanged(20, OP);
      const terminal = await database.pool.connect();
      try {
        await terminal.query("BEGIN");
        await finalizeOrderEditWarehouseRelease(terminal, 20, OP, proof);
        await terminal.query(
          "UPDATE oms.order_edit_operations SET status='expired' WHERE id=$1",
          [OP],
        );
        await terminal.query("ROLLBACK");
        expect(
          (
            await database.pool.query(
              "SELECT order_edit_operation_id,on_hold FROM wms.orders WHERE id=10",
            )
          ).rows[0],
        ).toEqual({ order_edit_operation_id: OP, on_hold: 1 });
        await terminal.query("BEGIN");
        await finalizeOrderEditWarehouseRelease(terminal, 20, OP, proof);
        await terminal.query(
          "UPDATE oms.order_edit_operations SET status='expired' WHERE id=$1",
          [OP],
        );
        await terminal.query("COMMIT");
        await database.pool.query(
          "INSERT INTO wms.orders(id,source,oms_fulfillment_order_id,channel_id,external_order_id) VALUES(11,'oms','20',36,'1')",
        );
        expect(
          (
            await database.pool.query(
              "SELECT order_edit_operation_id,on_hold FROM wms.orders ORDER BY id",
            )
          ).rows,
        ).toEqual([
          { order_edit_operation_id: null, on_hold: 1 },
          { order_edit_operation_id: null, on_hold: 0 },
        ]);
      } finally {
        await terminal.query("ROLLBACK");
        terminal.release();
      }
    });
    it("enforces unique active operation ownership and immutable audit history", async () => {
      await expect(
        database.pool
          .query(`INSERT INTO oms.order_edit_operations(id,oms_order_id,connection_id,request_key,request_hash,actor_id,status,document,created_at,updated_at)
      VALUES('00000000-0000-4000-8000-000000000003',20,4,'00000000-0000-4000-8000-000000000004',repeat('b',64),'staff','preparing','{}',now(),now())`),
      ).rejects.toMatchObject({ code: "23505" });
      await database.pool.query(
        "INSERT INTO oms.order_edit_events(operation_id,connection_id,actor_id,action,after_state,occurred_at) VALUES($1,4,'staff','test','{}',now())",
        [OP],
      );
      await expect(
        database.pool.query(
          "UPDATE oms.order_edit_events SET action='changed'",
        ),
      ).rejects.toMatchObject({ code: "23514" });
    });
    it("abandons an operation that never acquired a hold after picking won", async () => {
      await database.pool.query(
        "UPDATE wms.orders SET warehouse_status='in_progress',started_at=now(),assigned_picker_id='picker' WHERE id=10",
      );
      const proof = await gateway.releaseUnchanged(20, OP);
      expect(proof.ownership).toBe("none");
      const store = new PostgresOrderEditStore(database.pool);
      await store.save(
        { ...record(), status: "expired", version: 1 },
        0,
        "staff",
        "abandoned",
        proof,
      );
      expect(
        (
          await database.pool.query(
            "SELECT warehouse_status,order_edit_operation_id FROM wms.orders WHERE id=10",
          )
        ).rows[0],
      ).toEqual({
        warehouse_status: "in_progress",
        order_edit_operation_id: null,
      });
      expect((await store.get(OP)).status).toBe("expired");
      expect(
        (
          await database.pool.query(
            "SELECT action FROM oms.order_edit_events ORDER BY id",
          )
        ).rows,
      ).toEqual([{ action: "created" }, { action: "abandoned" }]);
    });
    it("does not accept no-hold abandonment when a commit or provider hold was attempted", async () => {
      await database.pool.query(
        "UPDATE oms.order_edit_operations SET document=jsonb_set(document,'{commitStartedAt}','\"2026-10-05T00:01:00.000Z\"') WHERE id=$1",
        [OP],
      );
      await expect(gateway.releaseUnchanged(20, OP)).rejects.toMatchObject({
        code: "ORDER_EDIT_RELEASE_NOT_UNCHANGED",
      });
      await database.pool.query(
        "UPDATE oms.order_edit_operations SET document=jsonb_set(document,'{commitStartedAt}','null') WHERE id=$1",
        [OP],
      );
      await database.pool.query(
        "INSERT INTO wms.outbound_shipments(id,order_id) VALUES(1,10)",
      );
      await database.pool.query(
        "INSERT INTO oms.order_edit_provider_holds(operation_id,shipment_id,provider_order_id,was_held) VALUES($1,1,55,false)",
        [OP],
      );
      await expect(gateway.releaseUnchanged(20, OP)).rejects.toMatchObject({
        code: "ORDER_EDIT_RELEASE_NOT_UNCHANGED",
      });
    });
    it("invalidates no-hold proof if a new inherited warehouse partition arrives", async () => {
      const proof = await gateway.releaseUnchanged(20, OP);
      await database.pool.query(
        "INSERT INTO wms.orders(id,source,oms_fulfillment_order_id,channel_id,external_order_id) VALUES(11,'oms','20',36,'1')",
      );
      const store = new PostgresOrderEditStore(database.pool);
      await expect(
        store.save(
          { ...record(), status: "expired", version: 1 },
          0,
          "staff",
          "abandoned",
          proof,
        ),
      ).rejects.toMatchObject({ code: "ORDER_EDIT_RELEASE_OWNER_CHANGED" });
      expect((await store.get(OP)).status).toBe("preparing");
    });
    it("atomically saves the terminal state, hold release and audit, including rollback on audit failure", async () => {
      await gateway.acquire(20, OP);
      const proof = await gateway.releaseUnchanged(20, OP);
      const store = new PostgresOrderEditStore(database.pool);
      // An invalid audit actor triggers a real FK violation AFTER the owner clear.
      await expect(
        store.save(
          { ...record(), status: "expired", version: 1 },
          0,
          "unknown-user",
          "expired",
          proof,
        ),
      ).rejects.toMatchObject({ code: "23503" });
      expect((await store.get(OP)).status).toBe("preparing");
      expect(
        (
          await database.pool.query(
            "SELECT order_edit_operation_id FROM wms.orders WHERE id=10",
          )
        ).rows[0].order_edit_operation_id,
      ).toBe(OP);
      await store.save(
        { ...record(), status: "expired", version: 1 },
        0,
        "staff",
        "expired",
        proof,
      );
      expect((await store.get(OP)).status).toBe("expired");
      expect(
        (
          await database.pool.query(
            "SELECT count(*)::int AS count FROM oms.order_edit_events",
          )
        ).rows[0].count,
      ).toBe(2);
    });
    it("rechecks and fingerprints canonical allocations before terminal release", async () => {
      await gateway.acquire(20, OP);
      const proof = await gateway.reconcileAndRelease(20, OP, snapshot());
      expect(proof.allocationRequired).toBe(true);
      await database.pool.query(
        "UPDATE inventory.availability_claims SET revision=2 WHERE id=1",
      );
      const store = new PostgresOrderEditStore(database.pool);
      await expect(
        store.save(
          { ...record(), status: "expired", version: 1 },
          0,
          "staff",
          "expired",
          proof,
        ),
      ).rejects.toMatchObject({ code: "ORDER_EDIT_RELEASE_CHANGED" });
      expect(
        (
          await database.pool.query(
            "SELECT order_edit_operation_id FROM wms.orders WHERE id=10",
          )
        ).rows[0].order_edit_operation_id,
      ).toBe(OP);
    });
    it("rejects paid completion with an unchanged-release proof instead of an allocation proof", async () => {
      await gateway.acquire(20, OP);
      const proof = await gateway.releaseUnchanged(20, OP);
      const store = new PostgresOrderEditStore(database.pool);
      await expect(
        store.save(
          { ...record(), status: "completed", version: 1 },
          0,
          "staff",
          "completed",
          proof,
        ),
      ).rejects.toMatchObject({ code: "ORDER_EDIT_ALLOCATION_PROOF_REQUIRED" });
      expect((await store.get(OP)).status).toBe("preparing");
      expect(
        (
          await database.pool.query(
            "SELECT order_edit_operation_id FROM wms.orders WHERE id=10",
          )
        ).rows[0].order_edit_operation_id,
      ).toBe(OP);
    });
    it.each([
      "UPDATE inventory.availability_claim_lines SET planned_qty=0,shortfall_qty=1 WHERE id=1",
      "UPDATE inventory.availability_claim_lines SET target_variant_id=999 WHERE id=1",
      "UPDATE wms.order_items SET product_id=101 WHERE id=40",
      "UPDATE wms.order_items SET catalog_product_id=999 WHERE id=40",
      "UPDATE wms.order_items SET product_id=NULL WHERE id=40",
    ])("keeps a changed or short allocation held: %s", async (statement) => {
      await gateway.acquire(20, OP);
      await database.pool.query(statement);
      await expect(
        gateway.reconcileAndRelease(20, OP, snapshot()),
      ).rejects.toMatchObject({ code: "ORDER_EDIT_INVENTORY_PENDING" });
      expect(
        (
          await database.pool.query(
            "SELECT order_edit_operation_id FROM wms.orders WHERE id=10",
          )
        ).rows[0].order_edit_operation_id,
      ).toBe(OP);
    });
    it("does not let unexpired quote work starve committed reconciliation", async () => {
      const store = new PostgresOrderEditStore(database.pool);
      expect(await store.pending(1, new Date("2026-10-05T00:01:00Z"))).toEqual(
        [],
      );
      expect(await store.pending(1, new Date("2026-10-05T00:11:00Z"))).toEqual([
        OP,
      ]);
    });
    it("releases a reduction using current paid authority while retaining purchased history", async () => {
      await database.pool.query(
        "UPDATE oms.oms_order_lines SET quantity=3,paid_quantity=3,authority_fulfillable_quantity=1 WHERE id=30",
      );
      await gateway.acquire(20, OP);
      const proof = await gateway.reconcileAndRelease(20, OP, snapshot());
      expect(proof.allocationRequired).toBe(true);
      expect(
        (
          await database.pool.query(
            "SELECT quantity,paid_quantity,authority_fulfillable_quantity FROM oms.oms_order_lines WHERE id=30",
          )
        ).rows[0],
      ).toEqual({
        quantity: 3,
        paid_quantity: 3,
        authority_fulfillable_quantity: 1,
      });
    });
    it.each(["removed", "expired-addition"] as const)(
      "accepts zero authority for a %s line without resurrecting its historical units",
      async (kind) => {
        await database.pool.query(
          `INSERT INTO oms.oms_order_lines(id,order_id,external_line_item_id,quantity,paid_quantity,authority_fulfillable_quantity)
      VALUES(31,20,'102',2,$1,0)`,
          [kind === "removed" ? 2 : 0],
        );
        await database.pool.query(
          "INSERT INTO wms.order_items(id,order_id,oms_order_line_id,quantity,status) VALUES(41,10,31,2,'cancelled')",
        );
        await gateway.acquire(20, OP);
        const expected = snapshot();
        if (kind === "expired-addition")
          expected.lines.push({
            ...expected.lines[0],
            id: "gid://shopify/LineItem/102",
            quantity: 0,
            unfulfilledQuantity: 0,
            totalCents: 0,
          });
        expect(
          (await gateway.reconcileAndRelease(20, OP, expected))
            .allocationRequired,
        ).toBe(true);
      },
    );
    it.each([0, null])(
      "does not use purchased quantity as a fallback for authority %s",
      async (authority) => {
        await database.pool.query(
          "UPDATE oms.oms_order_lines SET authority_fulfillable_quantity=$1 WHERE id=30",
          [authority],
        );
        await gateway.acquire(20, OP);
        await expect(
          gateway.reconcileAndRelease(20, OP, snapshot()),
        ).rejects.toMatchObject({ code: "ORDER_EDIT_CONTENTS_NOT_RECONCILED" });
      },
    );
    it("finds the active edit after reload without leaking another channel's same-number order", async () => {
      await database.pool.query(
        "UPDATE oms.oms_orders SET external_order_number='#1234' WHERE id=20",
      );
      await database.pool.query(
        "INSERT INTO oms.oms_orders(id,channel_id,external_order_id,external_order_number) VALUES(21,37,'2','#1234')",
      );
      const store = new PostgresOrderEditStore(database.pool);
      for (const search of ["1234", "#1234"]) {
        expect(await store.findOrders(4, search)).toEqual([
          expect.objectContaining({
            omsOrderId: 20,
            connectionId: 4,
            activeOperationId: OP,
          }),
        ]);
      }
      expect(await store.findOrders(5, "1234")).toEqual([
        expect.objectContaining({
          omsOrderId: 21,
          connectionId: 5,
          activeOperationId: null,
        }),
      ]);
      await gateway.acquire(20, OP);
      const proof = await gateway.releaseUnchanged(20, OP);
      await store.save(
        { ...record(), status: "expired", version: 1 },
        0,
        "staff",
        "expired",
        proof,
      );
      expect(await store.findOrders(4, "1234")).toEqual([
        expect.objectContaining({ omsOrderId: 20, activeOperationId: null }),
      ]);
    });
    it.each(["2026-10-04T23:59:59Z", "2026-10-05T00:00:00Z"])(
      "ignores contradictory old/equal webhook %s without reopening a completed edit",
      async (updatedAt) => {
        await saveProjection();
        await database.pool.query(
          "UPDATE oms.order_edit_operations SET status='completed' WHERE id=$1",
          [OP],
        );
        expect(
          await ingress(
            rawOrder({ updated_at: updatedAt, current_total_price: "30.00" }),
          ),
        ).toEqual({ skipLines: true, skipOrder: true });
        expect(
          (
            await database.pool.query(
              "SELECT status FROM oms.order_edit_operations WHERE id=$1",
              [OP],
            )
          ).rows[0].status,
        ).toBe("completed");
      },
    );
    it("allows metadata progression from matching newer fulfillment events without rewriting certified lines", async () => {
      await saveProjection();
      expect(
        await ingress(rawOrder({ fulfillment_status: "fulfilled" })),
      ).toEqual({ skipLines: true, skipOrder: false });
      expect(
        (
          await database.pool.query(
            "SELECT count(*)::int AS count FROM oms.webhook_retry_queue",
          )
        ).rows[0].count,
      ).toBe(0);
    });
    it("allows matching fulfilled content after picking to reconcile its fulfillment authority", async () => {
      await saveProjection();
      await database.pool.query(
        "UPDATE wms.orders SET started_at=now(),warehouse_status='shipped' WHERE id=10",
      );
      expect(
        await ingress(rawOrder({ fulfillment_status: "fulfilled" })),
      ).toEqual({ skipLines: false, skipOrder: false });
      expect(
        (
          await database.pool.query(
            "SELECT order_edit_operation_id FROM wms.orders WHERE id=10",
          )
        ).rows[0].order_edit_operation_id,
      ).toBeNull();
    });
    it("reopens only a new pre-picking contradiction, preserves manual holds and queues provider hold", async () => {
      await saveProjection();
      await database.pool.query(
        "UPDATE oms.order_edit_operations SET status='completed',document=jsonb_set(document,'{status}','\"completed\"') WHERE id=$1",
        [OP],
      );
      await database.pool.query("UPDATE wms.orders SET on_hold=1 WHERE id=10");
      expect(await ingress(rawOrder({ current_total_price: "30.00" }))).toEqual(
        { skipLines: true, skipOrder: true },
      );
      expect(
        (
          await database.pool.query(
            "SELECT order_edit_operation_id,on_hold FROM wms.orders WHERE id=10",
          )
        ).rows[0],
      ).toEqual({ order_edit_operation_id: OP, on_hold: 1 });
      expect(
        (
          await database.pool.query(
            "SELECT status FROM oms.order_edit_operations WHERE id=$1",
            [OP],
          )
        ).rows[0].status,
      ).toBe("review_required");
      expect(
        (
          await database.pool.query(
            "SELECT action FROM oms.order_edit_events WHERE action='newer_source_conflict'",
          )
        ).rowCount,
      ).toBe(1);
      expect(
        (
          await database.pool.query(
            "SELECT payload FROM oms.webhook_retry_queue",
          )
        ).rows[0].payload,
      ).toEqual({ wmsOrderId: 10, requestedMode: "hold" });
      await ingress(rawOrder({ current_total_price: "30.00" }));
      expect(
        (
          await database.pool.query(
            "SELECT count(*)::int AS count FROM oms.webhook_retry_queue",
          )
        ).rows[0].count,
      ).toBe(1);
    });
    it.each(["2026-10-05T00:00:00Z", "2026-10-05T00:01:00Z"])(
      "allows a second owned edit at %s to observe added lines without lifting its hold",
      async (updatedAt) => {
        const next = "00000000-0000-4000-8000-000000000099";
        await saveProjection();
        await database.pool.query(
          "UPDATE oms.order_edit_operations SET status='completed' WHERE id=$1",
          [OP],
        );
        await new PostgresOrderEditStore(database.pool).create({
          ...record(),
          id: next,
          requestKey: next,
          input: { ...record().input, requestKey: next },
        });
        await gateway.acquire(20, next);
        const { sql } = await import("drizzle-orm");
        expect(
          await ingress(
            rawOrder({ updated_at: updatedAt, current_total_price: "20.00" }),
            async (execute) => {
              await execute(sql`INSERT INTO oms.oms_order_lines(id,order_id,external_line_item_id,quantity,paid_quantity,authority_fulfillable_quantity,authority_source_topic)
        VALUES(31,20,'102',1,0,0,'orders/updated')`);
            },
          ),
        ).toEqual({ skipLines: false, skipOrder: false });
        expect(
          (
            await database.pool.query(
              "SELECT order_edit_operation_id FROM wms.orders WHERE id=10",
            )
          ).rows[0].order_edit_operation_id,
        ).toBe(next);
        expect(
          (
            await database.pool.query(
              "SELECT quantity FROM oms.oms_order_lines WHERE id=31",
            )
          ).rows[0].quantity,
        ).toBe(1);
      },
    );
    it.each(["picking", "refund", "cancel"])(
      "retains the existing %s owner for newer post-edit reconciliation",
      async (kind) => {
        await saveProjection();
        await database.pool.query(
          "UPDATE oms.order_edit_operations SET status='completed' WHERE id=$1",
          [OP],
        );
        if (kind === "picking")
          await database.pool.query(
            "UPDATE wms.orders SET started_at=now(),warehouse_status='in_progress' WHERE id=10",
          );
        const patch =
          kind === "refund"
            ? { financial_status: "partially_refunded", refunds: [{ id: 99 }] }
            : kind === "cancel"
              ? { cancelled_at: "2026-10-05T00:01:00Z" }
              : {};
        expect(
          await ingress(rawOrder({ current_total_price: "20.00", ...patch })),
        ).toEqual({ skipLines: kind === "refund", skipOrder: false });
        expect(
          (
            await database.pool.query(
              "SELECT order_edit_operation_id FROM wms.orders WHERE id=10",
            )
          ).rows[0].order_edit_operation_id,
        ).toBeNull();
      },
    );
    it("database backstop rejects a generic writer that bypasses the projection guard", async () => {
      await saveProjection();
      await expect(
        database.pool.query(
          "UPDATE oms.oms_order_lines SET paid_quantity=3,authority_fulfillable_quantity=3,authority_source_topic='orders/paid' WHERE id=30",
        ),
      ).rejects.toMatchObject({ code: "23514" });
      await database.pool.query(
        "UPDATE oms.oms_order_lines SET authority_fulfillable_quantity=0,authority_source_topic='refunds/create' WHERE id=30",
      );
      expect(
        (
          await database.pool.query(
            "SELECT authority_fulfillable_quantity FROM oms.oms_order_lines WHERE id=30",
          )
        ).rows[0].authority_fulfillable_quantity,
      ).toBe(0);
    });
    it("does not treat an existing partial refund as permission for another content change", async () => {
      await saveProjection();
      const value = snapshot();
      value.refunds = [
        {
          id: "gid://shopify/Refund/99",
          note: null,
          amountCents: 100,
          transactions: [],
        },
      ];
      await database.pool.query(
        "UPDATE oms.order_edit_paid_projections SET snapshot=$1",
        [JSON.stringify(value)],
      );
      expect(
        await ingress(
          rawOrder({
            financial_status: "partially_refunded",
            refunds: [{ id: 99 }],
          }),
        ),
      ).toEqual({ skipLines: true, skipOrder: false });
      expect(
        await ingress(
          rawOrder({
            financial_status: "partially_refunded",
            refunds: [{ id: 99 }],
            current_total_price: "20.00",
          }),
        ),
      ).toEqual({ skipLines: true, skipOrder: true });
      expect(
        (
          await database.pool.query(
            "SELECT status FROM oms.order_edit_operations WHERE id=$1",
            [OP],
          )
        ).rows[0].status,
      ).toBe("review_required");
    });
    it("accepts a retired zero-quantity line with a deleted Shopify variant", async () => {
      await saveProjection();
      const value = snapshot();
      value.lines.push({
        ...value.lines[0],
        id: "gid://shopify/LineItem/102",
        variantId: "",
        quantity: 0,
        unfulfilledQuantity: 0,
        totalCents: 0,
        unsupported: true,
      });
      await database.pool.query(
        "UPDATE oms.order_edit_paid_projections SET snapshot=$1",
        [JSON.stringify(value)],
      );
      const raw = rawOrder();
      raw.line_items.push({
        id: 102,
        variant_id: null as unknown as number,
        current_quantity: 0,
        price: "10.00",
      });
      expect(await ingress(raw)).toEqual({ skipLines: true, skipOrder: false });
    });
    it("rechecks a newly committed projection when a previously waiting generic line writer wakes", async () => {
      const projector = await database.pool.connect();
      const writer = await database.pool.connect();
      try {
        await projector.query("BEGIN");
        await projector.query(
          "SELECT id FROM oms.oms_orders WHERE id=20 FOR UPDATE",
        );
        await projector.query(
          "UPDATE oms.oms_order_lines SET authority_source_topic='order-edit/paid' WHERE id=30",
        );
        await projector.query(
          "INSERT INTO oms.order_edit_paid_projections VALUES(20,$1,'2026-10-05',$2,$3,'2026-10-05')",
          [OP, snapshot().fingerprint, JSON.stringify(snapshot())],
        );
        const pending = writer.query(
          "UPDATE oms.oms_order_lines SET quantity=3,paid_quantity=3,authority_fulfillable_quantity=3,authority_source_topic='orders/paid' WHERE id=30",
        );
        const rejected = expect(pending).rejects.toMatchObject({
          code: "23514",
        });
        const pid = (await projector.query("SELECT pg_backend_pid() AS pid"))
          .rows[0].pid;
        await vi.waitFor(
          async () =>
            expect(
              (
                await database.pool.query(
                  "SELECT count(*)::int AS count FROM pg_stat_activity WHERE $1::int=ANY(pg_blocking_pids(pid))",
                  [pid],
                )
              ).rows[0].count,
            ).toBeGreaterThan(0),
          { timeout: 3000, interval: 10 },
        );
        await projector.query("COMMIT");
        await rejected;
        expect(
          (
            await database.pool.query(
              "SELECT authority_fulfillable_quantity FROM oms.oms_order_lines WHERE id=30",
            )
          ).rows[0].authority_fulfillable_quantity,
        ).toBe(1);
      } finally {
        await projector.query("ROLLBACK");
        projector.release();
        writer.release();
      }
    });
  },
);
