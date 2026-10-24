import { readFileSync } from "node:fs";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import express, { type Request } from "express";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "@shared/schema";
import { purchaseOrderEntryCommandResultSchema } from "@shared/procurement/purchase-order-entry-command";
import { validatePostgresTestEnvironment } from "../../../../../scripts/ci/postgres-tests";
import { fixtureForeignKeys, fixtureTable } from "./shipment-line-fixture";
import { supplierReturnReadFixtureTables } from "./supplier-return-fixture";

// Only the connection and session establishment are adapted. HTTP permissions,
// default command ledger, purchasing/catalog owners and audit SQL remain real.
const connection = vi.hoisted(() => ({ database: null as ReturnType<typeof drizzle<typeof schema>> | null }));
vi.mock("../../../../db", () => ({ db: new Proxy({}, { get(_target, property) {
  if (!connection.database) throw new Error("PO recovery fixture database not initialized");
  const value = Reflect.get(connection.database, property);
  return typeof value === "function" ? value.bind(connection.database) : value;
} }) }));
import { procurementMethods } from "../../procurement.storage";
import { productMethods } from "../../../catalog/catalog.storage";
import { createPurchasingService } from "../../purchasing.service";
import { registerPurchaseOrderRoutes } from "../../purchase-order.routes";
import { PURCHASE_ORDER_ENTRY_COMMAND_PRINCIPAL } from "../../purchase-order-entry.commands";

const TEST_URL = process.env.ECHELON_TEST_DATABASE_URL;
const integration = TEST_URL && process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true" ? describe : describe.skip;
const NOW = new Date("2026-10-24T12:00:00.000Z");
const ACTOR = "po-entry-buyer";
const TABLES = [schema.products, schema.productVariants, schema.vendors, schema.vendorProducts, schema.warehouses, schema.echelonSettings,
  schema.users, schema.authRoles, schema.authPermissions, schema.authUserRoles, schema.authRolePermissions,
  schema.purchaseOrders, schema.purchaseOrderLines, schema.poStatusHistory, schema.poEvents, schema.poRevisions, schema.poApprovalTiers,
  schema.warehouseSettings, schema.purchasingRecommendationPoHandoffs, schema.inboundShipments, schema.inboundShipmentLines,
  schema.receivingOrders, schema.receivingLines, schema.poReceipts, schema.vendorInvoices, schema.supplierCredits, schema.supplierCreditLines,
  ...supplierReturnReadFixtureTables, schema.supplierCreditApplications, schema.supplierCreditApplicationReversals, schema.vendorInvoiceLines,
  schema.vendorInvoicePoLinks, schema.landedCostSnapshots, schema.landedCostAdjustments, schema.inventoryLots];

interface HttpResult { status: number; body: unknown; replayed: string | undefined }
integration.sequential("purchase order entry HTTP and PostgreSQL recovery", () => {
  let pool: pg.Pool;
  let server: Server;
  let port: number;
  let app: express.Express;
  const ownedSchemas: string[] = [];
  const ownedPublic: string[] = [];
  const line = () => ({ client_id: "product-one", product_id: 10, product_variant_id: 100,
    expected_receive_variant_id: 100, expected_receive_units_per_variant: 1,
    quantity_ordered: 2, pricing_source: "manual", pricing: { basis: "per_piece", quantityPieces: 2, unitCostMills: 20_000 } });
  const input = () => ({ vendor_id: 2, warehouse_id: 3, vendor_notes: "Reviewed supplier terms", lines: [line()] });

  async function http(method: "POST" | "PUT", path: string, key: string, body: unknown, options: { lose?: boolean; actor?: string | null } = {}): Promise<HttpResult | null> {
    return new Promise((resolveResponse, reject) => {
      const payload = JSON.stringify(body);
      let lost = false;
      const actor = options.actor === undefined ? ACTOR : options.actor;
      const outgoing = request({ host: "127.0.0.1", port, path, method, headers: {
        "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload), "Idempotency-Key": key,
        ...(actor ? { "X-Test-Actor": actor } : {}),
      } }, incoming => {
        if (options.lose) {
          // Headers are sent after commit; the operator never receives the body.
          lost = true; incoming.destroy(); outgoing.destroy(); resolveResponse(null); return;
        }
        const chunks: Buffer[] = [];
        incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
        incoming.on("error", reject);
        incoming.on("end", () => {
          try {
            const replayed = incoming.headers["idempotency-replayed"];
            resolveResponse({ status: incoming.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
              replayed: typeof replayed === "string" ? replayed : undefined });
          } catch (error) { reject(error); }
        });
      });
      outgoing.setTimeout(15_000, () => outgoing.destroy(new Error("PO recovery HTTP timeout")));
      outgoing.on("error", error => { if (!lost) reject(error); });
      outgoing.end(payload);
    });
  }
  async function post(path: string, key: string, body: unknown = {}, actor?: string | null) {
    const response = await http("POST", path, key, body, { actor });
    if (!response) throw new Error("Expected PO response");
    return response;
  }
  async function create(name: string, body = input()) {
    const response = await post("/api/purchase-orders", `po-entry:${name}`, body);
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return purchaseOrderEntryCommandResultSchema.parse(response.body);
  }
  async function ledger(key: string) {
    return (await pool.query("SELECT * FROM public.financial_command_results WHERE actor_id=$1 AND idempotency_key=$2", [PURCHASE_ORDER_ENTRY_COMMAND_PRINCIPAL, key])).rows[0];
  }
  async function waitFor(predicate: () => Promise<boolean>, message: string) {
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      if (await predicate()) return;
      await new Promise(resolveWait => setTimeout(resolveWait, 20));
    }
    throw new Error(message);
  }
  async function counts() {
    return (await pool.query(`SELECT
      (SELECT count(*)::int FROM procurement.purchase_orders) AS orders,
      (SELECT count(*)::int FROM procurement.purchase_order_lines) AS lines,
      (SELECT count(*)::int FROM procurement.po_events) AS events,
      (SELECT count(*)::int FROM procurement.po_status_history) AS history`)).rows[0];
  }

  beforeAll(async () => {
    validatePostgresTestEnvironment(process.env);
    pool = new pg.Pool({ connectionString: TEST_URL, ssl: false, max: 8, statement_timeout: 15_000 });
    for (const name of ["catalog", "procurement", "warehouse", "inventory", "identity"]) {
      await pool.query(`CREATE SCHEMA ${name}`); ownedSchemas.push(name);
    }
    for (const table of TABLES) await pool.query(fixtureTable(table));
    await pool.query("CREATE UNIQUE INDEX po_entry_line_identity ON procurement.purchase_order_lines(purchase_order_id,id)");
    await pool.query("CREATE UNIQUE INDEX purchase_orders_po_number_unique ON procurement.purchase_orders(po_number)");
    for (const ddl of fixtureForeignKeys(TABLES)) await pool.query(ddl);
    const dialect = new PgDialect();
    for (const table of [schema.purchaseOrders, schema.purchaseOrderLines]) {
      const definition = getTableConfig(table);
      for (const check of definition.checks) {
        const expression = dialect.sqlToQuery(check.value);
        if (expression.params.length) throw new Error("Fixture check cannot contain parameters");
        const sqlText = expression.sql.replaceAll(`"${definition.schema}"."${definition.name}".`, "").replaceAll(`"${definition.name}".`, "");
        await pool.query(`ALTER TABLE "${definition.schema}"."${definition.name}" ADD CONSTRAINT "${check.name}" CHECK (${sqlText})`);
      }
    }
    const existing = (await pool.query("SELECT to_regclass('public.idempotency_keys') AS legacy,to_regclass('public.financial_command_results') AS commands,to_regclass('public.audit_events') AS audit")).rows[0];
    if (Object.values(existing).some(Boolean)) throw new Error("PO entry fixture requires empty public command/audit relations");
    await pool.query(fixtureTable(schema.auditEvents)); ownedPublic.push("audit_events");
    for (const migration of ["0085_idempotency_keys.sql", "136_financial_command_results.sql", "140_financial_command_operations.sql", "227_purchase_order_history_retention.sql"]) {
      await pool.query(readFileSync(resolve(process.cwd(), "migrations", migration), "utf8"));
    }
    ownedPublic.push("idempotency_keys", "financial_command_results", "financial_command_recoveries");
    await pool.query(`INSERT INTO identity.users(id,username,password,active) VALUES('${ACTOR}','buyer','unused',1),('other-buyer','other','unused',1);
      INSERT INTO identity.auth_roles(id,name) VALUES(1,'Buyer');
      INSERT INTO identity.auth_permissions(id,resource,action,category) VALUES(1,'purchasing','create','purchasing'),(2,'purchasing','edit','purchasing');
      INSERT INTO identity.auth_role_permissions(role_id,permission_id) VALUES(1,1),(1,2);
      INSERT INTO identity.auth_user_roles(user_id,role_id) VALUES('${ACTOR}',1),('other-buyer',1);
      INSERT INTO catalog.products(id,sku,name) VALUES(10,'ENTRY-PRODUCT','PO recovery product');
      INSERT INTO catalog.product_variants(id,product_id,sku,name,units_per_variant,uom_type,is_base_unit) VALUES(100,10,'ENTRY-EACH','Each',1,'each',true);
      INSERT INTO procurement.vendors(id,code,name,currency,payment_terms_days,payment_terms_type) VALUES(2,'ENTRY-SUPPLIER','Synthetic supplier','USD',30,'net');
      INSERT INTO warehouse.warehouses(id,code,name) VALUES(3,'ENTRY-DOCK','Receiving dock');
      INSERT INTO inventory.warehouse_settings(warehouse_code,require_approval) VALUES('DEFAULT',false)`);
    const database = drizzle(pool, { schema }); connection.database = database;
    const service = createPurchasingService(database, { ...procurementMethods, ...productMethods } as never, { now: () => NOW });
    app = express(); app.use(express.json());
    app.use((req, _res, next) => {
      const actorId = req.header("X-Test-Actor");
      req.session = { user: actorId ? { id: actorId, role: "admin" } : undefined } as Request["session"];
      next();
    });
    app.locals.services = { purchasing: service } as typeof app.locals.services;
    registerPurchaseOrderRoutes(app);
    server = createServer(app);
    await new Promise<void>((resolveStarted, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolveStarted(); }); });
    port = (server.address() as AddressInfo).port;
  }, 60_000);
  beforeEach(async () => {
    await pool.query(`UPDATE identity.users SET active=1;
      INSERT INTO identity.auth_role_permissions(role_id,permission_id) SELECT 1,1 WHERE NOT EXISTS(SELECT 1 FROM identity.auth_role_permissions WHERE role_id=1 AND permission_id=1);
      UPDATE inventory.warehouse_settings SET require_approval=false;
      DELETE FROM procurement.po_approval_tiers`);
  });
  afterAll(async () => {
    if (server) await new Promise<void>((resolveClosed, reject) => server.close(error => error ? reject(error) : resolveClosed()));
    connection.database = null;
    if (pool) {
      for (const name of ownedSchemas.reverse()) await pool.query(`DROP SCHEMA ${name} CASCADE`);
      for (const name of ownedPublic.reverse()) await pool.query(`DROP TABLE public.${name} CASCADE`);
      await pool.end();
    }
  });

  it("recovers a lost manual create response with the exact 201 result and one immutable event", async () => {
    const before = await counts(); const key = "po-entry:lost-create"; const body = input();
    expect(await http("POST", "/api/purchase-orders", key, body, { lose: true })).toBeNull();
    const saved = await ledger(key); expect(saved.status).toBe("succeeded");
    expect(await post("/api/purchase-orders", key, body)).toEqual({ status: 201, body: saved.response_body, replayed: "true" });
    const result = purchaseOrderEntryCommandResultSchema.parse(saved.response_body);
    expect(await counts()).toEqual({ orders: before.orders + 1, lines: before.lines + 1, events: before.events + 2, history: before.history + 1 });
    const audit = (await pool.query("SELECT * FROM procurement.po_events WHERE po_id=$1 AND event_type='entry_create'", [result.po.id])).rows[0];
    expect(audit).toMatchObject({ actor_id: ACTOR, created_at: NOW, payload_json: { before: null, command_key: key, after: { po: { id: result.po.id } } } });
    await expect(pool.query("UPDATE procurement.po_events SET payload_json='{}' WHERE id=$1", [audit.id])).rejects.toMatchObject({ code: "23514" });
    await expect(pool.query("DELETE FROM procurement.po_events WHERE id=$1", [audit.id])).rejects.toMatchObject({ code: "23514" });
  });

  it("recovers original draft save after a subsequent edit without overwriting newer state", async () => {
    const original = await create("draft-source"); const id = original.po.id;
    const firstBody = { ...input(), expected_updated_at: original.po.updatedAt, vendor_notes: "First saved terms",
      lines: [{ ...line(), line_id: original.lines[0].id }] };
    const firstKey = "po-entry:lost-save";
    await http("PUT", `/api/purchase-orders/${id}/draft`, firstKey, firstBody, { lose: true });
    const saved = (await ledger(firstKey)).response_body;
    const first = purchaseOrderEntryCommandResultSchema.parse(saved);
    expect(first.lines[0]).toMatchObject({ id: original.lines[0].id, clientId: "product-one" });
    expect((await http("PUT", `/api/purchase-orders/${id}/draft`, "po-entry:later-save", {
      ...firstBody, expected_updated_at: first.po.updatedAt, vendor_notes: "Later reviewed terms",
    }))?.status).toBe(200);
    expect(await http("PUT", `/api/purchase-orders/${id}/draft`, firstKey, firstBody)).toEqual({ status: 200, body: saved, replayed: "true" });
    expect((await pool.query("SELECT vendor_notes FROM procurement.purchase_orders WHERE id=$1", [id])).rows[0].vendor_notes).toBe("Later reviewed terms");
  });

  it("keeps a saved draft when supplier preparation rejects and replays that exact partial outcome", async () => {
    const body = { ...input(), prepare_for_supplier: true,
      lines: [{ ...line(), quoted_at: "2020-01-01T00:00:00.000Z", quote_valid_until: "2020-01-02" }] };
    const result = await create("prepare-rejected", body);
    expect(result).toMatchObject({ po: { status: "draft", physicalStatus: "draft" }, dispatch_recorded: false, sendError: expect.stringContaining("expired") });
    expect(await post("/api/purchase-orders", "po-entry:prepare-rejected", body)).toMatchObject({ status: 201, body: result, replayed: "true" });
  });

  it("preserves both preparation routes and their different approval-tier rules", async () => {
    const solo = await create("solo-source");
    await pool.query("INSERT INTO procurement.po_approval_tiers(tier_name,threshold_cents,approver_role,active) VALUES('Buyer tier',1,'admin',1)");
    const denied = await post(`/api/purchase-orders/${solo.po.id}/send-to-vendor`, "po-entry:solo-tiers", {});
    expect(denied).toMatchObject({ status: 400, body: { details: { purchaseOrderEntryOutcome: "rejected", action: "prepare" } } });
    await pool.query("UPDATE inventory.warehouse_settings SET require_approval=true");
    const prepared = await post(`/api/purchase-orders/${solo.po.id}/send-pdf`, "po-entry:prepare-document", {});
    expect(prepared).toMatchObject({ status: 200, body: { po: { status: "pending_approval" }, pending_approval: true, dispatch_recorded: false, pdf: null } });
    expect(await post(`/api/purchase-orders/${solo.po.id}/send-pdf`, "po-entry:prepare-document", {})).toEqual({ ...prepared, replayed: "true" });
  });

  it("creates one duplicate per intent and preserves identical legitimate requests with distinct keys", async () => {
    const source = await create("duplicate-source"); const before = await counts();
    const path = `/api/purchase-orders/${source.po.id}/duplicate`;
    const one = await post(path, "po-entry:duplicate-one", {});
    expect(one.status, JSON.stringify(one.body)).toBe(201);
    expect(await post(path, "po-entry:duplicate-one", {})).toEqual({ ...one, replayed: "true" });
    const two = await post(path, "po-entry:duplicate-two", {});
    expect(purchaseOrderEntryCommandResultSchema.parse(two.body).po.id).not.toBe(purchaseOrderEntryCommandResultSchema.parse(one.body).po.id);
    expect((await counts()).orders).toBe(before.orders + 2);
  });

  it.each([null, { error: "Temporary failure" }, { id: 999, poNumber: "OLD-SUCCESS" }])("preserves legacy pending or cached evidence without dispatching a new command %j", async cached => {
    const key = `po-entry:legacy-${cached === null ? "pending" : "error" in cached ? "error" : "success"}`;
    await pool.query("INSERT INTO public.idempotency_keys(key,request_hash,response_body) VALUES($1,'legacy-unscoped',$2)", [key, cached]);
    const before = await counts();
    expect(await post("/api/purchase-orders", key, input())).toMatchObject({ status: 409, body: { code: "PURCHASE_ORDER_ENTRY_LEGACY_REVIEW_REQUIRED" } });
    expect(await ledger(key)).toBeUndefined(); expect(await counts()).toEqual(before);
    expect((await pool.query("SELECT response_body FROM public.idempotency_keys WHERE key=$1", [key])).rows[0].response_body).toEqual(cached);
  });

  it("does not reuse an existing key for another actor, target, action or payload", async () => {
    const original = await create("identity"); const before = await counts(); const key = "po-entry:identity";
    expect((await post("/api/purchase-orders", key, input(), "other-buyer")).status).toBe(422);
    expect((await post("/api/purchase-orders", key, { ...input(), vendor_notes: "Changed" })).status).toBe(422);
    expect((await post(`/api/purchase-orders/${original.po.id}/duplicate`, key, {})).status).toBe(422);
    expect(await counts()).toEqual(before);
  });

  it("recovers concurrent same-key create attempts to one purchase order", async () => {
    const blocker = await pool.connect(); const key = "po-entry:concurrent"; const before = await counts();
    await blocker.query("BEGIN"); await blocker.query("SELECT pg_advisory_xact_lock(hashtext('inventory.cost_graph'),hashtext('version_1'))");
    try {
      const first = post("/api/purchase-orders", key, input());
      await waitFor(async () => (await ledger(key))?.status === "claimed", "Create did not reserve its command");
      const second = post("/api/purchase-orders", key, input());
      await blocker.query("COMMIT");
      const results = await Promise.all([first, second]);
      expect(results.every(result => result.status === 201 || result.status === 409)).toBe(true);
      expect((await post("/api/purchase-orders", key, input())).status).toBe(201);
      expect((await counts()).orders).toBe(before.orders + 1);
    } finally { await blocker.query("ROLLBACK"); blocker.release(); }
  });

  it("rechecks permission after replay waits on the persisted command row", async () => {
    await create("blocked-replay"); const key = "po-entry:blocked-replay";
    const blocker = await pool.connect(); await blocker.query("BEGIN");
    await blocker.query("SELECT id FROM public.financial_command_results WHERE idempotency_key=$1 FOR UPDATE", [key]);
    try {
      const replay = post("/api/purchase-orders", key, input());
      await waitFor(async () => Number((await pool.query("SELECT count(*) AS count FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%financial_command_results%' AND pid<>pg_backend_pid()")).rows[0].count) > 0, "Replay did not wait for ledger row");
      await pool.query("DELETE FROM identity.auth_role_permissions WHERE role_id=1 AND permission_id=1");
      await blocker.query("COMMIT");
      expect(await replay).toMatchObject({ status: 403, body: { code: "PURCHASE_ORDER_ENTRY_FORBIDDEN" } });
      expect((await ledger(key)).status).toBe("succeeded");
    } finally { await blocker.query("ROLLBACK"); blocker.release(); }
  });

  it("rechecks permission after a new mutation waits on the cost graph lock", async () => {
    const blocker = await pool.connect(); const key = "po-entry:revoked-before-write"; const before = await counts();
    await blocker.query("BEGIN"); await blocker.query("SELECT pg_advisory_xact_lock(hashtext('inventory.cost_graph'),hashtext('version_1'))");
    try {
      const pending = post("/api/purchase-orders", key, input());
      await waitFor(async () => (await ledger(key))?.status === "claimed", "Create did not reserve its command");
      await pool.query("DELETE FROM identity.auth_role_permissions WHERE role_id=1 AND permission_id=1");
      await blocker.query("COMMIT");
      expect((await pending).status).toBe(403);
      expect(await counts()).toEqual(before);
      expect((await ledger(key)).status).toBe("rejected");
      await pool.query("INSERT INTO identity.auth_role_permissions(role_id,permission_id) VALUES(1,1)");
      expect(await post("/api/purchase-orders", key, input())).toMatchObject({ status: 403, replayed: "true",
        body: { details: { purchaseOrderEntryOutcome: "rejected", actorId: ACTOR, action: "create" } } });
      expect(await counts()).toEqual(before);
    } finally { await blocker.query("ROLLBACK"); blocker.release(); }
  });

  it.each(["save-draft", "duplicate", "prepare"] as const)("rolls back %s together with its audit and recovers the original intent", async action => {
    const source = await create(`rollback-source-${action}`); const id = source.po.id;
    const before = await counts();
    const headerBefore = (await pool.query("SELECT * FROM procurement.purchase_orders WHERE id=$1", [id])).rows[0];
    const key = `po-entry:rollback-${action}`;
    const path = `/api/purchase-orders/${id}/${action === "save-draft" ? "draft" : action === "prepare" ? "send-to-vendor" : "duplicate"}`;
    const body = action === "save-draft" ? { ...input(), expected_updated_at: source.po.updatedAt, vendor_notes: "Must be atomic",
      lines: [{ ...line(), line_id: source.lines[0].id }] } : {};
    const method = action === "save-draft" ? "PUT" : "POST";
    await pool.query(`CREATE FUNCTION public.po_entry_action_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_type='entry_${action.replaceAll("-", "_")}' THEN RAISE EXCEPTION 'injected action audit failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER po_entry_action_failure BEFORE INSERT ON procurement.po_events FOR EACH ROW EXECUTE FUNCTION public.po_entry_action_failure()`);
    try {
      expect((await http(method, path, key, body))?.status).toBe(503);
      expect(await counts()).toEqual(before);
      expect((await pool.query("SELECT * FROM procurement.purchase_orders WHERE id=$1", [id])).rows[0]).toEqual(headerBefore);
      expect((await ledger(key)).status).toBe("retryable");
    } finally { await pool.query("DROP TRIGGER po_entry_action_failure ON procurement.po_events; DROP FUNCTION public.po_entry_action_failure()"); }
    await waitFor(async () => (await pool.query("SELECT next_attempt_at<=clock_timestamp() AS due FROM public.financial_command_results WHERE idempotency_key=$1", [key])).rows[0]?.due === true, "Action retry was not due");
    const recovered = await http(method, path, key, body);
    expect(recovered?.status, JSON.stringify(recovered?.body)).toBe(action === "duplicate" ? 201 : 200);
    expect(await http(method, path, key, body)).toEqual({ ...recovered, replayed: "true" });
  });

  it.each(["audit", "result"] as const)("rolls back all business writes when %s persistence fails, then recovers with the original key", async failure => {
    const key = `po-entry:rollback-${failure}`; const before = await counts();
    const table = failure === "audit" ? "procurement.po_events" : "public.financial_command_results";
    const condition = failure === "audit" ? "NEW.event_type='entry_create'" : `NEW.status='succeeded' AND NEW.idempotency_key='${key}'`;
    await pool.query(`CREATE FUNCTION public.po_entry_test_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF ${condition} THEN RAISE EXCEPTION 'injected PO entry persistence failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER po_entry_test_failure BEFORE ${failure === "audit" ? "INSERT" : "UPDATE"} ON ${table} FOR EACH ROW EXECUTE FUNCTION public.po_entry_test_failure()`);
    try {
      expect((await post("/api/purchase-orders", key, input())).status).toBe(503);
      expect(await counts()).toEqual(before); expect((await ledger(key)).status).toBe("retryable");
    } finally { await pool.query(`DROP TRIGGER po_entry_test_failure ON ${table}; DROP FUNCTION public.po_entry_test_failure()`); }
    await waitFor(async () => (await pool.query("SELECT next_attempt_at<=clock_timestamp() AS due FROM public.financial_command_results WHERE idempotency_key=$1", [key])).rows[0]?.due === true, "Retry was not due");
    const recovered = await post("/api/purchase-orders", key, input());
    expect(recovered.status, JSON.stringify(recovered.body)).toBe(201); expect((await counts()).orders).toBe(before.orders + 1);
  });

  it("requires a key even for legacy empty manual creation and replays its flat compatibility fields", async () => {
    expect((await post("/api/purchase-orders", "", { vendorId: 2 })).status).toBe(400);
    const created = await post("/api/purchase-orders", "po-entry:empty-legacy", { vendorId: 2, poType: "dropship", priority: "rush" });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const result = purchaseOrderEntryCommandResultSchema.parse(created.body);
    expect(result).toMatchObject({ id: result.po.id, poNumber: result.po.poNumber, po: { poType: "dropship", priority: "rush" }, lines: [] });
    expect(await post("/api/purchase-orders", "po-entry:empty-legacy", { vendorId: 2, poType: "dropship", priority: "rush" })).toEqual({ ...created, replayed: "true" });
  });

  it("completes concurrent creates, save, catalog duplicate and both preparation paths with one application connection", async () => {
    // No spare application connection exists while the command owns its
    // transaction. A hidden storage/db read outside that transaction times out
    // instead of being concealed by the larger fixture administration pool.
    const originalDatabase = connection.database;
    const originalService = app.locals.services.purchasing;
    const singlePool = new pg.Pool({ connectionString: TEST_URL, ssl: false, max: 1,
      connectionTimeoutMillis: 1_500, statement_timeout: 5_000 });
    const singleDatabase = drizzle(singlePool, { schema });
    await pool.query(`INSERT INTO procurement.vendor_products(id,vendor_id,product_id,product_variant_id,
      pricing_basis,unit_cost_mills,unit_cost_cents,quoted_unit_cost_mills,quoted_at,quote_valid_until)
      VALUES(91,2,10,100,'per_piece',20000,200,20000,'2026-10-24T00:00:00Z','2099-12-31')`);
    connection.database = singleDatabase;
    app.locals.services.purchasing = createPurchasingService(singleDatabase, { ...procurementMethods, ...productMethods } as never, { now: () => NOW });
    try {
      const catalogInput = { ...input(), lines: [{ ...line(), pricing_source: "vendor_catalog", vendor_product_id: 91 }] };
      const created = await Promise.all([create("one-connection-first", catalogInput), create("one-connection-second", catalogInput)]);
      expect(created[0].po.id).not.toBe(created[1].po.id);
      const source = created[0];
      const saved = await http("PUT", `/api/purchase-orders/${source.po.id}/draft`, "po-entry:one-connection-save", {
        ...catalogInput, expected_updated_at: source.po.updatedAt, vendor_notes: "One connection save",
        lines: [{ ...catalogInput.lines[0], line_id: source.lines[0].id }],
      });
      expect(saved?.status, JSON.stringify(saved?.body)).toBe(200);
      const duplicate = await post(`/api/purchase-orders/${source.po.id}/duplicate`, "po-entry:one-connection-duplicate");
      expect(duplicate.status, JSON.stringify(duplicate.body)).toBe(201);
      const copied = purchaseOrderEntryCommandResultSchema.parse(duplicate.body);
      expect(copied.lines[0]).toMatchObject({ pricingSource: "vendor_catalog", vendorProductId: 91 });
      const prepared = await post(`/api/purchase-orders/${source.po.id}/send-to-vendor`, "po-entry:one-connection-prepare");
      expect(prepared.status, JSON.stringify(prepared.body)).toBe(200);
      const document = await post(`/api/purchase-orders/${copied.po.id}/send-pdf`, "po-entry:one-connection-document");
      expect(document.status, JSON.stringify(document.body)).toBe(200);
      const empty = await post("/api/purchase-orders", "po-entry:one-connection-empty", { vendorId: 2, source: "reorder" });
      expect(empty.status, JSON.stringify(empty.body)).toBe(201);
      expect(empty.body).toMatchObject({ source: "reorder", po: { source: "reorder" } });
      expect(singlePool.totalCount).toBe(1);
    } finally {
      app.locals.services.purchasing = originalService;
      connection.database = originalDatabase;
      await singlePool.end();
    }
  }, 30_000);
});
