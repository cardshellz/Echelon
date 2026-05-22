import { db as defaultDb } from "../db";
import { catalogStorage } from "../modules/catalog";
import { inventoryStorage } from "../modules/inventory";
import { createShipmentTrackingService, procurementStorage } from "../modules/procurement";
import {
  sendProcurementHealthCriticalEscalation,
  type ProcurementHealthEscalationResult,
} from "../modules/procurement/procurement-health-escalation.service";
import { loadProcurementHealthSummary } from "../modules/procurement/procurement-health-summary.service";
import type { ProcurementHealthSummary } from "../modules/procurement/procurement-health.service";

type DbWithExecute = {
  execute: (query: any) => Promise<{ rows: unknown[] }>;
};

type ShipmentTrackingHealthSource = {
  getLandedCostHealth: (input: { limit: number }) => Promise<{
    status: string;
    critical: number;
    warning: number;
  }>;
};

export type ProcurementHealthEscalationJobResult = {
  mode: "procurement_health_escalation";
  limit: number;
  health: ProcurementHealthSummary;
  escalation: ProcurementHealthEscalationResult;
};

function normalizeLimit(value: unknown): number {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 25;
  return Math.min(parsed, 100);
}

function createDefaultShipmentTracking(db: DbWithExecute): ShipmentTrackingHealthSource {
  return createShipmentTrackingService(db as any, {
    ...procurementStorage,
    ...catalogStorage,
  }) as ShipmentTrackingHealthSource;
}

export async function runProcurementHealthEscalationJob(options: {
  db?: DbWithExecute;
  storage?: Parameters<typeof loadProcurementHealthSummary>[0]["storage"];
  shipmentTracking?: ShipmentTrackingHealthSource;
  limit?: number;
  dedupeHours?: number;
  force?: boolean;
} = {}): Promise<ProcurementHealthEscalationJobResult> {
  const db = options.db ?? defaultDb;
  const storage = options.storage ?? { ...procurementStorage, ...inventoryStorage };
  const shipmentTracking = options.shipmentTracking ?? createDefaultShipmentTracking(db);
  const limit = normalizeLimit(options.limit);
  const health = await loadProcurementHealthSummary({
    db,
    storage,
    shipmentTracking,
    limit,
  });
  const escalation = await sendProcurementHealthCriticalEscalation(health, {
    db,
    dedupeHours: options.dedupeHours,
    force: options.force,
  });

  return {
    mode: "procurement_health_escalation",
    limit,
    health,
    escalation,
  };
}
