import { createHash } from "node:crypto";
import { z } from "zod";
import { customerReturnDeliveryEvidenceSchema, type CustomerReturnEligibilityInput } from "../domain/customer-return-eligibility";
import { customerReturnShopifySnapshotSchema, type CustomerReturnShopifySnapshot } from "./customer-return-shopify-snapshot.ports";
import { customerReturnLocalInspectionSnapshotSchema, type CustomerReturnLocalInspectionSnapshot } from "./customer-return-local-inspection.ports";

type Evidence = CustomerReturnEligibilityInput["order"]["lines"][number]["allocations"][number]["deliveryEvidence"];
type Fulfillment = CustomerReturnShopifySnapshot["fulfillments"][number];
type ProviderLine = Fulfillment["lines"][number];
type Binding = CustomerReturnLocalInspectionSnapshot["fulfillmentBindings"][number];
type PackageItem = CustomerReturnLocalInspectionSnapshot["packageItems"][number];
type CarrierEvent = CustomerReturnLocalInspectionSnapshot["carrierEvents"][number];
export interface CustomerReturnLiveDeliveryProjection { evidence: Evidence; blocked: boolean }
const projectionSchema = z.object({ evidence: z.array(customerReturnDeliveryEvidenceSchema).max(200), blocked: z.boolean() }).strict();
const IN_TRANSIT_EVENTS = new Set(["ATTEMPTED_DELIVERY", "CARRIER_PICKED_UP", "DELAYED", "FAILURE", "IN_TRANSIT", "OUT_FOR_DELIVERY", "READY_FOR_PICKUP"]);
const CARRIER_IN_TRANSIT = new Set(["accepted", "in_transit", "exception", "delivery_attempt", "delivered_to_service_point"]);
const NEGATIVE_DISPLAY = new Set(["CANCELED", "FAILURE", "LABEL_VOIDED", "NOT_DELIVERED"]);

export class CustomerReturnLiveDeliveryError extends Error {
  readonly code = "RETURN_LIVE_DELIVERY_SOURCE_INVALID";
  constructor() { super("Return delivery evidence requires consistent source identities."); this.name = "CustomerReturnLiveDeliveryError"; }
}

/** No SKU joins, tracking-only quantity assignments, staff overrides, or fabricated provider line IDs. */
type DeliveryInput = {
  shopify: CustomerReturnShopifySnapshot;
  local: CustomerReturnLocalInspectionSnapshot;
};
export function projectCustomerReturnLiveDelivery(input: DeliveryInput): ReadonlyMap<string, CustomerReturnLiveDeliveryProjection> {
  return inspectLiveDelivery(input).projections;
}

/** Writable allocation identities use the same complete physical provenance as
 * delivery. Shopify delivery alone cannot invent a WMS receiving partition. */
export function projectCustomerReturnLiveWmsAllocations(input: DeliveryInput) {
  return inspectLiveDelivery(input).wmsAllocations;
}

function inspectLiveDelivery(input: DeliveryInput) {
  const providerResult = customerReturnShopifySnapshotSchema.safeParse(input.shopify);
  const localResult = customerReturnLocalInspectionSnapshotSchema.safeParse(input.local);
  if (!providerResult.success || !localResult.success) invalid();
  const shopify = providerResult.data, local = localResult.data;
  if (local.shop.channelId !== shopify.shop.channelId || local.shop.connectionId !== shopify.shop.connectionId
    || local.shop.shopDomain !== shopify.shop.shopDomain || local.order.channelId !== shopify.shop.channelId
    || providerId(local.order.externalOrderId, "Order") !== shopify.order.id) invalid();
  const localLines = index(local.lines, line => line.omsOrderLineId);
  const wmsItems = index(local.wmsItems, item => item.wmsOrderItemId);
  const packageItems = index(local.packageItems, item => item.physicalShipmentItemId);
  index(local.fulfillmentBindings, binding => `${binding.kind}:${binding.bindingId}`);
  index(local.packageLabels, label => label.linkId);
  index(local.carrierEvents, event => event.eventId);
  const projections = new Map<string, CustomerReturnLiveDeliveryProjection>();
  const providerLines = new Map<string, { fulfillment: Fulfillment; line: ProviderLine }>();
  const allocations = new Map<string, Map<number, { item: PackageItem; quantity: number }>>();
  for (const fulfillment of shopify.fulfillments) {
    for (const line of fulfillment.lines) {
      if (providerLines.has(line.id)) invalid();
      providerLines.set(line.id, { fulfillment, line });
      projections.set(line.id, shopifyProjection(fulfillment, shopify.observedAt));
      allocations.set(line.id, new Map());
    }
  }
  for (const binding of local.fulfillmentBindings) {
    if (binding.provider !== "shopify") continue;
    const fulfillment = shopify.fulfillments.find(candidate => candidate.id === providerId(binding.fulfillmentId, "Fulfillment"));
    // An unlinked attempt cannot establish or contradict the identity of a particular provider allocation.
    if (!fulfillment) continue;
    // Only successful provider allocations consume return entitlement. A canceled
    // historical fulfillment can refer to the same physical item as its successor;
    // counting both would make that history invalidate a current exact mapping.
    // Retain its Shopify evidence, but do not promote carrier evidence or reserve
    // physical capacity for an allocation the eligibility evaluator makes inactive.
    if (fulfillment.status !== "SUCCESS") continue;
    const candidates = bindingCandidates(binding, fulfillment);
    const affected = candidates.length ? candidates : fulfillment.lines;
    const block = () => affected.forEach(line => { projections.get(line.id)!.blocked = true; });
    if (candidates.length !== 1 || binding.sourceChannelId !== shopify.shop.channelId
      || providerId(binding.sourceOrderId, "Order") !== shopify.order.id) {
      block(); continue;
    }
    const line = candidates[0];
    const localLine = binding.omsOrderLineId === null ? undefined : localLines.get(binding.omsOrderLineId);
    const wms = binding.wmsOrderItemId === null ? undefined : wmsItems.get(binding.wmsOrderItemId);
    const item = binding.physicalShipmentItemId === null ? undefined : packageItems.get(binding.physicalShipmentItemId);
    // Missing fields must not hide contradictory fields that ARE present in this complete local read.
    const wmsLine = wms?.omsOrderLineId == null ? undefined : localLines.get(wms.omsOrderLineId);
    if (binding.quantity <= 0 || binding.quantity > line.quantity
      || (binding.omsOrderLineId !== null && (!localLine || providerId(localLine.externalLineItemId, "LineItem") !== line.lineItemId))
      || (binding.wmsOrderItemId !== null && (!wms || !wmsLine || providerId(wmsLine.externalLineItemId, "LineItem") !== line.lineItemId))
      || (wms && ((wms.channelId !== null && wms.channelId !== shopify.shop.channelId)
        || (wms.externalOrderId !== null && providerId(wms.externalOrderId, "Order") !== shopify.order.id)))
      || (binding.physicalShipmentItemId !== null && !item)
      || (item && binding.physicalShipmentId !== null && item.physicalShipmentId !== binding.physicalShipmentId)
      || (item && binding.wmsOrderItemId !== null && item.wmsOrderItemId !== binding.wmsOrderItemId)
      || (item && (item.purpose !== "customer_fulfillment" || item.status !== "shipped"
        || item.replacementForOrderItemId !== null || item.correctionForPhysicalShipmentItemId !== null
        || binding.quantity <= 0 || binding.quantity > item.effectiveQuantity || item.effectiveQuantity > item.originalQuantity))) {
      block(); continue;
    }
    // Null links are missing projection, not contrary evidence. Do not erase a Shopify delivery.
    if (binding.omsOrderLineId === null || binding.wmsOrderItemId === null || binding.physicalShipmentItemId === null
      || binding.physicalShipmentId === null) continue;
    if (!localLine || !wms || !item || providerId(localLine.externalLineItemId, "LineItem") !== line.lineItemId
      || wms.omsOrderLineId !== localLine.omsOrderLineId || (wms.channelId !== null && wms.channelId !== shopify.shop.channelId)
      || (wms.externalLineItemId !== null && providerId(wms.externalLineItemId, "LineItem") !== line.lineItemId)
      || (wms.externalOrderId !== null && providerId(wms.externalOrderId, "Order") !== shopify.order.id)
      || item.wmsOrderItemId !== wms.wmsOrderItemId
      || (item.omsOrderLineId !== null && item.omsOrderLineId !== localLine.omsOrderLineId)
      || item.physicalShipmentId !== binding.physicalShipmentId
      || item.purpose !== "customer_fulfillment" || item.status !== "shipped"
      || item.replacementForOrderItemId !== null || item.correctionForPhysicalShipmentItemId !== null
      || binding.quantity <= 0 || binding.quantity > item.effectiveQuantity || binding.quantity > line.quantity
      || item.effectiveQuantity > item.originalQuantity) {
      block(); continue;
    }
    // Processing/review is workflow state, not evidence that a confirmed delivery
    // was reversed: ingress can retain an exact echo in review after an inventory
    // posting failure. Check all present identities and quantities above, but only
    // accepted bindings may establish a carrier-to-allocation quantity mapping.
    if (!(binding.kind === "receipt" ? ["processed", "ignored"] : ["success", "ignored"]).includes(binding.status)) continue;
    const mapped = allocations.get(line.id)!;
    const existing = mapped.get(item.physicalShipmentItemId);
    if (existing && existing.quantity !== binding.quantity) { block(); continue; }
    // Push and webhook receipt can be exact echoes of the same physical allocation.
    mapped.set(item.physicalShipmentItemId, { item, quantity: binding.quantity });
  }
  const physicalUse = new Map<number, { total: number; capacity: number; lineIds: Set<string> }>();
  for (const [lineId, mapped] of allocations) for (const { item, quantity } of mapped.values()) {
    const use = physicalUse.get(item.physicalShipmentItemId) ?? { total: 0, capacity: item.effectiveQuantity, lineIds: new Set<string>() };
    use.total += quantity; use.lineIds.add(lineId); physicalUse.set(item.physicalShipmentItemId, use);
  }
  for (const use of physicalUse.values()) if (!Number.isSafeInteger(use.total) || use.total > use.capacity) {
    for (const lineId of use.lineIds) projections.get(lineId)!.blocked = true;
  }
  for (const [lineId, mapped] of allocations) {
    const projection = projections.get(lineId)!;
    const { fulfillment, line } = providerLines.get(lineId)!;
    const mappedQuantity = [...mapped.values()].reduce((sum, item) => sum + item.quantity, 0);
    if (!Number.isSafeInteger(mappedQuantity) || mappedQuantity > line.quantity) { projection.blocked = true; continue; }
    if (mapped.size === 0) continue;
    const packageIds = [...new Set([...mapped.values()].map(allocation => allocation.item.physicalShipmentId))].sort((a, b) => a - b);
    const packages = packageIds.map(packageId => carrierPackage(packageId, fulfillment, local));
    if (packages.some(item => item.blocked)) projection.blocked = true;
    if (mappedQuantity !== line.quantity) continue;
    const inTransit = packages.flatMap(item => item.inTransit);
    // Delivered evidence is whole-allocation evidence. A single delivered parcel never grants other parcels' units.
    if (packages.every(item => item.delivered !== null && !item.blocked)) {
      const delivered = packages.map(item => item.delivered!);
      const latest = delivered.reduce((a, b) => Date.parse(a.occurredAt) >= Date.parse(b.occurredAt) ? a : b);
      const eventIds = delivered.map(item => item.evidenceId).sort();
      const fingerprint = createHash("sha256").update(JSON.stringify({ lineId, packageIds, eventIds })).digest("hex");
      projection.evidence.push({ ...latest, evidenceId: `carrier-complete-allocation:${fingerprint}` });
    } else if (inTransit.length > 0) {
      projection.evidence.push(inTransit.reduce((a, b) => Date.parse(a.occurredAt) >= Date.parse(b.occurredAt) ? a : b));
    }
  }
  for (const [lineId, projection] of projections) {
    const delivered = projection.evidence.filter(event => event.status === "delivered");
    if (delivered.length > 0) {
      const firstDeliveredAt = Math.min(...delivered.map(event => Date.parse(event.occurredAt)));
      if (projection.evidence.some(event => event.status === "in_transit" && Date.parse(event.occurredAt) >= firstDeliveredAt)) {
        projection.blocked = true;
      }
    }
    const parsed = projectionSchema.safeParse(projection);
    if (!parsed.success) invalid();
    projections.set(lineId, parsed.data);
  }
  const wmsAllocations = new Map<string, { wmsOrderItemId: number; originalQuantity: number }[]>();
  for (const [lineId, mapped] of allocations) {
    const provider = providerLines.get(lineId)!;
    if (provider.fulfillment.status !== "SUCCESS" || projections.get(lineId)!.blocked
      || [...mapped.values()].reduce((total, value) => total + value.quantity, 0) !== provider.line.quantity) continue;
    const byItem = new Map<number, number>();
    for (const { item, quantity } of mapped.values()) {
      if (item.wmsOrderItemId === null) invalid();
      byItem.set(item.wmsOrderItemId, (byItem.get(item.wmsOrderItemId) ?? 0) + quantity);
    }
    wmsAllocations.set(lineId, [...byItem].sort(([a], [b]) => a - b)
      .map(([wmsOrderItemId, originalQuantity]) => ({ wmsOrderItemId, originalQuantity })));
  }
  return { projections, wmsAllocations };
}

function bindingCandidates(binding: Binding, fulfillment: Fulfillment): ProviderLine[] {
  const purchasedId = providerId(binding.purchasedLineId, "LineItem");
  if (purchasedId === null) return [];
  return fulfillment.lines.filter(line => {
    if (line.lineItemId !== purchasedId) return false;
    if (binding.providerFulfillmentLineId === null) return binding.kind === "push";
    // REST ingress deliberately stored LineItem.id in this untyped legacy receipt column.
    return providerId(binding.providerFulfillmentLineId, "FulfillmentLineItem") === line.id
      || providerId(binding.providerFulfillmentLineId, "LineItem") === line.lineItemId;
  });
}

function shopifyProjection(fulfillment: Fulfillment, observedAt: string): CustomerReturnLiveDeliveryProjection {
  const evidence: Evidence = [];
  if (fulfillment.deliveredAt !== null) evidence.push({ evidenceId: `${fulfillment.id}:deliveredAt`, source: "shopify",
    status: "delivered", occurredAt: fulfillment.deliveredAt, observedAt });
  if (fulfillment.inTransitAt !== null) evidence.push({ evidenceId: `${fulfillment.id}:inTransitAt`, source: "shopify",
    status: "in_transit", occurredAt: fulfillment.inTransitAt, observedAt });
  // The evaluator needs the first delivery and last contrary event. Historical transit before delivery is not a conflict.
  const delivered = fulfillment.events.filter(event => event.status === "DELIVERED")
    .sort((a, b) => Date.parse(a.happenedAt) - Date.parse(b.happenedAt) || compareText(a.id, b.id))[0];
  const transit = fulfillment.events.filter(event => IN_TRANSIT_EVENTS.has(event.status))
    .sort((a, b) => Date.parse(b.happenedAt) - Date.parse(a.happenedAt) || compareText(a.id, b.id))[0];
  if (delivered) evidence.push({ evidenceId: delivered.id, source: "shopify", status: "delivered", occurredAt: delivered.happenedAt, observedAt });
  if (transit) evidence.push({ evidenceId: transit.id, source: "shopify", status: "in_transit", occurredAt: transit.happenedAt, observedAt });
  return { evidence, blocked: fulfillment.displayStatus !== null && NEGATIVE_DISPLAY.has(fulfillment.displayStatus) };
}

function carrierPackage(packageId: number, fulfillment: Fulfillment, local: CustomerReturnLocalInspectionSnapshot): {
  delivered: Evidence[number] | null; inTransit: Evidence; blocked: boolean;
} {
  const empty = { delivered: null, inTransit: [], blocked: false };
  const linked = local.packageLabels.filter(label => label.physicalShipmentId === packageId);
  if (linked.length === 0) return empty;
  const candidates = linked.filter(label => (label.status === "active" || label.status === "unknown") && label.voidedAt === null);
  const byLabel = new Map<number, typeof candidates[number]>();
  for (const label of candidates) {
    const previous = byLabel.get(label.labelId);
    if (previous && JSON.stringify({ ...previous, linkId: 0 }) !== JSON.stringify({ ...label, linkId: 0 })) return { ...empty, blocked: true };
    byLabel.set(label.labelId, label);
  }
  if (byLabel.size !== 1) return { ...empty, blocked: true };
  const label = [...byLabel.values()][0];
  if (label.direction !== "outbound" || label.status !== "active") return { ...empty, blocked: true };
  const tracking = normalizeTracking(label.trackingNumber);
  if (!tracking || tracking !== label.normalizedTrackingNumber) return { ...empty, blocked: true };
  const providerTracking = fulfillment.tracking.map(item => normalizeTracking(item.number)).filter((item): item is string => item !== null);
  if (providerTracking.length > 0 && !providerTracking.includes(tracking)) return { ...empty, blocked: true };
  const events = local.carrierEvents.filter(event => event.labelId === label.labelId);
  if (events.length === 0) return empty;
  const sorted = [...events].sort((a, b) => eventTime(b) - eventTime(a) || Date.parse(b.receivedAt) - Date.parse(a.receivedAt) || b.eventId - a.eventId);
  const latest = sorted[0];
  if (latest.dispatchEvidence === "review") return { ...empty, blocked: true };
  const deliveries = events.filter(event => event.canonicalStatus === "delivered" && event.dispatchEvidence === "confirmed"
    && (event.actualDeliveryAt !== null || event.occurredAt !== null))
    .sort((a, b) => Date.parse(a.occurredAt ?? a.actualDeliveryAt!) - Date.parse(b.occurredAt ?? b.actualDeliveryAt!) || a.eventId - b.eventId);
  const transit = sorted.find(event => CARRIER_IN_TRANSIT.has(event.canonicalStatus) && event.occurredAt !== null);
  if (latest.canonicalStatus === "delivered" && latest.dispatchEvidence !== "confirmed") return { ...empty, blocked: true };
  if (deliveries.length > 0) {
    const first = deliveries[0];
    // Match the carrier normalizer's authority: the canonical event instant wins;
    // shipment-level actualDeliveryAt is only a fallback when no event time exists.
    const occurredAt = first.occurredAt ?? first.actualDeliveryAt!;
    if (transit && Date.parse(transit.occurredAt!) >= Date.parse(occurredAt)) return { ...empty, blocked: true };
    // A later unknown observation is not evidence that an already confirmed delivery was reversed.
    return { delivered: carrierEvidence(first, occurredAt, local.observedAt, "delivered"), inTransit: [], blocked: false };
  }
  return { delivered: null, inTransit: transit ? [carrierEvidence(transit, transit.occurredAt!, local.observedAt, "in_transit")] : [], blocked: false };
}

function carrierEvidence(event: CarrierEvent, occurredAt: string, observedAt: string, status: "delivered" | "in_transit"): Evidence[number] {
  return { evidenceId: `carrier-event:${event.eventId}:match:${event.matchId}:label:${event.labelId}`, source: "carrier", occurredAt, observedAt, status };
}

function eventTime(event: CarrierEvent): number { return Date.parse(event.occurredAt ?? event.receivedAt); }
function compareText(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
function normalizeTracking(value: string | null): string | null { return value?.replace(/[^a-z0-9]/gi, "").toUpperCase() || null; }
function providerId(value: string | null, resource: string): string | null {
  if (value === null) return null;
  const match = new RegExp(`^(?:gid://shopify/${resource}/)?([1-9]\\d*)$`).exec(value);
  return match ? `gid://shopify/${resource}/${match[1]}` : null;
}
function index<T, K extends string | number>(rows: readonly T[], key: (row: T) => K): Map<K, T> {
  const result = new Map<K, T>();
  for (const row of rows) { const id = key(row); if (result.has(id)) invalid(); result.set(id, row); }
  return result;
}
function invalid(): never { throw new CustomerReturnLiveDeliveryError(); }
