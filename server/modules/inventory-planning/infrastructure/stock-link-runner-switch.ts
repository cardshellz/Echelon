import { getSchedulerDisableReason } from "../../../infrastructure/scheduler-config";

/**
 * The stock-link runner's kill switches (channels PR2, PLAN-CH2 v4.1 §7.1, §21), dependency-free so the status route
 * and Ops Health can tell that the runner is off without loading the runner, its scheduler or its pool (review CMP-1).
 * The runner is started in the web process, the same process that answers the status route and Ops Health, so this
 * process's environment is the runner's.
 */

/** This runner's own kill switch (§7.1, §21). */
export const STOCK_LINK_DISABLE_ENV = "STOCK_LINK_AUTO_DISABLED";

/** Why the runner is off in this process (DISABLE_SCHEDULERS or STOCK_LINK_AUTO_DISABLED set to "true"), or null. */
export function stockLinkRunnerDisableReason(environment: NodeJS.ProcessEnv = process.env): string | null {
  return getSchedulerDisableReason(STOCK_LINK_DISABLE_ENV, environment);
}
