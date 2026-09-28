/**
 * Environment switches for the .ops cost detection worker. Read here, once,
 * so the runner and the admin view agree on whether this process runs it.
 */
export const DROPSHIP_COST_DETECTION_ENABLED_VARIABLE = "DROPSHIP_COST_DETECTION_WORKER_ENABLED";
export const DROPSHIP_COST_DETECTION_DISABLED_VARIABLE = "DROPSHIP_COST_DETECTION_WORKER_DISABLED";

/** Opt-in like the other dropship maintenance workers; DISABLE_SCHEDULERS and the disabled switch win. */
export function isDropshipCostDetectionWorkerEnabled(environment: NodeJS.ProcessEnv = process.env): boolean {
  return environment.DISABLE_SCHEDULERS !== "true"
    && environment[DROPSHIP_COST_DETECTION_DISABLED_VARIABLE] !== "true"
    && environment[DROPSHIP_COST_DETECTION_ENABLED_VARIABLE] === "true";
}
