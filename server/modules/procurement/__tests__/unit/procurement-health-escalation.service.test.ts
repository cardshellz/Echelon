import { describe, expect, it, vi } from "vitest";
import {
  PROCUREMENT_HEALTH_CRITICAL_NOTIFICATION_KEY,
  buildProcurementHealthCriticalNotification,
  sendProcurementHealthCriticalEscalation,
} from "../../procurement-health-escalation.service";
import type { ProcurementHealthSummary } from "../../procurement-health.service";

function summary(overrides: Partial<ProcurementHealthSummary> = {}): ProcurementHealthSummary {
  return {
    generatedAt: "2026-05-22T12:00:00.000Z",
    status: "critical",
    critical: 3,
    warning: 2,
    total: 2,
    sources: [
      {
        key: "stale_auto_draft_pos",
        label: "Stale auto-draft POs",
        status: "critical",
        critical: 2,
        warning: 0,
        total: 2,
        href: "/purchase-orders",
        actionLabel: "Open POs",
        detail: "Auto-created POs aging past review thresholds.",
      },
      {
        key: "supplier_setup_gaps",
        label: "Supplier setup gaps",
        status: "critical",
        critical: 1,
        warning: 2,
        total: 3,
        href: "/suppliers",
        actionLabel: "Open Suppliers",
        detail: "Vendor setup gaps blocking recommendations.",
      },
      {
        key: "landed_cost_health",
        label: "Landed cost health",
        status: "healthy",
        critical: 0,
        warning: 0,
        total: 0,
        href: "/shipments",
        actionLabel: "Open Inbound",
        detail: "Inbound costing work.",
      },
    ],
    ...overrides,
  };
}

describe("procurement health critical escalation", () => {
  it("builds a notification payload from critical health sources", () => {
    const notification = buildProcurementHealthCriticalNotification(summary());

    expect(notification).toMatchObject({
      title: "Procurement health has 3 critical signals",
      data: {
        criticalCount: 3,
        warningCount: 2,
        nonHealthySourceCount: 2,
        signature: "stale_auto_draft_pos:2:0:2|supplier_setup_gaps:1:2:3",
        url: "/purchasing",
      },
    });
    expect(notification?.message).toContain("Stale auto-draft POs: 2 critical. Open POs.");
    expect(notification?.message).toContain("Supplier setup gaps: 1 critical, 2 warning. Open Suppliers.");
    expect(notification?.data.sources).toEqual([
      expect.objectContaining({ key: "stale_auto_draft_pos", href: "/purchase-orders" }),
      expect.objectContaining({ key: "supplier_setup_gaps", href: "/suppliers" }),
    ]);
  });

  it("does not build or send when the health summary has no critical sources", async () => {
    const healthy = summary({
      status: "warning",
      critical: 0,
      warning: 1,
      total: 1,
      sources: [
        {
          key: "landed_cost_health",
          label: "Landed cost health",
          status: "warning",
          critical: 0,
          warning: 1,
          total: 1,
          href: "/shipments",
          actionLabel: "Open Inbound",
          detail: "Inbound costing work.",
        },
      ],
    });
    const notify = vi.fn().mockResolvedValue(undefined);

    const result = await sendProcurementHealthCriticalEscalation(healthy, { notify });

    expect(result).toEqual({
      sent: false,
      suppressed: false,
      reason: "no_critical",
      criticalCount: 0,
      signature: null,
      notificationTypeKey: PROCUREMENT_HEALTH_CRITICAL_NOTIFICATION_KEY,
    });
    expect(notify).not.toHaveBeenCalled();
  });

  it("sends the notification when no recent matching escalation exists", async () => {
    const db = { execute: vi.fn().mockResolvedValue({ rows: [] }) };
    const notify = vi.fn().mockResolvedValue(undefined);

    const result = await sendProcurementHealthCriticalEscalation(summary(), { db, notify });

    expect(result).toMatchObject({
      sent: true,
      suppressed: false,
      reason: "sent",
      criticalCount: 3,
      notificationTypeKey: PROCUREMENT_HEALTH_CRITICAL_NOTIFICATION_KEY,
      signature: "stale_auto_draft_pos:2:0:2|supplier_setup_gaps:1:2:3",
    });
    expect(notify).toHaveBeenCalledWith(
      PROCUREMENT_HEALTH_CRITICAL_NOTIFICATION_KEY,
      expect.objectContaining({
        title: "Procurement health has 3 critical signals",
        data: expect.objectContaining({ signature: "stale_auto_draft_pos:2:0:2|supplier_setup_gaps:1:2:3" }),
      }),
    );
  });

  it("suppresses duplicate critical signatures during the cooldown window", async () => {
    const db = { execute: vi.fn().mockResolvedValue({ rows: [{ exists: 1 }] }) };
    const notify = vi.fn().mockResolvedValue(undefined);

    const result = await sendProcurementHealthCriticalEscalation(summary(), { db, notify });

    expect(result).toMatchObject({
      sent: false,
      suppressed: true,
      reason: "cooldown",
      signature: "stale_auto_draft_pos:2:0:2|supplier_setup_gaps:1:2:3",
    });
    expect(notify).not.toHaveBeenCalled();
  });
});
