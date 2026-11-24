/** Standalone command for an on-demand or scheduled forecast-evaluation batch. */

import { sanitizePurchasePipelineJobError } from "../modules/procurement/planning-and-pipeline-jobs.api";
import { runPurchaseForecastBacktestingJob } from "./purchase-forecast-backtesting.job";
import { logger } from "../platform/observability/logger";

function parseLimit(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 5_000) {
    throw new RangeError("PURCHASE_FORECAST_EVALUATION_LIMIT must be an integer between 1 and 5000");
  }
  return parsed;
}

function parseMaxBatches(value: string | undefined): number {
  if (value === undefined || value.trim() === "") return 10;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 100) {
    throw new RangeError("PURCHASE_FORECAST_EVALUATION_MAX_BATCHES must be an integer between 1 and 100");
  }
  return parsed;
}

async function main() {
  const limit = parseLimit(process.env.PURCHASE_FORECAST_EVALUATION_LIMIT);
  const maxBatches = parseMaxBatches(process.env.PURCHASE_FORECAST_EVALUATION_MAX_BATCHES);
  logger.info("jobs.run_purchase_forecast_backtesting", { detail: JSON.stringify(
    await runPurchaseForecastBacktestingJob({ limit, maxBatches }),
    null,
    2,
  ) });
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    logger.error("jobs.run_purchase_forecast_backtesting", { message: "[PurchaseForecastBacktesting] Scheduled evaluation failed", error: sanitizePurchasePipelineJobError(error) });
    process.exit(1);
  });
