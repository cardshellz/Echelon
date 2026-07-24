import { describe, expect, it } from "vitest";

import type {
  ChannelFulfillmentCommand,
  ChannelFulfillmentCommandItem,
} from "../../channel-fulfillment-command";
import {
  buildSupplementalChannelFulfillmentScope,
  reconcileChannelFulfillmentCommandSet,
  type ExistingChannelFulfillmentCommandSnapshot,
} from "../../channel-fulfillment-command-reconciliation";

const firstItem: ChannelFulfillmentCommandItem = {
  physicalShipmentItemId: 101,
  shipmentRequestItemId: 201,
  omsOrderLineId: 301,
  channelOrderLineId: "gid://shopify/LineItem/401",
  quantity: 1,
};
const secondItem: ChannelFulfillmentCommandItem = {
  physicalShipmentItemId: 102,
  shipmentRequestItemId: 202,
  omsOrderLineId: 302,
  channelOrderLineId: "gid://shopify/LineItem/402",
  quantity: 2,
};

function command(
  items: readonly ChannelFulfillmentCommandItem[] = [firstItem, secondItem],
): ChannelFulfillmentCommand {
  return {
    commandKey: "fulfillment:v1:shopify:10:20:order",
    requestHash: "incoming-hash",
    omsOrderId: 10,
    physicalShipmentId: 20,
    channelProvider: "shopify",
    channelFulfillmentScopeKey: "order",
    trackingNumber: "1ZEXACT",
    carrier: "UPS",
    trackingUrl: null,
    shippedAt: "2026-07-24T12:00:00.000Z",
    items,
  };
}

function snapshot(
  overrides: Partial<ExistingChannelFulfillmentCommandSnapshot> = {},
): ExistingChannelFulfillmentCommandSnapshot {
  return {
    id: 501,
    commandKey: "fulfillment:v1:shopify:10:20:order",
    requestHash: "prior-hash",
    pushStatus: "success",
    lastErrorCode: null,
    trackingNumber: "1ZEXACT",
    carrier: "ups",
    shippingProvider: "shipstation",
    providerPhysicalShipmentId: "9001",
    items: [firstItem],
    ...overrides,
  };
}

describe("channel fulfillment command-set reconciliation", () => {
  it("keeps an immutable exact subset and returns only uncovered physical items", () => {
    expect(reconcileChannelFulfillmentCommandSet({
      existingCommands: [snapshot()],
      incomingCommand: command(),
      shippingProvider: "shipstation",
      providerPhysicalShipmentId: "9001",
    })).toEqual({
      kind: "compatible",
      coveredItems: [firstItem],
      missingItems: [secondItem],
      requeueCommandIds: [],
    });
  });

  it("requeues only a compatible historical command-request conflict", () => {
    const result = reconcileChannelFulfillmentCommandSet({
      existingCommands: [snapshot({
        pushStatus: "review",
        lastErrorCode: "COMMAND_REQUEST_CONFLICT",
      })],
      incomingCommand: command(),
      shippingProvider: "shipstation",
      providerPhysicalShipmentId: "9001",
    });
    expect(result).toMatchObject({
      kind: "compatible",
      requeueCommandIds: [501],
      missingItems: [secondItem],
    });
  });

  it("fails closed when an immutable item quantity changed", () => {
    const result = reconcileChannelFulfillmentCommandSet({
      existingCommands: [snapshot({
        items: [{ ...firstItem, quantity: 2 }],
      })],
      incomingCommand: command(),
      shippingProvider: "shipstation",
      providerPhysicalShipmentId: "9001",
    });
    expect(result).toMatchObject({
      kind: "conflict",
      reason: "existing_item_is_not_an_exact_subset",
    });
  });

  it("fails closed when two immutable commands cover the same physical item", () => {
    const result = reconcileChannelFulfillmentCommandSet({
      existingCommands: [
        snapshot(),
        snapshot({ id: 502, commandKey: "supplemental", pushStatus: "pending" }),
      ],
      incomingCommand: command(),
      shippingProvider: "shipstation",
      providerPhysicalShipmentId: "9001",
    });
    expect(result).toMatchObject({
      kind: "conflict",
      reason: "physical_item_covered_by_multiple_commands",
    });
  });

  it("fails closed when immutable package identity changed", () => {
    const result = reconcileChannelFulfillmentCommandSet({
      existingCommands: [snapshot({ trackingNumber: "1ZDIFFERENT" })],
      incomingCommand: command(),
      shippingProvider: "shipstation",
      providerPhysicalShipmentId: "9001",
    });
    expect(result).toMatchObject({
      kind: "conflict",
      reason: "immutable_package_identity_changed",
    });
  });

  it("builds the same supplemental scope regardless of item order", () => {
    expect(buildSupplementalChannelFulfillmentScope([firstItem, secondItem]))
      .toBe(buildSupplementalChannelFulfillmentScope([secondItem, firstItem]));
    expect(buildSupplementalChannelFulfillmentScope([firstItem]))
      .not.toBe(buildSupplementalChannelFulfillmentScope([secondItem]));
  });
});
