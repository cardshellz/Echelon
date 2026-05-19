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
    expect(EBAY_INGESTION_SRC).toMatch(/await ensureEbayOrderQueuedForWmsSync\(_wmsSyncService, result\.id, ebayOrder\.orderId\)/);
    expect(EBAY_INGESTION_SRC).toMatch(/await ensureEbayOrderQueuedForWmsSync\(_wmsSyncService, result\.id, orderId\)/);
  });

  it("persists an oms_wms_sync retry when eBay WMS sync cannot complete", () => {
    expect(EBAY_INGESTION_SRC).toMatch(/enqueueOmsWmsSyncRetry\(db, omsOrderId, err\)/);
    expect(EBAY_INGESTION_SRC).toMatch(/eBay WMS sync returned no WMS order/);
  });
});
