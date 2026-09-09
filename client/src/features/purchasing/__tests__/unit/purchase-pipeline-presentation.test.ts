import { describe, expect, it } from "vitest";
import {
  emptySupplierProgress,
  purchasePipelineRowSchema,
  type PurchasePipelineCost,
  type PurchasePipelineRow,
} from "@shared/procurement/purchase-pipeline";
import {
  filterPipelinePurchases,
  formatPipelineCurrency,
  formatPipelinePieces,
  groupPipelinePurchases,
  summarizePipelineCosts,
} from "../../purchase-pipeline-presentation";

function cost(
  component: PurchasePipelineCost["component"],
  amountMills: string | null,
  evidence: PurchasePipelineCost["evidence"] = amountMills === null ? "unknown" : "estimated",
): PurchasePipelineCost {
  return { component, amountMills, evidence, source: "missing", sourceRevisionId: null, recordedAt: null, reference: null };
}

function row(overrides: Partial<PurchasePipelineRow> = {}): PurchasePipelineRow {
  return purchasePipelineRowSchema.parse({
    key: "11:0:supplier_unconfirmed",
    purchaseOrderId: 1,
    purchaseOrderLineId: 11,
    poNumber: "PO-ONE",
    vendorName: "North Supply",
    sku: "BLUE-CASE",
    productName: "Blue protective case",
    currency: "USD",
    orderedPieces: 100,
    cancelledPieces: 0,
    receivedPieces: 0,
    remainingPieces: 100,
    stage: "supplier_unconfirmed",
    quantityPieces: 100,
    shipmentId: null,
    shipmentLineId: null,
    shipmentNumber: null,
    arrivalDate: null,
    arrivalSource: null,
    arrivalBucket: "unknown",
    arrivalDestination: "unknown",
    costs: [cost("product", null), cost("packaging", null), cost("landed", null)],
    progress: emptySupplierProgress(),
    issues: [],
    ...overrides,
  });
}

describe("purchase pipeline presentation grouping", () => {
  it("groups by exact PO identity and sums remaining slices without repeating line or received quantities", () => {
    const input = [
      row({ key: "21:0:supplier_unconfirmed", purchaseOrderId: 2, purchaseOrderLineId: 21, poNumber: "PO-TWO", quantityPieces: 15 }),
      row({ key: "11:1:in_transit", stage: "in_transit", shipmentId: 8, shipmentLineId: 1, shipmentNumber: "SHARED", quantityPieces: 30, receivedPieces: 50, remainingPieces: 50 }),
      row({ key: "11:2:awaiting_receipt", stage: "awaiting_receipt", shipmentId: 9, shipmentLineId: 2, quantityPieces: 20, receivedPieces: 50, remainingPieces: 50 }),
      row({ key: "12:0:ready_to_ship", purchaseOrderLineId: 12, stage: "ready_to_ship", orderedPieces: 40, remainingPieces: 40, quantityPieces: 40 }),
    ];
    const original = structuredClone(input);
    const groups = groupPipelinePurchases(Object.freeze(input));
    expect(groups.map((group) => group.id)).toEqual([1, 2]);
    expect(groups[0]).toMatchObject({
      poNumber: "PO-ONE", vendorName: "North Supply", lineCount: 2,
      knownPieces: "90", unknownQuantity: false,
      stages: ["ready_to_ship", "in_transit", "awaiting_receipt"],
    });
    expect(groups[0].rows).toEqual(input.slice(1));
    expect(groups[1].knownPieces).toBe("15");
    expect(input).toEqual(original);
  });

  it("keeps shared shipments attributed to their own purchase slices", () => {
    const groups = groupPipelinePurchases([
      row({ key: "11:1:in_transit", shipmentId: 7, stage: "in_transit", quantityPieces: 60 }),
      row({ key: "22:2:in_transit", purchaseOrderId: 2, purchaseOrderLineId: 22, shipmentId: 7, stage: "in_transit", quantityPieces: 50 }),
    ]);
    expect(groups.map((group) => group.knownPieces)).toEqual(["60", "50"]);
    expect(groups.every((group) => group.lineCount === 1)).toBe(true);
  });

  it("adds validated piece quantities exactly beyond Number's safe aggregate range", () => {
    const groups = groupPipelinePurchases([
      row({ quantityPieces: Number.MAX_SAFE_INTEGER }),
      row({ key: "12:0:supplier_unconfirmed", purchaseOrderLineId: 12, quantityPieces: 2 }),
    ]);
    expect(groups[0].knownPieces).toBe("9007199254740993");
    expect(formatPipelinePieces(groups[0].knownPieces)).toBe("9,007,199,254,740,993");
  });

  it("keeps unknown quantities distinct from zero while preserving known slices", () => {
    const review = row({ key: "12:0:review", purchaseOrderLineId: 12, stage: "review", quantityPieces: null, remainingPieces: null, receivedPieces: null });
    expect(groupPipelinePurchases([row({ quantityPieces: 7 }), review])[0])
      .toMatchObject({ knownPieces: "7", unknownQuantity: true, lineCount: 2 });
    expect(groupPipelinePurchases([review])[0]).toMatchObject({ knownPieces: "0", unknownQuantity: true });
    expect(groupPipelinePurchases([row({ quantityPieces: 0 })])[0]).toMatchObject({ knownPieces: "0", unknownQuantity: false });
    expect(groupPipelinePurchases([])).toEqual([]);
  });
});

describe("purchase pipeline cost summaries", () => {
  it("totals each displayed cost column independently without combining currencies or accepting unresolved amounts", () => {
    const rows = [
      row({ costs: [cost("product", "10000", "confirmed"), cost("packaging", "2000"), cost("landed", null)] }),
      row({ costs: [cost("product", "-1000", "confirmed"), cost("packaging", "9000", "review_required"), cost("landed", "3000")] }),
      row({ currency: "EUR", costs: [cost("product", "5000"), cost("packaging", "0", "confirmed"), cost("landed", null)] }),
    ];
    const original = structuredClone(rows);
    expect(summarizePipelineCosts(rows, "product").map(({ currency, knownMills, missingComponents }) => ({ currency, knownMills, missingComponents })))
      .toEqual([{ currency: "EUR", knownMills: "5000", missingComponents: 0 }, { currency: "USD", knownMills: "9000", missingComponents: 0 }]);
    expect(summarizePipelineCosts(rows, "packaging")[1]).toMatchObject({ knownMills: "2000", estimatedComponents: 1, missingComponents: 1 });
    expect(summarizePipelineCosts(rows, "landed")[0]).toMatchObject({ knownMills: "0", estimatedComponents: 0, confirmedComponents: 0, missingComponents: 1 });
    expect(rows).toEqual(original);
  });

  it("keeps currency, confidence and missing component counts separate with signed credits", () => {
    const summaries = summarizePipelineCosts([
      row({ costs: [cost("product", "1000", "confirmed"), cost("packaging", "0"), cost("landed", null)] }),
      row({ costs: [cost("product", "-100", "confirmed"), cost("packaging", null), cost("landed", null)] }),
      row({ currency: "EUR", costs: [cost("product", "2000"), cost("packaging", null), cost("landed", null)] }),
      row({ currency: null }),
    ]);
    expect(summaries).toEqual([
      { currency: "EUR", knownMills: "2000", confirmedMills: "0", estimatedMills: "2000", confirmedComponents: 0, estimatedComponents: 1, missingComponents: 2 },
      { currency: "USD", knownMills: "900", confirmedMills: "900", estimatedMills: "0", confirmedComponents: 2, estimatedComponents: 1, missingComponents: 3 },
      { currency: null, knownMills: "0", confirmedMills: "0", estimatedMills: "0", confirmedComponents: 0, estimatedComponents: 0, missingComponents: 3 },
    ]);
  });

  it("distinguishes a recorded zero from an entirely unknown value", () => {
    const zero = summarizePipelineCosts([row({ costs: [cost("product", "0", "confirmed"), cost("packaging", "0"), cost("landed", "0")] })])[0];
    const unknown = summarizePipelineCosts([row()])[0];
    expect(zero).toMatchObject({ knownMills: "0", confirmedComponents: 1, estimatedComponents: 2, missingComponents: 0 });
    expect(unknown).toMatchObject({ knownMills: "0", confirmedComponents: 0, estimatedComponents: 0, missingComponents: 3 });
    expect(summarizePipelineCosts([])).toEqual([]);
  });

  it("does not count an unresolved component amount as known evidence", () => {
    const summary = summarizePipelineCosts([row({
      costs: [cost("product", "10000", "review_required"), cost("packaging", "2000", "unknown"), cost("landed", null, "confirmed")],
    })])[0];
    expect(summary).toMatchObject({ knownMills: "0", confirmedComponents: 0, estimatedComponents: 0, missingComponents: 3 });
  });

  it("aggregates tiny amounts before rounding and retains evidence when credits net to zero", () => {
    const small = row({ costs: [cost("product", "49"), cost("packaging", "49"), cost("landed", null)] });
    const summary = summarizePipelineCosts([small])[0];
    expect(formatPipelineCurrency("49", "USD")).toBe("$0.00");
    expect(summary.knownMills).toBe("98");
    expect(formatPipelineCurrency(summary.knownMills, summary.currency)).toBe("$0.01");
    expect(summarizePipelineCosts([row({ costs: [cost("product", "49", "confirmed"), cost("packaging", "-49", "confirmed"), cost("landed", null)] })])[0])
      .toMatchObject({ knownMills: "0", confirmedComponents: 2, missingComponents: 1 });
  });

  it("preserves 100-digit source values through exact summation", () => {
    const large = "9".repeat(100);
    const summary = summarizePipelineCosts([row({ costs: [cost("product", large), cost("packaging", "1"), cost("landed", null)] })])[0];
    expect(summary.knownMills).toBe(`1${"0".repeat(100)}`);
  });
});

describe("purchase pipeline search and filters", () => {
  const input = [
    row({ key: "11:0:supplier_unconfirmed", arrivalBucket: "overdue" }),
    row({ key: "12:1:in_transit", purchaseOrderLineId: 12, sku: "RED-SLEEVE", productName: "Red archival sleeve", stage: "in_transit", arrivalBucket: "within_horizon", shipmentNumber: "CONTAINER-88" }),
    row({ key: "21:0:ready_to_ship", purchaseOrderId: 2, purchaseOrderLineId: 21, poNumber: "PO-TWO", vendorName: "South Supply", sku: null, productName: null, stage: "ready_to_ship" }),
  ];

  it("requires the same slice to match stage and arrival bucket", () => {
    const groups = groupPipelinePurchases(input);
    expect(filterPipelinePurchases(groups, { search: "", bucket: "overdue", stage: "in_transit" })).toEqual([]);
    expect(filterPipelinePurchases(groups, { search: "", bucket: "overdue", stage: "supplier_unconfirmed" }).map((group) => group.id)).toEqual([1]);
  });

  it("returns the entire matching purchase and searches across its slices without mutation", () => {
    const groups = groupPipelinePurchases(input);
    const original = structuredClone(groups);
    const result = filterPipelinePurchases(Object.freeze(groups), { search: " container-88 ", bucket: "overdue", stage: "supplier_unconfirmed" });
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(groups[0]);
    expect(result[0].rows).toHaveLength(2);
    expect(groups).toEqual(original);
  });

  it.each([
    ["po-one", 1], ["NORTH SUPPLY", 1], ["red-sleeve", 1], ["archival", 1], ["container-88", 1], ["south supply", 2],
  ])("finds %s across purchase, supplier, product or shipment fields", (search, id) => {
    expect(filterPipelinePurchases(groupPipelinePurchases(input), { search, bucket: "all", stage: "all" }).map((group) => group.id)).toEqual([id]);
  });

  it("returns all groups for a blank search and no groups for a missing term", () => {
    const groups = groupPipelinePurchases(input);
    expect(filterPipelinePurchases(groups, { search: "  ", bucket: "all", stage: "all" })).toEqual(groups);
    expect(filterPipelinePurchases(groups, { search: "missing", bucket: "all", stage: "all" })).toEqual([]);
  });
});

describe("exact pipeline presentation formatting", () => {
  it.each([
    ["331442000", "$33,144.20"], ["0", "$0.00"], ["-0", "$0.00"],
    ["49", "$0.00"], ["50", "$0.01"], ["149", "$0.01"], ["150", "$0.02"],
    ["-49", "$0.00"], ["-50", "-$0.01"], ["-150", "-$0.02"],
    ["9999", "$1.00"], ["-9999", "-$1.00"], ["-123456", "-$12.35"],
  ])("formats %s mills as %s using exact half-up rounding", (mills, expected) => {
    expect(formatPipelineCurrency(mills, "USD")).toBe(expected);
  });

  it("uses the currency's minor digits and names every non-USD or unknown currency", () => {
    expect(formatPipelineCurrency("123456", "EUR")).toBe("EUR\u00a012.35");
    expect(formatPipelineCurrency("4999", "JPY")).toBe("JPY\u00a00");
    expect(formatPipelineCurrency("5000", "JPY")).toBe("JPY\u00a01");
    expect(formatPipelineCurrency("-5000", "JPY")).toBe("-JPY\u00a01");
    expect(formatPipelineCurrency("5", "KWD")).toBe("KWD\u00a00.001");
    expect(formatPipelineCurrency("1", "CLF")).toBe("CLF\u00a00.0001");
    expect(formatPipelineCurrency("123456", null)).toBe("12.35 currency unknown");
  });

  it("formats 100-digit values and carry rounding without loss of precision", () => {
    const whole = `1${"0".repeat(96)}`.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    expect(formatPipelineCurrency("9".repeat(100), "USD")).toBe(`$${whole}.00`);
    expect(formatPipelineCurrency(`-${"9".repeat(100)}`, "USD")).toBe(`-$${whole}.00`);
    expect(formatPipelinePieces("14657530")).toBe("14,657,530");
    expect(formatPipelinePieces("0")).toBe("0");
  });

  it.each(["", " 1", "1 ", "+1", "01", "1.0", "1e3", "NaN", "Infinity", "1".repeat(129)])("rejects noncanonical or out-of-range integer input %s", (value) => {
    expect(() => formatPipelineCurrency(value, "USD")).toThrow(TypeError);
    expect(() => formatPipelinePieces(value)).toThrow(TypeError);
  });

  it("rejects negative piece quantities, invalid currencies and non-string runtime input", () => {
    expect(() => formatPipelinePieces("-1")).toThrow(TypeError);
    expect(() => formatPipelineCurrency("1", "usd")).toThrow(TypeError);
    expect(() => formatPipelineCurrency("1", "US")).toThrow(TypeError);
    expect(() => formatPipelineCurrency(1 as unknown as string, "USD")).toThrow(TypeError);
  });
});
