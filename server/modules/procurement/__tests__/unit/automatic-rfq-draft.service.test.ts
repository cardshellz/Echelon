import { describe, expect, it, vi } from "vitest";
import {
  createAutomaticRfqDraftService,
  normalizeAutomaticRfqDraftPolicy,
  planAutomaticRfqDrafts,
} from "../../automatic-rfq-draft.service";

function recommendation(overrides: Record<string, unknown> = {}) {
  return {
    id: 101,
    runId: 50,
    productId: 20,
    productVariantId: 30,
    warehouseId: null,
    sku: "SKU-20-30",
    recommendedPieces: 100,
    preferredVendorId: 7,
    preferredVendorProductId: 70,
    status: "open",
    evidenceSnapshot: {
      confidence: "medium",
      rfqConfidence: "high",
      forecastTrust: { severity: "ok" },
      qualityGate: { autoDraftEligible: false },
      autopilotBlockers: [{ area: "supplier_cost", code: "missing_supplier_cost" }],
      supplierBasis: { costSource: "missing", costQuality: "missing", pricingBasis: "legacy_unknown" },
    },
    ...overrides,
  } as any;
}

function thenableChain(rows: any[]) {
  const chain: any = {
    from: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: () => chain,
    innerJoin: () => chain,
    for: async () => rows,
    then: (resolve: (value: any[]) => unknown, reject: (error: unknown) => unknown) =>
      Promise.resolve(rows).then(resolve, reject),
  };
  return chain;
}

function fakeDatabase(selectResults: any[][], insertResults: any[][]) {
  const insertedValues: any[] = [];
  const tx = {
    select: vi.fn(() => thenableChain(selectResults.shift() ?? [])),
    insert: vi.fn(() => ({
      values: (values: any) => {
        insertedValues.push(values);
        const rows = insertResults.shift() ?? [];
        return {
          returning: async () => rows,
          then: (resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) =>
            Promise.resolve(undefined).then(resolve, reject),
        };
      },
    })),
  };
  return {
    database: { transaction: (operation: (transaction: typeof tx) => unknown) => operation(tx) },
    tx,
    insertedValues,
  };
}

describe("automatic RFQ draft service", () => {
  it("defaults to manual and clamps unattended policy inputs", () => {
    expect(normalizeAutomaticRfqDraftPolicy({})).toEqual({
      mode: "manual",
      minimumConfidence: "high",
      requireTrustedForecast: true,
      maximumLinesPerRun: 100,
    });
    expect(normalizeAutomaticRfqDraftPolicy({
      rfqDraftAutomationMode: "preferred_vendor",
      rfqDraftMinimumConfidence: "medium",
      rfqDraftRequireTrustedForecast: false,
      rfqDraftMaximumLinesPerRun: 999,
    })).toMatchObject({
      mode: "preferred_vendor",
      minimumConfidence: "medium",
      requireTrustedForecast: false,
      maximumLinesPerRun: 500,
    });
  });

  it("drafts only trusted supplier-cost gaps and holds PO-ready or operationally blocked lines", () => {
    const policy = normalizeAutomaticRfqDraftPolicy({ rfqDraftAutomationMode: "preferred_vendor" });
    const result = planAutomaticRfqDrafts([
      recommendation(),
      recommendation({ id: 102, sku: "PO-READY", evidenceSnapshot: {
        confidence: "high", forecastTrust: { severity: "ok" }, qualityGate: { autoDraftEligible: true }, autopilotBlockers: [],
      } }),
      recommendation({ id: 103, sku: "LEAD-TIME-REVIEW", evidenceSnapshot: {
        confidence: "high", forecastTrust: { severity: "ok" }, qualityGate: { autoDraftEligible: false },
        autopilotBlockers: [{ area: "lead_time", code: "lead_time_review" }],
      } }),
      recommendation({ id: 104, sku: "NO-SUPPLIER", preferredVendorId: null, preferredVendorProductId: null }),
      recommendation({ id: 105, sku: "CURRENT-QUOTE", evidenceSnapshot: {
        confidence: "medium", forecastTrust: { severity: "ok" }, qualityGate: { autoDraftEligible: false },
        autopilotBlockers: [], supplierBasis: { costSource: "vendor_unit_cost_mills", costQuality: "current", pricingBasis: "per_piece" },
      } }),
    ], policy);

    expect(result.selected.map((line) => line.id)).toEqual([101]);
    expect(result.skipped.map((skip) => skip.code)).toEqual([
      "po_ready", "non_supplier_blocker", "no_preferred_supplier", "supplier_quote_current",
    ]);
  });

  it("creates one draft for only the remainder left by active RFQs from earlier runs", async () => {
    const line = recommendation();
    const persisted = { ...line };
    const { database, insertedValues } = fakeDatabase([
      [persisted],
      [],
      [{ id: 7, active: 1, currency: "USD" }],
      [{ id: 20 }],
      [{ productId: 20, productVariantId: 30, warehouseId: null, requestedPieces: 40 }],
      [{ id: 70, vendorId: 7, productId: 20, productVariantId: 30, isActive: 1, purchaseUom: null }],
    ], [
      [{ id: 501, rfqNumber: "RFQ-AUTO-TEST", vendorId: 7, status: "draft" }],
      [{ id: 601, rfqId: 501, recommendationLineId: 101, requestedPieces: 60 }],
      [],
    ]);

    const result = await createAutomaticRfqDraftService(database).createDrafts({
      recommendationRunId: 50,
      lines: [line],
      policy: normalizeAutomaticRfqDraftPolicy({ rfqDraftAutomationMode: "preferred_vendor" }),
      actorId: "system:auto-draft",
    });

    expect(result).toMatchObject({ reused: false, rfqs: [{ id: 501 }], lines: [{ requestedPieces: 60 }] });
    expect(insertedValues[0].requestHash).toMatch(/^[0-9a-f]{64}$/);
    expect(insertedValues[1]).toMatchObject({
      requestedPieces: 60,
      quantityOverrideReason: "Automatically reduced by active RFQ allocations from prior recommendation runs.",
    });
  });

  it("replays an existing supplier draft without creating another header", async () => {
    const line = recommendation();
    const { database, tx } = fakeDatabase([
      [{ ...line }],
      [{ id: 501, rfqNumber: "RFQ-AUTO-TEST", vendorId: 7, status: "draft" }],
      [{ id: 601, rfqId: 501, recommendationLineId: 101, requestedPieces: 100 }],
    ], []);

    const result = await createAutomaticRfqDraftService(database).createDrafts({
      recommendationRunId: 50,
      lines: [line],
      policy: normalizeAutomaticRfqDraftPolicy({ rfqDraftAutomationMode: "preferred_vendor" }),
      actorId: "system:auto-draft",
    });

    expect(result).toMatchObject({ reused: true, rfqs: [{ id: 501 }], lines: [{ id: 601 }] });
    expect(tx.insert).not.toHaveBeenCalled();
  });
});
