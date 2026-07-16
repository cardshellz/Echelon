import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const EBAY_INGESTION_SRC = readFileSync(
  resolve(__dirname, "../../ebay-order-ingestion.ts"),
  "utf-8",
);

describe("ebay-order-ingestion :: routing", () => {
  it("routes existing orders that do not have warehouse assignment yet", () => {
    expect(EBAY_INGESTION_SRC).toMatch(/if \(isNew \|\| !result\.warehouseId\)/);
    expect(EBAY_INGESTION_SRC).toMatch(
      /await ensureEbayOrderQueuedForWmsSync\(\s*_wmsSyncService,\s*result\.id,\s*ebayOrder\.orderId,\s*database/,
    );
    expect(EBAY_INGESTION_SRC).toMatch(/await ensureEbayOrderQueuedForWmsSync\(_wmsSyncService, result\.id, orderId\)/);
  });

  it("re-queues on a genuine WMS sync failure, but treats an intentional skip as a no-op", () => {
    // genuine error throws -> re-queue (the catch block)
    expect(EBAY_INGESTION_SRC).toMatch(/enqueueOmsWmsSyncRetry\(database, omsOrderId, err\)/);
    // null = sync deliberately skipped (already fulfilled out-of-band) -> no-op, NOT a re-queue
    expect(EBAY_INGESTION_SRC).toMatch(/WMS sync skipped for .*no-op/);
  });
});
