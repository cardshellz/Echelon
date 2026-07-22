/** Standalone command for an on-demand or scheduled forecast-evaluation batch. */

import { db } from "../db";
import { createPurchaseForecastBacktestingService } from "../modules/procurement/purchase-forecast-backtesting.service";

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
  const service = createPurchaseForecastBacktestingService({ database: db });
  const asOf = new Date();
  const limit = parseLimit(process.env.PURCHASE_FORECAST_EVALUATION_LIMIT);
  const maxBatches = parseMaxBatches(process.env.PURCHASE_FORECAST_EVALUATION_MAX_BATCHES);
  const batches = [];
  for (let batchNumber = 1; batchNumber <= maxBatches; batchNumber += 1) {
    const result = await service.evaluateMatured({
      asOf,
      limit,
      actor: "system:purchase-forecast-backtesting",
    });
    batches.push({ batchNumber, ...result });
    if (!result.batchLimitReached) break;
  }
  console.log(JSON.stringify({
    asOf,
    maxBatches,
    batchCount: batches.length,
    insertedCount: batches.reduce((sum, batch) => sum + batch.insertedCount, 0),
    backlogMayRemain: batches.length === maxBatches && Boolean(batches[batches.length - 1]?.batchLimitReached),
    batches,
  }, null, 2));
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("[PurchaseForecastBacktesting] Scheduled evaluation failed", { error });
    process.exit(1);
  });
