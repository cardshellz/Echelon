import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createServer, request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import express, { type RequestHandler } from "express";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "@shared/schema";
import { costSourceRevisionSchema } from "@shared/procurement/cost-source-contracts";
import { applyReturnRestock } from "../../application/return-restock.use-case";
import { applyCostRevision } from "../../application/apply-cost-revision";
import { COGSService } from "../../cogs.service";
import { InventoryLotService } from "../../lots.service";
import { costFingerprint, lockInventoryCostGraph, recordReceiptCostOrigin } from "../../infrastructure/cost-evidence.repository";
import { readLotCostFollowUps } from "../../infrastructure/lot-cost-follow-up.repository";
import { createReturnsService } from "../../../orders/returns.service";
import { fixtureForeignKeys, fixtureTable, qualifiedTable } from "../../../procurement/__tests__/integration/shipment-line-fixture";
import { installPreOpeningQuantityAuthorityFixture } from "../fixtures/pre-opening-quantity-authority.fixture";
import { returnCommandResultFor } from "@shared/inventory/return-command";
import { lotCostFollowUpReportSchema } from "@shared/inventory/lot-cost-follow-up";
import { executeMigrationWithRetry } from "../../../../../migrations/migration-executor";

// Exercise registered HTTP handlers against the real application/PG owners.
// Authentication and unrelated module singletons are isolated; no global DB
// or production server is started. Permission behavior has separate tests.
vi.mock("../../../../db", () => ({ db: {}, pool: {} }));
vi.mock("../../index", () => ({ inventoryStorage: {} }));
vi.mock("../../../warehouse", () => ({ warehouseStorage: {} }));
vi.mock("../../../catalog", () => ({ catalogStorage: {} }));
vi.mock("../../../orders", () => ({ ordersStorage: {} }));
vi.mock("../../../channels", () => ({ channelsStorage: {} }));
vi.mock("../../../../routes/middleware", () => {
  const pass: RequestHandler = (_req, _res, next) => next();
  return { requirePermission: () => pass, requireAuth: pass, upload: { single: () => pass } };
});
import { registerInventoryRoutes } from "../../inventory.routes";

const url = process.env.ECHELON_TEST_DATABASE_URL;
const suite = url && process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true" ? describe : describe.skip;
const now = new Date("2026-10-05T12:00:00Z");
const tables = [schema.products,schema.productVariants,schema.warehouses,schema.warehouseLocations,
  schema.inventoryLevels,schema.inventoryLots,schema.inventoryTransactions,schema.orders,schema.orderItems,
  schema.orderItemCosts,schema.purchaseOrderLines,schema.receivingOrders,schema.receivingLines];

suite.sequential("physical return and cost-only recovery ownership on PostgreSQL", () => {
  let pool: pg.Pool;
  let database: ReturnType<typeof drizzle<typeof schema>>;
  let cogs: COGSService;
  const ownedSchemas: string[] = [];

  beforeAll(async () => {
    const address = new URL(url!);
    if (!["127.0.0.1","localhost"].includes(address.hostname)
      || [process.env.DATABASE_URL,process.env.EXTERNAL_DATABASE_URL].filter(Boolean).includes(url!)) {
      throw new Error("Lot cost ownership tests require a separate explicitly disposable local database.");
    }
    pool = new pg.Pool({ connectionString: url,max: 6,statement_timeout: 15_000 });
    for (const name of ["catalog","warehouse","inventory","wms","oms","procurement","returns"]) {
      await pool.query(`CREATE SCHEMA ${name}`); ownedSchemas.push(name);
    }
    for (const table of tables) await pool.query(fixtureTable(table));
    for (const statement of fixtureForeignKeys(tables)) await pool.query(statement);
    // Empty prerequisites for unrelated document/portal owners. This suite
    // proves the real return cost/stock and financial application SQL, not
    // portal authorization, receipt close or active quantity-journal admission.
    await pool.query(`CREATE TABLE procurement.inbound_shipment_lines(id integer PRIMARY KEY);
      CREATE TABLE procurement.vendor_invoice_lines(id integer PRIMARY KEY);
      CREATE TABLE procurement.receipt_reversals(receiving_line_id integer);
      CREATE TABLE oms.oms_order_lines(id integer PRIMARY KEY,product_variant_id integer);
      CREATE TABLE returns.customer_return_authorizations(id integer PRIMARY KEY);
      CREATE TABLE returns.customer_return_authorization_lines(authorization_id integer,oms_order_line_id integer);
      -- Reduced query fixture for the existing canonical reversal identity.
      -- Full claim movement DDL/transitions are tested by the claim owner suites.
      CREATE TABLE inventory.availability_claim_pick_movements(id bigint PRIMARY KEY,
        order_item_cost_id integer NOT NULL REFERENCES oms.order_item_costs(id),
        movement_type text NOT NULL,quantity bigint NOT NULL,
        reverses_pick_movement_id bigint REFERENCES inventory.availability_claim_pick_movements(id));
      CREATE UNIQUE INDEX ownership_level_identity ON inventory.inventory_levels(product_variant_id,warehouse_location_id);
      CREATE TABLE inventory.cost_adjustment_log(id serial PRIMARY KEY,lot_id integer,lot_number text,
        product_variant_id integer,sku text,old_cost_cents bigint,new_cost_cents bigint,delta_cents bigint,
        reason text,created_at timestamp NOT NULL);`);
    await installPreOpeningQuantityAuthorityFixture(pool);
    for (const name of ["222_procurement_cost_evidence.sql","0725_inventory_cost_admission_evidence.sql","0726_inventory_return_cost_allocations.sql"]) {
      await pool.query(readFileSync(resolve(process.cwd(),"migrations",name),"utf8"));
    }
    database = drizzle(pool,{ schema }); cogs = new COGSService(database,()=>now);
  });

  beforeEach(async () => {
    await pool.query(`TRUNCATE ${tables.map(qualifiedTable).join(",")},inventory.cost_adjustment_log RESTART IDENTITY CASCADE`);
    await pool.query(`INSERT INTO catalog.products(id,sku,name) VALUES(10,'COST-TEST','Synthetic product');
      INSERT INTO catalog.product_variants(id,product_id,sku,name,units_per_variant,is_active,last_cost_cents)
        VALUES(101,10,'COST-P5','Synthetic pack',5,true,999);
      INSERT INTO warehouse.warehouses(id,code,name) VALUES(1,'COST-WH','Synthetic warehouse');
      INSERT INTO warehouse.warehouse_locations(id,warehouse_id,code,is_active,is_pickable)
        VALUES(20,1,'SOURCE',1,1),(30,1,'RETURNS',1,1);
      INSERT INTO wms.orders(id,order_number,customer_name) VALUES(61,'WMS-61','Synthetic customer'),(51,'DECOY-OMS-ID','Synthetic customer');
      INSERT INTO wms.order_items(id,order_id,sku,name,quantity)
        VALUES(71,61,'COST-P5','Returned line',4),(72,61,'COST-P5','Other same SKU',5),(73,51,'COST-P5','Other order',5);
      INSERT INTO inventory.inventory_levels(product_variant_id,warehouse_location_id,variant_qty) VALUES(101,30,0);
      INSERT INTO inventory.inventory_lots(id,lot_number,product_variant_id,warehouse_location_id,qty_on_hand,qty_received,
        cost_precision_version,cost_provisional,cost_source,unit_cost_mills,total_unit_cost_mills,
        po_unit_cost_mills,packaging_cost_mills,landed_cost_mills,unit_cost_cents,total_unit_cost_cents,received_at)
        VALUES(101,'SOLD-A',101,20,1,5,1,0,'purchase_order',149,149,100,20,29,1,1,'2026-10-01T12:00:00Z'),
          (102,'SOLD-B',101,20,1,5,1,0,'purchase_order',250,250,200,30,20,3,3,'2026-10-01T12:00:00Z'),
          (103,'DECOY-COST',101,20,1,5,1,0,'purchase_order',999,999,999,0,0,10,10,'2026-10-01T12:00:00Z');
      INSERT INTO oms.order_item_costs(id,order_id,order_item_id,inventory_lot_id,product_variant_id,qty,
        unit_cost_mills,total_cost_mills,unit_cost_cents,total_cost_cents,cost_precision_version)
        VALUES(1,61,71,101,101,2,149,298,1,3,1),(2,61,71,102,101,2,250,500,3,5,1),
          (3,61,72,103,101,5,999,4995,10,50,1),(4,51,73,103,101,5,999,4995,10,50,1);`);
  });

  afterAll(async () => {
    if (!pool) return;
    try { for (const name of [...ownedSchemas].reverse()) await pool.query(`DROP SCHEMA ${name} CASCADE`); }
    finally { await pool.end(); }
  });

  const returnInput = (quantity = 3, dispositionItemId = 901) => ({
    dispositionItemId,returnCaseId: 90,caseNumber: "RMA-COST",productVariantId: 101,
    warehouseLocationId: 30,quantity,omsOrderId: 51,wmsOrderId: 61,wmsOrderItemId: 71,
    actor: "operator:cost-test",notes: "Actual authorized returned packs",now,
  });
  async function restock(quantity = 3, dispositionItemId = 901) {
    return database.transaction(tx=>applyReturnRestock(tx,returnInput(quantity,dispositionItemId)));
  }
  async function returnedLayers() {
    return (await pool.query(`SELECT lot.id,lot.qty_on_hand,lot.po_unit_cost_mills,lot.packaging_cost_mills,
      lot.landed_cost_mills,lot.total_unit_cost_mills,lot.cost_provisional,allocation.source_order_item_cost_id,
      allocation.wms_order_id,allocation.wms_order_item_id,allocation.evidence_state
      FROM inventory.inventory_lots lot JOIN inventory.return_cost_allocations allocation ON allocation.returned_lot_id=lot.id
      ORDER BY lot.id`)).rows;
  }
  async function physicalState() {
    return {
      lots: (await pool.query("SELECT id,product_variant_id,warehouse_location_id,qty_received,qty_on_hand,qty_reserved,qty_picked,qty_consumed,status FROM inventory.inventory_lots ORDER BY id")).rows,
      levels: (await pool.query("SELECT * FROM inventory.inventory_levels ORDER BY id")).rows,
      transactions: (await pool.query("SELECT * FROM inventory.inventory_transactions ORDER BY id")).rows,
      allocations: (await pool.query("SELECT * FROM inventory.return_cost_allocations ORDER BY returned_lot_id")).rows,
      commands: (await pool.query("SELECT * FROM inventory.return_commands ORDER BY idempotency_key")).rows,
    };
  }
  async function financialState() {
    return {
      lots: (await pool.query("SELECT id,total_unit_cost_mills,po_unit_cost_mills,packaging_cost_mills,landed_cost_mills FROM inventory.inventory_lots ORDER BY id")).rows,
      costs: (await pool.query("SELECT * FROM oms.order_item_costs ORDER BY id")).rows,
      applications: (await pool.query("SELECT * FROM inventory.cost_applications ORDER BY id")).rows,
      attempts: (await pool.query("SELECT * FROM inventory.lot_cost_follow_up_attempts ORDER BY id")).rows,
      logs: (await pool.query("SELECT * FROM inventory.cost_adjustment_log ORDER BY id")).rows,
    };
  }
  async function revision(totalMills = 1000) {
    await pool.query(`INSERT INTO procurement.purchase_order_lines(id,purchase_order_id,line_number,order_qty) VALUES(5,4,1,5);
      INSERT INTO procurement.receiving_orders(id,receipt_number) VALUES(6,'SYNTHETIC-RECEIPT');
      INSERT INTO procurement.receiving_lines(id,receiving_order_id,purchase_order_line_id,product_variant_id,units_per_variant_snapshot,received_qty,cost_source_kind)
        VALUES(7,6,5,101,1,5,'purchase_order_line');
      UPDATE inventory.inventory_lots SET receiving_order_id=6,po_line_id=5 WHERE id=101;`);
    // Seed explicit frozen source evidence through the actual origin validator;
    // no source fact is inferred by the application or return owner.
    await database.transaction(tx=>recordReceiptCostOrigin(tx,{ inventoryLotId: 101,receivingLineId: 7,
      purchaseOrderLineId: 5,inboundShipmentLineId: null,unitsPerVariantSnapshot: 1,receivedVariantQty: 5 },"source-owner",now));
    const evidence = { syntheticReviewedPrice: totalMills,receivedQuantity: 5 };
    const contract = costSourceRevisionSchema.parse({ contractVersion: 1,revision: 1,fingerprint: costFingerprint(evidence),
      component: "product",scope: { kind: "purchase_order_line",purchaseOrderId: 4,purchaseOrderLineId: 5 },
      sources: [{ kind: "purchase_order_line",documentId: 4,lineId: 5,version: costFingerprint(evidence) }],
      currency: "USD",totalMills,basePieces: 5,evidence: "confirmed",packagingTreatment: "separate",issue: null,manualOverride: null });
    const result = await pool.query(`INSERT INTO procurement.cost_source_revisions(purchase_order_line_id,component,revision,fingerprint,contract,source_evidence,recorded_by,recorded_at)
      VALUES(5,'product',1,$1,$2,$3,'source-owner',$4) RETURNING id`,[contract.fingerprint,contract,evidence,now]);
    return { id: Number(result.rows[0].id),contract };
  }

  it("preserves distinct OMS/WMS/item identity and every exact partial sold layer", async () => {
    const first = await restock();
    expect(first.inventoryLotIds).toHaveLength(2);
    expect(await returnedLayers()).toMatchObject([
      { qty_on_hand: 2,source_order_item_cost_id: 1,wms_order_id: 61,wms_order_item_id: 71,
        po_unit_cost_mills: "100",packaging_cost_mills: "20",landed_cost_mills: "29",total_unit_cost_mills: "149" },
      { qty_on_hand: 1,source_order_item_cost_id: 2,total_unit_cost_mills: "250" },
    ]);
    await restock(1,902);
    expect((await returnedLayers()).at(-1)).toMatchObject({ qty_on_hand: 1,source_order_item_cost_id: 2,total_unit_cost_mills: "250" });
    const before = await physicalState();
    await expect(restock(1,903)).rejects.toMatchObject({ code: "RETURN_COST_QUANTITY_EXCEEDED" });
    expect(await physicalState()).toEqual(before);
  });

  it("keeps a mill-authoritative sold zero despite positive cent mirrors and catalog estimates", async () => {
    await pool.query(`UPDATE oms.order_item_costs SET unit_cost_mills=0,total_cost_mills=0,unit_cost_cents=999 WHERE id IN(1,2);
      UPDATE inventory.inventory_lots SET unit_cost_mills=0,total_unit_cost_mills=0,po_unit_cost_mills=0,
        packaging_cost_mills=0,landed_cost_mills=0,unit_cost_cents=999,total_unit_cost_cents=999 WHERE id IN(101,102)`);
    await restock();
    expect((await returnedLayers()).every(layer=>layer.total_unit_cost_mills==="0" && layer.evidence_state==="confirmed")).toBe(true);
    expect((await pool.query("SELECT count(*)::integer AS n FROM inventory.lot_cost_follow_ups")).rows[0].n).toBe(0);
  });

  it("admits an independently authorized return with null financial evidence when no source price exists", async () => {
    await pool.query("DELETE FROM oms.order_item_costs WHERE order_item_id=71; UPDATE catalog.product_variants SET last_cost_cents=0 WHERE id=101");
    await restock(1);
    expect((await pool.query("SELECT evidence_state,source_order_item_cost_id,source_evidence FROM inventory.return_cost_allocations")).rows)
      .toMatchObject([{ evidence_state: "unknown",source_order_item_cost_id: null,source_evidence: { unitMills: null,originalCostMissing: true } }]);
    expect(await returnedLayers()).toMatchObject([{ qty_on_hand: 1,cost_provisional: 1,evidence_state: "unknown" }]);
    const report = await readLotCostFollowUps(database);
    expect(report.items).toMatchObject([{ issueCode: "COST_RETURN_SOURCE_MISSING",state: "review_required" }]);
  });

  it("does not turn conflicting component history into a confirmed breakdown", async () => {
    await pool.query("UPDATE inventory.inventory_lots SET po_unit_cost_mills=200,unit_cost_mills=249,total_unit_cost_mills=249 WHERE id=101");
    await restock(1);
    expect(await returnedLayers()).toMatchObject([{ total_unit_cost_mills: "149",cost_provisional: 1,evidence_state: "review_required" }]);
    expect((await pool.query("SELECT source_evidence->>'componentHistoryKnown' AS known FROM inventory.return_cost_allocations")).rows)
      .toEqual([{ known: "false" }]);
  });

  it("replays concurrent identical commands once and rejects a changed replay", async () => {
    const results = await Promise.all([restock(),restock()]);
    expect(results.map(result=>result.replayed).sort()).toEqual([false,true]);
    expect(results[0].inventoryLotIds).toEqual(results[1].inventoryLotIds);
    const before = await physicalState();
    await expect(restock(2)).rejects.toMatchObject({ code: "RETURN_RESTOCK_REPLAY_CONFLICT" });
    expect(await physicalState()).toEqual(before);
    await expect(pool.query("DELETE FROM inventory.return_cost_allocations")).rejects.toMatchObject({ code: "55000" });
  });

  it("serializes different return commands against the remaining exact sold quantity", async () => {
    const results = await Promise.allSettled([restock(3,901),restock(3,902)]);
    expect(results.filter(result=>result.status==="fulfilled")).toHaveLength(1);
    const failed = results.find(result=>result.status==="rejected") as PromiseRejectedResult;
    expect(failed.reason).toMatchObject({ code: "RETURN_COST_QUANTITY_EXCEEDED" });
    expect((await returnedLayers()).reduce((sum,layer)=>sum+layer.qty_on_hand,0)).toBe(3);
  });

  it("nets an exact linked unpick before allocating partial returned sold layers", async () => {
    await pool.query(`INSERT INTO oms.order_item_costs(id,order_id,order_item_id,inventory_lot_id,product_variant_id,qty,
      unit_cost_mills,total_cost_mills,unit_cost_cents,total_cost_cents,cost_precision_version)
      VALUES(5,61,71,101,101,-1,149,-149,1,-1,1);
      INSERT INTO inventory.availability_claim_pick_movements VALUES(20,1,'pick',2,NULL),(21,5,'unpick',1,20);`);
    await restock();
    expect((await returnedLayers()).map(layer=>({ source: layer.source_order_item_cost_id,quantity: layer.qty_on_hand })))
      .toEqual([{ source: 1,quantity: 1 },{ source: 2,quantity: 2 }]);
    const accepted = await physicalState();
    await expect(restock(1,902)).rejects.toMatchObject({ code: "RETURN_COST_QUANTITY_EXCEEDED" });
    expect(await physicalState()).toEqual(accepted);
  });

  it("rejects an unlinked negative cost row instead of guessing which same-SKU pick it reversed", async () => {
    await pool.query(`INSERT INTO oms.order_item_costs(id,order_id,order_item_id,inventory_lot_id,product_variant_id,qty,
      unit_cost_mills,total_cost_mills,unit_cost_cents,total_cost_cents,cost_precision_version)
      VALUES(5,61,71,101,101,-1,149,-149,1,-1,1)`);
    const before = await physicalState();
    await expect(restock()).rejects.toMatchObject({ code: "RETURN_COST_ALLOCATION_CONFLICT" });
    expect(await physicalState()).toEqual(before);
  });

  it("recosts explicitly linked picks and unpicks with exact signed amounts before a partial return", async () => {
    await pool.query(`INSERT INTO oms.order_item_costs(id,order_id,order_item_id,inventory_lot_id,product_variant_id,qty,
      unit_cost_mills,total_cost_mills,unit_cost_cents,total_cost_cents,cost_precision_version)
      VALUES(5,61,71,101,101,-1,149,-149,1,-1,1);
      INSERT INTO inventory.availability_claim_pick_movements VALUES(20,1,'pick',2,NULL),(21,5,'unpick',1,20);`);
    const source = await revision();
    const before = await physicalState();
    const applied = await database.transaction(tx => applyCostRevision(tx, source, cogs, "accountant", now));
    expect(applied).toMatchObject({ status: "applied", cogsRowsUpdated: 2 });
    expect(await physicalState()).toEqual(before);
    expect((await pool.query(`SELECT id,qty,unit_cost_mills,total_cost_mills,total_cost_cents FROM oms.order_item_costs
      WHERE id IN (1,5) ORDER BY id`)).rows).toEqual([
      { id: 1, qty: 2, unit_cost_mills: "249", total_cost_mills: "498", total_cost_cents: "5" },
      { id: 5, qty: -1, unit_cost_mills: "249", total_cost_mills: "-249", total_cost_cents: "-2" },
    ]);
    const accepted = await financialState();
    await database.transaction(tx => applyCostRevision(tx, source, cogs, "accountant", now));
    expect(await financialState()).toEqual(accepted);
    await restock();
    expect((await returnedLayers()).map(layer => ({ source: layer.source_order_item_cost_id, quantity: layer.qty_on_hand,
      unitMills: layer.total_unit_cost_mills }))).toEqual([
      { source: 1, quantity: 1, unitMills: "249" }, { source: 2, quantity: 2, unitMills: "250" },
    ]);
  });

  it("rolls back every return layer and stock projection when audit evidence persistence fails", async () => {
    const before = await physicalState();
    await pool.query(`CREATE FUNCTION inventory.fail_return_allocation() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'injected return allocation failure'; END $$;
      CREATE TRIGGER fail_return_allocation BEFORE INSERT ON inventory.return_cost_allocations FOR EACH ROW EXECUTE FUNCTION inventory.fail_return_allocation()`);
    try {
      await expect(restock()).rejects.toThrow("injected return allocation failure");
      expect(await physicalState()).toEqual(before);
    } finally { await pool.query("DROP TRIGGER fail_return_allocation ON inventory.return_cost_allocations; DROP FUNCTION inventory.fail_return_allocation()"); }
  });

  it("uses the same owner for the supported legacy route, with optional-key compatibility and durable keyed replay", async () => {
    const service = createReturnsService(database,{}, { clock: ()=>now,newCommandKey: ()=>"legacy-older-client" });
    const input = { orderId: 61,warehouseLocationId: 30,userId: "operator:cost-test",
      items: [{ orderItemId: 71,productVariantId: 101,qty: 1,condition: "sellable" as const }] };
    await service.processReturn(input);
    const keyed = { ...input,commandKey: "inventory:stable-return" };
    const results = await Promise.all([service.processReturn(keyed),service.processReturn(keyed)]);
    expect(results[0]).toEqual(results[1]);
    expect((await returnedLayers()).reduce((sum,layer)=>sum+layer.qty_on_hand,0)).toBe(2);
    expect((await pool.query("SELECT count(*)::integer AS n FROM inventory.return_commands")).rows[0].n).toBe(2);
    await expect(service.processReturn({ ...keyed,items: [{ ...input.items[0],qty: 2 }] })).rejects.toMatchObject({ code: "RETURN_COMMAND_REPLAY_CONFLICT" });
  });

  it("bounds concurrent physical returns from the actual order quantity when sold costs are missing", async () => {
    await pool.query("DELETE FROM oms.order_item_costs WHERE order_item_id=71; UPDATE catalog.product_variants SET last_cost_cents=0 WHERE id=101");
    const service = createReturnsService(database,undefined,{ clock: ()=>now });
    const body = { orderId: 61,warehouseLocationId: 30,userId: "operator:cost-test",
      items: [{ orderItemId: 71,productVariantId: 101,qty: 4,condition: "sellable" as const }] };
    const outcomes = await Promise.allSettled([service.processReturn({ ...body,commandKey: "inventory:unknown-return-a" }),
      service.processReturn({ ...body,commandKey: "inventory:unknown-return-b" })]);
    expect(outcomes.filter(outcome=>outcome.status==="fulfilled")).toHaveLength(1);
    const failed = outcomes.find(outcome=>outcome.status==="rejected") as PromiseRejectedResult;
    expect(failed.reason).toMatchObject({ code: "RETURN_QUANTITY_EXCEEDED" });
    expect((await returnedLayers()).reduce((sum,layer)=>sum+layer.qty_on_hand,0)).toBe(4);
    expect((await returnedLayers()).every(layer=>layer.evidence_state==="unknown")).toBe(true);
    const accepted = await physicalState();
    const winner = outcomes[0].status==="fulfilled" ? "inventory:unknown-return-a" : "inventory:unknown-return-b";
    await service.processReturn({ ...body,commandKey: winner });
    expect(await physicalState()).toEqual(accepted);
  });

  it("posts and replays the registered HTTP return with real PostgreSQL and validates follow-up timestamps", async () => {
    await pool.query("DELETE FROM oms.order_item_costs WHERE order_item_id=71; UPDATE catalog.product_variants SET last_cost_cents=0 WHERE id=101");
    const app = express();
    // Let malformed JSON values reach the registered handler so its own boundary
    // is proved independently of Express's earlier strict-object parser.
    app.use(express.json({ strict: false }));
    app.use((req, _res, next) => {
      req.session = { user: { id: "operator:cost-test" } } as typeof req.session;
      next();
    });
    const httpServices: Pick<typeof app.locals.services, "returns" | "cogs" | "inventoryLots"> = {
      returns: createReturnsService(database, undefined, { clock: () => now }), cogs,
      inventoryLots: new InventoryLotService(database),
    };
    Object.assign(app.locals, { services: httpServices });
    registerInventoryRoutes(app);
    const server = createServer(app);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const port = (server.address() as AddressInfo).port;
    const request = (path: string, body?: Record<string, unknown> | null): Promise<{ status: number; body: unknown }> =>
      new Promise((resolve, reject) => {
        const call = httpRequest({ hostname: "127.0.0.1", port, path,
          method: body === undefined ? "GET" : "POST", headers: { "Content-Type": "application/json" } }, response => {
          const chunks: Buffer[] = [];
          response.on("data", chunk => chunks.push(Buffer.from(chunk)));
          response.on("error", reject);
          response.on("end", () => {
            try { resolve({ status: response.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) }); }
            catch (error) { reject(error); }
          });
        });
        call.on("error", reject);
        call.end(body === undefined ? undefined : JSON.stringify(body));
      });
    const body = { orderId: 61, warehouseLocationId: 30,
      items: [{ orderItemId: 71, productVariantId: 101, qty: 3, condition: "sellable" as const }] };
    const wire = { ...body, commandKey: "inventory:http-return" };
    try {
      for (const invalid of [null, { ...wire, commandKey: " invalid" },
        { ...wire, items: [body.items[0], body.items[0]] }, { ...wire, unknownField: true }]) {
        expect(await request("/api/returns/process", invalid))
          .toMatchObject({ status: 400, body: { code: "RETURN_INPUT_INVALID" } });
      }
      expect(await request("/api/returns/process", { ...wire, items: [{ ...body.items[0], qty: -1 }] }))
        .toMatchObject({ status: 400, body: { code: "RETURN_INPUT_INVALID" } });
      expect(await returnedLayers()).toEqual([]);
      const accepted = await Promise.all([request("/api/returns/process", wire), request("/api/returns/process", wire)]);
      expect(accepted.map(response => response.status)).toEqual([200, 200]);
      expect(accepted[0].body).toEqual(accepted[1].body);
      expect(returnCommandResultFor(body).parse(accepted[0].body)).toMatchObject({ processed: 1, totalBaseUnitsReturned: 15 });
      expect(await returnedLayers()).toMatchObject([{ qty_on_hand: 3, evidence_state: "unknown" }]);
      expect((await pool.query("SELECT count(*)::integer AS n FROM inventory.return_commands")).rows[0].n).toBe(1);
      const [lotValuation, cogsValuation] = await Promise.all([
        request("/api/inventory/valuation"), request("/api/cogs/valuation"),
      ]);
      expect(lotValuation).toMatchObject({ status: 200, body: { total: { qty: 6, valueCents: 14 },
        totalValueMills: "1398", quantityUnit: "variant", unknownCostQty: 3 } });
      expect(cogsValuation).toMatchObject({ status: 200, body: { totalQty: 6, totalValueCents: 14,
        totalValueMills: "1398", quantityUnit: "variant", unknownCostQty: 3 } });
      const physical = await physicalState();
      await pool.query("UPDATE warehouse.warehouse_locations SET is_active=0 WHERE id=30");
      expect(await request("/api/returns/process", wire)).toEqual(accepted[0]);
      const conflict = await request("/api/returns/process", { ...wire, items: [{ ...body.items[0], qty: 4 }] });
      expect(conflict).toMatchObject({ status: 409, body: { code: "RETURN_COMMAND_REPLAY_CONFLICT" } });
      expect(await physicalState()).toEqual(physical);
      const followUps = await request("/api/cogs/cost-follow-ups?limit=2");
      expect(followUps.status).toBe(200);
      const report = lotCostFollowUpReportSchema.parse(followUps.body);
      expect(report.items).toHaveLength(1);
      expect(report.items[0]).toMatchObject({ state: "review_required", recordedAt: now.toISOString() });
      expect((await request("/api/cogs/cost-follow-ups?afterId=true")).status).toBe(400);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
        server.closeAllConnections();
      });
    }
  });

  it.each(["damaged", "defective"] as const)("quarantines only newly returned %s lots, preserving history and replay", async condition => {
    const service = createReturnsService(database,{}, { clock: ()=>now });
    const input = { orderId: 61,warehouseLocationId: 30,userId: "operator:cost-test",commandKey: "inventory:damaged",
      items: [{ orderItemId: 71,productVariantId: 101,qty: 3,condition }] };
    const beforeSource = (await pool.query("SELECT id,qty_on_hand FROM inventory.inventory_lots ORDER BY id")).rows;
    const first = await service.processReturn(input);
    const before = await physicalState();
    expect(await service.processReturn(input)).toEqual(first);
    expect(await physicalState()).toEqual(before);
    expect((await pool.query("SELECT id,qty_on_hand FROM inventory.inventory_lots WHERE id>=101 ORDER BY id")).rows).toEqual(beforeSource);
    expect((await returnedLayers()).every(layer=>layer.qty_on_hand===0)).toBe(true);
    const history = await service.getReturnHistory(61);
    expect(history).toHaveLength(2);
    expect(history.every(item=>item.condition===condition && item.orderItemId===71)).toBe(true);
    expect(history.reduce((sum,item)=>sum+item.qty,0)).toBe(3);
    expect((await pool.query("SELECT qty_consumed FROM inventory.inventory_lots WHERE id IN (SELECT returned_lot_id FROM inventory.return_cost_allocations) ORDER BY id")).rows)
      .toEqual([{ qty_consumed: 2 }, { qty_consumed: 1 }]);
    expect((await pool.query("SELECT variant_qty FROM inventory.inventory_levels WHERE warehouse_location_id=30")).rows).toEqual([{ variant_qty: 0 }]);
  });

  it("applies later source cost through returned descendants without replaying any physical work", async () => {
    await pool.query("UPDATE inventory.inventory_lots SET cost_provisional=1 WHERE id=101");
    await restock(); const source = await revision();
    const before = await physicalState();
    const applied = await database.transaction(tx=>applyCostRevision(tx,source,cogs,"accountant",now));
    expect(applied).toMatchObject({ status: "applied",lotsUpdated: 2,cogsRowsUpdated: 1 });
    expect((await returnedLayers())[0]).toMatchObject({ total_unit_cost_mills: "249",packaging_cost_mills: "20",landed_cost_mills: "29" });
    expect((await pool.query("SELECT unit_cost_mills,total_cost_mills,qty FROM oms.order_item_costs WHERE id=1")).rows)
      .toEqual([{ unit_cost_mills: "249",total_cost_mills: "498",qty: 2 }]);
    expect(await physicalState()).toEqual(before);
    const financial = await financialState();
    const replay = await database.transaction(tx=>applyCostRevision(tx,source,cogs,"accountant",now));
    expect(replay).toMatchObject({ applicationId: applied.applicationId,replayed: true });
    expect(await financialState()).toEqual(financial);
    // A product correction alone does not certify every historical component.
    expect((await readLotCostFollowUps(database)).items.every(item=>item.state==="review_required")).toBe(true);
  });

  it("persists missing historical basis as review instead of inventing an original intake", async () => {
    await restock(); const source = await revision();
    await pool.query("UPDATE inventory.inventory_lots SET qty_received=0 WHERE id=101");
    const before = await physicalState(); const costs = (await financialState()).costs;
    const result = await database.transaction(tx=>applyCostRevision(tx,source,cogs,"accountant",now));
    expect(result).toMatchObject({ status: "review_required",lotsUpdated: 0,issues: expect.arrayContaining([
      expect.objectContaining({ code: "COST_HISTORICAL_BASIS_MISSING" })]) });
    expect(await physicalState()).toEqual(before); expect((await financialState()).costs).toEqual(costs);
  });

  it("preserves a signed source credit for review without posting a negative lot or changing stock", async () => {
    await restock(); const source = await revision(-100);
    const before = await physicalState(); const costs = (await financialState()).costs;
    const result = await database.transaction(tx=>applyCostRevision(tx,source,cogs,"accountant",now));
    expect(result).toMatchObject({ status: "review_required",lotsUpdated: 0,
      issues: expect.arrayContaining([expect.objectContaining({ code: "COST_SOURCE_NOT_APPLICABLE" })]) });
    expect(source.contract.totalMills).toBe(-100);
    expect(await physicalState()).toEqual(before); expect((await financialState()).costs).toEqual(costs);
  });

  it("preserves a manually protected component across cost-only source application", async () => {
    await restock(); const source = await revision();
    await pool.query("UPDATE inventory.inventory_lots SET cost_source='manual' WHERE id=101");
    const before = await physicalState(); const costs = (await financialState()).costs;
    const result = await database.transaction(tx=>applyCostRevision(tx,source,cogs,"accountant",now));
    expect(result).toMatchObject({ status: "review_required",lotsUpdated: 0,
      issues: expect.arrayContaining([expect.objectContaining({ code: "COST_MANUAL_OVERRIDE_REVIEW" })]) });
    expect(await physicalState()).toEqual(before); expect((await financialState()).costs).toEqual(costs);
  });

  it("rolls back financial correction and COGS if recording its follow-up result fails", async () => {
    await pool.query("UPDATE inventory.inventory_lots SET cost_provisional=1 WHERE id=101");
    await restock(); const source = await revision();
    const before = await financialState(); const physical = await physicalState();
    await pool.query(`CREATE FUNCTION inventory.fail_follow_up_attempt() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'injected financial follow-up failure'; END $$;
      CREATE TRIGGER fail_follow_up_attempt BEFORE INSERT ON inventory.lot_cost_follow_up_attempts FOR EACH ROW EXECUTE FUNCTION inventory.fail_follow_up_attempt()`);
    try {
      await expect(database.transaction(tx=>applyCostRevision(tx,source,cogs,"accountant",now))).rejects.toThrow("injected financial follow-up failure");
      expect(await financialState()).toEqual(before); expect(await physicalState()).toEqual(physical);
    } finally { await pool.query("DROP TRIGGER fail_follow_up_attempt ON inventory.lot_cost_follow_up_attempts; DROP FUNCTION inventory.fail_follow_up_attempt()"); }
    expect((await database.transaction(tx=>applyCostRevision(tx,source,cogs,"accountant",now))).status).toBe("applied");
    expect(await physicalState()).toEqual(physical);
  });

  it("binds returns to a concurrent committed recost under the same graph lock", async () => {
    const writer = await pool.connect(); let pending: ReturnType<typeof restock> | undefined;
    let backendId = 0;
    try {
      await writer.query("BEGIN");
      const { costEvidenceTransactionFromPg } = await import("../../infrastructure/cost-evidence-pg");
      await lockInventoryCostGraph(costEvidenceTransactionFromPg(writer));
      await writer.query("UPDATE inventory.inventory_lots SET unit_cost_mills=249,total_unit_cost_mills=249,po_unit_cost_mills=200 WHERE id=101");
      await writer.query("UPDATE oms.order_item_costs SET unit_cost_mills=249,total_cost_mills=qty*249 WHERE id=1");
      pending = database.transaction(async tx=> {
        backendId=Number((await tx.execute(sql`SELECT pg_backend_pid() AS id`)).rows[0].id);
        return applyReturnRestock(tx,returnInput(1));
      });
      let waiting = false;
      for (let attempt=0;attempt<100;attempt++) {
        if (backendId) waiting=(await writer.query("SELECT EXISTS(SELECT 1 FROM pg_locks WHERE pid=$1 AND locktype='advisory' AND NOT granted) AS waiting",[backendId])).rows[0].waiting;
        if (waiting) break;
        await new Promise(done=>setTimeout(done,10));
      }
      expect(waiting).toBe(true); await writer.query("COMMIT"); await pending;
      expect((await returnedLayers())[0]).toMatchObject({ total_unit_cost_mills: "249",po_unit_cost_mills: "200" });
    } finally { await writer.query("ROLLBACK"); writer.release(); await pending; }
  });

  it.each([
    { name: "0725_inventory_cost_admission_evidence.sql", schemaName: "inventory", tableName: "inventory_lots",
      evidenceTables: ["inventory.lot_cost_follow_ups", "inventory.lot_cost_follow_up_attempts"],
      reset: `DROP TABLE inventory.lot_cost_follow_up_attempts,inventory.lot_cost_follow_ups;
        ALTER TABLE inventory.inventory_lots DROP COLUMN cost_precision_version;` },
    { name: "0726_inventory_return_cost_allocations.sql", schemaName: "oms", tableName: "order_item_costs",
      evidenceTables: ["inventory.return_cost_allocations", "inventory.return_commands"],
      reset: `DROP TABLE inventory.return_cost_allocations,inventory.return_commands;
        ALTER TABLE oms.order_item_costs DROP COLUMN cost_precision_version;
        ALTER TABLE inventory.lot_cost_contributions DROP CONSTRAINT lot_cost_contributions_operation_kind_check;
        ALTER TABLE inventory.lot_cost_contributions ADD CONSTRAINT lot_cost_contributions_operation_kind_check
          CHECK(operation_kind IN ('transfer','conversion','assembly','build'));` },
  ])("keeps $name schema and tracking atomic under the release executor", async migration => {
    const client = await pool.connect();
    let trackingCreated = false;
    try {
      // This suite owns the disposable database and runs sequentially. Reset only
      // this batch's metadata; keep all source lots and physical quantities intact.
      expect((await client.query("SELECT to_regclass('_migrations') AS relation")).rows[0].relation).toBeNull();
      await client.query(migration.reset);
      const physical = (await client.query("SELECT id,qty_on_hand,qty_received FROM inventory.inventory_lots ORDER BY id")).rows;
      await client.query(`CREATE TABLE _migrations(filename text PRIMARY KEY,content_hash text,
        CONSTRAINT reject_migration_tracking CHECK(false))`);
      trackingCreated = true;
      const sourceSql = readFileSync(resolve(process.cwd(), "migrations", migration.name), "utf8");
      const input = { client,file: migration.name,sql: sourceSql,contentHash: costFingerprint(sourceSql),
        options: { maxAttempts: 1,retryBaseDelayMs: 0,retryMaxDelayMs: 0,lockTimeoutMs: 2000 } };
      await expect(executeMigrationWithRetry(input)).rejects.toMatchObject({ code: "23514" });
      for (const table of migration.evidenceTables) {
        expect((await client.query("SELECT to_regclass($1) AS relation", [table])).rows[0].relation).toBeNull();
      }
      const column = await client.query(`SELECT EXISTS(SELECT 1 FROM information_schema.columns
        WHERE table_schema=$1 AND table_name=$2 AND column_name='cost_precision_version') AS present`,
      [migration.schemaName,migration.tableName]);
      expect(column.rows[0].present).toBe(false);
      expect((await client.query("SELECT count(*)::integer AS count FROM _migrations")).rows[0].count).toBe(0);
      expect((await client.query("SELECT id,qty_on_hand,qty_received FROM inventory.inventory_lots ORDER BY id")).rows).toEqual(physical);
      if (migration.schemaName === "oms") {
        expect((await client.query(`SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
          WHERE conrelid='inventory.lot_cost_contributions'::regclass
            AND conname='lot_cost_contributions_operation_kind_check'`)).rows[0].definition).not.toContain("'return'");
      }
      await client.query("ALTER TABLE _migrations DROP CONSTRAINT reject_migration_tracking");
      expect(await executeMigrationWithRetry(input)).toEqual({ attempts: 1 });
      expect((await client.query("SELECT filename,content_hash FROM _migrations")).rows)
        .toEqual([{ filename: migration.name,content_hash: input.contentHash }]);
      for (const table of migration.evidenceTables) {
        expect((await client.query("SELECT to_regclass($1) AS relation", [table])).rows[0].relation).not.toBeNull();
      }
      expect((await client.query("SELECT id,qty_on_hand,qty_received FROM inventory.inventory_lots ORDER BY id")).rows).toEqual(physical);
    } finally {
      try { if (trackingCreated) await client.query("DROP TABLE _migrations"); }
      finally { client.release(); }
    }
  });
});
