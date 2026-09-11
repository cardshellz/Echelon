import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { defaultPurchasePlanningPolicy } from "@shared/procurement/purchase-planning-policy";
import type { PurchasingRecommendationRawRow } from "../../purchasing-recommendation.engine";
import type { RfqQuoteEvidence } from "@shared/procurement/rfq-workflow";
import { receivingUnitVersion } from "../../receiving-unit-contract";
import { shipmentCostVersion } from "../../shipment-cost-version";
import type { ShipmentCostCommand } from "../../shipment-cost-commands";
import type { ShipmentLineCommand } from "../../shipment-line-commands";
import type { FinancialCommandDescriptor } from "../../../../platform/commands/transactional-command.service";
import { createFlowCostHarness, seedFlowMasterData, FLOW_ACTOR, FLOW_AT, FLOW_IDS, type FlowCostHarness } from "./procurement-flow-cost.fixture";

const url = process.env.ECHELON_TEST_DATABASE_URL;
const enabled = !!url && process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
const controlled = enabled ? describe : describe.skip;
const positiveId = z.object({ id: z.number().int().positive() });

function demandRow(productId: number, variantId: number, sku: string, monthlyPieces: number): PurchasingRecommendationRawRow {
  return {
    product_id: productId, variant_id: variantId, base_sku: sku, product_name: `Controlled ${sku}`,
    total_pieces: 0, total_reserved_pieces: 0, total_outbound_pieces: monthlyPieces,
    previous_outbound_pieces: monthlyPieces, lead_time_days: 30, safety_stock_days: 10,
    on_order_pieces: 0, inbound_schedule: [], receipt_supply_evidence: { version: 1, lines: [] },
    receive_variant_selection: { version: 1, highestHierarchyLevel: 2, candidateCount: 1, selectedVariantId: variantId },
    recommendation_analysis_date: "2026-09-10", forward_demand_contributions: [],
    forward_demand_planning_as_of_date: "2026-09-10", forward_demand_horizon_days: 90,
  };
}

function quote(quantityPieces: number, unitCostMills: number, quoteReference: string): RfqQuoteEvidence {
  return { pricing: { basis: "per_piece", quantityPieces, unitCostMills },
    packagingTreatment: "separate", packagingCostCents: 10_000,
    quoteReference, quoteValidUntil: null, quotedAt: FLOW_AT.toISOString(), leadTimeDays: 30,
    reason: "Controlled FLOW final supplier quote; packaging explicitly separate" };
}

function descriptor(command: ShipmentCostCommand | ShipmentLineCommand, key: string,
  kind: "cost" | "line"): FinancialCommandDescriptor {
  const isCost = kind === "cost";
  const isResource = isCost ? command.operation !== "create"
    : command.operation === "update" || command.operation === "delete";
  const routeTemplate = isCost
    ? isResource ? "/api/inbound-shipments/costs/:costId" : "/api/inbound-shipments/:id/costs"
    : isResource ? "/api/inbound-shipments/lines/:lineId" : "/api/inbound-shipments/:id/lines/from-po";
  return {
    actorType: "service", actorId: `procurement.shipment-${kind}`,
    method: command.operation === "update" ? "PATCH" : command.operation === "delete" ? "DELETE" : "POST",
    routeTemplate, resourceKey: `${isResource ? `shipment_${kind}` : "shipment"}:${command.resourceId}`,
    idempotencyKey: `controlled-flow-${key}`, requestHash: createHash("sha256").update(JSON.stringify(command)).digest("hex"),
    commandName: `procurement.shipment_${kind}.${command.operation}`, contractVersion: 1,
  };
}

controlled.sequential("FLOW persisted RFQ, partial receipts, sale and late freight (pre-opening quantity authority)", () => {
  let harness: FlowCostHarness;
  let disposeHarness: (() => Promise<void>) | undefined;
  beforeEach(async () => {
    // Fresh owned schemas preserve the real immutable-history guards in every
    // scenario; a TRUNCATE reset would bypass or violate those guarantees.
    harness = await createFlowCostHarness(url!);
    disposeHarness = harness.dispose;
    await seedFlowMasterData(harness);
  });
  afterEach(async () => {
    const dispose = disposeHarness;
    disposeHarness = undefined;
    await dispose?.();
  });

  function createPurchases() {
    return harness.rfqHelper.createControlledRfqPurchases({
      database: harness.database, purchasingOwner: harness.purchasing, actorId: FLOW_ACTOR,
      at: FLOW_AT, key: "controlled-flow", lookbackDays: 30,
      settings: { planningPolicy: defaultPurchasePlanningPolicy(), planningPolicyRevision: 0, autoDraftMode: "review_only" },
      rows: [demandRow(FLOW_IDS.productA, FLOW_IDS.caseA, "PROC-UAT-FLOW-A", 750),
        demandRow(FLOW_IDS.productB, FLOW_IDS.caseB, "PROC-UAT-FLOW-B", 375)],
      quotes: [{ productId: FLOW_IDS.productA, quote: quote(1_000, 20_000, "PROC-UAT-FLOW-A-QUOTE") },
        { productId: FLOW_IDS.productB, quote: quote(500, 40_000, "PROC-UAT-FLOW-B-QUOTE") }],
    });
  }

  async function latestLandedEvidence(shipmentLineId: number) {
    return (await harness.pool.query(`SELECT contract,source_evidence FROM procurement.cost_source_revisions
      WHERE component='landed' AND inbound_shipment_line_id=$1 ORDER BY revision DESC LIMIT 1`, [shipmentLineId])).rows[0];
  }

  async function allocations() {
    return (await harness.pool.query(`SELECT s.shipment_number,pol.product_id,a.allocated_cents::text AS cents,
      a.allocation_basis_value::text AS weight,a.allocation_basis_total::text AS total_weight
      FROM procurement.inbound_freight_allocations a
      JOIN procurement.inbound_shipment_lines sl ON sl.id=a.inbound_shipment_line_id
      JOIN procurement.inbound_shipments s ON s.id=sl.inbound_shipment_id
      JOIN procurement.purchase_order_lines pol ON pol.id=sl.purchase_order_line_id
      ORDER BY s.shipment_number,pol.product_id`)).rows;
  }

  async function money() {
    const [inventory, sold] = await Promise.all([
      harness.pool.query(`SELECT COALESCE(SUM(qty_on_hand::numeric*total_unit_cost_mills),0)::text AS mills
        FROM inventory.inventory_lots WHERE status='active'`),
      harness.pool.query("SELECT COALESCE(SUM(total_cost_mills),0)::text AS mills FROM oms.order_item_costs"),
    ]);
    const inventoryMills = BigInt(inventory.rows[0].mills);
    const soldMills = BigInt(sold.rows[0].mills);
    return { inventoryMills: inventoryMills.toString(), soldMills: soldMills.toString(), totalMills: (inventoryMills + soldMills).toString() };
  }

  async function financialState() {
    const tables = ["procurement.cost_source_revisions", "inventory.cost_applications", "inventory.cost_application_lots",
      "inventory.cost_reporting_events", "inventory.cost_adjustment_log", "oms.order_item_costs",
      "inventory.inventory_lots", "inventory.inventory_levels", "inventory.inventory_transactions"];
    return Promise.all(tables.map(async (table) => (await harness.pool.query(
      `SELECT * FROM ${table} ORDER BY ${table === "inventory.cost_application_lots" ? "application_id,inventory_lot_id" : "1"}`,
    )).rows));
  }

  async function addShipmentLine(shipmentId: number, poId: number, poLineId: number, qty: number, key: string) {
    const command: ShipmentLineCommand = { operation: "add-from-po", resourceId: shipmentId,
      body: { purchaseOrderId: poId, lineSelections: [{ poLineId, qty }] } };
    const response = await harness.lineCommands.execute(command, FLOW_ACTOR, descriptor(command, key, "line"));
    expect(response.httpStatus, JSON.stringify(response.body)).toBe(201);
    const [line] = z.array(positiveId).length(1).parse(response.body);
    return line.id;
  }

  async function addFreight(shipmentId: number, actualCents: number, key: string) {
    const command: ShipmentCostCommand = { operation: "create", resourceId: shipmentId,
      body: { costType: "freight", actualCents, allocationMethod: "by_weight", vendorId: FLOW_IDS.freightVendor,
        reason: "Controlled FLOW freight quote" } };
    const response = await harness.costCommands.execute(command, FLOW_ACTOR, descriptor(command, key, "cost"));
    expect(response.httpStatus, JSON.stringify(response.body)).toBe(201);
    return positiveId.parse(response.body).id;
  }

  async function receive(shipmentId: number, poId: number, shipmentLineId: number, cartons: number,
    expectedCartons: number, locationId: number) {
    const receipt = await harness.purchasing.createReceiptFromShipment(shipmentId, FLOW_ACTOR, { purchaseOrderId: poId });
    const lines = await harness.storage.getReceivingLines(receipt.id);
    expect(lines).toHaveLength(1);
    const [line] = lines;
    expect(line).toMatchObject({ expectedQty: expectedCartons, unitsPerVariantSnapshot: 100, inboundShipmentLineId: shipmentLineId });
    await harness.receiving.open(receipt.id, FLOW_ACTOR);
    await harness.receiving.updateLine(line.id, { receivedQty: cartons, putawayLocationId: locationId,
      expectedUnitVersion: receivingUnitVersion(line) }, FLOW_ACTOR);
    await harness.receiving.close(receipt.id, FLOW_ACTOR);
    return { receiptId: receipt.id, receivingLineId: line.id };
  }

  async function finalizeDeliveredShipment(shipmentId: number) {
    await harness.shipment.book(shipmentId, FLOW_ACTOR);
    await harness.shipment.markInTransit(shipmentId, FLOW_ACTOR);
    await harness.shipment.markAtPort(shipmentId, FLOW_ACTOR);
    await harness.shipment.markCustomsClearance(shipmentId, FLOW_ACTOR);
    await harness.shipment.markDelivered(shipmentId, FLOW_ACTOR);
    await harness.shipment.startCosting(shipmentId, FLOW_ACTOR);
    await harness.shipment.finalizeAllocations(shipmentId, FLOW_ACTOR);
  }

  it("conserves $4,610 across $4,370 inventory and $240 sold COGS, preserving source history and exact-once retries", async () => {
    const created = await createPurchases();
    const poA = created.purchases.get(FLOW_IDS.productA)!;
    const poB = created.purchases.get(FLOW_IDS.productB)!;
    const poLineA = poA.lines[0].purchaseOrderLineId;
    const poLineB = poB.lines[0].purchaseOrderLineId;
    expect(poA.purchaseOrderId).not.toBe(poB.purchaseOrderId);
    const originalQuoteEvidence = (await harness.pool.query("SELECT * FROM procurement.rfq_quote_revisions ORDER BY id")).rows;
    const originalPurchaseLinks = (await harness.pool.query("SELECT * FROM procurement.rfq_purchase_order_line_links ORDER BY id")).rows;
    expect(originalQuoteEvidence).toHaveLength(2);
    expect(originalPurchaseLinks).toHaveLength(2);
    expect((await harness.pool.query(`SELECT product_id,order_qty,expected_receive_variant_id,
      expected_receive_units_per_variant,total_product_cost_cents::text AS product_cents,
      packaging_cost_cents::text AS packaging_cents,line_total_cents::text AS total_cents
      FROM procurement.purchase_order_lines ORDER BY product_id`)).rows).toEqual([
      { product_id: 100, order_qty: 1_000, expected_receive_variant_id: 200, expected_receive_units_per_variant: 100,
        product_cents: "200000", packaging_cents: "10000", total_cents: "210000" },
      { product_id: 101, order_qty: 500, expected_receive_variant_id: 202, expected_receive_units_per_variant: 100,
        product_cents: "200000", packaging_cents: "10000", total_cents: "210000" },
    ]);
    // This owner records the internal solo-mode send. No email/provider delivery is claimed.
    await harness.purchasing.sendToVendor(poA.purchaseOrderId, FLOW_ACTOR);
    await harness.purchasing.sendToVendor(poB.purchaseOrderId, FLOW_ACTOR);

    const x = await harness.shipment.createShipment({ shipmentNumber: "PROC-UAT-FLOW-X", mode: "sea_lcl", warehouseId: 1 }, FLOW_ACTOR);
    const y = await harness.shipment.createShipment({ shipmentNumber: "PROC-UAT-FLOW-Y", mode: "sea_lcl", warehouseId: 1 }, FLOW_ACTOR);
    const xA = await addShipmentLine(x.id, poA.purchaseOrderId, poLineA, 600, "x-a");
    const xB = await addShipmentLine(x.id, poB.purchaseOrderId, poLineB, 500, "x-b");
    const yA = await addShipmentLine(y.id, poA.purchaseOrderId, poLineA, 400, "y-a");
    expect((await harness.pool.query(`SELECT inbound_shipment_id,product_variant_id,qty_shipped,carton_count,total_weight_kg
      FROM procurement.inbound_shipment_lines ORDER BY id`)).rows).toEqual([
      { inbound_shipment_id: x.id, product_variant_id: 200, qty_shipped: 600, carton_count: 6, total_weight_kg: "6.000" },
      { inbound_shipment_id: x.id, product_variant_id: 202, qty_shipped: 500, carton_count: 5, total_weight_kg: "5.000" },
      { inbound_shipment_id: y.id, product_variant_id: 200, qty_shipped: 400, carton_count: 4, total_weight_kg: "4.000" },
    ]);
    const freightX = await addFreight(x.id, 22_000, "freight-x");
    const freightY = await addFreight(y.id, 8_000, "freight-y");
    for (const id of [x.id, y.id]) {
      await finalizeDeliveredShipment(id);
    }
    expect(await allocations()).toEqual([
      { shipment_number: "PROC-UAT-FLOW-X", product_id: 100, cents: "12000", weight: "6.000000", total_weight: "11.000000" },
      { shipment_number: "PROC-UAT-FLOW-X", product_id: 101, cents: "10000", weight: "5.000000", total_weight: "11.000000" },
      { shipment_number: "PROC-UAT-FLOW-Y", product_id: 100, cents: "8000", weight: "4.000000", total_weight: "4.000000" },
    ]);

    // PO import copies explicit product/packaging evidence; real AP approval is
    // the confirmation owner. No direct invoice approval or cost writes here.
    for (const [purchase, invoiceNumber] of [[poA, "PROC-UAT-FLOW-INVOICE-A"], [poB, "PROC-UAT-FLOW-INVOICE-B"]] as const) {
      const invoice = await harness.ap.createInvoice({ invoiceNumber, vendorId: FLOW_IDS.vendor,
        poIds: [purchase.purchaseOrderId], invoiceDate: FLOW_AT, currency: "USD", createdBy: FLOW_ACTOR });
      expect(invoice.invoicedAmountCents).toBe(210_000);
      await harness.ap.approveInvoice(invoice.id, FLOW_ACTOR);
    }
    const receipts = [];
    receipts.push(await receive(x.id, poA.purchaseOrderId, xA, 5, 6, FLOW_IDS.locationX));
    receipts.push(await receive(x.id, poB.purchaseOrderId, xB, 4, 5, FLOW_IDS.locationX));
    expect((await harness.pool.query("SELECT SUM(qty_received)::text AS pieces FROM procurement.po_receipts")).rows[0]).toEqual({ pieces: "900" });
    expect((await harness.pool.query(`SELECT product_id,received_qty FROM procurement.purchase_order_lines ORDER BY product_id`)).rows)
      .toEqual([{ product_id: 100, received_qty: 500 }, { product_id: 101, received_qty: 400 }]);
    const partialX = await harness.purchasing.getShipmentPoReceiveOptions(x.id);
    const partialY = await harness.purchasing.getShipmentPoReceiveOptions(y.id);
    expect(partialX.purchaseOrders.map(({ purchaseOrderId, remainingBaseQty }) => ({ purchaseOrderId, remainingBaseQty })))
      .toEqual([{ purchaseOrderId: poA.purchaseOrderId, remainingBaseQty: 100 }, { purchaseOrderId: poB.purchaseOrderId, remainingBaseQty: 100 }]);
    expect(partialY.purchaseOrders).toMatchObject([{ purchaseOrderId: poA.purchaseOrderId, remainingBaseQty: 400 }]);
    receipts.push(await receive(x.id, poA.purchaseOrderId, xA, 1, 1, FLOW_IDS.locationX));
    receipts.push(await receive(x.id, poB.purchaseOrderId, xB, 1, 1, FLOW_IDS.locationX));
    // Separate pickable locations guarantee the sale consumes X, without relying
    // on tied database timestamps to choose between X and Y FIFO lots.
    receipts.push(await receive(y.id, poA.purchaseOrderId, yA, 4, 4, FLOW_IDS.locationY));
    await harness.shipment.pushLandedCostsToLots(x.id);
    await harness.shipment.pushLandedCostsToLots(y.id);
    expect(await money()).toEqual({ inventoryMills: "45000000", soldMills: "0", totalMills: "45000000" });
    expect((await harness.cogs.getInventoryValuation()).totalValueCents).toBe(450_000);
    const lineage = (await harness.pool.query(`SELECT t.receiving_line_id,rl.inbound_shipment_line_id,
      rl.units_per_variant_snapshot,l.qty_received AS cartons,pr.qty_received AS pieces,
      link.rfq_id,link.quote_revision_id
      FROM inventory.inventory_transactions t JOIN inventory.inventory_lots l ON l.id=t.inventory_lot_id
      JOIN procurement.receiving_lines rl ON rl.id=t.receiving_line_id
      JOIN procurement.po_receipts pr ON pr.receiving_line_id=rl.id
      JOIN procurement.rfq_purchase_order_line_links link ON link.purchase_order_line_id=rl.purchase_order_line_id
      WHERE t.transaction_type='receipt' AND t.voided_at IS NULL ORDER BY t.id`)).rows;
    expect(lineage).toHaveLength(5);
    for (const [index, row] of lineage.entries()) {
      expect(row).toMatchObject({ receiving_line_id: receipts[index].receivingLineId,
        units_per_variant_snapshot: 100, rfq_id: created.proposal.rfqId });
      expect(row.pieces).toBe(row.cartons * 100);
      expect(originalQuoteEvidence.some((revision) => revision.id === row.quote_revision_id)).toBe(true);
    }

    const sale = { productVariantId: FLOW_IDS.caseA, warehouseLocationId: FLOW_IDS.locationX, qty: 1,
      orderId: FLOW_IDS.order, orderItemId: FLOW_IDS.orderItem, userId: FLOW_ACTOR };
    expect(await harness.inventory.pickItem(sale)).toBe(true);
    await harness.inventory.recordShipment({ ...sale, shipmentId: "PROC-UAT-FLOW-SALE" });
    expect((await harness.pool.query(`SELECT c.qty,l.inbound_shipment_id,c.total_cost_mills::text AS mills
      FROM oms.order_item_costs c JOIN inventory.inventory_lots l ON l.id=c.inventory_lot_id`)).rows)
      .toEqual([{ qty: 1, inbound_shipment_id: x.id, mills: "2300000" }]);
    expect(await money()).toEqual({ inventoryMills: "42700000", soldMills: "2300000", totalMills: "45000000" });
    const initialCogs = await harness.cogs.getOrderCOGS(FLOW_IDS.order);
    expect(initialCogs?.totalCogsCents).toBe(23_000);
    // Synthetic selling price is explicitly $300 for one carton. These checks
    // also detect a report reading retired WMS price fields as zero revenue.
    expect(initialCogs).toMatchObject({ totalRevenueCents: 30_000, grossMarginCents: 7_000,
      lineItems: [expect.objectContaining({ revenueCents: 30_000, marginCents: 7_000 })] });
    const initialSources = (await harness.pool.query("SELECT * FROM procurement.cost_source_revisions ORDER BY id")).rows;
    const beforeLateCost = await money();
    const originalCharge = await harness.storage.getInboundFreightCostById(freightX);
    expect(originalCharge?.vendorInvoiceId).toBeNull();
    const amendment: ShipmentCostCommand = { operation: "update", resourceId: freightX,
      body: { expectedVersion: shipmentCostVersion(originalCharge!), actualCents: 33_000,
        reason: "Controlled FLOW late freight correction from $220 to $330" } };
    const amendmentIdentity = descriptor(amendment, "late-freight-x", "cost");
    const amendmentResult = await harness.costCommands.execute(amendment, FLOW_ACTOR, amendmentIdentity);
    expect(amendmentResult.httpStatus, JSON.stringify(amendmentResult.body)).toBe(200);
    await harness.shipment.finalizeAllocations(x.id, FLOW_ACTOR);
    await harness.shipment.pushLandedCostsToLots(x.id);
    expect((await allocations()).map(({ cents, product_id, shipment_number }) => ({ cents, product_id, shipment_number }))).toEqual([
      { shipment_number: "PROC-UAT-FLOW-X", product_id: 100, cents: "18000" },
      { shipment_number: "PROC-UAT-FLOW-X", product_id: 101, cents: "15000" },
      { shipment_number: "PROC-UAT-FLOW-Y", product_id: 100, cents: "8000" },
    ]);
    const afterLateCost = await money();
    expect(afterLateCost).toEqual({ inventoryMills: "43700000", soldMills: "2400000", totalMills: "46100000" });
    expect(BigInt(afterLateCost.inventoryMills) - BigInt(beforeLateCost.inventoryMills)).toBe(BigInt(1_000_000));
    expect(BigInt(afterLateCost.soldMills) - BigInt(beforeLateCost.soldMills)).toBe(BigInt(100_000));
    const valuation = await harness.cogs.getInventoryValuation();
    expect(valuation.totalValueCents).toBe(437_000);
    expect(valuation.byProduct.map(({ productId, totalQty, totalValueCents }) => ({ productId, totalQty, totalValueCents })))
      .toEqual([{ productId: 101, totalQty: 5, totalValueCents: 225_000 }, { productId: 100, totalQty: 9, totalValueCents: 212_000 }]);
    const adjustedCogs = await harness.cogs.getOrderCOGS(FLOW_IDS.order);
    expect(adjustedCogs?.totalCogsCents).toBe(24_000);
    expect(adjustedCogs).toMatchObject({ totalRevenueCents: 30_000, grossMarginCents: 6_000,
      lineItems: [expect.objectContaining({ revenueCents: 30_000, marginCents: 6_000 })] });
    const currentSources = (await harness.pool.query("SELECT * FROM procurement.cost_source_revisions ORDER BY id")).rows;
    for (const original of initialSources) expect(currentSources.find((source) => source.id === original.id)).toEqual(original);
    expect((await harness.pool.query("SELECT * FROM procurement.rfq_quote_revisions ORDER BY id")).rows).toEqual(originalQuoteEvidence);
    expect((await harness.pool.query("SELECT * FROM procurement.rfq_purchase_order_line_links ORDER BY id")).rows).toEqual(originalPurchaseLinks);

    const beforeReplay = await financialState();
    const replay = await harness.costCommands.execute(amendment, FLOW_ACTOR, amendmentIdentity);
    expect(replay.replayed).toBe(true);
    // The durable command stores the HTTP JSON representation, including ISO
    // date strings; compare wire-equivalent bodies rather than JS Date objects.
    expect(replay.body).toEqual(JSON.parse(JSON.stringify(amendmentResult.body)));
    const pushes = await Promise.all([harness.shipment.pushLandedCostsToLots(x.id), harness.shipment.pushLandedCostsToLots(x.id)]);
    for (const push of pushes) {
      expect(push.updated).toBe(0);
      expect(push.costApplications.every((application) => application.replayed)).toBe(true);
    }
    await harness.inventory.recordShipment({ ...sale, shipmentId: "PROC-UAT-FLOW-SALE" });
    expect(await financialState()).toEqual(beforeReplay);
    expect((await harness.pool.query(`SELECT attempt_count,status FROM public.financial_command_results
      WHERE idempotency_key='controlled-flow-late-freight-x'`)).rows).toEqual([{ attempt_count: 1, status: "succeeded" }]);
    expect((await harness.pool.query(`SELECT inbound_shipment_id,product_variant_id,
      total_unit_cost_mills::text AS cost_mills FROM inventory.inventory_lots
      GROUP BY inbound_shipment_id,product_variant_id,total_unit_cost_mills
      ORDER BY inbound_shipment_id,product_variant_id`)).rows).toEqual([
      { inbound_shipment_id: x.id, product_variant_id: 200, cost_mills: "2400000" },
      { inbound_shipment_id: x.id, product_variant_id: 202, cost_mills: "4500000" },
      { inbound_shipment_id: y.id, product_variant_id: 200, cost_mills: "2300000" },
    ]);

    // C05: link the corrected freight only after C04. AP records another view
    // of the same charge; it must not add its value again to inventory or COGS.
    const costAdjustmentsBeforeInvoices = (await harness.pool.query("SELECT * FROM inventory.cost_adjustment_log ORDER BY id")).rows;
    for (const [shipmentId, costId, invoiceNumber, cents] of [
      [x.id, freightX, "PROC-UAT-FLOW-FREIGHT-X", 33_000],
      [y.id, freightY, "PROC-UAT-FLOW-FREIGHT-Y", 8_000],
    ] as const) {
      const invoice = await harness.ap.createInvoiceFromShipmentCosts(shipmentId, {
        vendorId: FLOW_IDS.freightVendor, invoiceNumber, invoiceDate: FLOW_AT, costRowIds: [costId],
      }, FLOW_ACTOR);
      expect(invoice.invoicedAmountCents).toBe(cents);
      await harness.shipment.pushLandedCostsToLots(shipmentId);
      for (const lineId of shipmentId === x.id ? [xA, xB] : [yA]) {
        expect((await latestLandedEvidence(lineId)).contract.evidence).toBe("confirmed");
      }
      await harness.ap.approveInvoice(invoice.id, FLOW_ACTOR);
      await harness.shipment.pushLandedCostsToLots(shipmentId);
    }
    expect(await money()).toEqual(afterLateCost);
    const costAdjustmentsAfterInvoices = (await harness.pool.query("SELECT * FROM inventory.cost_adjustment_log ORDER BY id")).rows;
    expect(costAdjustmentsAfterInvoices.slice(0, costAdjustmentsBeforeInvoices.length)).toEqual(costAdjustmentsBeforeInvoices);
    // A newly recorded source document may add audit entries; it must not add
    // another economic adjustment for the already allocated freight amount.
    expect(costAdjustmentsAfterInvoices.slice(costAdjustmentsBeforeInvoices.length)
      .every((adjustment) => BigInt(adjustment.delta_cents) === BigInt(0))).toBe(true);
    expect((await harness.pool.query(`SELECT COUNT(*)::int AS count,SUM(invoiced_amount_cents)::text AS cents
      FROM procurement.vendor_invoices WHERE status='approved'`)).rows).toEqual([{ count: 4, cents: "461000" }]);
    expect((await harness.pool.query(`SELECT DISTINCT ON(inbound_shipment_line_id)
      inbound_shipment_line_id,contract->>'evidence' AS evidence FROM procurement.cost_source_revisions
      WHERE component='landed' ORDER BY inbound_shipment_line_id,revision DESC`)).rows).toEqual([
      { inbound_shipment_line_id: xA, evidence: "confirmed" },
      { inbound_shipment_line_id: xB, evidence: "confirmed" },
      { inbound_shipment_line_id: yA, evidence: "confirmed" },
    ]);
    expect(harness.suppressedChannelSyncs.length).toBeGreaterThan(0);
    console.info(JSON.stringify({ event: "procurement.controlled_flow.proven", authority: "pre_opening_legacy",
      rfqId: created.proposal.rfqId, poIds: [poA.purchaseOrderId, poB.purchaseOrderId], shipmentIds: [x.id, y.id],
      receiptIds: receipts.map((receipt) => receipt.receiptId), final: afterLateCost,
      providerSync: "suppressed", retry: "unchanged_command_and_concurrent_cost_pushes" }));
  }, 90_000);

  it.each([false, true])("keeps estimated freight unconfirmed until an exact approved invoice; mismatch=%s", async (mismatched) => {
    const created = await createPurchases();
    const purchase = created.purchases.get(FLOW_IDS.productA)!;
    await harness.purchasing.sendToVendor(purchase.purchaseOrderId, FLOW_ACTOR);
    const shipment = await harness.shipment.createShipment({ shipmentNumber: "PROC-UAT-EVIDENCE", mode: "sea_lcl", warehouseId: 1 }, FLOW_ACTOR);
    const shipmentLineId = await addShipmentLine(shipment.id, purchase.purchaseOrderId, purchase.lines[0].purchaseOrderLineId, 1_000, "evidence-line");
    const createCost: ShipmentCostCommand = { operation: "create", resourceId: shipment.id,
      body: { costType: "freight", estimatedCents: 22_000, allocationMethod: "by_weight", vendorId: FLOW_IDS.freightVendor } };
    const costResult = await harness.costCommands.execute(createCost, FLOW_ACTOR, descriptor(createCost, "estimated-charge", "cost"));
    expect(costResult.httpStatus).toBe(201);
    const costId = positiveId.parse(costResult.body).id;
    await finalizeDeliveredShipment(shipment.id);
    expect((await latestLandedEvidence(shipmentLineId)).contract.evidence).toBe("estimated");
    const invoice = await harness.ap.createInvoiceFromShipmentCosts(shipment.id, {
      vendorId: FLOW_IDS.freightVendor, invoiceNumber: "PROC-UAT-ESTIMATE-INVOICE", invoiceDate: FLOW_AT, costRowIds: [costId],
      ...(mismatched ? { lineOverrides: [{ freightCostId: costId, qtyInvoiced: 1, unitCostMills: 2_300_000 }] } : {}),
    }, FLOW_ACTOR);
    await harness.shipment.pushLandedCostsToLots(shipment.id);
    expect((await latestLandedEvidence(shipmentLineId)).contract.evidence).toBe(mismatched ? "review_required" : "estimated");
    await harness.ap.approveInvoice(invoice.id, FLOW_ACTOR);
    const push = await harness.shipment.pushLandedCostsToLots(shipment.id);
    const approved = await latestLandedEvidence(shipmentLineId);
    if (mismatched) {
      expect(push.status).toBe("review_required");
      expect(approved.contract).toMatchObject({ evidence: "review_required", issue: { code: "LANDED_INVOICE_AMOUNT_REVIEW" } });
    } else {
      expect(approved.contract).toMatchObject({ evidence: "confirmed", issue: null });
      expect(approved.contract.sources).toContainEqual(expect.objectContaining({ kind: "vendor_invoice_line", documentId: invoice.id }));
      for (const expectedStatus of ["partially_paid", "paid"]) {
        await harness.ap.recordPayment({ vendorId: FLOW_IDS.freightVendor, paymentDate: FLOW_AT,
          paymentMethod: "wire", currency: "USD", totalAmountCents: 11_000,
          allocations: [{ vendorInvoiceId: invoice.id, appliedAmountCents: 11_000 }], createdBy: FLOW_ACTOR });
        expect((await harness.pool.query("SELECT status FROM procurement.vendor_invoices WHERE id=$1", [invoice.id])).rows[0].status).toBe(expectedStatus);
        await harness.shipment.pushLandedCostsToLots(shipment.id);
        expect((await latestLandedEvidence(shipmentLineId)).contract.evidence).toBe("confirmed");
      }
    }
    const beforeReplay = await financialState();
    await harness.shipment.pushLandedCostsToLots(shipment.id);
    expect(await financialState()).toEqual(beforeReplay);
    expect(await money()).toEqual({ inventoryMills: "0", soldMills: "0", totalMills: "0" });
  });
});
