/**
 * Standalone entry point for scheduled procurement health escalation checks.
 *
 * Suggested command: npm run procurement:health-escalation
 */

import { runProcurementHealthEscalationJob } from "./procurement-health-escalation.job";
import { logger } from "../platform/observability/logger";

function parseOptionalInt(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function parseBoolean(value: string | undefined): boolean | undefined {
  if (!value) return undefined;
  return value === "1" || value.toLowerCase() === "true";
}

runProcurementHealthEscalationJob({
  limit: parseOptionalInt(process.env.PROCUREMENT_HEALTH_ESCALATION_LIMIT),
  dedupeHours: parseOptionalInt(process.env.PROCUREMENT_HEALTH_ESCALATION_DEDUPE_HOURS),
  force: parseBoolean(process.env.PROCUREMENT_HEALTH_ESCALATION_FORCE),
})
  .then((result) => {
    logger.info("jobs.run_procurement_health_escalation", { detail: JSON.stringify({
      mode: result.mode,
      status: result.health.status,
      critical: result.health.critical,
      warning: result.health.warning,
      total: result.health.total,
      escalation: result.escalation,
    }, null, 2) });
    process.exit(0);
  })
  .catch((err) => {
    logger.error("jobs.run_procurement_health_escalation", { message: "[Procurement health] Escalation scheduler run failed:", error: err });
    process.exit(1);
  });
