import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { defaultPurchasePlanningPolicy } from "@shared/procurement/purchase-planning-policy";
import { rfqConversionResultSchema, type RfqConvert, type RfqQuoteEvidence } from "@shared/procurement/rfq-workflow";
import type { PurchasingRecommendationRawRow } from "../../purchasing-recommendation.engine";
import { PurchasePlanningPolicyRepository } from "../../purchase-planning-policy.repository";
import { PurchasePlanningPolicyService } from "../../purchase-planning-policy.service";
import { readPurchaseRfqOrigins } from "../../purchase-rfq-origin.repository";
import { lockAndLoadActiveRfqAllocations } from "../../purchasing-rfq.service";
import { createControlledRfqDatabase } from "./rfq-controlled-acceptance-database";
import { captureControlledRfqQuote, createControlledRfqProposal, prepareControlledRfqConversion } from "./rfq-controlled-acceptance-helper";

const url = process.env.ECHELON_TEST_DATABASE_URL;
const suite = url && process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true" ? describe : describe.skip;
const AT = new Date("2026-09-10T12:00:00.000Z");
const ACTOR = "controlled-rfq-operator";

suite.sequential("controlled planning → RFQ → quote revision → separate real purchase orders", () => {
  let fixture: Awaited<ReturnType<typeof createControlledRfqDatabase>> | undefined;

  beforeAll(async () => {
    fixture = await createControlledRfqDatabase(url!, AT);
    // Only external starting observations/catalog are seeded. There are no
    // recommendation/RFQ/quote/PO inserts: their owners create the whole chain.
    await fixture.pool.query(`
      INSERT INTO catalog.products(id,sku,name) VALUES
        (100,'CONTROLLED-A','Controlled product A'),(101,'CONTROLLED-B','Controlled product B');
      INSERT INTO catalog.product_variants(id,product_id,sku,name,units_per_variant,uom_type,is_base_unit,hierarchy_level) VALUES
        (200,100,'CONTROLLED-A-C50','Case of 50',50,'case',false,2),
        (202,101,'CONTROLLED-B-C50','Case of 50',50,'case',false,2);
      INSERT INTO warehouse.warehouses(id,code,name) VALUES(1,'CONTROLLED','Controlled warehouse');
      INSERT INTO procurement.vendors(id,code,name,currency,default_lead_time_days) VALUES(5,'CONTROLLED','Controlled supplier','USD',30);
      INSERT INTO procurement.vendor_products(id,vendor_id,product_id,product_variant_id,is_preferred,moq,pack_size) VALUES
        (300,5,100,200,1,50,50),(301,5,101,202,1,50,50);
    `);
  });
  afterAll(async () => { await fixture?.close(); });

  it("preserves the saved growth decision, requested pieces, revised quote, exact PO costs and replay evidence across the complete owner chain", async () => {
    const { database, pool, purchasingOwner } = fixture!;
    const planning = new PurchasePlanningPolicyService(new PurchasePlanningPolicyRepository(pool), () => AT);
    const originalPolicy = await planning.read();
    expect(originalPolicy).toEqual({ revision: 0, policy: defaultPurchasePlanningPolicy() });
    await planning.update({ expectedRevision: 0, idempotencyKey: "controlled-growth-50",
      policy: { ...originalPolicy.policy, growthPercent: 50 } }, ACTOR);
    const savedPolicy = await planning.read();
    expect(savedPolicy.revision).toBe(1);

    // Explicit synthetic historical observations: 25/day and 10/day, 40-day
    // cover, +50% growth. Targets are 1500/600, less available 500/100.
    const rows: PurchasingRecommendationRawRow[] = [
      { product_id: 100, variant_id: 200, base_sku: "CONTROLLED-A", product_name: "Controlled product A",
        total_pieces: 500, total_outbound_pieces: 750, previous_outbound_pieces: 750 },
      { product_id: 101, variant_id: 202, base_sku: "CONTROLLED-B", product_name: "Controlled product B",
        total_pieces: 100, total_outbound_pieces: 300, previous_outbound_pieces: 300 },
    ].map((row) => ({ ...row, lead_time_days: 30, safety_stock_days: 10,
      on_order_pieces: 0, inbound_schedule: [], receipt_supply_evidence: { version: 1, lines: [] },
      receive_variant_selection: { version: 1, highestHierarchyLevel: 2, candidateCount: 1, selectedVariantId: row.variant_id },
      recommendation_analysis_date: "2026-09-10", latest_demand_at: AT.toISOString(),
      demand_order_count: 30, demand_active_days: 30,
      forward_demand_contributions: [], forward_demand_planning_as_of_date: "2026-09-10", forward_demand_horizon_days: 90,
    }));
    const proposal = await createControlledRfqProposal({ database, purchasingOwner, actorId: ACTOR,
      at: AT, key: "controlled-rfq", lookbackDays: 30, rows,
      settings: { planningPolicy: savedPolicy.policy, planningPolicyRevision: savedPolicy.revision, autoDraftMode: "review_only" },
    });
    const recommendations = [...proposal.recommendations.items, ...proposal.recommendations.skippedItems]
      .sort((left, right) => left.productId - right.productId);
    expect(recommendations.map((item) => ({ productId: item.productId, pieces: item.suggestedOrderPieces,
      basis: item.planningBasis }))).toMatchObject([
      { productId: 100, pieces: 1000, basis: { policyRevision: 1, growthPercent: 50, historicalDailyPieces: 25,
        adjustedDailyPieces: 37.5, targetCoverDays: 40, targetStockPieces: 1500 } },
      { productId: 101, pieces: 500, basis: { policyRevision: 1, growthPercent: 50, historicalDailyPieces: 10,
        adjustedDailyPieces: 15, targetCoverDays: 40, targetStockPieces: 600 } },
    ]);
    expect(proposal.snapshot.run.policySnapshot).toMatchObject({ planningPolicyRevision: 1, planningPolicy: { growthPercent: 50 } });
    expect(proposal.snapshot.observations).toHaveLength(2);
    expect(proposal.snapshot.observations).toEqual(expect.arrayContaining([
      expect.objectContaining({ productId: 100, forecastDailyPiecesMicros: 37_500_000, baselineDailyPiecesMicros: 25_000_000,
        forecastPolicySnapshot: expect.objectContaining({ growthPercent: 50 }), overlayCaptureComplete: true }),
      expect.objectContaining({ productId: 101, forecastDailyPiecesMicros: 15_000_000, baselineDailyPiecesMicros: 10_000_000 }),
    ]));
    expect((await pool.query("SELECT count(*)::int AS count FROM procurement.purchase_orders")).rows[0].count).toBe(0);
    const replayedRequest = await purchasingOwner.createRfqBatch(proposal.request, ACTOR);
    expect(replayedRequest.reused).toBe(true);
    expect(replayedRequest.rfqs.map((rfq) => rfq.id)).toEqual([proposal.rfqId]);
    expect((await pool.query("SELECT count(*)::int AS count FROM procurement.request_for_quotes")).rows[0].count).toBe(1);
    const pendingBefore = await database.transaction((tx) => lockAndLoadActiveRfqAllocations(tx, proposal.snapshot.lines));
    expect(pendingBefore).toEqual(new Map([["100:all", 1000], ["101:all", 500]]));
    const initial = await proposal.workflow.getDetail(proposal.rfqId);
    expect(initial.lines.map((line) => [line.productId, line.requestedPieces]).sort()).toEqual([[100, 1000], [101, 500]]);
    expect(initial.lines.every((line) => line.latestQuote === null && line.purchaseOrder === null)).toBe(true);
    const originalEvidence = (await pool.query("SELECT policy_snapshot FROM procurement.purchase_recommendation_runs WHERE id=$1", [proposal.snapshot.run.id])).rows[0];
    await planning.update({ expectedRevision: 1, idempotencyKey: "controlled-growth-25", policy: { ...savedPolicy.policy, growthPercent: 25 } }, ACTOR);
    expect((await planning.read()).policy.growthPercent).toBe(25);
    expect((await pool.query("SELECT policy_snapshot FROM procurement.purchase_recommendation_runs WHERE id=$1", [proposal.snapshot.run.id])).rows[0]).toEqual(originalEvidence);

    const quoteA: RfqQuoteEvidence = { pricing: { basis: "extended_total", quantityPieces: 1000, quotedTotalCents: 20000 },
      packagingTreatment: "separate", packagingCostCents: 1800, quoteReference: "CONTROLLED-QUOTE-A-1",
      quoteValidUntil: "2026-09-30", quotedAt: AT.toISOString(), leadTimeDays: 30, reason: "Synthetic final vendor quote" };
    const firstCapture = await captureControlledRfqQuote(proposal, 100, quoteA, "capture-a-1");
    expect(firstCapture.result.httpStatus, JSON.stringify(firstCapture.result.body)).toBe(200);
    expect(await proposal.commands.execute(firstCapture.command, ACTOR, firstCapture.identity)).toMatchObject({
      replayed: true, body: firstCapture.result.body,
    });
    const staleVersion = await prepareControlledRfqConversion(proposal, [100], null, "stale-version");
    const revised = await captureControlledRfqQuote(proposal, 100, { ...quoteA,
      pricing: { basis: "extended_total", quantityPieces: 1200, quotedTotalCents: 24000 },
      quoteReference: "CONTROLLED-QUOTE-A-2", reason: "Supplier confirmed 24 cases instead of the requested 20" }, "capture-a-2");
    expect(revised.result.httpStatus, JSON.stringify(revised.result.body)).toBe(200);
    expect((await proposal.commands.execute(staleVersion.command, ACTOR, staleVersion.identity)).body).toMatchObject({ code: "RFQ_VERSION_CONFLICT" });
    const beforeB = await proposal.workflow.getDetail(proposal.rfqId);
    const lineA = beforeB.lines.find((line) => line.productId === 100)!;
    const history = await proposal.workflow.getQuoteHistory(proposal.rfqId, lineA.id, null);
    expect(history.revisions.map((quote) => [quote.revision, quote.quotedPieces])).toEqual([[2, 1200], [1, 1000]]);
    expect(history.revisions[1].quote).toEqual(quoteA);

    const staleQuote = await prepareControlledRfqConversion(proposal, [100], "Review latest quote", "stale-quote");
    const staleQuoteCommand = { ...staleQuote.command, body: { ...(staleQuote.command.body as RfqConvert),
      lines: [{ rfqLineId: lineA.id, quoteRevisionId: history.revisions[1].id }] } };
    expect((await proposal.commands.execute(staleQuoteCommand, ACTOR,
      proposal.descriptor(staleQuoteCommand, "stale-quote-request"))).body).toMatchObject({ code: "RFQ_QUOTE_CHANGED" });
    const missingReason = await prepareControlledRfqConversion(proposal, [100], null, "missing-quantity-reason");
    expect((await proposal.commands.execute(missingReason.command, ACTOR, missingReason.identity)).body)
      .toMatchObject({ code: "RFQ_QUANTITY_OVERRIDE_REQUIRED" });
    expect((await pool.query("SELECT count(*)::int AS count FROM procurement.purchase_orders")).rows[0].count).toBe(0);

    // An explicitly recorded zero packaging charge is valid. UOM pricing must
    // survive as 10 cases x 50 pieces, not become 10 pieces or an invented price.
    const quoteB: RfqQuoteEvidence = { ...quoteA, pricing: { basis: "per_purchase_uom", purchaseUom: "case",
      uomQuantity: 10, piecesPerUom: 50, quotedCostMillsPerUom: 120000 }, packagingCostCents: 0, quoteReference: "CONTROLLED-QUOTE-B-1" };
    const capturedB = await captureControlledRfqQuote(proposal, 101, quoteB, "capture-b-1");
    expect(capturedB.result.httpStatus, JSON.stringify(capturedB.result.body)).toBe(200);
    const acceptedA = await prepareControlledRfqConversion(proposal, [100],
      "Supplier confirmed 24 cases instead of the original 20; operator accepted the extra 200 pieces", "convert-a");
    const resultA = await proposal.commands.execute(acceptedA.command, ACTOR, acceptedA.identity);
    expect(resultA.httpStatus, JSON.stringify(resultA.body)).toBe(201);
    const poA = rfqConversionResultSchema.parse(resultA.body);
    const afterA = await proposal.workflow.getDetail(proposal.rfqId);
    expect(afterA.lines.find((line) => line.productId === 100)?.purchaseOrder?.purchaseOrderId).toBe(poA.purchaseOrderId);
    expect(afterA.lines.find((line) => line.productId === 101)?.purchaseOrder).toBeNull();
    const acceptedB = await prepareControlledRfqConversion(proposal, [101], null, "convert-b");
    const resultB = await proposal.commands.execute(acceptedB.command, ACTOR, acceptedB.identity);
    expect(resultB.httpStatus, JSON.stringify(resultB.body)).toBe(201);
    const poB = rfqConversionResultSchema.parse(resultB.body);
    expect(poB.purchaseOrderId).not.toBe(poA.purchaseOrderId);
    expect(await proposal.commands.execute(acceptedA.command, ACTOR, acceptedA.identity)).toMatchObject({ replayed: true, body: resultA.body });
    expect(await proposal.commands.execute(acceptedB.command, ACTOR, acceptedB.identity)).toMatchObject({ replayed: true, body: resultB.body });

    const lines = (await pool.query(`SELECT product_id, order_qty, pricing_basis, total_product_cost_cents,
      packaging_cost_cents, line_total_cents, expected_receive_variant_id, expected_receive_units_per_variant
      FROM procurement.purchase_order_lines ORDER BY product_id`)).rows;
    expect(lines).toEqual([
      { product_id: 100, order_qty: 1200, pricing_basis: "extended_total", total_product_cost_cents: "24000",
        packaging_cost_cents: "1800", line_total_cents: "25800", expected_receive_variant_id: 200, expected_receive_units_per_variant: 50 },
      { product_id: 101, order_qty: 500, pricing_basis: "per_purchase_uom", total_product_cost_cents: "12000",
        packaging_cost_cents: "0", line_total_cents: "12000", expected_receive_variant_id: 202, expected_receive_units_per_variant: 50 },
    ]);
    for (const purchase of [poA, poB]) {
      const origins = await database.transaction((tx) => readPurchaseRfqOrigins(tx, purchase.purchaseOrderId));
      expect(origins).toHaveLength(1);
      expect(origins[0]).toMatchObject({ rfqId: proposal.rfqId, rfqLineId: purchase.lines[0].rfqLineId,
        quoteRevisionId: purchase.lines[0].quoteRevisionId, purchaseOrderLineId: purchase.lines[0].purchaseOrderLineId });
      expect((await pool.query("SELECT event_type FROM procurement.po_events WHERE po_id=$1 ORDER BY id", [purchase.purchaseOrderId])).rows)
        .toEqual([{ event_type: "created" }, { event_type: "rfq_converted" }]);
    }
    const pendingAfter = await database.transaction((tx) => lockAndLoadActiveRfqAllocations(tx, proposal.snapshot.lines));
    expect(pendingAfter).toEqual(new Map([["100:all", 1200], ["101:all", 500]]));
    expect((await proposal.workflow.getDetail(proposal.rfqId)).lines.map((line) => [line.productId, line.requestedPieces]).sort())
      .toEqual([[100, 1000], [101, 500]]);
    expect((await pool.query("SELECT status,sent_to_vendor_at FROM procurement.purchase_orders ORDER BY id")).rows)
      .toEqual([{ status: "draft", sent_to_vendor_at: null }, { status: "draft", sent_to_vendor_at: null }]);
    expect((await pool.query("SELECT sent_at FROM procurement.request_for_quotes WHERE id=$1", [proposal.rfqId])).rows[0].sent_at).toBeNull();
    expect((await pool.query("SELECT count(*)::int AS count FROM procurement.rfq_quote_revisions")).rows[0].count).toBe(3);
    expect((await pool.query("SELECT count(*)::int AS count FROM procurement.rfq_purchase_order_line_links")).rows[0].count).toBe(2);
    const audits = (await pool.query("SELECT action FROM public.audit_events WHERE action LIKE 'purchase_rfq.%' ORDER BY id")).rows;
    expect(audits.filter((row) => row.action === "purchase_rfq.quote_captured")).toHaveLength(3);
    expect(audits.filter((row) => row.action === "purchase_rfq.converted_to_draft_po")).toHaveLength(2);
    expect((await planning.history()).map((entry) => ({ revision: entry.revision, actorId: entry.actorId, growth: entry.after.growthPercent })))
      .toEqual([{ revision: 2, actorId: ACTOR, growth: 25 }, { revision: 1, actorId: ACTOR, growth: 50 }]);
  });
});
