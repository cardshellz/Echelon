import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createInventoryCutoverTestDatabase, type InventoryCutoverTestDatabase } from "../../../inventory/__tests__/fixtures/inventory-cutover-database";
import { claimVariantAvailabilitySyncs, enqueueVariantAvailabilitySync, markVariantAvailabilitySynced, supersedeAvailabilityClaim,
  type ClaimedVariantAvailabilitySync, type SqlPool } from "../../variant-availability-sync.repository";

const base = `CREATE SCHEMA catalog; CREATE SCHEMA channels; CREATE SCHEMA dropship;
  CREATE SCHEMA marketplace; CREATE SCHEMA inventory; CREATE SCHEMA wms; CREATE SCHEMA oms;
  CREATE TABLE catalog.products(id integer PRIMARY KEY,is_active boolean,status text);
  CREATE TABLE catalog.product_variants(id integer PRIMARY KEY,product_id integer REFERENCES catalog.products(id),is_active boolean,
    sales_eligibility text NOT NULL DEFAULT 'sellable',sku text,shopify_variant_id text,shopify_inventory_item_id text,dropship_eligible boolean DEFAULT false);
  CREATE TABLE channels.channels(id integer PRIMARY KEY,provider text);
  CREATE TABLE channels.channel_feeds(
    id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,channel_id integer,product_variant_id integer,
    channel_variant_id text,channel_inventory_item_id text,channel_sku text,is_active integer,
    last_synced_qty integer,last_synced_at timestamptz,updated_at timestamptz,
    UNIQUE(channel_id,product_variant_id));
  CREATE TABLE channels.channel_listings(
    id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,channel_id integer,product_variant_id integer,
    external_product_id text,external_variant_id text,external_sku text,last_synced_qty integer,
    last_synced_at timestamptz,sync_status text,sync_error text,created_at timestamptz,updated_at timestamptz,
    UNIQUE(channel_id,product_variant_id));
  CREATE TABLE channels.channel_reservations(product_variant_id integer);
  CREATE TABLE channels.channel_variant_overrides(product_variant_id integer,is_listed integer);
  CREATE TABLE channels.channel_allocation_rules(product_variant_id integer);
  CREATE TABLE dropship.dropship_vendor_listings(product_variant_id integer);
  CREATE TABLE dropship.dropship_vendor_variant_overrides(product_variant_id integer);
  CREATE TABLE marketplace.listing_publications(id integer,status text);
  CREATE TABLE marketplace.listing_publication_members(publication_id integer,product_variant_id integer,disposition text);
  CREATE TABLE inventory.inventory_publication_outbox(product_variant_id integer,state text);
  CREATE TABLE wms.orders(id integer,warehouse_status text);
  CREATE TABLE wms.order_items(order_id integer,sku text,status text,fulfilled_quantity integer,quantity integer);
  CREATE TABLE oms.oms_orders(id integer,status text);
  CREATE TABLE oms.oms_order_lines(order_id integer,product_variant_id integer);`;
const url = process.env.ECHELON_TEST_DATABASE_URL;
const disposable = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
const lease = "123e4567-e89b-42d3-a456-426614174000";
const claim: ClaimedVariantAvailabilitySync = {
  channelId: 1,productVariantId: 1,desiredActive: true,revision: 1,attemptCount: 1,leaseToken: lease,
  requestKind: "catalog_activation",
};

(url && disposable ? describe : describe.skip).sequential("availability archive cutover with PostgreSQL", () => {
  let database: InventoryCutoverTestDatabase;
  const pool = () => database.pool as unknown as SqlPool;
  beforeAll(async () => {
    database = await createInventoryCutoverTestDatabase(url, disposable, base);
    await database.pool.query(readFileSync(resolve("migrations/0606_channel_variant_availability_sync.sql"), "utf8"));
    const eligibilityMigration = readFileSync(resolve("migrations/0626_catalog_variant_sales_eligibility.sql"), "utf8");
    const sellabilityStart = eligibilityMigration.indexOf("CREATE OR REPLACE FUNCTION catalog.assert_customer_sellable_variant()");
    const sellabilityEnd = eligibilityMigration.indexOf("CREATE OR REPLACE FUNCTION catalog.guard_internal_only_variant_transition()");
    expect(sellabilityStart).toBeGreaterThan(0); expect(sellabilityEnd).toBeGreaterThan(sellabilityStart);
    await database.pool.query(eligibilityMigration.slice(sellabilityStart,sellabilityEnd));
    // The production migration will replace this prototype after PR allocation.
    await database.pool.query(readFileSync(resolve(".verification/archive-separation.sql"), "utf8"));
    await database.pool.query(`CREATE TRIGGER product_variants_guard_internal_only_transition
      BEFORE UPDATE OF sales_eligibility,shopify_variant_id,shopify_inventory_item_id,dropship_eligible
      ON catalog.product_variants FOR EACH ROW EXECUTE FUNCTION catalog.guard_internal_only_variant_transition()`);
  });
  afterAll(async () => { await database?.close(); });
  beforeEach(async () => {
    await database.pool.query(`TRUNCATE channels.channel_variant_availability_followups,
      channels.channel_variant_availability_sync,channels.channel_feeds,channels.channel_listings,
      catalog.product_variants,catalog.products,channels.channels RESTART IDENTITY CASCADE;
      INSERT INTO catalog.products VALUES (1,true,'active');
      INSERT INTO channels.channels VALUES (1,'ebay');
      INSERT INTO catalog.product_variants VALUES (1,1,true),(2,1,false);
      INSERT INTO channels.channel_feeds(channel_id,product_variant_id,channel_sku,is_active) VALUES(1,1,'EXAMPLE',1);
      UPDATE channels.channel_variant_availability_sync
        SET status='processing',attempt_count=1,lease_token='${lease}',lease_expires_at=transaction_timestamp()+interval '5 minutes'
        WHERE product_variant_id=1;`);
  });
  it("preserves an in-flight request through archive and reactivation, then promotes the newer request exactly once", async () => {
    await database.pool.query("UPDATE catalog.product_variants SET is_active=false WHERE id=1");
    await database.pool.query("INSERT INTO channels.channel_listings(channel_id,product_variant_id) VALUES(1,2)");
    expect((await database.pool.query("SELECT 1 FROM channels.channel_variant_availability_sync WHERE product_variant_id=2")).rowCount).toBe(0);
    await database.pool.query("UPDATE catalog.product_variants SET is_active=true WHERE id=1");
    expect((await database.pool.query("SELECT status,revision,lease_token FROM channels.channel_variant_availability_sync WHERE product_variant_id=1")).rows[0])
      .toEqual({ status: "processing",revision: "1",lease_token: lease });
    expect((await database.pool.query("SELECT desired_active FROM channels.channel_variant_availability_followups WHERE product_variant_id=1")).rows)
      .toEqual([{ desired_active: true }]);

    const result = { quantity: 17,feedActive: true,externalProductId: "listing-a",externalVariantId: "offer-a",
      externalInventoryItemId: null,externalSku: "EXAMPLE" };
    expect(await markVariantAvailabilitySynced(pool(),claim,result)).toBe(true);
    expect((await database.pool.query("SELECT status,revision,desired_active,last_synced_quantity,lease_token FROM channels.channel_variant_availability_sync WHERE product_variant_id=1")).rows[0])
      .toEqual({ status: "pending",revision: "2",desired_active: true,last_synced_quantity: 17,lease_token: null });
    expect((await database.pool.query("SELECT 1 FROM channels.channel_variant_availability_followups")).rowCount).toBe(0);
    expect(await markVariantAvailabilitySynced(pool(),claim,result)).toBe(false);
  });
  it("rolls back the mapping projection when completing the claim fails", async () => {
    await enqueueVariantAvailabilitySync(pool(), { channelId: 1,productVariantId: 1,desiredActive: true,requestKind: "catalog_activation" });
    await database.pool.query(`CREATE FUNCTION channels.reject_completion_test() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.status='pending' THEN RAISE EXCEPTION 'completion failed'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER reject_completion_test BEFORE UPDATE ON channels.channel_variant_availability_sync
      FOR EACH ROW EXECUTE FUNCTION channels.reject_completion_test();`);
    try {
      await expect(markVariantAvailabilitySynced(pool(),claim,{ quantity: 17,feedActive: true,externalProductId: "listing-a",
        externalVariantId: "offer-a",externalInventoryItemId: null,externalSku: "EXAMPLE" })).rejects.toThrow("completion failed");
      expect((await database.pool.query("SELECT status,revision,lease_token FROM channels.channel_variant_availability_sync WHERE product_variant_id=1")).rows[0])
        .toEqual({ status: "processing",revision: "1",lease_token: lease });
      expect((await database.pool.query("SELECT channel_variant_id,last_synced_qty FROM channels.channel_feeds WHERE product_variant_id=1")).rows[0])
        .toEqual({ channel_variant_id: null,last_synced_qty: null });
      expect((await database.pool.query("SELECT 1 FROM channels.channel_listings WHERE product_variant_id=1")).rowCount).toBe(0);
      expect((await database.pool.query("SELECT 1 FROM channels.channel_variant_availability_followups WHERE product_variant_id=1")).rowCount).toBe(1);
    } finally {
      await database.pool.query("DROP TRIGGER reject_completion_test ON channels.channel_variant_availability_sync; DROP FUNCTION channels.reject_completion_test()");
    }
  });
  it("does not reactivate a local feed when an older provider acknowledgement arrives after archive", async () => {
    await database.pool.query("UPDATE catalog.product_variants SET is_active=false WHERE id=1");
    expect(await markVariantAvailabilitySynced(pool(),claim,{ quantity: 17,feedActive: true,externalProductId: "listing-a",
      externalVariantId: "offer-a",externalInventoryItemId: null,externalSku: "EXAMPLE" })).toBe(true);
    expect((await database.pool.query("SELECT is_active,last_synced_qty FROM channels.channel_feeds WHERE product_variant_id=1")).rows[0])
      .toEqual({ is_active: 0,last_synced_qty: 17 });
    expect((await database.pool.query("SELECT external_variant_id FROM channels.channel_listings WHERE product_variant_id=1")).rows[0])
      .toEqual({ external_variant_id: "offer-a" });
  });
  it("does not run a queued reactivation after the variant is archived again", async () => {
    await database.pool.query("UPDATE catalog.product_variants SET is_active=false WHERE id=1");
    await database.pool.query("UPDATE catalog.product_variants SET is_active=true WHERE id=1");
    await database.pool.query("UPDATE catalog.product_variants SET is_active=false WHERE id=1");
    expect(await markVariantAvailabilitySynced(pool(),claim,{ quantity: 17,feedActive: true,externalProductId: "listing-a",
      externalVariantId: "offer-a",externalInventoryItemId: null,externalSku: "EXAMPLE" })).toBe(true);
    expect((await database.pool.query("SELECT status,desired_active FROM channels.channel_variant_availability_sync WHERE product_variant_id=1")).rows[0])
      .toEqual({ status: "synced",desired_active: true });
    expect((await database.pool.query("SELECT is_active FROM channels.channel_feeds WHERE product_variant_id=1")).rows[0]).toEqual({ is_active: 0 });
    expect((await database.pool.query("SELECT 1 FROM channels.channel_variant_availability_followups WHERE product_variant_id=1")).rowCount).toBe(0);
  });
  it("retains an independently requested zero repair after archive and preserves immutable follow-up history", async () => {
    await enqueueVariantAvailabilitySync(pool(), { channelId: 1,productVariantId: 1,desiredActive: false,requestKind: "stock_repair" });
    await database.pool.query("UPDATE catalog.product_variants SET is_active=false WHERE id=1");
    expect(await markVariantAvailabilitySynced(pool(),claim,{ quantity: 17,feedActive: true,externalProductId: "listing-a",
      externalVariantId: "offer-a",externalInventoryItemId: null,externalSku: "EXAMPLE" })).toBe(true);
    expect((await database.pool.query("SELECT status,desired_active,revision FROM channels.channel_variant_availability_sync WHERE product_variant_id=1")).rows[0])
      .toEqual({ status: "pending",desired_active: false,revision: "2" });
    const events = (await database.pool.query(`SELECT operation,reason,before_state,after_state
      FROM channels.channel_variant_availability_followup_events WHERE product_variant_id=1 ORDER BY id DESC LIMIT 2`)).rows;
    expect(events).toMatchObject([
      { operation: "DELETE",reason: "promoted",before_state: { desired_active: false },after_state: null },
      { operation: "INSERT",reason: "requested",before_state: null,after_state: { desired_active: false } },
    ]);
    await expect(database.pool.query("DELETE FROM channels.channel_variant_availability_followup_events")).rejects.toMatchObject({ code: "55000" });
    await expect(database.pool.query("TRUNCATE channels.channel_variant_availability_followup_events")).rejects.toMatchObject({ code: "55000" });
  });
  it("retains stock repair ahead of a later reactivation instead of replacing it", async () => {
    await enqueueVariantAvailabilitySync(pool(), { channelId: 1,productVariantId: 1,desiredActive: false,requestKind: "stock_repair" });
    await enqueueVariantAvailabilitySync(pool(), { channelId: 1,productVariantId: 1,desiredActive: true,requestKind: "catalog_activation" });
    expect((await database.pool.query("SELECT desired_active,request_kind FROM channels.channel_variant_availability_followups WHERE product_variant_id=1 ORDER BY id")).rows)
      .toEqual([{ desired_active: false,request_kind: "stock_repair" },{ desired_active: true,request_kind: "catalog_activation" }]);
    expect(await markVariantAvailabilitySynced(pool(),claim,{ quantity: 17,feedActive: true,externalProductId: "listing-a",
      externalVariantId: "offer-a",externalInventoryItemId: null,externalSku: "EXAMPLE" })).toBe(true);
    expect((await database.pool.query("SELECT status,desired_active,request_kind FROM channels.channel_variant_availability_sync WHERE product_variant_id=1")).rows[0])
      .toEqual({ status: "pending",desired_active: false,request_kind: "stock_repair" });
    expect((await database.pool.query("SELECT desired_active,request_kind FROM channels.channel_variant_availability_followups WHERE product_variant_id=1 ORDER BY id")).rows)
      .toEqual([{ desired_active: true,request_kind: "catalog_activation" }]);
    const [repairClaim]=await claimVariantAvailabilitySyncs(pool(), { batchSize: 1,leaseSeconds: 60 });
    expect(repairClaim).toMatchObject({ desiredActive: false,requestKind: "stock_repair",revision: 2 });
    expect(await markVariantAvailabilitySynced(pool(),repairClaim,{ quantity: 0,feedActive: false,externalProductId: "listing-a",
      externalVariantId: "offer-a",externalInventoryItemId: null,externalSku: "EXAMPLE" })).toBe(true);
    expect((await database.pool.query("SELECT status,revision,desired_active,request_kind FROM channels.channel_variant_availability_sync WHERE product_variant_id=1")).rows[0])
      .toEqual({ status: "pending",revision: "3",desired_active: true,request_kind: "catalog_activation" });
    expect((await database.pool.query("SELECT 1 FROM channels.channel_variant_availability_followups WHERE product_variant_id=1")).rowCount).toBe(0);
  });
  it("keeps an older worker's saved repair ahead of a newer request after completion", async () => {
    await enqueueVariantAvailabilitySync(pool(), { channelId: 1,productVariantId: 1,desiredActive: false,requestKind: "stock_repair" });
    await database.pool.query("UPDATE channels.channel_variant_availability_sync SET status='synced',lease_token=NULL,lease_expires_at=NULL WHERE product_variant_id=1");
    await enqueueVariantAvailabilitySync(pool(), { channelId: 1,productVariantId: 1,desiredActive: true,requestKind: "catalog_activation" });
    expect((await database.pool.query("SELECT desired_active,request_kind FROM channels.channel_variant_availability_followups WHERE product_variant_id=1 ORDER BY id")).rows)
      .toEqual([{ desired_active: false,request_kind: "stock_repair" },{ desired_active: true,request_kind: "catalog_activation" }]);
    await database.pool.query("SELECT channels.promote_completed_availability_followups(1,transaction_timestamp())");
    expect((await database.pool.query("SELECT status,desired_active,request_kind FROM channels.channel_variant_availability_sync WHERE product_variant_id=1")).rows[0])
      .toEqual({ status: "pending",desired_active: false,request_kind: "stock_repair" });
  });
  it("discards an archived activation without discarding a later stock repair", async () => {
    await enqueueVariantAvailabilitySync(pool(), { channelId: 1,productVariantId: 1,desiredActive: true,requestKind: "catalog_activation" });
    await enqueueVariantAvailabilitySync(pool(), { channelId: 1,productVariantId: 1,desiredActive: false,requestKind: "stock_repair" });
    await enqueueVariantAvailabilitySync(pool(), { channelId: 1,productVariantId: 1,desiredActive: true,requestKind: "catalog_activation" });
    await database.pool.query("UPDATE catalog.product_variants SET is_active=false WHERE id=1");
    expect(await markVariantAvailabilitySynced(pool(),claim,{ quantity: 17,feedActive: true,externalProductId: "listing-a",
      externalVariantId: "offer-a",externalInventoryItemId: null,externalSku: "EXAMPLE" })).toBe(true);
    expect((await database.pool.query("SELECT status,desired_active,request_kind FROM channels.channel_variant_availability_sync WHERE product_variant_id=1")).rows[0])
      .toEqual({ status: "pending",desired_active: false,request_kind: "stock_repair" });
    expect((await database.pool.query("SELECT desired_active,request_kind FROM channels.channel_variant_availability_followups ORDER BY id")).rows)
      .toEqual([{ desired_active: true,request_kind: "catalog_activation" }]);
    expect((await database.pool.query("SELECT reason,before_state->>'request_kind' AS kind FROM channels.channel_variant_availability_followup_events WHERE operation='DELETE' ORDER BY id DESC LIMIT 2")).rows)
      .toEqual([{ reason: "promoted",kind: "stock_repair" },{ reason: "archived_before_dispatch",kind: "catalog_activation" }]);
  });
  it("bounds a large archived backlog and still promotes the later repair", async () => {
    await database.pool.query(`UPDATE catalog.product_variants SET is_active=false WHERE id=1;
      INSERT INTO channels.channel_variant_availability_followups(channel_id,product_variant_id,desired_active,request_kind)
        SELECT 1,1,true,'catalog_activation' FROM generate_series(1,1001);
      INSERT INTO channels.channel_variant_availability_followups(channel_id,product_variant_id,desired_active,request_kind)
        VALUES(1,1,false,'stock_repair');`);
    expect(await markVariantAvailabilitySynced(pool(),claim,{ quantity: 17,feedActive: true,externalProductId: "listing-a",
      externalVariantId: "offer-a",externalInventoryItemId: null,externalSku: "EXAMPLE" })).toBe(true);
    expect((await database.pool.query("SELECT status FROM channels.channel_variant_availability_sync WHERE product_variant_id=1")).rows[0])
      .toEqual({ status: "synced" });
    expect((await database.pool.query("SELECT count(*)::int AS n FROM channels.channel_variant_availability_followups WHERE product_variant_id=1")).rows[0].n).toBe(2);
    expect((await database.pool.query<{n:number}>("SELECT channels.promote_completed_availability_followups(1,transaction_timestamp()) AS n")).rows[0].n).toBe(1);
    expect((await database.pool.query("SELECT status,request_kind FROM channels.channel_variant_availability_sync WHERE product_variant_id=1")).rows[0])
      .toEqual({ status: "pending",request_kind: "stock_repair" });
  });
  it("coalesces only adjacent identical follow-ups", async () => {
    for (const desiredActive of [false,false,true,true,false]) {
      await enqueueVariantAvailabilitySync(pool(), { channelId: 1,productVariantId: 1,desiredActive,
        requestKind: desiredActive ? "catalog_activation" : "stock_repair" });
    }
    expect((await database.pool.query("SELECT request_kind FROM channels.channel_variant_availability_followups ORDER BY id")).rows)
      .toEqual([{ request_kind: "stock_repair" },{ request_kind: "catalog_activation" },{ request_kind: "stock_repair" }]);
  });
  it("can use the actual variant indexes for Catalog exposure checks", async () => {
    const client=await database.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL enable_seqscan=off");
      const queuePlan=await client.query<{"QUERY PLAN":string}>("EXPLAIN (COSTS OFF) SELECT 1 FROM channels.channel_variant_availability_sync WHERE product_variant_id=1");
      const followupPlan=await client.query<{"QUERY PLAN":string}>("EXPLAIN (COSTS OFF) SELECT 1 FROM channels.channel_variant_availability_followups WHERE product_variant_id=1 AND desired_active");
      expect(queuePlan.rows.map(row => row["QUERY PLAN"]).join("\n")).toContain("channel_variant_availability_sync_variant_idx");
      expect(followupPlan.rows.map(row => row["QUERY PLAN"]).join("\n")).toContain("channel_variant_availability_followups_active_variant_idx");
      await client.query("ROLLBACK");
    } finally { client.release(); }
  });
  it("blocks an internal-only transition while a queued activation remains", async () => {
    await database.pool.query("DELETE FROM channels.channel_feeds WHERE product_variant_id=1");
    await database.pool.query("UPDATE channels.channel_variant_availability_sync SET desired_active=false,request_kind='stock_repair' WHERE product_variant_id=1");
    await enqueueVariantAvailabilitySync(pool(), { channelId: 1,productVariantId: 1,desiredActive: true,requestKind: "catalog_activation" });
    await expect(database.pool.query("UPDATE catalog.product_variants SET sales_eligibility='internal_only' WHERE id=1"))
      .rejects.toMatchObject({ code: "23514",constraint: "internal_only_variant_has_customer_exposure" });
    expect((await database.pool.query("SELECT sales_eligibility FROM catalog.product_variants WHERE id=1")).rows[0])
      .toEqual({ sales_eligibility: "sellable" });
  });
  it.each(["processing", "needs_review"])("blocks an internal-only transition for unconfirmed %s legacy work even when the latest value is zero", async status => {
    await database.pool.query("DELETE FROM channels.channel_feeds WHERE product_variant_id=1");
    await database.pool.query(`UPDATE channels.channel_variant_availability_sync SET desired_active=false,request_kind=NULL,
      enqueued_revision=NULL,status=$1::varchar,lease_token=CASE WHEN $1::varchar='processing' THEN $2::uuid ELSE NULL END,
      lease_expires_at=CASE WHEN $1::varchar='processing' THEN transaction_timestamp()+interval '1 minute' ELSE NULL END WHERE product_variant_id=1`, [status,lease]);
    await expect(database.pool.query("UPDATE catalog.product_variants SET sales_eligibility='internal_only' WHERE id=1"))
      .rejects.toMatchObject({ code: "23514",constraint: "internal_only_variant_has_customer_exposure" });
  });
  it("does not treat a proven-unsent cancellation as active exposure", async () => {
    await database.pool.query("DELETE FROM channels.channel_feeds WHERE product_variant_id=1");
    await database.pool.query(`UPDATE channels.channel_variant_availability_sync SET status='cancelled',
      lease_token=NULL,lease_expires_at=NULL WHERE product_variant_id=1`);
    await database.pool.query("UPDATE catalog.product_variants SET sales_eligibility='internal_only' WHERE id=1");
    expect((await database.pool.query("SELECT sales_eligibility FROM catalog.product_variants WHERE id=1")).rows[0])
      .toEqual({ sales_eligibility: "internal_only" });
  });
  it("serializes a queued activation against a concurrent internal-only transition", async () => {
    await database.pool.query("DELETE FROM channels.channel_feeds WHERE product_variant_id=1");
    await database.pool.query("UPDATE channels.channel_variant_availability_sync SET desired_active=false,request_kind='stock_repair' WHERE product_variant_id=1");
    const editor=await database.pool.connect(), requester=await database.pool.connect();
    try {
      const requesterPid=(await requester.query<{pid:number}>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      await editor.query("BEGIN");
      await editor.query("UPDATE catalog.product_variants SET sales_eligibility='internal_only' WHERE id=1");
      const requested=requester.query("SELECT channels.request_variant_availability_refresh(1,1,true,'catalog_activation')")
        .then(() => null, error => error);
      let blocked=false;
      for (let i=0;i<100;i++) {
        if ((await editor.query<{blocked:boolean}>("SELECT cardinality(pg_blocking_pids($1))>0 AS blocked",[requesterPid])).rows[0].blocked) {
          blocked=true; break;
        }
        await new Promise(resolveDelay => setTimeout(resolveDelay,10));
      }
      expect(blocked).toBe(true);
      await editor.query("COMMIT");
      expect(await requested).toMatchObject({ code: "23514",constraint: "customer_sellable_variant_required" });
      expect((await database.pool.query("SELECT 1 FROM channels.channel_variant_availability_followups WHERE product_variant_id=1")).rowCount).toBe(0);
    } finally { await editor.query("ROLLBACK").catch(() => undefined); editor.release(); requester.release(); }
  });
  it("serializes simultaneous completion and a new request without losing either intent", async () => {
    const blocker = await database.pool.connect(), completing = await database.pool.connect(), requesting = await database.pool.connect();
    try {
      const completionPid = (await completing.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      const requestPid = (await requesting.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      await blocker.query("BEGIN");
      await blocker.query("SELECT 1 FROM channels.channel_variant_availability_sync WHERE channel_id=1 AND product_variant_id=1 FOR UPDATE");
      const completion = completing.query<{ completed: boolean }>(
        "SELECT channels.complete_variant_availability_claim(1,1,1,$1,true,17,transaction_timestamp()) AS completed", [lease]);
      const request = requesting.query("SELECT channels.request_variant_availability_refresh(1,1,true,'catalog_activation')");
      let bothBlocked = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        const waiting = (await blocker.query<{ first: boolean; second: boolean }>(
          "SELECT cardinality(pg_blocking_pids($1))>0 AS first,cardinality(pg_blocking_pids($2))>0 AS second",
          [completionPid,requestPid])).rows[0];
        if (waiting.first && waiting.second) { bothBlocked = true; break; }
        await new Promise(resolveDelay => setTimeout(resolveDelay, 10));
      }
      expect(bothBlocked).toBe(true);
      await blocker.query("COMMIT");
      expect((await completion).rows[0].completed).toBe(true);
      await request;
      expect((await database.pool.query("SELECT status,revision,desired_active,last_synced_quantity FROM channels.channel_variant_availability_sync WHERE product_variant_id=1")).rows[0])
        .toEqual({ status: "pending",revision: "2",desired_active: true,last_synced_quantity: 17 });
      expect((await database.pool.query("SELECT 1 FROM channels.channel_variant_availability_followups")).rowCount).toBe(0);
    } finally {
      await blocker.query("ROLLBACK").catch(() => undefined);
      blocker.release(); completing.release(); requesting.release();
    }
  });
  it("does not wait or project a stale acknowledgement while the catalog variant is changing", async () => {
    const editor = await database.pool.connect();
    try {
      await editor.query("BEGIN");
      await editor.query("SELECT id FROM catalog.product_variants WHERE id=1 FOR UPDATE");
      await expect(markVariantAvailabilitySynced(pool(),claim,{ quantity: 17,feedActive: true,externalProductId: "listing-a",
        externalVariantId: "offer-a",externalInventoryItemId: null,externalSku: "EXAMPLE" })).rejects.toMatchObject({ code: "55P03" });
      expect((await database.pool.query("SELECT status,revision,lease_token FROM channels.channel_variant_availability_sync WHERE product_variant_id=1")).rows[0])
        .toEqual({ status: "processing",revision: "1",lease_token: lease });
      expect((await database.pool.query("SELECT 1 FROM channels.channel_listings WHERE product_variant_id=1")).rowCount).toBe(0);
    } finally {
      await editor.query("ROLLBACK"); editor.release();
    }
  });
  it("allows exactly one concurrent completion of the same lease", async () => {
    await enqueueVariantAvailabilitySync(pool(), { channelId: 1,productVariantId: 1,desiredActive: true,requestKind: "catalog_activation" });
    const results = await Promise.all([1,2].map(() => database.pool.query<{ completed: boolean }>(
      "SELECT channels.complete_variant_availability_claim(1,1,1,$1,false,NULL,transaction_timestamp()) AS completed", [lease])));
    expect(results.map(result => result.rows[0].completed).sort()).toEqual([false,true]);
    expect((await database.pool.query("SELECT status,revision FROM channels.channel_variant_availability_sync WHERE product_variant_id=1")).rows[0])
      .toEqual({ status: "pending",revision: "2" });
    expect((await database.pool.query("SELECT 1 FROM channels.channel_variant_availability_followups")).rowCount).toBe(0);
  });
  it("preserves a newer queued decision when an older worker replans", async () => {
    await enqueueVariantAvailabilitySync(pool(), { channelId: 1,productVariantId: 1,desiredActive: false,requestKind: "stock_repair" });
    await supersedeAvailabilityClaim(pool(),claim,true);
    expect((await database.pool.query("SELECT status,revision,desired_active FROM channels.channel_variant_availability_sync WHERE product_variant_id=1")).rows[0])
      .toEqual({ status: "pending",revision: "2",desired_active: false });
    expect((await database.pool.query("SELECT desired_active,request_kind FROM channels.channel_variant_availability_followups ORDER BY id")).rows)
      .toEqual([{ desired_active: true,request_kind: "catalog_activation" }]);
    await expect(supersedeAvailabilityClaim(pool(),claim,true)).rejects.toThrow("lost its lease or revision");
  });
  it("retains a legacy request for review rather than creating a new zero when archived", async () => {
    await database.pool.query("UPDATE channels.channel_variant_availability_sync SET enqueued_revision=NULL,request_kind=NULL WHERE product_variant_id=1");
    await database.pool.query("UPDATE catalog.product_variants SET is_active=false WHERE id=1");
    await supersedeAvailabilityClaim(pool(),claim,false);
    expect((await database.pool.query("SELECT status,desired_active,lease_token,last_error FROM channels.channel_variant_availability_sync WHERE product_variant_id=1")).rows[0])
      .toMatchObject({ status: "needs_review",desired_active: true,lease_token: null });
    expect((await database.pool.query("SELECT disposition,before_state,after_state FROM channels.channel_variant_availability_decisions WHERE product_variant_id=1 ORDER BY id DESC LIMIT 1")).rows[0])
      .toMatchObject({ disposition: "prior_work_unconfirmed",before_state: { status: "processing" },after_state: { status: "needs_review" } });
    await database.pool.query("UPDATE catalog.product_variants SET is_active=true WHERE id=1");
    expect((await database.pool.query("SELECT status,desired_active FROM channels.channel_variant_availability_sync WHERE product_variant_id=1")).rows[0])
      .toEqual({ status: "needs_review",desired_active: true });
    expect((await database.pool.query("SELECT desired_active FROM channels.channel_variant_availability_followups WHERE product_variant_id=1")).rows)
      .toEqual([{ desired_active: true }]);
    await expect(database.pool.query("DELETE FROM channels.channel_variant_availability_decisions")).rejects.toMatchObject({ code: "55000" });
  });
  it("keeps a newer stock repair behind an unconfirmed legacy request", async () => {
    await database.pool.query("UPDATE channels.channel_variant_availability_sync SET enqueued_revision=NULL,request_kind=NULL WHERE product_variant_id=1");
    await enqueueVariantAvailabilitySync(pool(), { channelId: 1,productVariantId: 1,desiredActive: false,requestKind: "stock_repair" });
    await database.pool.query("UPDATE catalog.product_variants SET is_active=false WHERE id=1");
    await supersedeAvailabilityClaim(pool(),claim,false);
    expect((await database.pool.query("SELECT status,revision FROM channels.channel_variant_availability_sync WHERE product_variant_id=1")).rows[0])
      .toEqual({ status: "needs_review",revision: "1" });
    expect((await database.pool.query("SELECT desired_active,request_kind FROM channels.channel_variant_availability_followups WHERE product_variant_id=1")).rows)
      .toEqual([{ desired_active: false,request_kind: "stock_repair" }]);
  });
  it("rejects a replan if catalog state changed after the worker's read", async () => {
    await database.pool.query("UPDATE catalog.product_variants SET is_active=false WHERE id=1");
    await expect(supersedeAvailabilityClaim(pool(),claim,true)).rejects.toMatchObject({ code: "40001" });
    expect((await database.pool.query("SELECT status,lease_token FROM channels.channel_variant_availability_sync WHERE product_variant_id=1")).rows[0])
      .toEqual({ status: "processing",lease_token: lease });
  });
  it("does not attribute an older writer's replacement to a recorded request kind", async () => {
    await database.pool.query(`UPDATE channels.channel_variant_availability_sync
      SET desired_active=false,request_kind='stock_repair',enqueued_revision=1,revision=2,status='pending',
        attempt_count=0,lease_token=NULL,lease_expires_at=NULL,next_attempt_at=transaction_timestamp() WHERE product_variant_id=1`);
    const [legacyClaim] = await claimVariantAvailabilitySyncs(pool(), { batchSize: 1,leaseSeconds: 60 });
    expect(legacyClaim).toMatchObject({ desiredActive: false,revision: 2,requestKind: null });
    await database.pool.query("UPDATE catalog.product_variants SET is_active=false WHERE id=1");
    await supersedeAvailabilityClaim(pool(),legacyClaim,false);
    expect((await database.pool.query("SELECT status FROM channels.channel_variant_availability_sync WHERE product_variant_id=1")).rows[0])
      .toEqual({ status: "needs_review" });
  });
  it("cancels only a proven first unsent claim when archive supersedes it", async () => {
    await database.pool.query("UPDATE channels.channel_variant_availability_sync SET attempt_count=1,enqueued_revision=revision WHERE product_variant_id=1");
    await database.pool.query("UPDATE catalog.product_variants SET is_active=false WHERE id=1");
    await supersedeAvailabilityClaim(pool(),claim,false);
    expect((await database.pool.query("SELECT status,desired_active FROM channels.channel_variant_availability_sync WHERE product_variant_id=1")).rows[0])
      .toEqual({ status: "cancelled",desired_active: true });
    expect((await database.pool.query("SELECT disposition FROM channels.channel_variant_availability_decisions WHERE product_variant_id=1 ORDER BY id DESC LIMIT 1")).rows[0])
      .toEqual({ disposition: "cancelled_before_dispatch" });
  });
  it("retains an earlier requested zero repair when the catalog is archived during a claim", async () => {
    await enqueueVariantAvailabilitySync(pool(), { channelId: 1,productVariantId: 1,desiredActive: false,requestKind: "stock_repair" });
    await database.pool.query("UPDATE catalog.product_variants SET is_active=false WHERE id=1");
    await supersedeAvailabilityClaim(pool(),claim,false);
    expect((await database.pool.query("SELECT status,desired_active,revision,request_kind FROM channels.channel_variant_availability_sync WHERE product_variant_id=1")).rows[0])
      .toEqual({ status: "pending",desired_active: false,revision: "2",request_kind: "stock_repair" });
    expect((await database.pool.query("SELECT 1 FROM channels.channel_variant_availability_followups WHERE product_variant_id=1")).rowCount).toBe(0);
  });
  it("coalesces feed and listing inserts in one transaction without a duplicate follow-up", async () => {
    await database.pool.query(`INSERT INTO catalog.product_variants VALUES(3,1,true);
      BEGIN;
      INSERT INTO channels.channel_feeds(channel_id,product_variant_id) VALUES(1,3);
      INSERT INTO channels.channel_listings(channel_id,product_variant_id) VALUES(1,3);
      COMMIT;`);
    expect((await database.pool.query("SELECT status,revision FROM channels.channel_variant_availability_sync WHERE product_variant_id=3")).rows[0])
      .toEqual({ status: "pending",revision: "1" });
    expect((await database.pool.query("SELECT 1 FROM channels.channel_variant_availability_followups WHERE product_variant_id=3")).rowCount).toBe(0);
  });
  it("does not create a legacy eBay queue entry for another provider or an archived parent", async () => {
    await database.pool.query(`INSERT INTO channels.channels VALUES(2,'shopify');
      INSERT INTO catalog.products VALUES(2,false,'archived');
      INSERT INTO catalog.product_variants VALUES(3,1,true),(4,2,true);
      INSERT INTO channels.channel_listings(channel_id,product_variant_id) VALUES(2,3),(1,4);`);
    expect((await database.pool.query("SELECT channel_id,product_variant_id FROM channels.channel_variant_availability_sync ORDER BY product_variant_id")).rows)
      .toEqual([{ channel_id: 1,product_variant_id: 1 }]);
  });
  it("recovers a follow-up after an older worker completes without promoting it", async () => {
    await enqueueVariantAvailabilitySync(pool(), { channelId: 1,productVariantId: 1,desiredActive: true,requestKind: "catalog_activation" });
    await database.pool.query(`UPDATE channels.channel_variant_availability_sync SET status='synced',
      lease_token=NULL,lease_expires_at=NULL WHERE product_variant_id=1`);
    const first = (await database.pool.query<{ n: number }>("SELECT channels.promote_completed_availability_followups(25,transaction_timestamp()) AS n")).rows[0].n;
    const second = (await database.pool.query<{ n: number }>("SELECT channels.promote_completed_availability_followups(25,transaction_timestamp()) AS n")).rows[0].n;
    expect([first,second]).toEqual([1,0]);
    expect((await database.pool.query("SELECT status,revision,desired_active FROM channels.channel_variant_availability_sync WHERE product_variant_id=1")).rows[0])
      .toEqual({ status: "pending",revision: "2",desired_active: true });
  });
  it("does not promote an old-worker reactivation follow-up after a later archive", async () => {
    await enqueueVariantAvailabilitySync(pool(), { channelId: 1,productVariantId: 1,desiredActive: true,requestKind: "catalog_activation" });
    await database.pool.query(`UPDATE catalog.product_variants SET is_active=false WHERE id=1;
      UPDATE channels.channel_variant_availability_sync SET status='synced',lease_token=NULL,lease_expires_at=NULL WHERE product_variant_id=1`);
    expect((await database.pool.query<{ n: number }>("SELECT channels.promote_completed_availability_followups(25,transaction_timestamp()) AS n")).rows[0].n).toBe(1);
    expect((await database.pool.query("SELECT status,revision FROM channels.channel_variant_availability_sync WHERE product_variant_id=1")).rows[0])
      .toEqual({ status: "synced",revision: "1" });
    expect((await database.pool.query("SELECT operation,reason,before_state FROM channels.channel_variant_availability_followup_events WHERE product_variant_id=1 ORDER BY id DESC LIMIT 1")).rows[0])
      .toMatchObject({ operation: "DELETE",reason: "archived_before_dispatch",before_state: { desired_active: true } });
  });
});
