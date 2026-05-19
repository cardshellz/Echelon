export type PurchasingDemandForecastQuality = "no_recent_demand" | "thin_history" | "normal";
export type PurchasingDemandForecastTrend =
  | "not_available"
  | "no_recent_demand"
  | "new_demand"
  | "rising"
  | "stable"
  | "falling";
export type PurchasingDemandForecastSource = "recent_order_velocity";
export type PurchasingDemandForecastMethod = "recent_order_velocity_v1";
export type PurchasingDemandForecastWindowLabel = "standard" | "short";
export type PurchasingDemandForecastAccelerationSignal =
  | "not_available"
  | "accelerating"
  | "steady"
  | "decelerating";

export interface PurchasingDemandForecastInput {
  lookbackDays: number | string | null | undefined;
  periodUsagePieces: number | string | null | undefined;
  priorPeriodUsagePieces?: number | string | null;
  demandOrderCount?: number | string | null;
  demandActiveDays?: number | string | null;
  latestDemandAt?: string | Date | null;
}

export interface PurchasingDemandForecastBasis {
  method: PurchasingDemandForecastMethod;
  version: 1;
  demandSource: PurchasingDemandForecastSource;
  lookbackDays: number;
  periodUsagePieces: number;
  priorPeriodUsagePieces: number | null;
  avgDailyUsagePieces: number;
  demandQuality: PurchasingDemandForecastQuality;
  demandTrend: PurchasingDemandForecastTrend;
  demandOrderCount: number | null;
  demandActiveDays: number | null;
  latestDemandAt: string | Date | null;
}

export interface PurchasingDemandForecastWindowSnapshot extends PurchasingDemandForecastBasis {
  label: PurchasingDemandForecastWindowLabel;
}

export interface PurchasingDemandForecastWindowDiagnostics {
  standardWindow: PurchasingDemandForecastWindowSnapshot;
  shortWindow: PurchasingDemandForecastWindowSnapshot;
  accelerationRatio: number | null;
  accelerationSignal: PurchasingDemandForecastAccelerationSignal;
}

function asNumber(value: unknown, fallback = 0): number {
  if (value === null || value === undefined || value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function asPositiveInt(value: unknown, fallback: number): number {
  const parsed = Math.trunc(asNumber(value, fallback));
  return parsed > 0 ? parsed : fallback;
}

function asNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function classifyDemandQuality(input: {
  periodUsagePieces: number;
  lookbackDays: number;
  demandOrderCount: number | null;
  demandActiveDays: number | null;
}): PurchasingDemandForecastQuality {
  if (input.periodUsagePieces <= 0) return "no_recent_demand";
  if (
    (input.demandOrderCount !== null && input.demandOrderCount <= 1) ||
    (input.demandActiveDays !== null && input.demandActiveDays <= 1)
  ) {
    return "thin_history";
  }
  if (input.periodUsagePieces < 3 || input.lookbackDays < 14) return "thin_history";
  return "normal";
}

function classifyDemandTrend(input: {
  periodUsagePieces: number;
  priorPeriodUsagePieces: number | null;
}): PurchasingDemandForecastTrend {
  if (input.periodUsagePieces <= 0) return "no_recent_demand";
  if (input.priorPeriodUsagePieces === null) return "not_available";
  if (input.priorPeriodUsagePieces <= 0) return "new_demand";

  const ratio = input.periodUsagePieces / input.priorPeriodUsagePieces;
  if (ratio >= 1.5) return "rising";
  if (ratio <= 0.5) return "falling";
  return "stable";
}

export function buildPurchasingDemandForecastBasis(
  input: PurchasingDemandForecastInput,
): PurchasingDemandForecastBasis {
  const lookbackDays = asPositiveInt(input.lookbackDays, 30);
  const periodUsagePieces = asNumber(input.periodUsagePieces);
  const priorPeriodUsagePieces = asNullableNumber(input.priorPeriodUsagePieces);
  const demandOrderCount = asNullableNumber(input.demandOrderCount);
  const demandActiveDays = asNullableNumber(input.demandActiveDays);
  const avgDailyUsagePieces = lookbackDays > 0 ? periodUsagePieces / lookbackDays : 0;
  const demandQuality = classifyDemandQuality({
    periodUsagePieces,
    lookbackDays,
    demandOrderCount,
    demandActiveDays,
  });
  const demandTrend = classifyDemandTrend({
    periodUsagePieces,
    priorPeriodUsagePieces,
  });

  return {
    method: "recent_order_velocity_v1",
    version: 1,
    demandSource: "recent_order_velocity",
    lookbackDays,
    periodUsagePieces,
    priorPeriodUsagePieces,
    avgDailyUsagePieces,
    demandQuality,
    demandTrend,
    demandOrderCount,
    demandActiveDays,
    latestDemandAt: input.latestDemandAt ?? null,
  };
}

function toWindowSnapshot(
  label: PurchasingDemandForecastWindowLabel,
  basis: PurchasingDemandForecastBasis,
): PurchasingDemandForecastWindowSnapshot {
  return {
    label,
    ...basis,
  };
}

function classifyAccelerationSignal(input: {
  standardAvgDailyUsagePieces: number;
  shortAvgDailyUsagePieces: number;
}): {
  accelerationRatio: number | null;
  accelerationSignal: PurchasingDemandForecastAccelerationSignal;
} {
  if (input.standardAvgDailyUsagePieces <= 0 && input.shortAvgDailyUsagePieces <= 0) {
    return { accelerationRatio: null, accelerationSignal: "not_available" };
  }
  if (input.standardAvgDailyUsagePieces <= 0 && input.shortAvgDailyUsagePieces > 0) {
    return { accelerationRatio: null, accelerationSignal: "accelerating" };
  }

  const ratio = input.shortAvgDailyUsagePieces / input.standardAvgDailyUsagePieces;
  const roundedRatio = Math.round(ratio * 100) / 100;
  if (ratio >= 1.5) return { accelerationRatio: roundedRatio, accelerationSignal: "accelerating" };
  if (ratio <= 0.5) return { accelerationRatio: roundedRatio, accelerationSignal: "decelerating" };
  return { accelerationRatio: roundedRatio, accelerationSignal: "steady" };
}

export function buildPurchasingDemandForecastWindowDiagnostics(input: {
  standardWindow: PurchasingDemandForecastBasis;
  shortWindow: PurchasingDemandForecastBasis;
}): PurchasingDemandForecastWindowDiagnostics {
  const acceleration = classifyAccelerationSignal({
    standardAvgDailyUsagePieces: input.standardWindow.avgDailyUsagePieces,
    shortAvgDailyUsagePieces: input.shortWindow.avgDailyUsagePieces,
  });

  return {
    standardWindow: toWindowSnapshot("standard", input.standardWindow),
    shortWindow: toWindowSnapshot("short", input.shortWindow),
    accelerationRatio: acceleration.accelerationRatio,
    accelerationSignal: acceleration.accelerationSignal,
  };
}
