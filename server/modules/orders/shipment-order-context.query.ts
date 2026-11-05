import { asc, eq } from "drizzle-orm";
import { orders, orderItems } from "@shared/schema";
import type { db } from "../../db";
import { shipmentOrderContextSchema } from "@shared/shipment-access";
type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
/** Internal Orders projection for the verified shipment relation only.
 * Shipping owns the relationship and admission; this is not an HTTP query for arbitrary orders.
 * No financial, address, email, provider credential or mutation fields.
 */
export async function readShipmentLinkedOrderSummary(tx: Transaction, linkedOrderId: number) {
  const [order] = await tx.select({
    orderNumber: orders.orderNumber, customerName: orders.customerName,
    warehouseStatus: orders.warehouseStatus, onHold: orders.onHold,
  }).from(orders).where(eq(orders.id,linkedOrderId)).limit(1);
  if (!order) return null;
  const rows = await tx.select({
    id: orderItems.id, sku: orderItems.sku, name: orderItems.name, quantity: orderItems.quantity,
    pickedQuantity: orderItems.pickedQuantity, status: orderItems.status,
  }).from(orderItems).where(eq(orderItems.orderId,linkedOrderId)).orderBy(asc(orderItems.id)).limit(201);
  return shipmentOrderContextSchema.shape.order.parse({
    ...order, onHold: order.onHold === 1, items: rows.slice(0,200), hasMoreItems: rows.length > 200,
  });
}
