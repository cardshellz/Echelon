/**
 * Standalone entry point for Heroku Scheduler.
 *
 * Heroku Scheduler command: node dist/jobs/run-auto-draft.js
 * Schedule: Daily at 02:00 AM UTC
 */

import { runAutoDraftJob } from "./auto-draft.job";
import { logger } from "../platform/observability/logger";

runAutoDraftJob({ triggeredBy: "scheduler" })
  .then(() => {
    logger.info("jobs.run_auto_draft", { message: "[Auto-draft] Scheduler run completed successfully" });
    process.exit(0);
  })
  .catch((err) => {
    logger.error("jobs.run_auto_draft", { message: "[Auto-draft] Scheduler run failed:", error: err });
    process.exit(1);
  });
