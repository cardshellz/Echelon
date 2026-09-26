import { z } from "zod";

export const CUSTOMER_RETURN_SHOPIFY_API_VERSION = "2026-07" as const;
export const CUSTOMER_RETURN_SHOPIFY_COLLECTION_LIMIT = 200;
const integer = z.number().int().nonnegative().safe();
const positiveInteger = integer.refine(value => value > 0);
export const customerReturnShopifyTimestampSchema = z.string().max(35).datetime({ offset: true })
  .refine(value => Number.isFinite(Date.parse(value)));
export const customerReturnShopifyGidSchema = (resource: string) =>
  z.string().max(255).regex(new RegExp(`^gid://shopify/${resource}/[1-9]\\d*$`));
export const customerReturnShopifyDomainSchema = z.string().max(255)
  .regex(/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/);
const collection = <T extends z.ZodTypeAny>(schema: T) => z.array(schema).max(CUSTOMER_RETURN_SHOPIFY_COLLECTION_LIMIT);

export const customerReturnShopifySelectedShopSchema = z.object({
  channelId: positiveInteger,
  connectionId: positiveInteger,
  shopDomain: customerReturnShopifyDomainSchema,
  displayName: z.string().trim().min(1).max(255),
}).strict();

export const customerReturnShopifySnapshotInputSchema = z.object({
  shop: customerReturnShopifySelectedShopSchema,
  externalOrderId: z.string().max(255).regex(/^(?:gid:\/\/shopify\/Order\/)?[1-9]\d*$/),
}).strict();

// This provider-only address never enters the read-only customer order DTO.
// Incomplete addresses remain readable, but cannot be used to buy postage.
export const customerReturnShopifyAddressSchema = z.object({
  name: z.string().max(200).nullable().default(null),
  phone: z.string().max(50).nullable().default(null),
  company: z.string().max(200).nullable().default(null),
  address1: z.string().max(300).nullable().default(null),
  address2: z.string().max(300).nullable().default(null),
  city: z.string().max(100).nullable().default(null),
  provinceCode: z.string().max(100).nullable().default(null),
  zip: z.string().max(20).nullable().default(null),
  countryCodeV2: z.string().regex(/^[A-Z]{2}$/).nullable(),
}).strict();

export const customerReturnShopifyOrderSchema = z.object({
  id: customerReturnShopifyGidSchema("Order"), name: z.string().min(1).max(255),
  createdAt: customerReturnShopifyTimestampSchema, processedAt: customerReturnShopifyTimestampSchema,
  updatedAt: customerReturnShopifyTimestampSchema, cancelledAt: customerReturnShopifyTimestampSchema.nullable(),
  destinationCountryCode: z.string().regex(/^[A-Z]{2}$/).nullable(),
  shippingAddress: customerReturnShopifyAddressSchema.nullable().default(null),
}).strict();

export const customerReturnShopifyPurchasedLineSchema = z.object({
  id: customerReturnShopifyGidSchema("LineItem"), title: z.string().min(1).max(1000),
  variantTitle: z.string().max(1000).nullable(), sku: z.string().max(255).nullable(),
  quantity: integer, currentQuantity: integer, refundableQuantity: integer, requiresShipping: z.boolean(),
}).strict().superRefine((line, ctx) => {
  if (line.currentQuantity > line.quantity || line.refundableQuantity > line.quantity) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Purchased line quantities are inconsistent." });
  }
});

export const customerReturnShopifyFulfillmentLineSchema = z.object({
  id: customerReturnShopifyGidSchema("FulfillmentLineItem"),
  lineItemId: customerReturnShopifyGidSchema("LineItem"), quantity: integer,
}).strict();
export const customerReturnShopifyFulfillmentEventSchema = z.object({
  id: customerReturnShopifyGidSchema("FulfillmentEvent"),
  status: z.enum(["ATTEMPTED_DELIVERY", "CARRIER_PICKED_UP", "CONFIRMED", "DELAYED", "DELIVERED", "FAILURE",
    "IN_TRANSIT", "LABEL_PRINTED", "LABEL_PURCHASED", "OUT_FOR_DELIVERY", "READY_FOR_PICKUP"]),
  happenedAt: customerReturnShopifyTimestampSchema,
}).strict();
export const customerReturnShopifyFulfillmentSchema = z.object({
  id: customerReturnShopifyGidSchema("Fulfillment"),
  status: z.enum(["CANCELLED", "ERROR", "FAILURE", "SUCCESS", "OPEN", "PENDING"]),
  updatedAt: customerReturnShopifyTimestampSchema,
  deliveredAt: customerReturnShopifyTimestampSchema.nullable(), inTransitAt: customerReturnShopifyTimestampSchema.nullable(),
  displayStatus: z.enum(["ATTEMPTED_DELIVERY", "CANCELED", "CARRIER_PICKED_UP", "CONFIRMED", "DELAYED", "DELIVERED",
    "FAILURE", "FULFILLED", "IN_TRANSIT", "LABEL_PRINTED", "LABEL_PURCHASED", "LABEL_VOIDED", "MARKED_AS_FULFILLED",
    "NOT_DELIVERED", "OUT_FOR_DELIVERY", "PICKED_UP", "READY_FOR_PICKUP", "SUBMITTED"]).nullable(),
  totalQuantity: integer,
  tracking: collection(z.object({ number: z.string().max(255).nullable(), company: z.string().max(255).nullable() }).strict()),
  lines: collection(customerReturnShopifyFulfillmentLineSchema),
  events: collection(customerReturnShopifyFulfillmentEventSchema),
}).strict();
export const customerReturnShopifyNativeReturnLineSchema = z.object({
  id: customerReturnShopifyGidSchema("ReturnLineItem"), fulfillmentLineItemId: customerReturnShopifyGidSchema("FulfillmentLineItem"),
  lineItemId: customerReturnShopifyGidSchema("LineItem"), quantity: integer, processedQuantity: integer, refundedQuantity: integer,
}).strict().superRefine((line, ctx) => {
  if (line.processedQuantity > line.quantity || line.refundedQuantity > line.quantity) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Return line quantities are inconsistent." });
  }
});
export const customerReturnShopifyNativeReturnSchema = z.object({
  id: customerReturnShopifyGidSchema("Return"), status: z.enum(["CANCELED", "CLOSED", "DECLINED", "OPEN", "REQUESTED"]),
  totalQuantity: integer, lines: collection(customerReturnShopifyNativeReturnLineSchema),
}).strict();
export const customerReturnShopifyRefundLineSchema = z.object({
  id: customerReturnShopifyGidSchema("RefundLineItem").nullable(), lineItemId: customerReturnShopifyGidSchema("LineItem"),
  quantity: integer, restockType: z.enum(["CANCEL", "LEGACY_RESTOCK", "NO_RESTOCK", "RETURN"]),
}).strict();
export const customerReturnShopifyRefundSchema = z.object({
  id: customerReturnShopifyGidSchema("Refund"), updatedAt: customerReturnShopifyTimestampSchema,
  returnId: customerReturnShopifyGidSchema("Return").nullable(), lines: collection(customerReturnShopifyRefundLineSchema),
}).strict();
export const customerReturnShopifyReturnableLineSchema = z.object({
  fulfillmentLineItemId: customerReturnShopifyGidSchema("FulfillmentLineItem"),
  lineItemId: customerReturnShopifyGidSchema("LineItem"), quantity: integer,
}).strict();
export const customerReturnShopifyReturnableFulfillmentSchema = z.object({
  id: customerReturnShopifyGidSchema("ReturnableFulfillment"), fulfillmentId: customerReturnShopifyGidSchema("Fulfillment"),
  lines: collection(customerReturnShopifyReturnableLineSchema),
}).strict();

/** Provider observations only. Returnable ceilings do not replace the approved merchant policy. */
export const customerReturnShopifySnapshotSchema = z.object({
  shop: customerReturnShopifySelectedShopSchema.extend({
    shopId: customerReturnShopifyGidSchema("Shop"),
    scopes: z.object({ readOrders: z.literal(true), readAllOrders: z.literal(true), readReturns: z.literal(true) }).strict(),
  }).strict(),
  apiVersion: z.literal(CUSTOMER_RETURN_SHOPIFY_API_VERSION), observedAt: customerReturnShopifyTimestampSchema,
  order: customerReturnShopifyOrderSchema, lines: collection(customerReturnShopifyPurchasedLineSchema),
  fulfillments: collection(customerReturnShopifyFulfillmentSchema), returns: collection(customerReturnShopifyNativeReturnSchema),
  refunds: collection(customerReturnShopifyRefundSchema), returnableFulfillments: collection(customerReturnShopifyReturnableFulfillmentSchema),
}).strict();

export type CustomerReturnShopifySnapshotInput = z.infer<typeof customerReturnShopifySnapshotInputSchema>;
export type CustomerReturnShopifySnapshot = z.infer<typeof customerReturnShopifySnapshotSchema>;
export interface CustomerReturnShopifySnapshotReader {
  read(input: CustomerReturnShopifySnapshotInput): Promise<CustomerReturnShopifySnapshot>;
}

export type CustomerReturnShopifySnapshotErrorCode =
  | "RETURN_SHOPIFY_INPUT_INVALID" | "RETURN_SHOPIFY_CONNECTION_UNAVAILABLE" | "RETURN_SHOPIFY_CONNECTION_CHANGED"
  | "RETURN_SHOPIFY_TRANSPORT_FAILED" | "RETURN_SHOPIFY_HTTP_REJECTED" | "RETURN_SHOPIFY_GRAPHQL_REJECTED"
  | "RETURN_SHOPIFY_VERSION_MISMATCH" | "RETURN_SHOPIFY_SCOPE_MISSING" | "RETURN_SHOPIFY_ORDER_UNAVAILABLE"
  | "RETURN_SHOPIFY_RESPONSE_INVALID" | "RETURN_SHOPIFY_IDENTITY_MISMATCH" | "RETURN_SHOPIFY_PAGINATION_INVALID"
  | "RETURN_SHOPIFY_SNAPSHOT_LIMIT" | "RETURN_SHOPIFY_SNAPSHOT_CHANGED" | "RETURN_SHOPIFY_CLOCK_INVALID";

/** Never attach raw provider errors, IDs, order fields or credentials. */
export class CustomerReturnShopifySnapshotError extends Error {
  readonly status: number;
  constructor(readonly code: CustomerReturnShopifySnapshotErrorCode, readonly failureClass: "permanent" | "transient" = "permanent") {
    super("The Shopify order snapshot could not be verified.");
    this.name = "CustomerReturnShopifySnapshotError";
    this.status = code === "RETURN_SHOPIFY_INPUT_INVALID" ? 400 : code === "RETURN_SHOPIFY_ORDER_UNAVAILABLE" ? 404 : 503;
  }
}
