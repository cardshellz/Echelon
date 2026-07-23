import { describe, expect, it } from "vitest";

import {
  ChannelFulfillmentPlanningError,
  planChannelFulfillmentCommands,
  type PhysicalShipmentForChannelFulfillment,
} from "../../channel-fulfillment-command";

function packageInput(
  overrides: Partial<PhysicalShipmentForChannelFulfillment> = {},
): PhysicalShipmentForChannelFulfillment {
  return {
    physicalShipmentId: 7001,
    shippingProvider: "shipstation",
    providerPhysicalShipmentId: "442503317",
    trackingNumber: "1Z999AA10123456784",
    carrier: "UPS",
    trackingUrl: "https://www.ups.com/track?tracknum=1Z999AA10123456784",
    shippedAt: "2026-07-22T12:00:00.000Z",
    items: [
      {
        physicalShipmentItemId: 8001,
        shipmentRequestItemId: 9001,
        omsOrderId: 1001,
        omsOrderLineId: 1101,
        channelProvider: "shopify",
        channelOrderLineId: "gid://shopify/LineItem/1101",
        channelFulfillmentScopeKey: "gid://shopify/FulfillmentOrder/1201",
        quantityShipped: 2,
      },
    ],
    ...overrides,
  };
}

describe("planChannelFulfillmentCommands", () => {
  it("creates one deterministic command for a single-order package", () => {
    const input = packageInput();

    const first = planChannelFulfillmentCommands(input);
    const replay = planChannelFulfillmentCommands(input);

    expect(first).toEqual(replay);
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      omsOrderId: 1001,
      physicalShipmentId: 7001,
      channelProvider: "shopify",
      channelFulfillmentScopeKey: "gid://shopify/FulfillmentOrder/1201",
      trackingNumber: "1Z999AA10123456784",
      carrier: "UPS",
      shippedAt: "2026-07-22T12:00:00.000Z",
      items: [
        {
          physicalShipmentItemId: 8001,
          shipmentRequestItemId: 9001,
          omsOrderLineId: 1101,
          channelOrderLineId: "gid://shopify/LineItem/1101",
          quantity: 2,
        },
      ],
    });
    expect(first[0].commandKey).toBe(
      "fulfillment:v1:shopify:1001:7001:gid://shopify/FulfillmentOrder/1201",
    );
    expect(first[0].requestHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("creates independent commands when one physical package combines OMS orders", () => {
    const commands = planChannelFulfillmentCommands(packageInput({
      items: [
        {
          physicalShipmentItemId: 8001,
          shipmentRequestItemId: 9001,
          omsOrderId: 1001,
          omsOrderLineId: 1101,
          channelProvider: "shopify",
          channelOrderLineId: "gid://shopify/LineItem/1101",
          channelFulfillmentScopeKey: "gid://shopify/FulfillmentOrder/1201",
          quantityShipped: 1,
        },
        {
          physicalShipmentItemId: 8002,
          shipmentRequestItemId: 9002,
          omsOrderId: 1002,
          omsOrderLineId: 1102,
          channelProvider: "shopify",
          channelOrderLineId: "gid://shopify/LineItem/1102",
          channelFulfillmentScopeKey: "gid://shopify/FulfillmentOrder/1202",
          quantityShipped: 3,
        },
      ],
    }));

    expect(commands).toHaveLength(2);
    expect(commands.map((command) => command.omsOrderId)).toEqual([1001, 1002]);
    expect(new Set(commands.map((command) => command.commandKey)).size).toBe(2);
    expect(commands.every((command) => command.physicalShipmentId === 7001)).toBe(true);
  });

  it("creates separate commands for multiple channel fulfillment scopes in one order", () => {
    const commands = planChannelFulfillmentCommands(packageInput({
      items: [
        {
          physicalShipmentItemId: 8001,
          shipmentRequestItemId: 9001,
          omsOrderId: 1001,
          omsOrderLineId: 1101,
          channelProvider: "shopify",
          channelOrderLineId: "gid://shopify/LineItem/1101",
          channelFulfillmentScopeKey: "gid://shopify/FulfillmentOrder/1201",
          quantityShipped: 1,
        },
        {
          physicalShipmentItemId: 8002,
          shipmentRequestItemId: 9002,
          omsOrderId: 1001,
          omsOrderLineId: 1102,
          channelProvider: "shopify",
          channelOrderLineId: "gid://shopify/LineItem/1102",
          channelFulfillmentScopeKey: "gid://shopify/FulfillmentOrder/1202",
          quantityShipped: 1,
        },
      ],
    }));

    expect(commands).toHaveLength(2);
    expect(commands.map((command) => command.channelFulfillmentScopeKey)).toEqual([
      "gid://shopify/FulfillmentOrder/1201",
      "gid://shopify/FulfillmentOrder/1202",
    ]);
  });

  it("preserves exact physical allocation when the same OMS line spans package items", () => {
    const commands = planChannelFulfillmentCommands(packageInput({
      items: [
        {
          physicalShipmentItemId: 8002,
          shipmentRequestItemId: 9002,
          omsOrderId: 1001,
          omsOrderLineId: 1101,
          channelProvider: "shopify",
          channelOrderLineId: "gid://shopify/LineItem/1101",
          channelFulfillmentScopeKey: "gid://shopify/FulfillmentOrder/1201",
          quantityShipped: 1,
        },
        {
          physicalShipmentItemId: 8001,
          shipmentRequestItemId: 9001,
          omsOrderId: 1001,
          omsOrderLineId: 1101,
          channelProvider: "shopify",
          channelOrderLineId: "gid://shopify/LineItem/1101",
          channelFulfillmentScopeKey: "gid://shopify/FulfillmentOrder/1201",
          quantityShipped: 2,
        },
      ],
    }));

    expect(commands).toHaveLength(1);
    expect(commands[0].items).toEqual([
      expect.objectContaining({ physicalShipmentItemId: 8001, quantity: 2 }),
      expect.objectContaining({ physicalShipmentItemId: 8002, quantity: 1 }),
    ]);
  });

  it("does not mutate caller-owned input while normalizing provider identity", () => {
    const input = packageInput({ shippingProvider: " ShipStation " });
    const original = structuredClone(input);

    const commands = planChannelFulfillmentCommands(input);

    expect(input).toEqual(original);
    expect(commands[0].channelProvider).toBe("shopify");
  });

  it.each([
    {
      title: "a blank physical provider id",
      input: packageInput({ providerPhysicalShipmentId: " " }),
    },
    {
      title: "a blank tracking number",
      input: packageInput({ trackingNumber: " " }),
    },
    {
      title: "a non-positive quantity",
      input: packageInput({
        items: [{ ...packageInput().items[0], quantityShipped: 0 }],
      }),
    },
    {
      title: "a missing channel line identity",
      input: packageInput({
        items: [{ ...packageInput().items[0], channelOrderLineId: " " }],
      }),
    },
    {
      title: "an empty item allocation",
      input: packageInput({ items: [] }),
    },
  ])("rejects $title before a command can be created", ({ input }) => {
    expect(() => planChannelFulfillmentCommands(input)).toThrowError(
      expect.objectContaining({
        code: "INVALID_PHYSICAL_SHIPMENT",
      }),
    );
  });

  it("rejects duplicate physical item identities", () => {
    const item = packageInput().items[0];

    expect(() => planChannelFulfillmentCommands(packageInput({ items: [item, item] })))
      .toThrowError(expect.objectContaining({
        code: "DUPLICATE_PHYSICAL_SHIPMENT_ITEM",
      }));
  });

  it("rejects conflicting channel providers for one OMS order", () => {
    const first = packageInput().items[0];
    const second = {
      ...first,
      physicalShipmentItemId: 8002,
      shipmentRequestItemId: 9002,
      channelProvider: "ebay",
      channelOrderLineId: "ebay-line-1101",
    };

    expect(() => planChannelFulfillmentCommands(packageInput({ items: [first, second] })))
      .toThrowError(expect.objectContaining({
        code: "CONFLICTING_CHANNEL_PROVIDER",
      }));
  });

  it("returns classified errors with immutable audit context", () => {
    try {
      planChannelFulfillmentCommands(packageInput({ items: [] }));
      throw new Error("expected planner to reject empty allocation");
    } catch (error) {
      expect(error).toBeInstanceOf(ChannelFulfillmentPlanningError);
      const classified = error as ChannelFulfillmentPlanningError;
      expect(classified.code).toBe("INVALID_PHYSICAL_SHIPMENT");
      expect(Object.isFrozen(classified.context)).toBe(true);
    }
  });
});
