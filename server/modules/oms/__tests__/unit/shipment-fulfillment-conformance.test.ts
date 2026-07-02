import { describe, expect, it } from "vitest";

type ChannelProvider = "shopify" | "ebay";
type ShippingProvider = "shipstation" | "internal_shipping_engine";

type ConformanceInvariant =
  | "oms_line_authority"
  | "planner_owns_shipment_requests"
  | "shipping_adapter_cannot_invent_lines"
  | "shipping_engine_order_is_not_physical_shipment"
  | "physical_shipment_idempotency"
  | "physical_shipment_item_authority"
  | "channel_push_from_physical_shipment"
  | "channel_push_idempotency"
  | "ambiguous_provider_event_requires_review";

interface ExpectedCanonicalShape {
  fulfillmentPlans: number;
  shipmentRequests: number;
  shippingEngineOrders: number;
  physicalShipments: number;
  channelFulfillmentPushes: number;
}

interface ConformanceScenario {
  id: string;
  title: string;
  productionExamples: string[];
  channelProvider: ChannelProvider;
  shippingProvider: ShippingProvider;
  description: string;
  expected: ExpectedCanonicalShape;
  requiredInvariants: ConformanceInvariant[];
  currentGap: string;
}

const REQUIRED_INVARIANTS: ConformanceInvariant[] = [
  "oms_line_authority",
  "planner_owns_shipment_requests",
  "shipping_adapter_cannot_invent_lines",
  "shipping_engine_order_is_not_physical_shipment",
  "physical_shipment_idempotency",
  "physical_shipment_item_authority",
  "channel_push_from_physical_shipment",
  "channel_push_idempotency",
  "ambiguous_provider_event_requires_review",
];

const CONFORMANCE_SCENARIOS: ConformanceScenario[] = [
  {
    id: "shopify-single-package",
    title: "Shopify order shipped as one physical package",
    productionExamples: ["baseline-shape"],
    channelProvider: "shopify",
    shippingProvider: "shipstation",
    description:
      "A normal Shopify order should produce one plan, one shipment request, one shipping-engine order, one physical shipment, and one Shopify fulfillment push.",
    expected: {
      fulfillmentPlans: 1,
      shipmentRequests: 1,
      shippingEngineOrders: 1,
      physicalShipments: 1,
      channelFulfillmentPushes: 1,
    },
    requiredInvariants: [
      "oms_line_authority",
      "planner_owns_shipment_requests",
      "physical_shipment_idempotency",
      "channel_push_from_physical_shipment",
      "channel_push_idempotency",
    ],
    currentGap:
      "Current runtime stores shipping engine identity, physical shipment tracking, and Shopify fulfillment id on wms.outbound_shipments.",
  },
  {
    id: "shopify-one-engine-order-multiple-packages",
    title: "Shopify order split into multiple physical packages by the shipping engine",
    productionExamples: ["#59381", "#59409", "#59540", "#59551"],
    channelProvider: "shopify",
    shippingProvider: "shipstation",
    description:
      "One shipping-engine order can emit multiple physical shipment events. Each physical shipment must push its own mapped tracking to Shopify without colliding on provider order id.",
    expected: {
      fulfillmentPlans: 1,
      shipmentRequests: 1,
      shippingEngineOrders: 1,
      physicalShipments: 2,
      channelFulfillmentPushes: 2,
    },
    requiredInvariants: [
      "oms_line_authority",
      "shipping_engine_order_is_not_physical_shipment",
      "physical_shipment_idempotency",
      "physical_shipment_item_authority",
      "channel_push_from_physical_shipment",
      "channel_push_idempotency",
    ],
    currentGap:
      "Current runtime can treat provider order id/key as the active uniqueness boundary while split packages need physical-shipment-level idempotency.",
  },
  {
    id: "same-sku-split-across-packages",
    title: "Same SKU split across multiple physical packages",
    productionExamples: ["#59381", "#59409"],
    channelProvider: "shopify",
    shippingProvider: "shipstation",
    description:
      "When the same SKU appears in multiple packages, fulfillment must map by authorized shipment request item references, not by SKU alone.",
    expected: {
      fulfillmentPlans: 1,
      shipmentRequests: 1,
      shippingEngineOrders: 1,
      physicalShipments: 3,
      channelFulfillmentPushes: 3,
    },
    requiredInvariants: [
      "oms_line_authority",
      "shipping_adapter_cannot_invent_lines",
      "shipping_engine_order_is_not_physical_shipment",
      "physical_shipment_idempotency",
      "physical_shipment_item_authority",
      "channel_push_from_physical_shipment",
    ],
    currentGap:
      "Current fallback behavior can use exact SKU/quantity matching when provider line item keys are absent; that is not enough for ambiguous repeated SKUs.",
  },
  {
    id: "partial-shipment-rest-later",
    title: "Partially shipped order with remaining items shipped later",
    productionExamples: ["#59453"],
    channelProvider: "shopify",
    shippingProvider: "shipstation",
    description:
      "A partially shipped order must retain remaining authorized line quantities and later push tracking for the remaining physical shipment.",
    expected: {
      fulfillmentPlans: 1,
      shipmentRequests: 1,
      shippingEngineOrders: 1,
      physicalShipments: 2,
      channelFulfillmentPushes: 2,
    },
    requiredInvariants: [
      "oms_line_authority",
      "shipping_engine_order_is_not_physical_shipment",
      "physical_shipment_idempotency",
      "physical_shipment_item_authority",
      "channel_push_from_physical_shipment",
      "channel_push_idempotency",
    ],
    currentGap:
      "Current status and Shopify fulfillment state are materialized on overloaded WMS shipment rows, which makes partial follow-up tracking fragile.",
  },
  {
    id: "webhook-replay",
    title: "Duplicate physical shipment webhook replay",
    productionExamples: ["retry-worker-replay"],
    channelProvider: "shopify",
    shippingProvider: "shipstation",
    description:
      "Replaying the same provider physical shipment event must re-read the canonical physical shipment key and perform a no-op or idempotent update.",
    expected: {
      fulfillmentPlans: 1,
      shipmentRequests: 1,
      shippingEngineOrders: 1,
      physicalShipments: 1,
      channelFulfillmentPushes: 1,
    },
    requiredInvariants: [
      "oms_line_authority",
      "physical_shipment_idempotency",
      "channel_push_idempotency",
    ],
    currentGap:
      "Current retry behavior is split across ShipStation notify retries, shipment push retries, and Shopify fulfillment retries without a single physical shipment authority row.",
  },
  {
    id: "ambiguous-provider-item-mapping",
    title: "Provider shipment item keys are missing or ambiguous",
    productionExamples: ["ShipStation shipment items without parseable wms-item lineItemKey"],
    channelProvider: "shopify",
    shippingProvider: "shipstation",
    description:
      "If provider shipment items cannot be mapped deterministically to authorized request items, the system must create a review exception and avoid inventory/channel mutation.",
    expected: {
      fulfillmentPlans: 1,
      shipmentRequests: 1,
      shippingEngineOrders: 1,
      physicalShipments: 0,
      channelFulfillmentPushes: 0,
    },
    requiredInvariants: [
      "shipping_adapter_cannot_invent_lines",
      "ambiguous_provider_event_requires_review",
    ],
    currentGap:
      "Current runtime has repair paths for missing line item keys; the target model needs an explicit review boundary for non-deterministic mappings.",
  },
  {
    id: "ebay-single-package",
    title: "eBay order shipped as one physical package",
    productionExamples: ["recent-ebay-order"],
    channelProvider: "ebay",
    shippingProvider: "shipstation",
    description:
      "eBay tracking push should use the same physical-shipment-driven contract as Shopify, with a different channel adapter only at the final push boundary.",
    expected: {
      fulfillmentPlans: 1,
      shipmentRequests: 1,
      shippingEngineOrders: 1,
      physicalShipments: 1,
      channelFulfillmentPushes: 1,
    },
    requiredInvariants: [
      "oms_line_authority",
      "planner_owns_shipment_requests",
      "physical_shipment_idempotency",
      "channel_push_from_physical_shipment",
      "channel_push_idempotency",
    ],
    currentGap:
      "Current tracking code paths are channel-specific repairs rather than one provider-agnostic physical-shipment push contract.",
  },
  {
    id: "future-internal-shipping-engine",
    title: "Internal shipping engine replaces ShipStation for the same request shape",
    productionExamples: ["future-shipping-engine"],
    channelProvider: "shopify",
    shippingProvider: "internal_shipping_engine",
    description:
      "Core OMS/WMS fulfillment behavior should not depend on ShipStation-specific order ids, order keys, or split behavior.",
    expected: {
      fulfillmentPlans: 1,
      shipmentRequests: 1,
      shippingEngineOrders: 1,
      physicalShipments: 1,
      channelFulfillmentPushes: 1,
    },
    requiredInvariants: [
      "oms_line_authority",
      "planner_owns_shipment_requests",
      "shipping_engine_order_is_not_physical_shipment",
      "physical_shipment_idempotency",
      "channel_push_from_physical_shipment",
    ],
    currentGap:
      "Current implementation writes ShipStation provider fields directly onto WMS shipment authority rows.",
  },
];

describe("shipment and fulfillment hardening conformance matrix", () => {
  it("has stable unique scenario ids", () => {
    const ids = CONFORMANCE_SCENARIOS.map((scenario) => scenario.id);

    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(id).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    }
  });

  it("covers the live incident order shapes that drove this hardening plan", () => {
    const examples = new Set(
      CONFORMANCE_SCENARIOS.flatMap((scenario) => scenario.productionExamples),
    );

    expect(examples).toEqual(
      expect.objectContaining({
        has: expect.any(Function),
      }),
    );
    expect(examples.has("#59381")).toBe(true);
    expect(examples.has("#59409")).toBe(true);
    expect(examples.has("#59453")).toBe(true);
    expect(examples.has("#59540")).toBe(true);
    expect(examples.has("#59551")).toBe(true);
  });

  it("requires every scenario to document an actionable current runtime gap", () => {
    for (const scenario of CONFORMANCE_SCENARIOS) {
      expect(scenario.currentGap.trim().length).toBeGreaterThan(20);
      expect(scenario.description.trim().length).toBeGreaterThan(20);
      expect(scenario.productionExamples.length).toBeGreaterThan(0);
    }
  });

  it("requires every scenario to preserve OMS line authority or explicitly route ambiguous events to review", () => {
    for (const scenario of CONFORMANCE_SCENARIOS) {
      const protectsAuthority =
        scenario.requiredInvariants.includes("oms_line_authority") ||
        scenario.requiredInvariants.includes("shipping_adapter_cannot_invent_lines") ||
        scenario.requiredInvariants.includes("ambiguous_provider_event_requires_review");

      expect(protectsAuthority, scenario.id).toBe(true);
    }
  });

  it("keeps physical shipment identity separate from shipping engine order identity", () => {
    for (const scenario of CONFORMANCE_SCENARIOS) {
      const canProducePhysicalShipment = scenario.expected.physicalShipments > 0;

      if (canProducePhysicalShipment) {
        expect(
          scenario.requiredInvariants.includes("physical_shipment_idempotency"),
          scenario.id,
        ).toBe(true);
      }

      if (scenario.expected.physicalShipments > scenario.expected.shippingEngineOrders) {
        expect(
          scenario.requiredInvariants.includes("shipping_engine_order_is_not_physical_shipment"),
          scenario.id,
        ).toBe(true);
      }
    }
  });

  it("does not bake ShipStation into the core conformance matrix", () => {
    const providers = new Set(CONFORMANCE_SCENARIOS.map((scenario) => scenario.shippingProvider));

    expect(providers.has("shipstation")).toBe(true);
    expect(providers.has("internal_shipping_engine")).toBe(true);
  });

  it("documents every required invariant in at least one scenario", () => {
    const covered = new Set(
      CONFORMANCE_SCENARIOS.flatMap((scenario) => scenario.requiredInvariants),
    );

    for (const invariant of REQUIRED_INVARIANTS) {
      expect(covered.has(invariant), invariant).toBe(true);
    }
  });
});

describe("shipment and fulfillment hardening target runtime behavior", () => {
  for (const scenario of CONFORMANCE_SCENARIOS) {
    it.todo(`${scenario.id}: ${scenario.title}`);
  }
});
