import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defaultPurchasePlanningPolicy } from "@shared/procurement/purchase-planning-policy";
import { shipmentCreateResultSchema } from "@shared/procurement/shipment-create-command";
import { verifiedCustodyResultSchema } from "@shared/procurement/receiving-quarantine-command";
import type { ReceivingQuarantineCommandResult } from "@shared/procurement/receiving-quarantine";
import type { FinancialCommandDescriptor } from "../../../../platform/commands/transactional-command.service";
import type { PurchasingRecommendationRawRow } from "../../purchasing-recommendation.engine";
import type { ReceivingCustodyCommand } from "../../receiving-quarantine.service";
import { receivingUnitVersion } from "../../receiving-unit-contract";
import { createFlowCostHarness, FLOW_ACTOR, FLOW_AT, FLOW_IDS, seedFlowMasterData, type FlowCostHarness } from "./procurement-flow-cost.fixture";

const databaseUrl = process.env.ECHELON_TEST_DATABASE_URL;
const suite = databaseUrl && process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true" ? describe : describe.skip;
const ORDERED_PIECES = 1_000;
const PIECES_PER_CASE = 100;
const HOLDING_LOCATION_ID = 100;
const CUSTODY_REASON = "Controlled lifecycle inspection recorded damaged cases in physical custody";

function demandRow(): PurchasingRecommendationRawRow {
  return {
    product_id: FLOW_IDS.productA, variant_id: FLOW_IDS.caseA, base_sku: "PROC-UAT-FLOW-A",
    product_name: "Controlled FLOW product A", total_pieces: 0, total_reserved_pieces: 0,
    total_outbound_pieces: 750, previous_outbound_pieces: 750, lead_time_days: 30, safety_stock_days: 10,
    on_order_pieces: 0, inbound_schedule: [], receipt_supply_evidence: { version: 1, lines: [] },
    receive_variant_selection: { version: 1, highestHierarchyLevel: 2, candidateCount: 1, selectedVariantId: FLOW_IDS.caseA },
    recommendation_analysis_date: "2026-09-10", forward_demand_contributions: [],
    forward_demand_planning_as_of_date: "2026-09-10", forward_demand_horizon_days: 90,
  };
}

suite.sequential("RFQ-origin shipment quarantine lifecycle preserves physical custody", () => {
  let harness: FlowCostHarness;
  let disposeHarness: (() => Promise<void>) | undefined;
  let custodyModule: typeof import("../../receiving-quarantine.commands");
  let custodyCommands: ReturnType<typeof import("../../receiving-quarantine.commands").createReceivingCustodyCommands>;
  let readCustody: typeof import("../../receiving-quarantine.service").readReceivingQuarantineView;
  let acceptanceOptions: typeof import("../../receiving-quarantine-options.repository").readQuarantineAcceptanceOptions;
  let shipmentCommands: ReturnType<typeof import("../../shipment-create.commands").createShipmentCreateCommands>;
  let shipmentModule: typeof import("../../shipment-create.commands");
  let hashCommand: typeof import("../../../../platform/commands/http-command").hashHttpFinancialCommand;

  beforeEach(async () => {
    harness = await createFlowCostHarness(databaseUrl!);
    disposeHarness = harness.dispose;
    await seedFlowMasterData(harness);
    await harness.pool.query(readFileSync(resolve(process.cwd(), "migrations/114_receiving_order_shipment_po_active_predicate.sql"), "utf8"));
    // Identity DDL belongs to FLOW. Only add the exact authority needed for
    // custody to its existing actor; ID 1 remains the RFQ purchasing edit grant.
    await harness.pool.query(`
      INSERT INTO identity.auth_permissions(id,resource,action,category) OVERRIDING SYSTEM VALUE
        VALUES(10,'inventory','adjust','inventory'),(11,'purchasing','approve','purchasing');
      INSERT INTO identity.auth_role_permissions(role_id,permission_id,constraints)
        VALUES(1,10,NULL),(1,11,NULL)`);
    custodyModule = await import("../../receiving-quarantine.commands");
    shipmentModule = await import("../../shipment-create.commands");
    const repositoryModule = await import("../../../../platform/commands/command-results.repository");
    const repository = repositoryModule.createDrizzleFinancialCommandRepository(harness.database);
    custodyCommands = custodyModule.createReceivingCustodyCommands(harness.receiving, repository, () => FLOW_AT);
    shipmentCommands = shipmentModule.createShipmentCreateCommands(harness.shipment, repository, () => FLOW_AT);
    readCustody = (await import("../../receiving-quarantine.service")).readReceivingQuarantineView;
    acceptanceOptions = (await import("../../receiving-quarantine-options.repository")).readQuarantineAcceptanceOptions;
    hashCommand = (await import("../../../../platform/commands/http-command")).hashHttpFinancialCommand;
  });

  afterEach(async () => {
    const dispose = disposeHarness;
    disposeHarness = undefined;
    await dispose?.();
  });

  async function custody(command: ReceivingCustodyCommand, resourceId: number, body: unknown, key: string): Promise<ReceivingQuarantineCommandResult> {
    const identity: FinancialCommandDescriptor = {
      ...custodyModule.custodyCommandScope(), actorType: "service", actorId: "procurement.receiving-custody",
      idempotencyKey: key, requestHash: custodyModule.hashCustodyCommandIdentity({ command, resourceId, body, actorId: FLOW_ACTOR }),
      contractVersion: 1,
    };
    const result = await custodyCommands.execute(command, resourceId, body, FLOW_ACTOR, identity);
    expect(result, JSON.stringify(result.body)).toMatchObject({ httpStatus: 200, terminalState: "succeeded" });
    expect(await custodyCommands.execute(command, resourceId, body, FLOW_ACTOR, identity))
      .toMatchObject({ replayed: true, body: result.body });
    return verifiedCustodyResultSchema.parse(result.body);
  }

  async function physicalState() {
    // This scenario never changes catalog units. Verify both ordinary stock and
    // base-piece PO postings, not a display-only receiving quantity.
    return (await harness.pool.query(`SELECT
      (SELECT COALESCE(SUM(l.variant_qty::bigint * v.units_per_variant),0)::text
        FROM inventory.inventory_levels l JOIN catalog.product_variants v ON v.id=l.product_variant_id) AS stock_pieces,
      (SELECT COALESCE(SUM(qty_received),0)::text FROM procurement.po_receipts) AS po_received_pieces,
      (SELECT COUNT(*)::int FROM inventory.inventory_lots) AS lots,
      (SELECT COUNT(*)::int FROM inventory.inventory_transactions WHERE transaction_type='receipt') AS receipt_transactions`)).rows[0];
  }

  async function createSourcePurchase(includeUnrelatedLine = false) {
    const created = await harness.rfqHelper.createControlledRfqPurchases({
      database: harness.database, purchasingOwner: harness.purchasing, actorId: FLOW_ACTOR,
      at: FLOW_AT, key: "controlled-custody-lifecycle", lookbackDays: 30,
      settings: { planningPolicy: defaultPurchasePlanningPolicy(), planningPolicyRevision: 0, autoDraftMode: "review_only" },
      rows: [demandRow()], quotes: [{ productId: FLOW_IDS.productA, quote: {
        pricing: { basis: "per_purchase_uom", purchaseUom: "case", uomQuantity: 10,
          piecesPerUom: PIECES_PER_CASE, quotedCostMillsPerUom: 2_000_000 },
        packagingTreatment: "separate", packagingCostCents: 0, quoteReference: "CONTROLLED-CUSTODY-QUOTE",
        quoteValidUntil: null, quotedAt: FLOW_AT.toISOString(), leadTimeDays: 30,
        reason: "Controlled supplier quote for ten cases of one hundred pieces",
      } }],
    });
    const purchase = created.purchases.get(FLOW_IDS.productA)!;
    const unrelatedLine = includeUnrelatedLine ? await harness.purchasing.addLine(purchase.purchaseOrderId, {
      expectedPoUpdatedAt: (await harness.storage.getPurchaseOrderById(purchase.purchaseOrderId))!.updatedAt!.toISOString(),
      productId: FLOW_IDS.productB, expectedReceiveVariantId: FLOW_IDS.caseB, expectedReceiveUnitsPerVariant: PIECES_PER_CASE,
      pricing: { basis: "per_piece", quantityPieces: 100, unitCostMills: 40_000 }, packagingCostCents: 0,
    }, FLOW_ACTOR) : null;
    await harness.purchasing.sendToVendor(purchase.purchaseOrderId, FLOW_ACTOR);
    await harness.purchasing.send(purchase.purchaseOrderId, FLOW_ACTOR, {
      confirmedSentExternally: true,
      expectedUpdatedAt: (await harness.storage.getPurchaseOrderById(purchase.purchaseOrderId))!.updatedAt!.toISOString(),
    });
    return { ...purchase, unrelatedLine };
  }

  async function sourceWithHeldGoods(acceptedPieces: number, heldPieces = ORDERED_PIECES - acceptedPieces, includeUnrelatedLine = false) {
    const purchase = await createSourcePurchase(includeUnrelatedLine);
    const body = { shipmentNumber: "PROC-UAT-CUSTODY-LIFECYCLE", mode: "sea_lcl", warehouseId: FLOW_IDS.warehouse,
      purchaseOrder: { purchaseOrderId: purchase.purchaseOrderId, lineSelections: [{
        poLineId: purchase.lines[0].purchaseOrderLineId, qty: ORDERED_PIECES,
        unitSelection: { productVariantId: FLOW_IDS.caseA, unitsPerVariant: PIECES_PER_CASE, quantity: 10 },
      }] },
    };
    const scope = shipmentModule.shipmentCreateCommandScope();
    const identity: FinancialCommandDescriptor = { ...scope, actorType: "service", actorId: shipmentModule.SHIPMENT_CREATE_COMMAND_PRINCIPAL,
      idempotencyKey: "controlled-custody-shipment-create", requestHash: hashCommand({ ...scope, body }), contractVersion: 1 };
    const response = await shipmentCommands.execute(body, FLOW_ACTOR, identity);
    expect(response, JSON.stringify(response.body)).toMatchObject({ httpStatus: 201, terminalState: "succeeded" });
    const shipment = shipmentCreateResultSchema.parse(response.body);
    expect(await shipmentCommands.execute(body, FLOW_ACTOR, identity)).toMatchObject({ replayed: true, body: response.body });
    expect((await harness.pool.query("SELECT COUNT(*)::int AS count FROM procurement.inbound_shipments")).rows).toEqual([{ count: 1 }]);
    const [shipmentLine] = await harness.storage.getInboundShipmentLines(shipment.id);
    expect(shipmentLine).toMatchObject({ purchaseOrderLineId: purchase.lines[0].purchaseOrderLineId,
      qtyShipped: ORDERED_PIECES, unitsPerVariantSnapshot: PIECES_PER_CASE });
    await harness.shipment.book(shipment.id, FLOW_ACTOR);
    await harness.shipment.markInTransit(shipment.id, FLOW_ACTOR);
    await harness.shipment.markAtPort(shipment.id, FLOW_ACTOR);
    await harness.shipment.markCustomsClearance(shipment.id, FLOW_ACTOR);
    await harness.shipment.markDelivered(shipment.id, FLOW_ACTOR);

    const receipt = await harness.purchasing.createReceiptFromShipment(shipment.id, FLOW_ACTOR, { purchaseOrderId: purchase.purchaseOrderId });
    await harness.receiving.open(receipt.id, FLOW_ACTOR);
    await harness.receiving.updateOrderDetails(receipt.id, { warehouseId: FLOW_IDS.warehouse }, FLOW_ACTOR);
    const [initialLine] = await harness.storage.getReceivingLines(receipt.id);
    await harness.receiving.updateLine(initialLine.id, { putawayLocationId: FLOW_IDS.locationX }, FLOW_ACTOR);
    const [line] = await harness.storage.getReceivingLines(receipt.id);
    const heldCases = heldPieces / PIECES_PER_CASE;
    const held = await custody("intake", receipt.id, {
      kind: "receipt_line", receivingLineId: line.id, expectedUnitVersion: receivingUnitVersion(line),
      acceptedQty: acceptedPieces / PIECES_PER_CASE, heldQty: heldCases, countsReviewed: true,
      condition: "damaged", holdingLocationId: HOLDING_LOCATION_ID, reason: CUSTODY_REASON,
      evidenceReference: "controlled-custody-inspection",
    }, "controlled-custody-intake");
    expect(held.observation).toMatchObject({ purchaseOrderLineId: purchase.lines[0].purchaseOrderLineId,
      inboundShipmentLineId: shipmentLine.id, unitsPerVariant: PIECES_PER_CASE, physicalHeldQty: heldCases });
    expect(await physicalState()).toMatchObject({ stock_pieces: "0", po_received_pieces: "0" });
    await harness.receiving.close(receipt.id, FLOW_ACTOR);
    const posted = await physicalState();
    expect(posted).toMatchObject({ stock_pieces: String(acceptedPieces), po_received_pieces: String(acceptedPieces) });
    await harness.receiving.close(receipt.id, FLOW_ACTOR);
    expect(await physicalState()).toEqual(posted);
    return { purchase, shipment, shipmentLine, receipt, line, held, heldCases, acceptedPieces };
  }

  type HeldSource = Awaited<ReturnType<typeof sourceWithHeldGoods>>;

  async function poDirectSourceWithHeldGoods() {
    const purchase = await createSourcePurchase();
    const receipt = await harness.purchasing.createReceiptFromPO(purchase.purchaseOrderId, FLOW_ACTOR);
    await harness.receiving.open(receipt.id, FLOW_ACTOR);
    await harness.receiving.updateOrderDetails(receipt.id, { warehouseId: FLOW_IDS.warehouse }, FLOW_ACTOR);
    const [initial] = await harness.storage.getReceivingLines(receipt.id);
    await harness.receiving.updateLine(initial.id, { putawayLocationId: FLOW_IDS.locationX }, FLOW_ACTOR);
    const [line] = await harness.storage.getReceivingLines(receipt.id);
    const held = await custody("intake", receipt.id, { kind: "receipt_line", receivingLineId: line.id,
      expectedUnitVersion: receivingUnitVersion(line), acceptedQty: 8, heldQty: 2, countsReviewed: true,
      condition: "damaged", holdingLocationId: HOLDING_LOCATION_ID, reason: CUSTODY_REASON,
      evidenceReference: "controlled-direct-custody-inspection" }, "controlled-direct-custody-intake");
    await harness.receiving.close(receipt.id, FLOW_ACTOR);
    expect(await physicalState()).toMatchObject({ stock_pieces: "800", po_received_pieces: "800" });
    return { purchase, receipt, line, held, heldCases: 2 };
  }

  async function prepareAcceptance(source: { receipt: { id: number }; line: { id: number }; held: { observation: { id: number } }; heldCases: number }, key = "controlled-custody-acceptance") {
    const options = await harness.database.transaction(tx => acceptanceOptions(tx, source.receipt.id, FLOW_ACTOR, { q: "" }));
    const selected = options.items.find(row => row.receivingLineId === source.line.id)!;
    expect(selected).toBeDefined();
    const current = (await harness.database.transaction(tx => readCustody(tx, source.receipt.id, FLOW_ACTOR))).observations[0];
    return custody("prepare-acceptance", source.held.observation.id, {
      expectedVersion: current.version, observationQty: source.heldCases,
      targetReceivingOrderId: selected.targetReceivingOrderId, targetSourceReceivingLineId: selected.receivingLineId,
      expectedTargetUnitVersion: selected.unitVersion, productVariantId: selected.productVariantId,
      expectedUnitsPerVariant: selected.unitsPerVariant, acceptedVariantQty: source.heldCases,
      purchaseOrderLineId: selected.purchaseOrderLineId, inboundShipmentLineId: selected.inboundShipmentLineId,
      putawayLocationId: FLOW_IDS.locationX, reason: "Inspection approved the exact held cases for normal receiving", countConversionReviewed: true,
    }, key);
  }

  async function historicalOrdinaryLine(receiptId: number, source: HeldSource, cases = source.heldCases, shipmentScoped = true) {
    // Explicit historical fixture: the old shipment handoff could persist this
    // source-linked ordinary line. Current public manual-entry APIs correctly
    // forbid assigning those source fields, so do not pretend they create it.
    const [origin] = await harness.storage.getReceivingLines(source.receipt.id);
    await harness.database.transaction(async tx => harness.storage.createReceivingLine({
      receivingOrderId: receiptId, productId: FLOW_IDS.productA, productVariantId: FLOW_IDS.caseA,
      unitsPerVariantSnapshot: PIECES_PER_CASE, sku: origin.sku, productName: origin.productName,
      purchaseOrderLineId: source.purchase.lines[0].purchaseOrderLineId, inboundShipmentLineId: shipmentScoped ? source.shipmentLine.id : null,
      expectedQty: 0, receivedQty: cases, damagedQty: 0, putawayLocationId: FLOW_IDS.locationX,
      unitCost: origin.unitCost, unitCostMills: origin.unitCostMills, costSourceKind: origin.costSourceKind,
      status: "complete",
    }, tx));
  }
  async function ordinaryDraft(source: HeldSource, shipmentScoped = true) {
    const receipt = await harness.database.transaction(async tx => harness.storage.createReceivingOrder({
      receiptNumber: await harness.storage.generateReceiptNumber(tx), sourceType: shipmentScoped ? "shipment" : "po", warehouseId: FLOW_IDS.warehouse,
      purchaseOrderId: source.purchase.purchaseOrderId, inboundShipmentId: shipmentScoped ? source.shipment.id : null, vendorId: FLOW_IDS.vendor,
      status: "draft", createdBy: FLOW_ACTOR,
    }, tx));
    await historicalOrdinaryLine(receipt.id, source, source.heldCases, shipmentScoped);
    return receipt;
  }

  for (const acceptedPieces of [800, 0]) {
    it(`rejects closing an existing ordinary draft over ${ORDERED_PIECES - acceptedPieces} held pieces even with over-receipt confirmation`, async () => {
      const source = await sourceWithHeldGoods(acceptedPieces);
      const draft = await ordinaryDraft(source);
      const before = await physicalState();
      await expect(harness.receiving.close(draft.id, FLOW_ACTOR, { allowOverReceipt: true }))
        .rejects.toMatchObject({ statusCode: 409, details: { code: "SHIPMENT_RECEIPT_COVERAGE_REVIEW_REQUIRED" } });
      expect(await physicalState()).toEqual(before);
      expect((await harness.storage.getReceivingOrderById(draft.id))?.status).toBe("draft");
    }, 90_000);

    it(`does not re-admit ${ORDERED_PIECES - acceptedPieces} held pieces through ordinary Receive again after ${acceptedPieces} accepted pieces`, async () => {
      const source = await sourceWithHeldGoods(acceptedPieces);
      const before = await physicalState();
      const viewBefore = await harness.database.transaction(tx => readCustody(tx, source.receipt.id, FLOW_ACTOR));
      const options = await harness.purchasing.getShipmentPoReceiveOptions(source.shipment.id);
      const option = options.purchaseOrders.find(row => row.purchaseOrderId === source.purchase.purchaseOrderId);
      expect.soft(option, "All shipped pieces are already accepted or held; none are a fresh delivery").toMatchObject({ receivable: false });

      // Exercise the real handoff even if its preview is wrong. A green test
      // requires rejection, not a characterization accepting duplicated custody.
      let ordinaryReceipt: Awaited<ReturnType<FlowCostHarness["purchasing"]["createReceiptFromShipment"]>> | undefined;
      try {
        ordinaryReceipt = await harness.purchasing.createReceiptFromShipment(source.shipment.id, FLOW_ACTOR,
          { purchaseOrderId: source.purchase.purchaseOrderId });
      } catch (error) {
        expect(error).toMatchObject({ statusCode: 409 });
      }
      expect.soft(ordinaryReceipt, "Held goods require explicit custody resolution before an ordinary new receipt").toBeUndefined();
      if (ordinaryReceipt) {
        await harness.receiving.open(ordinaryReceipt.id, FLOW_ACTOR);
        await harness.receiving.updateOrderDetails(ordinaryReceipt.id, { warehouseId: FLOW_IDS.warehouse }, FLOW_ACTOR);
        const [ordinaryLine] = await harness.storage.getReceivingLines(ordinaryReceipt.id);
        expect(ordinaryLine).toMatchObject({ inboundShipmentLineId: source.shipmentLine.id, expectedQty: source.heldCases });
        let postedOrdinaryReceipt = false;
        try {
          await harness.receiving.updateLine(ordinaryLine.id, { receivedQty: ordinaryLine.expectedQty,
            expectedUnitVersion: receivingUnitVersion(ordinaryLine), putawayLocationId: FLOW_IDS.locationX }, FLOW_ACTOR);
          await harness.receiving.close(ordinaryReceipt.id, FLOW_ACTOR);
          postedOrdinaryReceipt = true;
        } catch (error) {
          expect(error).toMatchObject({ statusCode: 409 });
        }
        expect.soft(postedOrdinaryReceipt, "An ordinary receipt must not post goods still held in custody").toBe(false);
      }
      const after = await physicalState();
      expect.soft(after, "No quarantine approval occurred, so inventory and accepted PO pieces must remain unchanged").toEqual(before);
      expect(await harness.database.transaction(tx => readCustody(tx, source.receipt.id, FLOW_ACTOR))).toEqual(viewBefore);
      console.info(JSON.stringify({ event: "procurement.lifecycle.quarantine_receive_again", acceptedPieces,
        heldPieces: source.heldCases * PIECES_PER_CASE, shipmentId: source.shipment.id, receiptId: source.receipt.id,
        ordinaryReceiptId: ordinaryReceipt?.id ?? null, preview: option, before, after }));
    }, 90_000);

    it(`releases ${ORDERED_PIECES - acceptedPieces} held pieces only through reviewed custody acceptance and normal close`, async () => {
      const source = await sourceWithHeldGoods(acceptedPieces);
      const before = await physicalState();
      const options = await harness.database.transaction(tx => acceptanceOptions(tx, source.receipt.id, FLOW_ACTOR, { q: "" }));
      const option = options.items.find(row => row.receivingLineId === source.line.id);
      expect(option).toBeDefined();
      const selected = option!;
      const prepared = await custody("prepare-acceptance", source.held.observation.id, {
        expectedVersion: source.held.observation.version, observationQty: source.heldCases,
        targetReceivingOrderId: selected.targetReceivingOrderId, targetSourceReceivingLineId: selected.receivingLineId,
        expectedTargetUnitVersion: selected.unitVersion, productVariantId: selected.productVariantId,
        expectedUnitsPerVariant: selected.unitsPerVariant, acceptedVariantQty: source.heldCases,
        purchaseOrderLineId: selected.purchaseOrderLineId, inboundShipmentLineId: selected.inboundShipmentLineId,
        putawayLocationId: FLOW_IDS.locationX, reason: "Inspection approved the exact held cases for normal receiving",
        countConversionReviewed: true,
      }, "controlled-custody-acceptance");
      expect(prepared.acceptance).not.toBeNull();
      expect(prepared.observation).toMatchObject({ awaitingReceiptQty: source.heldCases, receivedQty: 0,
        physicalHeldQty: source.heldCases });
      expect(await physicalState()).toEqual(before);
      await harness.receiving.close(prepared.acceptance!.receivingOrderId, FLOW_ACTOR);
      const posted = await physicalState();
      expect(posted).toMatchObject({ stock_pieces: String(ORDERED_PIECES), po_received_pieces: String(ORDERED_PIECES) });
      await harness.receiving.close(prepared.acceptance!.receivingOrderId, FLOW_ACTOR);
      expect(await physicalState()).toEqual(posted);
      const view = await harness.database.transaction(tx => readCustody(tx, source.receipt.id, FLOW_ACTOR));
      expect(view.observations).toMatchObject([{ physicalHeldQty: 0, awaitingReceiptQty: 0, receivedQty: source.heldCases,
        purchaseOrderLineId: source.purchase.lines[0].purchaseOrderLineId, inboundShipmentLineId: source.shipmentLine.id }]);
      const coverage = await harness.purchasing.getShipmentPoReceiveOptions(source.shipment.id);
      expect(coverage.purchaseOrders).toMatchObject([{ purchaseOrderId: source.purchase.purchaseOrderId,
        receivedBaseQty: ORDERED_PIECES, remainingBaseQty: 0, receivable: false }]);
    }, 90_000);
  }

  it("receives only a true unarrived remainder while keeping held units separate", async () => {
    const source = await sourceWithHeldGoods(600, 200);
    const preview = await harness.purchasing.getShipmentPoReceiveOptions(source.shipment.id);
    expect(preview.purchaseOrders).toMatchObject([{ receivedBaseQty: 600, custodyBaseQty: 200,
      heldBaseQty: 200, returnedBaseQty: 0, remainingBaseQty: 200, receivable: true, custodyReceiptIds: [source.receipt.id] }]);
    const pack = await harness.purchasing.getShipmentReceiptPackResolution(source.shipment.id, { purchaseOrderId: source.purchase.purchaseOrderId });
    expect(pack).toMatchObject({ qtyShipped: 1_000, receivedBaseQty: 600, custodyBaseQty: 200,
      heldBaseQty: 200, returnedBaseQty: 0, remainingBaseQty: 200, canCreateReceipt: true, custodyReceiptIds: [source.receipt.id],
      lines: [{ qtyShipped: 200, receivePlan: { expectedQty: 2 } }] });
    const receipt = await harness.purchasing.createReceiptFromShipment(source.shipment.id, FLOW_ACTOR, { purchaseOrderId: source.purchase.purchaseOrderId });
    await harness.receiving.updateOrderDetails(receipt.id, { warehouseId: FLOW_IDS.warehouse }, FLOW_ACTOR);
    const [line] = await harness.storage.getReceivingLines(receipt.id);
    expect(line.expectedQty).toBe(2);
    await harness.receiving.updateLine(line.id, { receivedQty: 2, putawayLocationId: FLOW_IDS.locationX,
      expectedUnitVersion: receivingUnitVersion(line) }, FLOW_ACTOR);
    await harness.receiving.close(receipt.id, FLOW_ACTOR);
    expect(await physicalState()).toMatchObject({ stock_pieces: "800", po_received_pieces: "800" });
    const prepared = await prepareAcceptance(source);
    await harness.receiving.close(prepared.acceptance!.receivingOrderId, FLOW_ACTOR);
    expect(await physicalState()).toMatchObject({ stock_pieces: "1000", po_received_pieces: "1000" });
  }, 90_000);

  it("does not re-admit shipment-held goods through the alternate PO-direct receiving handoff", async () => {
    const source = await sourceWithHeldGoods(800);
    const before = await physicalState();
    const custodyBefore = await harness.database.transaction(tx => readCustody(tx, source.receipt.id, FLOW_ACTOR));
    const preview = await harness.purchasing.getPurchaseOrderReceiveOptions(source.purchase.purchaseOrderId);
    expect.soft(preview.poDirect.allowed, "The remaining PO pieces are already held, not a fresh arrival").toBe(false);
    let ordinaryReceipt: Awaited<ReturnType<FlowCostHarness["purchasing"]["createReceiptFromPO"]>> | undefined;
    let rejection: unknown;
    try {
      ordinaryReceipt = await harness.purchasing.createReceiptFromPO(source.purchase.purchaseOrderId, FLOW_ACTOR);
      await harness.receiving.updateOrderDetails(ordinaryReceipt.id, { warehouseId: FLOW_IDS.warehouse }, FLOW_ACTOR);
      const [line] = await harness.storage.getReceivingLines(ordinaryReceipt.id);
      await harness.receiving.updateLine(line.id, { receivedQty: source.heldCases, putawayLocationId: FLOW_IDS.locationX,
        expectedUnitVersion: receivingUnitVersion(line) }, FLOW_ACTOR);
      await harness.receiving.close(ordinaryReceipt.id, FLOW_ACTOR, { allowOverReceipt: true });
    } catch (error) {
      rejection = error;
    }
    expect.soft(rejection, "PO-direct creation or close must refuse ordinary admission of the already-held pieces")
      .toMatchObject({ statusCode: 409 });
    expect(await physicalState()).toEqual(before);
    expect(await harness.database.transaction(tx => readCustody(tx, source.receipt.id, FLOW_ACTOR))).toEqual(custodyBefore);
  }, 90_000);

  it("blocks a pre-existing PO-direct draft on a purchase line with shipment custody", async () => {
    const source = await sourceWithHeldGoods(800);
    const draft = await ordinaryDraft(source, false);
    const before = await physicalState();
    await expect(harness.receiving.close(draft.id, FLOW_ACTOR, { allowOverReceipt: true }))
      .rejects.toMatchObject({ statusCode: 409, details: { code: "PO_DIRECT_CUSTODY_SOURCE_REQUIRED" } });
    expect(await physicalState()).toEqual(before);
  }, 90_000);

  it("does not let a second intake on an old PO-direct draft manufacture permission to post another source's custody", async () => {
    const source = await sourceWithHeldGoods(800);
    const draft = await ordinaryDraft(source, false);
    const [line] = await harness.storage.getReceivingLines(draft.id);
    const before = await physicalState();
    await custody("intake", draft.id, { kind: "receipt_line", receivingLineId: line.id,
      expectedUnitVersion: receivingUnitVersion(line), acceptedQty: 1, heldQty: 1, countsReviewed: true,
      condition: "damaged", holdingLocationId: HOLDING_LOCATION_ID, reason: "A second recount cannot release original held stock",
      evidenceReference: "controlled-conflicting-intake" }, "controlled-conflicting-intake");
    await expect(harness.receiving.close(draft.id, FLOW_ACTOR, { allowOverReceipt: true }))
      .rejects.toMatchObject({ statusCode: 409, details: { code: "PO_DIRECT_CUSTODY_SOURCE_REQUIRED" } });
    expect(await physicalState()).toEqual(before);
  }, 90_000);

  it("keeps PO-direct custody out of a fresh ordinary receipt while permitting its original counts and explicit acceptance", async () => {
    const source = await poDirectSourceWithHeldGoods();
    const before = await physicalState();
    const preview = await harness.purchasing.getPurchaseOrderReceiveOptions(source.purchase.purchaseOrderId);
    expect(preview.poDirect).toMatchObject({ allowed: false, blockedPurchaseOrderLineIds: [source.purchase.lines[0].purchaseOrderLineId],
      custodyReceiptIds: [source.receipt.id] });
    await expect(harness.purchasing.createReceiptFromPO(source.purchase.purchaseOrderId, FLOW_ACTOR))
      .rejects.toMatchObject({ statusCode: 409, details: { code: "PO_DIRECT_CUSTODY_SOURCE_REQUIRED" } });
    expect(await physicalState()).toEqual(before);
    const prepared = await prepareAcceptance(source);
    expect((await harness.storage.getReceivingOrderById(prepared.acceptance!.receivingOrderId))?.inboundShipmentId).toBeNull();
    await harness.receiving.close(prepared.acceptance!.receivingOrderId, FLOW_ACTOR);
    const posted = await physicalState();
    expect(posted).toMatchObject({ stock_pieces: "1000", po_received_pieces: "1000" });
    await harness.receiving.close(prepared.acceptance!.receivingOrderId, FLOW_ACTOR);
    expect(await physicalState()).toEqual(posted);
  }, 90_000);

  it("discloses custody source exclusions and still receives an unrelated purchase line directly", async () => {
    const source = await sourceWithHeldGoods(800, 200, true);
    const preview = await harness.purchasing.getPurchaseOrderReceiveOptions(source.purchase.purchaseOrderId);
    expect(preview.poDirect).toMatchObject({ allowed: true, blockedPurchaseOrderLineIds: [source.purchase.lines[0].purchaseOrderLineId],
      custodyReceiptIds: [source.receipt.id], warning: expect.stringContaining("PO-direct receiving excludes") });
    const direct = await harness.purchasing.createReceiptFromPO(source.purchase.purchaseOrderId, FLOW_ACTOR);
    const lines = await harness.storage.getReceivingLines(direct.id);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ purchaseOrderLineId: source.purchase.unrelatedLine!.id, productId: FLOW_IDS.productB, expectedQty: 1 });
    await harness.receiving.updateOrderDetails(direct.id, { warehouseId: FLOW_IDS.warehouse }, FLOW_ACTOR);
    await harness.receiving.updateLine(lines[0].id, { receivedQty: 1, putawayLocationId: FLOW_IDS.locationX,
      expectedUnitVersion: receivingUnitVersion(lines[0]) }, FLOW_ACTOR);
    await harness.receiving.close(direct.id, FLOW_ACTOR);
    expect(await physicalState()).toMatchObject({ stock_pieces: "900", po_received_pieces: "900" });
    expect((await harness.database.transaction(tx => readCustody(tx, source.receipt.id, FLOW_ACTOR))).observations)
      .toMatchObject([{ physicalHeldQty: 2, receivedQty: 0 }]);
  }, 90_000);

  it("preserves reviewed unidentified-package acceptance without lending its authority to an ordinary sibling line", async () => {
    const source = await poDirectSourceWithHeldGoods();
    const before = await physicalState();
    const unknown = await custody("intake", source.receipt.id, { kind: "unidentified", quantity: 1, unitLabel: "sealed package",
      description: "A separately observed package pending product inspection", observedSku: null, condition: "unexpected",
      holdingLocationId: HOLDING_LOCATION_ID, reason: "Record separate unknown package before inspection",
      evidenceReference: "controlled-unknown-package" }, "controlled-unknown-intake");
    const options = await harness.database.transaction(tx => acceptanceOptions(tx, source.receipt.id, FLOW_ACTOR, { q: "" }));
    const selected = options.items.find(row => row.receivingLineId === source.line.id)!;
    expect(selected).toBeDefined();
    const approved = await custody("prepare-acceptance", unknown.observation.id, {
      expectedVersion: 0, observationQty: 1, targetReceivingOrderId: selected.targetReceivingOrderId,
      targetSourceReceivingLineId: selected.receivingLineId, expectedTargetUnitVersion: selected.unitVersion,
      productVariantId: selected.productVariantId, expectedUnitsPerVariant: selected.unitsPerVariant, acceptedVariantQty: 1,
      purchaseOrderLineId: selected.purchaseOrderLineId, inboundShipmentLineId: null, putawayLocationId: FLOW_IDS.locationX,
      reason: "Inspection explicitly identified the package as one hundred matching product pieces", countConversionReviewed: true,
    }, "controlled-unknown-acceptance");
    // A historical ordinary sibling must not borrow the dedicated prepared
    // acceptance's proof. Public manual entry cannot assign this PO source.
    const original = (await harness.storage.getReceivingLineById(source.line.id))!;
    const sibling = await harness.database.transaction(tx => harness.storage.createReceivingLine({
      receivingOrderId: approved.acceptance!.receivingOrderId, productId: original.productId, productVariantId: original.productVariantId,
      unitsPerVariantSnapshot: original.unitsPerVariantSnapshot, purchaseOrderLineId: original.purchaseOrderLineId,
      inboundShipmentLineId: null, expectedQty: 0, receivedQty: 1, damagedQty: 0, putawayLocationId: FLOW_IDS.locationX,
      unitCost: original.unitCost, unitCostMills: original.unitCostMills, costSourceKind: original.costSourceKind, status: "complete",
    }, tx));
    await expect(harness.receiving.close(approved.acceptance!.receivingOrderId, FLOW_ACTOR, { allowOverReceipt: true }))
      .rejects.toMatchObject({ statusCode: 409, details: { code: "PO_DIRECT_CUSTODY_SOURCE_REQUIRED" } });
    expect(await physicalState()).toEqual(before);
    await harness.receiving.updateLine(sibling.id, { receivedQty: 0, expectedUnitVersion: receivingUnitVersion(sibling) }, FLOW_ACTOR);
    await harness.receiving.close(approved.acceptance!.receivingOrderId, FLOW_ACTOR);
    const posted = await physicalState();
    expect(posted).toMatchObject({ stock_pieces: "900", po_received_pieces: "900" });
    await harness.receiving.close(approved.acceptance!.receivingOrderId, FLOW_ACTOR);
    expect(await physicalState()).toEqual(posted);
    const observations = (await harness.database.transaction(tx => readCustody(tx, source.receipt.id, FLOW_ACTOR))).observations;
    expect(observations.find(row => row.id === source.held.observation.id)).toMatchObject({ physicalHeldQty: 2, receivedQty: 0 });
    expect(observations.find(row => row.id === unknown.observation.id)).toMatchObject({ physicalHeldQty: 0, receivedQty: 1, productId: null });
  }, 90_000);

  it("does not present returned quarantine as a new arrival or accepted inventory", async () => {
    const source = await sourceWithHeldGoods(800);
    const before = await physicalState();
    await custody("return", source.held.observation.id, { expectedVersion: 0, observationQty: 2,
      reason: "Carrier collected the held cases for the supplier", evidenceReference: "controlled-return-collection" }, "controlled-custody-return");
    expect(await physicalState()).toEqual(before);
    expect((await harness.purchasing.getShipmentPoReceiveOptions(source.shipment.id)).purchaseOrders)
      .toMatchObject([{ receivedBaseQty: 800, custodyBaseQty: 200, heldBaseQty: 0, returnedBaseQty: 200,
        remainingBaseQty: 0, receivable: false, custodyReceiptIds: [source.receipt.id] }]);
    await expect(harness.purchasing.createReceiptFromShipment(source.shipment.id, FLOW_ACTOR,
      { purchaseOrderId: source.purchase.purchaseOrderId })).rejects.toMatchObject({ statusCode: 409 });
  }, 90_000);

  it("keeps pending and cancelled acceptance in custody until its normal receipt posts", async () => {
    const source = await sourceWithHeldGoods(800);
    const before = await physicalState();
    const prepared = await prepareAcceptance(source);
    expect((await harness.purchasing.getShipmentPoReceiveOptions(source.shipment.id)).purchaseOrders)
      .toMatchObject([{ receivedBaseQty: 800, custodyBaseQty: 200, heldBaseQty: 200, remainingBaseQty: 0,
        action: "open_existing_receipt", existingReceiptId: prepared.acceptance!.receivingOrderId }]);
    await custody("cancel-acceptance", source.held.observation.id, { expectedVersion: 1, acceptanceId: prepared.acceptance!.id,
      reason: "Inspection needs another review" }, "controlled-custody-cancel");
    expect(await physicalState()).toEqual(before);
    expect((await harness.purchasing.getShipmentPoReceiveOptions(source.shipment.id)).purchaseOrders)
      .toMatchObject([{ receivedBaseQty: 800, custodyBaseQty: 200, heldBaseQty: 200, remainingBaseQty: 0 }]);
    await historicalOrdinaryLine(prepared.acceptance!.receivingOrderId, source);
    await expect(harness.receiving.close(prepared.acceptance!.receivingOrderId, FLOW_ACTOR, { allowOverReceipt: true }))
      .rejects.toMatchObject({ statusCode: 409, details: { code: "SHIPMENT_RECEIPT_COVERAGE_REVIEW_REQUIRED" } });
    expect(await physicalState()).toEqual(before);
  }, 90_000);

  it("preserves exact accepted-receipt reversal coverage without releasing held custody", async () => {
    const source = await sourceWithHeldGoods(800);
    const before = await harness.database.transaction(tx => readCustody(tx, source.receipt.id, FLOW_ACTOR));
    const { ReceiptReversalService } = await import("../../receipt-reversal.service");
    const reversal = new ReceiptReversalService(harness.database, harness.inventory);
    const body = { receivingLineId: source.line.id, qty: 1, reason: "Correct one accepted case count",
      idempotencyKey: "controlled-custody-reversal", userId: FLOW_ACTOR };
    expect(await reversal.reverseReceivingLine(body)).toMatchObject({ baseUnitsReversed: 100, idempotentReplay: false });
    expect(await reversal.reverseReceivingLine(body)).toMatchObject({ baseUnitsReversed: 100, idempotentReplay: true });
    expect(await harness.database.transaction(tx => readCustody(tx, source.receipt.id, FLOW_ACTOR))).toEqual(before);
    expect((await harness.purchasing.getShipmentPoReceiveOptions(source.shipment.id)).purchaseOrders)
      .toMatchObject([{ receivedBaseQty: 700, custodyBaseQty: 200, heldBaseQty: 200, remainingBaseQty: 100, receivable: true }]);
  }, 90_000);

  it("keeps a concurrent ordinary handoff inside the approved acceptance receipt without duplicating stock", async () => {
    const source = await sourceWithHeldGoods(800);
    const prepared = await prepareAcceptance(source);
    const results = await Promise.allSettled([
      harness.purchasing.createReceiptFromShipment(source.shipment.id, FLOW_ACTOR, { purchaseOrderId: source.purchase.purchaseOrderId }),
      harness.receiving.close(prepared.acceptance!.receivingOrderId, FLOW_ACTOR),
    ]);
    if (results[0].status === "fulfilled") expect(results[0].value).toMatchObject({ id: prepared.acceptance!.receivingOrderId, reusedExisting: true });
    else expect(results[0].reason).toMatchObject({ statusCode: 409 });
    expect(results[1]).toMatchObject({ status: "fulfilled" });
    expect((await harness.pool.query("SELECT COUNT(*)::int AS count FROM procurement.receiving_orders")).rows).toEqual([{ count: 2 }]);
    expect(await physicalState()).toMatchObject({ stock_pieces: "1000", po_received_pieces: "1000" });
    expect((await harness.database.transaction(tx => readCustody(tx, source.receipt.id, FLOW_ACTOR))).observations)
      .toMatchObject([{ physicalHeldQty: 0, receivedQty: 2 }]);
  }, 90_000);
});
