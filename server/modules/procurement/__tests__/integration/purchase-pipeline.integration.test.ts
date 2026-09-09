import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPurchasePipelineRepository, type PipelineDatabase } from "../../purchase-pipeline.repository";
import { projectPurchasePipeline } from "../../purchase-pipeline.service";
import { createSupplierProgressService } from "../../supplier-progress.service";
import { recordCostRevision } from "../../cost-source-revision.repository";

const url = process.env.ECHELON_TEST_DATABASE_URL;
const suite = url && process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true" ? describe : describe.skip;
suite.sequential("purchase pipeline and supplier progress PostgreSQL", () => {
  let pool: pg.Pool; let lease: pg.PoolClient | undefined; let database: PipelineDatabase; let ownsSchema = false;
  const at = new Date("2026-09-07T12:00:00.000Z");
  let repository: ReturnType<typeof createPurchasePipelineRepository>; let service: ReturnType<typeof createSupplierProgressService>;
  beforeAll(async () => {
    if (!url || !["localhost", "127.0.0.1"].includes(new URL(url).hostname) || [process.env.DATABASE_URL, process.env.EXTERNAL_DATABASE_URL].includes(url)) throw new Error("Use a separate local disposable pipeline database.");
    pool = new pg.Pool({ connectionString: url, max: 6, statement_timeout: 10_000 });
    lease = await pool.connect();
    const lock = await lease.query("SELECT pg_try_advisory_lock(hashtext('echelon.procurement.cost-audit-fixture')) AS acquired");
    if (!lock.rows[0].acquired) throw new Error("Another procurement fixture owns the schema lease");
    await pool.query("CREATE SCHEMA procurement"); ownsSchema = true;
    await pool.query(`
      CREATE TABLE procurement.vendors(id integer PRIMARY KEY,name text NOT NULL);
      CREATE TABLE procurement.purchase_orders(id integer PRIMARY KEY,vendor_id integer NOT NULL REFERENCES procurement.vendors(id),po_number text NOT NULL,status text NOT NULL,currency text,confirmed_delivery_date timestamptz,expected_delivery_date timestamptz);
      CREATE TABLE procurement.purchase_order_lines(id integer PRIMARY KEY,purchase_order_id integer NOT NULL REFERENCES procurement.purchase_orders(id),line_type text NOT NULL DEFAULT 'product',status text NOT NULL DEFAULT 'open',sku text,product_name text,order_qty integer NOT NULL,received_qty integer NOT NULL DEFAULT 0,cancelled_qty integer NOT NULL DEFAULT 0,pricing_basis text NOT NULL DEFAULT 'per_piece',quoted_unit_cost_mills bigint,quoted_total_cents bigint,total_product_cost_cents bigint NOT NULL DEFAULT 0,purchase_uom_quantity integer,pieces_per_purchase_uom integer,packaging_cost_cents bigint,quote_reference text,expected_delivery_date timestamptz,promised_date timestamptz);
      CREATE TABLE procurement.inbound_shipments(id integer PRIMARY KEY,shipment_number text NOT NULL,status text NOT NULL,eta timestamptz,delivered_date timestamptz);
      CREATE TABLE procurement.inbound_shipment_lines(id integer PRIMARY KEY,inbound_shipment_id integer NOT NULL REFERENCES procurement.inbound_shipments(id),purchase_order_id integer,purchase_order_line_id integer,qty_shipped integer NOT NULL);
      CREATE TABLE procurement.receiving_orders(id integer PRIMARY KEY,purchase_order_id integer,inbound_shipment_id integer,status text NOT NULL);
      CREATE TABLE procurement.receiving_lines(id integer PRIMARY KEY,receiving_order_id integer NOT NULL REFERENCES procurement.receiving_orders(id),purchase_order_line_id integer,inbound_shipment_line_id integer,received_qty integer NOT NULL,reversed_qty integer NOT NULL DEFAULT 0,units_per_variant_snapshot integer);
      CREATE TABLE procurement.po_receipts(id integer PRIMARY KEY,receiving_line_id integer NOT NULL,receiving_order_id integer NOT NULL,purchase_order_id integer NOT NULL,purchase_order_line_id integer NOT NULL,qty_received integer NOT NULL);
      CREATE TABLE procurement.receipt_reversals(id integer PRIMARY KEY,receiving_line_id integer NOT NULL,receiving_order_id integer NOT NULL,qty integer NOT NULL,base_units_reversed integer);
      CREATE TABLE procurement.cost_source_revisions(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,purchase_order_line_id integer NOT NULL,inbound_shipment_line_id integer,component text NOT NULL,revision integer NOT NULL,fingerprint text NOT NULL,contract jsonb NOT NULL,source_evidence jsonb,recorded_by text NOT NULL,recorded_at timestamptz NOT NULL);
      INSERT INTO procurement.vendors VALUES(1,'Supplier fixture');
      INSERT INTO procurement.purchase_orders(id,vendor_id,po_number,status,currency) VALUES(1,1,'TEST-PO-1','acknowledged','USD'),(2,1,'TEST-PO-2','sent','EUR'),(3,1,'TEST-DRAFT','draft','USD');
      INSERT INTO procurement.purchase_order_lines(id,purchase_order_id,sku,product_name,order_qty,quoted_unit_cost_mills,packaging_cost_cents,expected_delivery_date) VALUES(11,1,'TEST-1','Fixture one',100,10000,1000,'2026-10-17'),(22,2,'TEST-2','Fixture two',50,20000,0,NULL),(33,3,'TEST-3','Ignored draft',1000,10000,0,NULL);
      INSERT INTO procurement.inbound_shipments VALUES(7,'TEST-SHARED','in_transit','2026-09-27',NULL),(8,'TEST-SPLIT','at_port','2026-09-02',NULL);
      INSERT INTO procurement.inbound_shipment_lines VALUES(111,7,1,11,60),(222,7,2,22,25),(223,8,2,22,25);
      INSERT INTO procurement.receiving_orders VALUES(3,1,7,'closed');
      INSERT INTO procurement.receiving_lines VALUES(31,3,11,111,2,0,10);
    `);
    const migration = readFileSync(resolve(process.cwd(), "migrations/226_purchase_supplier_progress.sql"), "utf8");
    await pool.query(migration); await pool.query(migration);
    database = drizzle(pool) as unknown as PipelineDatabase;
    repository = createPurchasePipelineRepository(database); service = createSupplierProgressService(database, () => at);
  });
  afterAll(async () => { try { if (ownsSchema) await pool.query("DROP SCHEMA procurement CASCADE"); } finally { lease?.release(); await pool?.end(); } });
  const command = (expectedRevision: number, startedPieces = 100, completedPieces = 70, notes = "") => ({ expectedRevision, idempotencyKey: randomUUID(), report: { startedPieces, completedPieces, asOf: at.toISOString(), reference: "Supplier evidence", notes } });

  it("loads exact shared/split source joins, omits drafts, and subtracts physical receipt before PO/AP sync", async () => {
    const input = await repository.read();
    expect(input.lines.map((line) => line.id)).toEqual([11,22]);
    const result = projectPurchasePipeline(input, at, 90);
    expect(result.rows.filter((row) => row.purchaseOrderLineId === 11).reduce((sum,row) => sum + row.quantityPieces!,0)).toBe(80);
    expect(result.rows.filter((row) => row.purchaseOrderLineId === 22).map((row) => [row.shipmentId,row.quantityPieces])).toEqual([[7,25],[8,25]]);
    expect(result.totals.some((row) => row.currency === "EUR")).toBe(true);
    expect(result.rows.find((row) => row.shipmentId === 8)?.arrivalBucket).toBe("overdue");
  });
  it("reads existing legacy PO component totals as exact strings and apportions them over split shipments after receipt", async () => {
    // The original quote basis is absent, but historical PO totals are present.
    // Distinct IDs keep this read-model fixture separate from progress writes.
    await pool.query(`
      INSERT INTO procurement.purchase_orders(id,vendor_id,po_number,status,currency) VALUES(4,1,'TEST-LEGACY','sent','USD');
      INSERT INTO procurement.purchase_order_lines(id,purchase_order_id,sku,order_qty,pricing_basis,total_product_cost_cents,packaging_cost_cents)
        VALUES(44,4,'TEST-LEGACY-ITEM',100,'legacy_unknown',98765,1234);
      INSERT INTO procurement.inbound_shipment_lines VALUES(441,7,4,44,60),(442,8,4,44,40);
      INSERT INTO procurement.receiving_orders VALUES(4,4,7,'closed');
      INSERT INTO procurement.receiving_lines VALUES(41,4,44,441,2,0,10);
    `);
    try {
      const evidence = await repository.read();
      expect(evidence.lines.find((line) => line.id === 44)).toMatchObject({ pricingBasis: "legacy_unknown", quotedUnitMills: null, productCents: "98765", packagingCents: "1234" });
      const rows = projectPurchasePipeline(evidence, at, 90).rows.filter((row) => row.purchaseOrderLineId === 44);
      expect(rows.map((row) => [row.shipmentId, row.quantityPieces])).toEqual([[7, 40], [8, 40]]);
      expect(rows.every((row) => row.costs[0].source === "purchase_order" && row.costs[0].evidence === "estimated")).toBe(true);
      expect(rows.reduce((sum, row) => sum + BigInt(row.costs[0].amountMills!), BigInt(0))).toBe(BigInt(7901200));
      expect(rows.reduce((sum, row) => sum + BigInt(row.costs[1].amountMills!), BigInt(0))).toBe(BigInt(98720));
      expect(rows.every((row) => row.costs[2].amountMills === null)).toBe(true);
      await pool.query("UPDATE procurement.purchase_order_lines SET total_product_cost_cents=9007199254740993 WHERE id=44");
      const large = projectPurchasePipeline(await repository.read(), at, 90).rows.filter((row) => row.purchaseOrderLineId === 44);
      expect(large.reduce((sum, row) => sum + BigInt(row.costs[0].amountMills!), BigInt(0))).toBe(BigInt("720575940379279440"));
      expect((await pool.query("SELECT pricing_basis,quoted_unit_cost_mills,total_product_cost_cents FROM procurement.purchase_order_lines WHERE id=44")).rows[0]).toEqual({ pricing_basis: "legacy_unknown", quoted_unit_cost_mills: null, total_product_cost_cents: "9007199254740993" });
      await pool.query("UPDATE procurement.purchase_order_lines SET total_product_cost_cents=0,packaging_cost_cents=0 WHERE id=44");
      const unknown = projectPurchasePipeline(await repository.read(), at, 90).rows.filter((row) => row.purchaseOrderLineId === 44);
      expect(unknown.every((row) => row.costs.every((cost) => cost.amountMills === null && cost.evidence === "unknown"))).toBe(true);
      await pool.query("UPDATE procurement.purchase_order_lines SET pricing_basis='per_piece',quoted_unit_cost_mills=0 WHERE id=44");
      const explicitZero = projectPurchasePipeline(await repository.read(), at, 90).rows.filter((row) => row.purchaseOrderLineId === 44);
      expect(explicitZero.every((row) => row.costs.slice(0, 2).every((cost) => cost.amountMills === "0" && cost.evidence === "estimated"))).toBe(true);
    } finally {
      await pool.query("DELETE FROM procurement.receiving_lines WHERE id=41; DELETE FROM procurement.receiving_orders WHERE id=4; DELETE FROM procurement.inbound_shipment_lines WHERE id IN (441,442); DELETE FROM procurement.purchase_order_lines WHERE id=44; DELETE FROM procurement.purchase_orders WHERE id=4;");
    }
  });
  it("records report, immutable before/after and actor/time in one transaction without inventory/AP writes", async () => {
    const result = await service.update(11,command(0),"pipeline-operator");
    expect(result).toMatchObject({ revision: 1,reused: false,recordedBy: "pipeline-operator",recordedAt: at.toISOString() });
    const history = await repository.history(11);
    expect(history.changes[0]).toMatchObject({ revision: 1,before: null,after: { startedPieces: 100,completedPieces: 70 } });
    expect((await pool.query("SELECT received_qty FROM procurement.purchase_order_lines WHERE id=11")).rows[0].received_qty).toBe(0);
    expect(projectPurchasePipeline(await repository.read(),at,90).rows.filter((row) => row.purchaseOrderLineId === 11).map((row) => [row.stage,row.quantityPieces])).toEqual([["in_transit",40],["ready_to_ship",10],["in_production",30]]);
  });
  it("replays a lost result after a later correction and rejects changed payload reuse", async () => {
    const saved = command(1,100,100);
    expect(await service.update(11,saved,"pipeline-operator")).toMatchObject({ revision: 2 });
    await service.update(11,command(2,90,70,"Corrected supplier report"),"pipeline-operator");
    expect(await service.update(11,saved,"pipeline-operator")).toMatchObject({ revision: 2,reused: true });
    await expect(service.update(11,{...saved,report:{...saved.report,notes:"different"}},"pipeline-operator")).rejects.toMatchObject({ code: "SUPPLIER_PROGRESS_IDEMPOTENCY_CONFLICT" });
    expect((await repository.history(11)).current.revision).toBe(3);
  });
  it("serializes competing revisions with one winner", async () => {
    const results = await Promise.allSettled([service.update(11,command(3,100,70),"operator-a"),service.update(11,command(3,100,80),"operator-b")]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({ reason:{ code:"SUPPLIER_PROGRESS_CHANGED" } });
  });
  it("rolls history and current progress back together on a late database failure", async () => {
    const before = await repository.history(11);
    await pool.query("CREATE FUNCTION procurement.pipeline_fail_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.report->>'notes' = 'fail late' THEN RAISE EXCEPTION 'synthetic late failure'; END IF; RETURN NEW; END; $$; CREATE TRIGGER pipeline_fail_update BEFORE UPDATE ON procurement.purchase_supplier_progress FOR EACH ROW EXECUTE FUNCTION procurement.pipeline_fail_update()");
    await expect(service.update(11,command(before.current.revision,100,70,"fail late"),"pipeline-operator")).rejects.toThrow("synthetic late failure");
    expect(await repository.history(11)).toEqual(before);
  });
  it("validates bounds, activity, report timestamps and preserves immutable history", async () => {
    const revision = (await repository.history(11)).current.revision;
    await expect(service.update(11,command(revision,101,70),"pipeline-operator")).rejects.toMatchObject({ code:"SUPPLIER_PROGRESS_QUANTITY_EXCEEDED" });
    const future = command(revision); future.report.asOf="2027-01-01T00:00:00.000Z";
    await expect(service.update(11,future,"pipeline-operator")).rejects.toMatchObject({ code:"SUPPLIER_PROGRESS_DATE_INVALID" });
    await expect(service.update(33,command(0),"pipeline-operator")).rejects.toMatchObject({ code:"SUPPLIER_PROGRESS_LINE_INACTIVE" });
    await expect(pool.query("UPDATE procurement.purchase_supplier_progress_revisions SET recorded_by='rewritten' WHERE purchase_order_line_id=11")).rejects.toThrow("immutable");
    await expect(pool.query("DELETE FROM procurement.purchase_supplier_progress_revisions WHERE purchase_order_line_id=11")).rejects.toThrow("immutable");
  });
  it("reads actual cost-owner fingerprints and full source coverage without extrapolating partial confirmed amounts", async () => {
    await database.transaction(async (tx) => {
      await recordCostRevision(tx,{contractVersion:1,component:"product",scope:{kind:"purchase_order_line",purchaseOrderId:1,purchaseOrderLineId:11},sources:[{kind:"vendor_invoice_line",documentId:8,lineId:9,version:"a".repeat(64)}],currency:"USD",totalMills:700000,basePieces:100,evidence:"confirmed",packagingTreatment:"separate",issue:null,manualOverride:null},"cost-operator",at,{invoice:"real owner fixture"});
    });
    const rows = projectPurchasePipeline(await repository.read(),at,90).rows.filter((row) => row.purchaseOrderLineId===11);
    expect(rows.every((row) => row.costs[0].evidence==="confirmed")).toBe(true);
    expect(rows.reduce((sum,row) => sum+BigInt(row.costs[0].amountMills!),BigInt(0))).toBe(BigInt(560000));
    await database.transaction(async (tx) => { await recordCostRevision(tx,{contractVersion:1,component:"product",scope:{kind:"purchase_order_line",purchaseOrderId:1,purchaseOrderLineId:11},sources:[{kind:"vendor_invoice_line",documentId:8,lineId:9,version:"b".repeat(64)}],currency:"USD",totalMills:200000,basePieces:20,evidence:"confirmed",packagingTreatment:"separate",issue:null,manualOverride:null},"cost-operator",at,{invoice:"partial coverage"}); });
    expect(projectPurchasePipeline(await repository.read(),at,90).rows.filter((row) => row.purchaseOrderLineId===11).every((row) => row.costs[0].amountMills===null)).toBe(true);
  });
  it("uses a read-only repeatable-read transaction and fails visibly when required storage is absent", async () => {
    let seen: unknown;
    const wrapped = { transaction: async (work: (tx: unknown) => Promise<unknown>,config: unknown) => { seen=config; return database.transaction(work as never,config as never); } } as unknown as PipelineDatabase;
    await createPurchasePipelineRepository(wrapped).read();
    expect(seen).toEqual({isolationLevel:"repeatable read",accessMode:"read only"});
    await pool.query("ALTER TABLE procurement.purchase_supplier_progress RENAME TO pipeline_progress_hidden");
    try { await expect(repository.read()).rejects.toThrow("purchase_supplier_progress"); }
    finally { await pool.query("ALTER TABLE procurement.pipeline_progress_hidden RENAME TO purchase_supplier_progress"); }
  });
});
