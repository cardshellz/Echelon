import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { config as loadEnv } from "dotenv";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WorkConfigurationRepository } from "../../work/infrastructure/work-configuration.repository";
import { WorkConfigurationService } from "../../work/application/work-configuration.service";
import { AssemblyWorkRepository } from "../../work/infrastructure/assembly-work.repository";
import { AssemblyWorkOwner } from "../../work/application/assembly-work-owner";
import { AssemblyWorkService } from "../../work/application/assembly-work.service";
import { lockAssemblyClaimForWork } from "../../../inventory-planning/application/assembly-work-claim-access";
import { recordAssemblyOutputPickLocation } from "../../../wms/assembly-output-pick-command";
import { config, start, TIME } from "../assembly-work.fixture";

loadEnv({ path: resolve(process.cwd(), ".env.test") });
const databaseUrl = process.env.ECHELON_TEST_DATABASE_URL;
const disposable = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
const databaseSuite = databaseUrl && disposable ? describe.sequential : describe.skip;

databaseSuite("assembly work PostgreSQL ownership and atomicity", () => {
  let pool: Pool;
  let repository: WorkConfigurationRepository;
  let owner: AssemblyWorkOwner;
  let service: AssemblyWorkService;
  let setup: WorkConfigurationService;
  let nextWarehouse = 100;
  const schemas = { warehouse: `assembly_warehouse_${process.pid}`, identity: `assembly_identity_${process.pid}`, inventory: `assembly_inventory_${process.pid}`, wms: `assembly_wms_${process.pid}` };
  const rewrite = (sql: string) => Object.entries(schemas).reduce((text, [from, to]) => text.replaceAll(`${from}.`, `"${to}".`), sql);
  async function query(sql: string, values: unknown[] = []) { return pool.query(rewrite(sql), values); }
  async function connect(): Promise<PoolClient> {
    const client = await pool.connect();
    return { query: (sql: string, values?: unknown[]) => client.query(rewrite(sql), values), release: (error?: Error) => client.release(error) } as unknown as PoolClient;
  }
  beforeAll(async () => {
    if (!databaseUrl || !disposable) throw new Error("Explicit disposable PostgreSQL required");
    const target = new URL(databaseUrl);
    for (const protectedUrl of [process.env.DATABASE_URL, process.env.EXTERNAL_DATABASE_URL].filter((url): url is string => !!url)) {
      const protectedTarget = new URL(protectedUrl);
      if (target.hostname === protectedTarget.hostname && (target.port || "5432") === (protectedTarget.port || "5432") && target.pathname === protectedTarget.pathname) {
        throw new Error("Cannot use an application database as the test database");
      }
    }
    pool = new Pool({ connectionString: databaseUrl, max: 8, ssl: /^(localhost|127\.0\.0\.1|\[::1\])$/.test(target.hostname) ? false : { rejectUnauthorized: false } });
    for (const name of Object.values(schemas)) {
      if (!/^assembly_(warehouse|identity|inventory|wms)_[0-9]+$/.test(name)) throw new Error("Unsafe test schema name");
      await pool.query(`CREATE SCHEMA "${name}"`);
    }
    await query(`
      CREATE TABLE warehouse.warehouses (id integer PRIMARY KEY, code text UNIQUE NOT NULL, name text NOT NULL, is_active integer NOT NULL DEFAULT 1, warehouse_type text NOT NULL DEFAULT 'operations');
      CREATE TABLE warehouse.warehouse_locations (id integer PRIMARY KEY, warehouse_id integer REFERENCES warehouse.warehouses(id), code text NOT NULL, zone text, is_active integer NOT NULL DEFAULT 1);
      CREATE TABLE identity.users (id varchar PRIMARY KEY, username text NOT NULL, display_name text, active integer NOT NULL DEFAULT 1);
      CREATE TABLE identity.auth_permissions (id serial PRIMARY KEY, resource text NOT NULL, action text NOT NULL);
      CREATE TABLE identity.auth_roles (id integer PRIMARY KEY);
      CREATE TABLE identity.auth_user_roles (id serial PRIMARY KEY, user_id varchar REFERENCES identity.users(id), role_id integer REFERENCES identity.auth_roles(id));
      CREATE TABLE identity.auth_role_permissions (id serial PRIMARY KEY, role_id integer REFERENCES identity.auth_roles(id), permission_id integer REFERENCES identity.auth_permissions(id), constraints jsonb);
      CREATE TABLE inventory.availability_claims (id bigint PRIMARY KEY, status text NOT NULL);
      CREATE TABLE inventory.availability_claim_operations (id bigint PRIMARY KEY, claim_id bigint REFERENCES inventory.availability_claims(id), UNIQUE(id,claim_id));
      CREATE TABLE wms.orders (id integer PRIMARY KEY, warehouse_status text NOT NULL, on_hold integer DEFAULT 0, assigned_picker_id varchar);
      CREATE TABLE wms.order_items (id integer PRIMARY KEY, order_id integer REFERENCES wms.orders(id), status text NOT NULL, on_hold boolean NOT NULL DEFAULT false, requires_shipping integer NOT NULL DEFAULT 1, location varchar(50), zone varchar(10));
      -- Test-only stand-in for an upstream owner's posting, NOT an inventory simulation.
      CREATE TABLE inventory.work_test_postings (claim_id bigint NOT NULL);
      INSERT INTO identity.users(id,username) VALUES ('admin','admin'),('picker','picker'),('assembler','assembler'),('other','other');
      INSERT INTO identity.auth_roles VALUES (1),(2),(3),(4);
      INSERT INTO identity.auth_user_roles(user_id,role_id) VALUES ('admin',1),('picker',2),('assembler',3),('other',4);
      INSERT INTO identity.auth_permissions(resource,action) VALUES ('warehouse_work','view'),('warehouse_work','configure'),('warehouse_work','manage_access'),('warehouse_work','assembly'),('warehouse_work','picking');
      INSERT INTO identity.auth_role_permissions(role_id,permission_id) SELECT r.id,p.id FROM identity.auth_roles r CROSS JOIN identity.auth_permissions p;
    `);
    await query(readFileSync(resolve(process.cwd(), "migrations/0655_warehouse_work_configuration.sql"), "utf8"));
    await query(readFileSync(resolve(process.cwd(), "migrations/0656_warehouse_assembly_work.sql"), "utf8"));
    repository = new WorkConfigurationRepository({ connect } as Pick<Pool, "connect">);
    owner = new AssemblyWorkOwner(repository, new AssemblyWorkRepository());
    // Physical inventory math is covered by the real canonical owner tests;
    // this suite exercises the actual work SQL, identity, locks and transactions.
    const unavailable = async (): Promise<never> => { throw new Error("Canonical posting must not be called by a work-state command"); };
    service = new AssemblyWorkService(owner, () => new Date(TIME), { handoffBuildOperation: unavailable, executeBuildOperation: unavailable });
    setup = new WorkConfigurationService(repository, () => new Date(TIME));
  });
  afterAll(async () => {
    if (!pool) return;
    for (const name of Object.values(schemas)) {
      if (!/^assembly_(warehouse|identity|inventory|wms)_[0-9]+$/.test(name)) throw new Error("Unsafe test schema cleanup");
      await pool.query(`DROP SCHEMA IF EXISTS "${name}" CASCADE`);
    }
    await pool.end();
  });
  async function fixture() {
    const id = ++nextWarehouse;
    const configuration = config();
    configuration.stations[0].id = randomUUID();
    configuration.stations[0].locationId = id * 10 + 1;
    configuration.stations[0].assemblyBindings = { materialLocationIds: [id * 10 + 2], outputLocationId: id * 10 + 3 };
    await query("INSERT INTO warehouse.warehouses(id,code,name) VALUES ($1,$2,$2)", [id, `W${id}`]);
    await query("INSERT INTO warehouse.warehouse_locations(id,warehouse_id,code,zone) VALUES ($1,$4,'BENCH','PACK'),($2,$4,'MATERIALS','PACK'),($3,$4,'OUTPUT','PACK')", [id * 10 + 1, id * 10 + 2, id * 10 + 3, id]);
    await query("INSERT INTO inventory.availability_claims(id,status) VALUES ($1,'active')", [id]);
    await query("INSERT INTO wms.orders(id,warehouse_status) VALUES ($1,'in_progress')", [id]);
    await query("INSERT INTO wms.order_items(id,order_id,status) VALUES ($1,$2,'pending')", [id * 10, id]);
    await query("INSERT INTO inventory.availability_claim_operations(id,claim_id) VALUES ($1,$2)", [id * 10, id]);
    await setup.save("admin", id, { expectedRevision: 0, commandId: randomUUID(), reason: "Configure explicit local assembly", configuration });
    const evidence = { warehouseId: id, claimId: String(id), claimOperationId: String(id * 10), operationKey: `build:${id}`,
      orderId: id, orderItemId: id * 10, buildOrderId: id, buildSystemNumber: `BLD-${id}`, destinationVariantId: 105,
      outputQty: "2", outputLocationId: id * 10 + 3, inputs: [{ variantId: 101, quantity: "10" }], sourceLocationIds: [id * 10 + 2],
      actorId: "picker", reason: "Hand off physical job", commandKey: `handoff:${id}`, requestHash: "a".repeat(64), occurredAt: TIME,
      route: { warehouseId: id, stationId: configuration.stations[0].id, configurationRevision: 1, acknowledgeWorkOnlyHandoff: true as const } };
    const task = await repository.transaction(async (client) => { await lockAssemblyClaimForWork(client, String(id)); return owner.handoff(client, evidence); });
    const startCommand = { ...start(), commandId: randomUUID(), receivedBuildSystemNumber: task.buildSystemNumber };
    return { id, configuration, evidence, task, startCommand };
  }
  async function eventCount(taskId: string) {
    return Number((await query("SELECT count(*) FROM warehouse.work_item_events WHERE work_item_id=$1", [taskId])).rows[0].count);
  }
  async function completion(f: Awaited<ReturnType<typeof fixture>>, expectedVersion: number) {
    return repository.transaction(async (client) => {
      await lockAssemblyClaimForWork(client, f.task.claimId);
      await client.query("INSERT INTO inventory.work_test_postings(claim_id) VALUES ($1)", [f.task.claimId]);
      await owner.recordCompletion(client, { claimOperationId: f.task.claimOperationId, producedQty: "2", actorId: "assembler",
        fence: { taskId: f.task.id, expectedVersion, completedOutputQty: "2", confirmPhysicalAssembly: true },
        reason: "Actual assembly complete", commandKey: `complete:${f.id}`, requestHash: "b".repeat(64), occurredAt: TIME });
    });
  }
  it("persists a work-only handoff, exact routing snapshot, and no presumed receipt", async () => {
    const f = await fixture();
    expect(f.task).toMatchObject({ state: "queued", assignedTo: null, receivedAt: null, outputQty: "2", configurationRevision: 1 });
    expect(await eventCount(f.task.id)).toBe(1);
    expect((await service.queue("assembler", { warehouseId: f.id })).tasks.map((task) => task.id)).toEqual([f.task.id]);
  });
  it("uses boolean item holds and rolls back output-pick WMS evidence on failure", async () => {
    const f = await fixture();
    const configuration = structuredClone(f.configuration);
    configuration.access.find((entry) => entry.userId === "assembler")!.capabilities.push("picking");
    await setup.save("admin", f.id, { expectedRevision: 1, commandId: randomUUID(), reason: "Permit finished output picking", configuration });
    await service.command("assembler", f.task.id, f.startCommand); await completion(f, 2);
    const evidence = { fence: { taskId: f.task.id, expectedVersion: 3, confirmPhysicalOutput: true as const },
      claimId: f.task.claimId, orderId: f.task.orderId, orderItemId: f.task.orderItemId, variantId: 105,
      locationId: f.id * 10 + 3, quantity: "2", actorId: "assembler", producerOperationKeys: [f.task.operationKey] };
    await query("UPDATE wms.order_items SET on_hold=true WHERE id=$1", [f.task.orderItemId]);
    await expect(repository.transaction((client) => owner.authorizeOutputPick(client, evidence))).rejects.toMatchObject({ code: "WORK_ORDER_NOT_EXECUTABLE" });
    await query("UPDATE wms.order_items SET on_hold=false WHERE id=$1", [f.task.orderItemId]);
    await expect(repository.transaction(async (client) => {
      const location = await owner.authorizeOutputPick(client, evidence);
      await client.query("UPDATE wms.order_items SET status='completed' WHERE id=$1", [f.task.orderItemId]);
      await recordAssemblyOutputPickLocation(client, { orderId: f.task.orderId, orderItemId: f.task.orderItemId, ...location });
      throw new Error("Simulated receipt persistence failure");
    })).rejects.toThrow("Simulated receipt persistence failure");
    expect((await query("SELECT status,location,zone FROM wms.order_items WHERE id=$1", [f.task.orderItemId])).rows[0])
      .toEqual({ status: "pending", location: null, zone: null });
  });
  it("lets exactly one competing employee claim/start the job", async () => {
    const f = await fixture();
    const outcomes = await Promise.allSettled([service.command("assembler", f.task.id, f.startCommand), service.command("other", f.task.id, { ...f.startCommand, commandId: randomUUID() })]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.find((outcome) => outcome.status === "rejected")).toMatchObject({ reason: { code: "WORK_TASK_VERSION_CONFLICT" } });
    expect(await eventCount(f.task.id)).toBe(2);
  });
  it("serializes duplicate retries and binds the receipt to employee, task and payload", async () => {
    const f = await fixture();
    const results = await Promise.all([service.command("assembler", f.task.id, f.startCommand), service.command("assembler", f.task.id, f.startCommand)]);
    expect(results[0].task).toEqual(results[1].task);
    expect(results.map((result) => result.idempotentReplay).sort()).toEqual([false, true]);
    await expect(service.command("other", f.task.id, f.startCommand)).rejects.toMatchObject({ code: "WORK_COMMAND_REUSED" });
    await expect(service.command("assembler", f.task.id, { ...f.startCommand, reason: "Changed body" })).rejects.toMatchObject({ code: "WORK_COMMAND_REUSED" });
    expect(await eventCount(f.task.id)).toBe(2);
  });
  it("rolls back upstream posting and work evidence when the completion fence is stale", async () => {
    const f = await fixture(); await service.command("assembler", f.task.id, f.startCommand);
    await expect(completion(f, 1)).rejects.toMatchObject({ code: "WORK_TASK_VERSION_CONFLICT" });
    expect((await query("SELECT * FROM inventory.work_test_postings WHERE claim_id=$1", [f.task.claimId])).rowCount).toBe(0);
    expect((await service.get("assembler", f.task.id)).state).toBe("in_progress");
    expect(await eventCount(f.task.id)).toBe(2);
    await completion(f, 2);
    expect((await query("SELECT * FROM inventory.work_test_postings WHERE claim_id=$1", [f.task.claimId])).rowCount).toBe(1);
    expect((await service.get("assembler", f.task.id)).state).toBe("completed");
  });
  it("retains started/blocked ownership and refuses generic claim cancellation", async () => {
    const f = await fixture(); await service.command("assembler", f.task.id, f.startCommand);
    await service.command("assembler", f.task.id, { action: "block", commandId: randomUUID(), expectedVersion: 2, reason: "Missing material" });
    await expect(repository.transaction(async (client) => {
      await lockAssemblyClaimForWork(client, f.task.claimId);
      await owner.cancelUnstarted(client, { claimId: f.task.claimId, actorId: "system:cancel", reason: "Order cancelled",
        commandKey: `cancel:${f.id}`, requestHash: "c".repeat(64), occurredAt: TIME });
    })).rejects.toMatchObject({ code: "WORK_PHYSICAL_RECOVERY_REQUIRED" });
    expect((await service.get("assembler", f.task.id))).toMatchObject({ state: "blocked", assignedTo: "assembler", version: 3 });
  });
  it("cancels unstarted work under the claim lock and prevents late start", async () => {
    const f = await fixture();
    await repository.transaction(async (client) => {
      await lockAssemblyClaimForWork(client, f.task.claimId);
      await owner.cancelUnstarted(client, { claimId: f.task.claimId, actorId: "system:cancel", reason: "Order cancelled",
        commandKey: `cancel:${f.id}`, requestHash: "c".repeat(64), occurredAt: TIME });
      await client.query("UPDATE inventory.availability_claims SET status='cancelled' WHERE id=$1", [f.task.claimId]);
    });
    await expect(service.command("assembler", f.task.id, f.startCommand)).rejects.toMatchObject({ code: "WORK_CLAIM_NOT_ACTIVE" });
    expect((await service.get("assembler", f.task.id)).state).toBe("cancelled");
  });
  it("blocks new starts at paused stations but allows already-started completion", async () => {
    const f = await fixture(); await service.command("assembler", f.task.id, f.startCommand);
    const next = structuredClone(f.configuration); next.stations[0].enabled = false; next.profile.assemblyPacking = "separate";
    await setup.save("admin", f.id, { expectedRevision: 1, commandId: randomUUID(), reason: "Pause new work", configuration: next });
    await completion(f, 2);
    expect((await service.get("assembler", f.task.id)).profile.assemblyPacking).toBe("combined");
    const queued = await fixture(); const paused = structuredClone(queued.configuration); paused.stations[0].enabled = false;
    await setup.save("admin", queued.id, { expectedRevision: 1, commandId: randomUUID(), reason: "Pause new work", configuration: paused });
    await expect(service.command("assembler", queued.task.id, queued.startCommand)).rejects.toMatchObject({ code: "WORK_STATION_NOT_ACCEPTING_WORK" });
  });
  it("enforces immutable audit/identity and rejects duplicate operation work", async () => {
    const f = await fixture();
    await expect(query("UPDATE warehouse.work_item_events SET reason='tamper' WHERE work_item_id=$1", [f.task.id])).rejects.toMatchObject({ code: "55000" });
    await expect(query("DELETE FROM warehouse.work_items WHERE id=$1", [f.task.id])).rejects.toMatchObject({ code: "55000" });
    await expect(query("UPDATE warehouse.work_items SET context='{}', version=version+1 WHERE id=$1", [f.task.id])).rejects.toMatchObject({ code: "55000" });
    await expect(query("UPDATE warehouse.work_stations SET location_id=$1 WHERE id=$2", [f.id * 10 + 3, f.task.station.id])).rejects.toMatchObject({ code: "23514" });
    await expect(repository.transaction(async (client) => { await lockAssemblyClaimForWork(client, f.task.claimId); await owner.handoff(client, f.evidence); }))
      .rejects.toMatchObject({ code: "WORK_TASK_ALREADY_EXISTS" });
  });
  it("rejects a wrong physical job reference without assigning or starting work", async () => {
    const f = await fixture();
    await expect(service.command("assembler", f.task.id, { ...f.startCommand, receivedBuildSystemNumber: "wrong-label" })).rejects.toMatchObject({ code: "WORK_HANDOFF_MISMATCH" });
    expect((await service.get("assembler", f.task.id)).state).toBe("queued");
    expect(await eventCount(f.task.id)).toBe(1);
  });
  it("does not start work after a hold; blocking observations remain recordable", async () => {
    const f = await fixture();
    await query("UPDATE wms.order_items SET on_hold=true WHERE id=$1", [f.task.orderItemId]);
    await expect(service.command("assembler", f.task.id, f.startCommand)).rejects.toMatchObject({ code: "WORK_ORDER_NOT_EXECUTABLE" });
    await query("UPDATE wms.order_items SET on_hold=false WHERE id=$1", [f.task.orderItemId]);
    await service.command("assembler", f.task.id, f.startCommand);
    await query("UPDATE wms.orders SET on_hold=1 WHERE id=$1", [f.task.orderId]);
    await expect(service.command("assembler", f.task.id, { action: "block", commandId: randomUUID(), expectedVersion: 2, reason: "Order hold noticed" }))
      .resolves.toMatchObject({ task: { state: "blocked" } });
  });
});
