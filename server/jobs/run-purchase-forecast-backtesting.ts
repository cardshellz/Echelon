/** Standalone command for an on-demand or scheduled forecast-evaluation batch. */

import { sanitizePurchasePipelineJobError } from "../modules/procurement/purchase-pipeline-job-run-lifecycle.service";
import { runPurchaseForecastBacktestingJob } from "./purchase-forecast-backtesting.job";

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
  console.log(JSON.stringify(
    await runPurchaseForecastBacktestingJob({ limit, maxBatches }),
    null,
    2,
  ));
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(
      "[PurchaseForecastBacktesting] Scheduled evaluation failed",
      sanitizePurchasePipelineJobError(error),
    );
    process.exit(1);
  });
