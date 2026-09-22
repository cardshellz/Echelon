import { XMLParser, XMLValidator } from "fast-xml-parser";
import { z } from "zod";
import { ChannelFulfillmentProviderError } from "../../channel-fulfillment-provider.error";
import type { EbayShippingFulfillmentRequest, EbayShippingFulfillmentResponse } from "./ebay-types";

const text = z.string().trim().min(1).max(200);
const quantity = z.number().int().positive().max(2_147_483_647);
const lineSchema = z.object({ lineItemId: text, quantity });
const packageSchema = z.object({ trackingNumber: text, shippingCarrierCode: text,
  lineItems: z.array(lineSchema).min(1).max(500) });
const providerPackageSchema = z.object({ fulfillmentId: text, shipmentTrackingNumber: text,
  shippingCarrierCode: text, lineItems: z.array(lineSchema).min(1).max(500) });
const collectionSchema = z.object({ fulfillments: z.array(providerPackageSchema).max(100),
  total: z.number().int().nonnegative().optional(), next: z.string().nullish() });
const orderSchema = z.object({ orderId: text, lineItems: z.array(lineSchema.extend({ legacyItemId: text })).min(1).max(500),
  cancelStatus: z.object({ cancelState: z.literal("NONE_REQUESTED"), cancelRequests: z.array(z.unknown()).length(0) }) });
type Package = z.infer<typeof packageSchema>;
type ProviderPackage = z.infer<typeof providerPackageSchema>;
export interface EbayTrackingReplacementBatch { readonly packages: readonly EbayShippingFulfillmentRequest[] }

function fail(code: string, transient = false): never {
  throw new ChannelFulfillmentProviderError(code, "eBay package tracking replacement requires exact, unchanged line and quantity evidence", transient ? "transient" : "permanent");
}
function lines(value: readonly z.infer<typeof lineSchema>[]): string {
  if (new Set(value.map(line => line.lineItemId)).size !== value.length) fail("EBAY_TRACKING_LINE_IDENTITY_AMBIGUOUS");
  return JSON.stringify([...value].sort((a, b) => a.lineItemId.localeCompare(b.lineItemId)));
}
function totals(packages: readonly Package[]): Map<string, number> {
  const result = new Map<string, number>();
  for (const pkg of packages) {
    lines(pkg.lineItems);
    for (const line of pkg.lineItems) {
      const value = (result.get(line.lineItemId) ?? 0) + line.quantity;
      if (!Number.isSafeInteger(value)) fail("EBAY_TRACKING_QUANTITY_INVALID");
      result.set(line.lineItemId, value);
    }
  }
  return result;
}
function asPackage(pkg: ProviderPackage): Package {
  return { trackingNumber: pkg.shipmentTrackingNumber, shippingCarrierCode: pkg.shippingCarrierCode, lineItems: pkg.lineItems };
}
function signature(packages: readonly Package[]): string {
  return JSON.stringify(packages.map(pkg => [pkg.trackingNumber, pkg.shippingCarrierCode, lines(pkg.lineItems)])
    .sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
}
function xml(value: string): string {
  return value.replace(/[<>&"']/g, character => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[character]!);
}
function array(value: unknown): unknown[] { return value == null ? [] : Array.isArray(value) ? value : [value]; }

/** CompleteSale with OrderID replaces tracking for the entire order. Use only
 * explicit Trading line IDs, mapped bijectively through provider listing IDs
 * within this exact order (never SKU, title, guessed transaction IDs or index).
 * Because CompleteSale marks a line shipped, a partially fulfilled line must
 * remain reviewable. Never upgrade a backorder to shipped to amend tracking.
 * https://developer.ebay.com/devzone/xml/docs/reference/ebay/CompleteSale.html */
export async function replaceEbayPackageTracking(dependencies: {
  orderId: string; current: EbayShippingFulfillmentRequest; previousTrackingNumbers: readonly string[];
  batch: EbayTrackingReplacementBatch; read(path: string): Promise<unknown>;
  create?(): Promise<EbayShippingFulfillmentResponse>;
  trading(call: "GetOrders" | "CompleteSale", body: string): Promise<string>;
}): Promise<EbayShippingFulfillmentResponse> {
  const { orderId, current } = dependencies;
  text.parse(orderId);
  const parsed = z.array(packageSchema).min(1).max(100).safeParse(dependencies.batch.packages);
  if (!parsed.success) fail("EBAY_TRACKING_REPLACEMENT_INVALID");
  const targets = parsed.data;
  const oldTracking = z.array(text).min(1).max(500).parse(dependencies.previousTrackingNumbers);
  const targetTracking = new Set(targets.map(pkg => pkg.trackingNumber));
  if (targetTracking.size !== targets.length || oldTracking.some(value => targetTracking.has(value))) fail("EBAY_TRACKING_REPLACEMENT_INVALID");
  const currentTarget = targets.find(pkg => pkg.trackingNumber === current.trackingNumber);
  if (!currentTarget || signature([currentTarget]) !== signature([packageSchema.parse(current)])) fail("EBAY_TRACKING_REPLACEMENT_INVALID");
  const path = `/sell/fulfillment/v1/order/${encodeURIComponent(orderId)}`;
  const read = async (): Promise<ProviderPackage[]> => {
    const result = collectionSchema.safeParse(await dependencies.read(`${path}/shipping_fulfillment`));
    if (!result.success) fail("EBAY_TRACKING_PACKAGE_QUANTITIES_UNPROVEN");
    const value = result.data;
    if (value.next || (value.total !== undefined && value.total !== value.fulfillments.length)
      || new Set(value.fulfillments.map(pkg => pkg.shipmentTrackingNumber)).size !== value.fulfillments.length
      || new Set(value.fulfillments.map(pkg => pkg.fulfillmentId)).size !== value.fulfillments.length) fail("EBAY_TRACKING_READBACK_INVALID", true);
    for (const pkg of value.fulfillments) lines(pkg.lineItems);
    return value.fulfillments;
  };
  const before = await read();
  const replaced = before.filter(pkg => oldTracking.includes(pkg.shipmentTrackingNumber) || targetTracking.has(pkg.shipmentTrackingNumber));
  const retained = before.filter(pkg => !replaced.includes(pkg));
  const replacedTotals = totals(replaced.map(asPackage));
  const targetTotals = totals(targets);
  if (!before.some(pkg => oldTracking.includes(pkg.shipmentTrackingNumber)) && dependencies.create) {
    // The voided label may never have reached eBay. Admit unsent members one
    // at a time through normal fulfillment creation, only after proving that
    // all batch members plus unaffected packages fit the live order quantities.
    for (const existing of replaced) {
      const target = targets.find(pkg => pkg.trackingNumber === existing.shipmentTrackingNumber);
      if (!target || signature([asPackage(existing)]) !== signature([target])) fail('EBAY_TRACKING_PREDECESSOR_CONFLICT');
    }
    const observed = orderSchema.safeParse(await dependencies.read(path));
    const wanted = totals([...retained.map(asPackage), ...targets]);
    if (!observed.success || observed.data.orderId !== orderId || [...wanted].some(([id, amount]) => {
      const matches = observed.data.lineItems.filter(line => line.lineItemId === id);
      return matches.length !== 1 || amount > matches[0].quantity;
    })) fail('EBAY_TRACKING_PREDECESSOR_CONFLICT');
    const existing = before.find(pkg => pkg.shipmentTrackingNumber === current.trackingNumber);
    return existing ? { fulfillmentId: existing.fulfillmentId } : dependencies.create();
  }
  if (replacedTotals.size !== targetTotals.size || [...targetTotals].some(([id, amount]) => replacedTotals.get(id) !== amount)) fail("EBAY_TRACKING_PREDECESSOR_CONFLICT");
  const desired = [...retained.map(asPackage), ...targets];
  // A lost response is adopted only from exact provider quantities. No POST on
  // replay, including commands for other labels of this same atomic repack.
  if (signature(before.map(asPackage)) === signature(desired)) {
    return { fulfillmentId: before.find(pkg => pkg.shipmentTrackingNumber === current.trackingNumber)!.fulfillmentId };
  }
  const order = orderSchema.safeParse(await dependencies.read(path));
  if (!order.success || order.data.orderId !== orderId) fail("EBAY_TRACKING_ORDER_UNPROVEN");
  const desiredTotals = totals(desired);
  for (const [id] of targetTotals) {
    const matches = order.data.lineItems.filter(line => line.lineItemId === id);
    if (matches.length !== 1 || desiredTotals.get(id) !== matches[0].quantity) fail("EBAY_TRACKING_PARTIAL_LINE_UNSUPPORTED");
  }
  const raw = await dependencies.trading("GetOrders", `<OrderIDArray><OrderID>${xml(orderId)}</OrderID></OrderIDArray><DetailLevel>ReturnAll</DetailLevel>`);
  // Reject DTD/entity declarations and bounded malformed input before parsing.
  if (raw.length > 2_000_000 || /<!DOCTYPE|<!ENTITY/i.test(raw) || XMLValidator.validate(raw) !== true) fail("EBAY_TRACKING_TRADING_READBACK_INVALID");
  const parsedXml: unknown = new XMLParser({ parseTagValue: false, ignoreAttributes: true, removeNSPrefix: true }).parse(raw);
  const envelope = z.object({ GetOrdersResponse: z.object({ Ack: z.enum(["Success", "Warning"]),
    HasMoreOrders: z.enum(["false", "0"]).optional(), OrderArray: z.object({ Order: z.unknown() }) }) }).safeParse(parsedXml);
  if (!envelope.success) fail("EBAY_TRACKING_TRADING_READBACK_INVALID");
  const orders = array(envelope.data.GetOrdersResponse.OrderArray.Order);
  if (orders.length !== 1) fail("EBAY_TRACKING_TRADING_ORDER_AMBIGUOUS");
  const tradingOrder = z.object({ OrderID: z.literal(orderId), TransactionArray: z.object({ Transaction: z.unknown() }) }).safeParse(orders[0]);
  if (!tradingOrder.success) fail("EBAY_TRACKING_TRADING_ORDER_AMBIGUOUS");
  const transactions = z.array(z.object({ OrderLineItemID: text, QuantityPurchased: z.coerce.number().int().positive(),
    Item: z.object({ ItemID: text }) })).min(1).max(500).safeParse(array(tradingOrder.data.TransactionArray.Transaction));
  if (!transactions.success || new Set(transactions.data.map(line => line.OrderLineItemID)).size !== transactions.data.length) fail("EBAY_TRACKING_LINE_IDENTITY_AMBIGUOUS");
  const amendments = [...targetTotals.keys()].sort().map(id => {
    const restLine = order.data.lineItems.find(line => line.lineItemId === id)!;
    const matches = transactions.data.filter(line => line.Item.ItemID === restLine.legacyItemId);
    if (matches.length !== 1 || order.data.lineItems.filter(line => line.legacyItemId === restLine.legacyItemId).length !== 1
      || matches[0].QuantityPurchased !== restLine.quantity) fail("EBAY_TRACKING_LINE_IDENTITY_AMBIGUOUS");
    return { id: matches[0].OrderLineItemID, packages: desired.filter(pkg => pkg.lineItems.some(line => line.lineItemId === id)) };
  });
  const orderAgain = orderSchema.safeParse(await dependencies.read(path));
  if (!orderAgain.success || JSON.stringify(orderAgain.data) !== JSON.stringify(order.data)) fail('EBAY_TRACKING_READBACK_CHANGED', true);
  if (signature((await read()).map(asPackage)) !== signature(before.map(asPackage))) fail("EBAY_TRACKING_READBACK_CHANGED", true);
  for (const amendment of amendments) {
    await dependencies.trading("CompleteSale", `<OrderLineItemID>${xml(amendment.id)}</OrderLineItemID><Shipment>${amendment.packages.map(pkg =>
      `<ShipmentTrackingDetails><ShipmentTrackingNumber>${xml(pkg.trackingNumber)}</ShipmentTrackingNumber><ShippingCarrierUsed>${xml(pkg.shippingCarrierCode)}</ShippingCarrierUsed></ShipmentTrackingDetails>`).join("")}</Shipment>`);
  }
  const after = await read();
  if (signature(after.map(asPackage)) !== signature(desired)) fail("EBAY_TRACKING_AMENDMENT_UNVERIFIED", true);
  return { fulfillmentId: after.find(pkg => pkg.shipmentTrackingNumber === current.trackingNumber)!.fulfillmentId };
}
