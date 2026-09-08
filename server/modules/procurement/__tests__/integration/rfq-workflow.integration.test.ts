import { SupplierSourcingService } from "../../supplier-sourcing.service";
import { SupplierSourcingRepository, attachSupplierSourcingCandidates } from "../../supplier-sourcing.repository";
import { DEFAULT_SUPPLIER_SOURCING_POLICY } from "@shared/procurement/supplier-sourcing";
import { generatePurchasingRecommendations } from "../../purchasing-recommendation.engine";
import { createAutomaticRfqDraftService, normalizeAutomaticRfqDraftPolicy } from "../../automatic-rfq-draft.service";
import { readPurchaseRfqOrigins } from "../../purchase-rfq-origin.repository";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "dotenv";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as schema from "@shared/schema";
import { rfqConversionResultSchema, rfqWorkflowDetailSchema } from "@shared/procurement/rfq-workflow";
import { hashHttpFinancialCommand } from "../../../../platform/commands/http-command";
import type { FinancialCommandDescriptor } from "../../../../platform/commands/transactional-command.service";
import type { RfqWorkflowCommand } from "../../rfq-workflow.service";
import { fixtureForeignKeys, fixtureTable, qualifiedTable } from "./shipment-line-fixture";

config({ path: resolve(process.cwd(), ".env.test") });
const url = process.env.ECHELON_TEST_DATABASE_URL;
const integration = url && process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true" ? describe : describe.skip;
const NOW = new Date("2026-09-07T12:00:00Z");
const TABLES = [schema.products, schema.productVariants, schema.warehouses, schema.vendors, schema.vendorProducts,
  schema.purchaseOrders, schema.purchaseOrderLines, schema.poStatusHistory, schema.poEvents, schema.purchasingRecommendationDecisions, schema.purchasingRecommendationPoHandoffs];

integration.sequential("RFQ quote revisions and real purchase-owner transaction", () => {
  const suffix = randomUUID();
  const actorId = `rfq-workflow-${suffix}`;
  const ownedSchemas: string[] = [];
  let ownsAudit = false;
  let ownsCommands = false;
  let ownsRecoveries = false;
  let pool: pg.Pool;
  let lease: pg.PoolClient | undefined;
  let modulePool: pg.Pool | undefined;
  let database: ReturnType<typeof drizzle<typeof schema>>;
  let service: ReturnType<typeof import("../../rfq-workflow.service").createRfqWorkflowService>;
  let purchasingOwner: ReturnType<typeof import("../../purchasing.service").createPurchasingService>;
  let recommendationHandoff: ReturnType<typeof import("../../recommendation-po-handoff.service").createRecommendationPoHandoffService>;
  let commands: ReturnType<typeof import("../../rfq-workflow.commands").createRfqWorkflowCommands>;
  let commandScope: typeof import("../../rfq-workflow.commands").rfqWorkflowCommandScope;
  let commandPrincipal: string;

  beforeAll(async () => {
    if (!["127.0.0.1", "localhost"].includes(new URL(url!).hostname) || [process.env.DATABASE_URL, process.env.EXTERNAL_DATABASE_URL].filter(Boolean).includes(url!)) throw new Error("RFQ workflow tests require a separate explicitly disposable LOCAL database");
    pool = new pg.Pool({ connectionString: url, ssl: false, max: 10, statement_timeout: 15_000 });
    lease = await pool.connect();
    const lock = await lease.query("SELECT pg_try_advisory_lock(hashtext('echelon.procurement.cost-audit-fixture')) AS acquired");
    if (!lock.rows[0].acquired) throw new Error("Another procurement fixture owns the schema lease");
    for (const name of ["catalog", "procurement", "warehouse"]) { await pool.query(`CREATE SCHEMA ${name}`); ownedSchemas.push(name); }
    for (const table of TABLES) await pool.query(fixtureTable(table));
    await pool.query("CREATE UNIQUE INDEX purch_rec_decisions_id_rec_kind_uidx ON procurement.purchasing_recommendation_decisions(id,recommendation_id,kind)");
    await pool.query("CREATE UNIQUE INDEX purchase_order_lines_po_id_line_id_uidx ON procurement.purchase_order_lines(purchase_order_id,id)");
    for (const statement of fixtureForeignKeys(TABLES)) await pool.query(statement);
    await pool.query("CREATE UNIQUE INDEX purchase_orders_po_number_unique ON procurement.purchase_orders(po_number)");
    for (const migration of ["130_atomic_recommendation_po_handoffs.sql", "148_purchase_rfq_requests.sql", "158_rfq_allocation_override_evidence.sql", "224_rfq_quote_revisions_and_purchase_links.sql", "228_supplier_sourcing_policies.sql"]) await pool.query(readFileSync(resolve(process.cwd(), "migrations", migration), "utf8"));
    if (!(await pool.query("SELECT to_regclass('public.audit_events') AS relation")).rows[0].relation) { await pool.query(fixtureTable(schema.auditEvents)); ownsAudit = true; }
    ownsCommands = !(await pool.query("SELECT to_regclass('public.financial_command_results') AS relation")).rows[0].relation;
    ownsRecoveries = !(await pool.query("SELECT to_regclass('public.financial_command_recoveries') AS relation")).rows[0].relation;
    for (const migration of ["136_financial_command_results.sql", "140_financial_command_operations.sql"]) {
      await pool.query(readFileSync(resolve(process.cwd(), "migrations", migration), "utf8"));
    }
    database = drizzle(pool, { schema });
    const priorDatabase = process.env.DATABASE_URL;
    const priorExternal = process.env.EXTERNAL_DATABASE_URL;
    delete process.env.DATABASE_URL; delete process.env.EXTERNAL_DATABASE_URL;
    try {
      const [dbModule, procurement, catalog, purchasing, workflow, commandModule, repository] = await Promise.all([
        import("../../../../db"), import("../../procurement.storage"), import("../../../catalog/catalog.storage"),
        import("../../purchasing.service"), import("../../rfq-workflow.service"), import("../../rfq-workflow.commands"),
        import("../../../../platform/commands/command-results.repository"),
      ]);
      modulePool = dbModule.pool;
      modulePool.query = pool.query.bind(pool) as typeof modulePool.query;
      modulePool.connect = pool.connect.bind(pool) as typeof modulePool.connect;
      const storage = { ...procurement.procurementMethods, ...catalog.productMethods };
      const owner = purchasing.createPurchasingService(database, storage as never, { now: () => NOW });
      const handoffRepository = await import("../../recommendation-po-handoff.repository");
      const handoffService = await import("../../recommendation-po-handoff.service");
      recommendationHandoff = handoffService.createRecommendationPoHandoffService(handoffRepository.createDrizzleRecommendationPoHandoffRepository(database));
      purchasingOwner = owner;
      service = workflow.createRfqWorkflowService(database, owner);
      commands = commandModule.createRfqWorkflowCommands(service, repository.createDrizzleFinancialCommandRepository(database), () => NOW);
      commandScope = commandModule.rfqWorkflowCommandScope;
      commandPrincipal = commandModule.RFQ_WORKFLOW_COMMAND_PRINCIPAL;
    } finally {
      if (priorDatabase === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = priorDatabase;
      if (priorExternal === undefined) delete process.env.EXTERNAL_DATABASE_URL; else process.env.EXTERNAL_DATABASE_URL = priorExternal;
    }
  });

  beforeEach(async () => {
    if (ownedSchemas.length !== 3) throw new Error("RFQ fixture schema ownership missing");
    // Disable only the fixture's immutable TRUNCATE guard for isolated reset.
    await pool.query(`BEGIN; ALTER TABLE procurement.supplier_sourcing_revisions DISABLE TRIGGER supplier_sourcing_history_truncate_immutable; TRUNCATE ${TABLES.map(qualifiedTable).join(",")}, procurement.purchase_recommendation_runs RESTART IDENTITY CASCADE; ALTER TABLE procurement.supplier_sourcing_revisions ENABLE TRIGGER supplier_sourcing_history_truncate_immutable; COMMIT`);
    await pool.query("DELETE FROM public.audit_events WHERE actor=$1", [actorId]);
    await pool.query("DELETE FROM public.financial_command_results WHERE idempotency_key LIKE $1", [`rfq-${suffix}-%`]);
    await pool.query(`
      INSERT INTO catalog.products(id,sku,name) VALUES(100,'RFQ-SKU-A','RFQ product A'),(101,'RFQ-SKU-B','RFQ product B');
      INSERT INTO catalog.product_variants(id,product_id,sku,name,units_per_variant,uom_type,is_base_unit) VALUES(200,100,'RFQ-CASE-A','Case of 50',50,'case',false),(201,101,'RFQ-CASE-B','Case of 50',50,'case',false);
      INSERT INTO warehouse.warehouses(id,code,name) VALUES(1,'RFQ-WH','Synthetic warehouse');
      INSERT INTO procurement.vendors(id,code,name) VALUES(5,'RFQ-VENDOR','Synthetic supplier');
      INSERT INTO procurement.vendor_products(id,vendor_id,product_id,product_variant_id) VALUES(300,5,100,200),(301,5,101,201);
      INSERT INTO procurement.purchase_recommendation_runs(id,calculation_version,as_of,lookback_days,policy_snapshot) OVERRIDING SYSTEM VALUE VALUES(1,'rfq-test','2026-09-07',90,'{}');
      INSERT INTO procurement.purchase_recommendation_lines(id,run_id,recommendation_key,product_id,product_variant_id,warehouse_id,sku,product_name,recommended_pieces,evidence_snapshot) OVERRIDING SYSTEM VALUE VALUES(1,1,'rfq-a',100,200,1,'RFQ-SKU-A','RFQ product A',150,'{"supplierBasis":{"vendorProductId":300,"minimumOrderPieces":1,"packSize":1,"piecesPerPurchaseUom":null}}'),(2,1,'rfq-b',101,201,1,'RFQ-SKU-B','RFQ product B',150,'{"supplierBasis":{"vendorProductId":301,"minimumOrderPieces":1,"packSize":1,"piecesPerPurchaseUom":null}}');
      INSERT INTO procurement.request_for_quotes(id,rfq_number,vendor_id,idempotency_key,request_hash) OVERRIDING SYSTEM VALUE VALUES(10,'RFQ-TEST',5,'rfq-initial',repeat('a',64));
      INSERT INTO procurement.request_for_quote_lines(id,rfq_id,recommendation_line_id,vendor_product_id,requested_pieces) OVERRIDING SYSTEM VALUE VALUES(20,10,1,300,150),(21,10,2,301,150);
    `);
  });

  afterAll(async () => {
    try {
      if (pool) {
        if (ownsAudit) await pool.query("DROP TABLE public.audit_events"); else if ((await pool.query("SELECT to_regclass('public.audit_events') AS relation")).rows[0].relation) await pool.query("DELETE FROM public.audit_events WHERE actor=$1", [actorId]);
        if (ownsRecoveries) await pool.query("DROP TABLE public.financial_command_recoveries");
        if (ownsCommands) await pool.query("DROP TABLE public.financial_command_results"); else if ((await pool.query("SELECT to_regclass('public.financial_command_results') AS relation")).rows[0].relation) await pool.query("DELETE FROM public.financial_command_results WHERE idempotency_key LIKE $1", [`rfq-${suffix}-%`]);
        for (const name of [...ownedSchemas].reverse()) await pool.query(`DROP SCHEMA ${name} CASCADE`);
      }
    } finally {
      if (lease) { await lease.query("SELECT pg_advisory_unlock(hashtext('echelon.procurement.cost-audit-fixture'))"); lease.release(); }
      await pool?.end(); await modulePool?.end();
    }
  });

  function descriptor(command: RfqWorkflowCommand, key = randomUUID()): FinancialCommandDescriptor {
    const scope = commandScope(command);
    return { actorType: "service", actorId: commandPrincipal, ...scope, idempotencyKey: `rfq-${suffix}-${key}`, requestHash: hashHttpFinancialCommand({ ...scope, body: command.body }), contractVersion: 1 };
  }
  async function capture(lineId = 20, patch: Record<string, unknown> = {}) {
    const before = await service.getDetail(10);
    const command: RfqWorkflowCommand = { operation: "capture_quote", rfqId: 10, lineId, body: { expectedVersion: before.version, quote: {
      pricing: { basis: "extended_total", quantityPieces: 150, quotedTotalCents: 10000 }, packagingTreatment: "separate", packagingCostCents: 1800,
      quoteReference: "VENDOR-QUOTE-1", quoteValidUntil: "2026-09-30", quotedAt: "2026-09-07T00:00:00Z", leadTimeDays: 120, reason: "Supplier quote received", ...patch,
    } } };
    const identity = descriptor(command);
    return { command, identity, result: await commands.execute(command, actorId, identity) };
  }
  async function conversion(lineIds = [20]) {
    const workflow = await service.getDetail(10);
    const command: RfqWorkflowCommand = { operation: "convert", rfqId: 10, body: { expectedVersion: workflow.version, lines: lineIds.map((rfqLineId) => ({ rfqLineId, quoteRevisionId: workflow.lines.find((line) => line.id === rfqLineId)!.latestQuote!.id })), quantityOverrideReason: null } };
    return { command, identity: descriptor(command) };
  }

  it.each([
    { name: "historical", evidence: {} },
    { name: "ambiguous", evidence: { receiveVariantSelection: { version: 1, highestHierarchyLevel: 3, candidateCount: 2, selectedVariantId: null } } },
  ])("replays a $name automatic RFQ from its original key while refusing a new draft from that capture", async ({ evidence }) => {
    await pool.query("UPDATE procurement.request_for_quotes SET status='cancelled',cancelled_at=$1 WHERE id=10", [NOW]);
    await pool.query("INSERT INTO procurement.purchase_recommendation_lines(id,run_id,recommendation_key,product_id,product_variant_id,warehouse_id,sku,product_name,recommended_pieces,preferred_vendor_id,preferred_vendor_product_id,evidence_snapshot) OVERRIDING SYSTEM VALUE VALUES(3,1,'receive-choice-capture',100,200,1,'RFQ-SKU-A','RFQ product A',150,5,300,$1::jsonb)", [JSON.stringify(evidence)]);
    const line = (await database.select().from(schema.purchaseRecommendationLines)).find((row) => row.id === 3)!;
    const automatic = createAutomaticRfqDraftService(database);
    const input = { recommendationRunId: 1, lines: [{ ...line, evidenceSnapshot: evidence }], actorId,
      policy: normalizeAutomaticRfqDraftPolicy({ rfqDraftAutomationMode: "preferred_vendor" }) };
    const before = (await pool.query("SELECT count(*)::int AS count FROM procurement.request_for_quotes")).rows[0].count;
    const held = await automatic.createDrafts(input);
    expect(held).toMatchObject({ reused: false, rfqs: [], lines: [], skipped: [{ code: "receive_selection_review_required" }] });
    expect((await pool.query("SELECT count(*)::int AS count FROM procurement.request_for_quotes")).rows[0].count).toBe(before);
    const [savedRfq] = await database.insert(schema.requestForQuotes).values({
      rfqNumber: "RFQ-SAVED-AUTOMATIC", vendorId: 5, idempotencyKey: "auto-rfq-recommendation-run:1", requestHash: "a".repeat(64),
    }).returning();
    const [savedLine] = await database.insert(schema.requestForQuoteLines).values({
      rfqId: savedRfq.id, recommendationLineId: line.id, vendorProductId: 300, requestedPieces: 150,
    }).returning();
    const replay = await automatic.createDrafts(input);
    expect(replay).toMatchObject({ reused: true, rfqs: [savedRfq], lines: [savedLine], skipped: [{ code: "receive_selection_review_required" }] });
    expect((await automatic.createDrafts(input))).toEqual(replay);
    expect((await pool.query("SELECT count(*)::int AS count FROM procurement.request_for_quotes")).rows[0].count).toBe(before + 1);
    expect((await database.select().from(schema.purchaseRecommendationLines)).find((row) => row.id === line.id)?.evidenceSnapshot).toEqual(evidence);
  });

  it("preserves versioned supplier tiers through recommendation, final RFQ quote and real PO conversion", async () => {
    const sourcing = new SupplierSourcingService(new SupplierSourcingRepository(database), () => NOW);
    const policy = { ...DEFAULT_SUPPLIER_SOURCING_POLICY, priceList: { currency: "USD", basis: "per_purchase_uom" as const, purchaseUom: "case", piecesPerPurchaseUom: 50,
      quoteReference: "CATALOG-TIER-1", quotedAt: "2026-09-01T00:00:00Z", validFrom: "2026-09-01", validUntil: "2026-09-30", tiers: [{ minimumQuantity: 1, unitCostMills: 100001 }, { minimumQuantity: 10, unitCostMills: 90001 }] } };
    await sourcing.update(300, { expectedRevision: 0, idempotencyKey: randomUUID(), reason: "Synthetic supplier tier quote", policy }, actorId);
    const rows = await attachSupplierSourcingCandidates(database, [{ product_id: 100, variant_id: 200, total_pieces: 0, total_outbound_pieces: 60, previous_outbound_pieces: 60, lead_time_days: 10, safety_stock_days: 0, on_order_pieces: 0, recommendation_analysis_date: "2026-09-07" }]);
    const item = generatePurchasingRecommendations({ asOf: NOW, lookbackDays: 30, rows }).items[0];
    const captured = item.supplierBasis.sourcingSelection;
    await pool.query("TRUNCATE procurement.purchase_recommendation_lines RESTART IDENTITY CASCADE");
    await pool.query("INSERT INTO procurement.purchase_recommendation_lines(id,run_id,recommendation_key,product_id,product_variant_id,warehouse_id,sku,product_name,recommended_pieces,preferred_vendor_id,preferred_vendor_product_id,evidence_snapshot) OVERRIDING SYSTEM VALUE VALUES(1,1,'tier-source',100,200,1,'RFQ-SKU-A','RFQ product A',150,5,300,$1::jsonb)", [JSON.stringify({ supplierBasis: item.supplierBasis })]);
    await pool.query("INSERT INTO procurement.request_for_quote_lines(id,rfq_id,recommendation_line_id,vendor_product_id,requested_pieces) OVERRIDING SYSTEM VALUE VALUES(20,10,1,300,150)");
    await sourcing.update(300, { expectedRevision: 1, idempotencyKey: randomUUID(), reason: "Later policy edit preserves earlier evidence", policy: { ...policy, priority: 5 } }, actorId);
    expect((await service.getDetail(10)).lines[0].sourcingSelection).toEqual(captured);
    await capture(); const attempt = await conversion();
    attempt.command.body = { ...(attempt.command.body as object), quantityOverrideReason: "Supplier confirmed the final RFQ quantity and purchase units" };
    attempt.identity = descriptor(attempt.command);
    const converted = await commands.execute(attempt.command, actorId, attempt.identity);
    expect(converted.httpStatus).toBe(201);
    const result = rfqConversionResultSchema.parse(converted.body);
    expect((await database.transaction((tx) => readPurchaseRfqOrigins(tx, result.purchaseOrderId)))[0].rfqLineId).toBe(20);
    expect((await service.getDetail(10)).lines[0].sourcingSelection).toEqual(captured);
    expect((await commands.execute(attempt.command, actorId, attempt.identity)).body).toEqual(converted.body);
  });

  it("uses an explicitly selected product-level supplier mapping without creating a replacement variant mapping", async () => {
    await pool.query("UPDATE procurement.request_for_quotes SET status='cancelled',cancelled_at=$1 WHERE id=10", [NOW]);
    await pool.query("UPDATE procurement.vendor_products SET product_variant_id=NULL WHERE id=300");
    await pool.query("INSERT INTO procurement.purchase_recommendation_lines(id,run_id,recommendation_key,product_id,product_variant_id,warehouse_id,sku,product_name,recommended_pieces,preferred_vendor_id,preferred_vendor_product_id,evidence_snapshot) OVERRIDING SYSTEM VALUE VALUES(3,1,'exact-source',100,200,1,'RFQ-SKU-A','RFQ product A',150,5,300,'{}')");
    const input = { idempotencyKey: `exact-source-${suffix}`, requestNote: "Operator selected the captured supplier mapping", lines: [{ recommendationLineId: 3, vendorId: 5, vendorProductId: 300, requestedPieces: 150 }] };
    const result = await purchasingOwner.createRfqBatch(input, actorId);
    expect(result.lines[0].vendorProductId).toBe(300);
    expect((await pool.query("SELECT count(*)::int AS count FROM procurement.vendor_products WHERE product_id=100")).rows[0].count).toBe(1);
    expect((await purchasingOwner.createRfqBatch(input, actorId)).reused).toBe(true);
  });

  async function tierAcceptance(validUntil = "2099-09-30", asOfDate = "2026-09-07") {
    const sourcing = new SupplierSourcingService(new SupplierSourcingRepository(database), () => NOW);
    const policy = { ...DEFAULT_SUPPLIER_SOURCING_POLICY, priceList: { currency: "USD", basis: "per_purchase_uom" as const, purchaseUom: "bundle", piecesPerPurchaseUom: 3,
      quoteReference: "EXACT-TIER", quotedAt: "2026-09-01T00:00:00Z", validFrom: "2026-09-01", validUntil, tiers: [{ minimumQuantity: 1, unitCostMills: 100001 }] } };
    await pool.query("UPDATE procurement.vendor_products SET is_preferred=1,lead_time_days=4 WHERE id=300");
    await sourcing.update(300,{expectedRevision:0,idempotencyKey:randomUUID(),reason:"Exact supplier quote",policy},actorId);
    const rows = await attachSupplierSourcingCandidates(database,[{product_id:100,variant_id:200,total_pieces:0,total_outbound_pieces:60,previous_outbound_pieces:60,safety_stock_days:0,on_order_pieces:0,recommendation_analysis_date:asOfDate}]);
    const item = generatePurchasingRecommendations({asOf:`${asOfDate}T12:00:00Z`,lookbackDays:30,rows}).items[0];
    const accepted = {...item,vendorProductId:item.supplierBasis.vendorProductId,pricingBasis:item.supplierBasis.pricingBasis,purchaseUom:item.supplierBasis.purchaseUom,quotedUnitCostMills:item.supplierBasis.quotedUnitCostMills,piecesPerPurchaseUom:item.supplierBasis.piecesPerPurchaseUom,quoteReference:item.supplierBasis.quoteReference,quotedAt:item.supplierBasis.quotedAt,quoteValidUntil:item.supplierBasis.quoteValidUntil};
    const decision = await recommendationHandoff.recordDecision({recommendationId:item.recommendationId,kind:"held_by_policy",decision:"accepted_for_po",status:"active",decisionReason:"supplier_review",note:"Operator reviewed supplier quantity tiers",source:"operator",productId:100,productVariantId:200,vendorId:5,sku:"RFQ-SKU-A",productName:"RFQ product A",candidateScore:null,candidateBand:null,recommendationSnapshot:{item:accepted},decidedBy:actorId});
    return {sourcing,policy,command:{actorId,items:[{acceptedDecisionId:decision.id,recommendationId:item.recommendationId,kind:"held_by_policy",productId:100,productVariantId:200,suggestedPieces:item.suggestedOrderPieces,orderUomUnits:item.orderUomUnits,orderUomLabel:item.orderUomLabel,vendorId:5,vendorProductId:300,sku:"RFQ-SKU-A",productName:"RFQ product A",candidateScore:null,candidateBand:null,recommendationSnapshot:{item:accepted}}]}};
  }

  it("writes exact tier money and signed normalization remainder through the real recommendation PO owner", async () => {
    const accepted = await tierAcceptance();
    const result = await recommendationHandoff.createAcceptedHandoff(accepted.command);
    const row=(await pool.query("SELECT order_qty,quoted_unit_cost_mills,unit_cost_mills,total_product_cost_cents,pricing_remainder_mills,quote_reference,vendor_product_id,pieces_per_purchase_uom FROM procurement.purchase_order_lines WHERE purchase_order_id=$1",[result.pos[0].id])).rows[0];
    expect(row).toMatchObject({order_qty:9,quoted_unit_cost_mills:"100001",unit_cost_mills:"33334",total_product_cost_cents:"3000",pricing_remainder_mills:"-3",quote_reference:"EXACT-TIER",vendor_product_id:300,pieces_per_purchase_uom:3});
    const evidence=(await pool.query("SELECT recommendation_snapshot FROM procurement.purchasing_recommendation_decisions WHERE decision='accepted_for_po'")).rows[0].recommendation_snapshot;
    expect(evidence.item.supplierBasis.sourcingSelection.options[0].tier.revision).toBe(1);
  });

  it("rejects a tier revision changed after persisted acceptance without creating financial rows", async () => {
    const accepted = await tierAcceptance();
    await accepted.sourcing.update(300,{expectedRevision:1,idempotencyKey:randomUUID(),reason:"Changed supplier terms",policy:{...accepted.policy,priority:5}},actorId);
    await expect(recommendationHandoff.createAcceptedHandoff(accepted.command)).rejects.toMatchObject({code:"SUPPLIER_TIER_REVISION_CHANGED"});
    expect((await pool.query("SELECT count(*)::int AS count FROM procurement.purchase_orders")).rows[0].count).toBe(0);
    expect((await pool.query("SELECT count(*)::int AS count FROM procurement.purchasing_recommendation_decisions WHERE decision='po_handoff_created'")).rows[0].count).toBe(0);
  });

  it("rejects a tier that expired after recommendation capture without creating a PO", async () => {
    const accepted = await tierAcceptance("2026-09-02","2026-09-01");
    await expect(recommendationHandoff.createAcceptedHandoff(accepted.command)).rejects.toMatchObject({code:"SUPPLIER_TIER_QUANTITY_REVIEW_REQUIRED"});
    expect((await pool.query("SELECT count(*)::int AS count FROM procurement.purchase_orders")).rows[0].count).toBe(0);
  });

  it("captures exact quote economics and replays the original response once", async () => {
    const attempt = await capture();
    expect(attempt.result.httpStatus, JSON.stringify(attempt.result.body)).toBe(200);
    expect((await pool.query("SELECT status,sent_at,responded_at IS NOT NULL AS responded FROM procurement.request_for_quotes WHERE id=10")).rows[0]).toEqual({ status: "partially_quoted", sent_at: null, responded: true });
    const detail = rfqWorkflowDetailSchema.parse(attempt.result.body);
    expect(detail.lines[0].latestQuote).toMatchObject({ productTotalMills: 1_000_000, quotedUnitCostMills: 6667, pricingRemainderMills: -50 });
    const replay = await commands.execute(attempt.command, actorId, attempt.identity);
    expect(replay.replayed).toBe(true);
    expect(replay.body).toEqual(attempt.result.body);
    expect((await pool.query("SELECT count(*)::int AS count FROM procurement.rfq_quote_revisions")).rows[0].count).toBe(1);
  });

  it("atomically creates a draft through the real PO owner with exact links and supplier quote basis", async () => {
    await capture();
    const attempt = await conversion();
    const result = await commands.execute(attempt.command, actorId, attempt.identity);
    expect(result.httpStatus).toBe(201);
    const created = rfqConversionResultSchema.parse(result.body);
    const origins = await database.transaction((tx) => readPurchaseRfqOrigins(tx, created.purchaseOrderId));
    expect(origins).toHaveLength(created.lines.length);
    expect(origins).toEqual(expect.arrayContaining(created.lines.map((line) => expect.objectContaining({
      rfqId: created.rfqId, rfqLineId: line.rfqLineId, quoteRevisionId: line.quoteRevisionId,
      purchaseOrderLineId: line.purchaseOrderLineId,
    }))));
    expect(await database.transaction((tx) => readPurchaseRfqOrigins(tx, 2147483647))).toEqual([]);
    const line = (await pool.query("SELECT * FROM procurement.purchase_order_lines WHERE id=$1", [created.lines[0].purchaseOrderLineId])).rows[0];
    expect(line).toMatchObject({ order_qty: 150, pricing_basis: "extended_total", total_product_cost_cents: "10000", packaging_cost_cents: "1800", pricing_remainder_mills: "-50", line_total_cents: "11800" });
    expect((await service.getDetail(10)).lines[0].purchaseOrder?.purchaseOrderLineId).toBe(created.lines[0].purchaseOrderLineId);
    expect((await commands.execute(attempt.command, actorId, attempt.identity)).replayed).toBe(true);
    expect((await pool.query("SELECT count(*)::int AS count FROM procurement.purchase_orders")).rows[0].count).toBe(1);
    expect((await pool.query("SELECT event_type FROM procurement.po_events WHERE po_id=$1 ORDER BY id", [created.purchaseOrderId])).rows.map((row) => row.event_type)).toEqual(["created", "rfq_converted"]);
  });

  it("requires current MOQ and multiple review, preserves quoted pieces, and replays the exact audited purchase", async () => {
    await capture();
    const stale = await conversion();
    await pool.query("UPDATE procurement.vendor_products SET moq=200,pack_size=100 WHERE id=300");
    expect((await commands.execute(stale.command, actorId, stale.identity)).body).toMatchObject({ code: "RFQ_VERSION_CONFLICT" });
    const workflow = await service.getDetail(10);
    expect(workflow.lines[0].quantityReview).toMatchObject({ evaluatedPieces: 150, requiresReason: true, issues: ["supplier_rules_changed", "below_current_moq", "outside_current_order_multiple"] });
    const missingReason = await conversion();
    expect((await commands.execute(missingReason.command, actorId, missingReason.identity)).body).toMatchObject({ code: "RFQ_QUANTITY_REVIEW_REQUIRED" });
    expect((await pool.query("SELECT count(*)::int AS count FROM procurement.purchase_orders")).rows[0].count).toBe(0);
    const reviewed = await conversion();
    const reason = "Vendor confirmed 150 pieces despite the new standard case and MOQ";
    reviewed.command.body = { ...(reviewed.command.body as object), quantityOverrideReason: reason };
    const identity = descriptor(reviewed.command);
    const result = await commands.execute(reviewed.command, actorId, identity);
    expect(result.httpStatus, JSON.stringify(result.body)).toBe(201);
    const created = rfqConversionResultSchema.parse(result.body);
    expect((await pool.query("SELECT order_qty,total_product_cost_cents FROM procurement.purchase_order_lines WHERE id=$1", [created.lines[0].purchaseOrderLineId])).rows[0]).toEqual({ order_qty: 150, total_product_cost_cents: "10000" });
    expect((await pool.query("SELECT quantity_override_reason,quoted_pieces FROM procurement.rfq_purchase_order_line_links WHERE rfq_line_id=20")).rows[0]).toEqual({ quantity_override_reason: reason, quoted_pieces: 150 });
    const audit = (await pool.query("SELECT context FROM public.audit_events WHERE actor=$1 AND action='purchase_rfq.converted_to_draft_po'", [actorId])).rows[0].context;
    expect(audit).toMatchObject({ quantityOverrideReason: reason, quantityReviews: [{ rfqLineId: 20, recommendationRules: { minimumOrderPieces: 1, orderMultiplePieces: 1 }, currentRules: { minimumOrderPieces: 200, orderMultiplePieces: 100 }, evaluatedPieces: 150 }] });
    await pool.query("UPDATE procurement.vendor_products SET moq=400 WHERE id=300");
    const replay = await commands.execute(reviewed.command, actorId, identity);
    expect(replay.replayed).toBe(true);
    expect(replay.body).toEqual(result.body);
    expect((await pool.query("SELECT count(*)::int AS count FROM procurement.purchase_orders")).rows[0].count).toBe(1);
  });

  it("requires a reason when immutable historical recommendations did not retain supplier rules", async () => {
    await freshRecommendation(3, 1, 400);
    await pool.query("INSERT INTO procurement.request_for_quote_lines(id,rfq_id,recommendation_line_id,vendor_product_id,requested_pieces) OVERRIDING SYSTEM VALUE VALUES(22,10,3,300,150)");
    await capture(22);
    const attempt = await conversion([22]);
    expect((await commands.execute(attempt.command, actorId, attempt.identity)).body).toMatchObject({ code: "RFQ_QUANTITY_REVIEW_REQUIRED" });
    expect((await service.getDetail(10)).lines.find((line) => line.id === 22)?.quantityReview).toMatchObject({ recommendationRules: null, issues: ["recommendation_rules_unavailable"] });
    attempt.command.body = { ...(attempt.command.body as object), quantityOverrideReason: "Reviewed current supplier order rules against this historical request" };
    expect((await commands.execute(attempt.command, actorId, descriptor(attempt.command))).httpStatus).toBe(201);
  });

  it("cannot use a reason to bypass malformed current supplier order rules", async () => {
    await capture();
    await pool.query("UPDATE procurement.vendor_products SET pack_size=0 WHERE id=300");
    const attempt = await conversion();
    attempt.command.body = { ...(attempt.command.body as object), quantityOverrideReason: "This cannot authorize invalid supplier data" };
    expect((await commands.execute(attempt.command, actorId, descriptor(attempt.command))).body).toMatchObject({ code: "RFQ_ORDER_RULES_INVALID" });
    expect((await pool.query("SELECT count(*)::int AS count FROM procurement.purchase_orders")).rows[0].count).toBe(0);
  });

  it("holds current supplier rules stable through the same real PO owner transaction", async () => {
    await capture();
    const attempt = await conversion();
    const { loadRfqWorkflow } = await import("../../rfq-workflow.repository");
    const { lockInventoryCostGraph } = await import("../../../inventory/infrastructure/cost-evidence.repository");
    const competing = await pool.connect();
    try {
      await competing.query("SET lock_timeout='250ms'");
      const result = await database.transaction(async (tx) => {
        await lockInventoryCostGraph(tx);
        await loadRfqWorkflow(tx, 10, true);
        await expect(competing.query("UPDATE procurement.vendor_products SET pack_size=100 WHERE id=300")).rejects.toMatchObject({ code: "55P03" });
        return service.executeInTransaction(tx, attempt.command, actorId, NOW, `rfq-${suffix}-locked-policy`);
      });
      expect(rfqConversionResultSchema.parse(result).status).toBe("draft");
      expect((await competing.query("UPDATE procurement.vendor_products SET pack_size=100 WHERE id=300")).rowCount).toBe(1);
    } finally { await competing.query("RESET lock_timeout"); competing.release(); }
  });

  it("supports selected subsets as separate POs while each RFQ line converts only once", async () => {
    await capture(); await capture(21);
    const first = await conversion([20]);
    expect((await commands.execute(first.command, actorId, first.identity)).httpStatus).toBe(201);
    const second = await conversion([21]);
    expect((await commands.execute(second.command, actorId, second.identity)).httpStatus).toBe(201);
    const duplicate = await conversion([20]);
    const duplicateResult = await commands.execute(duplicate.command, actorId, duplicate.identity);
    expect(duplicateResult.httpStatus).toBe(409);
    expect(duplicateResult.body).toMatchObject({ code: "RFQ_LINE_ALREADY_ORDERED" });
    expect((await pool.query("SELECT count(*)::int AS count FROM procurement.purchase_orders")).rows[0].count).toBe(2);
  });

  it("preserves revisions and legacy quote mirrors before replacement, and rejects stale conversion", async () => {
    await pool.query("UPDATE procurement.request_for_quote_lines SET quoted_pieces=150,quoted_unit_cost_mills=9007199254740993,quote_reference='LEGACY-EVIDENCE' WHERE id=20");
    await capture();
    const stale = await conversion();
    await capture(20, { quoteReference: "VENDOR-QUOTE-2", pricing: { basis: "per_piece", quantityPieces: 150, unitCostMills: 7000 } });
    const rejected = await commands.execute(stale.command, actorId, stale.identity);
    expect(rejected.body).toMatchObject({ code: "RFQ_VERSION_CONFLICT" });
    const history = await service.getQuoteHistory(10, 20, null);
    expect(history.revisions.map((revision) => revision.revision)).toEqual([2, 1]);
    const audit = (await pool.query("SELECT changes FROM public.audit_events WHERE actor=$1 AND action='purchase_rfq.quote_captured' ORDER BY id LIMIT 1", [actorId])).rows[0];
    expect(audit.changes.before.lineSnapshot.quote_reference).toBe("LEGACY-EVIDENCE");
    expect(audit.changes.before.lineSnapshot.quoted_unit_cost_mills).toBe("9007199254740993");
    await expect(pool.query("UPDATE procurement.rfq_quote_revisions SET quoted_unit_cost_mills=1")).rejects.toMatchObject({ code: "23514" });
  });

  it("rolls back PO header, lines, source links and statuses when the RFQ audit fails", async () => {
    await capture();
    await pool.query("CREATE FUNCTION procurement.rfq_test_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='purchase_rfq.converted_to_draft_po' THEN RAISE EXCEPTION 'injected RFQ audit failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER rfq_test_audit_failure BEFORE INSERT ON public.audit_events FOR EACH ROW EXECUTE FUNCTION procurement.rfq_test_audit_failure()");
    const attempt = await conversion();
    try { await expect(commands.execute(attempt.command, actorId, attempt.identity)).rejects.toThrow(); }
    finally { await pool.query("DROP TRIGGER rfq_test_audit_failure ON public.audit_events; DROP FUNCTION procurement.rfq_test_audit_failure()"); }
    expect((await pool.query("SELECT count(*)::int AS count FROM procurement.purchase_orders")).rows[0].count).toBe(0);
    expect((await service.getDetail(10)).lines[0].status).toBe("quoted");
    expect((await pool.query("SELECT count(*)::int AS count FROM procurement.rfq_purchase_order_line_links")).rows[0].count).toBe(0);
  });

  it("serializes overlapping conversions and commits only one purchase", async () => {
    await capture();
    const attempt = await conversion();
    const competing = descriptor(attempt.command);
    const results = await Promise.all([commands.execute(attempt.command, actorId, attempt.identity), commands.execute(attempt.command, actorId, competing)]);
    expect(results.map((result) => result.httpStatus).sort()).toEqual([201, 409]);
    expect((await pool.query("SELECT count(*)::int AS count FROM procurement.purchase_orders")).rows[0].count).toBe(1);
  });

  async function pendingAllocation(recommendationId: number) {
    const { lockAndLoadActiveRfqAllocations } = await import("../../purchasing-rfq.service");
    return database.transaction((tx) => lockAndLoadActiveRfqAllocations(tx, [{ id: recommendationId, productId: 100, productVariantId: 200, warehouseId: 1 }]));
  }
  async function freshRecommendation(id: number, runId: number, pieces: number) {
    await pool.query("INSERT INTO procurement.purchase_recommendation_lines(id,run_id,recommendation_key,product_id,product_variant_id,warehouse_id,sku,product_name,recommended_pieces,evidence_snapshot) OVERRIDING SYSTEM VALUE VALUES($1,$2,$3,100,200,1,'RFQ-SKU-A','RFQ product A',$4,'{}')", [id, runId, `fresh-${id}`, pieces]);
  }
  async function nextRfqLine(recommendationId: number, pieces: number) {
    await pool.query("INSERT INTO procurement.request_for_quote_lines(rfq_id,recommendation_line_id,vendor_product_id,requested_pieces) VALUES(11,$1,300,$2)", [recommendationId, pieces]);
  }

  it("reserves the actual draft PO quantity and keeps original RFQ quantity immutable", async () => {
    await capture(20, { pricing: { basis: "extended_total", quantityPieces: 200, quotedTotalCents: 10000 } });
    const attempt = await conversion();
    attempt.command.body = { ...(attempt.command.body as object), quantityOverrideReason: "Supplier minimum is 200 pieces" };
    const result = await commands.execute(attempt.command, actorId, descriptor(attempt.command));
    expect(result.httpStatus, JSON.stringify(result.body)).toBe(201);
    const created = rfqConversionResultSchema.parse(result.body);
    expect((await pendingAllocation(1)).get("100:200:1")).toBe(200);
    await pool.query("UPDATE procurement.purchase_order_lines SET order_qty=120,cancelled_qty=20 WHERE id=$1", [created.lines[0].purchaseOrderLineId]);
    await pool.query("UPDATE procurement.request_for_quotes SET status='cancelled',cancelled_at=$1 WHERE id=10", [NOW]);
    expect((await pendingAllocation(1)).get("100:200:1")).toBe(100);
    expect((await pool.query("SELECT requested_pieces FROM procurement.request_for_quote_lines WHERE id=20")).rows[0].requested_pieces).toBe(150);
    await freshRecommendation(3, 1, 400);
    await pool.query("INSERT INTO procurement.request_for_quotes(id,rfq_number,vendor_id,idempotency_key,request_hash) OVERRIDING SYSTEM VALUE VALUES(11,'RFQ-NEXT',5,'rfq-next',repeat('b',64))");
    await nextRfqLine(3, 300);
    expect((await pendingAllocation(3)).get("100:200:1")).toBe(400);
  });

  it.each(["approved", "received", "closed", "cancelled"])("avoids double allocation after %s and blocks reuse of stale recommendations", async (status) => {
    await capture();
    const attempt = await conversion();
    const result = await commands.execute(attempt.command, actorId, attempt.identity);
    expect(result.httpStatus).toBe(201);
    const created = rfqConversionResultSchema.parse(result.body);
    // Only line.updated_at advances: header-only freshness would miss this.
    await pool.query("UPDATE procurement.purchase_orders SET status=$1,updated_at='2026-09-06T00:00:00' WHERE id=$2", [status, created.purchaseOrderId]);
    await pool.query("UPDATE procurement.purchase_order_lines SET updated_at='2026-09-07T13:00:00' WHERE id=$1", [created.lines[0].purchaseOrderLineId]);
    await expect(pendingAllocation(1)).rejects.toMatchObject({ code: "RFQ_SUPPLY_SNAPSHOT_STALE" });
    await freshRecommendation(3, 1, 100);
    await pool.query("INSERT INTO procurement.request_for_quotes(id,rfq_number,vendor_id,idempotency_key,request_hash) OVERRIDING SYSTEM VALUE VALUES(11,'RFQ-NEXT',5,'rfq-next',repeat('b',64))");
    await expect(nextRfqLine(3, 100)).rejects.toMatchObject({ code: "23514", message: expect.stringContaining("RFQ_SUPPLY_SNAPSHOT_STALE") });
    await pool.query("INSERT INTO procurement.purchase_recommendation_runs(id,calculation_version,as_of,lookback_days,policy_snapshot) OVERRIDING SYSTEM VALUE VALUES(2,'rfq-test','2026-09-08T00:00:00Z',90,'{}')");
    await freshRecommendation(4, 2, 100);
    expect((await pendingAllocation(4)).get("100:200:1")).toBe(0);
    await nextRfqLine(4, 100);
    expect((await pendingAllocation(4)).get("100:200:1")).toBe(100);
  });
  it("keeps ambiguous packaging as evidence while refusing financial conversion", async () => {
    expect((await capture(20, { packagingTreatment: "unknown", packagingCostCents: null })).result.httpStatus).toBe(200);
    const attempt = await conversion();
    const result = await commands.execute(attempt.command, actorId, attempt.identity);
    expect(result.body).toMatchObject({ code: "RFQ_PACKAGING_REVIEW_REQUIRED" });
    expect((await pool.query("SELECT count(*)::int AS count FROM procurement.purchase_orders")).rows[0].count).toBe(0);
  });
});
