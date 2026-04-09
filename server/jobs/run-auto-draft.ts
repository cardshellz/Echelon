/**
 * Standalone entry point for Heroku Scheduler.
 *
 * Heroku Scheduler command: node dist/jobs/run-auto-draft.js
 * Schedule: Daily at 02:00 AM UTC
 */

import { runAutoDraftJob } from "./auto-draft.job";

runAutoDraftJob({ triggeredBy: "scheduler" })
  .then(() => {
    console.log("[Auto-draft] Scheduler run completed successfully");
    process.exit(0);
  })
  .catch((err) => {
    console.error("[Auto-draft] Scheduler run failed:", err);
    process.exit(1);
  });
