import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAX_PREVIEW_LINES,
  MAX_PREVIEW_PARCELS,
  returnPortalPreviewStateSchema,
  returnPreviewOrderSchema,
  returnPreviewReasonSchema,
  returnPreviewReviewSchema,
  type ReturnPreviewReviewInput,
  type ReturnPreviewScenarioId,
} from "../../../../../shared/returns/customer-return-preview.contract";
import { CustomerReturnPreviewError, CustomerReturnPreviewService } from "../../application/customer-return-preview.service";
import {
  CUSTOMER_RETURN_PREVIEW_EVALUATED_AT,
  readCustomerReturnPreviewScenario,
} from "../../application/customer-return-preview-scenarios";
import * as eligibilityDomain from "../../domain/customer-return-eligibility";

const service = new CustomerReturnPreviewService();
const lookup = { scenarioId: "split_delivered" as const, orderReference: "TEST-1001" };

function reviewInput(): ReturnPreviewReviewInput {
  return {
    ...lookup,
    selections: [
      { lineId: "sample-line-1", quantity: 3, reasonCode: null },
      { lineId: "sample-line-2", quantity: 1, reasonCode: "no_longer_needed" },
    ],
    parcels: [
      { items: [{ lineId: "sample-line-1", quantity: 1 }, { lineId: "sample-line-2", quantity: 1 }] },
      { items: [{ lineId: "sample-line-1", quantity: 2 }] },
    ],
  };
}

function expectPreviewError(work: () => unknown, code: CustomerReturnPreviewError["code"], status: number): void {
  let caught: unknown;
  try { work(); } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(CustomerReturnPreviewError);
  expect(caught).toMatchObject({ code, status });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("CustomerReturnPreviewService lookup", () => {
  it("advertises only the five explicitly fictional sample orders with customer access disabled", () => {
    const state = service.getState();
    expect(returnPortalPreviewStateSchema.safeParse(state).success).toBe(true);
    expect(state).toMatchObject({ mode: "admin_preview", customerAccess: "disabled", dataSource: "sample_orders" });
    expect(state.scenarios.map(scenario => scenario.orderReference)).toEqual([
      "TEST-1001", "TEST-1002", "TEST-1003", "TEST-1004", "TEST-1005",
    ]);
    expect(new Set(state.scenarios.map(scenario => scenario.id)).size).toBe(5);
    expect(state.scenarios.every(scenario => scenario.description.startsWith("Fictional"))).toBe(true);
  });

  it("combines delivered allocations of the same purchased line while preserving separate same-SKU lines", () => {
    const sample = readCustomerReturnPreviewScenario("split_delivered");
    expect(sample.facts.order.lines[0].allocations.map(allocation => allocation.quantity)).toEqual([1, 2]);
    expect(new Set(sample.facts.order.lines[0].allocations.map(allocation => allocation.fulfillmentId)).size).toBe(2);
    const result = service.lookup(lookup);
    expect(result.lines.map(line => line.eligibleQuantity)).toEqual([3, 1, 1]);
    expect(result.lines[0].sku).toBe(result.lines[1].sku);
    expect(result.lines[0].id).not.toBe(result.lines[1].id);
    expect(result.lines[0]).toMatchObject({ purchasedQuantity: 3, deliveredQuantity: 3, alreadyReturningQuantity: 0 });
  });

  it("offers only delivered quantities without waiting for the whole purchased line or order", () => {
    const result = service.lookup({ scenarioId: "partially_delivered", orderReference: "TEST-1002" });
    expect(result.lines[0]).toMatchObject({ purchasedQuantity: 3, deliveredQuantity: 1, eligibleQuantity: 1 });
    expect(result.lines[0].message).toBe("Only the delivered quantity is available to return.");
    expect(result.lines[1]).toMatchObject({ purchasedQuantity: 2, deliveredQuantity: 2, eligibleQuantity: 2 });
  });

  it("does not treat shipment as delivery", () => {
    const result = service.lookup({ scenarioId: "in_transit", orderReference: "TEST-1003" });
    expect(result.lines[0]).toMatchObject({ purchasedQuantity: 2, deliveredQuantity: 0, eligibleQuantity: 0 });
    expect(result.lines[0].message).toContain("not been delivered");
  });

  it("deducts existing claims from only their purchased line", () => {
    const result = service.lookup({ scenarioId: "already_returning", orderReference: "TEST-1004" });
    expect(result.lines.map(line => [line.deliveredQuantity, line.alreadyReturningQuantity, line.eligibleQuantity]))
      .toEqual([[3, 2, 1], [1, 1, 0], [1, 0, 1]]);
    expect(result.lines[0].sku).toBe(result.lines[2].sku);
    expect(result.lines[1].message).toBe("These items are already included in a return.");
  });

  it("uses the purchase-based 365-day deadline even though the sample delivery was recent", () => {
    const result = service.lookup({ scenarioId: "outside_window", orderReference: "TEST-1005" });
    expect(result).toMatchObject({ purchasedAt: "2025-09-21T12:00:00.000Z", returnWindowEndsAt: "2026-09-21T12:00:00.000Z" });
    expect(result.lines[0]).toMatchObject({ deliveredQuantity: 2, eligibleQuantity: 0 });
    expect(result.lines[0].message).toContain("365-day");
  });

  it.each(["TEST-1001", "#TEST-1001", "  # TEST-1001  ", "  TEST-1001  "])("normalizes the conventional prefix and surrounding spaces: %s", orderReference => {
    expect(service.lookup({ ...lookup, orderReference }).orderReference).toBe("TEST-1001");
  });

  it.each(["TEST-1002", "63210", "63268", "test-1001", "TEST-01001", "TEST-1001-X"])("never substitutes a real, other-scenario, or differently spelled reference: %s", orderReference => {
    expectPreviewError(() => service.lookup({ ...lookup, orderReference }), "RETURN_PREVIEW_ORDER_NOT_FOUND", 404);
  });

  it.each([
    null, [], {}, { ...lookup, scenarioId: "actual_order" }, { ...lookup, orderReference: 1001 },
    { ...lookup, orderReference: "" }, { ...lookup, orderReference: " # " },
    { ...lookup, orderReference: "##TEST-1001" }, { ...lookup, orderReference: "TEST-\u00001001" },
    { ...lookup, orderReference: "X".repeat(257) }, { ...lookup, orderReference: "X".repeat(51) },
    { ...lookup, customerId: "fake-customer" }, { ...lookup, eligibility: { eligibleQuantity: 100 } },
  ])("classifies malformed lookup input without exposing evidence: %j", input => {
    expectPreviewError(() => service.lookup(input), "RETURN_PREVIEW_INPUT_INVALID", 400);
  });

  it("validates every public sample output and keeps internal identities out of the DTO", () => {
    for (const scenario of service.getState().scenarios) {
      const result = service.lookup({ scenarioId: scenario.id, orderReference: scenario.orderReference });
      expect(returnPreviewOrderSchema.safeParse(result).success).toBe(true);
      expect(result.evaluatedAt).toBe(CUSTOMER_RETURN_PREVIEW_EVALUATED_AT);
      expect(result.message).toContain("fictional order");
      const serialized = JSON.stringify(result);
      for (const forbidden of ["fulfillmentId", "fulfillmentLineItemId", "warehouse", "staff", "evidenceId", "channelId", "orderId", "fictional-allocation:", "gid://"]) {
        expect(serialized).not.toContain(forbidden);
      }
    }
  });

  it("is independent of real time and returns fresh fixtures and public objects", () => {
    const expected = service.lookup(lookup);
    vi.useFakeTimers();
    vi.setSystemTime("2040-01-01T00:00:00.000Z");
    const state = service.getState();
    state.scenarios[0].orderReference = "changed";
    const sample = readCustomerReturnPreviewScenario("split_delivered");
    sample.facts.order.lines[0].purchasedQuantity = 0;
    sample.description.orderReference = "changed";
    const exposed = service.lookup(lookup);
    exposed.lines[0].eligibleQuantity = 0;
    expect(service.lookup(lookup)).toEqual(expected);
    expect(service.getState().scenarios[0].orderReference).toBe("TEST-1001");
  });
});

describe("CustomerReturnPreviewService review", () => {
  it("conserves each selected line across boxes, including split deliveries and same-SKU lines", () => {
    const input = reviewInput();
    const before = structuredClone(input);
    const result = service.review(input);
    expect(returnPreviewReviewSchema.safeParse(result).success).toBe(true);
    expect(result).toMatchObject({ mode: "admin_preview", effects: "none", refundMethod: "manual_shopify", orderReference: "TEST-1001", selectedQuantity: 4 });
    expect(result.parcels.map(parcel => parcel.number)).toEqual([1, 2]);
    expect(result.parcels[0].items.map(item => [item.lineId, item.quantity])).toEqual([["sample-line-1", 1], ["sample-line-2", 1]]);
    expect(result.parcels[1].items).toMatchObject([{ lineId: "sample-line-1", quantity: 2 }]);
    expect(input).toEqual(before);
    expect(Object.keys(result).sort()).toEqual(["effects", "mode", "orderReference", "parcels", "refundMethod", "selectedQuantity"]);
  });

  it("re-evaluates trusted samples on every review, ignoring mutations to previous lookup outputs", () => {
    const exposed = service.lookup(lookup);
    exposed.lines[0].eligibleQuantity = 100;
    const evaluate = vi.spyOn(eligibilityDomain, "evaluateCustomerReturnEligibility");
    const input = reviewInput();
    service.review(input);
    expect(evaluate).toHaveBeenCalledTimes(1);
    input.selections[0].quantity = 100;
    expectPreviewError(() => service.review(input), "RETURN_PREVIEW_QUANTITY_UNAVAILABLE", 409);
    expect(evaluate).toHaveBeenCalledTimes(2);
  });

  it("has no reservation or review state across repeated requests or service instances", () => {
    const first = service.review(reviewInput());
    const expected = structuredClone(first);
    first.parcels[0].items[0].quantity = 99;
    expect(service.review(reviewInput())).toEqual(expected);
    expect(new CustomerReturnPreviewService().review(reviewInput())).toEqual(expected);
    expect(service.lookup(lookup).lines[0].eligibleQuantity).toBe(3);
  });

  it("normalizes the order reference on review too", () => {
    expect(service.review({ ...reviewInput(), orderReference: " # TEST-1001 " }).orderReference).toBe("TEST-1001");
  });

  it.each([null, ...returnPreviewReasonSchema.options])("allows an optional null reason or supported reason: %s", reasonCode => {
    const input = reviewInput();
    input.selections[0].reasonCode = reasonCode;
    expect(service.review(input).selectedQuantity).toBe(4);
  });

  it.each([undefined, "", "unrecognized", "DAMAGED", 7])("rejects malformed or missing reason values: %j", reasonCode => {
    const input = { ...reviewInput(), selections: [{ lineId: "sample-line-1", quantity: 1, reasonCode }] };
    expectPreviewError(() => service.review(input), "RETURN_PREVIEW_INPUT_INVALID", 400);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, "1"])("rejects invalid selection and parcel quantities: %j", quantity => {
    const input = reviewInput();
    expectPreviewError(() => service.review({ ...input, selections: [{ ...input.selections[0], quantity }] }), "RETURN_PREVIEW_INPUT_INVALID", 400);
    expectPreviewError(() => service.review({ ...input, parcels: [{ items: [{ lineId: "sample-line-1", quantity }] }] }), "RETURN_PREVIEW_INPUT_INVALID", 400);
  });

  it.each(["unknown-line", "SAMPLE-SLEEVES", " sample-line-1", "sample-line-1 "])("rejects unknown or nonexact purchased line identity: %s", lineId => {
    const input = reviewInput();
    input.selections[0].lineId = lineId;
    expectPreviewError(() => service.review(input), "RETURN_PREVIEW_SELECTION_INVALID", 400);
  });

  it("rejects duplicate selection lines before constructing a box plan", () => {
    const input = reviewInput();
    input.selections.push({ ...input.selections[0], quantity: 1 });
    expectPreviewError(() => service.review(input), "RETURN_PREVIEW_SELECTION_INVALID", 400);
  });

  it.each([
    ["split_delivered", "TEST-1001", "sample-line-1", 4],
    ["partially_delivered", "TEST-1002", "sample-line-1", 2],
    ["in_transit", "TEST-1003", "sample-line-1", 1],
    ["already_returning", "TEST-1004", "sample-line-1", 2],
    ["already_returning", "TEST-1004", "sample-line-2", 1],
    ["outside_window", "TEST-1005", "sample-line-1", 1],
  ] as const)("blocks unavailable units for %s/%s/%s", (scenarioId, orderReference, lineId, quantity) => {
    expectPreviewError(() => service.review({ scenarioId, orderReference,
      selections: [{ lineId, quantity, reasonCode: null }], parcels: [{ items: [{ lineId, quantity }] }],
    }), "RETURN_PREVIEW_QUANTITY_UNAVAILABLE", 409);
  });

  it.each([
    ["partially_delivered", "TEST-1002", "sample-line-1"],
    ["already_returning", "TEST-1004", "sample-line-1"],
  ] as const)("accepts the one remaining eligible unit in %s", (scenarioId, orderReference, lineId) => {
    expect(service.review({ scenarioId, orderReference,
      selections: [{ lineId, quantity: 1, reasonCode: null }], parcels: [{ items: [{ lineId, quantity: 1 }] }],
    }).selectedQuantity).toBe(1);
  });

  it.each([
    [{ items: [{ lineId: "sample-line-1", quantity: 3 }] }], // Missing selected second line.
    [{ items: [{ lineId: "sample-line-1", quantity: 2 }, { lineId: "sample-line-2", quantity: 1 }] }], // Underpacked.
    [{ items: [{ lineId: "sample-line-1", quantity: 4 }, { lineId: "sample-line-2", quantity: 1 }] }], // Overpacked.
    [{ items: [{ lineId: "sample-line-1", quantity: 2 }, { lineId: "sample-line-2", quantity: 2 }] }], // Equal grand total, wrong lines.
    [{ items: [{ lineId: "sample-line-3", quantity: 1 }] }], // Available but not selected.
    [{ items: [{ lineId: "unknown", quantity: 1 }] }],
    [{ items: [{ lineId: "sample-line-1", quantity: 1 }, { lineId: "sample-line-1", quantity: 2 }, { lineId: "sample-line-2", quantity: 1 }] }],
    [{ items: [{ lineId: "sample-line-1", quantity: Number.MAX_SAFE_INTEGER }] }],
  ].map(parcels => ({ parcels })))("rejects missing, duplicated, unknown, overpacked or unconserved box contents", ({ parcels }) => {
    expectPreviewError(() => service.review({ ...reviewInput(), parcels }), "RETURN_PREVIEW_PARCELS_INVALID", 400);
  });

  it.each([
    null, [], {}, { ...reviewInput(), selections: [] }, { ...reviewInput(), parcels: [] },
    { ...reviewInput(), parcels: [{ items: [] }] },
    { ...reviewInput(), selections: Array.from({ length: MAX_PREVIEW_LINES + 1 }, () => reviewInput().selections[0]) },
    { ...reviewInput(), parcels: Array.from({ length: MAX_PREVIEW_PARCELS + 1 }, () => ({ items: [{ lineId: "sample-line-1", quantity: 1 }] })) },
    { ...reviewInput(), parcels: [{ items: Array.from({ length: MAX_PREVIEW_LINES + 1 }, () => ({ lineId: "sample-line-1", quantity: 1 })) }] },
    { ...reviewInput(), warehouseId: 1 },
    { ...reviewInput(), selections: [{ ...reviewInput().selections[0], eligibleQuantity: 50 }] },
    { ...reviewInput(), parcels: [{ items: [{ lineId: "sample-line-1", quantity: 1, fulfillmentId: "untrusted" }] }] },
    { ...reviewInput(), parcels: [{ items: [{ lineId: "sample-line-1", quantity: 1 }], label: "untrusted" }] },
  ])("validates strict bounded review payloads", input => {
    expectPreviewError(() => service.review(input), "RETURN_PREVIEW_INPUT_INVALID", 400);
  });

  it("does not accept a valid order from a different scenario", () => {
    expectPreviewError(() => service.review({ ...reviewInput(), scenarioId: "partially_delivered" as ReturnPreviewScenarioId }), "RETURN_PREVIEW_ORDER_NOT_FOUND", 404);
  });

  it("classifies internal failures without disclosing provider or fixture evidence", () => {
    vi.spyOn(eligibilityDomain, "evaluateCustomerReturnEligibility").mockImplementation(() => {
      throw new Error("private provider, warehouse and staff evidence");
    });
    expectPreviewError(() => service.review(reviewInput()), "RETURN_PREVIEW_DATA_INVALID", 500);
    expect(() => service.lookup(lookup)).toThrow("The return preview is unavailable.");
  });
});
