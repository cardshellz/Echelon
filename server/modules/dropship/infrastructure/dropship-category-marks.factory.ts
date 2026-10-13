import { performance } from "node:perf_hooks";
import { logger } from "../../../platform/observability/logger";
import {
  DropshipCategoryMarksJobService,
  type CategoryMarksJobLog,
} from "../application/dropship-category-marks-job-service";
import { systemDropshipListingPreviewClock } from "../application/dropship-listing-preview-service";
import { PgDropshipCategoryMarksJobSource } from "./dropship-category-marks-job.source";
import { PgDropshipListingSettingWritesRepository } from "./dropship-listing-setting-writes.repository";

/** The job's lines through the platform logger (CLAUDE.md §10: one structured logger), which merges any correlation context. */
const platformJobLog: CategoryMarksJobLog = {
  debug: (action, fields) => logger.debug(action, fields),
  info: (action, fields) => logger.info(action, fields),
  warn: (action, fields) => logger.warn(action, fields),
  error: (action, fields) => logger.error(action, fields),
};

/**
 * The first-mark job's production wiring (plan PR 9, 10.5): the reads over
 * the shared pool, the 8a write wrapper's system transaction, the preview
 * clock, a monotonic timer for `elapsed_ms` and the platform logger.
 */
export function createDropshipCategoryMarksJobServiceFromEnv(): DropshipCategoryMarksJobService {
  return new DropshipCategoryMarksJobService({
    source: new PgDropshipCategoryMarksJobSource(),
    repository: new PgDropshipListingSettingWritesRepository(),
    clock: systemDropshipListingPreviewClock,
    timer: () => performance.now(),
    log: platformJobLog,
  });
}
