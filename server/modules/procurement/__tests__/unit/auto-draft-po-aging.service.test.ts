import { describe, expect, it } from "vitest";
import {
  buildStaleAutoDraftPoDiagnostics,
  type AutoDraftPoAgingRow,
} from "../../auto-draft-po-aging.service";

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

describe("buildStaleAutoDraftPoDiagnostics", () => {
  const now = new Date("2026-05-10T00:00:00.000Z");

  it("uses the auto-draft action plan to flag stale draft review work", () => {
    const result = buildStaleAutoDraftPoDiagnostics([row({ id: 101, status: "draft" })], { now });

    expect(result).toMatchObject({
      scannedAutoDraftPos: 1,
      totalStale: 1,
      counts: {
        critical: 1,
        reviewPending: 1,
      },
    });
    expect(result.items[0]).toMatchObject({
      poId: 101,
      stage: "review_pending",
      severity: "critical",
      action: {
        action: "open_lines",
        href: "/purchase-orders/101",
      },
    });
  });

  it("classifies sent POs waiting on supplier follow-up", () => {
    const result = buildStaleAutoDraftPoDiagnostics([
      row({
        id: 102,
        status: "sent",
        physicalStatus: "sent",
        sentToVendorAt: "2026-05-01T00:00:00.000Z",
      }),
    ], { now });

    expect(result.items[0]).toMatchObject({
      poId: 102,
      stage: "supplier_followup_pending",
      severity: "warning",
      action: {
        action: "acknowledge",
      },
    });
  });

  it("uses receive-by dates as the aging baseline for receiving work", () => {
    const result = buildStaleAutoDraftPoDiagnostics([
      row({
        id: 103,
        status: "acknowledged",
        physicalStatus: "arrived",
        confirmedDeliveryDate: "2026-05-06T00:00:00.000Z",
        sentToVendorAt: "2026-04-01T00:00:00.000Z",
      }),
    ], { now });

    expect(result.items[0]).toMatchObject({
      poId: 103,
      stage: "receiving_pending",
      ageDays: 4,
      severity: "warning",
      action: {
        action: "create_receipt",
      },
    });
  });

  it("flags received auto-draft POs that are waiting on AP closeout", () => {
    const result = buildStaleAutoDraftPoDiagnostics([
      row({
        id: 104,
        status: "received",
        physicalStatus: "received",
        financialStatus: "unbilled",
        actualDeliveryDate: "2026-04-15T00:00:00.000Z",
      }),
    ], { now });

    expect(result.items[0]).toMatchObject({
      poId: 104,
      stage: "ap_closeout_pending",
      severity: "critical",
      action: {
        action: "create_invoice",
      },
    });
  });

  it("does not report terminal paid or manual POs", () => {
    const result = buildStaleAutoDraftPoDiagnostics([
      row({ id: 105, source: "manual" }),
      row({
        id: 106,
        status: "closed",
        physicalStatus: "received",
        financialStatus: "paid",
      }),
    ], { now });

    expect(result.totalStale).toBe(0);
    expect(result.items).toEqual([]);
  });
});
