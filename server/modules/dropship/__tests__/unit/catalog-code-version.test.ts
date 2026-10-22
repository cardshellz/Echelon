import { describe, expect, it } from "vitest";
import {
  DROPSHIP_CATALOG_CODE_VERSION,
  NEW_VERSION_SETTLE_MS,
  OLDER_PROCESS_ALERT_AFTER_MS,
  OLDER_PROCESS_GRACE_MS,
  decideCatalogPageVersion,
} from "../../domain/catalog-code-version";
import { PROCESS_HEARTBEAT_INTERVAL_MS } from "../../infrastructure/dropship-process-heartbeat";
import { isReservedSelectionIdempotencyKey, LEGACY_PICKS_IDEMPOTENCY_KEY_PREFIX } from "../../domain/selection-release";
import { vi } from "vitest";

vi.mock("../../../../db", () => ({ pool: {}, db: {} }));

/**
 * The catalog code version is the contract every later release's gate reads
 * (step 1 plan S2-5 §4.9 item 1, D37): A = 1, B = 2, C = 3. Changing it is a
 * release decision, so this pins it.
 */
describe("catalog code version (S2-5 §4.9)", () => {
  it("is 1 in PR A", () => {
    expect(DROPSHIP_CATALOG_CODE_VERSION).toBe(1);
  });

  it("keeps the grace longer than four missed beats, and the settle and alert longer than the grace", () => {
    expect(OLDER_PROCESS_GRACE_MS).toBe(120_000);
    expect(OLDER_PROCESS_GRACE_MS).toBeGreaterThanOrEqual(4 * PROCESS_HEARTBEAT_INTERVAL_MS);
    expect(NEW_VERSION_SETTLE_MS).toBe(300_000);
    expect(OLDER_PROCESS_ALERT_AFTER_MS).toBe(30 * 60_000);
  });

  it("answers only a page newer than the server with 'page newer'", () => {
    expect(decideCatalogPageVersion(null)).toBe("current");
    expect(decideCatalogPageVersion(1)).toBe("current");
    expect(decideCatalogPageVersion(2)).toBe("page_newer_than_server");
    expect(decideCatalogPageVersion(3, 3)).toBe("current");
    expect(decideCatalogPageVersion(2, 3)).toBe("current");
  });

  it("reserves exactly B's backfill key prefix for the rules save (CHK10)", () => {
    expect(LEGACY_PICKS_IDEMPOTENCY_KEY_PREFIX).toBe("legacy-picks-");
    expect(isReservedSelectionIdempotencyKey("legacy-picks-backfill:10")).toBe(true);
    expect(isReservedSelectionIdempotencyKey("  legacy-picks-x")).toBe(true);
    expect(isReservedSelectionIdempotencyKey("catalog-legacy-picks-1")).toBe(false);
    expect(isReservedSelectionIdempotencyKey("Legacy-Picks-1")).toBe(false);
  });
});
