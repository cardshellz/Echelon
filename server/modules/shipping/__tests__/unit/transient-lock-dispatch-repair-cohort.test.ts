import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { parseFlags } from "../../../../../scripts/repair-historical-carrier-dispatch";

// 2026-11-23: a Postgres lock timeout (55P03) at the carrier confirmation boundary
// was classified as permanent. It moved 113 dispatches that were durably waiting
// for a pick correction into review_required, so their inventory never posted.
// The classifier now retries 55P03; this cohort lets an operator requeue the
// already-parked commands through the guarded repair script.
describe("parked carrier dispatches from transient lock timeouts", () => {
  const repository = readFileSync(resolve(process.cwd(), "server/modules/shipping/carrier-tracking.repository.ts"), "utf8");
  const eligibility = repository.slice(repository.indexOf("function historicalCarrierDispatchRepairEligibilitySql"));
  const requeueable = eligibility.slice(0, eligibility.indexOf("OR ("));
  const classifier = readFileSync(resolve(process.cwd(), "server/modules/oms/shipstation/shipstation-notify-webhook-dispatch.ts"), "utf8");

  it("selects only application failures whose source was a 55P03 lock timeout", () => {
    expect(repository).toContain("THEN 'transient_lock_not_available'");
    expect(repository).toMatch(/command\.last_error_code = 'CARRIER_DISPATCH_APPLICATION_FAILED'\s+AND NULLIF\(BTRIM\(command\.result_evidence ->> 'sourceCode'\), ''\) = '55P03'\s+THEN 'transient_lock_not_available'/);
    expect(requeueable).toContain("'transient_lock_not_available'");
  });

  it("only requeues a cohort whose failure is now retried instead of parked", () => {
    expect(classifier).toMatch(/\["40001", "40P01", "53300", "55P03", "57P01", "57P02", "57P03"\]/);
  });

  it("lets the operator repair script select the cohort", () => {
    expect(parseFlags(["--cohort=transient_lock_not_available"]).cohort).toBe("transient_lock_not_available");
  });
});
