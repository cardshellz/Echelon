import type { StaleAutoDraftPoDiagnostics } from "./auto-draft-po-aging.service";

export type ProcurementHealthSeverity = "critical" | "warning" | "healthy";

export type ProcurementHealthSource = {
  key: string;
  label: string;
  status: ProcurementHealthSeverity;
  critical: number;
  warning: number;
  total: number;
  href: string;
  actionLabel: string;
  detail: string;
};

export type ProcurementHealthSummary = {
  generatedAt: string;
  status: ProcurementHealthSeverity;
  critical: number;
  warning: number;
  total: number;
  sources: ProcurementHealthSource[];
};

type LandedCostHealthLike = {
  status: string;
  critical: number;
  warning: number;
};

function statusFromCounts(critical: number, warning: number): ProcurementHealthSeverity {
  if (critical > 0) return "critical";
  if (warning > 0) return "warning";
  return "healthy";
}

function normalizeStatus(status: string): ProcurementHealthSeverity {
  return status === "critical" || status === "warning" ? status : "healthy";
}

function countNonHealthy(sources: ProcurementHealthSource[]): number {
  return sources.reduce((count, source) => count + (source.status === "healthy" ? 0 : 1), 0);
}

export function buildProcurementHealthSummary(input: {
  staleAutoDraftPos: StaleAutoDraftPoDiagnostics;
  landedCostHealth: LandedCostHealthLike;
  generatedAt?: Date;
}): ProcurementHealthSummary {
  const staleCritical = input.staleAutoDraftPos.counts.critical;
  const staleWarning = input.staleAutoDraftPos.counts.warning;
  const landedCritical = input.landedCostHealth.critical;
  const landedWarning = input.landedCostHealth.warning;

  const sources: ProcurementHealthSource[] = [
    {
      key: "stale_auto_draft_pos",
      label: "Stale auto-draft POs",
      status: statusFromCounts(staleCritical, staleWarning),
      critical: staleCritical,
      warning: staleWarning,
      total: input.staleAutoDraftPos.totalStale,
      href: "/purchase-orders",
      actionLabel: "Open POs",
      detail: "Auto-created POs aging past review, supplier, receiving, or AP thresholds.",
    },
    {
      key: "landed_cost_health",
      label: "Landed cost health",
      status: normalizeStatus(input.landedCostHealth.status),
      critical: landedCritical,
      warning: landedWarning,
      total: landedCritical + landedWarning,
      href: "/shipments",
      actionLabel: "Open Inbound",
      detail: "Inbound costing and allocation work that can block final inventory cost reporting.",
    },
  ];

  const critical = sources.reduce((sum, source) => sum + source.critical, 0);
  const warning = sources.reduce((sum, source) => sum + source.warning, 0);

  return {
    generatedAt: (input.generatedAt ?? new Date()).toISOString(),
    status: statusFromCounts(critical, warning),
    critical,
    warning,
    total: countNonHealthy(sources),
    sources,
  };
}
