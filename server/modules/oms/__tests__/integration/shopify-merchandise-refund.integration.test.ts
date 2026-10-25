import { readFile } from "node:fs/promises";
import { drizzle } from "drizzle-orm/node-postgres";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  createInventoryCutoverTestDatabase,
  type InventoryCutoverTestDatabase,
} from "../../../inventory/__tests__/fixtures/inventory-cutover-database";
import {
  applyShopifyRefundCascade,
  type ShopifyRefundCascadeHelpers,
} from "../../shopify-refund-cascade.service";
import type { ShopifyMerchandiseSnapshot } from "../../infrastructure/shopify-merchandise-snapshot";

const url = process.env.ECHELON_TEST_DATABASE_URL;
const disposable = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
const NOW = new Date("2026-10-24T12:00:00Z");
// Named-schema query fixture. Execute the additive migration verbatim; external
// inventory reconciliation is a failure-injectable port, not a stock fixture.
const fixture = `CREATE SCHEMA oms;CREATE SCHEMA wms;
CREATE TABLE oms.oms_orders(id bigint PRIMARY KEY,channel_id integer,external_order_id text,status text,financial_status text);
CREATE TABLE oms.oms_order_lines(id bigint PRIMARY KEY,order_id bigint,external_line_item_id text,quantity integer,
 channel_observed_quantity integer,paid_quantity integer,authority_fulfillable_quantity integer,cancelled_quantity integer DEFAULT 0,
 refunded_quantity integer DEFAULT 0,authorization_status text,authorized_at timestamptz,authorized_by_event_id text,
 authority_source_topic text,authority_source_inbox_id integer,requires_shipping boolean DEFAULT true,
 wms_materialized_quantity integer DEFAULT 0,updated_at timestamptz);
CREATE TABLE oms.oms_order_line_authority_events(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,event_key text UNIQUE,
 event_type text,order_id bigint,order_line_id bigint,source_topic text,source_event_id text,source_inbox_id integer,
 previous_channel_observed_quantity integer,previous_paid_quantity integer,previous_authority_fulfillable_quantity integer,
 previous_authorization_status text,channel_observed_quantity integer,paid_quantity integer,authority_fulfillable_quantity integer,
 cancelled_quantity integer,refunded_quantity integer,authorization_status text,authorized_at timestamptz,authorized_by_event_id text,
 created_at timestamptz DEFAULT now());
CREATE TABLE oms.order_line_adjustments(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,order_id bigint,order_line_id bigint,
 external_line_item_id text,source text,source_event_id text,adjustment_type text,restock_policy text,quantity integer,
 reason text,raw_payload jsonb,UNIQUE(source,source_event_id,external_line_item_id,adjustment_type));
CREATE TABLE wms.orders(id integer PRIMARY KEY,source text,oms_fulfillment_order_id text,source_table_id text,
 warehouse_status text DEFAULT 'ready',on_hold integer DEFAULT 1,item_count integer,unit_count integer,picked_count integer,updated_at timestamptz);
CREATE TABLE wms.order_items(id integer PRIMARY KEY,order_id integer,oms_order_line_id bigint,product_id integer,
 quantity integer,picked_quantity integer DEFAULT 0,fulfilled_quantity integer DEFAULT 0,status text DEFAULT 'pending',
 short_reason text,on_hold boolean DEFAULT false,requires_shipping integer DEFAULT 1);
CREATE TABLE wms.outbound_shipments(id integer PRIMARY KEY,order_id integer,status text,requires_review boolean,
 review_reason text,updated_at timestamptz,shipping_engine text,engine_order_ref text,shipstation_order_id integer,shipstation_order_key text);
CREATE TABLE wms.outbound_shipment_items(id integer PRIMARY KEY,shipment_id integer,order_item_id integer,qty integer,commercial_requested_qty integer);`;

function native(currentQuantity = 1): ShopifyMerchandiseSnapshot {
  return {
    orderId: "gid://shopify/Order/1",
    shopDomain: "synthetic.myshopify.com",
    updatedAt: NOW.toISOString(),
    cancelled: false,
    lines: [
      {
        id: "gid://shopify/LineItem/101",
        quantity: 2,
        currentQuantity,
        unfulfilledQuantity: currentQuantity,
      },
    ],
  };
}
function refund(
  id = "501",
  lines: unknown[] = [
    { line_item_id: "101", quantity: 1, restock_type: "no_restock" },
  ],
) {
  return {
    id,
    order_id: "1",
    note: "Synthetic refund",
    refund_line_items: lines,
    transactions: [],
  };
}

(url && disposable ? describe : describe.skip).sequential(
  "channel quantities and independent refunds in PostgreSQL",
  () => {
    let database: InventoryCutoverTestDatabase;
    beforeAll(async () => {
      database = await createInventoryCutoverTestDatabase(
        url,
        disposable,
        fixture,
      );
      await database.pool.query(
        await readFile(
          new URL(
            "../../../../../migrations/900000029000019090001_channel_merchandise_quantity_authority.sql",
            import.meta.url,
          ),
          "utf8",
        ),
      );
    });
    afterAll(async () => {
      await database?.close();
    });
    beforeEach(async () => {
      await database.pool
        .query(`TRUNCATE oms.oms_orders,oms.oms_order_lines,oms.oms_order_line_authority_events,
      oms.order_line_adjustments,wms.orders,wms.order_items,wms.outbound_shipments,wms.outbound_shipment_items;
      INSERT INTO oms.oms_orders VALUES(20,36,'1','confirmed','paid');
      INSERT INTO oms.oms_order_lines(id,order_id,external_line_item_id,quantity,channel_observed_quantity,paid_quantity,
        authority_fulfillable_quantity,authorization_status) VALUES(30,20,'101',2,2,2,2,'authorized');
      INSERT INTO wms.orders(id,source,oms_fulfillment_order_id) VALUES(10,'oms','20');
      INSERT INTO wms.order_items(id,order_id,oms_order_line_id,product_id,quantity) VALUES(40,10,30,100,2);`);
    });
    async function state() {
      return {
        lines: (
          await database.pool.query(
            "SELECT paid_quantity,channel_current_quantity,authority_fulfillable_quantity,refunded_quantity FROM oms.oms_order_lines ORDER BY id",
          )
        ).rows,
        items: (
          await database.pool.query(
            "SELECT quantity,status FROM wms.order_items ORDER BY id",
          )
        ).rows,
        orders: (
          await database.pool.query(
            "SELECT warehouse_status,on_hold FROM wms.orders ORDER BY id",
          )
        ).rows,
      };
    }
    function ports(snapshot = native()) {
      return {
        resolveOmsOrder: vi.fn(async () => ({ id: 20 })),
        readMerchandiseSnapshot: vi.fn(async () => snapshot),
        reconcileRefundOrderDemand: vi.fn<
          NonNullable<ShopifyRefundCascadeHelpers["reconcileRefundOrderDemand"]>
        >(async () => ({ releasedReservationQuantity: 1 })),
      };
    }
    const options = { channelId: 36, now: NOW };
    it("keeps a money-only refund entirely separate from quantities and warehouse cancellation", async () => {
      const before = await state();
      const helpers = ports();
      await database.pool.query(
        "UPDATE oms.oms_orders SET financial_status='refunded'",
      );
      const result = await applyShopifyRefundCascade(
        drizzle(database.pool),
        refund("501", []),
        helpers,
        options,
      );
      expect(result.outcome).toBe("financial_only");
      expect(await state()).toEqual(before);
      expect(helpers.reconcileRefundOrderDemand).not.toHaveBeenCalled();
      expect(helpers.readMerchandiseSnapshot).not.toHaveBeenCalled();
    });
  it("refuses to apply only half of a multi-partition merchandise refund", async () => {
    await database.pool.query("INSERT INTO wms.orders(id,source,oms_fulfillment_order_id) VALUES(11,'oms','20')");
    const before = await state();
    await expect(applyShopifyRefundCascade(drizzle(database.pool), refund(), ports(), options))
      .rejects.toMatchObject({ code: "CHANNEL_REFUND_PARTITIONS_REQUIRE_REVIEW" });
    expect(await state()).toEqual(before);
    expect((await database.pool.query("SELECT count(*)::int AS n FROM oms.order_line_adjustments")).rows[0].n).toBe(0);
  });
    it("does not remove still-owed channel units just because a financial refund mentions that line", async () => {
      const helpers = ports(native(2));
      await database.pool.query(
        "UPDATE oms.oms_orders SET financial_status='refunded'",
      );
      await applyShopifyRefundCascade(
        drizzle(database.pool),
        refund(),
        helpers,
        options,
      );
      expect((await state()).items).toEqual([
        { quantity: 2, status: "pending" },
      ]);
      expect((await state()).orders).toEqual([
        { warehouse_status: "ready", on_hold: 1 },
      ]);
      expect(helpers.reconcileRefundOrderDemand).not.toHaveBeenCalled();
      expect(
        (
          await database.pool.query(
            "SELECT merchandise_reduction_quantity FROM oms.order_line_adjustments",
          )
        ).rows,
      ).toEqual([{ merchandise_reduction_quantity: 0 }]);
    });
    it("retries the saved unconsumed demand reduction while preserving a shortage record's historical quantity", async () => {
      await database.pool.query("UPDATE wms.order_items SET status='short' WHERE id=40");
      const helpers = ports();
      helpers.reconcileRefundOrderDemand.mockRejectedValueOnce(new Error("Synthetic interrupted inventory reconciliation"));
      await expect(applyShopifyRefundCascade(drizzle(database.pool), refund(), helpers, options))
        .rejects.toThrow("Synthetic interrupted inventory reconciliation");
      expect((await state()).items).toEqual([{ quantity: 2, status: "short" }]);
      expect((await database.pool.query("SELECT merchandise_reduction_quantity FROM oms.order_line_adjustments")).rows)
        .toEqual([{ merchandise_reduction_quantity: 1 }]);
      await applyShopifyRefundCascade(drizzle(database.pool), refund(), helpers, options);
      expect(helpers.reconcileRefundOrderDemand).toHaveBeenCalledTimes(2);
      for (const [input] of helpers.reconcileRefundOrderDemand.mock.calls)
        expect(input).toMatchObject({ requiredAuthority: "canonical", releaseTargets: [{ orderItemId: 40, quantity: 1 }] });
      expect((await state()).items).toEqual([{ quantity: 2, status: "short" }]);
    });

    it("serializes concurrent copies of one refund into one quantity change and one immutable demand delta", async () => {
      const helpers = ports();
      await Promise.all([
        applyShopifyRefundCascade(
          drizzle(database.pool),
          refund(),
          helpers,
          options,
        ),
        applyShopifyRefundCascade(
          drizzle(database.pool),
          refund(),
          helpers,
          options,
        ),
      ]);
      expect((await state()).items).toEqual([
        { quantity: 1, status: "pending" },
      ]);
      expect(
        (
          await database.pool.query(
            "SELECT quantity,merchandise_reduction_quantity FROM oms.order_line_adjustments",
          )
        ).rows,
      ).toEqual([{ quantity: 1, merchandise_reduction_quantity: 1 }]);
      expect(
        (
          await database.pool.query(
            "SELECT count(*)::int AS n FROM oms.oms_order_line_authority_events",
          )
        ).rows[0].n,
      ).toBe(1);
    });
    it("uses the channel reduction once and retries a failed inventory leg from the saved physical delta", async () => {
      const helpers = ports();
      helpers.reconcileRefundOrderDemand.mockRejectedValueOnce(
        new Error("Synthetic inventory outage"),
      );
      await expect(
        applyShopifyRefundCascade(
          drizzle(database.pool),
          refund(),
          helpers,
          options,
        ),
      ).rejects.toThrow("Synthetic inventory outage");
      expect((await state()).items).toEqual([
        { quantity: 1, status: "pending" },
      ]);
      await applyShopifyRefundCascade(
        drizzle(database.pool),
        refund(),
        helpers,
        options,
      );
      await applyShopifyRefundCascade(
        drizzle(database.pool),
        refund(),
        helpers,
        options,
      );
      expect((await state()).lines[0]).toMatchObject({
        channel_current_quantity: 1,
        authority_fulfillable_quantity: 1,
        refunded_quantity: 1,
      });
      expect((await state()).orders).toEqual([
        { warehouse_status: "ready", on_hold: 1 },
      ]);
      expect(
        helpers.reconcileRefundOrderDemand.mock.calls.map(
          (call) => call[0].releaseTargets,
        ),
      ).toEqual([
        [{ orderItemId: 40, quantity: 1 }],
        [{ orderItemId: 40, quantity: 1 }],
        [{ orderItemId: 40, quantity: 1 }],
      ]);
      expect(
        (
          await database.pool.query(
            "SELECT quantity,merchandise_reduction_quantity FROM oms.order_line_adjustments",
          )
        ).rows,
      ).toEqual([{ quantity: 1, merchandise_reduction_quantity: 1 }]);
    });
    it("does not subtract refunded history again from certified current paid quantity", async () => {
      await database.pool
        .query(`UPDATE oms.oms_order_lines SET quantity=3,channel_observed_quantity=3,
      paid_quantity=2,authority_fulfillable_quantity=2,refunded_quantity=1;
      INSERT INTO oms.order_line_adjustments(order_id,order_line_id,external_line_item_id,source,source_event_id,adjustment_type,restock_policy,quantity)
      VALUES(20,30,'101','shopify_webhook','501','refund','no_restock',1)`);
      const observed = native(2);
      observed.lines[0].quantity = 3;
      const helpers = ports(observed);
      await applyShopifyRefundCascade(
        drizzle(database.pool),
        refund(),
        helpers,
        options,
      );
      expect((await state()).items).toEqual([
        { quantity: 2, status: "pending" },
      ]);
      expect((await state()).lines[0].authority_fulfillable_quantity).toBe(2);
      expect(helpers.reconcileRefundOrderDemand).not.toHaveBeenCalled();
    });
    it("applies a real zero-value item removal from channel quantity, while keeping the order header separate", async () => {
      const helpers = ports(native(0));
      await applyShopifyRefundCascade(
        drizzle(database.pool),
        refund("501", [
          { line_item_id: "101", quantity: 2, restock_type: "cancel" },
        ]),
        helpers,
        options,
      );
      expect((await state()).items).toEqual([
        { quantity: 0, status: "cancelled" },
      ]);
      expect((await state()).orders).toEqual([
        { warehouse_status: "ready", on_hold: 1 },
      ]);
    });
    it("fails closed before quantity changes on incomplete or wrong-order readback", async () => {
      const before = await state();
      await expect(
        applyShopifyRefundCascade(
          drizzle(database.pool),
          refund(),
          { ...ports(), readMerchandiseSnapshot: undefined },
          options,
        ),
      ).rejects.toThrow();
      const wrong = native();
      wrong.orderId = "gid://shopify/Order/2";
      await expect(
        applyShopifyRefundCascade(
          drizzle(database.pool),
          refund(),
          ports(wrong),
          options,
        ),
      ).rejects.toThrow();
      expect(await state()).toEqual(before);
    });
  },
);
