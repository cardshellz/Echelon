import { describe, expect, it } from "vitest";
import { describeWmsSyncFailure } from "../../domain/wms-sync-failure";

describe("durable WMS sync failure evidence", () => {
  it("retains the actual reservation cause behind the prerequisite wrapper", () => {
    const cause = Object.assign(new Error("could not serialize access"), { code: "40001" });
    const error = Object.assign(new Error("Authority-aware inventory reservation failed before shipment processing.", { cause }),
      { code: "WMS_SHIPMENT_PREREQUISITE_FAILED" });
    expect(describeWmsSyncFailure(error)).toBe("[WMS_SHIPMENT_PREREQUISITE_FAILED] Authority-aware inventory reservation failed before shipment processing.; caused by [40001] could not serialize access");
  });
  it("bounds cycles/depth and redacts credentials instead of storing the error payload", () => {
    const error = new Error("connect postgres://user:secret@host/db password=secret token=private");
    error.cause = error;
    expect(describeWmsSyncFailure(error)).toBe("connect [redacted URL] password=[redacted] token=[redacted]");
    expect(describeWmsSyncFailure(new Error("x".repeat(10000))).length).toBeLessThanOrEqual(2000);
  });
  it("omits query text and parameters but retains the underlying database cause", () => {
    const error = new Error("Failed query: INSERT INTO private_data VALUES ($1)\nparams: private-value", {
      cause: Object.assign(new Error("could not serialize access"), { code: "40001" }),
    });
    expect(describeWmsSyncFailure(error))
      .toBe("Database query failed; caused by [40001] could not serialize access");
    expect(describeWmsSyncFailure(new Error('authorization=Bearer private-token password="secret phrase"')))
      .toBe("authorization=[redacted] password=[redacted]");
  });
});
