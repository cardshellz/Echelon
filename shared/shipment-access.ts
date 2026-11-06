import { z } from "zod";
const nullableText = z.string().nullable();
export const outboundShipmentRowSchema = z.object({
  id: z.number().int().positive(), orderId: z.number().int().nullable(),
  orderNumber: nullableText, customerName: nullableText, channelName: nullableText,
  status: z.string(), carrier: nullableText, trackingNumber: nullableText,
  trackingUrl: nullableText, shippedAt: nullableText,
  carrierCostCents: z.number().int().safe().nullable().optional(),
});
export const outboundShipmentListSchema = z.object({
  rows: z.array(outboundShipmentRowSchema), total: z.number().int().nonnegative(),
  summary: z.object({ byCarrier: z.array(z.object({ carrier: nullableText, count: z.number().int().nonnegative() })),
    byStatus: z.array(z.object({ status: z.string(), count: z.number().int().nonnegative() })) }),
});
export type OutboundShipmentsResponse = z.infer<typeof outboundShipmentListSchema>;
export const shipmentOrderContextSchema = z.object({
  shipmentId: z.number().int().positive(),
  order: z.object({
    orderNumber: z.string(), customerName: z.string(), warehouseStatus: z.string(), onHold: z.boolean(),
    items: z.array(z.object({ id: z.number().int().positive(), sku: z.string(), name: z.string(),
      quantity: z.number().int(), pickedQuantity: z.number().int(), status: z.string() })).max(200),
    hasMoreItems: z.boolean(),
  }).nullable(),
});
export type ShipmentOrderContext = z.infer<typeof shipmentOrderContextSchema>;
