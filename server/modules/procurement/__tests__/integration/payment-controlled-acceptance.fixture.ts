import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import express from "express";
import session from "express-session";
import bcrypt from "bcrypt";
import pg from "pg";
import * as schema from "@shared/schema";
import type { RecordApPaymentInput } from "../../ap-ledger.service";
import { fixtureForeignKeys, fixtureTable, qualifiedTable } from "./shipment-line-fixture";

export const PAYMENT_ACTORS = {
  owner: "payment-uat-owner",
  delegate: "payment-uat-delegate",
  viewer: "payment-uat-viewer",
} as const;

export const PAYMENT_FLOW = {
  vendorId: 5,
  otherVendorId: 6,
  poA: 11,
  poB: 12,
  invoiceA: 71,
  invoiceB: 72,
  invoiceCents: 210_000,
} as const;

const SCHEMAS = ["identity", "catalog", "procurement", "warehouse", "inventory", "wms", "oms"];
const TABLES = [
  schema.users, schema.authRoles, schema.authPermissions, schema.authUserRoles, schema.authRolePermissions,
  schema.products, schema.productVariants, schema.vendors, schema.purchaseOrders, schema.purchaseOrderLines,
  schema.vendorInvoices, schema.vendorInvoiceLines, schema.vendorInvoicePoLinks, schema.vendorInvoiceAttachments,
  schema.apPayments, schema.apPaymentAllocations, schema.poStatusHistory, schema.poExceptions,
  schema.warehouses, schema.warehouseLocations, schema.inventoryLevels, schema.inventoryLots,
  schema.orders, schema.orderItems, schema.orderItemCosts,
];
const FIXTURE_LEASE = "echelon.procurement.payment-controlled-acceptance";
const DELEGATE_PASSWORD = "local-payment-acceptance-only";

export type PaymentRequest = Omit<RecordApPaymentInput, "paymentDate" | "createdBy"> & {
  paymentDate: string;
};

export function flowPayment(amountCents: number, invoiceId: number = PAYMENT_FLOW.invoiceA): PaymentRequest {
  return {
    vendorId: PAYMENT_FLOW.vendorId,
    paymentDate: "2026-09-10T12:00:00.000Z",
    paymentMethod: "wire",
    currency: "USD",
    totalAmountCents: amountCents,
    allocations: [{ vendorInvoiceId: invoiceId, appliedAmountCents: amountCents }],
    referenceNumber: "SYNTHETIC-UAT-WIRE",
  };
}

export interface PaymentHttpBody {
  id?: number;
  error?: string;
  details?: { code?: string };
  [key: string]: unknown;
}

export interface PaymentHttpResult<T = PaymentHttpBody> {
  status: number;
  replayed: string | null;
  body: T;
}

/**
 * Real HTTP routes, RBAC queries, command repository and AP owner on private
 * PostgreSQL. The ordinary command cases use a session-establishment helper;
 * deactivation coverage uses the real login owner and a retained session cookie.
 * Approved invoice and inventory prerequisites are synthetic;
 * this fixture does not claim to create receipts or execute a bank transfer.
 */
export class PaymentAcceptanceFixture {
  pool!: pg.Pool;
  private server?: Server;
  private baseUrl = "";
  private modulePool?: pg.Pool;
  private lease?: pg.PoolClient;
  private readonly ownedSchemas: string[] = [];
  private ownsPublicTables = false;
  private readonly sessionStore = new session.MemoryStore();

  async start(testUrl: string): Promise<void> {
    const parsed = new URL(testUrl);
    if (process.env.ECHELON_TEST_DATABASE_DISPOSABLE !== "true"
      || !["127.0.0.1", "localhost"].includes(parsed.hostname)
      || [process.env.DATABASE_URL, process.env.EXTERNAL_DATABASE_URL].filter(Boolean).includes(testUrl)) {
      throw new Error("Payment acceptance requires a separate explicitly disposable LOCAL database");
    }
    this.pool = new pg.Pool({ connectionString: testUrl, ssl: false, max: 10, statement_timeout: 15_000 });
    this.lease = await this.pool.connect();
    const lock = await this.lease.query("SELECT pg_try_advisory_lock(hashtext($1)) AS acquired", [FIXTURE_LEASE]);
    if (!lock.rows[0].acquired) throw new Error("Another payment fixture owns the schema lease");

    // Fail on existing schemas/public ledgers; never adopt or clear unknown data.
    for (const name of SCHEMAS) {
      await this.pool.query(`CREATE SCHEMA ${name}`);
      this.ownedSchemas.push(name);
    }
    const publicTables = await this.pool.query(`SELECT to_regclass('public.audit_events') AS audit,
      to_regclass('public.financial_command_results') AS commands,
      to_regclass('public.financial_command_recoveries') AS recoveries,
      to_regprocedure('public.guard_financial_command_result_update()') AS command_guard`);
    if (Object.values(publicTables.rows[0]).some(Boolean)) throw new Error("Payment fixture public ledgers already exist");
    for (const table of TABLES) await this.pool.query(fixtureTable(table));
    for (const statement of fixtureForeignKeys(TABLES)) await this.pool.query(statement);
    await this.pool.query(`
      CREATE UNIQUE INDEX ap_payments_payment_number_active_uidx ON procurement.ap_payments(payment_number) WHERE voided_at IS NULL;
      CREATE UNIQUE INDEX ap_payment_allocations_pay_inv_idx ON procurement.ap_payment_allocations(ap_payment_id,vendor_invoice_id);
      CREATE UNIQUE INDEX vendor_invoices_vendor_invoice_idx ON procurement.vendor_invoices(vendor_id,invoice_number);
      CREATE UNIQUE INDEX vendor_invoice_po_links_inv_po_idx ON procurement.vendor_invoice_po_links(vendor_invoice_id,purchase_order_id);
      CREATE UNIQUE INDEX auth_permissions_resource_action_idx ON identity.auth_permissions(resource,action);
      CREATE UNIQUE INDEX auth_role_permissions_role_perm_idx ON identity.auth_role_permissions(role_id,permission_id);
      CREATE UNIQUE INDEX payment_fixture_role_assignment ON identity.auth_user_roles(user_id,role_id);
    `);
    this.ownsPublicTables = true;
    for (const migration of ["0107_audit_events.sql", "136_financial_command_results.sql",
      "140_financial_command_operations.sql", "157_procurement_usd_financial_authority.sql"]) {
      await this.pool.query(readFileSync(resolve(process.cwd(), "migrations", migration), "utf8"));
    }

    const priorDatabase = process.env.DATABASE_URL;
    const priorExternal = process.env.EXTERNAL_DATABASE_URL;
    delete process.env.DATABASE_URL;
    delete process.env.EXTERNAL_DATABASE_URL;
    try {
      const dbModule = await import("../../../../db");
      this.modulePool = dbModule.pool;
      // The Drizzle/default singleton owners retain real queries/transactions;
      // every acquired connection is redirected to this disposable pool only.
      this.modulePool.query = this.pool.query.bind(this.pool) as typeof this.modulePool.query;
      this.modulePool.connect = this.pool.connect.bind(this.pool) as typeof this.modulePool.connect;
      const { registerApLedgerRoutes } = await import("../../ap-ledger.routes");
      const { registerAuthRoutes } = await import("../../../identity/identity.routes");
      const app = express();
      app.use(express.json());
      app.use(session({
        secret: "private-local-payment-acceptance-session",
        store: this.sessionStore, resave: false, saveUninitialized: false,
        cookie: { secure: false, httpOnly: true, sameSite: "lax" },
      }));
      app.use((req, _res, next) => {
        const actorId = req.header("X-Payment-Fixture-Actor");
        // Even the view-only actor gets a forged admin session role. Actual
        // purchasing permissions must come from PostgreSQL RBAC membership.
        if (actorId) req.session.user = { id: actorId, username: actorId, role: "admin",
          active: 1, displayName: null, createdAt: new Date("2026-09-10T12:00:00Z"), lastLoginAt: null };
        next();
      });
      registerAuthRoutes(app);
      registerApLedgerRoutes(app);
      this.server = createServer(app);
      await new Promise<void>((done) => this.server!.listen(0, "127.0.0.1", done));
      this.baseUrl = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    } finally {
      if (priorDatabase === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = priorDatabase;
      if (priorExternal === undefined) delete process.env.EXTERNAL_DATABASE_URL; else process.env.EXTERNAL_DATABASE_URL = priorExternal;
    }
  }

  async reset(): Promise<void> {
    if (this.ownedSchemas.length !== SCHEMAS.length || !this.ownsPublicTables) throw new Error("Payment fixture ownership is incomplete");
    await this.pool.query(`TRUNCATE ${TABLES.map(qualifiedTable).join(",")},
      public.audit_events,public.financial_command_recoveries,public.financial_command_results RESTART IDENTITY CASCADE`);
    await new Promise<void>((done, reject) => this.sessionStore.clear((error) => error ? reject(error) : done()));
    await this.pool.query(`
      INSERT INTO identity.users(id,username,password,role,active) VALUES
        ('${PAYMENT_ACTORS.owner}','payment-owner','unused','admin',1),
        ('${PAYMENT_ACTORS.delegate}','payment-delegate','unused','picker',1),
        ('${PAYMENT_ACTORS.viewer}','payment-viewer','unused','admin',1);
      INSERT INTO identity.auth_roles(id,name) VALUES(1,'UAT owner'),(2,'UAT payment delegate'),(3,'UAT view only');
      INSERT INTO identity.auth_permissions(id,resource,action,category) VALUES
        (1,'purchasing','view','purchasing'),(2,'purchasing','approve','purchasing');
      INSERT INTO identity.auth_user_roles(user_id,role_id) VALUES
        ('${PAYMENT_ACTORS.owner}',1),('${PAYMENT_ACTORS.delegate}',2),('${PAYMENT_ACTORS.viewer}',3);
      INSERT INTO identity.auth_role_permissions(role_id,permission_id) VALUES(1,1),(1,2),(2,1),(2,2),(3,1);
      INSERT INTO procurement.vendors(id,code,name) VALUES(5,'FLOW-VENDOR','Synthetic FLOW vendor'),(6,'OTHER-VENDOR','Synthetic other vendor');
      INSERT INTO catalog.products(id,sku,name) VALUES(21,'FLOW-A','FLOW product A'),(22,'FLOW-B','FLOW product B');
      INSERT INTO catalog.product_variants(id,product_id,sku,name,uom_type,units_per_variant) VALUES
        (31,21,'FLOW-A-EACH','FLOW A piece','each',1),(32,22,'FLOW-B-EACH','FLOW B piece','each',1);
      INSERT INTO warehouse.warehouses(id,code,name) VALUES(41,'FLOW','Synthetic FLOW warehouse');
      INSERT INTO warehouse.warehouse_locations(id,warehouse_id,code,is_pickable) VALUES(42,41,'FLOW-PICK',1);
      INSERT INTO procurement.purchase_orders(id,po_number,vendor_id,status,physical_status,financial_status,currency,
        subtotal_cents,total_cents,invoiced_total_cents,paid_total_cents,outstanding_cents,first_invoiced_at)
      VALUES(11,'FLOW-PO-A',5,'received','received','invoiced','USD',210000,210000,210000,0,210000,CURRENT_TIMESTAMP),
        (12,'FLOW-PO-B',5,'received','received','invoiced','USD',210000,210000,210000,0,210000,CURRENT_TIMESTAMP);
      INSERT INTO procurement.purchase_order_lines(id,purchase_order_id,line_number,product_id,product_variant_id,sku,product_name,
        order_qty,received_qty,status,unit_cost_cents,unit_cost_mills,total_product_cost_cents,packaging_cost_cents,line_total_cents)
      VALUES(51,11,1,21,31,'FLOW-A','FLOW product A',1000,1000,'received',200,20000,200000,10000,210000),
        (52,12,1,22,32,'FLOW-B','FLOW product B',500,500,'received',400,40000,200000,10000,210000);
      INSERT INTO procurement.vendor_invoices(id,vendor_id,invoice_number,status,currency,invoiced_amount_cents,paid_amount_cents,
        balance_cents,approved_by,approved_at,created_by)
      VALUES(71,5,'FLOW-INVOICE-A','approved','USD',210000,0,210000,'${PAYMENT_ACTORS.owner}',CURRENT_TIMESTAMP,'${PAYMENT_ACTORS.owner}'),
        (72,5,'FLOW-INVOICE-B','approved','USD',210000,0,210000,'${PAYMENT_ACTORS.owner}',CURRENT_TIMESTAMP,'${PAYMENT_ACTORS.owner}');
      INSERT INTO procurement.vendor_invoice_po_links(vendor_invoice_id,purchase_order_id,allocated_amount_cents) VALUES(71,11,210000),(72,12,210000);
      INSERT INTO procurement.vendor_invoice_lines(vendor_invoice_id,purchase_order_line_id,line_number,sku,product_name,qty_invoiced,unit_cost_cents,unit_cost_mills,line_total_cents)
      VALUES(71,51,1,'FLOW-A','FLOW A including packaging',1000,210,21000,210000),
        (72,52,1,'FLOW-B','FLOW B including packaging',500,420,42000,210000);
      INSERT INTO inventory.inventory_levels(product_variant_id,warehouse_location_id,variant_qty) VALUES(31,42,900),(32,42,500);
      INSERT INTO inventory.inventory_lots(id,lot_number,product_variant_id,warehouse_location_id,purchase_order_id,po_line_id,
        qty_on_hand,qty_received,qty_consumed,received_at,unit_cost_cents,unit_cost_mills,po_unit_cost_cents,po_unit_cost_mills,
        packaging_cost_cents,packaging_cost_mills,landed_cost_cents,landed_cost_mills,total_unit_cost_cents,total_unit_cost_mills)
      VALUES(81,'FLOW-LOT-A',31,42,11,51,900,1000,100,'2026-09-09T12:00:00',200,20000,200,20000,10,1000,20,2000,230,23000),
        (82,'FLOW-LOT-B',32,42,12,52,500,500,0,'2026-09-09T12:00:00',400,40000,400,40000,20,2000,20,2000,440,44000);
      INSERT INTO wms.orders(id,order_number,customer_name,source,warehouse_status) VALUES(91,'FLOW-SALE','Synthetic customer','manual','shipped');
      INSERT INTO wms.order_items(id,order_id,sku,name,quantity,fulfilled_quantity) VALUES(92,91,'FLOW-A-EACH','FLOW A sale',100,100);
      INSERT INTO oms.order_item_costs(order_id,order_item_id,inventory_lot_id,product_variant_id,qty,unit_cost_cents,total_cost_cents,unit_cost_mills,total_cost_mills)
      VALUES(91,92,81,31,100,230,23000,23000,2300000);
    `);
    // Low bcrypt work factor is solely for synthetic local login fixtures.
    const passwordHash = await bcrypt.hash(DELEGATE_PASSWORD, 4);
    await this.pool.query("UPDATE identity.users SET password=$1 WHERE id=$2", [passwordHash, PAYMENT_ACTORS.delegate]);
  }

  async loginDelegate(): Promise<string> {
    const response = await fetch(`${this.baseUrl}/api/auth/login`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "payment-delegate", password: DELEGATE_PASSWORD }),
    });
    if (response.status !== 200) throw new Error(`Synthetic delegate login failed: ${response.status}`);
    const cookie = response.headers.get("set-cookie")?.split(";")[0];
    if (!cookie) throw new Error("Synthetic delegate login did not establish a session cookie");
    return cookie;
  }

  async request<T = PaymentHttpBody>(path: string, options: {
    body?: unknown; key?: string; actor?: string | null; cookie?: string;
  } = {}): Promise<PaymentHttpResult<T>> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    const actor = options.actor === undefined ? (options.cookie ? null : PAYMENT_ACTORS.owner) : options.actor;
    if (actor) headers["X-Payment-Fixture-Actor"] = actor;
    if (options.cookie) headers.Cookie = options.cookie;
    if (options.key) headers["Idempotency-Key"] = options.key;
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: options.body === undefined ? "GET" : "POST", headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
    return { status: response.status, replayed: response.headers.get("Idempotency-Replayed"), body: await response.json() as T };
  }

  async graph() {
    const [purchaseOrders, invoices, invoiceLines, invoiceLinks, payments, allocations, history, audits, inventory] = await Promise.all([
      this.pool.query("SELECT * FROM procurement.purchase_orders ORDER BY id"),
      this.pool.query("SELECT * FROM procurement.vendor_invoices ORDER BY id"),
      this.pool.query("SELECT * FROM procurement.vendor_invoice_lines ORDER BY id"),
      this.pool.query("SELECT * FROM procurement.vendor_invoice_po_links ORDER BY id"),
      this.pool.query("SELECT * FROM procurement.ap_payments ORDER BY id"),
      this.pool.query("SELECT * FROM procurement.ap_payment_allocations ORDER BY id"),
      this.pool.query("SELECT * FROM procurement.po_status_history ORDER BY id"),
      this.pool.query("SELECT * FROM public.audit_events ORDER BY id"),
      this.inventoryEvidence(),
    ]);
    return { purchaseOrders: purchaseOrders.rows, invoices: invoices.rows, invoiceLines: invoiceLines.rows,
      invoiceLinks: invoiceLinks.rows, payments: payments.rows,
      allocations: allocations.rows, history: history.rows, audits: audits.rows, inventory };
  }

  async inventoryEvidence() {
    const [lines, levels, lots, cogs, variants] = await Promise.all([
      this.pool.query("SELECT * FROM procurement.purchase_order_lines ORDER BY id"),
      this.pool.query("SELECT * FROM inventory.inventory_levels ORDER BY id"),
      this.pool.query("SELECT * FROM inventory.inventory_lots ORDER BY id"),
      this.pool.query("SELECT * FROM oms.order_item_costs ORDER BY id"),
      this.pool.query("SELECT * FROM catalog.product_variants ORDER BY id"),
    ]);
    return { lines: lines.rows, levels: levels.rows, lots: lots.rows, cogs: cogs.rows, variants: variants.rows };
  }

  async stop(): Promise<void> {
    try {
      if (this.server) await new Promise<void>((done, reject) => this.server!.close((error) => error ? reject(error) : done()));
      if (this.ownsPublicTables) {
        await this.pool.query(`DROP TABLE IF EXISTS public.financial_command_recoveries,public.financial_command_results,public.audit_events;
          DROP FUNCTION IF EXISTS public.guard_financial_command_result_update()`);
      }
      for (const name of [...this.ownedSchemas].reverse()) await this.pool.query(`DROP SCHEMA ${name} CASCADE`);
    } finally {
      if (this.lease) {
        await this.lease.query("SELECT pg_advisory_unlock(hashtext($1))", [FIXTURE_LEASE]);
        this.lease.release();
      }
      await this.pool?.end();
      await this.modulePool?.end();
    }
  }
}
