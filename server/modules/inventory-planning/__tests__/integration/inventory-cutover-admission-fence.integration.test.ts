import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createInventoryCutoverTestDatabase, type InventoryCutoverTestDatabase } from "../../../inventory/__tests__/fixtures/inventory-cutover-database";
import { installCutoverAdmissionFixturePrerequisites } from "../fixtures/inventory-cutover-admission.fixture";
import { acquireInventoryCutoverFenceInsideTransaction, assertInventoryCutoverFenceHeldInsideTransaction } from "../../infrastructure/inventory-cutover-admission-fence.repository";
import { INVENTORY_CUTOVER_CONFIGURATION_TABLES, INVENTORY_CUTOVER_OPERATIONAL_TABLES } from "../../domain/inventory-cutover-admission-fence";

const URL = process.env.ECHELON_TEST_DATABASE_URL;
const DISPOSABLE = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
const databaseDescribe = URL && DISPOSABLE ? describe : describe.skip;
const migration = readFileSync(resolve(process.cwd(), "migrations/236_inventory_cutover_admission.sql"), "utf8");
const legacyMigration = readFileSync(resolve(process.cwd(), "migrations/0638_inventory_availability_cutover.sql"), "utf8");
const ALL_TABLES = [...INVENTORY_CUTOVER_CONFIGURATION_TABLES, ...INVENTORY_CUTOVER_OPERATIONAL_TABLES];
const REQUEST = { expectedAuthority: "legacy" as const, expectedConfigurationRunId: null };

databaseDescribe("actual migration236 cutover admission fence", () => {
  let database: InventoryCutoverTestDatabase;
  const connections = new Set<PoolClient>();
  async function connect(): Promise<PoolClient> {
    const client = await database.pool.connect(); connections.add(client);
    await client.query("SET statement_timeout = '4s'");
    return client;
  }
  async function begin(client: PoolClient, isolation = "READ COMMITTED") {
    await client.query(`BEGIN TRANSACTION ISOLATION LEVEL ${isolation}`);
  }
  async function acquire(client: PoolClient, run: string | null = null) {
    return acquireInventoryCutoverFenceInsideTransaction(client, { ...REQUEST, expectedConfigurationRunId: run });
  }
  async function prepare(client: PoolClient) {
    await begin(client); await acquire(client);
    await client.query("INSERT INTO inventory.availability_activation_freezes(activation_run_id,released_at) VALUES (7,NULL)");
    await client.query("COMMIT");
  }
  async function waitForLock(pid: number) {
    const deadline = Date.now() + 2500;
    while (Date.now() < deadline) {
      const row = (await database.pool.query("SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1", [pid])).rows[0];
      if (row?.wait_event_type === "Lock") return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`Connection ${pid} did not reach its expected database lock wait`);
  }

  beforeAll(async () => {
    database = await createInventoryCutoverTestDatabase(URL, DISPOSABLE, "SELECT 1");
    await installCutoverAdmissionFixturePrerequisites(database.pool);
    await database.pool.query("INSERT INTO inventory.availability_runtime_authority(singleton_key,authority,revision) VALUES(true,'legacy',1)");
    // Install the actual previous configuration function/triggers, then prove
    // migration236 replaces their GUC bypass without removing unrelated guards.
    const start = legacyMigration.indexOf("CREATE OR REPLACE FUNCTION inventory.guard_cutover_configuration_write()");
    const end = legacyMigration.indexOf("COMMENT ON TABLE inventory.availability_runtime_authority", start);
    await database.pool.query(legacyMigration.slice(start, end > start ? end : legacyMigration.indexOf("COMMENT ON TABLE", start)));
    await database.pool.query(migration);
  }, 30_000);

  beforeEach(async () => {
    const client = await database.pool.connect();
    try {
      await begin(client);
      const open = (await client.query("SELECT activation_run_id::text FROM inventory.availability_activation_freezes WHERE released_at IS NULL")).rows[0];
      const authority = (await client.query("SELECT authority FROM inventory.availability_runtime_authority WHERE singleton_key=true")).rows[0].authority;
      await acquireInventoryCutoverFenceInsideTransaction(client, { expectedAuthority: authority, expectedConfigurationRunId: open?.activation_run_id ?? null });
      await client.query("DELETE FROM inventory.availability_activation_freezes");
      await client.query("UPDATE inventory.availability_runtime_authority SET authority='legacy',activation_run_id=NULL,revision=1");
      await client.query("DELETE FROM catalog.products; DELETE FROM catalog.product_variants; DELETE FROM inventory.inventory_levels; DELETE FROM channels.channel_connections; DELETE FROM dropship.dropship_store_connections");
      await client.query("INSERT INTO catalog.products(id,sku,name,inventory_strategy,is_active) VALUES(1,'EA','Each','physical_only',true)");
      await client.query("INSERT INTO catalog.product_variants(id,product_id,sku,units_per_variant) VALUES(1,1,'EA',1)");
      await client.query("INSERT INTO inventory.inventory_levels(id,variant_qty,reserved_qty,picked_qty,packed_qty) VALUES(1,10,0,0,0)");
      await client.query("INSERT INTO channels.channel_connections(id,channel_id,shop_domain,access_token,sync_status,metadata) VALUES(1,1,'example.test','test-token','ok','{\"environment\":\"sandbox\",\"siteId\":\"US\",\"merchantLocationKey\":\"main\",\"diagnostic\":1}')");
      await client.query("INSERT INTO dropship.dropship_store_connections(id,vendor_id,platform,external_account_id,provider_environment,access_token_ref,status) VALUES(1,1,'ebay','account-1','sandbox','test-ref','active')");
      await client.query("COMMIT");
    } finally { client.release(); }
  });
  afterEach(async () => {
    for (const client of connections) { try { await client.query("ROLLBACK"); } finally { client.release(); } }
    connections.clear();
  });
  afterAll(async () => { await database?.close(); });

  it("installs exactly all77 admission scopes and both owner control guards", async () => {
    const rows = (await database.pool.query(`SELECT ns.nspname || '.' || relation.relname AS name
      FROM pg_trigger trigger JOIN pg_class relation ON relation.oid=trigger.tgrelid
      JOIN pg_namespace ns ON ns.oid=relation.relnamespace WHERE trigger.tgname='aa_cutover_writer_admission'`)).rows;
    expect(rows.map((row) => row.name).sort()).toEqual([...ALL_TABLES].sort());
    expect(rows).toHaveLength(77);
    const control = await database.pool.query("SELECT count(*)::integer AS count FROM pg_trigger WHERE tgname='aa_cutover_control_owner'");
    expect(control.rows[0].count).toBe(2);
    const legacy = await database.pool.query("SELECT count(*)::integer AS count FROM pg_trigger WHERE tgname LIKE 'cutover_freeze_%'");
    expect(legacy.rows[0].count).toBe(0);
  });

  it("allows inactive configuration and operational writes without an owner", async () => {
    await database.pool.query("UPDATE catalog.product_variants SET units_per_variant=5 WHERE id=1");
    await database.pool.query("UPDATE inventory.inventory_levels SET variant_qty=11 WHERE id=1");
    for (const table of ALL_TABLES) await database.pool.query(`DELETE FROM ${table} WHERE false`);
    expect((await database.pool.query("SELECT variant_qty FROM inventory.inventory_levels WHERE id=1")).rows[0].variant_qty).toBe(11);
  });

  it("blocks every scoped statement NOWAIT while the exclusive owner holds admission", async () => {
    const owner = await connect(); await begin(owner); await acquire(owner);
    const writer = await connect();
    for (const table of ALL_TABLES) {
      await begin(writer);
      await expect(writer.query(`DELETE FROM ${table} WHERE false`)).rejects.toMatchObject({ code: "55P03" });
      await writer.query("ROLLBACK");
    }
  });

  it("holds ordinary writer admission through commit and refuses owner admission NOWAIT", async () => {
    const writer = await connect(); await begin(writer);
    await writer.query("UPDATE inventory.inventory_levels SET variant_qty=11 WHERE id=1");
    const owner = await connect(); await begin(owner);
    await expect(acquire(owner)).rejects.toMatchObject({ code: "55P03" });
    await owner.query("ROLLBACK"); await writer.query("COMMIT");
    await begin(owner); await acquire(owner);
    expect((await owner.query("SELECT variant_qty FROM inventory.inventory_levels WHERE id=1")).rows[0].variant_qty).toBe(11);
  });

  it("drains authority-first legacy work before RC recapture of its committed inventory", async () => {
    const writer = await connect(); await begin(writer, "REPEATABLE READ");
    await writer.query("SELECT * FROM inventory.availability_runtime_authority WHERE singleton_key=true FOR SHARE");
    await writer.query("UPDATE inventory.inventory_levels SET variant_qty=12 WHERE id=1");
    const owner = await connect(); await begin(owner);
    const pid = (await owner.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    const admitted = acquire(owner);
    await waitForLock(pid); await writer.query("COMMIT"); await admitted;
    expect((await owner.query("SELECT variant_qty FROM inventory.inventory_levels WHERE id=1")).rows[0].variant_qty).toBe(12);
  });

  it("breaks an admission-first writer/authority-first owner lock inversion without deadlock", async () => {
    const owner = await connect(); await begin(owner);
    await owner.query("SELECT * FROM inventory.availability_runtime_authority WHERE singleton_key=true FOR UPDATE");
    const writer = await connect(); await begin(writer);
    await writer.query("UPDATE inventory.inventory_levels SET variant_qty=12 WHERE id=1");
    const pid = (await writer.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    const authorityRead = writer.query("SELECT * FROM inventory.availability_runtime_authority WHERE singleton_key=true FOR SHARE");
    await waitForLock(pid);
    await expect(acquire(owner)).rejects.toMatchObject({ code: "55P03" });
    await owner.query("ROLLBACK"); await authorityRead;
  });

  it.each(["REPEATABLE READ", "SERIALIZABLE"])("rejects a pre-freeze %s snapshot even on harmless metadata writes", async (isolation) => {
    const stale = await connect(); await begin(stale, isolation);
    await stale.query("SELECT count(*) FROM catalog.products");
    await prepare(await connect());
    await expect(stale.query("UPDATE catalog.products SET name='renamed' WHERE id=1")).rejects.toMatchObject({ code: "40001" });
  });

  it("rejects semantic changes under the durable freeze but permits token/status/unrelated metadata refresh", async () => {
    await prepare(await connect());
    await database.pool.query("UPDATE channels.channel_connections SET access_token='refreshed',sync_status='error',metadata=metadata || '{\"diagnostic\":2}'::jsonb WHERE id=1");
    await database.pool.query("UPDATE dropship.dropship_store_connections SET access_token_ref='refreshed-ref',status='error' WHERE id=1");
    await database.pool.query("UPDATE catalog.products SET name='new display name' WHERE id=1");
    await database.pool.query("UPDATE inventory.inventory_levels SET variant_qty=12 WHERE id=1");
    for (const sql of [
      "UPDATE channels.channel_connections SET shop_domain='other.test' WHERE id=1",
      "UPDATE channels.channel_connections SET metadata=metadata || '{\"environment\":\"production\"}'::jsonb WHERE id=1",
      "UPDATE channels.channel_connections SET metadata=metadata || '{\"siteId\":\"CA\"}'::jsonb WHERE id=1",
      "UPDATE channels.channel_connections SET metadata=metadata || '{\"merchantLocationKey\":\"other\"}'::jsonb WHERE id=1",
      "UPDATE dropship.dropship_store_connections SET external_account_id='other-account' WHERE id=1",
      "UPDATE catalog.product_variants SET units_per_variant=5 WHERE id=1",
      "INSERT INTO catalog.products(id,sku) VALUES(2,'P5')", "DELETE FROM catalog.products WHERE id=1", "TRUNCATE catalog.products",
    ]) await expect(database.pool.query(sql)).rejects.toMatchObject({ code: "55000", message: "CUTOVER_CONFIGURATION_FROZEN" });
  });

  it("does not trust a matching legacy activation-run GUC as freeze ownership", async () => {
    await prepare(await connect());
    const writer = await connect(); await begin(writer);
    await writer.query("SET LOCAL echelon.inventory_activation_run_id='7'");
    await expect(writer.query("UPDATE catalog.product_variants SET units_per_variant=5 WHERE id=1"))
      .rejects.toMatchObject({ code: "55000", message: "CUTOVER_CONFIGURATION_FROZEN" });
  });

  it("keeps the owner valid after same-transaction authority changes and freeze release", async () => {
    await prepare(await connect());
    const owner = await connect(); await begin(owner); const receipt = await acquire(owner, "7");
    await owner.query("UPDATE inventory.availability_runtime_authority SET authority='canonical',activation_run_id=7,revision=2");
    await owner.query("UPDATE inventory.availability_activation_freezes SET released_at=transaction_timestamp() WHERE activation_run_id=7");
    expect(await assertInventoryCutoverFenceHeldInsideTransaction(owner)).toBe(receipt.epoch);
    await owner.query("UPDATE catalog.product_variants SET units_per_variant=5 WHERE id=1");
  });

  it("rolls back the epoch, freeze and configuration together; old snapshots remain valid after rollback", async () => {
    const stale = await connect(); await begin(stale, "REPEATABLE READ");
    await stale.query("SELECT count(*) FROM catalog.products");
    const before = (await database.pool.query("SELECT epoch::text FROM inventory.cutover_admission_fence")).rows[0].epoch;
    const owner = await connect(); await begin(owner); await acquire(owner);
    await owner.query("INSERT INTO inventory.availability_activation_freezes(activation_run_id) VALUES(7)");
    await owner.query("UPDATE catalog.product_variants SET units_per_variant=5 WHERE id=1");
    await owner.query("ROLLBACK");
    expect((await database.pool.query("SELECT epoch::text FROM inventory.cutover_admission_fence")).rows[0].epoch).toBe(before);
    expect((await database.pool.query("SELECT count(*)::integer AS count FROM inventory.availability_activation_freezes")).rows[0].count).toBe(0);
    await stale.query("UPDATE catalog.products SET name='allowed after rollback' WHERE id=1");
    expect((await stale.query("SELECT units_per_variant FROM catalog.product_variants WHERE id=1")).rows[0].units_per_variant).toBe(1);
  });

  it.each(["UPDATE inventory.availability_runtime_authority SET revision=revision+1 WHERE singleton_key=true",
    "INSERT INTO inventory.availability_activation_freezes(activation_run_id) VALUES(7)",
    "DELETE FROM inventory.availability_activation_freezes", "TRUNCATE inventory.availability_activation_freezes",
  ])("requires current transaction ownership for control DML: %s", async (sql) => {
    await expect(database.pool.query(sql)).rejects.toMatchObject({ code: "55000", message: "CUTOVER_EXCLUSIVE_ADMISSION_REQUIRED" });
  });

  it("does not let another transaction reuse a committed owner xid", async () => {
    const prior = await connect(); await begin(prior); await acquire(prior); await prior.query("COMMIT");
    const other = await connect(); await begin(other);
    await expect(assertInventoryCutoverFenceHeldInsideTransaction(other)).rejects.toMatchObject({ code: "55000", message: "CUTOVER_EXCLUSIVE_ADMISSION_REQUIRED" });
  });

  it("cannot mint a direct owner row while an authority reader is in flight", async () => {
    const reader = await connect(); await begin(reader);
    await reader.query("SELECT * FROM inventory.availability_runtime_authority WHERE singleton_key=true FOR SHARE");
    const writer = await connect(); await begin(writer);
    await expect(writer.query("UPDATE inventory.cutover_admission_fence SET epoch=epoch+1,owner_transaction_id=pg_current_xact_id(),changed_at=transaction_timestamp()"))
      .rejects.toMatchObject({ code: "55P03" });
  });

  it.each(["REPEATABLE READ", "SERIALIZABLE", "READ COMMITTED READ ONLY"])("rejects cutover owner isolation %s", async (isolation) => {
    const client = await connect(); await begin(client, isolation);
    await expect(acquire(client)).rejects.toMatchObject({ code: "55000", message: "CUTOVER_READ_COMMITTED_TRANSACTION_REQUIRED" });
  });

  it("checks expected authority and existing freeze identity before owner epoch advancement", async () => {
    await prepare(await connect());
    const client = await connect(); await begin(client);
    await expect(acquire(client)).rejects.toMatchObject({ code: "55000", message: "CUTOVER_CONFIGURATION_FREEZE_CHANGED" });
    await client.query("ROLLBACK"); await begin(client);
    await expect(acquireInventoryCutoverFenceInsideTransaction(client, { expectedAuthority: "canonical", expectedConfigurationRunId: "7" }))
      .rejects.toMatchObject({ code: "55000", message: "CUTOVER_AUTHORITY_CHANGED" });
  });
});
