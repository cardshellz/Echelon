import { describe, expect, it } from "vitest";
import { buildStaleAutoDraftPoDiagnostics, type AutoDraftPoAgingRow } from "../../auto-draft-po-aging.service";
import { buildProcurementHealthSummary } from "../../procurement-health.service";

function row(overrides: Partial<AutoDraftPoAgingRow>): AutoDraftPoAgingRow {
  return {
    id: 1,
    poNumber: "PO-TEST",
    vendorId: 10,
    vendorName: "Vendor",
    status: "draft",
    physicalStatus: "draft",
    financialStatus: "unbilled",
    lineCount: 1,
    totalCents: 1000,
    source: "auto_draft",
    autoDraftDate: "2026-05-01T00:00:00.000Z",
    orderDate: null,
    approvedAt: null,
    sentToVendorAt: null,
    expectedDeliveryDate: null,
    confirmedDeliveryDate: null,
    actualDeliveryDate: null,
    firstShippedAt: null,
    firstArrivedAt: null,
    firstInvoicedAt: null,
    firstPaidAt: null,
    fullyPaidAt: null,
    createdAt: "2026-05-01T00:00:00.000Z",
    updatedAt: "2026-05-01T00:00:00.000Z",
    openExceptionCount: 0,
    ...overrides,
  };
}

describe("buildProcurementHealthSummary", () => {
  it("aggregates existing procurement monitors into one status", () => {
    const staleAutoDraftPos = buildStaleAutoDraftPoDiagnostics([
      row({ id: 101, poNumber: "PO-101" }),
    ], { now: new Date("2026-05-10T00:00:00.000Z") });

    const summary = buildProcurementHealthSummary({
      staleAutoDraftPos,
      landedCostHealth: {
        status: "warning",
        critical: 0,
        warning: 2,
      },
      supplierSetupGaps: {
        totalGapItems: 2,
        counts: {
          missingVendor: 1,
          missingSupplierCost: 0,
          lastPurchaseCost: 0,
          staleSupplierCost: 0,
          unverifiedSupplierCost: 0,
          defaultLeadTime: 1,
          productLeadTimeFallback: 0,
          blockedRecommendations: 1,
          reviewRecommendations: 1,
        },
      },
      generatedAt: new Date("2026-05-10T12:00:00.000Z"),
    });

    expect(summary).toMatchObject({
      generatedAt: "2026-05-10T12:00:00.000Z",
      status: "critical",
      critical: 2,
      warning: 3,
      total: 3,
      sources: [
        {
          key: "stale_auto_draft_pos",
          status: "critical",
          critical: 1,
          warning: 0,
          total: 1,
          href: "/purchase-orders",
        },
        {
          key: "landed_cost_health",
          status: "warning",
          critical: 0,
          warning: 2,
          total: 2,
          href: "/shipments",
        },
        {
          key: "supplier_setup_gaps",
          status: "critical",
          critical: 1,
          warning: 1,
          total: 2,
          href: "/suppliers",
        },
      ],
    });
  });
});
