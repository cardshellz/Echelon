import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { MARKETPLACE_IDENTITY_ISSUE_CODES } from "../../domain/marketplace-sync-decision";
import { MARKETPLACE_SYNC_SWEPT_STATUSES } from "../../domain/marketplace-sync-sweep";
import { EBAY_ORDER_CANCEL_DEAD_LETTER_EVENT_TYPE, MARKETPLACE_CANCEL_STATUSES } from "../../domain/marketplace-order-cancel";
import { ORDER_PROCESSING_RETRIES_EXHAUSTED_CODE } from "../../domain/order-processing-retry";

const ORDER_CHECK_CODES: readonly string[] = ["DROPSHIP_ORDER_PROCESSING_RETRIES_EXHAUSTED", "DROPSHIP_ORDER_MARKETPLACE_CANCEL_REVIEW",
  "DROPSHIP_EBAY_ORDER_CANCEL_UNPROCESSABLE", "DROPSHIP_ORDER_UNMATCHED_LISTING"];
import {
  DROPSHIP_MARKETPLACE_SYNC_HEALTH_CHECKS,
  NEEDS_REVIEW_ISSUE_CODES,
} from "../../infrastructure/dropship-marketplace-sync-health.sql";

/**
 * The ops-health SQL stays free of the domain's runtime imports (a read-only
 * caller must not load the sync runtime), so the lists it spells out are
 * pinned to the domain's here. The SQL runs against PostgreSQL in
 * dropship-ebay-sync-back-sweep.integration.test.ts.
 */
describe("eBay sync-back's ops-health SQL", () => {
  const dialect = new PgDialect();
  const text = (code: string, which: "countSql" | "sampleSql") =>
    dialect.sqlToQuery(DROPSHIP_MARKETPLACE_SYNC_HEALTH_CHECKS.find((check) => check.code === code)![which]).sql;

  it("counts as needing review exactly the identity issues and the sweep's dead letter", () => {
    expect(NEEDS_REVIEW_ISSUE_CODES).toEqual([...MARKETPLACE_IDENTITY_ISSUE_CODES, "sync_requires_review"]);
    expect(text("DROPSHIP_MARKETPLACE_LISTING_NEEDS_REVIEW", "countSql"))
      .toContain(`ARRAY[${NEEDS_REVIEW_ISSUE_CODES.map((code) => `'${code}'`).join(",")}]::text[]`);
    expect(text("DROPSHIP_MARKETPLACE_SYNC_CORRECTION_RATE", "countSql"))
      .toContain(`ARRAY[${MARKETPLACE_IDENTITY_ISSUE_CODES.map((code) => `'${code}'`).join(",")}]::text[]`);
  });

  it("looks only at the listings the sweep reads", () => {
    // The order checks (plan v4 §7) read order intake rows, not listings.
    const listingChecks = DROPSHIP_MARKETPLACE_SYNC_HEALTH_CHECKS.filter((entry) => entry.code !== "DROPSHIP_MARKETPLACE_SYNC_NOTICE_DEAD_LETTER"
      && !ORDER_CHECK_CODES.includes(entry.code));
    expect(listingChecks.length).toBe(DROPSHIP_MARKETPLACE_SYNC_HEALTH_CHECKS.length - 1 - ORDER_CHECK_CODES.length);
    for (const check of listingChecks) {
      expect(dialect.sqlToQuery(check.countSql).sql, check.code)
        .toContain(`ARRAY[${MARKETPLACE_SYNC_SWEPT_STATUSES.map((status) => `'${status}'`).join(",")}]::text[]`);
    }
  });

  it("spells the order checks' codes, statuses and event as the order fixes write them", () => {
    expect(text("DROPSHIP_ORDER_PROCESSING_RETRIES_EXHAUSTED", "countSql")).toContain("oi.status = 'failed'");
    expect(dialect.sqlToQuery(DROPSHIP_MARKETPLACE_SYNC_HEALTH_CHECKS.find((check) => check.code === "DROPSHIP_ORDER_PROCESSING_RETRIES_EXHAUSTED")!
      .countSql).params).toEqual([`${ORDER_PROCESSING_RETRIES_EXHAUSTED_CODE}:%`]);
    expect(text("DROPSHIP_ORDER_MARKETPLACE_CANCEL_REVIEW", "countSql"))
      .toContain(`IN ('${MARKETPLACE_CANCEL_STATUSES.review}', '${MARKETPLACE_CANCEL_STATUSES.afterShipment}')`);
    expect(text("DROPSHIP_EBAY_ORDER_CANCEL_UNPROCESSABLE", "countSql")).toContain(`'${EBAY_ORDER_CANCEL_DEAD_LETTER_EVENT_TYPE}'`);
    expect(dialect.sqlToQuery(DROPSHIP_MARKETPLACE_SYNC_HEALTH_CHECKS.find((check) => check.code === "DROPSHIP_EBAY_ORDER_CANCEL_UNPROCESSABLE")!
      .countSql).params).toEqual([MARKETPLACE_CANCEL_STATUSES.unprocessable]);
    expect(DROPSHIP_MARKETPLACE_SYNC_HEALTH_CHECKS.filter((check) => ORDER_CHECK_CODES.includes(check.code))
      .map((check) => [check.code, check.severity])).toEqual([
      ["DROPSHIP_ORDER_PROCESSING_RETRIES_EXHAUSTED", "critical"],
      ["DROPSHIP_ORDER_MARKETPLACE_CANCEL_REVIEW", "critical"],
      ["DROPSHIP_EBAY_ORDER_CANCEL_UNPROCESSABLE", "critical"],
      ["DROPSHIP_ORDER_UNMATCHED_LISTING", "warning"],
    ]);
  });

  it("bounds every sample", () => {
    for (const check of DROPSHIP_MARKETPLACE_SYNC_HEALTH_CHECKS) {
      const sample = dialect.sqlToQuery(check.sampleSql);
      expect(sample.sql, check.code).toMatch(/LIMIT \$\d+$/);
      expect(sample.params.at(-1), check.code).toBe(10);
    }
  });
});
