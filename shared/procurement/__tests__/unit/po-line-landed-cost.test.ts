import { describe, expect, it } from "vitest";
import {
  formatLandedCostPerPiece,
  projectPoLineLandedCosts,
} from "../../po-line-landed-cost";

const input = () => ({
  poHeader: {
    totalCents: 35000,
    discountCents: 0,
    taxCents: 0,
    shippingCostCents: 0,
  },
  poLines: [
    { id: 10, orderQty: 100, lineTotalCents: 12000 },
    { id: 11, orderQty: 200, lineTotalCents: 23000 },
  ],
  costs: {
    summary: {
      poAmountCents: 35000,
      totalCents: 5000,
      combinedCostCents: 40000 as number | null,
    },
    lines: [
      {
        lineId: 20,
        purchaseOrderLineId: 10 as number | null | undefined,
        allocatedCents: 2500,
      },
      { lineId: 21, purchaseOrderLineId: 10, allocatedCents: 1000 },
      { lineId: 22, purchaseOrderLineId: 11, allocatedCents: 1100 },
      { lineId: 23, purchaseOrderLineId: 11, allocatedCents: 400 },
    ],
  },
});

describe("PO line landed costs from recorded allocations", () => {
  it("combines split shipments by PO line ID and includes packaging exactly once", () => {
    const data = input();
    const before = structuredClone(data);
    expect(projectPoLineLandedCosts(data)).toEqual({
      status: "complete",
      poLevelAdjustmentCents: 0,
      lines: [
        {
          purchaseOrderLineId: 10,
          pieces: 100,
          supplierCents: 12000,
          shipmentCents: 3500,
          totalCents: 15500,
        },
        {
          purchaseOrderLineId: 11,
          pieces: 200,
          supplierCents: 23000,
          shipmentCents: 1500,
          totalCents: 24500,
        },
      ],
    });
    expect(data).toEqual(before);
  });
  it.each([null, undefined, 999])(
    "does not guess missing/wrong PO line identity %s",
    (identity) => {
      const data = input();
      data.costs.lines[0].purchaseOrderLineId = identity;
      expect(projectPoLineLandedCosts(data).status).toBe("unavailable");
    },
  );
  it("does not display incomplete or mixed-currency totals as landed", () => {
    const data = input();
    data.costs.summary.combinedCostCents = null;
    expect(projectPoLineLandedCosts(data).status).toBe("unavailable");
  });
  it("does not silently omit an allocation", () => {
    const data = input();
    data.costs.lines.pop();
    expect(projectPoLineLandedCosts(data).status).toBe("unavailable");
  });
  it("rejects a landed total that disagrees with its component totals", () => {
    const data = input();
    data.costs.summary.combinedCostCents = 39999;
    expect(projectPoLineLandedCosts(data).status).toBe("unavailable");
  });
  it.each(["purchase", "shipment"])(
    "rejects duplicate %s identities",
    (kind) => {
      const data = input();
      if (kind === "purchase") data.poLines.push(data.poLines[0]);
      else data.costs.lines.push(data.costs.lines[0]);
      expect(projectPoLineLandedCosts(data).status).toBe("unavailable");
    },
  );
  it("preserves signed credits and leaves header adjustments unallocated", () => {
    const data = input();
    data.costs.lines[0].allocatedCents = -100;
    data.costs.summary.totalCents -= 2600;
    data.costs.summary.poAmountCents -= 500;
    data.poHeader.discountCents = 500;
    data.poHeader.totalCents -= 500;
    data.costs.summary.combinedCostCents =
      data.costs.summary.poAmountCents + data.costs.summary.totalCents;
    const result = projectPoLineLandedCosts(data);
    expect(result).toMatchObject({
      status: "complete",
      poLevelAdjustmentCents: -500,
      lines: [{ shipmentCents: 900, totalCents: 12900 }, {}],
    });
  });
  it("does not disguise a stale or inconsistent PO total as a header adjustment", () => {
    const data = input();
    data.poLines[0].lineTotalCents -= 1;
    expect(projectPoLineLandedCosts(data).status).toBe("unavailable");
    data.poLines[0].lineTotalCents += 1;
    data.poHeader.totalCents += 1;
    expect(projectPoLineLandedCosts(data).status).toBe("unavailable");
  });
  it("excludes cancelled supplier lines from the current landed amounts", () => {
    const data = input();
    expect(
      projectPoLineLandedCosts({
        ...data,
        poLines: [
          ...data.poLines,
          { id: 12, orderQty: 10, lineTotalCents: 1000, status: "cancelled" },
        ],
      }),
    ).toMatchObject({
      status: "complete",
      poLevelAdjustmentCents: 0,
      lines: [{ purchaseOrderLineId: 10 }, { purchaseOrderLineId: 11 }],
    });
  });
  it("handles no shipment charges and zero quantities without fabricating a unit rate", () => {
    const data = input();
    data.costs.lines = [];
    data.costs.summary.totalCents = 0;
    data.poLines[0].orderQty = 0;
    data.costs.summary.combinedCostCents = data.costs.summary.poAmountCents;
    expect(projectPoLineLandedCosts(data)).toMatchObject({
      status: "complete",
      lines: [{ shipmentCents: 0, totalCents: 12000 }, {}],
    });
    expect(formatLandedCostPerPiece(12000, 0, "USD")).toBeNull();
  });
  it.each([1.1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid money %s",
    (amount) => {
      const data = input();
      data.poLines[0].lineTotalCents = amount;
      expect(projectPoLineLandedCosts(data).status).toBe("unavailable");
    },
  );
  it("fails closed on sum overflow", () => {
    const data = input();
    data.poLines[0].lineTotalCents = Number.MAX_SAFE_INTEGER;
    expect(projectPoLineLandedCosts(data).status).toBe("unavailable");
  });
});

describe("display-only per-piece rates", () => {
  it.each([
    [15500, 100, "$1.550000"],
    [24500, 200, "$1.225000"],
    [100, 3, "$0.333333"],
    [1, 20000, "$0.000001"],
    [-1, 20000, "-$0.000001"],
    [0, 12, "$0.000000"],
    [Number.MAX_SAFE_INTEGER, 1, "$90,071,992,547,409.910000"],
  ])(
    "formats %s cents / %s pieces exactly before rounding",
    (amount, pieces, text) => {
      expect(formatLandedCostPerPiece(amount, pieces, "USD")).toBe(text);
    },
  );
  it.each([0, -1, 0.5, NaN, Infinity])(
    "rejects invalid piece count %s",
    (pieces) => {
      expect(formatLandedCostPerPiece(100, pieces, "USD")).toBeNull();
    },
  );
  it("preserves currency and rejects malformed currencies", () => {
    expect(formatLandedCostPerPiece(100, 1, "EUR")).toBe("€1.000000");
    expect(formatLandedCostPerPiece(100, 1, "usd")).toBeNull();
  });
});
