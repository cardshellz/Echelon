import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const EBAY_INGESTION_SRC = readFileSync(
  resolve(__dirname, "../../ebay-order-ingestion.ts"),
  "utf-8",
);
const INGEST_AND_ROUTE_SRC = readFileSync(
  resolve(__dirname, "../../channel-order-ingest-and-route.ts"),
  "utf-8",
);

describe("ebay-order-ingestion :: routing", () => {
  it("routes existing orders that do not have warehouse assignment yet", () => {
    expect(INGEST_AND_ROUTE_SRC).toContain("isNew ||\n    !omsOrder.warehouseId");
    expect(EBAY_INGESTION_SRC.match(/await ingestAndRoute\(\{/g)?.length).toBe(3);
  });

  it("re-queues on a genuine WMS sync failure, but treats an intentional skip as a no-op", () => {
    // genuine error throws -> re-queue (the catch block)
    expect(INGEST_AND_ROUTE_SRC).toContain("await enqueueOmsWmsSyncRetry(db, omsOrderId, err)");
    // null = sync deliberately skipped (already fulfilled out-of-band) -> no-op, NOT a re-queue
    expect(INGEST_AND_ROUTE_SRC).toMatch(/WMS sync skipped for .*no-op/);
  });
});
