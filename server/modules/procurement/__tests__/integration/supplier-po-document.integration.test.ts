import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "@shared/schema";
import { validatePostgresTestEnvironment } from "../../../../../scripts/ci/postgres-tests";
import { fixtureForeignKeys, fixtureTable, qualifiedTable } from "./shipment-line-fixture";

// Substitute only the database connection, never query results or PO economics.
// No application environment file, default pool or external provider is loaded.
const connection = vi.hoisted(() => ({ database: null as ReturnType<typeof drizzle<typeof schema>> | null }));
vi.mock("../../../../db", () => ({ db: new Proxy({}, { get(_target, property) {
  if (!connection.database) throw new Error("Supplier document test database not initialized");
  const value = Reflect.get(connection.database, property);
  return typeof value === "function" ? value.bind(connection.database) : value;
} }) }));
import { procurementMethods } from "../../procurement.storage";
import { productMethods } from "../../../catalog/catalog.storage";
import { createPurchasingService, type CreatePurchaseOrderWithLinesInput } from "../../purchasing.service";
import { buildSupplierPoDocument } from "../../supplier-po-document";
import { renderPoHtml } from "../../po-document";
import { loadSupplierPoDocumentSource } from "../../supplier-po-document.repository";

const TEST_URL = process.env.ECHELON_TEST_DATABASE_URL;
const integration = TEST_URL && process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true" ? describe : describe.skip;
const TABLES = [schema.products, schema.productVariants, schema.vendors, schema.vendorProducts, schema.warehouses, schema.echelonSettings,
  schema.users, schema.authRoles, schema.authPermissions, schema.authUserRoles, schema.authRolePermissions,
  schema.purchaseOrders, schema.purchaseOrderLines, schema.poStatusHistory, schema.poEvents, schema.purchasingRecommendationPoHandoffs,
  schema.inboundShipments, schema.inboundShipmentLines, schema.receivingOrders, schema.receivingLines, schema.poReceipts,
  schema.vendorInvoices, schema.vendorInvoiceLines, schema.landedCostSnapshots, schema.landedCostAdjustments, schema.inventoryLots];

integration.sequential("supplier document from real saved purchase orders", () => {
  let pool: pg.Pool;
  let database: ReturnType<typeof drizzle<typeof schema>>;
  let service: ReturnType<typeof createPurchasingService>;
  const ownedSchemas: string[] = [];
  const storage = { ...procurementMethods, ...productMethods };

  function product(overrides: Partial<CreatePurchaseOrderWithLinesInput["lines"][number]> = {}): CreatePurchaseOrderWithLinesInput["lines"][number] {
    return { productId: 10, productVariantId: 100, expectedReceiveVariantId: 100, expectedReceiveUnitsPerVariant: 1,
      orderQty: 1, pricing: { basis: "per_piece", quantityPieces: 1, unitCostMills: 1234500 }, ...overrides };
  }
  function input(lines = [product()]): CreatePurchaseOrderWithLinesInput {
    return { vendorId: 2, warehouseId: 3, vendorNotes: "Deliver to receiving desk.", internalNotes: "PRIVATE_MARGIN_BUDGET",
      lines };
  }
  async function readSource(id: number) {
    return loadSupplierPoDocumentSource(database, id);
  }

  beforeAll(async () => {
    validatePostgresTestEnvironment(process.env);
    pool = new pg.Pool({ connectionString: TEST_URL, ssl: false, max: 4, statement_timeout: 15_000 });
    // CREATE refuses any preexisting fixture schema; cleanup owns only successes.
    for (const name of ["catalog", "procurement", "warehouse", "inventory", "identity"]) {
      await pool.query(`CREATE SCHEMA ${name}`); ownedSchemas.push(name);
    }
    for (const table of TABLES) await pool.query(fixtureTable(table));
    await pool.query("CREATE UNIQUE INDEX supplier_document_po_line_identity ON procurement.purchase_order_lines(purchase_order_id,id)");
    await pool.query("CREATE UNIQUE INDEX purchase_orders_po_number_unique ON procurement.purchase_orders(po_number)");
    for (const ddl of fixtureForeignKeys(TABLES)) await pool.query(ddl);
    // Enforce actual current quote residual, cents/mills and currency checks.
    const dialect = new PgDialect();
    for (const table of [schema.purchaseOrders, schema.purchaseOrderLines]) {
      const definition = getTableConfig(table);
      for (const check of definition.checks) {
        const expression = dialect.sqlToQuery(check.value);
        if (expression.params.length) throw new Error("Fixture checks cannot contain parameters");
        const sqlText = expression.sql.replaceAll(`"${definition.schema}"."${definition.name}".`, "").replaceAll(`"${definition.name}".`, "");
        await pool.query(`ALTER TABLE "${definition.schema}"."${definition.name}" ADD CONSTRAINT "${check.name}" CHECK (${sqlText})`);
      }
    }
    database = drizzle(pool, { schema }); connection.database = database;
    service = createPurchasingService(database, storage as never, { now: () => new Date("2026-10-12T12:00:00Z") });
  });
  beforeEach(async () => {
    if (ownedSchemas.length !== 5) throw new Error("Missing fixture ownership");
    await pool.query(`TRUNCATE ${TABLES.map(qualifiedTable).join(",")} RESTART IDENTITY CASCADE`);
    await pool.query(`
      INSERT INTO identity.users(id,username,password,role,active) VALUES ('document-test','document-test','unused','purchaser',1);
      INSERT INTO identity.users(id,username,password,role,active) VALUES ('concurrent-document-editor','concurrent-document-editor','unused','purchaser',1);
      INSERT INTO identity.auth_roles(id,name,is_system) VALUES (1,'Document cancellation fixture',0);
      INSERT INTO identity.auth_permissions(id,resource,action,category) VALUES (1,'purchasing','cancel','purchasing');
      INSERT INTO identity.auth_user_roles(user_id,role_id) VALUES ('document-test',1);
      INSERT INTO identity.auth_role_permissions(role_id,permission_id,constraints) VALUES (1,1,NULL);
      INSERT INTO catalog.products(id,sku,name) VALUES (10,'PRODUCT-SNAPSHOT','Supplier document product');
      INSERT INTO catalog.product_variants(id,product_id,sku,name,units_per_variant,uom_type,is_base_unit)
        VALUES (100,10,'PIECE-SKU','Each',1,'each',true);
      INSERT INTO procurement.vendors(id,code,name,currency,payment_terms_days,payment_terms_type)
        VALUES (2,'DOCUMENT-SUPPLIER','Synthetic supplier','USD',30,'net');
      INSERT INTO warehouse.warehouses(id,code,name) VALUES (3,'DOCUMENT-DOCK','Receiving dock');
      INSERT INTO warehouse.echelon_settings(key,value) VALUES ('company_name','Synthetic buyer'),('private_setting','PRIVATE_SETTING_VALUE');
    `);
  });
  afterAll(async () => {
    connection.database = null;
    if (pool) {
      for (const name of ownedSchemas.reverse()) await pool.query(`DROP SCHEMA ${name} CASCADE`);
      await pool.end();
    }
  });

  it("creates a real $123.45 PO and renders only its external recorded terms", async () => {
    const po = await service.createPurchaseOrderWithLines(input(), "document-test");
    const source = await readSource(po.id);
    expect(source.po.totalCents).toBe(12345);
    const [stored] = await database.select().from(schema.purchaseOrders).where(eq(schema.purchaseOrders.id, po.id));
    expect(stored.internalNotes).toBe("PRIVATE_MARGIN_BUDGET");
    expect(source.po).not.toHaveProperty("internalNotes");
    expect(JSON.stringify(source)).not.toContain("PRIVATE_SETTING_VALUE");
    const document = buildSupplierPoDocument(source);
    expect(document.totals.totalCents).toBe(12345);
    expect(document.lines[0].productName).toBe(source.lines[0].productName);
    expect(JSON.stringify(document)).not.toContain("PRIVATE_MARGIN_BUDGET");
    const html = renderPoHtml(document);
    expect(html).toContain("$123.45");
    expect(html).toContain("Deliver to receiving desk.");
    expect(html).not.toContain("PRIVATE_MARGIN_BUDGET");
    // A catalog rename does not rewrite the product recorded on the saved PO.
    await database.update(schema.products).set({ name: "Renamed live catalog product" }).where(eq(schema.products.id, 10));
    expect(buildSupplierPoDocument(await readSource(po.id)).lines[0].productName).toBe(source.lines[0].productName);
  });

  it("retains a removed row in PostgreSQL while active document totals follow the saved draft edit", async () => {
    const po = await service.createPurchaseOrderWithLines(input([product(), product({
      description: "REMOVED-HISTORICAL-LINE", pricing: { basis: "per_piece", quantityPieces: 1, unitCostMills: 70000 },
    })]), "document-test");
    const initial = await readSource(po.id);
    const retained = initial.lines[0];
    const removed = initial.lines[1];
    await service.updateDraftPurchaseOrderWithLines(po.id, { ...input([product({ lineId: retained.id })]),
      expectedUpdatedAt: initial.po.updatedAt }, "document-test");
    const current = await readSource(po.id);
    expect(current.lines).toHaveLength(2);
    expect(current.lines.find(line => line.id === removed.id)).toMatchObject({ status: "cancelled", orderQty: 1, lineTotalCents: 700 });
    const [storedRemoved] = await database.select().from(schema.purchaseOrderLines).where(eq(schema.purchaseOrderLines.id, removed.id));
    expect(storedRemoved.cancelledQty).toBe(1);
    const document = buildSupplierPoDocument(current);
    expect(document.lines.map(line => line.id)).toEqual([retained.id]);
    expect(document.totals.totalCents).toBe(12345);
    expect(renderPoHtml(document)).not.toContain("REMOVED-HISTORICAL-LINE");
    const events = await database.select().from(schema.poEvents).where(eq(schema.poEvents.poId, po.id));
    expect(events.length).toBeGreaterThan(1);
  });

  it("preserves purchase-UOM quote precision, packaging and signed commercial lines through real persistence", async () => {
    const po = await service.createPurchaseOrderWithLines(input([
      product({ orderQty: 100, packagingCostCents: 200, pricing: { basis: "per_purchase_uom", purchaseUom: "Carton", uomQuantity: 2, piecesPerUom: 50, quotedCostMillsPerUom: 123450 } }),
      { lineType: "fee", description: "Per-carton handling", orderQty: 2, unitCostMills: 25000 },
      { lineType: "discount", description: "Commercial discount", orderQty: 1, unitCostMills: -10000 },
      { lineType: "rebate", description: "Supplier rebate", orderQty: 1, unitCostMills: -5000 },
      { lineType: "tax", description: "Itemized tax", orderQty: 1, unitCostMills: 7500 },
      { lineType: "adjustment", description: "Supplier rounding credit", orderQty: 1, unitCostMills: -400 },
    ]), "document-test");
    const source = await readSource(po.id);
    const document = buildSupplierPoDocument(source);
    expect(source.po.totalCents).toBe(3090);
    expect(document.totals).toMatchObject({ subtotalCents: 3090, totalCents: 3090 });
    expect(document.lines.reduce((sum, line) => sum + line.totalCents, 0)).toBe(3090);
    expect(document.lines[0]).toMatchObject({ quantityPieces: 100, productAmountCents: 2469, packagingCents: 200, totalCents: 2669,
      pricing: { basis: "per_purchase_uom", quantity: 2, unitLabel: "Carton", unitCostMills: 123450 } });
    expect(document.lines.filter(line => ["discount", "rebate"].includes(line.lineType)).map(line => line.totalCents)).toEqual([-100, -50]);
    expect(renderPoHtml(document)).toContain("$12.345");
    expect(renderPoHtml(document)).toContain("$30.90");
  });

  it("fails closed on inconsistent saved header economics and leaves its rows unchanged", async () => {
    const po = await service.createPurchaseOrderWithLines(input(), "document-test");
    await database.update(schema.purchaseOrders).set({ totalCents: 12346 }).where(eq(schema.purchaseOrders.id, po.id));
    const before = await readSource(po.id);
    expect(() => buildSupplierPoDocument(before)).toThrow(expect.objectContaining({ code: "SUPPLIER_DOCUMENT_TOTAL_MISMATCH" }));
    expect(await readSource(po.id)).toEqual(before);
  });

  it("keeps a one-mill residual on a three-piece extended quote instead of repricing from rounded units", async () => {
    const po = await service.createPurchaseOrderWithLines(input([product({ orderQty: 3,
      pricing: { basis: "extended_total", quantityPieces: 3, quotedTotalCents: 100 },
    })]), "document-test");
    const source = await readSource(po.id);
    expect(source.lines[0]).toMatchObject({ unitCostMills: 3333, pricingRemainderMills: 1, totalProductCostCents: 100 });
    const document = buildSupplierPoDocument(source);
    expect(document.lines[0]).toMatchObject({ quantityPieces: 3, totalCents: 100,
      pricing: { basis: "extended_total", unitCostMills: null, quotedTotalCents: 100 } });
    expect(document.totals.totalCents).toBe(100);
  });

  it("rejects an actual cancelled PO whose retained header no longer describes active lines", async () => {
    const po = await service.createPurchaseOrderWithLines(input(), "document-test");
    await service.cancel(po.id, "Synthetic cancellation", "document-test");
    const source = await readSource(po.id);
    expect(source.po).toMatchObject({ status: "cancelled", physicalStatus: "cancelled", totalCents: 12345 });
    expect(source.lines[0]).toMatchObject({ status: "cancelled", lineTotalCents: 12345 });
    expect(() => buildSupplierPoDocument(source))
      .toThrow(expect.objectContaining({ code: "PURCHASE_ORDER_DOCUMENT_CANCELLED", statusCode: 409 }));
  });

  it("reads one coherent PostgreSQL snapshot while an atomic draft edit commits on another connection", async () => {
    const po = await service.createPurchaseOrderWithLines(input(), "document-test");
    const initial = await readSource(po.id);
    const readerClient = await pool.connect();
    let notifyHeaderRead!: () => void;
    let resumeReader!: () => void;
    const headerRead = new Promise<void>(resolve => { notifyHeaderRead = resolve; });
    const readerReleased = new Promise<void>(resolve => { resumeReader = resolve; });
    let paused = false;
    // Pause delivery of the actual first SELECT result after PostgreSQL has
    // acquired its snapshot. No result rows or transaction options are mocked.
    // This leased client stays occupied; the real edit uses a second pool client.
    const instrumentedClient = new Proxy(readerClient, {
      get(target, property) {
        if (property === "query") return async (...args: unknown[]) => {
          const result = await Reflect.apply(target.query, target, args);
          const query = args[0];
          const text = typeof query === "string" ? query : (query as { text?: string }).text ?? "";
          if (!paused && text.startsWith("select ") && text.includes('from "procurement"."purchase_orders"')) {
            paused = true;
            notifyHeaderRead();
            await readerReleased;
          }
          return result;
        };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const inFlight = loadSupplierPoDocumentSource(drizzle(instrumentedClient, { schema }), po.id);
    try {
      await Promise.race([headerRead, inFlight.then(() => { throw new Error("Repository completed without the expected header barrier"); })]);
      await service.updateDraftPurchaseOrderWithLines(po.id, {
        ...input([product({ lineId: initial.lines[0].id, pricing: { basis: "per_piece", quantityPieces: 1, unitCostMills: 2000000 } })]),
        expectedUpdatedAt: initial.po.updatedAt,
      }, "concurrent-document-editor");
      resumeReader();
      const originalSnapshot = buildSupplierPoDocument(await inFlight);
      expect(originalSnapshot.totals.totalCents).toBe(12345);
      expect(originalSnapshot.lines[0].totalCents).toBe(12345);
      const afterCommit = buildSupplierPoDocument(await readSource(po.id));
      expect(afterCommit.totals.totalCents).toBe(20000);
      expect(afterCommit.lines[0].totalCents).toBe(20000);
      expect(afterCommit.sourceRevision).not.toBe(originalSnapshot.sourceRevision);
    } finally {
      resumeReader();
      await inFlight.catch(() => undefined);
      readerClient.release();
    }
  });
});
