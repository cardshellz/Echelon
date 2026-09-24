import { test, expect } from "vitest";
import { Client, Pool } from "pg";
import { readFile } from "node:fs/promises";
import {
  loadArchonSnapshot,
  createArchonOrderDelivery,
} from "../../archon-order-delivery";
import { queueHistoricalArchonOrders } from "../../archon-order-replay";
const url =
  process.env.ECHELON_TEST_DATABASE_URL ?? process.env.ARCHON_TEST_DATABASE_URL;
test(
  "durable Archon delivery: rollback, all connectors, revisions, retry, leases and permanent failures",
  { skip: !url },
  async () => {
    if (
      (process.env.ECHELON_TEST_DATABASE_DISPOSABLE ??
        process.env.ARCHON_TEST_DATABASE_DISPOSABLE) !== "true"
    )
      throw Error("Disposable fixture required");
    const parsed = new URL(url!);
    expect(["127.0.0.1", "localhost"]).toContain(parsed.hostname);
    expect(parsed.pathname).toMatch(
      /^\/(?:archon_segments_test(?:_[a-z0-9_]+)?|echelon_ci_s[1-8]_[0-9a-f]{32})$/,
    );
    const name = parsed.pathname.slice(1) + "_echelon_origin";
    const admin = new Client({ connectionString: url });
    await admin.connect();
    let pool: Pool | undefined,
      owned = false;
    try {
      expect(
        (
          await admin.query("SELECT 1 FROM pg_database WHERE datname=$1", [
            name,
          ])
        ).rowCount,
      ).toBe(0);
      await admin.query('CREATE DATABASE "' + name + '"');
      owned = true;
      parsed.pathname = "/" + name;
      pool = new Pool({ connectionString: parsed.href });
      await pool.query(`CREATE SCHEMA oms;CREATE SCHEMA channels;
   CREATE TABLE channels.channels(id integer PRIMARY KEY,name text,provider text,shipping_config jsonb);
   INSERT INTO channels.channels VALUES(36,'Shopify','shopify','{}'),(37,'Ebay','ebay','{}'),(80,'Dropship OMS','manual','{"dropship":{"omsChannel":true}}');
   CREATE TABLE oms.oms_orders(id serial PRIMARY KEY,channel_id integer,external_order_id text,external_order_number text,customer_email text,customer_name text,customer_phone text,external_customer_id text,raw_payload jsonb,total_cents bigint DEFAULT 1200,subtotal_cents bigint DEFAULT 1000,shipping_cents bigint DEFAULT 100,tax_cents bigint DEFAULT 100,discount_cents bigint DEFAULT 0,refund_amount_cents bigint DEFAULT 0,currency text DEFAULT 'USD',financial_status text DEFAULT 'paid',fulfillment_status text DEFAULT 'unfulfilled',status text DEFAULT 'confirmed',ordered_at timestamptz DEFAULT '2026-09-14T12:00:00Z',tracking_number text,tracking_carrier text,tags text);
   CREATE TABLE oms.oms_order_lines(id serial PRIMARY KEY,order_id integer REFERENCES oms.oms_orders(id),sku text,title text,quantity integer,retail_price_cents bigint,total_discount_cents bigint,external_product_id text,fulfillment_status text,
      catalog_product_id integer, inventory_tracking boolean
    );
   INSERT INTO oms.oms_orders(channel_id,external_order_id,raw_payload) VALUES(36,'historic','{"source_name":"tiktok"}');`);
      const migration = await readFile(
        new URL(
          "../../../../../migrations/0672_archon_order_projection.sql",
          import.meta.url,
        ),
        "utf8",
      );
      await pool.query(migration);
      await pool.query(migration);
      expect(
        (await pool.query("SELECT count(*) FROM oms.archon_order_outbox"))
          .rows[0].count,
      ).toBe("0");
      const tx = await pool.connect();
      await tx.query("BEGIN");
      await tx.query(
        "INSERT INTO oms.oms_orders(channel_id,external_order_id) VALUES(37,'rollback')",
      );
      await tx.query("ROLLBACK");
      tx.release();
      expect(
        (await pool.query("SELECT count(*) FROM oms.archon_order_outbox"))
          .rows[0].count,
      ).toBe("0");
      await pool.query(
        `INSERT INTO oms.oms_orders(channel_id,external_order_id,raw_payload) VALUES(36,'shopify-1','{"source_name":"tiktok"}'),(37,'ebay-1','{}'),(80,'dropship:1:one','{"dropship":{"vendorId":1}}')`,
      );
      await pool.query(
        "UPDATE oms.oms_orders SET raw_payload=raw_payload || $1::jsonb WHERE external_order_id='shopify-1'",
        [
          JSON.stringify({
            currency: "USD",
            line_items: [
              {
                price: "10.00",
                quantity: 1,
                discount_allocations: [
                  { amount: "1.00", discount_application_index: 0 },
                ],
              },
            ],
            discount_applications: [
              {
                type: "discount_code",
                code: "WELCOME",
                target_type: "line_item",
              },
            ],
            shipping_lines: [],
          }),
        ],
      );
      const payloads: any[] = [],
        errors: string[] = [];
      let duringSend: (() => Promise<void>) | undefined;
      let lease = 0,
        now = new Date("2027-01-01T00:00:00Z"),
        fail = false;
      const tick = createArchonOrderDelivery({
        pool,
        clock: () => now,
        leaseId: () => String(++lease),
        log: (code) => errors.push(code),
        send: async (payload) => {
          if (fail) throw Error("ARCHON_HTTP_REJECTED");
          payloads.push(payload);
          if (duringSend) {
            const update = duringSend;
            duringSend = undefined;
            await update();
          }
        },
      });
      await Promise.all([tick(), tick()]);
      expect(payloads).toHaveLength(3);
      expect(
        payloads.find((p) => p.order.commerce_origin.connector === "shopify")
          .order.discount_evidence,
      ).toMatchObject({
        status: "complete",
        grossMerchandiseCents: 1000,
        merchandiseDiscountCents: 100,
        shippingDiscountCents: 0,
        applications: [{ code: "WELCOME", amountCents: 100 }],
      });
      expect(
        payloads.find((p) => p.order.commerce_origin.connector === "ebay").order
          .discount_evidence,
      ).toBeUndefined();
      expect(
        new Set(payloads.map((p) => p.order.commerce_origin.connector)),
      ).toEqual(new Set(["shopify", "ebay", "dropship"]));
      expect(
        payloads.find((p) => p.order.commerce_origin.connector === "shopify")
          .order.commerce_origin.salesChannel,
      ).toBe("tiktok_shop");
      expect(
        payloads.find((p) => p.order.commerce_origin.connector === "dropship")
          .order.customer_email,
      ).toBe(null);
      expect(
        (
          await pool.query(
            "SELECT count(*) FROM oms.archon_order_outbox WHERE revision>delivered_revision",
          )
        ).rows[0].count,
      ).toBe("0");
      const id = payloads[0].order.echelon_order_id;
      await pool.query(
        "UPDATE oms.oms_orders SET total_cents=1300 WHERE id=$1",
        [id],
      );
      fail = true;
      await tick();
      expect(errors).toContain("ARCHON_HTTP_REJECTED");
      expect(
        (
          await pool.query(
            "SELECT count(*) FROM oms.archon_order_outbox WHERE revision>delivered_revision",
          )
        ).rows[0].count,
      ).toBe("1");
      fail = false;
      now = new Date(now.getTime() + 600000);
      await tick();
      expect(payloads.at(-1).order.total_cents).toBe(1300);
      duringSend = async () => {
        await pool!.query(
          "UPDATE oms.oms_orders SET total_cents=1500 WHERE id=$1",
          [id],
        );
      };
      await pool.query(
        "UPDATE oms.oms_orders SET total_cents=1400 WHERE id=$1",
        [id],
      );
      await tick();
      expect(payloads.at(-1).order.total_cents).toBe(1500);
      expect(
        (
          await pool.query(
            "SELECT count(*) FROM oms.archon_order_outbox WHERE revision>delivered_revision",
          )
        ).rows[0].count,
      ).toBe("0");
      duringSend = async () => {
        await pool!.query(
          "UPDATE oms.oms_orders SET total_cents=1700 WHERE id=$1",
          [id],
        );
        throw new Error("ARCHON_SNAPSHOT_INVALID");
      };
      await pool.query(
        "UPDATE oms.oms_orders SET total_cents=1600 WHERE id=$1",
        [id],
      );
      await tick();
      expect(payloads.at(-1).order.total_cents).toBe(1700);
      expect(
        (
          await pool.query(
            "SELECT count(*) FROM oms.archon_order_outbox WHERE revision>delivered_revision",
          )
        ).rows[0].count,
      ).toBe("0");
      await pool.query("UPDATE oms.oms_orders SET channel_id=999 WHERE id=$1", [
        id,
      ]);
      await tick();
      expect(errors).toContain("OMS_CHANNEL_MISSING");
      expect(
        (
          await pool.query(
            "SELECT next_attempt_at::text FROM oms.archon_order_outbox WHERE order_id=$1",
            [id],
          )
        ).rows[0].next_attempt_at,
      ).toBe("infinity");
      const beforeReplay = (
        await pool.query(
          "SELECT * FROM oms.archon_order_outbox ORDER BY order_id",
        )
      ).rows;
      const replayRange = {
        from: "2026-09-14",
        to: "2026-09-15",
        apply: false,
      };
      expect(
        (await queueHistoricalArchonOrders(pool, replayRange)).orders,
      ).toBe("4");
      expect(
        (
          await pool.query(
            "SELECT * FROM oms.archon_order_outbox ORDER BY order_id",
          )
        ).rows,
      ).toEqual(beforeReplay);
      expect(
        (
          await queueHistoricalArchonOrders(pool, {
            ...replayRange,
            from: "2026-09-15",
            to: "2026-09-16",
          })
        ).orders,
      ).toBe("0");
      await expect(
        queueHistoricalArchonOrders(pool, {
          ...replayRange,
          to: replayRange.from,
        }),
      ).rejects.toThrow("INVALID_REPLAY_RANGE");
      const beforeOrders = (
        await pool.query("SELECT * FROM oms.oms_orders ORDER BY id")
      ).rows;
      await queueHistoricalArchonOrders(pool, { ...replayRange, apply: true });
      await queueHistoricalArchonOrders(pool, { ...replayRange, apply: true });
      expect(
        (
          await pool.query(
            "SELECT count(*) FROM oms.archon_order_outbox WHERE revision>delivered_revision",
          )
        ).rows[0].count,
      ).toBe("4");
      expect(
        (await pool.query("SELECT * FROM oms.oms_orders ORDER BY id")).rows,
      ).toEqual(beforeOrders);
      const providerRaw = {
        id: 101,
        source_name: "web",
        currency: "USD",
        updated_at: "2026-09-23T14:00:00Z",
        taxes_included: false,
        subtotal_price: "30.43",
        total_price: "41.42",
        total_tax: "0.00",
        original_total_duties_set: null,
        original_total_additional_fees_set: null,
        total_tip_received: "0.00",
        line_items: [{ price: "30.43", quantity: 1, discount_allocations: [] }],
        shipping_lines: [
          {
            price: "10.99",
            discounted_price: "10.99",
            discount_allocations: [],
          },
        ],
        discount_applications: [],
      };
      const inserted = await pool.query(
        "INSERT INTO oms.oms_orders(channel_id,external_order_id,total_cents,subtotal_cents,raw_payload) VALUES(36,'101',3742,2643,$1) RETURNING id",
        [JSON.stringify(providerRaw)],
      );
      const correctedId = inserted.rows[0].id;
      const reader = await pool.connect();
      let corrected;
      try {
        await reader.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
        corrected = await loadArchonSnapshot(reader, correctedId, "1");
        await reader.query("COMMIT");
      } finally {
        reader.release();
      }
      expect(corrected.order.total_cents).toBe(4142);
      expect(corrected.order.subtotal_cents).toBe(3043);
      expect(corrected.order.line_items).toMatchObject([
        { quantity: 1, price_cents: 3043, discount_cents: 0 },
      ]);
      expect(
        corrected.order.discount_evidence?.financials?.orderTotalCents,
      ).toBe(4142);
      expect(
        (
          await pool.query(
            "SELECT total_cents FROM oms.oms_orders WHERE id=$1",
            [correctedId],
          )
        ).rows[0].total_cents,
      ).toBe("3742");
    } finally {
      await pool?.end();
      if (owned) await admin.query('DROP DATABASE "' + name + '"');
      await admin.end();
    }
  },
);
