import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("eBay inactive-quantity drift reconciliation", () => {
  it("detects positive remote quantity on inactive variants and queues the durable repair", () => {
    const route = readFileSync(
      resolve(process.cwd(), "server/routes/ebay/ebay-listings.routes.ts"),
      "utf8",
    );

    expect(route).toContain("pv.is_active AS variant_is_active");
    expect(route).toContain("inspection.availableQuantity ?? 0");
    expect(route).toContain("INSERT INTO channels.channel_variant_availability_sync");
    expect(route).toContain("newStatus: \"availability repair queued\"");
    expect(route).toContain("quantityDrift");
  });
});
