import { describe, expect, it } from "vitest";
import {
  TRANSIENT_FENCE_MESSAGES,
  TRANSIENT_SQLSTATES,
  TRANSIENT_STOCK_LINK_CODES,
  classifyStockLinkFailure as classifyDropshipStockLinkFailure,
} from "../../domain/stock-link-readiness";
import { isDatabaseUnavailableError as dropshipIsDatabaseUnavailableError } from "../../domain/database-unavailable-error";
import { isDatabaseUnavailableError } from "../../../../infrastructure/database-unavailable-error";
import {
  STOCK_LINK_RETRYABLE_CODES,
  STOCK_LINK_RETRYABLE_FENCE_MESSAGES,
  STOCK_LINK_RETRYABLE_SQLSTATES,
  classifyStockLinkFailure,
} from "../../../inventory-planning/domain/stock-link-errors";

// Channels PR2 (PLAN-CH2 v4.1 §4.6, SAF-4): inventory planning's stock-link engine classifies the same writer's
// failures as Dropship's push link. Everything Dropship retries, the engine must retry too (busy, transient or
// "receipt decides"), never stamp `error` or halt on: its sets are a superset of Dropship's. No Dropship test or
// classification changed; Dropship only exports the two sets it already had.

const RETRYABLE_KINDS = ["busy", "transient", "cleanup_uncertain", "database_unavailable"];
const withCode = (code: string, message = code) => Object.assign(new Error(message), { code });

describe("stock-link classification parity with Dropship", () => {
  it("the engine's retryable codes, SQLSTATEs and fence messages contain Dropship's transient ones", () => {
    for (const code of TRANSIENT_STOCK_LINK_CODES) expect(STOCK_LINK_RETRYABLE_CODES.has(code), code).toBe(true);
    for (const code of TRANSIENT_SQLSTATES) expect(STOCK_LINK_RETRYABLE_SQLSTATES.has(code), code).toBe(true);
    for (const message of TRANSIENT_FENCE_MESSAGES) expect(STOCK_LINK_RETRYABLE_FENCE_MESSAGES.has(message), message).toBe(true);
  });

  it("every failure Dropship calls transient, the engine classifies as retryable", () => {
    const failures = [
      ...[...TRANSIENT_STOCK_LINK_CODES].map(code => withCode(code)),
      ...[...TRANSIENT_SQLSTATES].map(code => withCode(code, `pg ${code}`)),
      ...[...TRANSIENT_FENCE_MESSAGES].map(message => withCode("55000", message)),
      withCode("57P01"), withCode("08006"), withCode("ECONNRESET"), new Error("Connection terminated unexpectedly"),
    ];
    for (const failure of failures) {
      expect(classifyDropshipStockLinkFailure(failure).kind, failure.message).toBe("transient");
      expect(RETRYABLE_KINDS, failure.message).toContain(classifyStockLinkFailure(failure).kind);
    }
  });

  it("Dropship's database-unavailable predicate is the shared one, re-exported unchanged", () => {
    expect(dropshipIsDatabaseUnavailableError).toBe(isDatabaseUnavailableError);
  });
});
