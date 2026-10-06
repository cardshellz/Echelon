import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { OrderEditPaidProjection } from "../../order-edit-paid-projection";
import {
  createInventoryCutoverTestDatabase,
  type InventoryCutoverTestDatabase,
} from "../../../inventory/__tests__/fixtures/inventory-cutover-database";
import type {
  OrderEditSnapshot,
  OrderEditQuote,
} from "../../../order-edits/application/order-edit-provider";

const url = process.env.ECHELON_TEST_DATABASE_URL;
const disposable = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
const OP = "00000000-0000-4000-8000-000000000001";
const NOW = new Date("2026-10-05T23:00:00.000Z");
// Named-schema query fixture: proves transaction/locking behavior, not migration coverage.
const fixture = `CREATE SCHEMA oms; CREATE SCHEMA wms; CREATE SCHEMA channels;
CREATE TABLE oms.oms_orders(id bigint PRIMARY KEY,channel_id int,external_order_id text,currency text,cancelled_at timestamptz,
 status text,financial_status text,subtotal_cents bigint,gross_subtotal_cents bigint,shipping_cents bigint,tax_cents bigint,discount_cents bigint,total_cents bigint,updated_at timestamptz);
CREATE TABLE wms.orders(id int PRIMARY KEY,channel_id int,source text,oms_fulfillment_order_id text,source_table_id text,
 order_edit_operation_id uuid,started_at timestamptz,assigned_picker_id text,picked_count int);
CREATE TABLE oms.order_edit_operations(id uuid PRIMARY KEY,oms_order_id bigint,connection_id int,status text,document jsonb);
CREATE TABLE oms.oms_order_lines(id bigint PRIMARY KEY,order_id bigint,external_line_item_id text,product_variant_id int,quantity int,
 channel_observed_quantity int,paid_quantity int,authority_fulfillable_quantity int,cancelled_quantity int,refunded_quantity int,
 authorization_status text,authorized_by_event_id text,paid_price_cents bigint,retail_price_cents bigint,total_price_cents bigint,total_discount_cents bigint,
 plan_discount_cents bigint DEFAULT 0,coupon_discount_cents bigint DEFAULT 0,
 fulfillable_quantity int,authority_source_topic text,authority_source_inbox_id int,authorized_at timestamptz,updated_at timestamptz);
CREATE TABLE channels.channel_listings(channel_id int,external_variant_id text,product_variant_id int);
CREATE TABLE oms.order_edit_paid_projections(oms_order_id bigint PRIMARY KEY,operation_id uuid,source_updated_at timestamptz,fingerprint text,snapshot jsonb,projected_at timestamptz);
CREATE TABLE oms.oms_order_events(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,order_id bigint,event_type text,details jsonb,created_at timestamptz);
CREATE TABLE oms.order_edit_events(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,operation_id uuid,connection_id int,
 actor_id text,action text,before_state jsonb,after_state jsonb,occurred_at timestamptz);
CREATE TABLE oms.oms_order_line_authority_events(event_key text UNIQUE,event_type text,order_id bigint,order_line_id bigint,source_topic text,
 source_event_id text,source_inbox_id int,previous_channel_observed_quantity int,previous_paid_quantity int,previous_authority_fulfillable_quantity int,
 previous_authorization_status text,channel_observed_quantity int,paid_quantity int,authority_fulfillable_quantity int,cancelled_quantity int,
 refunded_quantity int,authorization_status text,authorized_at timestamptz,authorized_by_event_id text,created_at timestamptz);`;
function snapshot(quantity = 1): OrderEditSnapshot {
  return {
    connectionId: 4,
    channelId: 36,
    orderId: "gid://shopify/Order/1",
    name: "#1",
    customerId: null,
    currency: "USD",
    updatedAt: NOW.toISOString(),
    editable: true,
    editableErrors: [],
    cancelled: false,
    closed: false,
    fullyPaid: true,
    totalCents: quantity * 1000,
    outstandingCents: 0,
    subtotalCents: quantity * 1000,
    taxCents: 0,
    netPaidCents: quantity * 1000,
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
        quantity,
        unfulfilledQuantity: quantity,
        originalUnitPriceCents: 1000,
        discountedUnitPriceCents: 1000,
        totalCents: quantity * 1000,
        discountFingerprint: "a".repeat(64),
        unsupported: false,
      },
    ],
    transactions: [],
    refunds: [],
    contentFingerprint: "b".repeat(64),
    fingerprint: (quantity === 1 ? "c" : "d").repeat(64),
    evidence: {
      countryCode: "US",
      shippingAddressFingerprint: "e".repeat(64),
      discountApplications: [],
      unsupportedPaymentTerms: false,
    },
  };
}
function document(
  target: OrderEditSnapshot,
  baseline = snapshot(2),
  recovery = false,
) {
  const quote: OrderEditQuote = {
    connectionId: 4,
    channelId: 36,
    orderId: target.orderId,
    operationId: OP,
    calculatedOrderId: "gid://shopify/CalculatedOrder/1",
    sessionId: "gid://shopify/OrderEditSession/1",
    baselineFingerprint: baseline.fingerprint,
    baseline,
    plan: {
      changes: [
        {
          lineItemId: baseline.lines[0].id,
          quantity: target.lines[0].quantity,
        },
      ],
      additions: target.lines
        .slice(1)
        .map((line) => ({
          variantId: line.variantId,
          quantity: line.quantity,
        })),
    },
    lines: target.lines.map((line, index) => ({
      originalLineId: index === 0 ? line.id : null,
      calculatedLineId: `gid://shopify/CalculatedLineItem/${index + 1}`,
      variantId: line.variantId,
      title: line.title,
      variantTitle: line.variantTitle,
      quantity: line.quantity,
      originalUnitPriceCents: line.originalUnitPriceCents,
      discountedUnitPriceCents: line.discountedUnitPriceCents,
      totalCents: line.totalCents,
    })),
    totalCents: target.totalCents,
    outstandingCents: target.totalCents - baseline.netPaidCents,
    deltaCents: target.totalCents - baseline.totalCents,
    shippingCents: 0,
    createdAt: NOW.toISOString(),
    evidence: {},
  };
  return {
    id: OP,
    omsOrderId: 20,
    connectionId: 4,
    actorId: "staff",
    status: recovery ? "recovering" : "synchronizing",
    commitStartedAt: NOW.toISOString(),
    recoveryStartedAt: recovery ? NOW.toISOString() : null,
    baseline,
    quote,
    lastSnapshot: target,
  };
}

(url && disposable ? describe : describe.skip).sequential(
  "paid-current order edit OMS projection in PostgreSQL",
  () => {
    let database: InventoryCutoverTestDatabase;
    let projector: OrderEditPaidProjection;
    beforeAll(async () => {
      database = await createInventoryCutoverTestDatabase(
        url,
        disposable,
        fixture,
      );
      projector = new OrderEditPaidProjection(database.pool, () => NOW);
    }, 30000);
    afterAll(async () => {
      await database?.close();
    });
    beforeEach(async () => {
      await database.pool.query(
        "TRUNCATE oms.oms_orders,wms.orders,oms.order_edit_operations,oms.oms_order_lines,channels.channel_listings,oms.order_edit_paid_projections,oms.oms_order_events,oms.oms_order_line_authority_events,oms.order_edit_events",
      );
      await database.pool
        .query(`INSERT INTO oms.oms_orders VALUES(20,36,'1','USD',NULL,'open','paid',2000,2000,0,0,0,2000,NULL);
      INSERT INTO wms.orders VALUES(10,36,'oms','20',NULL,'${OP}',NULL,NULL,0);
      INSERT INTO oms.oms_order_lines(id,order_id,external_line_item_id,product_variant_id,quantity,channel_observed_quantity,paid_quantity,
        authority_fulfillable_quantity,cancelled_quantity,refunded_quantity,authorization_status,paid_price_cents,retail_price_cents,total_price_cents,total_discount_cents,fulfillable_quantity)
      VALUES(30,20,'101',100,2,2,2,2,0,0,'authorized',1000,1000,2000,0,2);
      INSERT INTO channels.channel_listings VALUES(36,'100',100);`);
      await save(document(snapshot()));
    });
    async function save(value: ReturnType<typeof document>) {
      await database.pool.query(
        `INSERT INTO oms.order_edit_operations VALUES($1,20,4,$2,$3) ON CONFLICT(id) DO UPDATE SET status=EXCLUDED.status,document=EXCLUDED.document`,
        [OP, value.status, JSON.stringify(value)],
      );
    }
    it("preserves purchased quantity while reducing current paid authority and totals, with idempotent immutable audit", async () => {
      await projector.project(20, OP, snapshot());
      await projector.project(20, OP, snapshot());
      expect(
        (
          await database.pool.query(
            "SELECT quantity,paid_quantity,authority_fulfillable_quantity,total_price_cents,authority_source_topic FROM oms.oms_order_lines",
          )
        ).rows[0],
      ).toEqual({
        quantity: 2,
        paid_quantity: 1,
        authority_fulfillable_quantity: 1,
        total_price_cents: "1000",
        authority_source_topic: "order-edit/paid",
      });
      expect(
        (await database.pool.query("SELECT total_cents FROM oms.oms_orders"))
          .rows[0].total_cents,
      ).toBe("1000");
      expect(
        (
          await database.pool.query(
            "SELECT count(*)::int AS count FROM oms.oms_order_events",
          )
        ).rows[0].count,
      ).toBe(1);
      expect(
        (
          await database.pool.query(
            "SELECT count(*)::int AS count FROM oms.oms_order_line_authority_events",
          )
        ).rows[0].count,
      ).toBe(1);
      const immutable = (
        await database.pool.query(
          "SELECT operation_id,connection_id,actor_id,action,before_state,after_state FROM oms.order_edit_events",
        )
      ).rows;
      expect(immutable).toHaveLength(1);
      expect(immutable[0]).toMatchObject({
        operation_id: OP,
        connection_id: 4,
        actor_id: "staff",
        action: "paid_current_projected",
        before_state: {
          header: { total_cents: 2000 },
          lines: [{ quantity: 2, paid_quantity: 2 }],
        },
        after_state: {
          header: { total_cents: "1000" },
          lines: [{ quantity: 2, paid_quantity: 1 }],
          snapshot: { fingerprint: snapshot().fingerprint },
        },
      });
    });
    it("authorizes an equal-price replacement without fabricating an orders/paid webhook", async () => {
      const target = snapshot();
      target.lines[0] = {
        ...target.lines[0],
        quantity: 0,
        unfulfilledQuantity: 0,
        totalCents: 0,
      };
      target.lines.push({
        ...snapshot().lines[0],
        id: "gid://shopify/LineItem/102",
        variantId: "gid://shopify/ProductVariant/200",
      });
      await database.pool
        .query(`INSERT INTO channels.channel_listings VALUES(36,'200',200);
      INSERT INTO oms.oms_order_lines(id,order_id,external_line_item_id,product_variant_id,quantity,channel_observed_quantity,paid_quantity,
        authority_fulfillable_quantity,cancelled_quantity,refunded_quantity,authorization_status,paid_price_cents,retail_price_cents,total_price_cents,total_discount_cents,fulfillable_quantity)
      VALUES(31,20,'102',200,1,1,0,0,0,0,'seen',1000,1000,1000,0,1);`);
      await save(document(target, snapshot()));
      await projector.project(20, OP, target);
      expect(
        (
          await database.pool.query(
            "SELECT quantity,paid_quantity,authority_fulfillable_quantity FROM oms.oms_order_lines ORDER BY id",
          )
        ).rows,
      ).toEqual([
        { quantity: 2, paid_quantity: 0, authority_fulfillable_quantity: 0 },
        { quantity: 1, paid_quantity: 1, authority_fulfillable_quantity: 1 },
      ]);
    });
    it("compares nested evidence structurally after PostgreSQL JSONB reorders object keys", async () => {
      const target = snapshot();
      target.evidence.discountApplications = [
        { z: 1, a: { second: 2, first: 1 } },
      ];
      await save(document(target));
      await expect(projector.project(20, OP, target)).resolves.toBeUndefined();
    });
    it("retains a historical zero line whose product no longer has a catalog mapping", async () => {
      const target = snapshot();
      const retired = {
        ...target.lines[0],
        id: "gid://shopify/LineItem/102",
        variantId: "",
        quantity: 0,
        unfulfilledQuantity: 0,
        totalCents: 0,
        unsupported: true,
      };
      target.lines.push(retired);
      const baseline = snapshot(2);
      baseline.lines.push(retired);
      const saved = document(snapshot(), baseline);
      saved.lastSnapshot = target;
      await save(saved);
      await database.pool
        .query(`INSERT INTO oms.oms_order_lines(id,order_id,external_line_item_id,product_variant_id,quantity,channel_observed_quantity,paid_quantity,
      authority_fulfillable_quantity,cancelled_quantity,refunded_quantity,authorization_status,paid_price_cents,retail_price_cents,total_price_cents,total_discount_cents,fulfillable_quantity)
      VALUES(31,20,'102',NULL,1,0,0,0,0,0,'authorized',1000,1000,0,0,0)`);
      await expect(projector.project(20, OP, target)).resolves.toBeUndefined();
      expect(
        (
          await database.pool.query(
            "SELECT quantity,authority_fulfillable_quantity FROM oms.oms_order_lines WHERE id=31",
          )
        ).rows[0],
      ).toEqual({ quantity: 1, authority_fulfillable_quantity: 0 });
    });
    it("keeps original automatic discounts in the existing coupon category at their current amount", async () => {
      const target = snapshot();
      target.lines[0].discountedUnitPriceCents = 800;
      target.lines[0].totalCents = 800;
      target.subtotalCents = 800;
      target.totalCents = 800;
      target.netPaidCents = 800;
      target.discountsPresent = true;
      const baseline = snapshot(2);
      baseline.lines[0].discountedUnitPriceCents = 800;
      baseline.lines[0].totalCents = 1600;
      baseline.subtotalCents = 1600;
      baseline.totalCents = 1600;
      baseline.netPaidCents = 1600;
      baseline.discountsPresent = true;
      await save(document(target, baseline));
      await database.pool.query(
        "UPDATE oms.oms_order_lines SET paid_price_cents=800,total_price_cents=1600,total_discount_cents=400,coupon_discount_cents=400",
      );
      await projector.project(20, OP, target);
      expect(
        (
          await database.pool.query(
            "SELECT total_discount_cents,plan_discount_cents,coupon_discount_cents FROM oms.oms_order_lines",
          )
        ).rows[0],
      ).toEqual({
        total_discount_cents: "200",
        plan_discount_cents: "0",
        coupon_discount_cents: "200",
      });
    });
    it("restores the original paid quantities after verified unpaid expiry", async () => {
      const target = snapshot(2);
      await save(document(target, target, true));
      await database.pool.query(
        "UPDATE oms.oms_order_lines SET quantity=3,paid_quantity=3,authority_fulfillable_quantity=3",
      );
      await projector.project(20, OP, target);
      expect(
        (
          await database.pool.query(
            "SELECT quantity,paid_quantity,authority_fulfillable_quantity FROM oms.oms_order_lines",
          )
        ).rows[0],
      ).toEqual({
        quantity: 3,
        paid_quantity: 2,
        authority_fulfillable_quantity: 2,
      });
    });
    it.each(["hold", "catalog", "disposition", "phase", "snapshot"])(
      "rejects unproven %s without partially changing finances",
      async (kind) => {
        if (kind === "hold")
          await database.pool.query(
            "UPDATE wms.orders SET order_edit_operation_id=NULL",
          );
        if (kind === "catalog")
          await database.pool.query(
            "UPDATE channels.channel_listings SET product_variant_id=999",
          );
        if (kind === "disposition")
          await database.pool.query(
            "UPDATE oms.oms_order_lines SET refunded_quantity=1",
          );
        if (kind === "phase")
          await database.pool.query(
            "UPDATE oms.order_edit_operations SET status='review_required'",
          );
        const target = snapshot();
        if (kind === "snapshot") target.fingerprint = "f".repeat(64);
        await expect(projector.project(20, OP, target)).rejects.toThrow();
        expect(
          (await database.pool.query("SELECT total_cents FROM oms.oms_orders"))
            .rows[0].total_cents,
        ).toBe("2000");
        expect(
          (
            await database.pool.query(
              "SELECT paid_quantity FROM oms.oms_order_lines",
            )
          ).rows[0].paid_quantity,
        ).toBe(2);
        expect(
          (
            await database.pool.query(
              "SELECT count(*)::int AS count FROM oms.oms_order_events",
            )
          ).rows[0].count,
        ).toBe(0);
      },
    );
    it("rolls every quantity back if recording the canonical authority audit fails", async () => {
      await database.pool.query(
        "ALTER TABLE oms.oms_order_line_authority_events ADD CONSTRAINT fail_audit CHECK(source_topic <> 'order-edit/paid')",
      );
      try {
        await expect(projector.project(20, OP, snapshot())).rejects.toThrow();
      } finally {
        await database.pool.query(
          "ALTER TABLE oms.oms_order_line_authority_events DROP CONSTRAINT fail_audit",
        );
      }
      expect(
        (
          await database.pool.query(
            "SELECT paid_quantity FROM oms.oms_order_lines",
          )
        ).rows[0].paid_quantity,
      ).toBe(2);
      expect(
        (
          await database.pool.query(
            "SELECT count(*)::int AS count FROM oms.order_edit_paid_projections",
          )
        ).rows[0].count,
      ).toBe(0);
    });
    it("rejects a stale provider revision", async () => {
      await database.pool.query(
        "INSERT INTO oms.order_edit_paid_projections VALUES(20,$1,$2,$3,$4,$2)",
        [
          OP,
          new Date(NOW.getTime() + 1000),
          "f".repeat(64),
          JSON.stringify(snapshot()),
        ],
      );
      await expect(projector.project(20, OP, snapshot())).rejects.toMatchObject(
        { code: "ORDER_EDIT_PROJECTION_STALE" },
      );
    });
    it("rolls prices, quantities, and all auxiliary audits back when the immutable edit audit fails", async () => {
      await database.pool.query(
        "ALTER TABLE oms.order_edit_events ADD CONSTRAINT fail_immutable_audit CHECK(action <> 'paid_current_projected')",
      );
      try {
        await expect(projector.project(20, OP, snapshot())).rejects.toThrow();
      } finally {
        await database.pool.query(
          "ALTER TABLE oms.order_edit_events DROP CONSTRAINT fail_immutable_audit",
        );
      }
      expect(
        (await database.pool.query("SELECT total_cents FROM oms.oms_orders"))
          .rows[0].total_cents,
      ).toBe("2000");
      expect(
        (
          await database.pool.query(
            "SELECT paid_quantity,total_price_cents FROM oms.oms_order_lines",
          )
        ).rows[0],
      ).toEqual({ paid_quantity: 2, total_price_cents: "2000" });
      expect(
        (
          await database.pool.query(
            "SELECT count(*)::int AS count FROM oms.oms_order_line_authority_events",
          )
        ).rows[0].count,
      ).toBe(0);
      expect(
        (
          await database.pool.query(
            "SELECT count(*)::int AS count FROM oms.oms_order_events",
          )
        ).rows[0].count,
      ).toBe(0);
      expect(
        (
          await database.pool.query(
            "SELECT count(*)::int AS count FROM oms.order_edit_paid_projections",
          )
        ).rows[0].count,
      ).toBe(0);
    });
    it("accepts a same-second successor only when its immutable baseline is the prior projection", async () => {
      const first = snapshot();
      await projector.project(20, OP, first);
      const nextId = "00000000-0000-4000-8000-000000000002";
      const next = snapshot(2);
      const saved = document(next, first);
      saved.id = nextId;
      saved.quote.operationId = nextId;
      await database.pool.query(
        "INSERT INTO oms.order_edit_operations VALUES($1,20,4,$2,$3)",
        [nextId, saved.status, JSON.stringify(saved)],
      );
      await database.pool.query(
        "UPDATE wms.orders SET order_edit_operation_id=$1",
        [nextId],
      );
      await projector.project(20, nextId, next);
      expect(
        (
          await database.pool.query(
            "SELECT operation_id,fingerprint FROM oms.order_edit_paid_projections",
          )
        ).rows[0],
      ).toEqual({ operation_id: nextId, fingerprint: next.fingerprint });
      expect(
        (
          await database.pool.query(
            "SELECT count(*)::int AS count FROM oms.oms_order_events",
          )
        ).rows[0].count,
      ).toBe(2);
    });
    it("waits for the owning OMS lock and observes a concurrent hold change", async () => {
      const other = await database.pool.connect();
      try {
        await other.query("BEGIN");
        await other.query(
          "SELECT id FROM oms.oms_orders WHERE id=20 FOR UPDATE",
        );
        await other.query("UPDATE wms.orders SET order_edit_operation_id=NULL");
        const pending = projector.project(20, OP, snapshot());
        const failed = expect(pending).rejects.toMatchObject({
          code: "ORDER_EDIT_HOLD_MISSING",
        });
        const pid = (await other.query("SELECT pg_backend_pid() AS pid"))
          .rows[0].pid;
        await vi.waitFor(async () => {
          expect(
            (
              await database.pool.query(
                "SELECT count(*)::int AS count FROM pg_stat_activity WHERE $1::int=ANY(pg_blocking_pids(pid))",
                [pid],
              )
            ).rows[0].count,
          ).toBeGreaterThan(0);
        });
        await other.query("COMMIT");
        await failed;
      } finally {
        await other.query("ROLLBACK");
        other.release();
      }
    });
  },
);
