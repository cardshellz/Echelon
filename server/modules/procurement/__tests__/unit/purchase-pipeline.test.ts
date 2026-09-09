import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalJson } from "@shared/utils/canonical-json";
import { formatPipelineMills, supplierProgressCommandSchema } from "@shared/procurement/purchase-pipeline";
import { pipelineIntervalMills, projectPurchasePipeline } from "../../purchase-pipeline.service";
import { pipelineEvidence, pipelineLine, pipelinePartialReceipt, pipelineShipment, pipelineTime } from "../../../../../test/fixtures/purchase-pipeline";

describe("purchase pipeline quantity and cost evidence", () => {
  it("uses actual remaining base pieces and reports production without overlapping partial shipments/receipts", () => {
    const result = projectPurchasePipeline(pipelinePartialReceipt(), pipelineTime, 90);
    expect(result.rows.map((row) => [row.stage, row.quantityPieces])).toEqual([["in_transit", 40], ["ready_to_ship", 10], ["in_production", 30]]);
    expect(result.rows.reduce((sum, row) => sum + row.quantityPieces!, 0)).toBe(80);
    expect(result.totals.reduce((sum, total) => sum + BigInt(total.estimatedMills), BigInt(0))).toBe(BigInt(880000));
    expect(result.issues[0]).toContain("20 physically received pieces are awaiting PO reconciliation");
    expect(result.rows[0]).toMatchObject({ shipmentId: 7, shipmentLineId: 111, arrivalSource: "shipment_eta", arrivalDestination: "shipment_destination" });
  });
  it("retains correct remaining ready quantity when all production was completed before partial dispatch", () => {
    const data = pipelinePartialReceipt(); data.lines[0].progress.report!.completedPieces = 100;
    expect(projectPurchasePipeline(data, pipelineTime, 90).rows.map((row) => [row.stage, row.quantityPieces])).toEqual([["in_transit", 40], ["ready_to_ship", 40]]);
  });
  it("does not assume acknowledged orders are in production or transit", () => {
    const data = pipelineEvidence(); data.shipments.push(pipelineShipment({ status: "booked", quantity: 100 }));
    const row = projectPurchasePipeline(data, pipelineTime, 90).rows[0];
    expect(row).toMatchObject({ stage: "supplier_unconfirmed", quantityPieces: 100, shipmentId: null });
    expect(row.issues[0]).toContain("Production has not been reported");
  });
  it("keeps dated historical supplier reports visible without claiming their age is a supplier SLA", () => {
    const data = pipelinePartialReceipt(); data.lines[0].progress.report!.asOf = "2026-01-01T12:00:00.000Z";
    expect(projectPurchasePipeline(data, pipelineTime, 90).rows.some((row) => row.stage === "in_production")).toBe(true);
  });
  it.each(["cancelled", "draft", "pending_approval", "closed", "received"])("excludes %s purchase orders", (poStatus) => {
    const data = pipelineEvidence(); data.lines[0].poStatus = poStatus;
    expect(projectPurchasePipeline(data, pipelineTime, 90).rows).toEqual([]);
  });
  it("subtracts frozen receipts instead of current catalog packs and excludes fully received quantities", () => {
    const data = pipelinePartialReceipt(); data.receipts[0].received = 10; data.shipments[0].quantity = 100;
    expect(projectPurchasePipeline(data, pipelineTime, 90).rows).toEqual([]);
  });
  it("requires receipt evidence when PO tallies are ahead and never silently calls the remainder accurate", () => {
    const data = pipelineEvidence(); data.lines[0].received = 10;
    expect(projectPurchasePipeline(data, pipelineTime, 90).rows[0]).toMatchObject({ quantityPieces: null, remainingPieces: null, stage: "review" });
  });
  it("does not let newly unposted physical receipts conceal missing old posted history", () => {
    const data = pipelinePartialReceipt(); data.lines[0].received = 10;
    expect(projectPurchasePipeline(data, pipelineTime, 90).rows[0]).toMatchObject({ stage: "review", quantityPieces: null, remainingPieces: null });
  });
  it("uses exact original postings for a legacy receipt and requires complete reversal evidence", () => {
    const data = pipelinePartialReceipt(); data.receipts[0].units = null; data.receipts[0].shipmentLineId = null;
    data.postings.push({ receivingLineId: 31, receivingOrderId: 3, purchaseOrderId: 1, purchaseOrderLineId: 11, qtyReceived: 20 });
    data.lines[0].received = 20; // PO posting and mirror commit together.
    expect(projectPurchasePipeline(data, pipelineTime, 90).rows[0].quantityPieces).toBe(40);
    data.receipts[0].reversed = 1;
    expect(projectPurchasePipeline(data, pipelineTime, 90).rows[0].quantityPieces).toBeNull();
    data.reversals.push({ id: 1, receivingLineId: 31, receivingOrderId: 3, qty: 1, baseUnitsReversed: 10 });
    data.lines[0].received = 10; // Physical reversal updates the mirror atomically.
    expect(projectPurchasePipeline(data, pipelineTime, 90).rows[0]).toMatchObject({ receivedPieces: 10, quantityPieces: 50 });
  });
  it("does not spread an ambiguous historical receipt across two shipment lines", () => {
    const data = pipelinePartialReceipt(); data.receipts[0].shipmentLineId = null;
    data.postings.push({ receivingLineId: 31, receivingOrderId: 3, purchaseOrderId: 1, purchaseOrderLineId: 11, qtyReceived: 20 });
    data.shipments.push(pipelineShipment({ id: 112, quantity: 40 }));
    expect(projectPurchasePipeline(data, pipelineTime, 90).rows[0]).toMatchObject({ stage: "review", quantityPieces: null });
  });
  it("handles one PO across shipments and one shipment across POs without repeating shared quantity or costs", () => {
    const data = pipelineEvidence(); data.lines.push(pipelineLine({ id: 22, purchaseOrderId: 2, poNumber: "TEST-PO-2", ordered: 50 }));
    data.shipments.push(pipelineShipment(), pipelineShipment({ id: 112, shipmentId: 8, quantity: 40 }), pipelineShipment({ id: 222, purchaseOrderId: 2, purchaseOrderLineId: 22, quantity: 50 }));
    const rows = projectPurchasePipeline(data, pipelineTime, 90).rows;
    expect(rows.map((row) => [row.purchaseOrderLineId, row.shipmentId, row.quantityPieces])).toEqual([[11, 7, 60], [11, 8, 40], [22, 7, 50]]);
  });
  it.each(["in_transit", "booked"])("flags overlapping %s shipment coverage rather than truncating or double-counting", (status) => {
    const data = pipelineEvidence(); data.shipments.push(pipelineShipment({ status, quantity: 101 }));
    expect(projectPurchasePipeline(data, pipelineTime, 90).rows).toMatchObject([{ stage: "review", quantityPieces: 100 }]);
  });
  it("does not allocate missing shipment links by SKU", () => {
    const data = pipelineEvidence(); data.shipments.push(pipelineShipment({ purchaseOrderLineId: null }));
    const result = projectPurchasePipeline(data, pipelineTime, 90);
    expect(result.rows).toMatchObject([{ stage: "review", quantityPieces: 100 }]);
    expect(result.issues[0]).toContain("not added by SKU");
  });
  it("makes contradictory progress reviewable without erasing proven transit", () => {
    const data = pipelinePartialReceipt(); data.lines[0].progress.report!.completedPieces = 10;
    const result = projectPurchasePipeline(data, pipelineTime, 90);
    expect(result.rows.map((row) => [row.stage, row.quantityPieces])).toEqual([["in_transit", 40], ["supplier_unconfirmed", 40]]);
    expect(result.rows[1].issues[0]).toContain("progress conflicts");
  });
  it("separates known, unknown, overdue, later and 30/90 day arrival evidence", () => {
    const data = pipelineEvidence();
    expect(projectPurchasePipeline(data, pipelineTime, 30).rows[0].arrivalBucket).toBe("later");
    expect(projectPurchasePipeline(data, pipelineTime, 90).rows[0].arrivalBucket).toBe("within_horizon");
    data.lines[0].expectedDate = null;
    expect(projectPurchasePipeline(data, pipelineTime, 90).rows[0].arrivalBucket).toBe("unknown");
    data.lines[0].promisedDate = "2026-09-06T12:00:00.000Z";
    expect(projectPurchasePipeline(data, pipelineTime, 90).rows[0]).toMatchObject({ arrivalBucket: "overdue", arrivalSource: "line_promised" });
  });
  it("keeps currencies separate and preserves exact quoted totals beyond Number precision", () => {
    const data = pipelineEvidence(); data.lines[0].quotedUnitMills = "9007199254740991";
    data.lines.push(pipelineLine({ id: 22, purchaseOrderId: 2, currency: "EUR" }), pipelineLine({ id: 33, purchaseOrderId: 3, currency: null }));
    const result = projectPurchasePipeline(data, pipelineTime, 90);
    expect(result.totals.map((row) => row.currency)).toEqual(["USD", "EUR", null]);
    expect(result.rows[0].costs[0].amountMills).toBe("900719925474099100");
    expect(result.rows[2].costs.every((cost) => cost.amountMills === null)).toBe(true);
    expect(formatPipelineMills("900719925474099100", "USD")).toBe("90,071,992,547,409.9100 USD");
  });
  it("uses exact purchase-unit quote extensions and never normalized rounded base-piece costs", () => {
    const data = pipelineEvidence(); Object.assign(data.lines[0], { ordered: 300, pricingBasis: "per_purchase_uom", quotedUnitMills: "100", purchaseUomQuantity: 100, piecesPerPurchaseUom: 3 });
    expect(projectPurchasePipeline(data, pipelineTime, 90).rows[0].costs[0].amountMills).toBe("10000");
  });
  it("uses fingerprint-verified confirmed component revisions while keeping other components estimated", () => {
    const data = pipelineEvidence(); Object.assign(data.lines[0], { pricingBasis: "legacy_unknown", quotedUnitMills: null }); const sourceEvidence = { invoice: "synthetic" };
    const input = { contractVersion: 1, component: "product", scope: { kind: "purchase_order_line", purchaseOrderId: 1, purchaseOrderLineId: 11 }, sources: [{ kind: "vendor_invoice_line", documentId: 8, lineId: 9, version: "a".repeat(64) }], currency: "USD", totalMills: 700000, basePieces: 100, evidence: "confirmed", packagingTreatment: "separate", issue: null, manualOverride: null };
    const fingerprint = createHash("sha256").update(canonicalJson({ input, sourceEvidence })).digest("hex");
    data.revisions.push({ id: 44, purchaseOrderLineId: 11, shipmentLineId: null, component: "product", revision: 1, fingerprint, contract: { ...input, revision: 1, fingerprint }, sourceEvidence, recordedAt: pipelineTime.toISOString() });
    expect(projectPurchasePipeline(data, pipelineTime, 90).rows[0].costs).toMatchObject([{ evidence: "confirmed", amountMills: "700000", sourceRevisionId: 44 }, { evidence: "estimated" }, { evidence: "unknown" }]);
    data.revisions[0].sourceEvidence = { tampered: true };
    expect(projectPurchasePipeline(data, pipelineTime, 90).rows[0].costs[0]).toMatchObject({ evidence: "review_required", amountMills: null });
  });
  it("uses existing legacy PO component totals without inventing a quote basis or multiplying a rounded unit price", () => {
    const data = pipelineEvidence();
    Object.assign(data.lines[0], { pricingBasis: "legacy_unknown", quotedUnitMills: null, productCents: "12345678", packagingCents: "321", ordered: 400000, quoteReference: null });
    const before = JSON.stringify(data);
    const result = projectPurchasePipeline(data, pipelineTime, 90);
    expect(result.rows[0].costs).toEqual([
      { component: "product", amountMills: "1234567800", evidence: "estimated", source: "purchase_order", sourceRevisionId: null, recordedAt: null, reference: "TEST-PO-1" },
      { component: "packaging", amountMills: "32100", evidence: "estimated", source: "purchase_order", sourceRevisionId: null, recordedAt: null, reference: "TEST-PO-1" },
      { component: "landed", amountMills: null, evidence: "unknown", source: "missing", sourceRevisionId: null, recordedAt: null, reference: null },
    ]);
    expect(result.totals[0]).toMatchObject({ estimatedMills: "1234599900", unknownComponentCount: 1 });
    expect(JSON.stringify(data)).toBe(before);
  });
  it("allocates saved PO totals once across physical receipts and split stages", () => {
    const data = pipelinePartialReceipt();
    Object.assign(data.lines[0], { pricingBasis: "legacy_unknown", quotedUnitMills: null, productCents: "98765", packagingCents: "1234" });
    const rows = projectPurchasePipeline(data, pipelineTime, 90).rows;
    expect(rows.map((row) => row.quantityPieces)).toEqual([40, 10, 30]);
    expect(rows.reduce((sum, row) => sum + BigInt(row.costs[0].amountMills!), BigInt(0))).toBe(BigInt(7901200));
    expect(rows.reduce((sum, row) => sum + BigInt(row.costs[1].amountMills!), BigInt(0))).toBe(BigInt(98720));
    data.lines[0].cancelled = 10;
    data.lines[0].progress.report = null;
    const afterCancellation = projectPurchasePipeline(data, pipelineTime, 90);
    expect(afterCancellation.rows.map((row) => row.quantityPieces)).toEqual([40, 30]);
    expect(afterCancellation.totals.reduce((sum, total) => sum + BigInt(total.estimatedMills), BigInt(0))).toBe(BigInt(6999930));
  });
  it("retains exact residual cents across split shipments for a legacy total", () => {
    const data = pipelineEvidence();
    Object.assign(data.lines[0], { ordered: 3, pricingBasis: "legacy_unknown", quotedUnitMills: null, productCents: "1", packagingCents: "2" });
    data.shipments.push(...[1, 2, 3].map((id) => pipelineShipment({ id, shipmentId: id, quantity: 1 })));
    const rows = projectPurchasePipeline(data, pipelineTime, 90).rows;
    expect(rows.map((row) => row.costs[0].amountMills)).toEqual(["33", "33", "34"]);
    expect(rows.map((row) => row.costs[1].amountMills)).toEqual(["66", "67", "67"]);
    expect(projectPurchasePipeline(data, pipelineTime, 90).totals[0].estimatedMills).toBe("300");
  });
  it.each([
    { productCents: "0", packagingCents: "0", productMills: null, packagingMills: null },
    { productCents: "100", packagingCents: "0", productMills: "10000", packagingMills: null },
    { productCents: "0", packagingCents: "100", productMills: null, packagingMills: "10000" },
    { productCents: null, packagingCents: "100", productMills: null, packagingMills: "10000" },
    { productCents: "100", packagingCents: null, productMills: "10000", packagingMills: null },
    { productCents: "-1", packagingCents: "-2", productMills: null, packagingMills: null },
    { productCents: "9007199254740993", packagingCents: "1", productMills: "900719925474099300", packagingMills: "100" },
  ])("keeps saved component amounts independent and exact: %j", ({ productCents, packagingCents, productMills, packagingMills }) => {
    const data = pipelineEvidence();
    Object.assign(data.lines[0], { pricingBasis: "legacy_unknown", quotedUnitMills: null, productCents, packagingCents });
    const [product, packaging] = projectPurchasePipeline(data, pipelineTime, 90).rows[0].costs;
    expect(product.amountMills).toBe(productMills);
    expect(packaging.amountMills).toBe(packagingMills);
    expect(product.evidence).toBe(productMills === null ? "unknown" : "estimated");
    expect(packaging.evidence).toBe(packagingMills === null ? "unknown" : "estimated");
  });
  it("distinguishes a legacy default zero from explicit zero product and packaging quotes", () => {
    const data = pipelineEvidence();
    Object.assign(data.lines[0], { quotedUnitMills: "0", productCents: "0", packagingCents: "0" });
    const [product, packaging] = projectPurchasePipeline(data, pipelineTime, 90).rows[0].costs;
    expect(product).toMatchObject({ amountMills: "0", evidence: "estimated", source: "purchase_quote" });
    expect(packaging).toMatchObject({ amountMills: "0", evidence: "estimated", source: "purchase_order" });
    data.lines[0].quotedUnitMills = null;
    expect(projectPurchasePipeline(data, pipelineTime, 90).rows[0].costs.slice(0, 2).every((cost) => cost.amountMills === null)).toBe(true);
  });
  it("honors verified zero component revisions even when legacy PO zeros cannot establish the amount", () => {
    const data = pipelineEvidence();
    Object.assign(data.lines[0], { pricingBasis: "legacy_unknown", quotedUnitMills: null, productCents: "0", packagingCents: "0" });
    for (const [index, component] of (["product", "packaging"] as const).entries()) {
      const input = { contractVersion: 1, component, scope: { kind: "purchase_order_line", purchaseOrderId: 1, purchaseOrderLineId: 11 }, sources: [{ kind: "vendor_invoice_line", documentId: 8, lineId: 9, version: "a".repeat(64) }], currency: "USD", totalMills: 0, basePieces: 100, evidence: "confirmed", packagingTreatment: "separate", issue: null, manualOverride: null };
      const sourceEvidence = { invoice: "synthetic zero component" };
      const fingerprint = createHash("sha256").update(canonicalJson({ input, sourceEvidence })).digest("hex");
      data.revisions.push({ id: 44 + index, purchaseOrderLineId: 11, shipmentLineId: null, component, revision: 1, fingerprint, contract: { ...input, revision: 1, fingerprint }, sourceEvidence, recordedAt: pipelineTime.toISOString() });
    }
    expect(projectPurchasePipeline(data, pipelineTime, 90).rows[0].costs.slice(0, 2)).toMatchObject([
      { amountMills: "0", evidence: "confirmed", source: "recorded_revision" },
      { amountMills: "0", evidence: "confirmed", source: "recorded_revision" },
    ]);
  });
  it("preserves exact explicit quote precedence and never replaces an incomplete explicit quote with a legacy estimate", () => {
    const data = pipelineEvidence();
    Object.assign(data.lines[0], { pricingBasis: "per_purchase_uom", ordered: 3, purchaseUomQuantity: 1, piecesPerPurchaseUom: 3, quotedUnitMills: "10001", productCents: "100" });
    expect(projectPurchasePipeline(data, pipelineTime, 90).rows[0].costs[0]).toMatchObject({ amountMills: "10001", source: "purchase_quote" });
    data.lines[0].piecesPerPurchaseUom = 2;
    expect(projectPurchasePipeline(data, pipelineTime, 90).rows[0].costs[0]).toMatchObject({ amountMills: null, evidence: "unknown" });
    expect(projectPurchasePipeline(data, pipelineTime, 90).rows[0].costs[1]).toMatchObject({ amountMills: "100000", source: "purchase_order" });
  });
  it("never extrapolates saved PO totals across an unproven receipt quantity", () => {
    const data = pipelineEvidence();
    Object.assign(data.lines[0], { pricingBasis: "legacy_unknown", quotedUnitMills: null, received: 10, productCents: "10000" });
    const row = projectPurchasePipeline(data, pipelineTime, 90).rows[0];
    expect(row.quantityPieces).toBeNull();
    expect(row.costs.every((cost) => cost.amountMills === null && cost.evidence === "review_required")).toBe(true);
  });
  it("rejects invalid saved monetary values before allocation", () => {
    const data = pipelineEvidence();
    Object.assign(data.lines[0], { pricingBasis: "legacy_unknown", quotedUnitMills: null, productCents: "12.5" });
    expect(() => projectPurchasePipeline(data, pipelineTime, 90)).toThrow();
  });
  it("preserves signed residuals across exact quantity intervals", () => {
    for (const total of [BigInt(7), BigInt(-7)]) expect([0, 1, 2].reduce((sum, start) => sum + BigInt(pipelineIntervalMills(total, 3, start, 1)), BigInt(0))).toBe(total);
    expect(() => pipelineIntervalMills(BigInt(7), 3, 2, 2)).toThrow("outside");
  });
  it("rejects duplicate identities, fractional reports, reversed progress and unknown command fields", () => {
    const data = pipelineEvidence(); data.lines.push(data.lines[0]);
    expect(() => projectPurchasePipeline(data, pipelineTime, 90)).toThrow("Duplicate");
    const command = { expectedRevision: 0, idempotencyKey: "10000000-0000-4000-8000-000000000001", report: { startedPieces: 10, completedPieces: 11, asOf: pipelineTime.toISOString(), reference: "supplier", notes: "" } };
    expect(supplierProgressCommandSchema.safeParse(command).success).toBe(false);
    expect(supplierProgressCommandSchema.safeParse({ ...command, extra: true, report: { ...command.report, completedPieces: 1.2 } }).success).toBe(false);
  });
});
