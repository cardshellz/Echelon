import { OrderEditPreviewService } from "../../application/order-edit-preview.service";
import { OrderEditService } from "../../application/order-edit.service";
import { ShopifyOrderEditProvider } from "../../infrastructure/shopify-order-edit.provider";
import type { OrderEditCatalog } from "../../application/order-edit-catalog";
import { orderEditCatalogVariantsInputSchema } from "@shared/order-edits/order-edit-catalog";
import {
  previewContext,
  previewInput,
  previewCalculation,
  PREVIEW_NOW,
} from "../fixtures/order-edit-preview.fixture";
import type { OrderEditPlan } from "../../application/order-edit-provider";
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
  type OrderEditWarehouseProvider,
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
import { orderEditQuoteSchema } from "../../application/order-edit-provider.schema";
import { serviceHarness } from "../fixtures/order-edit-service.fixture";
import { createShipStationService } from "../../../oms/shipstation.service";
import { registerStoppedRefundDeferredShipment } from "../../infrastructure/order-edit-deferred-shipment";
import { sql } from "drizzle-orm";
import { OrderEditPaidProjection } from "../../../oms/order-edit-paid-projection";
import { paidRewardFixture } from "../fixtures/order-edit-paid-reward.fixture";
import { settledRefundEditFixture } from "../fixtures/settled-refund-edit.fixture";
import { cancelWmsOrderAndRelease, completeWmsOrderAndRelease } from "../../../orders/cancel-wms-order";

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
  assigned_picker_id text,started_at timestamptz,picked_count integer NOT NULL DEFAULT 0,combined_group_id integer,cancelled_at timestamptz,updated_at timestamptz);
CREATE TABLE wms.order_items(id integer PRIMARY KEY,order_id integer REFERENCES wms.orders(id),oms_order_line_id bigint,
  quantity integer,picked_quantity integer DEFAULT 0,fulfilled_quantity integer DEFAULT 0,status text DEFAULT 'pending',on_hold boolean DEFAULT false,
  product_id integer DEFAULT 100,catalog_product_id integer DEFAULT 200,sku text DEFAULT 'SKU');
CREATE TABLE wms.outbound_shipments(id integer PRIMARY KEY,order_id integer REFERENCES wms.orders(id),status text DEFAULT 'planned',
  held boolean DEFAULT false,requires_review boolean DEFAULT false,review_reason text,shipstation_order_id integer,shipping_engine text,engine_order_ref text,
  tracking_number text,shipped_at timestamptz);
CREATE TABLE wms.outbound_shipment_items(id integer PRIMARY KEY,shipment_id integer REFERENCES wms.outbound_shipments(id),order_item_id integer,qty integer);
CREATE TABLE inventory.availability_runtime_authority(singleton_key boolean PRIMARY KEY,authority text,activation_run_id bigint,revision bigint);
CREATE TABLE inventory.availability_claims(id bigint PRIMARY KEY,order_id integer REFERENCES wms.orders(id),status text,revision integer,plan_status text,runtime_authority_revision bigint,activation_run_id bigint,plan_hash text);
CREATE TABLE inventory.availability_claim_lines(id bigint PRIMARY KEY,claim_id bigint REFERENCES inventory.availability_claims(id),order_item_id integer,target_variant_id integer,requested_qty bigint,planned_qty bigint,shortfall_qty bigint,released_target_qty bigint,consumed_target_qty bigint,picked_target_qty bigint);
CREATE TABLE inventory.availability_claim_resources(id bigint PRIMARY KEY,claim_id bigint REFERENCES inventory.availability_claims(id),claimed_qty bigint);
CREATE TABLE inventory.availability_claim_lot_allocations(id bigint PRIMARY KEY,claim_id bigint REFERENCES inventory.availability_claims(id),claimed_qty bigint);
CREATE TABLE oms.webhook_retry_queue(id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,provider text,topic text,payload jsonb,attempts integer,status text,last_error text,next_retry_at timestamptz,retry_key text,source_inbox_id integer,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now());
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
    status: "committing",
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
      await database.pool.query(await readFile(new URL("../../../../../migrations/0745_customer_account_order_edit_actor.sql", import.meta.url), "utf8"));
      await database.pool.query(await readFile(new URL("../../../../../migrations/900000010000018180001_order_edit_submission_holds.sql", import.meta.url), "utf8"));
      // Columns ordinarily supplied by the OMS owner migrations; exercise its
      // actual projector here rather than replacing the financial handoff.
      await database.pool.query(`
        ALTER TABLE oms.oms_orders ADD COLUMN subtotal_cents bigint DEFAULT 1000,
          ADD COLUMN gross_subtotal_cents bigint DEFAULT 1000,ADD COLUMN shipping_cents bigint DEFAULT 0,
          ADD COLUMN tax_cents bigint DEFAULT 0,ADD COLUMN discount_cents bigint DEFAULT 0;
        ALTER TABLE oms.oms_order_lines ADD COLUMN channel_observed_quantity int DEFAULT 1,
          ADD COLUMN cancelled_quantity int DEFAULT 0,ADD COLUMN refunded_quantity int DEFAULT 0,
          ADD COLUMN authorization_status text DEFAULT 'authorized',ADD COLUMN authorized_by_event_id text,
          ADD COLUMN authorized_at timestamptz,ADD COLUMN paid_price_cents bigint DEFAULT 1000,
          ADD COLUMN retail_price_cents bigint DEFAULT 1000,ADD COLUMN total_price_cents bigint DEFAULT 1000,
          ADD COLUMN total_discount_cents bigint DEFAULT 0,ADD COLUMN plan_discount_cents bigint DEFAULT 0,
          ADD COLUMN coupon_discount_cents bigint DEFAULT 0,ADD COLUMN fulfillable_quantity int DEFAULT 1,
          ADD COLUMN authority_source_inbox_id int,ADD COLUMN updated_at timestamptz;
        CREATE TABLE channels.channel_listings(channel_id int,external_variant_id text,product_variant_id int);
        CREATE TABLE oms.oms_order_events(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
          order_id bigint REFERENCES oms.oms_orders(id),event_type text,details jsonb,created_at timestamptz);
        CREATE TABLE oms.oms_order_line_authority_events(event_key text UNIQUE,event_type text,
          order_id bigint REFERENCES oms.oms_orders(id),order_line_id bigint,source_topic text,source_event_id text,
          source_inbox_id int,previous_channel_observed_quantity int,previous_paid_quantity int,
          previous_authority_fulfillable_quantity int,previous_authorization_status text,channel_observed_quantity int,
          paid_quantity int,authority_fulfillable_quantity int,cancelled_quantity int,refunded_quantity int,
          authorization_status text,authorized_at timestamptz,authorized_by_event_id text,created_at timestamptz);
        CREATE TABLE oms.order_line_adjustments(id bigint PRIMARY KEY);
      `);
      await database.pool.query(await readFile(new URL("../../../../../migrations/900000029000019090001_channel_merchandise_quantity_authority.sql", import.meta.url), "utf8"));
    }, 30000);
    afterAll(async () => {
      await database?.close();
    });
    beforeEach(async () => {
      await database.pool.query(
        "TRUNCATE oms.order_edit_operations,wms.orders,oms.oms_orders,oms.webhook_retry_queue CASCADE",
      );
      await database.pool.query(`TRUNCATE catalog.product_variants;
        TRUNCATE channels.channel_listings;
        INSERT INTO channels.channel_listings VALUES(36,'100',100),(36,'101',101);
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

    it("admits only submitted refund reviews for read-only scheduler recovery", async () => {
      const store = new PostgresOrderEditStore(database.pool);
      const h = serviceHarness(1);
      await h.service.quote(h.input, "staff");
      h.provider.refund.mockRejectedValueOnce(
        new (
          await import("../../application/order-edit-provider")
        ).OrderEditProviderError(
          "REFUND_UNCONFIRMED",
          "Incomplete reply",
          "unknown",
        ),
      );
      await h.service.commit(h.record().id, h.record().id, "staff");
      const value = { ...h.record(), id: OP, omsOrderId: 20 };
      await database.pool.query(
        "UPDATE oms.order_edit_operations SET status=$2,document=$3::jsonb WHERE id=$1",
        [OP, value.status, JSON.stringify(value)],
      );
      expect(await store.pending(25, new Date("2026-10-05T12:10:00Z"))).toEqual(
        [OP],
      );
      for (const code of [
        "REFUND_FAILED",
        "REFUND_AMBIGUOUS",
        "REFUND_REVIEW_EVIDENCE_MISMATCH",
      ]) {
        value.error = { code, message: "Staff review" };
        await database.pool.query(
          "UPDATE oms.order_edit_operations SET document=$2::jsonb WHERE id=$1",
          [OP, JSON.stringify(value)],
        );
        expect(
          await store.pending(25, new Date("2026-10-05T12:10:00Z")),
        ).toEqual([]);
      }
    });

    it.each(["cancel", "complete"])(
      "prevents startup %s when an edit takes ownership after candidate discovery",
      async (action) => {
        await database.pool.query(
          "ALTER TABLE wms.orders ADD COLUMN IF NOT EXISTS updated_at timestamptz, ADD COLUMN IF NOT EXISTS completed_at timestamptz",
        );
        const reservation = {
          releaseOrderReservation: vi.fn(async () => ({
            released: 1,
            failed: [],
          })),
        };
        const command =
          action === "cancel"
            ? cancelWmsOrderAndRelease
            : completeWmsOrderAndRelease;
        await gateway.acquire(20, OP);
        const orm = drizzle(database.pool);
        const result = await command(
          orm,
          reservation,
          10,
          "synthetic-startup-cleanup",
          undefined,
          { requireNoOrderEdit: true },
        );
        expect(result.transitioned).toBe(false);
        expect(reservation.releaseOrderReservation).not.toHaveBeenCalled();
        expect(
          (
            await database.pool.query(
              "SELECT warehouse_status,order_edit_operation_id FROM wms.orders WHERE id=10",
            )
          ).rows,
        ).toEqual([{ warehouse_status: "ready", order_edit_operation_id: OP }]);
      },
    );

    it("inspects committed availability without waiting for an order writer or observing its uncommitted hold", async () => {
      const writer = await database.pool.connect();
      let inspection: ReturnType<OrderEditWarehouseGateway["inspect"]> | undefined;
      let deadline: ReturnType<typeof setTimeout> | undefined;
      try {
        await writer.query("BEGIN");
        await writer.query("UPDATE oms.oms_orders SET updated_at='2026-10-05T00:01:00Z' WHERE id=20");
        await writer.query("UPDATE wms.orders SET order_edit_operation_id=$1 WHERE id=10", [OP]);
        inspection = gateway.inspect(20);
        // The writer remains open until the read finishes. A SELECT FOR UPDATE
        // implementation cannot pass by simply completing after the release.
        const result = await Promise.race([
          inspection,
          new Promise<never>((_resolve, reject) => {
            deadline = setTimeout(() => reject(new Error("Availability read waited for the writer")), 2000);
          }),
        ]);
        expect(result).toMatchObject({ editable: true, reasons: [], wmsOrderIds: [10] });
        await writer.query("COMMIT");
        expect((await gateway.inspect(20)).editable).toBe(false);
      } finally {
        if (deadline) clearTimeout(deadline);
        await writer.query("ROLLBACK");
        writer.release();
        await inspection?.catch(() => undefined);
      }
    });

    async function cancelledOperation(): Promise<OrderEditRecord> {
      const store = new PostgresOrderEditStore(database.pool);
      const original = record();
      const sale = { id: "gid://shopify/OrderTransaction/1", kind: "SALE", status: "SUCCESS", parentId: null, gateway: "manual", amountCents: 1000, manual: true };
      const paid = { ...original.baseline, transactions: [sale] };
      const value: OrderEditRecord = { ...original, kind: "cancel_order", status: "synchronizing", version: 1,
        baseline: paid,
        cancellation: { stage: "settling", jobId: "gid://shopify/Job/1", refundCents: 1000,
          rewards: { fingerprint: "a".repeat(64), returnedPoints: "100.00", deductedEarnedPoints: "5.00", settled: true } },
        commitKey: original.requestKey, commitStartedAt: original.createdAt,
        lastSnapshot: { ...paid, cancelled: true, fullyPaid: false, netPaidCents: 0, transactions: [sale, { ...sale, id: "gid://shopify/OrderTransaction/2", parentId: sale.id, kind: "REFUND" }] },
      };
      await store.save(value, 0, "staff", "fixture_cancellation_approved");
      await gateway.acquire(20, OP);
      await database.pool.query(`UPDATE oms.oms_orders SET status='cancelled',financial_status='refunded' WHERE id=20;
        UPDATE wms.orders SET warehouse_status='cancelled',cancelled_at='2026-10-06T00:00:00Z' WHERE id=10;
        UPDATE inventory.availability_claims SET status='released' WHERE order_id=10`);
      return value;
    }
    it("finishes native cancellation atomically without erasing paid-line history", async () => {
      const value = await cancelledOperation(), store = new PostgresOrderEditStore(database.pool);
      const proof = await gateway.cancellationReleaseProof(20, OP);
      expect(proof.cancelledOrder).toBe(true);
      await store.save({ ...value, version: 2, status: "completed" }, 1, null, "cancellation_completed", proof);
      expect((await store.get(OP)).status).toBe("completed");
      expect((await database.pool.query("SELECT order_edit_operation_id FROM wms.orders WHERE id=10")).rows[0].order_edit_operation_id).toBeNull();
      expect((await database.pool.query("SELECT paid_quantity,authority_fulfillable_quantity FROM oms.oms_order_lines WHERE id=30")).rows[0]).toEqual({ paid_quantity: 1, authority_fulfillable_quantity: 1 });
      expect((await database.pool.query("SELECT count(*)::int AS count FROM oms.order_edit_events WHERE operation_id=$1 AND action='cancellation_completed'", [OP])).rows[0].count).toBe(1);
    });
    it.each(["active_claim", "uncancelled_partition", "live_shipment", "unsettled_rewards", "unsettled_payment"])("retains ownership for cancellation with %s", async failure => {
      const value = await cancelledOperation();
      if (failure === "active_claim") await database.pool.query("UPDATE inventory.availability_claims SET status='active'");
      if (failure === "uncancelled_partition") await database.pool.query("UPDATE wms.orders SET warehouse_status='ready',cancelled_at=NULL");
      if (failure === "live_shipment") await database.pool.query("INSERT INTO wms.outbound_shipments(id,order_id,status) VALUES(51,10,'queued')");
      if (failure === "unsettled_rewards" || failure === "unsettled_payment") {
        if (failure === "unsettled_rewards") value.cancellation!.rewards.settled = false;
        else value.lastSnapshot!.netPaidCents = 1;
        await new PostgresOrderEditStore(database.pool).save({ ...value, version: 2 }, 1, null, "fixture_pending");
      }
      await expect(gateway.cancellationReleaseProof(20, OP)).rejects.toMatchObject({ code: "ORDER_CANCELLATION_WAREHOUSE_PENDING" });
      expect((await database.pool.query("SELECT order_edit_operation_id FROM wms.orders WHERE id=10")).rows[0].order_edit_operation_id).toBe(OP);
    });
    it("revalidates cancellation proof inside completion instead of trusting a stale read", async () => {
      const value = await cancelledOperation(), proof = await gateway.cancellationReleaseProof(20, OP);
      await database.pool.query("UPDATE inventory.availability_claims SET status='active' WHERE id=1");
      await expect(new PostgresOrderEditStore(database.pool).save({ ...value, version: 2, status: "completed" }, 1, null, "cancellation_completed", proof)).rejects.toThrow();
      expect((await new PostgresOrderEditStore(database.pool).get(OP)).status).toBe("synchronizing");
    });
    it("does not accept an ordinary edit release proof for a cancellation", async () => {
      const value = await cancelledOperation();
      await expect(new PostgresOrderEditStore(database.pool).save({ ...value, version: 2, status: "completed" }, 1, null, "cancellation_completed",
        { wmsOrderIds: [10], shipmentIds: [], contentFingerprint: "a".repeat(64), allocationRequired: true })).rejects.toMatchObject({ code: "ORDER_CANCELLATION_RELEASE_PROOF_REQUIRED" });
    });
    it.each(["edit_status", "missing_intent", "changed_refund"])("rejects an inconsistent persisted cancellation: %s", async failure => {
      const value = await cancelledOperation(), invalid = structuredClone(value);
      if (failure === "edit_status") invalid.status = "ready";
      if (failure === "missing_intent") invalid.cancellation!.stage = "acquiring";
      if (failure === "changed_refund") invalid.cancellation!.refundCents = 999;
      await expect(new PostgresOrderEditStore(database.pool).save({ ...invalid, version: 2 }, 1, null, "invalid_cancellation")).rejects.toThrow();
      expect((await new PostgresOrderEditStore(database.pool).get(OP)).version).toBe(1);
    });
    it("keeps legacy warehouse rows out of online cancellation without altering edit policy", async () => {
      await database.pool.query("UPDATE wms.orders SET warehouse_status='pending' WHERE id=10");
      expect(await gateway.inspect(20)).toMatchObject({ editable: true, cancellationReasons: ["Contact us to cancel this order."], fulfillment: { code: "awaiting_picking" } });
    });

    function customerRecord(): OrderEditRecord {
      const original = record();
      return { ...original, id: "88888888-8888-4888-8888-888888888888", omsOrderId: 21,
        requestKey: "99999999-9999-4999-8999-999999999999", actorId: "customer:36:100",
        input: { ...original.input, omsOrderId: 21, requestKey: "99999999-9999-4999-8999-999999999999" },
        baseline: { ...original.baseline, customerId: "gid://shopify/Customer/100", orderId: "gid://shopify/Order/2", name: "#2" } };
    }
    it("exempts only the same operation hold while preserving warehouse cutoff blockers", async () => {
      await gateway.acquire(20, OP);
      expect(await gateway.inspect(20, OP)).toMatchObject({ editable: true, reasons: [] });
      expect((await gateway.inspect(20, "99999999-9999-4999-8999-999999999999")).reasons).toContain("Another order edit holds this order.");
      await database.pool.query("UPDATE wms.orders SET started_at='2026-10-05T00:01:00Z' WHERE id=10");
      expect(await gateway.inspect(20, OP)).toMatchObject({ editable: false, reasons: ["Picking has already started."] });
    });
    async function customerParent() {
      await database.pool.query("INSERT INTO oms.oms_orders(id,channel_id,external_order_id,status,financial_status,updated_at) VALUES(21,36,'2','open','paid','2026-10-05T00:00:00Z')");
    }
    it("persists a Shopify customer actor without a staff user and retains immutable audit evidence", async () => {
      await customerParent();
      const store = new PostgresOrderEditStore(database.pool);
      const customer = customerRecord();
      await store.create(customer);
      expect((await store.get(customer.id)).actorId).toBe("customer:36:100");
      const row = (await database.pool.query("SELECT actor_id,customer_actor_channel_id,customer_actor_external_id FROM oms.order_edit_operations WHERE id=$1", [customer.id])).rows[0];
      expect(row).toEqual({ actor_id: null, customer_actor_channel_id: 36, customer_actor_external_id: "100" });
      const event = (await database.pool.query("SELECT actor_id,customer_actor_channel_id,customer_actor_external_id FROM oms.order_edit_events WHERE operation_id=$1", [customer.id])).rows[0];
      expect(event).toEqual(row);
      await expect(database.pool.query("UPDATE oms.order_edit_events SET action='tampered' WHERE operation_id=$1", [customer.id])).rejects.toMatchObject({ code: "23514" });
    });
    it("rejects an actor/baseline mismatch before the financial transaction writes anything", async () => {
      await customerParent();
      const customer = customerRecord();
      await expect(new PostgresOrderEditStore(database.pool).create({ ...customer, baseline: { ...customer.baseline, customerId: "gid://shopify/Customer/101" } })).rejects.toThrow();
      expect((await database.pool.query("SELECT count(*)::int AS count FROM oms.order_edit_operations WHERE oms_order_id=21")).rows[0].count).toBe(0);
    });
    it.each([
      { label: "legacy omitted codes", discountCodes: undefined, resume: false },
      { label: "explicit empty codes", discountCodes: [], resume: false },
      { label: "resumed failed quote with empty codes", discountCodes: [], resume: true },
    ])(
      "persists a provider-parsed customer quote with $label and reloads its exact plan",
      async ({ discountCodes, resume }) => {
        await customerParent();
        const store = new PostgresOrderEditStore(database.pool);
        const original = customerRecord();
        if (discountCodes !== undefined)
          original.input.discountCodes = discountCodes;
        await database.pool.query(
          "UPDATE oms.oms_orders SET external_customer_id='100' WHERE id=21",
        );
        await database.pool.query("INSERT INTO wms.orders(id,source,oms_fulfillment_order_id,channel_id,external_order_id) VALUES(11,'oms','21',36,'2')");
        await store.saveSettings(
          4,
          { enabled: true, paymentWindowMinutes: 30 },
          "staff",
          new Date(original.createdAt),
        );
        const baseline = original.baseline;
        const line = baseline.lines[0];
        // Exercise the provider's real parser before the real PostgreSQL save.
        // Parsing puts discountCodes before changes/additions when it is present.
        const quote = orderEditQuoteSchema.parse({
          connectionId: original.connectionId,
          channelId: baseline.channelId,
          orderId: baseline.orderId,
          operationId: original.id,
          calculatedOrderId: "gid://shopify/CalculatedOrder/2",
          sessionId: "gid://shopify/OrderEditSession/2",
          baseline,
          baselineFingerprint: baseline.fingerprint,
          plan: {
            changes: original.input.changes,
            additions: original.input.additions,
            ...(discountCodes === undefined ? {} : { discountCodes }),
          },
          lines: [
            {
              title: line.title,
              variantTitle: line.variantTitle,
              originalLineId: line.id,
              calculatedLineId: "gid://shopify/CalculatedLineItem/101",
              variantId: line.variantId,
              quantity: 2,
              originalUnitPriceCents: 1000,
              discountedUnitPriceCents: 1000,
              totalCents: 2000,
            },
          ],
          totalCents: 2000,
          outstandingCents: 1000,
          deltaCents: 1000,
          shippingCents: 0,
          createdAt: original.createdAt,
          evidence: {},
        });
        const external = serviceHarness();
        external.provider.readOrder.mockResolvedValue(baseline);
        external.provider.quote.mockResolvedValue(quote);
        const service = new OrderEditService(
          store,
          external.provider,
          gateway,
          () => new Date(original.createdAt),
          () => original.id,
          external.report,
        );
        if (resume) {
          external.provider.quote.mockRejectedValueOnce(new Error("Fixture preparation failure"));
          expect(await service.quote(original.input, original.actorId)).toMatchObject({ status: "review_required" });
          expect((await gateway.inspect(21)).reasons).toEqual([]);
          expect(await service.order(4, 21, "v1", original.actorId)).toMatchObject({ activeOperationId: original.id, eligibility: { editable: true, reasons: [] } });
          // Warehouse availability is not an authorization grant. Customer facade
          // tests separately prove that another customer cannot open this order.
          expect(await service.order(4, 21, "v1", "customer:36:101")).toMatchObject({ eligibility: { editable: true } });
        }
        let response;
        if (resume) {
          let entered!: () => void;
          let release!: () => void;
          const started = new Promise<void>(resolve => { entered = resolve; });
          const gate = new Promise<void>(resolve => { release = resolve; });
          external.provider.quote.mockImplementationOnce(async () => { entered(); await gate; return quote; });
          const first = service.resume(original.id, original.actorId);
          await started;
          try {
            await expect(service.resume(original.id, original.actorId)).rejects.toMatchObject({ code: "ORDER_EDIT_BUSY" });
          } finally { release(); }
          response = await first;
        } else response = await service.quote(original.input, original.actorId);
        expect(response).toMatchObject({
          status: "ready",
          quoteAvailable: true,
          updatedTotalCents: 2000,
          error: null,
        });
        const next = await store.get(original.id);
        const version = resume ? 3 : 1;
        expect(next).toMatchObject({ status: "ready", version, quote });
        expect(await store.findByRequestKey(original.requestKey)).toEqual(next);
        expect(await service.quote(original.input, original.actorId)).toMatchObject({ operationId: original.id, status: "ready", updatedTotalCents: response.updatedTotalCents });
        if (resume) await service.resume(original.id, original.actorId);
        expect(external.provider.quote).toHaveBeenCalledTimes(resume ? 2 : 1);
        expect(external.provider.commit).not.toHaveBeenCalled();
        expect(external.provider.refund).not.toHaveBeenCalled();
        if (!resume) expect(external.report).not.toHaveBeenCalled();
        const changedPlan = {
          ...next,
          version: version + 1,
          input: { ...next.input, discountCodes: ["DIFFERENT"] },
        };
        await expect(
          store.save(changedPlan, version, original.actorId, "quoted"),
        ).rejects.toMatchObject({
          issues: expect.arrayContaining([
            expect.objectContaining({ path: ["quote", "plan"] }),
          ]),
        });
        expect(await store.get(original.id)).toEqual(next);
        expect(
          (
            await database.pool.query(
              "SELECT action FROM oms.order_edit_events WHERE operation_id=$1 ORDER BY id",
              [original.id],
            )
          ).rows.map((row) => row.action),
        ).toEqual(resume ? ["created", "quote_failed", "quote_preparation_resumed", "quoted"] : ["created", "quoted"]);
        expect((await database.pool.query("SELECT order_edit_operation_id FROM wms.orders WHERE id=11")).rows[0].order_edit_operation_id).toBeNull();
        expect(next.commitStartedAt).toBeNull();
        expect(next.refundStartedAt).toBeNull();
      },
    );
    it("enforces customer identities and the original staff foreign key in PostgreSQL", async () => {
      await customerParent();
      const customer = customerRecord();
      await new PostgresOrderEditStore(database.pool).create(customer);
      for (const column of ["customer_actor_external_id=NULL", "customer_actor_external_id='101'", "customer_actor_external_id='invalid'"]) {
        await expect(database.pool.query(`UPDATE oms.order_edit_operations SET ${column} WHERE id=$1`, [customer.id])).rejects.toMatchObject({ code: "23514" });
      }
      await expect(database.pool.query("UPDATE oms.order_edit_operations SET actor_id='nonexistent-staff',customer_actor_channel_id=NULL,customer_actor_external_id=NULL WHERE id=$1", [customer.id])).rejects.toMatchObject({ code: "23503" });
    });
    it("allows only one concurrent customer edit on an order", async () => {
      await customerParent();
      const customer = customerRecord();
      const other = { ...customer, id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", requestKey: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        input: { ...customer.input, requestKey: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" } };
      const store = new PostgresOrderEditStore(database.pool);
      const results = await Promise.allSettled([store.create(customer), store.create(other)]);
      expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
      expect((await database.pool.query("SELECT count(*)::int AS count FROM oms.order_edit_operations WHERE oms_order_id=21")).rows[0].count).toBe(1);
      expect((await database.pool.query("SELECT count(*)::int AS count FROM oms.order_edit_events WHERE operation_id=ANY($1::uuid[])", [[customer.id, other.id]])).rows[0].count).toBe(1);
    });

    async function persistedState() {
      const result: Record<string, unknown> = {};
      // Constant, test-owned table identities; compare full rows, not just counts.
      for (const table of [
        "oms.oms_orders",
        "oms.oms_order_lines",
        "wms.orders",
        "wms.order_items",
        "wms.outbound_shipments",
        "inventory.availability_claims",
        "inventory.availability_claim_lines",
        "oms.order_edit_settings",
        "oms.order_edit_operations",
        "oms.order_edit_events",
        "oms.order_edit_provider_holds",
      ])
        result[table] = (
          await database.pool.query(
            `SELECT COALESCE(jsonb_agg(to_jsonb(row) ORDER BY to_jsonb(row)::text), '[]'::jsonb) AS rows FROM ${table} row`,
          )
        ).rows[0].rows;
      return result;
    }
    it("catalog discovery reads the selected connection without changing persisted orders, inventory or edit records", async () => {
      const pageInfo = { hasNextPage: false, endCursor: null };
      const catalog: OrderEditCatalog = {
        categories: vi.fn<OrderEditCatalog["categories"]>(
          async (connectionId, input) => ({
            connectionId,
            input,
            categories: ["Toploaders"],
            pageInfo,
          }),
        ),
        products: vi.fn<OrderEditCatalog["products"]>(
          async (connectionId, input) => ({
            connectionId,
            input,
            products: [],
            pageInfo,
          }),
        ),
        productVariants: vi.fn<OrderEditCatalog["productVariants"]>(
          async (connectionId, input) => ({
            connectionId,
            input: orderEditCatalogVariantsInputSchema.parse(input),
            product: {
              productId: input.productId,
              title: "Toploader",
              category: "Toploaders",
              imageUrl: null,
            },
            variants: [],
            pageInfo,
          }),
        ),
      };
      const request = vi.fn<typeof fetch>();
      const provider = new ShopifyOrderEditProvider({
        clock: () => new Date(PREVIEW_NOW),
        credentials: { get: async () => null },
        fetch: request,
      });
      const service = new OrderEditService(
        new PostgresOrderEditStore(database.pool),
        provider,
        gateway,
        () => new Date(PREVIEW_NOW),
        () => OP,
        vi.fn(),
        undefined,
        catalog,
      );
      const before = await persistedState();
      await service.catalogCategories(4, { after: null });
      await service.catalogProducts(4, {
        search: "toploader",
        category: "Toploaders",
        after: null,
      });
      await service.catalogVariants(4, {
        productId: "gid://shopify/Product/10",
        after: null,
      });
      await expect(
        service.catalogProducts(999, {
          search: "toploader",
          category: null,
          after: null,
        }),
      ).rejects.toMatchObject({ code: "ORDER_EDIT_CONNECTION_UNAVAILABLE" });
      expect(catalog.products).toHaveBeenCalledTimes(1);
      expect(request).not.toHaveBeenCalled();
      expect(await persistedState()).toEqual(before);
    });
    it("background preview preserves every persisted source, warehouse, inventory and edit record", async () => {
      const store = new PostgresOrderEditStore(database.pool);
      const proof = await gateway.releaseUnchanged(20, OP);
      await store.save(
        { ...record(), version: 1, status: "expired" },
        0,
        "staff",
        "fixture_closed",
        proof,
      );
      await store.saveSettings(
        4,
        { enabled: true, paymentWindowMinutes: 30 },
        "staff",
        new Date(PREVIEW_NOW),
      );
      await database.pool.query(
        "UPDATE oms.oms_orders SET external_customer_id='8' WHERE id=20",
      );
      const context = previewContext();
      context.snapshot.orderId = "gid://shopify/Order/1";
      const input = { ...previewInput(), omsOrderId: 20 };
      const provider = {
        readOrder: vi.fn(async () => structuredClone(context.snapshot)),
        preparePreview: vi.fn(async () => structuredClone(context)),
        preview: vi.fn(async (_context: unknown, plan: OrderEditPlan) =>
          previewCalculation(context, { ...input, ...plan }),
        ),
        quote: vi.fn(),
        commit: vi.fn(),
        refund: vi.fn(),
      };
      const shipmentWrite = vi.fn();
      const inspectOnly = new OrderEditWarehouseGateway(
        database.pool,
        {
          isConfigured: () => true,
          synchronizeOrderEditShipment: shipmentWrite,
        },
        vi.fn(),
      );
      const service = new OrderEditPreviewService(
        store,
        provider,
        inspectOnly,
        () => new Date(PREVIEW_NOW),
      );
      const before = await persistedState();
      const { changes, additions, ...scope } = input;
      await service.warm(scope, "staff");
      const catalogCustomer = await service.catalogSnapshot(scope, "staff");
      expect(catalogCustomer.customerId).toBe("gid://shopify/Customer/8");
      expect(catalogCustomer.memberPlan).toBe(context.snapshot.memberPlan);
      expect(provider.readOrder).toHaveBeenCalledTimes(1);
      const result = await service.preview(input, "staff");
      expect(result.financials.totalCents).toBe(22098);
      expect(await persistedState()).toEqual(before);
      expect(provider.quote).not.toHaveBeenCalled();
      expect(provider.commit).not.toHaveBeenCalled();
      expect(provider.refund).not.toHaveBeenCalled();
      expect(shipmentWrite).not.toHaveBeenCalled();
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
          after_state: { ...after, warehouseRelease: proof },
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
        ).toBe("committing");
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
      expect((await store.get(OP)).status).toBe("committing");
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
    it("round-trips shipping, discount and payment evidence alongside legacy operations", async () => {
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
          shippingContext: {
            address: {
              address1: "100 Test St",
              address2: null,
              city: "Test",
              provinceCode: "PA",
              zip: "16066",
              countryCodeV2: "US",
            },
            lines: [
              {
                id: "gid://shopify/ShippingLine/1",
                title: "Standard Shipping",
                code: "standard",
                source: "Echelon Shipping",
                grossCents: 500,
                netCents: 0,
              },
            ],
          },
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
    it("persists protected quantity lineage and UUID calculated identities without altering purchased or warehouse quantities", async () => {
      const store = new PostgresOrderEditStore(database.pool);
      await gateway.acquire(20, OP);
      const before = await physicalState();
      const baseline = snapshot();
      const original = baseline.lines[0];
      const calculatedOriginal = "gid://shopify/CalculatedLineItem/101";
      const calculatedAddition =
        "gid://shopify/CalculatedLineItem/385de2d5-a4b7-49f3-9a8f-10a609b835fe";
      const next: OrderEditRecord = {
        ...record(),
        status: "ready",
        version: 1,
        quote: {
          shippingRepricing: {
            title: "Standard Shipping",
            code: "standard",
            source: "Echelon Shipping",
            grossCents: 799,
            netCents: 0,
            discountCents: 799,
            discountLabels: ["Member free shipping"],
          },
          connectionId: 4,
          channelId: 36,
          orderId: baseline.orderId,
          operationId: OP,
          calculatedOrderId: "gid://shopify/CalculatedOrder/1",
          sessionId: "gid://shopify/OrderEditSession/1",
          baseline,
          baselineFingerprint: baseline.fingerprint,
          plan: { changes: record().input.changes, additions: [] },
          lines: [
            {
              title: original.title,
              variantTitle: original.variantTitle,
              originalLineId: original.id,
              calculatedLineId: calculatedOriginal,
              variantId: original.variantId,
              quantity: 1,
              originalUnitPriceCents: 1000,
              discountedUnitPriceCents: 1000,
              totalCents: 1000,
            },
            {
              title: original.title,
              variantTitle: original.variantTitle,
              originalLineId: null,
              quantityIncreaseOfLineId: original.id,
              calculatedLineId: calculatedAddition,
              variantId: original.variantId,
              quantity: 1,
              originalUnitPriceCents: 1000,
              discountedUnitPriceCents: 900,
              totalCents: 900,
            },
          ],
          totalCents: 1900,
          outstandingCents: 900,
          deltaCents: 900,
          shippingCents: 0,
          createdAt: record().createdAt,
          evidence: {},
          financials: buildOrderEditFinancials({
            lines: [
              { id: calculatedOriginal, grossCents: 1000, netCents: 1000 },
              { id: calculatedAddition, grossCents: 1000, netCents: 900 },
            ],
            itemsNetCents: 1900,
            itemDiscountLabels: ["Echelon member pricing"],
            itemDiscounts: [
              {
                key: "product",
                label: "Product discounts",
                amountCents: 100,
                value: { type: "allocated" },
              },
            ],
            shippingGrossCents: 0,
            shippingCents: 0,
            shippingDiscountLabels: [],
            taxCents: 0,
            taxesIncluded: false,
            totalCents: 1900,
          }),
        },
      };
      await store.save(next, 0, "staff", "quoted");
      expect((await store.get(OP)).quote).toEqual(next.quote);
      expect(await physicalState()).toEqual(before);
      const corrupted = structuredClone(next);
      corrupted.version = 2;
      corrupted.quote!.lines[1].quantity = 2;
      await expect(
        store.save(corrupted, 1, "staff", "quoted"),
      ).rejects.toThrow();
      expect(await store.get(OP)).toEqual(next);
      expect(
        (
          await database.pool.query(
            "SELECT action FROM oms.order_edit_events WHERE operation_id=$1 ORDER BY id",
            [OP],
          )
        ).rows,
      ).toEqual([{ action: "created" }, { action: "quoted" }]);
      expect(
        (
          await database.pool.query(
            "SELECT order_edit_operation_id FROM wms.orders WHERE id=10",
          )
        ).rows[0].order_edit_operation_id,
      ).toBe(OP);
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
    async function seedStoppedRefundEdit() {
      const now = new Date("2026-10-05T00:01:00Z");
      const operation = settledRefundEditFixture(OP, now);
      const store = new PostgresOrderEditStore(database.pool);
      await store.save({ ...operation, version: 1 }, 0, "staff", "synthetic_stopped_refund_fixture");
      await database.pool.query(`UPDATE wms.orders SET warehouse_status='cancelled',cancelled_at=now(),on_hold=1,
          order_edit_operation_id='00000000-0000-4000-8000-000000000001' WHERE id=10;
        UPDATE wms.order_items SET quantity=0,status='cancelled' WHERE id=40;
        UPDATE oms.oms_order_lines SET authority_fulfillable_quantity=0,refunded_quantity=1,authorization_status='refunded' WHERE id=30;`);
      return { now, operation, store, snapshot: operation.lastSnapshot! };
    }

    it("restores only empty owned work for a settled refund, retains all holds and audits once across retries", async () => {
      const { snapshot } = await seedStoppedRefundEdit();
      const enabledGateway = new OrderEditWarehouseGateway(database.pool,
        { isConfigured: () => true, synchronizeOrderEditShipment: vi.fn() }, vi.fn(), () => new Date("2026-10-05T00:01:00Z"), () => true);
      await enabledGateway.assertHeld(20, OP, snapshot);
      await enabledGateway.assertHeld(20, OP, snapshot);
      expect((await database.pool.query("SELECT warehouse_status,cancelled_at,on_hold,order_edit_operation_id FROM wms.orders WHERE id=10")).rows[0])
        .toEqual({ warehouse_status: "ready", cancelled_at: null, on_hold: 1, order_edit_operation_id: OP });
      expect((await database.pool.query("SELECT count(*)::int AS n FROM oms.order_edit_events WHERE action='stopped_refund_warehouse_restored'")).rows[0].n).toBe(1);
      expect((await database.pool.query("SELECT status,quantity FROM wms.order_items WHERE id=40")).rows[0])
        .toEqual({ status: "cancelled", quantity: 0 });
    });

    async function seedRetiredProvider() {
      const seeded = await seedStoppedRefundEdit();
      await database.pool.query(`INSERT INTO wms.outbound_shipments(id,order_id,status,shipping_engine,shipstation_order_id,engine_order_ref)
        VALUES(51,10,'cancelled','shipstation',551,'551');
        INSERT INTO oms.order_edit_provider_holds(operation_id,shipment_id,provider_order_id,was_held)
        VALUES('00000000-0000-4000-8000-000000000001',51,551,true);`);
      return seeded;
    }

    it("verifies the retired provider job before recovery and again on retry while preserving its receipt", async () => {
      const { snapshot, now } = await seedRetiredProvider();
      const provider = vi.fn(async () => {});
      const enabledGateway = new OrderEditWarehouseGateway(database.pool,
        { isConfigured: () => true, synchronizeOrderEditShipment: provider }, vi.fn(), () => now, () => true);
      await enabledGateway.assertHeld(20, OP, snapshot);
      await enabledGateway.assertHeld(20, OP, snapshot);
      expect(provider.mock.calls).toEqual([
        [{ shipmentId: 51, operationId: OP, mode: "verify_retired" }],
        [{ shipmentId: 51, operationId: OP, mode: "verify_retired" }],
      ]);
      expect((await database.pool.query("SELECT released_at,was_held FROM oms.order_edit_provider_holds WHERE shipment_id=51")).rows)
        .toEqual([{ released_at: null, was_held: true }]);
    });

    it("uses the existing ShipStation owner for GET-only retired-job verification on both sides of header recovery", async () => {
      const { snapshot, now } = await seedRetiredProvider();
      vi.stubEnv("SHIPSTATION_API_KEY", "synthetic-key");
      vi.stubEnv("SHIPSTATION_API_SECRET", "synthetic-secret");
      const request = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        expect(init?.method).toBe("GET");
        const path = new URL(String(url)).pathname;
        const job = { orderId: 551, orderNumber: "#1", orderStatus: "cancelled", items: [] };
        const result = path === "/orders/551" ? job : path === "/orders" ? { orders: [job], pages: 1 }
          : path === "/shipments" ? { shipments: [], pages: 0 } : null;
        if (!result) throw new Error("Unexpected synthetic provider read");
        return new Response(JSON.stringify(result), { status: 200 });
      });
      vi.stubGlobal("fetch", request);
      try {
        const provider = createShipStationService(drizzle(database.pool), undefined, { sessionLock: async (_key, work) => work() });
        const enabledGateway = new OrderEditWarehouseGateway(database.pool, provider, vi.fn(), () => now, () => true);
        await enabledGateway.assertHeld(20, OP, snapshot);
        await enabledGateway.assertHeld(20, OP, snapshot);
        expect(request).toHaveBeenCalledTimes(6);
        expect((await database.pool.query("SELECT warehouse_status FROM wms.orders WHERE id=10")).rows[0].warehouse_status).toBe("ready");
      } finally { vi.unstubAllGlobals(); vi.unstubAllEnvs(); }
    });

    it.each(["remote_active", "identity_missing", "receipt_missing", "receipt_changed", "concurrent_physical_change"])(
      "retains stopped ownership when retired provider proof has %s", async failure => {
        const { snapshot, now } = await seedRetiredProvider();
        if (failure === "identity_missing") await database.pool.query("UPDATE wms.outbound_shipments SET shipstation_order_id=NULL,engine_order_ref=NULL WHERE id=51");
        if (failure === "receipt_missing") await database.pool.query("DELETE FROM oms.order_edit_provider_holds WHERE shipment_id=51");
        if (failure === "receipt_changed") await database.pool.query("UPDATE oms.order_edit_provider_holds SET provider_order_id=552 WHERE shipment_id=51");
        const provider = vi.fn(async () => {
          if (failure === "remote_active") throw new Error("Remote cancellation not confirmed");
          if (failure === "concurrent_physical_change") await database.pool.query("UPDATE wms.orders SET started_at=now() WHERE id=10");
        });
        const enabledGateway = new OrderEditWarehouseGateway(database.pool,
          { isConfigured: () => true, synchronizeOrderEditShipment: provider }, vi.fn(), () => now, () => true);
        await expect(enabledGateway.assertHeld(20, OP, snapshot)).rejects.toThrow();
        expect((await database.pool.query("SELECT warehouse_status,on_hold,order_edit_operation_id FROM wms.orders WHERE id=10")).rows)
          .toEqual([{ warehouse_status: "cancelled", on_hold: 1, order_edit_operation_id: OP }]);
      },
    );

    it.each(["picked", "started", "label", "owner", "contents", "source_cancelled", "refund_pending"])(
      "does not restore stopped work when %s evidence is unsafe", async kind => {
        const { snapshot } = await seedStoppedRefundEdit();
        if (kind === "picked") await database.pool.query("UPDATE wms.order_items SET picked_quantity=1 WHERE id=40");
        if (kind === "started") await database.pool.query("UPDATE wms.orders SET started_at=now() WHERE id=10");
        if (kind === "label") await database.pool.query("INSERT INTO wms.outbound_shipments(id,order_id,status,tracking_number) VALUES(51,10,'cancelled','TRACKING')");
        if (kind === "owner") await database.pool.query("UPDATE wms.orders SET order_edit_operation_id=NULL WHERE id=10");
        if (kind === "contents") await database.pool.query("UPDATE wms.order_items SET quantity=1,status='pending' WHERE id=40");
        if (kind === "source_cancelled") await database.pool.query("UPDATE oms.oms_orders SET status='cancelled',cancelled_at=now() WHERE id=20");
        if (kind === "refund_pending") snapshot.refunds[0].transactions[0].status = "PENDING";
        const enabledGateway = new OrderEditWarehouseGateway(database.pool,
          { isConfigured: () => true, synchronizeOrderEditShipment: vi.fn() }, vi.fn(), () => new Date("2026-10-05T00:01:00Z"), () => true);
        await expect(enabledGateway.assertHeld(20, OP, snapshot)).rejects.toThrow();
        expect((await database.pool.query("SELECT warehouse_status,order_edit_operation_id,on_hold FROM wms.orders WHERE id=10")).rows[0])
          .toMatchObject({ warehouse_status: "cancelled", on_hold: 1 });
        expect((await database.pool.query("SELECT count(*)::int AS n FROM oms.order_edit_events WHERE action='stopped_refund_warehouse_restored'")).rows[0].n).toBe(0);
      });

    it.each([false, true])("completes the stopped refund edit through retries without another financial command (dispatch queue failure=%s)", async failQueue => {
      const { now, operation, snapshot } = await seedRetiredProvider();
      const legacy = { ...operation, version: 1, status: "review_required", error: { code: "ORDER_EDIT_PICKING_CUTOFF", message: "Legacy stopped warehouse" } };
      await database.pool.query("UPDATE oms.order_edit_operations SET status='review_required',document=$2::jsonb WHERE id=$1", [OP, JSON.stringify(legacy)]);
      await database.pool.query(`INSERT INTO oms.oms_order_lines(id,order_id,external_line_item_id,quantity,paid_quantity,
        authority_fulfillable_quantity,product_variant_id,authorization_status,paid_price_cents,retail_price_cents,total_price_cents)
        VALUES(31,20,'102',1,0,0,100,'seen',900,900,900)`);
      // The default release cannot resume this historical operation on deployment alone.
      expect(await new PostgresOrderEditStore(database.pool).pending(25, now)).toEqual([]);
      const store = new PostgresOrderEditStore(database.pool, () => [36]);
      expect(await store.pending(25, now)).toEqual([OP]);
      const saveErrors: string[] = [];
      const save = store.save.bind(store);
      vi.spyOn(store, "save").mockImplementation(async (...args) => {
        try { return await save(...args); }
        catch (error) { saveErrors.push((error as Error).message + " " + String((error as Error).cause)); throw error; }
      });
      const inventory = inventoryProjection();
      inventory.claim!.claimId = "2";
      inventory.claim!.lines[0] = { ...inventory.claim!.lines[0], claimLineId: "2", lineKey: "item:41", orderItemId: 41 };
      const projector = new OrderEditPaidProjection(database.pool, () => now, () => true);
      let failed = false;
      const materialize = vi.fn(async () => {
        if (!failed) { failed = true; throw new Error("Synthetic interrupted synchronization"); }
        // This query fixture supplies the WMS/claim contract. The ordinary WMS
        // materializer and real canonical reservations have their own PG suite.
        await drizzle(database.pool).transaction(async tx => {
          await tx.execute(sql`INSERT INTO wms.order_items(id,order_id,oms_order_line_id,quantity) VALUES(41,10,31,1) ON CONFLICT DO NOTHING;
            UPDATE inventory.availability_claims SET status='released' WHERE id=1;
            INSERT INTO inventory.availability_claims VALUES(2,10,'active',1,'satisfied',1,1,repeat('f',64)) ON CONFLICT DO NOTHING;
            INSERT INTO inventory.availability_claim_lines VALUES(2,2,41,100,1,1,0,0,0,0) ON CONFLICT DO NOTHING;`);
          const created = await tx.execute(sql`INSERT INTO wms.outbound_shipments(id,order_id,status) VALUES(52,10,'planned') ON CONFLICT DO NOTHING RETURNING id`);
          if (created.rows.length) await registerStoppedRefundDeferredShipment(tx,
            { omsOrderId: 20, wmsOrderId: 10, shipmentId: 52, operationId: OP, now });
        });
        return 10;
      });
      const synchronizer = new OrderEditOmsSynchronizer(database.pool, { syncOmsOrderToWms: materialize },
        { getOrderReservationStatus: vi.fn(async () => inventory) }, (id, op, source) => projector.project(id, op, source));
      const enabledGateway = new OrderEditWarehouseGateway(database.pool,
        { isConfigured: () => true, synchronizeOrderEditShipment: vi.fn() },
        (id, source, op) => synchronizer.synchronize(id, source, op), () => now, () => true);
      const synchronizeErrors: string[] = [];
      const reconcile = enabledGateway.reconcileAndRelease.bind(enabledGateway);
      vi.spyOn(enabledGateway, "reconcileAndRelease").mockImplementation(async (...args) => {
        try { return await reconcile(...args); }
        catch (error) { synchronizeErrors.push((error as Error).message); throw error; }
      });
      const h = serviceHarness();
      h.provider.observeRefund.mockResolvedValue({ status: "succeeded", refundId: snapshot.refunds[0].id, evidence: snapshot.refunds[0] });
      h.provider.reconcileCommit.mockResolvedValue({ status: "applied", snapshot });
      const service = new OrderEditService(store, h.provider, enabledGateway, () => now, () => OP, h.report,
        undefined, undefined, undefined, undefined, () => true);
      await service.sweep();
      expect((await store.get(OP)).status).toBe("synchronizing");
      expect((await database.pool.query("SELECT warehouse_status,on_hold,order_edit_operation_id FROM wms.orders WHERE id=10")).rows[0])
        .toEqual({ warehouse_status: "ready", on_hold: 1, order_edit_operation_id: OP });
      if (failQueue) await database.pool.query(`CREATE SEQUENCE synthetic_deferred_queue_attempt;
        CREATE FUNCTION synthetic_fail_deferred_queue() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
          IF NEW.topic='shipstation_shipment_push' AND nextval('synthetic_deferred_queue_attempt')=1 THEN
            RAISE EXCEPTION 'Synthetic deferred dispatch failure'; END IF; RETURN NEW; END; $$;
        CREATE TRIGGER synthetic_fail_deferred_queue BEFORE INSERT ON oms.webhook_retry_queue
          FOR EACH ROW EXECUTE FUNCTION synthetic_fail_deferred_queue();`);
      await service.sweep();
      if (failQueue) {
        expect((await store.get(OP)).status).toBe("synchronizing");
        expect((await database.pool.query("SELECT order_edit_operation_id FROM wms.orders WHERE id=10")).rows[0].order_edit_operation_id).toBe(OP);
        expect((await database.pool.query("SELECT released_at FROM oms.order_edit_provider_holds WHERE shipment_id=51")).rows[0].released_at).toBeNull();
      }
      await service.sweep();
      expect(synchronizeErrors).toEqual(["Synthetic interrupted synchronization"]);
      expect(saveErrors).toHaveLength(failQueue ? 1 : 0);
      if (failQueue) {
        expect(saveErrors[0]).toContain("Synthetic deferred dispatch failure");
        await database.pool.query("DROP TRIGGER synthetic_fail_deferred_queue ON oms.webhook_retry_queue; DROP FUNCTION synthetic_fail_deferred_queue(); DROP SEQUENCE synthetic_deferred_queue_attempt;");
      }
      expect((await store.get(OP)).error).toBeNull();
      expect((await store.get(OP)).status).toBe("completed");
      expect(await store.pending(25, now)).toEqual([]);
      expect((await database.pool.query("SELECT on_hold,order_edit_operation_id FROM wms.orders WHERE id=10")).rows[0])
        .toEqual({ on_hold: 1, order_edit_operation_id: null });
      expect((await enabledGateway.inspect(20)).cancellationReasons).toEqual([]);
      expect((await database.pool.query("SELECT count(*)::int AS n FROM oms.order_edit_events WHERE action='stopped_refund_warehouse_restored'")).rows[0].n).toBe(1);
      expect((await database.pool.query("SELECT released_at FROM oms.order_edit_provider_holds WHERE shipment_id=51")).rows[0].released_at).not.toBeNull();
      expect((await database.pool.query("SELECT status FROM wms.outbound_shipments WHERE id=51")).rows[0].status).toBe("cancelled");
      expect((await database.pool.query("SELECT status,shipstation_order_id FROM wms.outbound_shipments WHERE id=52")).rows[0])
        .toEqual({ status: "planned", shipstation_order_id: null });
      expect((await database.pool.query("SELECT count(*)::int AS n FROM oms.webhook_retry_queue WHERE topic='shipstation_shipment_push' AND payload->>'shipmentId'='52'")).rows[0].n).toBe(1);
      expect(h.provider.refund).not.toHaveBeenCalled();
      expect(h.provider.commit).not.toHaveBeenCalled();
    });

    it("finishes an already-paid reward edit through the worker and real paid projector after a failed release", async () => {
      const now = new Date("2026-10-05T00:01:00Z");
      const operation = paidRewardFixture(OP, now);
      const paid = operation.lastSnapshot!;
      const store = new PostgresOrderEditStore(database.pool);
      await store.save(
        { ...operation, version: 1 },
        0,
        "staff",
        "synthetic_paid_fixture",
      );
      await database.pool.query(`
        UPDATE oms.oms_orders SET total_cents=917 WHERE id=20;
        UPDATE oms.oms_order_lines SET paid_price_cents=279,retail_price_cents=279,
          total_price_cents=279 WHERE id=30;
        INSERT INTO oms.oms_order_lines(id,order_id,external_line_item_id,quantity,paid_quantity,
          authority_fulfillable_quantity,product_variant_id,authorization_status,paid_price_cents,
          retail_price_cents,total_price_cents,total_discount_cents)
        VALUES(31,20,'102',1,0,0,101,'seen',216,499,216,283);
        INSERT INTO wms.order_items(id,order_id,oms_order_line_id,quantity,product_id,sku) VALUES(41,10,31,1,101,'OTHER-PACK');
        INSERT INTO inventory.availability_claim_lines VALUES(2,1,41,101,1,1,0,0,0,0);
        INSERT INTO wms.outbound_shipments(id,order_id,shipstation_order_id) VALUES(51,10,551);
        INSERT INTO wms.outbound_shipment_items VALUES(1,51,40,1),(2,51,41,1);
        UPDATE wms.orders SET on_hold=1 WHERE id=10;
      `);
      const inventory = inventoryProjection();
      inventory.claim!.lines.push({
        ...inventory.claim!.lines[0],
        claimLineId: "2",
        lineKey: "item:41",
        orderItemId: 41,
        targetVariantId: 101,
        sku: "OTHER-PACK",
      });
      const projector = new OrderEditPaidProjection(database.pool, () => now);
      const sync = new OrderEditOmsSynchronizer(
        database.pool,
        { syncOmsOrderToWms: vi.fn(async () => 10) },
        { getOrderReservationStatus: vi.fn(async () => inventory) },
        (id, op, snapshot) => projector.project(id, op, snapshot),
      );
      let releaseFailed = false;
      const remote = vi.fn<
        OrderEditWarehouseProvider["synchronizeOrderEditShipment"]
      >(async (input) => {
        if (input.mode === "hold")
          await database.pool.query(
            `INSERT INTO oms.order_edit_provider_holds(operation_id,shipment_id,provider_order_id,was_held)
          VALUES($1,$2,551,false) ON CONFLICT(operation_id,shipment_id) DO NOTHING`,
            [input.operationId, input.shipmentId],
          );
        if (input.mode === "release" && !releaseFailed) {
          releaseFailed = true;
          throw new Error("Synthetic lost release response");
        }
      });
      const actualGateway = new OrderEditWarehouseGateway(
        database.pool,
        { isConfigured: () => true, synchronizeOrderEditShipment: remote },
        (id, snapshot, op) => sync.synchronize(id, snapshot, op),
      );
      const h = serviceHarness();
      h.provider.reconcileCommit.mockResolvedValue({
        status: "applied",
        snapshot: paid,
      });
      const codes = {
        available: () => true,
        reserve: vi.fn(),
        finalize: vi.fn(async () => {}),
        release: vi.fn(),
      };
      const service = new OrderEditService(
        store,
        h.provider,
        actualGateway,
        () => now,
        () => OP,
        h.report,
        undefined,
        undefined,
        codes,
      );
      await service.sweep();
      expect((await store.get(OP)).status).toBe("synchronizing");
      expect(releaseFailed).toBe(true);
      expect((await store.get(OP)).error?.code).toBe("ORDER_EDIT_UNAVAILABLE");
      expect(
        (
          await database.pool.query(
            "SELECT order_edit_operation_id FROM wms.orders WHERE id=10",
          )
        ).rows[0].order_edit_operation_id,
      ).toBe(OP);
      expect(
        (
          await database.pool.query(
            "SELECT released_at FROM oms.order_edit_provider_holds WHERE operation_id=$1",
            [OP],
          )
        ).rows,
      ).toEqual([{ released_at: null }]);
      await service.sweep();
      const finished = await store.get(OP);
      expect(finished.status).toBe("completed");
      expect(finished.error).toBeNull();
      expect(await store.pending(25, now)).toEqual([]);
      expect(
        (
          await database.pool.query(
            "SELECT order_edit_operation_id,on_hold FROM wms.orders WHERE id=10",
          )
        ).rows[0],
      ).toEqual({ order_edit_operation_id: null, on_hold: 1 });
      expect(
        (
          await database.pool.query(
            "SELECT released_at FROM oms.order_edit_provider_holds WHERE operation_id=$1",
            [OP],
          )
        ).rows,
      ).toEqual([{ released_at: expect.any(Date) }]);
      expect(
        (
          await database.pool.query(
            "SELECT total_price_cents FROM oms.oms_order_lines ORDER BY id",
          )
        ).rows,
      ).toEqual([{ total_price_cents: "0" }, { total_price_cents: "216" }]);
      expect(
        (
          await database.pool.query(
            "SELECT count(*)::int AS count FROM oms.order_edit_events WHERE action='paid_current_projected'",
          )
        ).rows[0].count,
      ).toBe(1);
      expect(
        (
          await database.pool.query(
            "SELECT count(*)::int AS count FROM oms.order_edit_events WHERE action='completed'",
          )
        ).rows[0].count,
      ).toBe(1);
      expect(codes.finalize).toHaveBeenCalledTimes(2);
      expect(codes.reserve).not.toHaveBeenCalled();
      expect(codes.release).not.toHaveBeenCalled();
      const remoteCalls = remote.mock.calls.length;
      await service.sweep();
      expect(remote).toHaveBeenCalledTimes(remoteCalls);
      expect(h.provider.commit).not.toHaveBeenCalled();
      expect(h.provider.refund).not.toHaveBeenCalled();
      expect(h.provider.recoverUnpaid).not.toHaveBeenCalled();
    });
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
    it.each(["preparing", "ready", "review_required"])("does not inherit or acquire a hold for a %s draft", async status => {
      await database.pool.query("UPDATE oms.order_edit_operations SET status=$2::varchar,document=jsonb_set(document,'{status}',to_jsonb($2::text)) WHERE id=$1", [OP, status]);
      await database.pool.query("INSERT INTO wms.orders(id,source,oms_fulfillment_order_id,channel_id,external_order_id) VALUES(11,'oms','20',36,'1')");
      expect((await database.pool.query("SELECT order_edit_operation_id FROM wms.orders ORDER BY id")).rows).toEqual([
        { order_edit_operation_id: null }, { order_edit_operation_id: null },
      ]);
      await expect(gateway.acquire(20, OP)).rejects.toMatchObject({ code: "ORDER_EDIT_HOLD_OWNER_INVALID" });
      const claimed = await database.pool.query("UPDATE wms.orders SET assigned_picker_id='picker',started_at='2026-10-05T00:01:00Z' WHERE id=10 AND order_edit_operation_id IS NULL");
      expect(claimed.rowCount).toBe(1);
    });
    it("atomically releases an interrupted submission, preserves manual holds, and stops new partitions inheriting", async () => {
      const store = new PostgresOrderEditStore(database.pool);
      await gateway.acquire(20, OP);
      await database.pool.query("UPDATE wms.orders SET on_hold=1 WHERE id=10");
      const proof = await gateway.releaseUnsubmitted(20, OP);
      expect((await database.pool.query("SELECT order_edit_operation_id FROM wms.orders WHERE id=10")).rows[0].order_edit_operation_id).toBe(OP);
      await store.save({ ...record(), status: "review_required", version: 1 }, 0, "staff", "unsubmitted_hold_released", proof);
      expect((await database.pool.query("SELECT order_edit_operation_id,on_hold FROM wms.orders WHERE id=10")).rows[0]).toEqual({ order_edit_operation_id: null, on_hold: 1 });
      await database.pool.query("INSERT INTO wms.orders(id,source,oms_fulfillment_order_id,channel_id,external_order_id) VALUES(11,'oms','20',36,'1')");
      expect((await database.pool.query("SELECT order_edit_operation_id FROM wms.orders WHERE id=11")).rows[0].order_edit_operation_id).toBeNull();
      expect((await database.pool.query("SELECT after_state->'warehouseRelease'->>'unsubmitted' AS proof FROM oms.order_edit_events WHERE action='unsubmitted_hold_released'")).rows[0].proof).toBe("true");
    });
    it("rejects stale cleanup proof if financial intent appeared after verification", async () => {
      await gateway.acquire(20, OP);
      const proof = await gateway.releaseUnsubmitted(20, OP);
      await database.pool.query(`UPDATE oms.order_edit_operations SET document=jsonb_set(document,'{commitStartedAt}','"2026-10-05T00:01:00.000Z"') WHERE id=$1`, [OP]);
      const client = await database.pool.connect();
      try {
        await client.query("BEGIN");
        await expect(finalizeOrderEditWarehouseRelease(client, 20, OP, proof, record().updatedAt)).rejects.toMatchObject({ code: "ORDER_EDIT_ALREADY_SUBMITTED" });
      } finally { await client.query("ROLLBACK"); client.release(); }
      expect((await database.pool.query("SELECT order_edit_operation_id FROM wms.orders WHERE id=10")).rows[0].order_edit_operation_id).toBe(OP);
    });
    it("does not treat missing financial intent as permission to release an already certified paid edit", async () => {
      await gateway.acquire(20, OP);
      await saveProjection();
      await expect(gateway.releaseUnsubmitted(20, OP)).rejects.toMatchObject({ code: "ORDER_EDIT_ALREADY_SUBMITTED" });
    });
    it("rolls back an unsubmitted release if audit persistence fails", async () => {
      await gateway.acquire(20, OP);
      const store = new PostgresOrderEditStore(database.pool);
      const proof = await gateway.releaseUnsubmitted(20, OP);
      await expect(store.save({ ...record(), status: "review_required", version: 1 }, 0, "missing-staff", "unsubmitted_hold_released", proof)).rejects.toMatchObject({ code: "23503" });
      expect((await store.get(OP)).version).toBe(0);
      expect((await database.pool.query("SELECT order_edit_operation_id FROM wms.orders WHERE id=10")).rows[0].order_edit_operation_id).toBe(OP);
      expect((await database.pool.query("SELECT count(*)::int AS count FROM oms.order_edit_events WHERE action='unsubmitted_hold_released'")).rows[0].count).toBe(0);
    });
    it("cleans legacy failed drafts and interrupted submissions through the real worker and store", async () => {
      const store = new PostgresOrderEditStore(database.pool);
      await gateway.acquire(20, OP);
      const h = serviceHarness();
      const service = new OrderEditService(store, h.provider, gateway, () => new Date("2026-10-05T00:01:00Z"), () => OP, h.report);
      expect(await store.pending(25, new Date("2026-10-05T00:01:00Z"))).toEqual([OP]);
      await service.sweep();
      expect((await store.get(OP)).status).toBe("review_required");
      expect((await database.pool.query("SELECT order_edit_operation_id FROM wms.orders WHERE id=10")).rows[0].order_edit_operation_id).toBeNull();
      expect(h.provider.commit).not.toHaveBeenCalled();
      expect(h.provider.readOrder).not.toHaveBeenCalled();
      // Simulate the previously deployed failed-quote hold, which had no financial intent.
      await database.pool.query("UPDATE wms.orders SET order_edit_operation_id=$1 WHERE id=10", [OP]);
      expect(await store.pending(25, new Date("2026-10-05T00:01:00Z"))).toEqual([OP]);
      await service.sweep();
      expect((await database.pool.query("SELECT order_edit_operation_id FROM wms.orders WHERE id=10")).rows[0].order_edit_operation_id).toBeNull();
      expect(await store.pending(25, new Date("2026-10-05T00:01:00Z"))).toEqual([]);
    });
    it("retries a partial provider cleanup and retires its receipts only in the final atomic transaction", async () => {
      await gateway.acquire(20, OP);
      await database.pool.query("INSERT INTO wms.outbound_shipments(id,order_id,shipstation_order_id) VALUES(51,10,551),(52,10,552)");
      await database.pool.query("INSERT INTO oms.order_edit_provider_holds(operation_id,shipment_id,provider_order_id,was_held) VALUES($1,51,551,false),($1,52,552,true)", [OP]);
      const synchronize = vi.fn<OrderEditWarehouseProvider["synchronizeOrderEditShipment"]>()
        .mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("response lost")).mockResolvedValue(undefined);
      const cleanup = new OrderEditWarehouseGateway(database.pool, { isConfigured: () => true, synchronizeOrderEditShipment: synchronize }, async () => {});
      await expect(cleanup.releaseUnsubmitted(20, OP)).rejects.toThrow("response lost");
      expect((await database.pool.query("SELECT count(*)::int AS count FROM oms.order_edit_provider_holds WHERE released_at IS NULL")).rows[0].count).toBe(2);
      const proof = await cleanup.releaseUnsubmitted(20, OP);
      expect(synchronize.mock.calls.every(([input]) => input.mode === "release_unsubmitted")).toBe(true);
      const store = new PostgresOrderEditStore(database.pool);
      await store.save({ ...record(), status: "review_required", version: 1 }, 0, "staff", "unsubmitted_hold_released", proof);
      expect((await database.pool.query("SELECT count(*)::int AS count FROM oms.order_edit_provider_holds WHERE released_at IS NULL")).rows[0].count).toBe(0);
      expect((await cleanup.releaseUnsubmitted(20, OP)).shipmentIds).toEqual([]);
    });
    it("inherits an approved submission on a new fulfillment partition and protects source identity", async () => {
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
    it("recaptures the provider's current hold on a later submission instead of reusing a retired receipt", async () => {
      const originalFetch = globalThis.fetch;
      let providerStatus = "awaiting_shipment";
      let restored = 0;
      vi.stubEnv("SHIPSTATION_API_KEY", "fixture-key");
      vi.stubEnv("SHIPSTATION_API_SECRET", "fixture-secret");
      globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
        const path = new URL(String(url)).pathname;
        const live = { orderId: 551, orderNumber: "#1", orderStatus: providerStatus, items: [] };
        let result: unknown;
        if (path === "/orders/551") result = live;
        else if (path === "/orders") result = { orders: [live], pages: 1 };
        else if (path === "/shipments") result = { shipments: [], pages: 1 };
        else if (path === "/orders/holduntil") { providerStatus = "on_hold"; result = { success: true }; }
        else if (path === "/orders/restorefromhold") { providerStatus = "awaiting_shipment"; restored++; result = { success: true }; }
        else throw new Error(`Unexpected test request: ${path}`);
        return new Response(JSON.stringify(result), { status: 200, headers: { "Content-Type": "application/json" } });
      }) as typeof fetch;
      try {
        await database.pool.query("INSERT INTO wms.outbound_shipments(id,order_id,shipstation_order_id,status) VALUES(51,10,551,'queued')");
        const provider = createShipStationService(drizzle(database.pool), undefined, { sessionLock: async (_key, work) => work() });
        const realGateway = new OrderEditWarehouseGateway(database.pool, provider, async () => {});
        const store = new PostgresOrderEditStore(database.pool);
        await realGateway.acquire(20, OP);
        const proof = await realGateway.releaseUnsubmitted(20, OP);
        const released = { ...record(), status: "review_required" as const, version: 1 };
        await store.save(released, 0, "staff", "unsubmitted_hold_released", proof);
        expect(providerStatus).toBe("awaiting_shipment");
        expect(restored).toBe(1);
        // An independent hold is applied between attempts. Its new provenance
        // must replace the retired receipt and survive the second cleanup.
        providerStatus = "on_hold";
        await store.save({ ...released, status: "committing", version: 2 }, 1, "staff", "submission_started");
        await realGateway.acquire(20, OP);
        expect((await database.pool.query("SELECT was_held,released_at FROM oms.order_edit_provider_holds WHERE operation_id=$1", [OP])).rows).toEqual([{ was_held: true, released_at: null }]);
        const nextProof = await realGateway.releaseUnsubmitted(20, OP);
        await store.save({ ...released, version: 3 }, 2, "staff", "unsubmitted_hold_released", nextProof);
        expect(providerStatus).toBe("on_hold");
        expect(restored).toBe(1);
      } finally {
        globalThis.fetch = originalFetch;
        vi.unstubAllEnvs();
      }
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
          finalizeOrderEditWarehouseRelease(terminal, 20, OP, proof, record().updatedAt),
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
        await finalizeOrderEditWarehouseRelease(terminal, 20, OP, proof, record().updatedAt);
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
        await finalizeOrderEditWarehouseRelease(terminal, 20, OP, proof, record().updatedAt);
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
      expect((await store.get(OP)).status).toBe("committing");
    });
    it("atomically saves the terminal state, hold release and audit, including rollback on audit failure", async () => {
      await gateway.acquire(20, OP);
      await database.pool.query("INSERT INTO wms.outbound_shipments(id,order_id,shipstation_order_id) VALUES(51,10,551)");
      await database.pool.query("INSERT INTO oms.order_edit_provider_holds(operation_id,shipment_id,provider_order_id,was_held) VALUES($1,51,551,false)",[OP]);
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
      expect((await store.get(OP)).status).toBe("committing");
      expect(
        (
          await database.pool.query(
            "SELECT order_edit_operation_id FROM wms.orders WHERE id=10",
          )
        ).rows[0].order_edit_operation_id,
      ).toBe(OP);
      expect((await database.pool.query('SELECT released_at FROM oms.order_edit_provider_holds WHERE operation_id=$1',[OP])).rows)
        .toEqual([{released_at:null}]);
      await store.save(
        { ...record(), status: "expired", version: 1 },
        0,
        "staff",
        "expired",
        proof,
      );
      expect((await store.get(OP)).status).toBe("expired");
      expect((await database.pool.query('SELECT released_at FROM oms.order_edit_provider_holds WHERE operation_id=$1',[OP])).rows)
        .toEqual([{released_at:new Date(record().updatedAt)}]);
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
      expect((await store.get(OP)).status).toBe("committing");
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
      await database.pool.query(`UPDATE oms.order_edit_operations SET status='preparing',document=jsonb_set(document,'{status}','"preparing"') WHERE id=$1`, [OP]);
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
    it.each([false, true])("keeps a prior submitted conflict with its original owner, not a new draft (pre-send hold=%s)", async approved => {
      const next = "00000000-0000-4000-8000-000000000099";
      await saveProjection();
      await database.pool.query(`UPDATE oms.order_edit_operations SET status='completed',
        document=jsonb_set(jsonb_set(document,'{status}','"completed"'),'{commitStartedAt}','"2026-10-05T00:00:00.000Z"') WHERE id=$1`, [OP]);
      await new PostgresOrderEditStore(database.pool).create({ ...record(), id: next, status: approved ? "committing" : "preparing",
        requestKey: next, input: { ...record().input, requestKey: next } });
      if (approved) {
        await gateway.acquire(20, next);
        await database.pool.query("INSERT INTO wms.outbound_shipments(id,order_id,shipstation_order_id) VALUES(51,10,551)");
        await database.pool.query("INSERT INTO oms.order_edit_provider_holds(operation_id,shipment_id,provider_order_id,was_held) VALUES($1,51,551,true)", [next]);
      }
      await ingress(rawOrder({ current_total_price: "30.00" }));
      expect((await database.pool.query("SELECT id,status FROM oms.order_edit_operations ORDER BY id")).rows).toEqual([
        { id: OP, status: "review_required" }, { id: next, status: "expired" },
      ]);
      expect((await database.pool.query("SELECT order_edit_operation_id FROM wms.orders WHERE id=10")).rows[0].order_edit_operation_id).toBe(OP);
      if (approved) expect((await database.pool.query("SELECT operation_id,was_held FROM oms.order_edit_provider_holds WHERE released_at IS NULL")).rows).toEqual([{ operation_id: OP, was_held: true }]);
      expect(await new PostgresOrderEditStore(database.pool).pending(25, new Date("2026-10-05T00:01:00Z"))).toEqual([]);
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
        await database.pool.query(`UPDATE oms.order_edit_operations SET document=jsonb_set(document,'{commitStartedAt}','"2026-10-05T00:00:00.000Z"') WHERE id=$1`, [next]);
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
