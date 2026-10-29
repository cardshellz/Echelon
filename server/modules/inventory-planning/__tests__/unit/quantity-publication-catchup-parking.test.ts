import { describe, expect, it } from "vitest";
import {
  QUANTITY_CATCHUP_PAUSED_DELAY, classifyQuantityCatchupFailure, quantityCatchupEscalation, quantityCatchupPausedDelaySeconds,
} from "../../domain/quantity-publication-catchup-parking";
import { normalizedProviderItemSql } from "../../infrastructure/quantity-catchup-parking.repository";

// Channels PR5 (PLAN-CH-v3 section 6 "Catch-up"): pure failure classes; the PG suite proves the persisted effects.
describe("quantity catch-up failure classes", () => {
  it.each([
    ["PUBLICATION_LISTING_TARGET_UNMAPPED", undefined, "parked"],
    ["PUBLICATION_LISTING_PLAN_OMITTED", undefined, "parked"],
    ["CANONICAL_PUBLICATION_MAPPING_MISSING", false, "parked"],
    ["55P03", undefined, "paused"],
    ["PUBLICATION_SCOPE_BUSY", undefined, "paused"],
    ["STOCK_MAPPING_PROVIDER_BUSY", false, "paused"],
    ["CUTOVER_CONFIGURATION_FREEZE_CHANGED", undefined, "paused"],
    ["PUBLICATION_GLOBAL_STOP_ACTIVE", undefined, "paused"],
    ["PUBLICATION_CATCHUP_SCOPE_MISMATCH", undefined, "permanent"],
    ["SHOPIFY_INVENTORY_REJECTED", false, "permanent"],
    ["SHOPIFY_INVENTORY_REJECTED", true, "transient"],
    ["40001", undefined, "transient"],
    ["PUBLICATION_CATCHUP_FAILED", undefined, "transient"],
    ["", undefined, "transient"],
    ["busy", undefined, "transient"],
  ] as const)("%s (retryable %s) -> %s", (code, retryable, expected) => {
    expect(classifyQuantityCatchupFailure({ code, retryable })).toBe(expected);
  });

  it("derives the paused delay from the claim, inside 60-180 s, without randomness", () => {
    const delays = Array.from({ length: 200 }, (_, index) => quantityCatchupPausedDelaySeconds({ catchupId: String(index + 1), revision: "1" }));
    for (const delay of delays) {
      expect(Number.isInteger(delay)).toBe(true);
      expect(delay).toBeGreaterThanOrEqual(QUANTITY_CATCHUP_PAUSED_DELAY.minSeconds);
      expect(delay).toBeLessThanOrEqual(QUANTITY_CATCHUP_PAUSED_DELAY.maxSeconds);
    }
    expect(new Set(delays).size).toBeGreaterThan(20);
    expect(quantityCatchupPausedDelaySeconds({ catchupId: "7", revision: "3" })).toBe(quantityCatchupPausedDelaySeconds({ catchupId: "7", revision: "3" }));
  });

  it("escalates only on the 8th (WARN) and 24th (ERROR) counted attempt", () => {
    expect([0, 1, 7, 8, 9, 23, 24, 25, 100].map(quantityCatchupEscalation)).toEqual([null, null, null, "warn", null, null, "error", null, null]);
  });

  it("normalizes Shopify ids in SQL only for Shopify and only for the exact gid form", () => {
    const text = normalizedProviderItemSql("x", "$1");
    expect(text).toContain("CASE WHEN $1 THEN");
    expect(text).toContain("'^gid://shopify/InventoryItem/([1-9][0-9]{0,19})$'");
    expect(text).toContain("'^[1-9][0-9]{0,19}$'");
    expect(text).toMatch(/ELSE x END\)$/);
  });
});
