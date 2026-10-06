import type { Pool } from "pg";
import { z } from "zod";
import type { OrderEditSnapshot } from "../application/order-edit-provider";
import { OrderEditError } from "../domain/order-edit-error";
import { getOmsLineMaterializableQuantity } from "../../oms/oms-line-authority";
import { canonicalAvailabilityReservationStatusProjectionSchema } from "@shared/types/inventory-availability-claims";

const integer = z.coerce.number().int().nonnegative().safe();
const headerSchema = z.object({
  channel_id: integer,
  external_order_id: z.string(),
  currency: z.literal("USD"),
  total_cents: integer,
  cancelled_at: z.null(),
});
const lineSchema = z.object({
  external_line_item_id: z.string(),
  quantity: integer,
  authority_fulfillable_quantity: integer,
  product_variant_id: integer.nullable(),
});

/** The OMS owner certifies paid current contents before ordinary WMS sync. */
export class OrderEditOmsSynchronizer {
  constructor(
    private readonly pool: Pick<Pool, "query">,
    private readonly wms: {
      syncOmsOrderToWms(orderId: number): Promise<number | null>;
    },
    private readonly reservation: {
      getOrderReservationStatus(orderId: number): Promise<unknown>;
    },
    private readonly projectPaidOrder: (
      omsOrderId: number,
      operationId: string,
      snapshot: OrderEditSnapshot,
    ) => Promise<void>,
  ) {}

  async synchronize(
    omsOrderId: number,
    expected: OrderEditSnapshot,
    operationId: string,
  ): Promise<void> {
    if (
      !expected.fullyPaid ||
      expected.outstandingCents !== 0 ||
      expected.netPaidCents !== expected.totalCents
    ) {
      throw new OrderEditError(
        "ORDER_EDIT_PAYMENT_REQUIRED",
        "Payment must settle before warehouse synchronization.",
      );
    }
    await this.projectPaidOrder(omsOrderId, operationId, expected);
    const raw = (
      await this.pool.query(
        "SELECT channel_id,external_order_id,currency,total_cents,cancelled_at FROM oms.oms_orders WHERE id=$1",
        [omsOrderId],
      )
    ).rows[0];
    const header = headerSchema.safeParse(raw);
    if (
      !header.success ||
      header.data.channel_id !== expected.channelId ||
      header.data.external_order_id.replace(/^gid:\/\/shopify\/Order\//, "") !==
        expected.orderId.replace(/^gid:\/\/shopify\/Order\//, "") ||
      header.data.total_cents !== expected.totalCents
    ) {
      throw new OrderEditError(
        "ORDER_EDIT_OMS_PENDING",
        "Waiting for the Shopify order update to reach Echelon. The order remains held.",
      );
    }
    const rows = z
      .array(lineSchema)
      .parse(
        (
          await this.pool.query(
            "SELECT external_line_item_id,quantity,authority_fulfillable_quantity,product_variant_id FROM oms.oms_order_lines WHERE order_id=$1",
            [omsOrderId],
          )
        ).rows,
      );
    const remaining = new Map(
      expected.lines.map((line) => [
        line.id.replace(/^gid:\/\/shopify\/LineItem\//, ""),
        line.quantity,
      ]),
    );
    const seen = new Set<string>();
    for (const line of rows) {
      const id = line.external_line_item_id.replace(
        /^gid:\/\/shopify\/LineItem\//,
        "",
      );
      const quantity = remaining.get(id) ?? 0;
      if (
        seen.has(id) ||
        // Shopify retains removed units in purchased quantity. Fulfillment is
        // authorized by the certified current quantity, never purchase history.
        line.quantity < quantity ||
        getOmsLineMaterializableQuantity({
          authorityFulfillableQuantity: line.authority_fulfillable_quantity,
        }) !== quantity ||
        (quantity > 0 && line.product_variant_id === null)
      ) {
        throw new OrderEditError(
          "ORDER_EDIT_OMS_LINES_PENDING",
          "Waiting for verified paid item quantities and catalog mapping in Echelon. The order remains held.",
        );
      }
      seen.add(id);
      remaining.delete(id);
    }
    if ([...remaining.values()].some((quantity) => quantity > 0)) {
      throw new OrderEditError(
        "ORDER_EDIT_OMS_LINES_PENDING",
        "Waiting for added items to reach Echelon. The order remains held.",
      );
    }
    await this.wms.syncOmsOrderToWms(omsOrderId);
    const items = z
      .array(
        z.object({
          id: integer,
          order_id: integer,
          quantity: integer,
          product_variant_id: integer.positive(),
          source_variant_id: integer.positive(),
        }),
      )
      .parse(
        (
          await this.pool.query(
            `SELECT oi.id,oi.order_id,oi.quantity,oi.product_variant_id,ol.product_variant_id AS source_variant_id FROM wms.order_items oi
       JOIN oms.oms_order_lines ol ON ol.id=oi.oms_order_line_id
       WHERE ol.order_id=$1 AND oi.status<>'cancelled' AND oi.quantity>0 ORDER BY oi.order_id,oi.id`,
            [omsOrderId],
          )
        ).rows,
      );
    if (
      items.some((item) => item.product_variant_id !== item.source_variant_id)
    ) {
      throw new OrderEditError(
        "ORDER_EDIT_INVENTORY_PENDING",
        "An edited item's warehouse variant does not match the source order.",
      );
    }
    for (const orderId of new Set(items.map((item) => item.order_id))) {
      const parsed =
        canonicalAvailabilityReservationStatusProjectionSchema.safeParse(
          await this.reservation.getOrderReservationStatus(orderId),
        );
      if (
        !parsed.success ||
        parsed.data.orderId !== orderId ||
        parsed.data.claim?.planStatus !== "satisfied"
      ) {
        throw new OrderEditError(
          "ORDER_EDIT_INVENTORY_PENDING",
          "All edited items must have verified inventory allocated before fulfillment resumes.",
        );
      }
      const expectedItems = new Map(
        items
          .filter((item) => item.order_id === orderId)
          .map((item) => [item.id, item]),
      );
      for (const line of parsed.data.claim.lines) {
        const item = expectedItems.get(line.orderItemId);
        if (
          item === undefined ||
          line.targetVariantId !== item.product_variant_id ||
          BigInt(line.requestedQty) !== BigInt(item.quantity) ||
          BigInt(line.openPlannedQty) !== BigInt(item.quantity) ||
          BigInt(line.shortfallQty) !== BigInt(0) ||
          BigInt(line.pickedTargetQty) !== BigInt(0) ||
          BigInt(line.consumedTargetQty) !== BigInt(0)
        ) {
          throw new OrderEditError(
            "ORDER_EDIT_INVENTORY_PENDING",
            "The inventory allocation does not yet match the edited order.",
          );
        }
        expectedItems.delete(line.orderItemId);
      }
      if (expectedItems.size !== 0)
        throw new OrderEditError(
          "ORDER_EDIT_INVENTORY_PENDING",
          "An edited item is missing its inventory allocation.",
        );
    }
    // The warehouse gateway independently verifies final quantities and claims
    // after this call. A webhook arrival alone never releases this operation.
  }
}
