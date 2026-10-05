import { describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

import {
  createFulfillmentPushService,
  type ChannelFulfillmentProviderCommandInput,
  type FulfillmentPushExclusiveRunner,
} from "../../fulfillment-push.service";
import { ChannelFulfillmentProviderError } from "../../../channels/channel-fulfillment-provider.error";
import { DropshipError } from "../../../dropship/domain/errors";
import { shopifyOrderFulfillmentLockId } from "../../shopify-fulfillment-lock";

const dialect = new PgDialect();
const SHIPPED_AT = new Date("2026-10-02T18:30:00.000Z");

function command(
  overrides: Partial<ChannelFulfillmentProviderCommandInput> = {},
): ChannelFulfillmentProviderCommandInput {
  return {
    commandId: 9001,
    omsOrderId: 1013417,
    physicalShipmentId: 4401,
    legacyWmsShipmentIds: [5501],
    trackingNumber: "9400150206217777402897",
    carrier: "USPS",
    trackingUrl: null,
    shippedAt: SHIPPED_AT,
    notifyCustomer: true,
    items: [{
      legacyWmsShipmentId: 5501,
      legacyWmsShipmentItemId: 6601,
      omsOrderLineId: 7701,
      channelOrderLineId: "110588014781-0",
      quantity: 2,
    }],
    ...overrides,
  };
}

interface ShipmentLine {
  shipment_id: number;
  shipment_item_id: number;
  order_item_id: number;
  oms_order_line_id: number;
  oms_order_id: number;
  fulfillment_provider: string | null;
  external_line_item_id: string | null;
  qty: number;
}

function shipmentLinesFor(input: ChannelFulfillmentProviderCommandInput): ShipmentLine[] {
  return input.items.map((item) => ({
    shipment_id: item.legacyWmsShipmentId,
    shipment_item_id: item.legacyWmsShipmentItemId,
    order_item_id: item.legacyWmsShipmentItemId + 1000,
    oms_order_line_id: item.omsOrderLineId,
    oms_order_id: input.omsOrderId,
    fulfillment_provider: "dropship",
    external_line_item_id: item.channelOrderLineId,
    qty: item.quantity,
  }));
}

function database(options: {
  channelProvider?: string;
  shipmentLines?: ShipmentLine[];
} = {}) {
  const queries: string[] = [];
  const events: unknown[] = [];
  const execute = vi.fn(async (query: SQL) => {
    const { sql: text, params } = dialect.sqlToQuery(query);
    queries.push(text);
    if (text.includes("FROM oms.oms_orders oms_order")) {
      return {
        rows: [{
          oms_order_id: params[0],
          channel_id: 61,
          external_order_id: "dropship:12:16-14215-38371",
          channel_provider: options.channelProvider ?? "manual",
          ordered_at: "2026-10-01T15:00:00.000Z",
          oms_created_at: "2026-10-01T15:00:05.000Z",
        }],
      };
    }
    // Ordinary (non-allocation) commands have no persisted allocation proof.
    if (text.includes("FROM oms.channel_fulfillment_pushes AS push")) return { rows: [] };
    if (text.includes("FROM wms.outbound_shipment_items shipment_item")) {
      return { rows: options.shipmentLines ?? [] };
    }
    throw new Error(`Unexpected database query: ${text}`);
  });
  const insert = vi.fn(() => ({
    values: vi.fn(async (event: unknown) => { events.push(event); }),
  }));
  return { db: { execute, insert }, queries, events, insert };
}

function trackingService(result: unknown) {
  return {
    pushForOmsOrder: vi.fn(async () => {
      if (result instanceof Error) throw result;
      return result as never;
    }),
  };
}

function succeededPush(pushId = 31) {
  return {
    status: "succeeded",
    push: {
      pushId,
      storeConnectionId: 12,
      platform: "ebay",
      externalFulfillmentId: "ebay-fulfillment-31",
    },
  };
}

function setup(options: {
  input?: ChannelFulfillmentProviderCommandInput;
  channelProvider?: string;
  shipmentLines?: ShipmentLine[];
  serviceResult?: unknown;
  runExclusive?: FulfillmentPushExclusiveRunner;
} = {}) {
  const input = options.input ?? command();
  const database_ = database({
    channelProvider: options.channelProvider,
    shipmentLines: options.shipmentLines ?? shipmentLinesFor(input),
  });
  const service = createFulfillmentPushService(database_.db, null, {
    ...(options.runExclusive ? { runExclusive: options.runExclusive } : {}),
  });
  const tracking = trackingService(options.serviceResult ?? succeededPush());
  service.setDropshipMarketplaceTrackingService(tracking);
  return { input, service, tracking, ...database_ };
}

describe("pushDropshipTrackingForShipmentCommand", () => {
  it("pushes the exact command lines to the vendor's store, keyed by the command", async () => {
    const { input, service, tracking, events } = setup();

    const result = await service.pushDropshipTrackingForShipmentCommand(input);

    expect(result).toEqual({
      outcome: "success",
      dropshipTrackingPushId: 31,
      externalFulfillmentId: "ebay-fulfillment-31",
      alreadySatisfied: false,
    });
    expect(tracking.pushForOmsOrder).toHaveBeenCalledTimes(1);
    expect(tracking.pushForOmsOrder).toHaveBeenCalledWith({
      omsOrderId: 1013417,
      wmsShipmentId: 5501,
      carrier: "USPS",
      trackingNumber: "9400150206217777402897",
      shippedAt: SHIPPED_AT,
      idempotencyKey: "channel-fulfillment-command:9001",
      lineItems: [{ externalLineItemId: "110588014781-0", quantity: 2 }],
      lastAttempt: false,
    });
    expect(events).toEqual([{
      orderId: 1013417,
      eventType: "tracking_pushed",
      details: {
        provider: "dropship",
        platform: "ebay",
        storeConnectionId: 12,
        dropshipTrackingPushId: 31,
        fulfillmentId: "ebay-fulfillment-31",
        channelFulfillmentCommandId: 9001,
        physicalShipmentId: 4401,
        wmsShipmentIds: [5501],
        trackingNumber: "9400150206217777402897",
        carrier: "USPS",
        lineItems: [{ externalLineItemId: "110588014781-0", quantity: 2 }],
      },
    }]);
  });

  it("passes the worker's last attempt to the dropship push", async () => {
    const { input, service, tracking } = setup();

    await service.pushDropshipTrackingForShipmentCommand(input, { lastAttempt: true });

    expect(tracking.pushForOmsOrder).toHaveBeenCalledWith(expect.objectContaining({ lastAttempt: true }));
  });

  it("sums items per marketplace line, sorts the lines, and names no single shipment for a multi-shipment package", async () => {
    const input = command({
      legacyWmsShipmentIds: [5502, 5501],
      items: [
        { legacyWmsShipmentId: 5501, legacyWmsShipmentItemId: 6601, omsOrderLineId: 7701, channelOrderLineId: "line-b", quantity: 1 },
        { legacyWmsShipmentId: 5502, legacyWmsShipmentItemId: 6602, omsOrderLineId: 7701, channelOrderLineId: "line-b", quantity: 2 },
        { legacyWmsShipmentId: 5502, legacyWmsShipmentItemId: 6603, omsOrderLineId: 7702, channelOrderLineId: "line-a", quantity: 1 },
      ],
    });
    const { service, tracking } = setup({ input });

    await service.pushDropshipTrackingForShipmentCommand(input);

    expect(tracking.pushForOmsOrder).toHaveBeenCalledWith(expect.objectContaining({
      wmsShipmentId: null,
      lineItems: [
        { externalLineItemId: "line-a", quantity: 1 },
        { externalLineItemId: "line-b", quantity: 3 },
      ],
    }));
  });

  it("reports a replayed push as already satisfied and records no second event", async () => {
    const { input, service, events } = setup({
      serviceResult: { ...succeededPush(), status: "already_succeeded" },
    });

    await expect(service.pushDropshipTrackingForShipmentCommand(input)).resolves.toEqual({
      outcome: "ignored",
      dropshipTrackingPushId: 31,
      externalFulfillmentId: "ebay-fulfillment-31",
      alreadySatisfied: true,
    });
    expect(events).toEqual([]);
  });

  it("retries later while another attempt is still pushing", async () => {
    const { input, service } = setup({
      serviceResult: { ...succeededPush(), status: "already_processing" },
    });

    await expect(service.pushDropshipTrackingForShipmentCommand(input)).rejects.toMatchObject({
      name: "ChannelFulfillmentProviderError",
      code: "DROPSHIP_TRACKING_PUSH_IN_PROGRESS",
      failureClass: "transient",
    });
  });

  it("sends an order with no dropship intake to review", async () => {
    const { input, service } = setup({ serviceResult: { status: "not_dropship" } });

    await expect(service.pushDropshipTrackingForShipmentCommand(input)).rejects.toMatchObject({
      code: "DROPSHIP_ORDER_INTAKE_NOT_FOUND",
      failureClass: "permanent",
    });
  });

  it("refuses a success with no push record", async () => {
    const { input, service, events } = setup({ serviceResult: { status: "succeeded" } });

    await expect(service.pushDropshipTrackingForShipmentCommand(input)).rejects.toMatchObject({
      code: "DROPSHIP_TRACKING_RESULT_INVALID",
      failureClass: "permanent",
    });
    expect(events).toEqual([]);
  });

  it("classifies dropship failures with the dropship service's own retry rule", async () => {
    const cases: Array<[unknown, string, "permanent" | "transient"]> = [
      [
        new DropshipError("DROPSHIP_EBAY_TRACKING_HTTP_ERROR", "eBay tracking push failed with HTTP 400.", { retryable: false }),
        "DROPSHIP_EBAY_TRACKING_HTTP_ERROR",
        "permanent",
      ],
      [
        new DropshipError("DROPSHIP_EBAY_TRACKING_HTTP_ERROR", "eBay tracking push failed with HTTP 503.", { retryable: true }),
        "DROPSHIP_EBAY_TRACKING_HTTP_ERROR",
        "transient",
      ],
      [
        new DropshipError("DROPSHIP_EBAY_TRACKING_NETWORK_ERROR", "no response"),
        "DROPSHIP_EBAY_TRACKING_NETWORK_ERROR",
        "transient",
      ],
      [new Error("connection reset"), "DROPSHIP_TRACKING_PUSH_FAILED", "transient"],
    ];
    for (const [failure, code, failureClass] of cases) {
      const { input, service, events } = setup({ serviceResult: failure });
      const error = await service.pushDropshipTrackingForShipmentCommand(input).catch((caught) => caught);
      expect(error).toBeInstanceOf(ChannelFulfillmentProviderError);
      expect(error).toMatchObject({ code, failureClass });
      expect(events).toEqual([]);
    }
  });

  it("never tells a store when the OMS order is not on the internal Dropship channel", async () => {
    const { input, service, tracking } = setup({ channelProvider: "ebay" });

    await expect(service.pushDropshipTrackingForShipmentCommand(input)).rejects.toMatchObject({
      code: "channel_fulfillment_lineage_mismatch",
    });
    expect(tracking.pushForOmsOrder).not.toHaveBeenCalled();
  });

  it("never tells a store when the live shipment no longer matches the command", async () => {
    const input = command();
    const [line] = shipmentLinesFor(input);
    const mismatches: ShipmentLine[][] = [
      [],
      [{ ...line, qty: 1 }],
      [{ ...line, external_line_item_id: "another-line" }],
      // A line the dropship command does not own drops out, so the command no longer matches.
      [{ ...line, fulfillment_provider: "ebay" }],
      [{ ...line, fulfillment_provider: null }],
    ];
    for (const shipmentLines of mismatches) {
      const { service, tracking } = setup({ input, shipmentLines });
      await expect(service.pushDropshipTrackingForShipmentCommand(input)).rejects.toMatchObject({
        code: "channel_fulfillment_lineage_mismatch",
      });
      expect(tracking.pushForOmsOrder).not.toHaveBeenCalled();
    }
  });

  it("sends a label replacement to review instead of adding a second tracking number", async () => {
    const input = command({ trackingReplacement: true });
    const { service, tracking } = setup({ input });

    await expect(service.pushDropshipTrackingForShipmentCommand(input)).rejects.toMatchObject({
      code: "DROPSHIP_TRACKING_REPLACEMENT_UNSUPPORTED",
      failureClass: "permanent",
    });
    expect(tracking.pushForOmsOrder).not.toHaveBeenCalled();
  });

  it("sends a command without a ship date to review", async () => {
    const input = command({ shippedAt: null });
    const { service, tracking } = setup({ input });

    await expect(service.pushDropshipTrackingForShipmentCommand(input)).rejects.toMatchObject({
      code: "DROPSHIP_TRACKING_SHIPPED_AT_REQUIRED",
      failureClass: "permanent",
    });
    expect(tracking.pushForOmsOrder).not.toHaveBeenCalled();
  });

  it("takes the order's fulfillment lock and retries when another writer holds it", async () => {
    const lockIds: number[] = [];
    const held: FulfillmentPushExclusiveRunner = async (lockId) => {
      lockIds.push(lockId);
      return null;
    };
    const { input, service, tracking } = setup({ runExclusive: held });

    await expect(service.pushDropshipTrackingForShipmentCommand(input)).rejects.toMatchObject({
      code: "DROPSHIP_FULFILLMENT_IN_PROGRESS",
      failureClass: "transient",
    });
    expect(lockIds).toEqual([shopifyOrderFulfillmentLockId(1013417)]);
    expect(tracking.pushForOmsOrder).not.toHaveBeenCalled();
  });

  it("rejects invalid command input before any read", async () => {
    const input = command({ items: [] });
    const { service, queries, tracking } = setup({ input });

    await expect(service.pushDropshipTrackingForShipmentCommand(input)).rejects.toMatchObject({
      code: "channel_fulfillment_invalid_input",
    });
    expect(queries).toEqual([]);
    expect(tracking.pushForOmsOrder).not.toHaveBeenCalled();
  });
});
