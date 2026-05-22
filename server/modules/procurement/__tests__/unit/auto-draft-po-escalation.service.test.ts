import { describe, expect, it, vi } from "vitest";
import { buildStaleAutoDraftPoDiagnostics, type AutoDraftPoAgingRow } from "../../auto-draft-po-aging.service";
import {
  CRITICAL_STALE_AUTO_DRAFT_PO_NOTIFICATION_KEY,
  buildCriticalStaleAutoDraftPoNotification,
  sendCriticalStaleAutoDraftPoEscalation,
} from "../../auto-draft-po-escalation.service";

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

describe("critical stale auto-draft PO escalation", () => {
  const now = new Date("2026-05-10T00:00:00.000Z");

  it("builds a notification payload for critical stale auto-draft POs", () => {
    const diagnostics = buildStaleAutoDraftPoDiagnostics([
      row({ id: 101, poNumber: "PO-101" }),
      row({ id: 102, poNumber: "PO-102", vendorName: "Second Vendor" }),
    ], { now });

    const notification = buildCriticalStaleAutoDraftPoNotification(diagnostics);

    expect(notification).toMatchObject({
      title: "2 auto-draft POs are critically stale",
      data: {
        criticalCount: 2,
        totalStale: 2,
        signature: "101:review_pending|102:review_pending",
        stageCounts: {
          review_pending: 2,
        },
        url: "/purchasing",
      },
    });
    expect(notification?.message).toContain("PO-101");
    expect(notification?.data.items).toEqual([
      expect.objectContaining({ poId: 101, action: expect.objectContaining({ href: "/purchase-orders/101" }) }),
      expect.objectContaining({ poId: 102, action: expect.objectContaining({ href: "/purchase-orders/102" }) }),
    ]);
  });

  it("sends the notification when no recent matching escalation exists", async () => {
    const diagnostics = buildStaleAutoDraftPoDiagnostics([row({ id: 201, poNumber: "PO-201" })], { now });
    const db = { execute: vi.fn().mockResolvedValue({ rows: [] }) };
    const notify = vi.fn().mockResolvedValue(undefined);

    const result = await sendCriticalStaleAutoDraftPoEscalation(diagnostics, { db, notify });

    expect(result).toMatchObject({
      sent: true,
      suppressed: false,
      reason: "sent",
      criticalCount: 1,
      notificationTypeKey: CRITICAL_STALE_AUTO_DRAFT_PO_NOTIFICATION_KEY,
    });
    expect(notify).toHaveBeenCalledWith(
      CRITICAL_STALE_AUTO_DRAFT_PO_NOTIFICATION_KEY,
      expect.objectContaining({
        title: "Auto-draft PO PO-201 is critically stale",
        data: expect.objectContaining({ signature: "201:review_pending" }),
      }),
    );
  });

  it("suppresses duplicate critical signatures during the cooldown window", async () => {
    const diagnostics = buildStaleAutoDraftPoDiagnostics([row({ id: 301, poNumber: "PO-301" })], { now });
    const db = { execute: vi.fn().mockResolvedValue({ rows: [{ exists: 1 }] }) };
    const notify = vi.fn().mockResolvedValue(undefined);

    const result = await sendCriticalStaleAutoDraftPoEscalation(diagnostics, { db, notify });

    expect(result).toMatchObject({
      sent: false,
      suppressed: true,
      reason: "cooldown",
      signature: "301:review_pending",
    });
    expect(notify).not.toHaveBeenCalled();
  });
});
