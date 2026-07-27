import fs from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = fs.readFileSync(
  resolve(__dirname, "../../flow-waterfall.service.ts"),
  "utf8",
);

describe("Shopify writeback debt Control Tower taxonomy", () => {
  it("classifies known historical debt before the generic dead-letter fallback", () => {
    const legacyTracking = source.indexOf("SHOPIFY_PUSH_LEGACY_TRACKING_MISSING");
    const packageConflict = source.indexOf("SHOPIFY_PUSH_PACKAGE_STATE_CONFLICT");
    const unclassified = source.indexOf("ELSE 'UNCLASSIFIED'");

    expect(legacyTracking).toBeGreaterThan(0);
    expect(packageConflict).toBeGreaterThan(legacyTracking);
    expect(unclassified).toBeGreaterThan(packageConflict);
    expect(source).toContain(
      "rq.last_error LIKE 'pushShopifyFulfillment: shipment % has no tracking_number'",
    );
    expect(source).toContain(
      "rq.last_error LIKE 'pushShopifyFulfillment: Shopify reports remaining quantity that cannot be allocated%'",
    );
  });

  it("keeps both reconciliation classes non-replayable and operator-readable", () => {
    for (const code of [
      "SHOPIFY_PUSH_LEGACY_TRACKING_MISSING",
      "SHOPIFY_PUSH_PACKAGE_STATE_CONFLICT",
    ]) {
      const reasonStart = source.indexOf(`{ code: "${code}"`);
      expect(reasonStart).toBeGreaterThan(0);
      const reasonEnd = source.indexOf("},", reasonStart);
      const reason = source.slice(reasonStart, reasonEnd + 2);
      expect(reason).toContain('stage: "writeback"');
      expect(reason).toContain('remediation: "INVESTIGATE"');
      expect(reason).toContain("replaySafe: false");
    }
  });
});
