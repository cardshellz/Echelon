import { createHash } from "node:crypto";

import { z } from "zod";

const canonicalIdentifier = (field: string, maxLength: number) =>
  z.string({ required_error: `${field} is required` })
    .trim()
    .min(1, `${field} must not be blank`)
    .max(maxLength, `${field} exceeds ${maxLength} characters`);

const channelProviderSchema = canonicalIdentifier("channelProvider", 40)
  .transform((value) => value.toLowerCase());

export const authorizedPhysicalShipmentItemSchema = z.object({
  physicalShipmentItemId: z.number().int().positive(),
  shipmentRequestItemId: z.number().int().positive(),
  omsOrderId: z.number().int().positive(),
  omsOrderLineId: z.number().int().positive(),
  channelProvider: channelProviderSchema,
  channelOrderLineId: canonicalIdentifier("channelOrderLineId", 200),
  channelFulfillmentScopeKey: canonicalIdentifier("channelFulfillmentScopeKey", 200)
    .default("order"),
  quantityShipped: z.number().int().positive(),
}).strict();

export const physicalShipmentForChannelFulfillmentSchema = z.object({
  physicalShipmentId: z.number().int().positive(),
  shippingProvider: canonicalIdentifier("shippingProvider", 40)
    .transform((value) => value.toLowerCase()),
  providerPhysicalShipmentId: canonicalIdentifier("providerPhysicalShipmentId", 200),
  trackingNumber: canonicalIdentifier("trackingNumber", 200),
  carrier: canonicalIdentifier("carrier", 100),
  trackingUrl: z.string().trim().url().max(2_000).nullable().default(null),
  shippedAt: z.string().datetime({ offset: true }).nullable().default(null),
  items: z.array(authorizedPhysicalShipmentItemSchema).min(1),
}).strict();

export type AuthorizedPhysicalShipmentItem = z.infer<typeof authorizedPhysicalShipmentItemSchema>;
export type PhysicalShipmentForChannelFulfillment = z.input<typeof physicalShipmentForChannelFulfillmentSchema>;

export interface ChannelFulfillmentCommandItem {
  readonly physicalShipmentItemId: number;
  readonly shipmentRequestItemId: number;
  readonly omsOrderLineId: number;
  readonly channelOrderLineId: string;
  readonly quantity: number;
}

export interface ChannelFulfillmentCommand {
  readonly commandKey: string;
  readonly requestHash: string;
  readonly omsOrderId: number;
  readonly physicalShipmentId: number;
  readonly channelProvider: string;
  readonly channelFulfillmentScopeKey: string;
  readonly trackingNumber: string;
  readonly carrier: string;
  readonly trackingUrl: string | null;
  readonly shippedAt: string | null;
  readonly items: readonly ChannelFulfillmentCommandItem[];
}

export type ChannelFulfillmentPlanningErrorCode =
  | "INVALID_PHYSICAL_SHIPMENT"
  | "DUPLICATE_PHYSICAL_SHIPMENT_ITEM"
  | "CONFLICTING_CHANNEL_PROVIDER"
  | "CONFLICTING_CHANNEL_ORDER_LINE";

export class ChannelFulfillmentPlanningError extends Error {
  readonly code: ChannelFulfillmentPlanningErrorCode;
  readonly context: Readonly<Record<string, unknown>>;

  constructor(
    code: ChannelFulfillmentPlanningErrorCode,
    message: string,
    context: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ChannelFulfillmentPlanningError";
    this.code = code;
    this.context = Object.freeze({ ...context });
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function compareCommandItems(
  left: ChannelFulfillmentCommandItem,
  right: ChannelFulfillmentCommandItem,
): number {
  return left.physicalShipmentItemId - right.physicalShipmentItemId
    || left.omsOrderLineId - right.omsOrderLineId
    || left.channelOrderLineId.localeCompare(right.channelOrderLineId);
}

function buildCommandKey(input: {
  channelProvider: string;
  omsOrderId: number;
  physicalShipmentId: number;
  channelFulfillmentScopeKey: string;
}): string {
  return [
    "fulfillment",
    "v1",
    input.channelProvider,
    input.omsOrderId,
    input.physicalShipmentId,
    input.channelFulfillmentScopeKey,
  ].join(":");
}

/**
 * Derives durable channel commands exclusively from authorized physical-item
 * allocations. The function has no clock, I/O, or provider behavior, so replay
 * of the same package is byte-for-byte deterministic.
 */
export function planChannelFulfillmentCommands(
  input: PhysicalShipmentForChannelFulfillment,
): readonly ChannelFulfillmentCommand[] {
  const parsed = physicalShipmentForChannelFulfillmentSchema.safeParse(input);
  if (!parsed.success) {
    throw new ChannelFulfillmentPlanningError(
      "INVALID_PHYSICAL_SHIPMENT",
      "Physical shipment cannot produce channel fulfillment commands",
      { issues: parsed.error.issues },
    );
  }

  const shipment = parsed.data;
  const seenPhysicalItems = new Set<number>();
  const providerByOmsOrder = new Map<number, string>();
  const channelIdentityByOmsLine = new Map<number, string>();

  for (const item of shipment.items) {
    if (seenPhysicalItems.has(item.physicalShipmentItemId)) {
      throw new ChannelFulfillmentPlanningError(
        "DUPLICATE_PHYSICAL_SHIPMENT_ITEM",
        `Physical shipment item ${item.physicalShipmentItemId} appears more than once`,
        {
          physicalShipmentId: shipment.physicalShipmentId,
          physicalShipmentItemId: item.physicalShipmentItemId,
        },
      );
    }
    seenPhysicalItems.add(item.physicalShipmentItemId);

    const existingProvider = providerByOmsOrder.get(item.omsOrderId);
    if (existingProvider && existingProvider !== item.channelProvider) {
      throw new ChannelFulfillmentPlanningError(
        "CONFLICTING_CHANNEL_PROVIDER",
        `OMS order ${item.omsOrderId} maps to multiple channel providers`,
        {
          omsOrderId: item.omsOrderId,
          providers: [existingProvider, item.channelProvider],
        },
      );
    }
    providerByOmsOrder.set(item.omsOrderId, item.channelProvider);

    const lineIdentity = `${item.channelProvider}:${item.channelOrderLineId}`;
    const existingLineIdentity = channelIdentityByOmsLine.get(item.omsOrderLineId);
    if (existingLineIdentity && existingLineIdentity !== lineIdentity) {
      throw new ChannelFulfillmentPlanningError(
        "CONFLICTING_CHANNEL_ORDER_LINE",
        `OMS order line ${item.omsOrderLineId} maps to conflicting channel line identities`,
        {
          omsOrderLineId: item.omsOrderLineId,
          channelLineIdentities: [existingLineIdentity, lineIdentity],
        },
      );
    }
    channelIdentityByOmsLine.set(item.omsOrderLineId, lineIdentity);
  }

  const groups = new Map<string, {
    omsOrderId: number;
    channelProvider: string;
    channelFulfillmentScopeKey: string;
    items: ChannelFulfillmentCommandItem[];
  }>();

  for (const item of shipment.items) {
    const groupKey = JSON.stringify([
      item.channelProvider,
      item.omsOrderId,
      item.channelFulfillmentScopeKey,
    ]);
    const group = groups.get(groupKey) ?? {
      omsOrderId: item.omsOrderId,
      channelProvider: item.channelProvider,
      channelFulfillmentScopeKey: item.channelFulfillmentScopeKey,
      items: [],
    };

    group.items.push({
      physicalShipmentItemId: item.physicalShipmentItemId,
      shipmentRequestItemId: item.shipmentRequestItemId,
      omsOrderLineId: item.omsOrderLineId,
      channelOrderLineId: item.channelOrderLineId,
      quantity: item.quantityShipped,
    });
    groups.set(groupKey, group);
  }

  const commands = [...groups.values()]
    .sort((left, right) =>
      left.channelProvider.localeCompare(right.channelProvider)
      || left.omsOrderId - right.omsOrderId
      || left.channelFulfillmentScopeKey.localeCompare(right.channelFulfillmentScopeKey))
    .map((group): ChannelFulfillmentCommand => {
      const items = group.items.slice().sort(compareCommandItems);
      const requestHash = sha256(JSON.stringify({
        contractVersion: 1,
        shippingProvider: shipment.shippingProvider,
        providerPhysicalShipmentId: shipment.providerPhysicalShipmentId,
        physicalShipmentId: shipment.physicalShipmentId,
        trackingNumber: shipment.trackingNumber,
        carrier: shipment.carrier,
        trackingUrl: shipment.trackingUrl,
        shippedAt: shipment.shippedAt,
        channelProvider: group.channelProvider,
        omsOrderId: group.omsOrderId,
        channelFulfillmentScopeKey: group.channelFulfillmentScopeKey,
        items,
      }));

      return Object.freeze({
        commandKey: buildCommandKey({
          channelProvider: group.channelProvider,
          omsOrderId: group.omsOrderId,
          physicalShipmentId: shipment.physicalShipmentId,
          channelFulfillmentScopeKey: group.channelFulfillmentScopeKey,
        }),
        requestHash,
        omsOrderId: group.omsOrderId,
        physicalShipmentId: shipment.physicalShipmentId,
        channelProvider: group.channelProvider,
        channelFulfillmentScopeKey: group.channelFulfillmentScopeKey,
        trackingNumber: shipment.trackingNumber,
        carrier: shipment.carrier,
        trackingUrl: shipment.trackingUrl,
        shippedAt: shipment.shippedAt,
        items: Object.freeze(items.map((item) => Object.freeze(item))),
      });
    });

  return Object.freeze(commands);
}
