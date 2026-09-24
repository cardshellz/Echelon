import type { ReturnPortalPreviewState, ReturnPreviewScenarioId } from "../../../../shared/returns/customer-return-preview.contract";
import type { CustomerReturnBoxOption } from "../../../../shared/returns/customer-return-parcel";
import {
  DEFAULT_CUSTOMER_RETURN_WINDOW_DAYS,
  type CustomerReturnEligibilityInput,
} from "../domain/customer-return-eligibility";

// These orders, products and internal evidence identifiers are fictional. The
// fixed instant makes the admin simulation reproducible without a live clock.
export const CUSTOMER_RETURN_PREVIEW_EVALUATED_AT = "2026-09-22T12:00:00.000Z";
const SAMPLE_PURCHASED_AT = "2026-08-20T12:00:00.000Z";
const SAMPLE_EVENT_AT = "2026-09-20T12:00:00.000Z";
const SAMPLE_CHANNEL_ID = 1;

type SampleLine = CustomerReturnEligibilityInput["order"]["lines"][number];
type SampleAllocation = SampleLine["allocations"][number];
type ScenarioDescription = ReturnPortalPreviewState["scenarios"][number];

export interface CustomerReturnPreviewScenario {
  description: ScenarioDescription;
  facts: CustomerReturnEligibilityInput;
  displayLines: { id: string; title: string; variant: string | null; unitWeightGrams: number }[];
  boxOptions: CustomerReturnBoxOption[];
}

const descriptions: readonly ScenarioDescription[] = [
  { id: "split_delivered", title: "Delivered in multiple shipments", orderReference: "TEST-1001",
    description: "Fictional order with one purchased line delivered in two shipments and separate purchased lines sharing a SKU." },
  { id: "partially_delivered", title: "Part of the order has arrived", orderReference: "TEST-1002",
    description: "Fictional order with delivered and in-transit quantities on the same purchased line." },
  { id: "in_transit", title: "Order is still on its way", orderReference: "TEST-1003",
    description: "Fictional order whose items have shipped but have not been delivered." },
  { id: "already_returning", title: "Some items are already returning", orderReference: "TEST-1004",
    description: "Fictional order with existing return claims and other delivered quantities still available." },
  { id: "outside_window", title: "Return window has ended", orderReference: "TEST-1005",
    description: "Fictional delivered order more than 365 days after purchase." },
];

/** Fresh copies prevent one admin's simulation from altering another's sample. */
export function listCustomerReturnPreviewScenarios(): ScenarioDescription[] {
  return descriptions.map(description => ({ ...description }));
}

export function readCustomerReturnPreviewScenario(id: ReturnPreviewScenarioId): CustomerReturnPreviewScenario {
  const description = descriptions.find(candidate => candidate.id === id);
  if (!description) throw new Error("Unknown customer return preview scenario.");
  const lines = buildLines(id);
  return {
    description: { ...description },
    facts: {
      now: CUSTOMER_RETURN_PREVIEW_EVALUATED_AT,
      policy: { channelId: SAMPLE_CHANNEL_ID, version: 1, returnWindowDays: DEFAULT_CUSTOMER_RETURN_WINDOW_DAYS },
      order: {
        orderId: `fictional-order:${description.orderReference}`,
        channelId: SAMPLE_CHANNEL_ID,
        provider: "shopify",
        destinationCountryCode: "US",
        purchasedAt: id === "outside_window" ? "2025-09-21T12:00:00.000Z" : SAMPLE_PURCHASED_AT,
        lines,
      },
    },
    displayLines: lines.map(line => ({
      id: line.lineId,
      title: line.sku === "SAMPLE-STORAGE" ? "Sample card storage box" : "Sample collector sleeves",
      variant: line.sku === "SAMPLE-STORAGE" ? "Black" : "100 count · Clear",
      unitWeightGrams: line.sku === "SAMPLE-STORAGE" ? 250 : 100,
    })),
    // Fictional measurements for each fictional outbound allocation. They are
    // not live carton defaults and must never be applied to real orders.
    boxOptions: lines.flatMap((line, lineIndex) => line.allocations.map((source, allocationIndex) => ({
      id: `sample-box-${lineIndex + 1}-${allocationIndex + 1}`,
      dimensions: line.sku === "SAMPLE-STORAGE"
        ? { lengthMm: 304.8, widthMm: 254, heightMm: 152.4 }
        : { lengthMm: 254, widthMm: 203.2, heightMm: 101.6 },
      items: [{ lineId: line.lineId, quantity: source.quantity }],
    }))),
  };
}

function buildLines(id: ReturnPreviewScenarioId): SampleLine[] {
  switch (id) {
    case "split_delivered":
      return [
        line("sample-line-1", "SAMPLE-SLEEVES", [allocation("split-a", 1), allocation("split-b", 2)]),
        line("sample-line-2", "SAMPLE-SLEEVES", [allocation("split-c", 1)]),
        line("sample-line-3", "SAMPLE-STORAGE", [allocation("split-d", 1)]),
      ];
    case "partially_delivered":
      return [
        line("sample-line-1", "SAMPLE-SLEEVES", [allocation("partial-a", 1), allocation("partial-b", 2, "in_transit")]),
        line("sample-line-2", "SAMPLE-STORAGE", [allocation("partial-c", 2)]),
      ];
    case "in_transit":
      return [line("sample-line-1", "SAMPLE-SLEEVES", [allocation("transit-a", 2, "in_transit")])];
    case "already_returning":
      return [
        line("sample-line-1", "SAMPLE-SLEEVES", [allocation("returning-a", 3)], 2),
        line("sample-line-2", "SAMPLE-STORAGE", [allocation("returning-b", 1)], 1),
        line("sample-line-3", "SAMPLE-SLEEVES", [allocation("returning-c", 1)]),
      ];
    case "outside_window":
      return [line("sample-line-1", "SAMPLE-SLEEVES", [allocation("expired-a", 2)])];
  }
}

function line(id: string, sku: string, allocations: SampleAllocation[], claimedQuantity = 0): SampleLine {
  return {
    lineId: id, sku, requiresShipping: true,
    purchasedQuantity: allocations.reduce((sum, allocation) => sum + allocation.quantity, 0),
    allocations,
    claims: claimedQuantity === 0 ? [] : [{
      claimId: `fictional-claim:${id}`, allocationId: allocations[0].allocationId, quantity: claimedQuantity,
    }],
  };
}

function allocation(id: string, quantity: number, status: "delivered" | "in_transit" = "delivered"): SampleAllocation {
  return {
    allocationId: `fictional-allocation:${id}`,
    fulfillmentId: `fictional-fulfillment:${id}`,
    fulfillmentLineItemId: `fictional-fulfillment-line:${id}`,
    quantity,
    status: "active",
    deliveryEvidence: [{
      evidenceId: `fictional-delivery:${id}`, source: "shopify", status,
      occurredAt: SAMPLE_EVENT_AT, observedAt: CUSTOMER_RETURN_PREVIEW_EVALUATED_AT,
    }],
    staffDeliveryOverride: null,
  };
}
