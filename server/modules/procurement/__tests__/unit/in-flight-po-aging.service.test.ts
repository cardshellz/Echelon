import { describe, expect, it } from "vitest";
import { buildInFlightPoAgingDiagnostics, type InFlightPoAgingRow } from "../../in-flight-po-aging.service";

function row(overrides: Partial<InFlightPoAgingRow>): InFlightPoAgingRow {
  return {
    id: 1,
    poNumber: "PO-TEST",
    vendorId: 10,
    vendorName: "Vendor",
    status: "sent",
    physicalStatus: "sent",
    financialStatus: "unbilled",
    lineCount: 1,
    totalCents: 1000,
    source: "manual",
    orderDate: "2026-05-01T00:00:00.000Z",
    sentToVendorAt: "2026-05-01T00:00:00.000Z",
    expectedDeliveryDate: null,
    confirmedDeliveryDate: null,
    actualDeliveryDate: null,
    firstShippedAt: null,
    firstArrivedAt: null,
    latestReceivingActivityAt: null,
    activeReceivingOrderId: null,
    activeReceiptNumber: null,
    activeReceiptStatus: null,
    createdAt: "2026-05-01T00:00:00.000Z",
    updatedAt: "2026-05-01T00:00:00.000Z",
    openExceptionCount: 0,
    ...overrides,
  };
}

describe("buildInFlightPoAgingDiagnostics", () => {
  const now = new Date("2026-05-20T00:00:00.000Z");

  it("flags supplier follow-up when a non-auto-draft PO is stale without ETA", () => {
    const result = buildInFlightPoAgingDiagnostics([row({
      id: 201,
      sentToVendorAt: "2026-05-01T00:00:00.000Z",
      expectedDeliveryDate: null,
      confirmedDeliveryDate: null,
    })], { now });

    expect(result).toMatchObject({
      scannedPos: 1,
      totalAging: 1,
      counts: {
        critical: 1,
        supplierFollowupPending: 1,
        missingEta: 1,
      },
    });
    expect(result.items[0]).toMatchObject({
      poId: 201,
      stage: "supplier_followup_pending",
      severity: "critical",
      action: {
        action: "follow_up_supplier",
        href: "/purchase-orders/201",
      },
    });
    expect(result.items[0]?.detail).toContain("without vendor acknowledgement or an expected delivery date");
  });

  it("continues aging sent POs from submission while vendor acknowledgement is missing", () => {
    const result = buildInFlightPoAgingDiagnostics([row({
      id: 208,
      sentToVendorAt: "2026-05-01T00:00:00.000Z",
      expectedDeliveryDate: "2026-06-15T00:00:00.000Z",
    })], { now });

    expect(result.items[0]).toMatchObject({
      poId: 208,
      stageStartedAt: "2026-05-01T00:00:00.000Z",
      ageDays: 19,
      severity: "critical",
    });
    expect(result.items[0]?.detail).toContain("without vendor acknowledgement");
  });

  it("does not age acknowledged POs before their effective delivery date", () => {
    const result = buildInFlightPoAgingDiagnostics([row({
      id: 209,
      status: "acknowledged",
      physicalStatus: "acknowledged",
      sentToVendorAt: "2026-05-01T00:00:00.000Z",
      expectedDeliveryDate: "2026-06-15T00:00:00.000Z",
    })], { now });

    expect(result.totalAging).toBe(0);
    expect(result.items).toHaveLength(0);
    expect(result.counts.overdueEta).toBe(0);
  });

  it("ages acknowledged POs from the effective delivery date", () => {
    const result = buildInFlightPoAgingDiagnostics([row({
      id: 210,
      status: "acknowledged",
      physicalStatus: "acknowledged",
      sentToVendorAt: "2026-05-01T00:00:00.000Z",
      confirmedDeliveryDate: "2026-05-10T00:00:00.000Z",
    })], { now });

    expect(result.items[0]).toMatchObject({
      poId: 210,
      stageStartedAt: "2026-05-10T00:00:00.000Z",
      ageDays: 10,
      severity: "warning",
    });
    expect(result.items[0]?.detail).toContain("past its vendor-confirmed delivery date");
  });

  it("does not age in-transit POs before their effective delivery date", () => {
    const result = buildInFlightPoAgingDiagnostics([row({
      id: 211,
      status: "acknowledged",
      physicalStatus: "in_transit",
      sentToVendorAt: "2026-05-01T00:00:00.000Z",
      expectedDeliveryDate: "2026-06-15T00:00:00.000Z",
    })], { now });

    expect(result.totalAging).toBe(0);
    expect(result.items).toHaveLength(0);
  });

  it("flags arrived POs waiting on receiving", () => {
    const result = buildInFlightPoAgingDiagnostics([row({
      id: 202,
      status: "acknowledged",
      physicalStatus: "arrived",
      firstArrivedAt: "2026-05-15T00:00:00.000Z",
      expectedDeliveryDate: "2026-05-15T00:00:00.000Z",
    })], { now });

    expect(result).toMatchObject({
      scannedPos: 1,
      totalAging: 1,
      counts: {
        warning: 1,
        receivingPending: 1,
        overdueEta: 1,
        arrivedNotReceiving: 1,
      },
    });
    expect(result.items[0]).toMatchObject({
      poId: 202,
      stage: "receiving_pending",
      severity: "warning",
      action: {
        action: "create_receipt",
      },
    });
  });

  it("uses legacy status when physical status has not been backfilled", () => {
    const result = buildInFlightPoAgingDiagnostics([row({
      id: 204,
      status: "partially_received",
      physicalStatus: "draft",
      expectedDeliveryDate: "2026-05-15T00:00:00.000Z",
    })], { now });

    expect(result.items[0]).toMatchObject({
      poId: 204,
      physicalStatus: "receiving",
      stage: "receiving_pending",
      severity: "warning",
    });
  });

  it("does not trust a confirmed delivery date that predates PO submission", () => {
    const result = buildInFlightPoAgingDiagnostics([row({
      id: 207,
      status: "acknowledged",
      physicalStatus: "acknowledged",
      sentToVendorAt: "2026-05-01T00:00:00.000Z",
      orderDate: "2026-05-01T00:00:00.000Z",
      expectedDeliveryDate: "2026-05-10T00:00:00.000Z",
      confirmedDeliveryDate: "2026-04-15T00:00:00.000Z",
    })], { now });

    expect(result.counts.invalidConfirmedDeliveryDate).toBe(1);
    expect(result.items[0]).toMatchObject({
      poId: 207,
      ageDays: 10,
      severity: "warning",
      expectedDeliveryDate: "2026-05-10T00:00:00.000Z",
      hasInvalidConfirmedDeliveryDate: true,
      action: {
        action: "correct_delivery_schedule",
        label: "Correct schedule",
      },
    });
    expect(result.items[0]?.detail).toContain("predates the PO submission date");
  });

  it("ages partially received POs from the latest receiving activity", () => {
    const result = buildInFlightPoAgingDiagnostics([row({
      id: 205,
      status: "partially_received",
      physicalStatus: "receiving",
      firstArrivedAt: "2026-04-01T00:00:00.000Z",
      latestReceivingActivityAt: "2026-05-18T00:00:00.000Z",
    })], { now });

    expect(result.totalAging).toBe(0);
    expect(result.items).toHaveLength(0);
  });

  it("continues an active receipt instead of offering to create another", () => {
    const result = buildInFlightPoAgingDiagnostics([row({
      id: 206,
      status: "partially_received",
      physicalStatus: "receiving",
      firstArrivedAt: "2026-04-01T00:00:00.000Z",
      latestReceivingActivityAt: "2026-05-15T00:00:00.000Z",
      activeReceivingOrderId: 501,
      activeReceiptNumber: "RCV-501",
      activeReceiptStatus: "open",
    })], { now });

    expect(result.items[0]).toMatchObject({
      poId: 206,
      stageStartedAt: "2026-05-15T00:00:00.000Z",
      ageDays: 5,
      severity: "warning",
      activeReceivingOrderId: 501,
      activeReceiptNumber: "RCV-501",
      activeReceiptStatus: "open",
      action: {
        action: "continue_receipt",
        label: "Continue receipt",
        href: "/receiving?open=501",
      },
    });
    expect(result.items[0]?.detail).toContain("Receipt RCV-501");
  });

  it("does not report supplier POs still inside the follow-up threshold", () => {
    const result = buildInFlightPoAgingDiagnostics([row({
      id: 203,
      sentToVendorAt: "2026-05-18T00:00:00.000Z",
    })], { now });

    expect(result.totalAging).toBe(0);
    expect(result.items).toHaveLength(0);
  });
});
