import { describe, expect, it } from "vitest";

import { assessSupplierQuoteValidity } from "../../supplier-quote-validity";

describe("supplier quote validity", () => {
  it("allows at most five minutes of timestamp clock skew", () => {
    const common = {
      quoteValidUntil: null,
      asOf: "2026-07-11T18:00:00.000Z",
      currentDate: "2026-07-11",
    } as const;

    expect(assessSupplierQuoteValidity({
      ...common,
      quotedAt: "2026-07-11T18:05:00.000Z",
      quotedAtDate: "2026-07-11",
    }).status).toBe("current");
    expect(assessSupplierQuoteValidity({
      ...common,
      quotedAt: "2026-07-11T18:05:00.001Z",
      quotedAtDate: "2026-07-11",
    }).status).toBe("future");
  });

  it("rejects a future DB calendar date even inside timestamp tolerance", () => {
    expect(assessSupplierQuoteValidity({
      quotedAt: "2026-07-12T00:00:00.000Z",
      quotedAtDate: "2026-07-12",
      quoteValidUntil: null,
      asOf: "2026-07-11T23:58:00.000Z",
      currentDate: "2026-07-11",
    }).status).toBe("future");
  });

  it("treats the explicit validity date as inclusive", () => {
    expect(assessSupplierQuoteValidity({
      quotedAt: "2026-07-01T12:00:00.000Z",
      quotedAtDate: "2026-07-01",
      quoteValidUntil: "2026-07-11",
      asOf: "2026-07-11T23:59:59.000Z",
      currentDate: "2026-07-11",
    }).status).toBe("current");
  });

  it("honors an explicit validity date beyond the fallback maximum age", () => {
    expect(assessSupplierQuoteValidity({
      quotedAt: "2024-01-01T12:00:00.000Z",
      quotedAtDate: "2024-01-01",
      quoteValidUntil: "2026-12-31",
      asOf: "2026-07-11T12:00:00.000Z",
      currentDate: "2026-07-11",
    }).status).toBe("current");
  });
});
