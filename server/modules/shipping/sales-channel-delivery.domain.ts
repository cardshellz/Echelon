import { z } from "zod";
import {
  packageHistoryDocumentSchema,
  type PackageHistoryDocument,
} from "@shared/shipping/package-history";
import {
  customerReturnShopifySnapshotSchema,
  type CustomerReturnShopifySnapshot,
} from "../returns/application/customer-return-shopify-snapshot.ports";
import {
  normalizeTrackingNumber,
  type CanonicalCarrierTrackingStatus,
} from "./carrier-tracking.domain";
import { packageHistoryHash } from "./package-history.domain";

const positiveId = z.number().int().positive().safe();
const nativeId = z
  .string()
  .regex(/^[1-9][0-9]*$/)
  .max(30);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const instant = z.string().datetime({ offset: true });
const status = z.enum([
  "pre_transit",
  "accepted",
  "in_transit",
  "delivered",
  "exception",
  "delivery_attempt",
  "delivered_to_service_point",
]);
/** Narrow, immutable shipping evidence. No addresses, money, quantities or
 * fulfillment-writing authority are carried into this projection. */
export const salesChannelDeliveryEvidenceSchema = z
  .object({
    version: z.literal(1),
    source: z.literal("shopify_fulfillment"),
    omsOrderId: positiveId,
    channelId: positiveId,
    externalOrderId: nativeId,
    externalCustomerId: nativeId.nullable(),
    connectionId: positiveId,
    shopDomain: z.string().regex(/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/),
    providerReference: nativeId,
    trackingNumber: z.string().trim().min(1).max(200),
    fulfillmentId: nativeId,
    nativeRevision: digest,
    providerObservationHash: digest,
    eventId: z.string().min(1).max(255),
    eventStatus: z.string().min(1).max(50),
    canonicalStatus: status,
    occurredAt: instant,
    observedAt: instant,
  })
  .strict()
  .refine(
    (value) => Date.parse(value.occurredAt) <= Date.parse(value.observedAt),
    "Delivery evidence cannot precede its event.",
  );
export type SalesChannelDeliveryEvidence = z.infer<
  typeof salesChannelDeliveryEvidenceSchema
>;
const eventMapping: Record<string, z.infer<typeof status> | undefined> = {
  ATTEMPTED_DELIVERY: "delivery_attempt",
  CARRIER_PICKED_UP: "accepted",
  DELAYED: "exception",
  DELIVERED: "delivered",
  FAILURE: "exception",
  IN_TRANSIT: "in_transit",
  OUT_FOR_DELIVERY: "in_transit",
  READY_FOR_PICKUP: "delivered_to_service_point",
  LABEL_PRINTED: "pre_transit",
  LABEL_PURCHASED: "pre_transit",
};
const strip = (resource: string, value: string) =>
  value.replace(`gid://shopify/${resource}/`, "");

/** A fulfillment-level event can describe one package only when its tracking
 * and package bindings are unique. FULFILLED/SUCCESS alone proves no delivery. */
export function deriveSalesChannelDeliveryEvidence(
  rawHistory: PackageHistoryDocument,
  providerReference: string,
  rawSnapshot: CustomerReturnShopifySnapshot,
  instantNow: Date,
): SalesChannelDeliveryEvidence[] {
  const history = packageHistoryDocumentSchema.parse(rawHistory);
  const snapshot = customerReturnShopifySnapshotSchema.parse(rawSnapshot);
  const now = z.date().parse(instantNow);
  const owner = history.sourceEvidence;
  if (
    snapshot.shop.channelId !== history.channelId ||
    snapshot.shop.connectionId !== owner.connectionId ||
    snapshot.shop.shopDomain !== owner.shopDomain ||
    strip("Order", snapshot.order.id) !== history.externalOrderId ||
    (owner.externalCustomerId !== null &&
      strip("Customer", snapshot.order.customerId ?? "") !==
        owner.externalCustomerId) ||
    Date.parse(snapshot.observedAt) > now.getTime()
  )
    throw new Error("SALES_CHANNEL_DELIVERY_OWNER_MISMATCH");
  const parcels = history.packages.filter(
    (p) => p.providerShipmentId === providerReference,
  );
  if (parcels.length !== 1)
    throw new Error("SALES_CHANNEL_DELIVERY_PACKAGE_AMBIGUOUS");
  const parcel = parcels[0];
  if (
    history.packages.filter((p) => p.fulfillmentId === parcel.fulfillmentId)
      .length !== 1
  )
    return [];
  const fulfillments = snapshot.fulfillments.filter(
    (f) => strip("Fulfillment", f.id) === parcel.fulfillmentId,
  );
  if (fulfillments.length !== 1)
    throw new Error("SALES_CHANNEL_DELIVERY_FULFILLMENT_CHANGED");
  const fulfillment = fulfillments[0];
  const tracking = [
    ...new Set(
      fulfillment.tracking.flatMap((t) =>
        t.number ? [normalizeTrackingNumber(t.number)] : [],
      ),
    ),
  ];
  if (
    fulfillment.status !== "SUCCESS" ||
    tracking.length !== 1 ||
    tracking[0] !== normalizeTrackingNumber(parcel.trackingNumber)
  )
    return [];
  // Validate that the verified package still represents the same physical lines.
  const physical = new Set(
    snapshot.lines
      .filter((l) => l.requiresShipping)
      .map((l) => strip("LineItem", l.id)),
  );
  const expected = parcel.lines
    .map((l) => [l.externalLineId, l.quantity] as const)
    .sort();
  const actual = fulfillment.lines
    .filter(
      (l) => physical.has(strip("LineItem", l.lineItemId)) && l.quantity > 0,
    )
    .map((l) => [strip("LineItem", l.lineItemId), l.quantity] as const)
    .sort();
  if (packageHistoryHash(expected) !== packageHistoryHash(actual))
    throw new Error("SALES_CHANNEL_DELIVERY_CONTENTS_CHANGED");
  const events = fulfillment.events.flatMap((event) => {
    const canonicalStatus = eventMapping[event.status];
    return canonicalStatus
      ? [
          {
            eventId: event.id,
            eventStatus: event.status,
            canonicalStatus,
            occurredAt: event.happenedAt,
          },
        ]
      : [];
  });
  if (
    fulfillment.displayStatus === "DELIVERED" &&
    fulfillment.deliveredAt &&
    !events.some(
      (e) =>
        e.canonicalStatus === "delivered" &&
        Date.parse(e.occurredAt) === Date.parse(fulfillment.deliveredAt!),
    )
  ) {
    events.push({
      eventId: `${fulfillment.id}:deliveredAt`,
      eventStatus: "DELIVERED",
      canonicalStatus: "delivered",
      occurredAt: fulfillment.deliveredAt,
    });
  }
  return events
    .filter(
      (e) =>
        Date.parse(e.occurredAt) <= now.getTime() &&
        Date.parse(e.occurredAt) <= Date.parse(snapshot.observedAt),
    )
    .map((event) =>
      salesChannelDeliveryEvidenceSchema.parse({
        version: 1,
        source: "shopify_fulfillment",
        omsOrderId: history.omsOrderId,
        channelId: history.channelId,
        externalOrderId: history.externalOrderId,
        externalCustomerId: owner.externalCustomerId,
        connectionId: owner.connectionId,
        shopDomain: owner.shopDomain,
        providerReference,
        trackingNumber: parcel.trackingNumber,
        fulfillmentId: parcel.fulfillmentId,
        nativeRevision: history.nativeRevision,
        providerObservationHash: parcel.providerObservationHash,
        ...event,
        observedAt: snapshot.observedAt,
      }),
    );
}

export interface DatedDeliveryStatus {
  status: CanonicalCarrierTrackingStatus;
  occurredAt: Date | null;
}
export function latestSalesChannelDeliveryEvidence(
  evidence: readonly SalesChannelDeliveryEvidence[],
): SalesChannelDeliveryEvidence | null {
  const priority = (value: string) =>
    value === "exception" || value === "delivery_attempt"
      ? 0
      : value === "delivered"
        ? 1
        : 2;
  return (
    [...evidence].sort(
      (a, b) =>
        Date.parse(b.occurredAt) - Date.parse(a.occurredAt) ||
        priority(a.canonicalStatus) - priority(b.canonicalStatus) ||
        a.eventId.localeCompare(b.eventId),
    )[0] ?? null
  );
}
/** An unknown provider result cannot erase dated delivery proof. For equally
 * dated contradictory evidence, show the issue rather than claiming delivery. */
export function mergeDeliveryStatus(
  carrier: DatedDeliveryStatus | null,
  channel: DatedDeliveryStatus | null,
): CanonicalCarrierTrackingStatus | null {
  if (!channel) return carrier?.status ?? null;
  if (!carrier || carrier.status === "unknown") return channel.status;
  if (!carrier.occurredAt) return carrier.status;
  if (!channel.occurredAt) return carrier.status;
  if (
    carrier.occurredAt.getTime() === channel.occurredAt.getTime() &&
    ["exception", "delivery_attempt"].includes(channel.status)
  )
    return channel.status;
  if (carrier.occurredAt >= channel.occurredAt) return carrier.status;
  return channel.status;
}
