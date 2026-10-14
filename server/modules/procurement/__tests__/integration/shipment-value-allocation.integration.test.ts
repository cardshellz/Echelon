import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { shipmentAllocationEvidenceSchema } from "@shared/procurement/shipment-allocation";
import { receivingUnitVersion } from "../../receiving-unit-contract";
import { shipmentCostVersion } from "../../shipment-cost-version";
import type { ShipmentCostCommand } from "../../shipment-cost-commands";
import type { FinancialCommandDescriptor } from "../../../../platform/commands/transactional-command.service";
import { createFlowCostHarness, seedFlowMasterData, FLOW_ACTOR, FLOW_AT, FLOW_IDS, type FlowCostHarness } from "./procurement-flow-cost.fixture";

const url = process.env.ECHELON_TEST_DATABASE_URL;
const integration = url && process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true" ? describe : describe.skip;
const SHIPMENT_ID = 1;
const PO_ID = 10;
const DUTY_ID = 31;

// This exercises real PostgreSQL and the existing pre-opening quantity authority.
// It does not certify activated quantity-ledger operation or a production rollout.
integration.sequential("exact shipment product-value allocation through real financial owners", () => {
  let harness: FlowCostHarness | undefined;

  function fixture(): FlowCostHarness {
    if (!harness) throw new Error("Disposable shipment value fixture is not initialized");
    return harness;
  }

  beforeEach(async () => {
    harness = await createFlowCostHarness(url!);
    await harness.pool.query(readFileSync(resolve(process.cwd(), "migrations/pending/shipment_exact_value_basis.sql"), "utf8"));
    await seedFlowMasterData(harness);
    // Commercial source fixtures only: every allocation, snapshot, receipt,
    // inventory cost and sale below goes through its real application owner.
    await harness.pool.query(`
      INSERT INTO procurement.purchase_orders(id,po_number,vendor_id,status,physical_status,warehouse_id,currency,total_cents)
        VALUES(10,'EXACT-VALUE-PO',5,'sent','sent',1,'USD',990);
      INSERT INTO procurement.purchase_order_lines(id,purchase_order_id,line_number,product_id,product_variant_id,
        expected_receive_variant_id,expected_receive_units_per_variant,sku,product_name,order_qty,
        unit_cost_cents,unit_cost_mills,total_product_cost_cents,packaging_cost_cents,line_total_cents,status)
        VALUES(21,10,1,100,200,200,100,'EXACT-VALUE-A','Subcent A',1000,0,49,490,0,490,'open'),
          (22,10,2,101,202,202,100,'EXACT-VALUE-B','Subcent B',1000,1,50,500,0,500,'open');
      INSERT INTO procurement.inbound_shipments(id,shipment_number,status,allocation_method_default,warehouse_id)
        VALUES(1,'EXACT-VALUE-SHIP','costing','by_value',1);
      INSERT INTO procurement.inbound_shipment_lines(id,inbound_shipment_id,purchase_order_id,purchase_order_line_id,
        product_variant_id,sku,qty_shipped,carton_count,allocated_cost_cents)
        VALUES(11,1,10,21,200,'EXACT-VALUE-A',1000,10,0),(12,1,10,22,202,'EXACT-VALUE-B',1000,10,0);
      INSERT INTO procurement.inbound_freight_costs(id,inbound_shipment_id,cost_type,actual_cents,
        allocation_method,cost_status,currency,exchange_rate,vendor_id)
        VALUES(31,1,'duty',990,'by_weight','finalized','USD',1,6)
    `);
  });

  afterEach(async () => {
    await harness?.dispose();
    harness = undefined;
  });

  async function allocations(shipmentId = SHIPMENT_ID) {
    return (await fixture().pool.query(`
      SELECT a.inbound_shipment_line_id AS line_id,a.allocated_cents::text AS cents,
        a.allocation_basis_value::text AS mirror,a.basis_evidence
      FROM procurement.inbound_freight_allocations a
      JOIN procurement.inbound_shipment_lines l ON l.id=a.inbound_shipment_line_id
      WHERE l.inbound_shipment_id=$1 ORDER BY a.inbound_shipment_line_id`, [shipmentId])).rows;
  }

  async function latestContracts() {
    return (await fixture().pool.query(`SELECT DISTINCT ON (inbound_shipment_line_id)
      inbound_shipment_line_id,contract,source_evidence FROM procurement.cost_source_revisions
      WHERE component='landed' ORDER BY inbound_shipment_line_id,revision DESC`)).rows;
  }

  async function allocationState() {
    const tables = ["procurement.inbound_freight_allocations", "procurement.landed_cost_snapshots",
      "procurement.inbound_shipment_lines", "procurement.cost_source_revisions", "procurement.landed_cost_adjustments"];
    return Promise.all(tables.map(async table => (await fixture().pool.query(`SELECT * FROM ${table} ORDER BY id`)).rows));
  }

  async function inventoryState() {
    const tables = ["inventory.inventory_lots", "inventory.inventory_levels", "inventory.inventory_transactions",
      "inventory.cost_applications", "inventory.cost_adjustment_log", "oms.order_item_costs"];
    return Promise.all(tables.map(async table => (await fixture().pool.query(`SELECT * FROM ${table} ORDER BY id`)).rows));
  }

  async function money() {
    const inventory = await fixture().pool.query(`SELECT COALESCE(SUM(qty_on_hand::numeric*total_unit_cost_mills),0)::text AS mills
      FROM inventory.inventory_lots WHERE status='active'`);
    const sold = await fixture().pool.query("SELECT COALESCE(SUM(total_cost_mills),0)::text AS mills FROM oms.order_item_costs");
    const inventoryMills = BigInt(inventory.rows[0].mills);
    const soldMills = BigInt(sold.rows[0].mills);
    return { inventoryMills: inventoryMills.toString(), soldMills: soldMills.toString(), totalMills: (inventoryMills + soldMills).toString() };
  }

  async function receiveAll() {
    const { purchasing, receiving, storage } = fixture();
    const receipt = await purchasing.createReceiptFromShipment(SHIPMENT_ID, FLOW_ACTOR, { purchaseOrderId: PO_ID });
    const lines = await storage.getReceivingLines(receipt.id);
    expect(lines).toHaveLength(2);
    await receiving.open(receipt.id, FLOW_ACTOR);
    for (const line of lines) {
      expect(line.expectedQty).toBe(10);
      await receiving.updateLine(line.id, { receivedQty: 10, putawayLocationId: FLOW_IDS.locationX,
        expectedUnitVersion: receivingUnitVersion(line) }, FLOW_ACTOR);
    }
    await receiving.close(receipt.id, FLOW_ACTOR);
    return receipt.id;
  }

  it("allocates 990 cents of duty as 490/500 using PO product totals and preserves exact evidence", async () => {
    const result = await fixture().shipment.runAllocation(SHIPMENT_ID);
    expect(result.totalAllocated).toBe(990);
    expect(result.allocations.map(line => [line.lineId, line.dutyCents])).toEqual([[11, 490], [12, 500]]);
    await fixture().shipment.finalizeAllocations(SHIPMENT_ID, FLOW_ACTOR);
    const rows = await allocations();
    expect(rows.map(row => row.cents)).toEqual(["490", "500"]);
    for (const [index, row] of rows.entries()) {
      const evidence = shipmentAllocationEvidenceSchema.parse(row.basis_evidence);
      expect(evidence).toMatchObject({ version: 2, method: "by_value", usedFallback: false,
        source: { kind: "po_product_total", poLineId: 21 + index, orderQty: 1000, qtyShipped: 1000,
          totalProductCostCents: index === 0 ? "490" : "500", currency: "USD" },
        rawRatio: { numerator: index === 0 ? "490" : "500", denominator: "1" },
        totalRatio: { numerator: "990", denominator: "1" } });
    }
    const snapshots = (await fixture().pool.query(`SELECT total_landed_cost_cents::text AS total,product_value_evidence
      FROM procurement.landed_cost_snapshots ORDER BY inbound_shipment_line_id`)).rows;
    expect(snapshots.map(row => row.total)).toEqual(["980", "1000"]);
    expect(snapshots.every(row => row.product_value_evidence?.version === 2)).toBe(true);
  });

  it("retains rational partial-PO value across split shipments without rounding the basis to cents", async () => {
    await fixture().pool.query(`
      UPDATE procurement.purchase_order_lines SET order_qty=CASE id WHEN 21 THEN 3 ELSE 2 END,total_product_cost_cents=1 WHERE id IN(21,22);
      UPDATE procurement.inbound_shipment_lines SET qty_shipped=1 WHERE id IN(11,12);
      UPDATE procurement.inbound_freight_costs SET actual_cents=5 WHERE id=31;
      INSERT INTO procurement.inbound_shipments(id,shipment_number,status,allocation_method_default,warehouse_id)
        VALUES(2,'EXACT-VALUE-SPLIT','costing','by_value',1);
      INSERT INTO procurement.inbound_shipment_lines(id,inbound_shipment_id,purchase_order_id,purchase_order_line_id,product_variant_id,sku,qty_shipped)
        VALUES(13,2,10,21,200,'EXACT-VALUE-A',2),(14,2,10,22,202,'EXACT-VALUE-B',1);
      INSERT INTO procurement.inbound_freight_costs(id,inbound_shipment_id,cost_type,actual_cents,allocation_method,cost_status,currency,exchange_rate,vendor_id)
        VALUES(32,2,'duty',7,'by_value','finalized','USD',1,6)`);
    await fixture().shipment.finalizeAllocations(1, FLOW_ACTOR);
    await fixture().shipment.finalizeAllocations(2, FLOW_ACTOR);
    const first = await allocations(1), second = await allocations(2);
    expect(first.map(row => row.cents)).toEqual(["2", "3"]);
    expect(second.map(row => row.cents)).toEqual(["4", "3"]);
    expect(first.map(row => row.basis_evidence.rawRatio)).toEqual([
      { numerator: "1", denominator: "3" }, { numerator: "1", denominator: "2" },
    ]);
    expect(second.map(row => row.basis_evidence.rawRatio)).toEqual([
      { numerator: "2", denominator: "3" }, { numerator: "1", denominator: "2" },
    ]);
    expect([...first, ...second].reduce((sum, row) => sum + BigInt(row.cents), BigInt(0))).toBe(BigInt(12));
    expect((await latestContracts()).every(row => row.contract.evidence === "confirmed")).toBe(true);
  });

  it("treats a known zero product value as zero while allocating to the positive source", async () => {
    await fixture().pool.query("UPDATE procurement.purchase_order_lines SET total_product_cost_cents=0 WHERE id=21");
    await fixture().shipment.runAllocation(SHIPMENT_ID);
    const rows = await allocations();
    expect(rows.map(row => row.cents)).toEqual(["0", "990"]);
    expect(rows[0].basis_evidence).toMatchObject({ usedFallback: false, rawRatio: { numerator: "0", denominator: "1" } });
  });

  it("records the existing equal-line fallback only when every product source is explicitly zero", async () => {
    await fixture().pool.query("UPDATE procurement.purchase_order_lines SET total_product_cost_cents=0 WHERE id IN(21,22)");
    await fixture().pool.query("UPDATE procurement.inbound_freight_costs SET actual_cents=5 WHERE id=31");
    await fixture().shipment.runAllocation(SHIPMENT_ID);
    const rows = await allocations();
    expect(rows.map(row => row.cents)).toEqual(["3", "2"]);
    for (const row of rows) expect(row.basis_evidence).toMatchObject({ usedFallback: true,
      rawRatio: { numerator: "0", denominator: "1" }, ratio: { numerator: "1", denominator: "1" } });
  });

  it.each(["invalid_ordered_quantity", "missing_po_line", "unsupported_currency"] as const)("rejects %s instead of turning missing evidence into zero or equal shares", async missing => {
    if (missing === "invalid_ordered_quantity") await fixture().pool.query("UPDATE procurement.purchase_order_lines SET order_qty=0 WHERE id=21");
    if (missing === "missing_po_line") await fixture().pool.query("UPDATE procurement.inbound_shipment_lines SET purchase_order_line_id=NULL WHERE id=11");
    if (missing === "unsupported_currency") await fixture().pool.query("UPDATE procurement.purchase_orders SET currency='EUR' WHERE id=10");
    const before = await allocationState();
    await expect(fixture().shipment.runAllocation(SHIPMENT_ID)).rejects.toMatchObject({ details: { code: "INVALID_ALLOCATION_BASIS" } });
    expect(await allocationState()).toEqual(before);
  });

  it("keeps historical numeric-only rows unchanged and review-required until explicit refinalization", async () => {
    await fixture().shipment.finalizeAllocations(SHIPMENT_ID, FLOW_ACTOR);
    await fixture().pool.query(`UPDATE procurement.inbound_freight_allocations SET basis_evidence=NULL;
      UPDATE procurement.landed_cost_snapshots SET product_value_evidence=NULL`);
    const historic = await allocations();
    const push = await fixture().shipment.pushLandedCostsToLots(SHIPMENT_ID, FLOW_ACTOR);
    expect(push.status).toBe("review_required");
    expect(push.skipped.some(issue => issue.reason === "LANDED_ALLOCATION_STALE")).toBe(true);
    expect(await allocations()).toEqual(historic);
    expect((await fixture().pool.query("SELECT product_value_evidence FROM procurement.landed_cost_snapshots")).rows.every(row => row.product_value_evidence === null)).toBe(true);
    await fixture().shipment.finalizeAllocations(SHIPMENT_ID, FLOW_ACTOR);
    expect((await allocations()).every(row => row.basis_evidence?.version === 2)).toBe(true);
    expect((await latestContracts()).every(row => row.contract.evidence === "confirmed")).toBe(true);
  });

  it("enforces the installed evidence constraints while preserving legacy nulls and generated version-two evidence", async () => {
    await fixture().shipment.finalizeAllocations(SHIPMENT_ID, FLOW_ACTOR);
    const targets = [
      { table: "procurement.inbound_freight_allocations", column: "basis_evidence",
        constraint: "inbound_freight_allocation_basis_evidence_v2" },
      { table: "procurement.landed_cost_snapshots", column: "product_value_evidence",
        constraint: "landed_cost_snapshot_product_value_evidence_v2" },
    ] as const;
    for (const target of targets) {
      // Identifiers come only from the fixed local allowlist above.
      const select = "SELECT id," + target.column + " AS evidence FROM " + target.table;
      const update = "UPDATE " + target.table + " SET " + target.column;
      const { rows: [generated] } = await fixture().pool.query(select + " ORDER BY id LIMIT 1");
      expect(generated.evidence.version).toBe(2);
      await fixture().pool.query(update + "=NULL WHERE id=$1", [generated.id]);
      expect((await fixture().pool.query(select + " WHERE id=$1", [generated.id])).rows[0].evidence).toBeNull();
      for (const invalid of [null, 1, true, "legacy", [], {}, { version: 1 }, { version: "2" }, { version: null }]) {
        await expect(fixture().pool.query(update + "=$1::jsonb WHERE id=$2",
          [JSON.stringify(invalid), generated.id])).rejects.toMatchObject({ code: "23514", constraint: target.constraint });
      }
      await fixture().pool.query(update + "=$1::jsonb WHERE id=$2", [JSON.stringify(generated.evidence), generated.id]);
      expect((await fixture().pool.query(select + " WHERE id=$1", [generated.id])).rows[0].evidence).toEqual(generated.evidence);
    }
  });

  it("classifies a closed legacy product projection correction without inventing freight or repeating financial effects", async () => {
    const owner = fixture();
    const invoice = await owner.ap.createInvoice({ invoiceNumber: "EXACT-VALUE-LEGACY-INVOICE", vendorId: FLOW_IDS.vendor,
      poIds: [PO_ID], invoiceDate: FLOW_AT, currency: "USD", createdBy: FLOW_ACTOR });
    await owner.ap.approveInvoice(invoice.id, FLOW_ACTOR);
    await owner.shipment.finalizeAllocations(SHIPMENT_ID, FLOW_ACTOR);
    await receiveAll();
    const sale = { productVariantId: FLOW_IDS.caseA, warehouseLocationId: FLOW_IDS.locationX, qty: 1,
      orderId: FLOW_IDS.order, orderItemId: FLOW_IDS.orderItem, userId: FLOW_ACTOR };
    expect(await owner.inventory.pickItem(sale)).toBe(true);
    await owner.inventory.recordShipment({ ...sale, shipmentId: "EXACT-VALUE-LEGACY-SALE" });
    expect(await money()).toEqual({ inventoryMills: "188200", soldMills: "9800", totalMills: "198000" });
    const beforeFinancialState = await inventoryState();
    const originalSources = (await owner.pool.query("SELECT * FROM procurement.cost_source_revisions ORDER BY id")).rows;
    // Emulate the persisted historical projection only. Its rounded product
    // mirror is zero, while its 490 cents of duty and recognized costs are known.
    await owner.pool.query("UPDATE procurement.inbound_shipments SET status='closed' WHERE id=1");
    await owner.pool.query("UPDATE procurement.landed_cost_snapshots SET po_unit_cost_cents=0,landed_unit_cost_cents=0," +
      "total_landed_cost_cents=490,product_value_evidence=NULL WHERE inbound_shipment_line_id=11");

    const corrected = await owner.shipment.finalizeAllocations(SHIPMENT_ID, FLOW_ACTOR);
    expect(corrected).toMatchObject({ unchanged: false, adjustments: 1 });
    const adjustments = (await owner.pool.query("SELECT * FROM procurement.landed_cost_adjustments ORDER BY id")).rows;
    expect(adjustments).toHaveLength(1);
    expect(adjustments[0]).toMatchObject({ inbound_shipment_line_id: 11, purchase_order_line_id: 21,
      adjustment_amount_cents: "490", created_by: FLOW_ACTOR });
    expect(adjustments[0].reason).toContain("Legacy product projection recalculation (prior exact PO source unavailable)");
    expect(adjustments[0].reason).toContain("Product projection: 0 -> 490 cents (+490)");
    expect(adjustments[0].reason).toContain("Duty/customs: 490 -> 490 cents (+0)");
    expect(adjustments[0].reason).toContain("Freight: 0 -> 0 cents (+0)");
    expect(adjustments[0].reason).toContain("Total landed: 490 -> 980 cents (+490)");
    expect(adjustments[0].reason).not.toContain("landed charge reallocation");
    expect(await inventoryState()).toEqual(beforeFinancialState);
    const correctedSources = (await owner.pool.query("SELECT * FROM procurement.cost_source_revisions ORDER BY id")).rows;
    for (const old of originalSources) expect(correctedSources.find(row => row.id === old.id)).toEqual(old);

    const repeated = await owner.shipment.finalizeAllocations(SHIPMENT_ID, FLOW_ACTOR);
    expect(repeated).toMatchObject({ unchanged: true, adjustments: 0 });
    expect((await owner.pool.query("SELECT * FROM procurement.landed_cost_adjustments ORDER BY id")).rows).toEqual(adjustments);
    expect(await inventoryState()).toEqual(beforeFinancialState);
    const repeatedSources = (await owner.pool.query("SELECT * FROM procurement.cost_source_revisions ORDER BY id")).rows;
    for (const old of correctedSources) expect(repeatedSources.find(row => row.id === old.id)).toEqual(old);
  });

  it("detects changed PO product totals even when rounded unit-cost mirrors and shipment quantities are unchanged", async () => {
    await fixture().shipment.finalizeAllocations(SHIPMENT_ID, FLOW_ACTOR);
    const originalSources = (await fixture().pool.query("SELECT * FROM procurement.cost_source_revisions ORDER BY id")).rows;
    const previousAllocation = await allocations();
    await fixture().pool.query("UPDATE procurement.purchase_order_lines SET total_product_cost_cents=1000 WHERE id=21");
    const push = await fixture().shipment.pushLandedCostsToLots(SHIPMENT_ID, FLOW_ACTOR);
    expect(push.status).toBe("review_required");
    expect(push.skipped.some(issue => issue.reason === "LANDED_ALLOCATION_STALE")).toBe(true);
    expect(await allocations()).toEqual(previousAllocation);
    await fixture().shipment.finalizeAllocations(SHIPMENT_ID, FLOW_ACTOR);
    expect((await allocations()).map(row => row.cents)).toEqual(["660", "330"]);
    const afterSources = (await fixture().pool.query("SELECT * FROM procurement.cost_source_revisions ORDER BY id")).rows;
    for (const old of originalSources) expect(afterSources.find(row => row.id === old.id)).toEqual(old);
  });

  it.each(["cost", "line"] as const)("serializes the actual %s command with the canonical PO source lock protocol", async kind => {
    const owner = fixture();
    const [{ lockInventoryCostGraph }, { costEvidenceTransactionFromPg }, costModule, lineModule, { shipmentLineVersion }] = await Promise.all([
      import("../../../inventory/infrastructure/cost-evidence.repository"),
      import("../../../inventory/infrastructure/cost-evidence-pg"),
      import("../../shipment-cost-commands"), import("../../shipment-line-commands"), import("../../shipment-line-version"),
    ]);
    await owner.shipment.runAllocation(SHIPMENT_ID);
    const cost = await owner.storage.getInboundFreightCostById(DUTY_ID);
    const line = await owner.storage.getInboundShipmentLineById(11);
    if (!cost || !line) throw new Error("Expected the seeded charge and shipment line");
    const command = { operation: "update" as const, resourceId: kind === "cost" ? DUTY_ID : 11,
      body: kind === "cost" ? { expectedVersion: shipmentCostVersion(cost), actualCents: 1500 }
        : { expectedVersion: shipmentLineVersion(line), qtyShipped: 500 } };
    const identity: FinancialCommandDescriptor = { actorType: "service",
      actorId: kind === "cost" ? costModule.SHIPMENT_COST_COMMAND_PRINCIPAL : lineModule.SHIPMENT_LINE_COMMAND_PRINCIPAL,
      ...(kind === "cost" ? costModule.shipmentCostCommandScope(command) : lineModule.shipmentLineCommandScope(command)),
      contractVersion: 1, idempotencyKey: "exact-value-source-barrier-" + kind,
      requestHash: createHash("sha256").update(JSON.stringify(command)).digest("hex") };
    const holder = await owner.pool.connect();
    let transactionOpen = false;
    let commandSettled = false;
    let outcome: Promise<{ ok: true; result: { httpStatus: number; body: unknown } } | { ok: false; error: unknown }> | undefined;
    try {
      await holder.query("BEGIN");
      transactionOpen = true;
      await holder.query("SET LOCAL statement_timeout = '10s'");
      // This is a source-update fixture using the production PO amendment lock
      // protocol, not a claim that the complete amendment HTTP flow ran here.
      await lockInventoryCostGraph(costEvidenceTransactionFromPg(holder));
      const { rows: [{ pid: holderPid }] } = await holder.query("SELECT pg_backend_pid() AS pid");
      const pending = kind === "cost" ? owner.costCommands.execute(command, FLOW_ACTOR, identity)
        : owner.lineCommands.execute(command, FLOW_ACTOR, identity);
      outcome = pending.then(result => { commandSettled = true; return { ok: true as const, result }; },
        (error: unknown) => { commandSettled = true; return { ok: false as const, error }; });
      const deadline = Date.now() + 5_000;
      let observedAdvisoryBlock = false;
      while (Date.now() < deadline) {
        const blocked = await owner.pool.query(
          "SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' " +
          "AND wait_event='advisory' AND $1=ANY(pg_blocking_pids(pid))", [holderPid]);
        if (blocked.rows.length > 0) { observedAdvisoryBlock = true; break; }
        if (commandSettled) throw new Error("Command finished without waiting for the PO source graph lock");
        await new Promise<void>(resolveWait => setTimeout(resolveWait, 10));
      }
      expect(observedAdvisoryBlock, "PostgreSQL must prove the command is waiting on this holder's advisory lock").toBe(true);
      // If the command took the shipment first, this NOWAIT probe fails instead
      // of allowing a graph -> shipment versus shipment -> graph deadlock.
      await holder.query("SELECT id FROM procurement.inbound_shipments WHERE id=1 FOR UPDATE NOWAIT");
      await holder.query("UPDATE procurement.purchase_order_lines SET order_qty=2000,total_product_cost_cents=2000,line_total_cents=2000 WHERE id=21");
      await holder.query("COMMIT");
      transactionOpen = false;
      const completed = await outcome;
      if (!completed.ok) throw completed.error;
      expect(completed.result.httpStatus, JSON.stringify(completed.result.body)).toBe(200);
      const rows = await allocations();
      expect(rows.map(row => row.cents)).toEqual(kind === "cost" ? ["1000", "500"] : ["495", "495"]);
      expect(rows[0].basis_evidence.source).toEqual({ kind: "po_product_total", poLineId: 21,
        orderQty: 2000, qtyShipped: kind === "cost" ? 1000 : 500, totalProductCostCents: "2000", currency: "USD" });
      expect(rows[0].basis_evidence.rawRatio).toEqual({ numerator: kind === "cost" ? "1000" : "500", denominator: "1" });
      await owner.shipment.finalizeAllocations(SHIPMENT_ID, FLOW_ACTOR);
      const snapshots = (await owner.pool.query("SELECT total_landed_cost_cents::text AS total " +
        "FROM procurement.landed_cost_snapshots ORDER BY inbound_shipment_line_id")).rows;
      expect(snapshots.map(row => row.total)).toEqual(kind === "cost" ? ["2000", "1000"] : ["995", "995"]);
      expect((await latestContracts()).every(row => row.contract.evidence === "confirmed")).toBe(true);
    } finally {
      if (transactionOpen) await holder.query("ROLLBACK");
      holder.release();
      await outcome;
    }
  });

  it("rolls allocation and snapshot writes back on a source-history failure, then permits a clean retry", async () => {
    await fixture().pool.query(`CREATE FUNCTION procurement.fail_exact_value_source() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'injected exact value source failure'; END $$;
      CREATE TRIGGER fail_exact_value_source BEFORE INSERT ON procurement.cost_source_revisions
      FOR EACH ROW EXECUTE FUNCTION procurement.fail_exact_value_source()`);
    const before = await allocationState();
    let failure: unknown;
    try { await fixture().shipment.finalizeAllocations(SHIPMENT_ID, FLOW_ACTOR); } catch (error) { failure = error; }
    const errorMessages: string[] = [];
    while (failure instanceof Error) { errorMessages.push(failure.message); failure = failure.cause; }
    expect(errorMessages.join(" ")).toContain("injected exact value source failure");
    expect(await allocationState()).toEqual(before);
    await fixture().pool.query("DROP TRIGGER fail_exact_value_source ON procurement.cost_source_revisions; DROP FUNCTION procurement.fail_exact_value_source()");
    await fixture().shipment.finalizeAllocations(SHIPMENT_ID, FLOW_ACTOR);
    expect((await allocations()).map(row => row.cents)).toEqual(["490", "500"]);
    expect((await latestContracts()).every(row => row.contract.evidence === "confirmed")).toBe(true);
  });

  it("conserves 1980 cents across inventory and sold COGS when exact duty arrives after receipt and sale", async () => {
    const owner = fixture();
    await owner.pool.query("UPDATE procurement.inbound_freight_costs SET actual_cents=0 WHERE id=31");
    const invoice = await owner.ap.createInvoice({ invoiceNumber: "EXACT-VALUE-INVOICE", vendorId: FLOW_IDS.vendor,
      poIds: [PO_ID], invoiceDate: FLOW_AT, currency: "USD", createdBy: FLOW_ACTOR });
    expect(invoice.invoicedAmountCents).toBe(990);
    await owner.ap.approveInvoice(invoice.id, FLOW_ACTOR);
    await owner.shipment.finalizeAllocations(SHIPMENT_ID, FLOW_ACTOR);
    await receiveAll();
    const sale = { productVariantId: FLOW_IDS.caseA, warehouseLocationId: FLOW_IDS.locationX, qty: 1,
      orderId: FLOW_IDS.order, orderItemId: FLOW_IDS.orderItem, userId: FLOW_ACTOR };
    expect(await owner.inventory.pickItem(sale)).toBe(true);
    await owner.inventory.recordShipment({ ...sale, shipmentId: "EXACT-VALUE-SALE" });
    expect(await money()).toEqual({ inventoryMills: "94100", soldMills: "4900", totalMills: "99000" });
    const original = await owner.storage.getInboundFreightCostById(DUTY_ID);
    expect(original).toBeDefined();
    const command: ShipmentCostCommand = { operation: "update", resourceId: DUTY_ID,
      body: { expectedVersion: shipmentCostVersion(original!), actualCents: 990, reason: "Confirmed late subcent duty" } };
    const { shipmentCostCommandScope, SHIPMENT_COST_COMMAND_PRINCIPAL } = await import("../../shipment-cost-commands");
    const identity: FinancialCommandDescriptor = { actorType: "service", actorId: SHIPMENT_COST_COMMAND_PRINCIPAL,
      ...shipmentCostCommandScope(command), contractVersion: 1,
      idempotencyKey: "exact-value-late-duty", requestHash: createHash("sha256").update(JSON.stringify(command)).digest("hex") };
    const result = await owner.costCommands.execute(command, FLOW_ACTOR, identity);
    expect(result.httpStatus, JSON.stringify(result.body)).toBe(200);
    await owner.shipment.finalizeAllocations(SHIPMENT_ID, FLOW_ACTOR);
    const applied = await owner.shipment.pushLandedCostsToLots(SHIPMENT_ID, FLOW_ACTOR);
    expect(applied.status, JSON.stringify(applied.skipped)).toBe("applied");
    expect(await money()).toEqual({ inventoryMills: "188200", soldMills: "9800", totalMills: "198000" });
    expect((await owner.cogs.getInventoryValuation()).totalValueCents).toBe(1882);
    expect((await owner.cogs.getOrderCOGS(FLOW_IDS.order))?.totalCogsCents).toBe(98);
    const beforeReplay = await inventoryState();
    const replay = await owner.costCommands.execute(command, FLOW_ACTOR, identity);
    expect(replay.replayed).toBe(true);
    const pushes = await Promise.all([owner.shipment.pushLandedCostsToLots(SHIPMENT_ID, FLOW_ACTOR), owner.shipment.pushLandedCostsToLots(SHIPMENT_ID, FLOW_ACTOR)]);
    for (const push of pushes) {
      expect(push.updated).toBe(0);
      expect(push.costApplications.every(application => application.replayed)).toBe(true);
    }
    await owner.inventory.recordShipment({ ...sale, shipmentId: "EXACT-VALUE-SALE" });
    expect(await inventoryState()).toEqual(beforeReplay);
  });
});
