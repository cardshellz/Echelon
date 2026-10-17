import { performance } from "node:perf_hooks";
import { buildSchedulerFailureContext } from "../../../infrastructure/scheduler-failure-context";
import { logger } from "../../../platform/observability/logger";
import { systemDropshipListingPreviewClock } from "../application/dropship-listing-preview-service";
import { rulesConversionCostReadReporter } from "../application/dropship-listing-rules-conversion-service";
import {
  DropshipRulesConversionJobService,
  rulesConversionJobCostReadLog,
  type RulesConversionJobLog,
} from "../application/dropship-rules-conversion-job-service";
import { PgDropshipListingRulesConversionRepository } from "./dropship-listing-rules-conversion.repository";
import { PgDropshipRulesConversionJobSource } from "./dropship-rules-conversion-job.source";

/** The job's lines through the platform logger (CLAUDE.md §10: one structured logger), which merges any correlation context. */
const platformJobLog: RulesConversionJobLog = {
  debug: (action, fields) => logger.debug(action, fields),
  info: (action, fields) => logger.info(action, fields),
  warn: (action, fields) => logger.warn(action, fields),
  error: (action, fields) => logger.error(action, fields),
};

/**
 * The rules conversion job's production wiring (PR 11e2, plan 9.2, the
 * first-mark factory's pattern): the store list over the shared pool, the
 * 11c2 conversion repository (its transaction, the check's load by store
 * and the failure record) with the vendor's cost-read reporter
 * (rulesConversionCostReadReporter) at DEBUG only (rulesConversionJobCostReadLog:
 * the job's own line for the failure is the one at WARN or ERROR), the preview clock, a monotonic timer for `elapsed_ms`, the
 * platform logger and the scheduler's failure context for ERROR lines. No
 * heavy-write gate: the job runs one store at a time, in one process at a
 * time (plan 13.8).
 */
export function createDropshipRulesConversionJobServiceFromEnv(): DropshipRulesConversionJobService {
  return new DropshipRulesConversionJobService({
    source: new PgDropshipRulesConversionJobSource(),
    repository: new PgDropshipListingRulesConversionRepository(undefined,
      rulesConversionCostReadReporter(rulesConversionJobCostReadLog(platformJobLog))),
    clock: systemDropshipListingPreviewClock,
    timer: () => performance.now(),
    log: platformJobLog,
    failureContext: (error) => ({ ...buildSchedulerFailureContext(error) }),
  });
}
