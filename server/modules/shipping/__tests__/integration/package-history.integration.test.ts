import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { Pool } from "pg";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { resolveReturnsTestDatabase } from "../../../returns/__tests__/support/disposable-database";
import {
  liveLocalFixture,
  liveShopifyFixture,
  LIVE_NOW,
  liveGid,
} from "../../../returns/__tests__/support/live-inspection-fixtures";
import { labelActivePolicy } from "../../../returns/__tests__/support/label-fixtures";
import { CustomerReturnLiveService } from "../../../returns/application/customer-return-live.service";
import {
  createPackageHistorySource,
  createPackageHistoryShipStationRequester,
} from "../../package-history.source";
import { PostgresPackageHistoryStore } from "../../package-history.repository";
import { PackageHistoryBackfillRepository } from "../../package-history-backfill.repository";
import { PackageHistoryWorker } from "../../package-history.worker";
import { buildPackageHistory } from "../../package-history.domain";

const url = resolveReturnsTestDatabase(process.env, "inspection");
const integration = url ? describe.sequential : describe.skip;
const migration =
  "migrations/900000036000019300001_shipping_package_history.sql";
function priorFunction(name: string): string {
  const sql = readFileSync(
    "migrations/900000033000019220001_customer_order_action_projection.sql",
    "utf8",
  ).replace(/\r\n/g, "\n");
  const start = sql.indexOf(`CREATE FUNCTION oms.${name}(`),
    end = sql.indexOf("\n$$;", start);
  if (start < 0 || end < 0)
    throw new Error("Missing real source identity helper");
  return sql.slice(start, end + 4);
}
integration("historical package capture and resumable backfill", () => {
  let pool: Pool,
    store: PostgresPackageHistoryStore,
    backfill: PackageHistoryBackfillRepository;
  let now: Date,
    native: ReturnType<typeof liveShopifyFixture>,
    requests: string[],
    fault: "none" | "rate" | "ambiguous",
    sequence: number;
  const rawShipment = (tracking = "TRACK601") => ({
    shipmentId: tracking === "TRACK602" ? 602 : 601,
    orderId: 99,
    orderKey: "1001-2001",
    orderNumber: "12",
    trackingNumber: tracking,
    isReturnLabel: false,
    voided: false,
    voidDate: null,
    dimensions: {
      units: "inches",
      length: tracking === "TRACK602" ? 12 : 10,
      width: 8,
      height: 4,
    },
    shipmentItems: [{ lineItemKey: "501", sku: "PRODUCT", quantity: 1 }],
  });
  const nativeReader = { read: vi.fn(async () => structuredClone(native)) };
  const providerRequest = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.method).toBe("GET");
      const query = new URL(String(input));
      requests.push(query.pathname);
      if (fault === "rate") {
        fault = "none";
        return new Response("private error body", { status: 429 });
      }
      const tracking = query.searchParams.get("trackingNumber")!;
      const rows = [rawShipment(tracking)];
      if (fault === "ambiguous") rows.push({ ...rows[0], shipmentId: 999 });
      return new Response(
        JSON.stringify({
          shipments: rows,
          page: 1,
          pages: 1,
          total: rows.length,
        }),
        { status: 200 },
      );
    },
  );
  const makeSource = () =>
    createPackageHistorySource({
      pool,
      shopify: nativeReader,
      now: () => now,
      shipstation: createPackageHistoryShipStationRequester({
        apiKey: "fixture-key",
        apiSecret: "fixture-secret",
        request: providerRequest as typeof fetch,
      }),
    });
  const makeWorker = () =>
    new PackageHistoryWorker({
      source: makeSource(),
      store,
      now: () => now,
      newId: () =>
        `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`,
      report: vi.fn(),
    });
  const guard = async (enabled: boolean) => {
    await pool.query("UPDATE test_guard.control SET protected=$1", [enabled]);
  };
  const fingerprint = async () =>
    createHash("sha256")
      .update(
        (
          await pool.query(`SELECT jsonb_build_object(
    'oms',(SELECT jsonb_agg(to_jsonb(o) ORDER BY id) FROM oms.oms_orders o),
    'lines',(SELECT jsonb_agg(to_jsonb(l) ORDER BY id) FROM oms.oms_order_lines l),
    'warehouse',(SELECT jsonb_agg(to_jsonb(w) ORDER BY id) FROM wms.orders w),
    'warehouseLines',(SELECT jsonb_agg(to_jsonb(wl) ORDER BY id) FROM wms.order_items wl),
    'balances',(SELECT jsonb_agg(to_jsonb(b) ORDER BY name) FROM test_guard.balances b))::text AS facts`)
        ).rows[0].facts,
      )
      .digest("hex");
  beforeAll(async () => {
    pool = new Pool({
      connectionString: url!,
      max: 5,
      statement_timeout: 10_000,
    });
    await pool.query(`DROP SCHEMA IF EXISTS test_guard CASCADE; DROP SCHEMA IF EXISTS wms CASCADE; DROP SCHEMA IF EXISTS oms CASCADE; DROP SCHEMA IF EXISTS channels CASCADE;
      CREATE SCHEMA test_guard; CREATE SCHEMA channels; CREATE SCHEMA oms; CREATE SCHEMA wms;
      CREATE TABLE channels.channels(id int PRIMARY KEY,provider text,type text,status text,name text);
      CREATE TABLE channels.channel_connections(id int PRIMARY KEY,channel_id int REFERENCES channels.channels(id),shop_domain text,access_token text,api_version text);
      CREATE TABLE oms.oms_orders(id bigint PRIMARY KEY,channel_id int REFERENCES channels.channels(id),external_order_id text,external_customer_id text,external_order_number text,raw_payload jsonb DEFAULT '{}',updated_at timestamptz);
      CREATE TABLE oms.oms_order_lines(id bigint PRIMARY KEY,order_id bigint REFERENCES oms.oms_orders(id),external_line_item_id text,sku text,quantity int,requires_shipping boolean);
      CREATE TABLE wms.orders(id int PRIMARY KEY,channel_id int,source text,source_table_id text,oms_fulfillment_order_id text,external_order_id text,warehouse_status text);
      CREATE TABLE wms.order_items(id int PRIMARY KEY,order_id int REFERENCES wms.orders(id),oms_order_line_id bigint,shopify_line_item_id text,sku text,quantity int,fulfilled_quantity int);
      CREATE TABLE wms.outbound_shipments(id int PRIMARY KEY,order_id int REFERENCES wms.orders(id),shipstation_order_id int);
      CREATE TABLE wms.outbound_shipment_items(id int PRIMARY KEY,shipment_id int,order_item_id int,shipment_item_purpose text,replacement_for_order_item_id int,correction_for_shipment_item_id int);
      CREATE TABLE wms.physical_shipments(id bigint PRIMARY KEY);
      CREATE TABLE wms.fulfillment_plan_lines(id bigint PRIMARY KEY,oms_order_line_id bigint);
      CREATE TABLE wms.physical_shipment_items(id bigint PRIMARY KEY,physical_shipment_id bigint,wms_order_item_id int,fulfillment_plan_line_id bigint);
      CREATE TABLE wms.shipping_provider_labels(id bigint PRIMARY KEY,provider text,provider_label_id text,provider_order_id text,provider_order_key text,label_status text,label_direction text,tracking_number text,metadata jsonb DEFAULT '{}');
      CREATE TABLE wms.shipping_provider_label_links(id bigint PRIMARY KEY,shipping_provider_label_id bigint,physical_shipment_id bigint);
      CREATE TABLE wms.shipping_provider_label_events(id bigint PRIMARY KEY,shipping_provider_label_id bigint,sanitized_payload jsonb,received_at timestamptz);
      CREATE TABLE oms.customer_order_action_invalidations(id bigint GENERATED ALWAYS AS IDENTITY,oms_order_id bigint);
      CREATE TABLE oms.channel_fulfillment_receipts(id bigint PRIMARY KEY,oms_order_id bigint);
      CREATE TABLE test_guard.control(protected boolean NOT NULL);INSERT INTO test_guard.control VALUES(false);
      CREATE TABLE test_guard.balances(name text PRIMARY KEY,value bigint NOT NULL);
      CREATE FUNCTION test_guard.reject_source_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF (SELECT protected FROM test_guard.control) THEN RAISE EXCEPTION 'Protected source/balance write attempted'; END IF; RETURN NULL; END; $$;`);
    for (const table of [
      "oms.oms_orders",
      "oms.oms_order_lines",
      "wms.orders",
      "wms.order_items",
      "test_guard.balances",
    ])
      await pool.query(
        `CREATE TRIGGER protected_write AFTER INSERT OR UPDATE OR DELETE ON ${table} FOR EACH ROW EXECUTE FUNCTION test_guard.reject_source_write()`,
      );
    for (const name of [
      "customer_action_wms_order_id",
      "customer_action_physical_order_ids",
      "customer_action_label_order_ids",
    ])
      await pool.query(priorFunction(name));
    await pool.query(readFileSync(migration, "utf8"));
  });
  beforeEach(async () => {
    await guard(false);
    await pool.query(`TRUNCATE wms.shipping_package_history_jobs,wms.shipping_package_history_events,wms.shipping_package_history_invalidations,
      wms.shipping_package_history_backfills,wms.shipping_provider_label_events,wms.shipping_provider_label_links,wms.shipping_provider_labels,
      oms.customer_order_action_invalidations,wms.outbound_shipment_items,wms.outbound_shipments,wms.order_items,wms.orders,oms.oms_order_lines,oms.oms_orders,
      oms.channel_fulfillment_receipts,channels.channel_connections,channels.channels,test_guard.balances RESTART IDENTITY CASCADE;
      INSERT INTO channels.channels VALUES(36,'shopify','internal','active','Fixture shop');
      INSERT INTO channels.channel_connections VALUES(4,36,'fixture.myshopify.com','fixture-token','2026-07');
      INSERT INTO oms.oms_orders(id,channel_id,external_order_id,external_customer_id,external_order_number) VALUES(100,36,'1001','901','#12'),(101,36,'1002','901','#13');
      INSERT INTO oms.oms_order_lines VALUES(101,100,'501','PRODUCT',1,true),(102,100,'502','CLUB',1,false);
      INSERT INTO wms.orders VALUES(200,36,'shopify','gid://shopify/Order/1001',NULL,'gid://shopify/Order/1001','shipped');
      INSERT INTO wms.order_items VALUES(301,200,NULL,'501','PRODUCT',1,1),(302,200,NULL,'502','CLUB',1,1);
      INSERT INTO test_guard.balances VALUES('inventory-units',1000),('reward-points',1200),('payment-cents',999);
      TRUNCATE wms.shipping_package_history_invalidations;`);
    now = new Date(LIVE_NOW);
    sequence = 0;
    requests = [];
    fault = "none";
    native = liveShopifyFixture();
    native.order.name = "#12";
    native.order.customerId = liveGid("Customer", 901);
    native.lines[0] = {
      ...native.lines[0],
      sku: "PRODUCT",
      quantity: 1,
      currentQuantity: 1,
      refundableQuantity: 1,
    };
    native.lines[1] = {
      ...native.lines[1],
      sku: "CLUB",
      quantity: 1,
      currentQuantity: 1,
      requiresShipping: false,
    };
    native.fulfillments = [
      {
        ...native.fulfillments[0],
        tracking: [{ number: "TRACK601", company: "USPS" }],
        totalQuantity: 1,
        lines: [{ ...native.fulfillments[0].lines[0], quantity: 1 }],
      },
      native.fulfillments[2],
    ];
    store = new PostgresPackageHistoryStore(pool, () => now);
    backfill = new PackageHistoryBackfillRepository(pool);
    vi.clearAllMocks();
  });
  afterAll(async () => {
    await pool?.end();
  });
  const seed = () =>
    backfill.seed(
      {
        channelId: 36,
        runKey: "fixture-history",
        actor: "fixture-operator",
        limit: 200,
      },
      now,
    );
  it("resumes keyset seeding without duplicate jobs and freezes its high-water mark", async () => {
    const first = await backfill.seed(
      {
        channelId: 36,
        runKey: "fixture-history",
        actor: "fixture-operator",
        limit: 1,
      },
      now,
    );
    expect(first).toMatchObject({
      before: "0",
      after: "100",
      through: "101",
      seeded: 1,
      state: "scanning",
    });
    await pool.query(
      "INSERT INTO oms.oms_orders(id,channel_id,external_order_id,external_order_number) VALUES(102,36,'1003','#14')",
    );
    expect(await seed()).toMatchObject({
      before: "100",
      after: "101",
      through: "101",
      seeded: 1,
      state: "seeded",
    });
    expect(await seed()).toMatchObject({ seeded: 0, state: "seeded" });
    expect(
      (
        await pool.query(
          "SELECT oms_order_id FROM wms.shipping_package_history_jobs ORDER BY oms_order_id",
        )
      ).rows,
    ).toHaveLength(2);
    expect(
      (
        await pool.query(
          "SELECT oms_order_id FROM wms.shipping_package_history_invalidations WHERE oms_order_id=102",
        )
      ).rows,
    ).toHaveLength(1);
  });
  it("scans mixed-width numeric IDs without skipping orders and safely resumes existing jobs", async () => {
    await pool.query(`INSERT INTO oms.oms_orders(id,channel_id,external_order_id,external_order_number)
      VALUES(9,36,'9009','#9'),(10,36,'9010','#10'),(99,36,'9099','#99'),(1000,36,'9100','#1000'),(10000,36,'9101','#10000')`);
    const visited: string[] = [];
    for (let batch = 0; batch < 10; batch++) {
      const result = await backfill.seed(
        {
          channelId: 36,
          runKey: "mixed-ids",
          actor: "fixture-operator",
          limit: 2,
        },
        now,
      );
      visited.push(result.after);
      if (result.state === "seeded") break;
    }
    expect(visited).toEqual(["10", "100", "1000", "10000"]);
    expect(
      (
        await pool.query(
          "SELECT j.oms_order_id::text AS oms_order_id FROM wms.shipping_package_history_jobs j ORDER BY j.oms_order_id",
        )
      ).rows.map((row) => row.oms_order_id),
    ).toEqual(["9", "10", "99", "100", "101", "1000", "10000"]);
    const replay = await backfill.seed(
      {
        channelId: 36,
        runKey: "mixed-ids",
        actor: "fixture-operator",
        limit: 2,
      },
      now,
    );
    expect(replay).toMatchObject({ scanned: 0, seeded: 0, state: "seeded" });
  });
  it("captures legacy package evidence, populates returns and preserves every protected source/balance row", async () => {
    await seed();
    const before = await fingerprint();
    await guard(true);
    await makeWorker().run({ orderIds: [100] });
    const history = await store.read({
      omsOrderId: 100,
      channelId: 36,
      externalOrderId: "1001",
    });
    expect(history?.packages).toHaveLength(1);
    expect(history?.packages[0].dimensions).toEqual({
      lengthMm: 254,
      widthMm: 203.2,
      heightMm: 101.6,
    });
    const local = liveLocalFixture();
    local.order.externalOrderNumber = "#12";
    local.order.externalCustomerId = "901";
    local.lines[0] = { ...local.lines[0], sku: "PRODUCT", quantity: 1 };
    local.lines[1] = {
      ...local.lines[1],
      sku: "CLUB",
      quantity: 1,
      requiresShipping: false,
    };
    const dimensions = {
      read: vi.fn(async () => {
        throw new Error("Customer lookup must use saved history");
      }),
    };
    const service = new CustomerReturnLiveService({
      local: {
        listShops: async () => [local.shop],
        read: async () => structuredClone(local),
      },
      shopify: nativeReader,
      dimensions,
      packageHistory: store,
      policies: { read: async () => [labelActivePolicy()] },
      now: () => now,
    });
    const order = await service.lookupCanonical({
      channelId: 36,
      omsOrderId: 100,
      externalOrderId: "1001",
      externalCustomerId: "901",
    });
    expect(order.boxOptions).toHaveLength(1);
    expect(order.boxOptions[0].dimensions).toEqual({
      lengthMm: 254,
      widthMm: 203.2,
      heightMm: 101.6,
    });
    expect(order.boxOptions[0].items).toEqual([
      { lineId: order.lines[0].id, quantity: 1 },
    ]);
    expect(dimensions.read).not.toHaveBeenCalled();
    expect(await fingerprint()).toBe(before);
    expect(new Set(requests)).toEqual(new Set(["/shipments"]));
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS count FROM wms.outbound_shipments",
        )
      ).rows[0].count,
    ).toBe(0);
  });
  it("retries a provider outage and replays without duplicate immutable evidence", async () => {
    await seed();
    const before = await fingerprint();
    await guard(true);
    fault = "rate";
    await makeWorker().run({ orderIds: [100] });
    expect(
      (
        await pool.query(
          "SELECT state,last_error_code FROM wms.shipping_package_history_jobs WHERE oms_order_id=100",
        )
      ).rows[0],
    ).toEqual({
      state: "retry",
      last_error_code: "PACKAGE_HISTORY_PROVIDER_UNAVAILABLE",
    });
    now = new Date(now.getTime() + 61_000);
    await makeWorker().run({ orderIds: [100] });
    await pool.query(
      "INSERT INTO wms.shipping_package_history_invalidations(oms_order_id) VALUES(100)",
    );
    await makeWorker().run({ orderIds: [100] });
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS count FROM wms.shipping_package_history_events",
        )
      ).rows[0].count,
    ).toBe(1);
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS count FROM oms.customer_order_action_invalidations WHERE oms_order_id=100",
        )
      ).rows[0].count,
    ).toBe(1);
    expect(
      await store.read({
        omsOrderId: 100,
        channelId: 36,
        externalOrderId: "1001",
      }),
    ).not.toBeNull();
    expect(await fingerprint()).toBe(before);
  });
  it("leases safely across concurrent workers and recovers a crashed lease", async () => {
    await seed();
    await guard(true);
    await Promise.all([
      makeWorker().run({ orderIds: [100] }),
      makeWorker().run({ orderIds: [100] }),
    ]);
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS count FROM wms.shipping_package_history_events",
        )
      ).rows[0].count,
    ).toBe(1);
    await pool.query(
      "INSERT INTO wms.shipping_package_history_invalidations(oms_order_id) VALUES(100)",
    );
    await store.drain(100);
    const first = (
      await store.claim(1, now, "00000000-0000-4000-8000-000000000099", {
        orderIds: [100],
      })
    )[0];
    expect(
      (await backfill.status({ channelId: 36, runKey: "fixture-history" }, now))
        .coverage?.leased_orders,
    ).toBe(1);
    now = new Date(now.getTime() + 5 * 60_000 + 1);
    expect(
      (await backfill.status({ channelId: 36, runKey: "fixture-history" }, now))
        .coverage?.leased_orders,
    ).toBe(0);
    const second = (
      await store.claim(1, now, "00000000-0000-4000-8000-000000000098", {
        orderIds: [100],
      })
    )[0];
    const source = makeSource(),
      scope = await source.scope(100),
      facts = await source.native(scope);
    const document = buildPackageHistory(
      scope,
      facts,
      await source.shipments("TRACK601"),
    );
    expect(await store.complete(first, document, now)).toBe(false);
    expect(await store.complete(second, document, now)).toBe(true);
  });
  it("queues subsequent shipments from normal source updates without historical reseeding", async () => {
    native.lines[0].quantity = 2;
    native.lines[0].currentQuantity = 2;
    await pool.query("UPDATE oms.oms_order_lines SET quantity=2 WHERE id=101");
    await makeWorker().run({ orderIds: [100] });
    expect(
      (
        await store.read({
          omsOrderId: 100,
          channelId: 36,
          externalOrderId: "1001",
        })
      )?.packages,
    ).toHaveLength(1);
    native.fulfillments.push({
      ...native.fulfillments[0],
      id: liveGid("Fulfillment", 704),
      tracking: [{ number: "TRACK602", company: "USPS" }],
      lines: [
        {
          ...native.fulfillments[0].lines[0],
          id: liveGid("FulfillmentLineItem", 804),
        },
      ],
    });
    await pool.query(
      "UPDATE oms.oms_orders SET raw_payload=$1::jsonb WHERE id=100",
      [JSON.stringify({ revision: 2 })],
    );
    const before = await fingerprint();
    await guard(true);
    await makeWorker().run({ orderIds: [100] });
    expect(
      (
        await store.read({
          omsOrderId: 100,
          channelId: 36,
          externalOrderId: "1001",
        })
      )?.packages,
    ).toHaveLength(2);
    expect(await fingerprint()).toBe(before);
  });
  it("records ambiguity for review and rejects foreign reads without guessing", async () => {
    await seed();
    await guard(true);
    fault = "ambiguous";
    await makeWorker().run({ orderIds: [100] });
    expect(
      (
        await pool.query(
          "SELECT state,last_error_code FROM wms.shipping_package_history_jobs WHERE oms_order_id=100",
        )
      ).rows[0],
    ).toEqual({
      state: "review",
      last_error_code: "PACKAGE_HISTORY_LABEL_AMBIGUOUS",
    });
    expect(
      await store.read({
        omsOrderId: 100,
        channelId: 36,
        externalOrderId: "1002",
      }),
    ).toBeNull();
  });
  it("rolls checkpoint and job writes back together on a failed page commit", async () => {
    await pool.query(`CREATE FUNCTION test_guard.reject_cursor() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Synthetic cursor failure'; END; $$;
      CREATE TRIGGER reject_cursor BEFORE UPDATE ON wms.shipping_package_history_backfills FOR EACH ROW EXECUTE FUNCTION test_guard.reject_cursor()`);
    try {
      await expect(seed()).rejects.toThrow("Synthetic cursor failure");
      expect(
        (
          await pool.query(
            "SELECT count(*)::int AS count FROM wms.shipping_package_history_jobs",
          )
        ).rows[0].count,
      ).toBe(0);
      expect(
        (
          await pool.query(
            "SELECT count(*)::int AS count FROM wms.shipping_package_history_backfills",
          )
        ).rows[0].count,
      ).toBe(0);
    } finally {
      await pool.query(
        "DROP TRIGGER reject_cursor ON wms.shipping_package_history_backfills; DROP FUNCTION test_guard.reject_cursor()",
      );
    }
  });
  it("keeps evidence immutable and hides immediately invalidated snapshots", async () => {
    await seed();
    await makeWorker().run({ orderIds: [100] });
    await expect(
      pool.query(
        "UPDATE wms.shipping_package_history_events SET actor='other'",
      ),
    ).rejects.toThrow("immutable");
    await pool.query(
      "INSERT INTO wms.shipping_provider_labels(id,provider,provider_label_id,provider_order_id,provider_order_key,label_status,label_direction,tracking_number) VALUES(1,'shipstation','601','99','1001-2001','voided','outbound','TRACK601')",
    );
    expect(
      await store.read({
        omsOrderId: 100,
        channelId: 36,
        externalOrderId: "1001",
      }),
    ).toBeNull();
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS count FROM wms.shipping_package_history_invalidations WHERE oms_order_id=100",
        )
      ).rows[0].count,
    ).toBeGreaterThan(0);
  });
  it("rolls evidence insertion back if publishing the current pointer fails", async () => {
    await seed();
    const before = await fingerprint();
    await guard(true);
    await pool.query(`CREATE FUNCTION test_guard.reject_ready() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.state='ready' THEN RAISE EXCEPTION 'Synthetic current-pointer failure'; END IF; RETURN NEW; END; $$;
      CREATE TRIGGER reject_ready BEFORE UPDATE ON wms.shipping_package_history_jobs FOR EACH ROW EXECUTE FUNCTION test_guard.reject_ready()`);
    try {
      await makeWorker().run({ orderIds: [100] });
      expect(
        (
          await pool.query(
            "SELECT count(*)::int AS count FROM wms.shipping_package_history_events",
          )
        ).rows[0].count,
      ).toBe(0);
      expect(
        (
          await pool.query(
            "SELECT state FROM wms.shipping_package_history_jobs WHERE oms_order_id=100",
          )
        ).rows[0].state,
      ).toBe("retry");
      expect(await fingerprint()).toBe(before);
    } finally {
      await pool.query(
        "DROP TRIGGER reject_ready ON wms.shipping_package_history_jobs; DROP FUNCTION test_guard.reject_ready()",
      );
    }
  });
  it("rolls shipping evidence back when the customer-account invalidation owner fails", async () => {
    await seed();
    const before = await fingerprint();
    await guard(true);
    await pool.query(`CREATE FUNCTION test_guard.reject_account_invalidation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      RAISE EXCEPTION 'Synthetic customer-account invalidation failure'; END; $$;
      CREATE TRIGGER reject_account_invalidation BEFORE INSERT ON oms.customer_order_action_invalidations
      FOR EACH ROW EXECUTE FUNCTION test_guard.reject_account_invalidation()`);
    try {
      await makeWorker().run({ orderIds: [100] });
      expect(
        (
          await pool.query(
            "SELECT count(*)::int AS count FROM wms.shipping_package_history_events",
          )
        ).rows[0].count,
      ).toBe(0);
      expect(
        (
          await pool.query(
            "SELECT state,document FROM wms.shipping_package_history_jobs WHERE oms_order_id=100",
          )
        ).rows[0],
      ).toEqual({ state: "retry", document: null });
      expect(
        (
          await pool.query(
            "SELECT count(*)::int AS count FROM oms.customer_order_action_invalidations",
          )
        ).rows[0].count,
      ).toBe(0);
      expect(await fingerprint()).toBe(before);
    } finally {
      await pool.query(
        "DROP TRIGGER reject_account_invalidation ON oms.customer_order_action_invalidations; DROP FUNCTION test_guard.reject_account_invalidation()",
      );
    }
    now = new Date(now.getTime() + 61_000);
    await makeWorker().run({ orderIds: [100] });
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS count FROM wms.shipping_package_history_events",
        )
      ).rows[0].count,
    ).toBe(1);
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS count FROM oms.customer_order_action_invalidations",
        )
      ).rows[0].count,
    ).toBe(1);
    expect(await fingerprint()).toBe(before);
  });
  it("does not publish an observation superseded by an incoming source event", async () => {
    await seed();
    const original = providerRequest.getMockImplementation()!;
    providerRequest.mockImplementationOnce(async (input, init) => {
      await pool.query(
        "UPDATE oms.oms_orders SET raw_payload=$1::jsonb WHERE id=100",
        [JSON.stringify({ revision: 2 })],
      );
      return original(input, init);
    });
    await makeWorker().run({ orderIds: [100] });
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS count FROM wms.shipping_package_history_events",
        )
      ).rows[0].count,
    ).toBe(0);
    expect(
      await store.read({
        omsOrderId: 100,
        channelId: 36,
        externalOrderId: "1001",
      }),
    ).toBeNull();
    await makeWorker().run({ orderIds: [100] });
    expect(
      await store.read({
        omsOrderId: 100,
        channelId: 36,
        externalOrderId: "1001",
      }),
    ).not.toBeNull();
  });
  it("reports an unstarted run consistently without creating a cursor or changing source data", async () => {
    const before = await fingerprint();
    await guard(true);
    expect(
      await backfill.status({ channelId: 36, runKey: "not-started" }, now),
    ).toEqual({
      cursor: null,
      states: [],
      errors: [],
      coverage: null,
      measurements: [],
    });
    expect(await fingerprint()).toBe(before);
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS count FROM wms.shipping_package_history_backfills",
        )
      ).rows[0].count,
    ).toBe(0);
  });
  it("does not call a seeded cursor or stale snapshot complete package coverage", async () => {
    await seed();
    await makeWorker().run({ orderIds: [100] });
    const status = await backfill.status(
      { channelId: 36, runKey: "fixture-history" },
      now,
    );
    expect(status.cursor?.state).toBe("seeded");
    expect(status.coverage).toMatchObject({
      source_orders: 2,
      unseeded_orders: 0,
    });
    expect(status.states).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ state: "pending", orders: 1, packages: 0 }),
        expect.objectContaining({ state: "ready", orders: 1, packages: 1 }),
      ]),
    );
    expect(status.measurements).toEqual([{ state: "verified", packages: 1 }]);
    await pool.query(
      "INSERT INTO wms.shipping_package_history_invalidations(oms_order_id) VALUES(100)",
    );
    const pending = await backfill.status(
      { channelId: 36, runKey: "fixture-history" },
      now,
    );
    expect(pending.states).toEqual([
      expect.objectContaining({ state: "pending", orders: 2, packages: 0 }),
    ]);
    expect(pending.measurements).toEqual([]);
    await makeWorker().run({ orderIds: [100] });
    now = new Date(now.getTime() + 24 * 60 * 60_000 + 1);
    expect(
      await store.read({
        omsOrderId: 100,
        channelId: 36,
        externalOrderId: "1001",
      }),
    ).not.toBeNull();
    expect(
      (await backfill.status({ channelId: 36, runKey: "fixture-history" }, now))
        .states,
    ).toEqual([
      expect.objectContaining({ state: "pending", orders: 1, packages: 0 }),
      expect.objectContaining({ state: "ready", orders: 1, packages: 1 }),
    ]);
  });
  it("scopes both dirty-event consumption and capture to the selected channel", async () => {
    await pool.query(`INSERT INTO channels.channels VALUES(37,'shopify','internal','active','Other fixture');
      INSERT INTO channels.channel_connections VALUES(5,37,'other-fixture.myshopify.com','fixture-token','2026-07');
      INSERT INTO oms.oms_orders(id,channel_id,external_order_id,external_order_number) VALUES(103,37,'9999','#99')`);
    await seed();
    await makeWorker().run({ channelId: 36 });
    expect(
      (
        await pool.query(
          "SELECT oms_order_id FROM wms.shipping_package_history_invalidations WHERE oms_order_id=103",
        )
      ).rows,
    ).toHaveLength(1);
    expect(
      (
        await pool.query(
          "SELECT oms_order_id FROM wms.shipping_package_history_jobs WHERE oms_order_id=103",
        )
      ).rows,
    ).toHaveLength(0);
  });
  it("enqueues from normal package, fulfillment and connection events without an explicit backfill", async () => {
    await pool.query(`INSERT INTO wms.orders VALUES(201,36,'oms',NULL,'100','1001','shipped');
      INSERT INTO wms.order_items VALUES(303,201,101,'501','PRODUCT',1,1);
      INSERT INTO wms.fulfillment_plan_lines VALUES(401,101);
      INSERT INTO wms.physical_shipments VALUES(501);
      INSERT INTO wms.physical_shipment_items VALUES(601,501,303,401)`);
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS count FROM wms.shipping_package_history_invalidations WHERE oms_order_id=100",
        )
      ).rows[0].count,
    ).toBeGreaterThan(0);
    await pool.query("TRUNCATE wms.shipping_package_history_invalidations");
    await pool.query(
      "INSERT INTO oms.channel_fulfillment_receipts VALUES(701,100)",
    );
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS count FROM wms.shipping_package_history_invalidations WHERE oms_order_id=100",
        )
      ).rows[0].count,
    ).toBe(1);
    await pool.query("TRUNCATE wms.shipping_package_history_invalidations");
    await pool.query(
      "UPDATE channels.channel_connections SET api_version='2026-10' WHERE id=4",
    );
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS count FROM wms.shipping_package_history_invalidations",
        )
      ).rows[0].count,
    ).toBe(2);
  });
  it("reserves capacity for both live events and initial historical coverage", async () => {
    await seed();
    await pool.query(`INSERT INTO oms.oms_orders(id,channel_id,external_order_id,external_order_number)
      VALUES(103,36,'1003','#14'),(104,36,'1004','#15')`);
    await store.drain(100);
    const first = await store.claim(
      2,
      now,
      "00000000-0000-4000-8000-000000000091",
    );
    expect(new Set(first.map((item) => item.omsOrderId))).toEqual(
      new Set([100, 103]),
    );
    const second = await store.claim(
      2,
      now,
      "00000000-0000-4000-8000-000000000092",
    );
    expect(new Set(second.map((item) => item.omsOrderId))).toEqual(
      new Set([101, 104]),
    );
  });
  it("retries reviewed history explicitly after evidence becomes resolvable", async () => {
    store = new PostgresPackageHistoryStore(
      pool,
      () => now,
      "fixture-operator",
    );
    await seed();
    fault = "ambiguous";
    await makeWorker().run({ orderIds: [100] });
    const before = await fingerprint();
    await guard(true);
    fault = "none";
    expect(
      await backfill.retryReview(
        {
          channelId: 36,
          runKey: "fixture-history",
          actor: "fixture-operator",
          limit: 200,
        },
        now,
      ),
    ).toMatchObject({ enqueued: 1 });
    await makeWorker().run({ orderIds: [100] });
    expect(await fingerprint()).toBe(before);
    expect(
      (
        await pool.query(
          "SELECT actor FROM wms.shipping_package_history_events WHERE oms_order_id=100",
        )
      ).rows,
    ).toEqual([{ actor: "fixture-operator" }]);
    expect(
      await store.read({
        omsOrderId: 100,
        channelId: 36,
        externalOrderId: "1001",
      }),
    ).not.toBeNull();
  });
});
