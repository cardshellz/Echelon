import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { drizzle } from "drizzle-orm/node-postgres";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "@shared/schema";
import { canonicalJson } from "@shared/utils/canonical-json";
import { fixtureTable, fixtureForeignKeys } from "./shipment-line-fixture";
import type { FinancialCommandDescriptor } from "../../../../platform/commands/transactional-command.service";
import type { PoQuantityApprovalRequest } from "@shared/procurement/po-quantity-amendment";

const connection = vi.hoisted(() => ({ database: null as ReturnType<typeof drizzle<typeof schema>> | null }));
vi.mock("../../../../db", () => ({ db: new Proxy({}, { get(_target, property) {
  if (!connection.database) throw new Error("Amendment test database not initialized");
  const value = Reflect.get(connection.database, property);
  return typeof value === "function" ? value.bind(connection.database) : value;
} }) }));
import { createPoQuantityAmendmentService } from "../../po-quantity-amendment.service";
import { registerPoQuantityAmendmentRoutes } from "../../po-quantity-amendment.routes";

const TEST_URL = process.env.ECHELON_TEST_DATABASE_URL;
const databaseTests = TEST_URL && process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true" ? describe : describe.skip;
const NOW = new Date("2026-10-08T12:00:00.000Z");

databaseTests.sequential("PO quantity amendment real PostgreSQL and HTTP guarantees", () => {
  let pool: pg.Pool;
  let database: ReturnType<typeof drizzle<typeof schema>>;
  let service: ReturnType<typeof createPoQuantityAmendmentService>;
  let server: Server;
  let url: string;
  let requestActor: string | null = "admin-user";
  const tables = [schema.users, schema.authRoles, schema.authPermissions, schema.authUserRoles, schema.authRolePermissions,
    schema.purchaseOrders, schema.purchaseOrderLines, schema.poApprovalTiers, schema.poStatusHistory, schema.poRevisions, schema.poEvents, schema.poExceptions,
    schema.purchasingRecommendationPoHandoffs, schema.vendorInvoices, schema.vendorInvoiceLines, schema.vendorInvoicePoLinks, schema.poReceipts,
    schema.warehouseSettings, schema.apPayments, schema.apPaymentAllocations, schema.receivingOrders, schema.receivingLines, schema.inventoryLots, schema.auditEvents];
  const migrations = ["136_financial_command_results.sql", "140_financial_command_operations.sql", "227_purchase_order_history_retention.sql"];
  const descriptor = (body: unknown, key = randomUUID(), actorId = "admin-user"): FinancialCommandDescriptor => ({
    actorType: "user", actorId, method: "POST", routeTemplate: "/api/purchase-orders/:id/quantity-amendment", resourceKey: "purchase_order:1",
    idempotencyKey: key, requestHash: createHash("sha256").update(canonicalJson(body)).digest("hex"), commandName: "purchase_order.quantity_amendment.approve", contractVersion: 1,
  });
  const body = async (quantityPieces = 20, actorId = "admin-user"): Promise<PoQuantityApprovalRequest> => ({
    sourceVersion: (await service.context(1, actorId)).sourceVersion,
    changes: [{ lineId: 11, quantityPieces, priceTreatment: "keep_product_total" }],
    reason: "Supplier confirmed the purchased quantity correction", approvalConfirmed: true,
  });
  const evidence = async () => {
    const records: Record<string, unknown[]> = {};
    for (const name of ["procurement.purchase_orders", "procurement.purchase_order_lines", "procurement.po_events", "procurement.po_revisions", "procurement.po_status_history", "procurement.po_exceptions"]) records[name] = (await pool.query(`SELECT * FROM ${name} ORDER BY id`)).rows;
    return records;
  };
  const protectedRecords = async () => {
    const records: Record<string, unknown[]> = {};
    for (const name of ["procurement.vendor_invoices", "procurement.ap_payments", "procurement.ap_payment_allocations", "procurement.po_receipts", "procurement.receiving_orders", "procurement.receiving_lines", "inventory.inventory_lots"]) records[name] = (await pool.query(`SELECT * FROM ${name} ORDER BY id`)).rows;
    records.invoiceEconomics = (await pool.query("SELECT id,vendor_invoice_id,purchase_order_line_id,qty_invoiced,unit_cost_cents,unit_cost_mills,line_total_cents,cost_component_evidence FROM procurement.vendor_invoice_lines ORDER BY id")).rows;
    return records;
  };
  const post = async (request: unknown, key = randomUUID()) => {
    const response = await fetch(`${url}/api/purchase-orders/1/quantity-amendment`, { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": key }, body: JSON.stringify(request) });
    return { status: response.status, body: await response.json(), replayed: response.headers.get("Idempotency-Replayed") };
  };
  beforeAll(async () => {
    if ([process.env.DATABASE_URL, process.env.EXTERNAL_DATABASE_URL].includes(TEST_URL)) throw new Error("Requires a separate disposable database.");
    pool = new pg.Pool({ connectionString: TEST_URL, max: 8, ssl: false });
    for (const name of ["identity", "procurement", "inventory"]) await pool.query(`CREATE SCHEMA ${name}`);
    for (const table of tables) await pool.query(fixtureTable(table));
    await pool.query("CREATE UNIQUE INDEX purchase_order_lines_po_id_line_id_uidx ON procurement.purchase_order_lines(purchase_order_id,id)");
    for (const ddl of fixtureForeignKeys(tables)) await pool.query(ddl);
    // Actual production Drizzle checks, including explicit quote residuals,
    // cents/mills consistency and purchase currency. Remove only table qualification.
    const dialect = new PgDialect();
    for (const table of [schema.purchaseOrders, schema.purchaseOrderLines]) {
      const definition = getTableConfig(table);
      for (const check of definition.checks) {
        const expression = dialect.sqlToQuery(check.value);
        if (expression.params.length) throw new Error("Constraint must have no parameters");
        const sqlText = expression.sql.replaceAll(`"${definition.schema}"."${definition.name}".`, "").replaceAll(`"${definition.name}".`, "");
        await pool.query(`ALTER TABLE "${definition.schema}"."${definition.name}" ADD CONSTRAINT "${check.name}" CHECK (${sqlText})`);
      }
    }
    for (const file of migrations.slice(0, 2)) await pool.query(readFileSync(resolve(process.cwd(), "migrations", file), "utf8"));
    database = drizzle(pool, { schema }); connection.database = database;
    service = createPoQuantityAmendmentService(database, () => NOW);
    const app = express(); app.use(express.json());
    app.use((req, _res, next) => { (req as unknown as { session: unknown }).session = { user: requestActor ? { id: requestActor, role: "admin" } : undefined }; next(); });
    registerPoQuantityAmendmentRoutes(app, service);
    server = createServer(app); await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  beforeEach(async () => {
    requestActor = "admin-user";
    await pool.query(`DROP TRIGGER IF EXISTS po_event_history_immutable_rows ON procurement.po_events;
      DROP TRIGGER IF EXISTS po_event_history_immutable_truncate ON procurement.po_events;
      DROP TRIGGER IF EXISTS purchase_order_history_retention_rows ON procurement.purchase_orders;
      DROP TRIGGER IF EXISTS purchase_order_history_retention_truncate ON procurement.purchase_orders;
      DROP TRIGGER IF EXISTS amendment_test_failure ON procurement.po_events;
      TRUNCATE identity.users,identity.auth_roles,identity.auth_permissions,identity.auth_user_roles,identity.auth_role_permissions,
      procurement.purchase_orders,procurement.purchase_order_lines,procurement.po_approval_tiers,procurement.po_status_history,procurement.po_revisions,procurement.po_events,procurement.po_exceptions,
      procurement.purchasing_recommendation_po_handoffs,procurement.vendor_invoices,procurement.vendor_invoice_lines,procurement.vendor_invoice_po_links,procurement.po_receipts,
      inventory.warehouse_settings,procurement.ap_payments,procurement.ap_payment_allocations,procurement.receiving_orders,procurement.receiving_lines,inventory.inventory_lots,public.audit_events,public.financial_command_results RESTART IDENTITY CASCADE;
      INSERT INTO identity.users(id,username,password,role,active) VALUES ('admin-user','admin','unused','picker',1),('lead-user','lead','unused','admin',1),('custom-user','custom','unused','admin',1),('scoped-user','scoped','unused','admin',1);
      INSERT INTO identity.auth_roles(id,name,is_system) VALUES(1,'Administrator',1),(2,'Team Lead',1),(3,'Administrator',0),(4,'Administrator',1);
      INSERT INTO identity.auth_permissions(id,resource,action,category) VALUES(1,'purchasing','approve','purchasing'),(2,'purchasing','view','purchasing');
      INSERT INTO identity.auth_user_roles(user_id,role_id) VALUES('admin-user',1),('lead-user',2),('custom-user',3),('scoped-user',4);
      INSERT INTO identity.auth_role_permissions(role_id,permission_id,constraints) VALUES(1,1,NULL),(1,2,NULL),(2,1,NULL),(2,2,NULL),(3,1,NULL),(3,2,NULL),(4,1,'{"warehouseId":1}'),(4,2,NULL);
      INSERT INTO procurement.purchase_orders(id,po_number,vendor_id,status,physical_status,financial_status,subtotal_cents,total_cents,line_count,received_line_count,revision_number) VALUES(1,'TEST-PO',2,'received','received','paid',1100,1100,1,1,0);
      INSERT INTO procurement.purchase_order_lines(id,purchase_order_id,line_number,product_id,product_name,order_qty,received_qty,status,unit_cost_cents,unit_cost_mills,total_product_cost_cents,packaging_cost_cents,line_total_cents,pricing_basis,pricing_source,quoted_unit_cost_mills) VALUES(11,1,1,1,'Test product',10,20,'received',100,10000,1000,100,1100,'per_piece','manual',10000);
      INSERT INTO procurement.vendor_invoices(id,invoice_number,vendor_id,status,invoiced_amount_cents,paid_amount_cents,balance_cents) VALUES(71,'TEST-INV',2,'paid',1000,1000,0);
      INSERT INTO procurement.vendor_invoice_po_links(vendor_invoice_id,purchase_order_id,allocated_amount_cents) VALUES(71,1,1000);
      INSERT INTO procurement.vendor_invoice_lines(id,vendor_invoice_id,line_number,purchase_order_line_id,description,qty_invoiced,unit_cost_cents,unit_cost_mills,line_total_cents,match_status) VALUES(81,71,1,11,'Test invoice product',10,100,10000,1000,'qty_discrepancy');
      INSERT INTO procurement.ap_payments(id,payment_number,vendor_id,payment_date,payment_method,total_amount_cents) VALUES(91,'TEST-PAY',2,'2026-10-01','wire',1000);
      INSERT INTO procurement.ap_payment_allocations(ap_payment_id,vendor_invoice_id,applied_amount_cents) VALUES(91,71,1000);
      INSERT INTO procurement.receiving_orders(id,receipt_number,purchase_order_id,status) VALUES(31,'TEST-RCV',1,'closed');
      INSERT INTO procurement.receiving_lines(id,receiving_order_id,purchase_order_line_id,expected_qty,received_qty,product_variant_id,units_per_variant_snapshot) VALUES(41,31,11,10,20,1,1);
      INSERT INTO procurement.po_receipts(purchase_order_id,purchase_order_line_id,receiving_order_id,receiving_line_id,qty_received,po_unit_cost_mills,actual_unit_cost_mills) VALUES(1,11,31,41,20,10000,10000);
      INSERT INTO inventory.inventory_lots(id,lot_number,product_variant_id,warehouse_location_id,receiving_order_id,purchase_order_id,po_line_id,unit_cost_cents,unit_cost_mills,qty_on_hand,qty_received,received_at) VALUES(51,'TEST-LOT',1,1,31,1,11,100,10000,20,20,'2026-10-01');
      INSERT INTO inventory.warehouse_settings(warehouse_code,require_approval) VALUES('DEFAULT',false);
      INSERT INTO procurement.po_exceptions(po_id,kind,severity,status,payload,payload_hash,title) VALUES(1,'match_mismatch','warn','resolved','{"invoiceId":71,"sourceVersion":1,"sourceFingerprint":"old"}','old-evidence','Old approved variance');
    `);
    await pool.query(readFileSync(resolve(process.cwd(), "migrations", migrations[2]), "utf8"));
  });
  afterAll(async () => {
    if (server) await new Promise<void>((done, reject) => server.close((error) => error ? reject(error) : done()));
    if (pool) { for (const name of ["procurement", "inventory", "identity"]) await pool.query(`DROP SCHEMA ${name} CASCADE`); await pool.end(); }
  });
  it("previews without writes, then applies one audited revision and preserves all AP/inventory records", async () => {
    const request = await body(); const before = await evidence(); const protectedBefore = await protectedRecords();
    const preview = await service.preview(1, { sourceVersion: request.sourceVersion, changes: request.changes, reason: request.reason }, "admin-user");
    expect(await evidence()).toEqual(before);
    const result = await post(request);
    expect(result).toMatchObject({ status: 200, body: { purchaseOrderId: 1, revisionNumber: 1, preview }, replayed: "false" });
    expect(await protectedRecords()).toEqual(protectedBefore);
    expect((await pool.query("SELECT order_qty,received_qty,total_product_cost_cents,unit_cost_mills,pricing_basis FROM procurement.purchase_order_lines WHERE id=11")).rows[0]).toMatchObject({ order_qty: 20, received_qty: 20, total_product_cost_cents: "1000", unit_cost_mills: "5000", pricing_basis: "extended_total" });
    const events = (await pool.query("SELECT actor_id,payload_json FROM procurement.po_events")).rows;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ actor_id: "admin-user", payload_json: { reason: request.reason, approvalEvidence: { active: true }, before: { lines: [{ orderQty: 10 }] }, after: { lines: [{ orderQty: 20 }] } } });
    expect((await pool.query("SELECT bool_and(line.updated_at <= header.approved_at) AS covered FROM procurement.purchase_orders header JOIN procurement.purchase_order_lines line ON line.purchase_order_id=header.id")).rows[0].covered).toBe(true);
    expect((await pool.query("SELECT status FROM procurement.po_exceptions ORDER BY id")).rows).toEqual([{ status: "dismissed" }, { status: "open" }]);
    await expect(pool.query("UPDATE procurement.po_events SET actor_id='forged'")).rejects.toMatchObject({ code: "23514" });
  });
  it("replays a committed result with the exact same response and one revision", async () => {
    const request = await body(); const key = randomUUID(); const first = await post(request, key); const after = await evidence();
    const retry = await post(request, key); expect(retry).toEqual({ ...first, replayed: "true" }); expect(await evidence()).toEqual(after);
    expect((await post({ ...request, reason: "Different correction reason after the command" }, key)).status).toBe(422);
    await pool.query("UPDATE procurement.purchase_orders SET status='closed',closed_at=now() WHERE id=1");
    const closed = await evidence(); expect(await post(request, key)).toEqual(retry); expect(await evidence()).toEqual(closed);
  });
  it("serializes competing corrections from one source version", async () => {
    const request = await body(); const other = { ...request, changes: [{ ...request.changes[0], quantityPieces: 30 }] };
    const results = await Promise.all([service.approve(1, request, "admin-user", descriptor(request)), service.approve(1, other, "admin-user", descriptor(other))]);
    expect(results.map((result) => result.httpStatus).sort()).toEqual([200, 409]);
    expect((await pool.query("SELECT COUNT(*)::int AS count FROM procurement.po_events")).rows[0].count).toBe(1);
    expect((await pool.query("SELECT revision_number FROM procurement.purchase_orders")).rows[0].revision_number).toBe(1);
  });
  it.each(["lead-user", "custom-user", "scoped-user"])("rejects forged legacy role or insufficient current authority for %s", async (actor) => {
    const request = await body(20, actor); requestActor = actor; const before = await evidence();
    expect(await post(request)).toMatchObject({ status: 403, body: { code: "PO_AMENDMENT_ADMIN_REQUIRED" } }); expect(await evidence()).toEqual(before);
  });
  it("checks live membership revocation after preview, including direct command execution", async () => {
    const request = await body(); await pool.query("DELETE FROM identity.auth_user_roles WHERE user_id='admin-user'"); const before = await evidence();
    const result = await service.approve(1, request, "admin-user", descriptor(request)); expect(result.httpStatus).toBe(403); expect(await evidence()).toEqual(before);
  });
  it("rejects disabled accounts, missing approval permission and missing authentication at HTTP", async () => {
    const request = await body(); const before = await evidence();
    await pool.query("UPDATE identity.users SET active=0 WHERE id='admin-user'"); expect((await post(request)).status).toBe(403);
    await pool.query("UPDATE identity.users SET active=1 WHERE id='admin-user'; DELETE FROM identity.auth_role_permissions WHERE role_id=1 AND permission_id=1"); expect((await post(request)).status).toBe(403);
    requestActor = null; expect((await post(request)).status).toBe(401); expect(await evidence()).toEqual(before);
  });
  it.each(["UPDATE procurement.purchase_order_lines SET received_qty=21 WHERE id=11", "UPDATE procurement.vendor_invoice_lines SET qty_invoiced=11 WHERE id=81", "UPDATE procurement.vendor_invoices SET status='voided' WHERE id=71", "UPDATE procurement.purchase_orders SET status='closed',closed_at=now() WHERE id=1", "UPDATE inventory.warehouse_settings SET require_approval=true"])("rejects stale source evidence: %s", async (sqlText) => {
    const request = await body(); await pool.query(sqlText); const before = await evidence();
    expect(await post(request)).toMatchObject({ status: 409, body: { code: "PO_AMENDMENT_STALE" } }); expect(await evidence()).toEqual(before);
  });
  it("honors configured amount role requirements even for an administrator", async () => {
    await pool.query("UPDATE inventory.warehouse_settings SET require_approval=true; INSERT INTO procurement.po_approval_tiers(tier_name,threshold_cents,approver_role,active) VALUES('Finance approval',0,'Finance Director',1)");
    const request = await body(); const before = await evidence();
    expect(await post(request)).toMatchObject({ status: 403, body: { details: { code: "PO_APPROVAL_ROLE_REQUIRED" } } }); expect(await evidence()).toEqual(before);
  });
  it("rolls back every selected line if a bulk correction contains an invalid line", async () => {
    const request = await body(); request.changes.push({ lineId: 999, quantityPieces: 30, priceTreatment: "keep_product_total" }); const before = await evidence();
    expect(await post(request)).toMatchObject({ status: 404, body: { code: "PO_AMENDMENT_LINE_NOT_FOUND" } }); expect(await evidence()).toEqual(before);
  });
  it("rolls back the complete correction if immutable audit append fails, then retries the same command safely", async () => {
    const request = await body(); const command = descriptor(request); const before = await evidence(); const protectedBefore = await protectedRecords();
    await pool.query("CREATE FUNCTION procurement.amendment_test_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Injected audit failure'; END; $$; CREATE TRIGGER amendment_test_failure BEFORE INSERT ON procurement.po_events FOR EACH ROW EXECUTE FUNCTION procurement.amendment_test_fail()");
    await expect(service.approve(1, request, "admin-user", command)).rejects.toThrow();
    expect(await evidence()).toEqual(before); expect(await protectedRecords()).toEqual(protectedBefore);
    await pool.query("DROP TRIGGER amendment_test_failure ON procurement.po_events");
    const deadline = Date.now() + 10000;
    while (true) {
      const state = await pool.query("SELECT next_attempt_at <= clock_timestamp() AS eligible FROM public.financial_command_results WHERE idempotency_key=$1", [command.idempotencyKey]);
      if (state.rows[0].eligible) break;
      if (Date.now() > deadline) throw new Error("Command retry did not become eligible.");
      await new Promise((done) => setTimeout(done, 20));
    }
    expect((await service.approve(1, request, "admin-user", command)).httpStatus).toBe(200);
  });
  it("requires an idempotency key and validated explicit approval fields", async () => {
    const request = await body(); const before = await evidence();
    const response = await fetch(`${url}/api/purchase-orders/1/quantity-amendment`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(request) }); expect(response.status).toBe(400);
    expect((await post({ ...request, approvalConfirmed: false })).status).toBe(400); expect(await evidence()).toEqual(before);
  });
  it("recomputes matched status when corrected PO, posted receipt and supplier invoice quantities agree", async () => {
    await pool.query("UPDATE procurement.vendor_invoice_lines SET qty_invoiced=20,line_total_cents=2000 WHERE id=81; UPDATE procurement.vendor_invoices SET invoiced_amount_cents=2000,paid_amount_cents=2000 WHERE id=71");
    const request = await body(); request.changes[0].priceTreatment = "keep_quoted_rate"; const protectedBefore = await protectedRecords();
    const result = await post(request); expect(result).toMatchObject({ status: 200, body: { preview: { afterTotalCents: 2100, invoiceMatches: [{ after: "matched" }] } } });
    expect((await pool.query("SELECT match_status FROM procurement.vendor_invoice_lines WHERE id=81")).rows[0].match_status).toBe("matched");
    expect(await protectedRecords()).toEqual(protectedBefore);
    expect((await pool.query("SELECT status FROM procurement.po_exceptions")).rows).toEqual([{ status: "dismissed" }]);
  });
  it("reopens the receiving projection when corrected quantity exceeds the actual received count", async () => {
    const request = await body(30); const protectedBefore = await protectedRecords(); expect((await post(request)).status).toBe(200);
    expect((await pool.query("SELECT status,physical_status,financial_status,received_line_count FROM procurement.purchase_orders")).rows[0]).toMatchObject({ status: "partially_received", physical_status: "receiving", financial_status: "paid", received_line_count: 0 });
    expect((await pool.query("SELECT status,order_qty,received_qty,fully_received_date FROM procurement.purchase_order_lines")).rows[0]).toMatchObject({ status: "partially_received", order_qty: 30, received_qty: 20, fully_received_date: null });
    expect(await protectedRecords()).toEqual(protectedBefore);
  });
  it("observes a real membership lock and denies approval after concurrent revocation commits", async () => {
    const request = await body(); const before = await evidence(); const holder = await pool.connect();
    let pending: ReturnType<typeof service.approve> | undefined;
    try {
      await holder.query("BEGIN"); const pid = Number((await holder.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
      await holder.query("DELETE FROM identity.auth_user_roles WHERE user_id='admin-user'");
      pending = service.approve(1, request, "admin-user", descriptor(request));
      const deadline = Date.now() + 5000; let blocked = false;
      while (Date.now() < deadline) {
        const state = await pool.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid))) AS blocked", [pid]);
        if (state.rows[0].blocked) { blocked = true; break; }
        await new Promise((done) => setTimeout(done, 20));
      }
      expect(blocked).toBe(true); await holder.query("COMMIT");
      expect((await pending).httpStatus).toBe(403); expect(await evidence()).toEqual(before);
    } finally { await holder.query("ROLLBACK"); holder.release(); await pending; }
  });
});
