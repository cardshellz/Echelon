import { z } from "zod";
import { walmartIdentifier } from "@shared/types/walmart-channel";
import { WalmartApiError, type WalmartClient } from "./walmart-client";

const id = walmartIdentifier;
const quantity = z.object({ unitOfMeasurement: z.enum(["EACH", "EA"]), amount: z.string().regex(/^\d+$/)
  .transform(Number).pipe(z.number().int().nonnegative().max(2_147_483_647)) });
const money = z.object({ currency: z.literal("USD"), amount: z.union([z.string(), z.number().finite()]) });
export const walmartOrderSchema = z.object({
  purchaseOrderId: id, customerOrderId: id, customerEmailId: z.string().optional(),
  orderDate: z.number().int().positive().max(8_640_000_000_000_000),
  orderType: z.enum(["REGULAR", "REPLACEMENT", "PREORDER"]).optional(),
  shipNode: z.object({ id, type: z.string() }),
  shippingInfo: z.object({
    phone: z.string().optional(), estimatedShipDate: z.number().int().positive().max(8_640_000_000_000_000),
    methodCode: z.string().min(1),
    postalAddress: z.object({ name: z.string().min(1), address1: z.string().min(1), address2: z.string().nullish(),
      city: z.string().min(1), state: z.string().min(1), postalCode: z.string().min(1), country: z.enum(["US", "USA"]) }),
  }),
  orderLines: z.object({ orderLine: z.array(z.object({
    lineNumber: id, item: z.object({ sku: id, productName: z.string().min(1) }),
    charges: z.object({ charge: z.array(z.object({
      chargeType: z.enum(["PRODUCT", "SHIPPING"]), chargeName: z.string(), chargeAmount: money,
      tax: z.object({ taxAmount: money }).nullish(),
    })).min(1) }),
    orderLineQuantity: quantity,
    orderLineStatuses: z.object({ orderLineStatus: z.array(z.object({
      status: z.enum(["Created", "Acknowledged", "Shipped", "Delivered", "Cancelled", "Refund"]),
      statusQuantity: quantity,
      trackingInfo: z.object({ trackingNumber: z.string().optional(), carrierName: z.object({
        carrier: z.string().nullish(), otherCarrier: z.string().nullish(),
      }).optional() }).nullish(),
    })).min(1) }),
    fulfillment: z.object({ fulfillmentOption: z.string(), shipMethod: z.string().optional() }),
    refund: z.unknown().optional(),
  })).min(1).max(500) }),
}).passthrough();
export type WalmartOrder = z.infer<typeof walmartOrderSchema>;
export type WalmartShipNode = { shipNode: string; shipNodeName: string; nodeType: string; status: string };
export interface WalmartUsApiPort {
  account(): Promise<{ partnerId: string; partnerName: string; nodes: WalmartShipNode[] }>;
  orders(query: URLSearchParams): Promise<{ orders: unknown[]; nextCursor: string | null }>;
  order(id: string): Promise<WalmartOrder>;
  acknowledge(id: string): Promise<WalmartOrder>;
  inventory(sku: string, node: string): Promise<number>;
  setInventory(sku: string, node: string, amount: number): Promise<void>;
  ship(id: string, body: unknown): Promise<void>;
}
function parse<T extends z.ZodTypeAny>(schema: T, value: unknown): z.output<T> {
  const result = schema.safeParse(value);
  if (!result.success) throw new WalmartApiError("WALMART_RESPONSE_INVALID", "Walmart response did not satisfy the verified US contract", false);
  return result.data;
}
export function parseWalmartOrder(value: unknown): WalmartOrder { return parse(walmartOrderSchema, value); }

export class WalmartUsApi implements WalmartUsApiPort {
  constructor(private readonly client: Pick<WalmartClient, "request">) {}
  async account() {
    const profile = parse(z.object({ partner: z.object({ partnerId: id, partnerDisplayName: z.string().min(1) }) }),
      await this.client.request("GET", "/v3/settings/partnerprofile"));
    const nodes = parse(z.array(z.object({ shipNode: id, shipNodeName: z.string(), nodeType: z.string(), status: z.string() })),
      await this.client.request("GET", "/v3/settings/shipping/shipnodes"));
    return { partnerId: profile.partner.partnerId, partnerName: profile.partner.partnerDisplayName, nodes };
  }
  async orders(query: URLSearchParams) {
    const page = parse(z.object({ list: z.object({
      meta: z.object({ nextCursor: z.string().nullish() }),
      elements: z.object({ order: z.array(z.unknown()) }),
    }) }), await this.client.request("GET", `/v3/orders?${query.toString()}`));
    return { orders: page.list.elements.order, nextCursor: page.list.meta.nextCursor || null };
  }
  async order(purchaseOrderId: string) {
    const response = parse(z.object({ order: walmartOrderSchema }), await this.client.request("GET",
      `/v3/orders/${encodeURIComponent(id.parse(purchaseOrderId))}?replacementInfo=true`));
    if (response.order.purchaseOrderId !== purchaseOrderId) throw new WalmartApiError("WALMART_ORDER_MISMATCH", "Walmart returned a different purchase order", false);
    return response.order;
  }
  async acknowledge(purchaseOrderId: string) {
    // The Global 3.1 schema explicitly supports whole-order acknowledgment in US.
    await this.client.request("POST", `/v3/orders/${encodeURIComponent(id.parse(purchaseOrderId))}/acknowledge`);
    return this.order(purchaseOrderId);
  }
  async inventory(sku: string, node: string) {
    const query = new URLSearchParams({ sku: id.parse(sku), shipNode: id.parse(node) });
    const value = parse(z.object({ sku: id, quantity: z.object({ unit: z.literal("EACH"),
      amount: z.number().int().nonnegative().max(2_147_483_647) }) }),
    await this.client.request("GET", `/v3/inventory?${query}`));
    if (value.sku !== sku) throw new WalmartApiError("WALMART_SKU_MISMATCH", "Walmart returned a different inventory SKU", false);
    return value.quantity.amount;
  }
  async setInventory(sku: string, node: string, amount: number) {
    z.number().int().nonnegative().max(2_147_483_647).parse(amount);
    const query = new URLSearchParams({ sku: id.parse(sku), shipNode: id.parse(node) });
    await this.client.request("PUT", `/v3/inventory?${query}`, { sku, quantity: { unit: "EACH", amount } });
    if (await this.inventory(sku, node) !== amount) throw new WalmartApiError("WALMART_INVENTORY_UNCONFIRMED", "Walmart inventory readback differs from the requested quantity", true);
  }
  async ship(purchaseOrderId: string, body: unknown) {
    await this.client.request("POST", `/v3/orders/${encodeURIComponent(id.parse(purchaseOrderId))}/shipping`, body);
  }
}
