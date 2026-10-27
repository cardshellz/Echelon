import { describe, expect, it } from "vitest";
import {
  DROPSHIP_CATALOG_CODE_VERSION,
  NEW_VERSION_SETTLE_MS,
  OLDER_PROCESS_ALERT_AFTER_MS,
  OLDER_PROCESS_GRACE_MS,
  decideCatalogPageVersion,
  isCatalogPageOutdated,
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
  it("is 3 in PR C (ending removed listings; PLAN-C v4.1 §4.1)", () => {
    expect(DROPSHIP_CATALOG_CODE_VERSION).toBe(3);
  });

  it("calls a step 1 save or preview outdated without a version or below this release's (PR C, D39)", () => {
    expect(isCatalogPageOutdated(null)).toBe(true);
    expect(isCatalogPageOutdated(1)).toBe(true);
    expect(isCatalogPageOutdated(2)).toBe(true);
    expect(isCatalogPageOutdated(3)).toBe(false);
    expect(isCatalogPageOutdated(4)).toBe(false);
    expect(isCatalogPageOutdated(3, 4)).toBe(true);
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
    expect(decideCatalogPageVersion(2)).toBe("current");
    expect(decideCatalogPageVersion(3)).toBe("current");
    // A later release's page reaching a C server, and PR C's page reaching a B server.
    expect(decideCatalogPageVersion(4)).toBe("page_newer_than_server");
    expect(decideCatalogPageVersion(3, 2)).toBe("page_newer_than_server");
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
