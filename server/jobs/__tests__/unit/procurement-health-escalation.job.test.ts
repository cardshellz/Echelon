import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  db: {},
  catalogStorage: {},
  inventoryStorage: {
    getVelocityLookbackDays: vi.fn(),
  },
  procurementStorage: {
    getAutoDraftSettings: vi.fn(),
    getReorderAnalysisData: vi.fn(),
  },
  shipmentTracking: {
    getLandedCostHealth: vi.fn(),
  },
  loadProcurementHealthSummary: vi.fn(),
  sendProcurementHealthCriticalEscalation: vi.fn(),
}));

vi.mock("../../../db", () => ({
  db: mocks.db,
}));

vi.mock("../../../modules/catalog", () => ({
  catalogStorage: mocks.catalogStorage,
}));

vi.mock("../../../modules/inventory", () => ({
  inventoryStorage: mocks.inventoryStorage,
}));

vi.mock("../../../modules/procurement", () => ({
  procurementStorage: mocks.procurementStorage,
  createShipmentTrackingService: () => mocks.shipmentTracking,
}));

vi.mock("../../../modules/procurement/procurement-health-summary.service", () => ({
  loadProcurementHealthSummary: mocks.loadProcurementHealthSummary,
}));

vi.mock("../../../modules/procurement/procurement-health-escalation.service", () => ({
  sendProcurementHealthCriticalEscalation: mocks.sendProcurementHealthCriticalEscalation,
}));

import { runProcurementHealthEscalationJob } from "../../procurement-health-escalation.job";

describe("procurement health escalation job", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadProcurementHealthSummary.mockResolvedValue({
      generatedAt: "2026-05-22T12:00:00.000Z",
      status: "critical",
      critical: 2,
      warning: 1,
      total: 1,
      sources: [],
    });
    mocks.sendProcurementHealthCriticalEscalation.mockResolvedValue({
      sent: true,
      suppressed: false,
      reason: "sent",
      criticalCount: 2,
      signature: "source:2:1:3",
      notificationTypeKey: "procurement_health_critical",
    });
  });

  it("loads the shared health summary and sends the deduped escalation", async () => {
    const result = await runProcurementHealthEscalationJob({
      limit: 10,
      dedupeHours: 12,
      force: true,
    });

    expect(mocks.loadProcurementHealthSummary).toHaveBeenCalledWith({
      db: mocks.db,
      storage: expect.objectContaining({
        getAutoDraftSettings: mocks.procurementStorage.getAutoDraftSettings,
        getVelocityLookbackDays: mocks.inventoryStorage.getVelocityLookbackDays,
      }),
      shipmentTracking: mocks.shipmentTracking,
      limit: 10,
    });
    expect(mocks.sendProcurementHealthCriticalEscalation).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "critical",
        critical: 2,
      }),
      {
        db: mocks.db,
        dedupeHours: 12,
        force: true,
      },
    );
    expect(result).toMatchObject({
      mode: "procurement_health_escalation",
      limit: 10,
      health: {
        status: "critical",
        critical: 2,
      },
      escalation: {
        sent: true,
        notificationTypeKey: "procurement_health_critical",
      },
    });
  });

  it("normalizes invalid limits to the dashboard default", async () => {
    const result = await runProcurementHealthEscalationJob({ limit: -1 });

    expect(mocks.loadProcurementHealthSummary).toHaveBeenCalledWith(expect.objectContaining({ limit: 25 }));
    expect(result.limit).toBe(25);
  });
});
