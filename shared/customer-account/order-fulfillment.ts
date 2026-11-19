import { z } from "zod";

export const customerOrderFulfillmentSchema = z
  .object({
    code: z.enum([
      "awaiting_picking",
      "picking",
      "preparing_shipment",
      "partially_shipped",
      "shipped",
      "on_hold",
      "cancelling",
      "cancelled",
      "attention",
      "unavailable",
    ]),
    label: z.string().min(1).max(80),
  })
  .strict();
export type CustomerOrderFulfillment = z.infer<
  typeof customerOrderFulfillmentSchema
>;

const presentation: Readonly<Record<string, CustomerOrderFulfillment>> = {
  pending: { code: "awaiting_picking", label: "Awaiting picking" },
  ready: { code: "awaiting_picking", label: "Awaiting picking" },
  picking: { code: "picking", label: "Being picked" },
  in_progress: { code: "picking", label: "Being picked" },
  picked: { code: "preparing_shipment", label: "Preparing shipment" },
  packing: { code: "preparing_shipment", label: "Preparing shipment" },
  packed: { code: "preparing_shipment", label: "Ready to ship" },
  completed: { code: "preparing_shipment", label: "Ready to ship" },
  ready_to_ship: { code: "preparing_shipment", label: "Ready to ship" },
  partially_shipped: { code: "partially_shipped", label: "Partially shipped" },
  shipped: { code: "shipped", label: "Shipped" },
  on_hold: { code: "on_hold", label: "On hold" },
  cancelled: { code: "cancelled", label: "Cancelled" },
  exception: { code: "attention", label: "Needs attention" },
  awaiting_3pl: { code: "preparing_shipment", label: "Preparing shipment" },
};
const unavailable: CustomerOrderFulfillment = {
  code: "unavailable",
  label: "Status unavailable",
};

/** Present the canonical warehouse lifecycle, independently of edit eligibility.
 * A cancelled partition does not hide another partition still being fulfilled.
 * Unknown or absent evidence must never be presented as "awaiting picking". */
export function presentCustomerOrderFulfillment(
  statuses: readonly string[],
  options: { held?: boolean } = {},
): CustomerOrderFulfillment {
  if (
    !statuses.length ||
    statuses.some((status) => !Object.hasOwn(presentation, status))
  )
    return { ...unavailable };
  const active = statuses.filter((status) => status !== "cancelled");
  if (!active.length) return { ...presentation.cancelled };
  if (active.every((status) => status === "shipped"))
    return { ...presentation.shipped };
  if (
    active.some((status) => ["shipped", "partially_shipped"].includes(status))
  )
    return { ...presentation.partially_shipped };
  if (active.some((status) => status === "exception"))
    return { ...presentation.exception };
  if (options.held || active.some((status) => status === "on_hold"))
    return { ...presentation.on_hold };
  // Report the least advanced active partition; one packed package cannot
  // imply that an untouched partition has finished picking.
  if (active.some((status) => ["pending", "ready"].includes(status)))
    return { ...presentation.ready };
  if (active.some((status) => ["picking", "in_progress"].includes(status)))
    return { ...presentation.picking };
  return active.some((status) =>
    ["picked", "packing", "awaiting_3pl"].includes(status),
  )
    ? { ...presentation.packing }
    : { ...presentation.ready_to_ship };
}

export function presentCustomerOrderLifecycle(
  warehouse: CustomerOrderFulfillment,
  cancelled: boolean,
): CustomerOrderFulfillment {
  // Cancelling warehouse work does not cancel the Shopify order. Keep those
  // facts separate, including legacy orders whose warehouse work was stopped.
  if (warehouse.code === "cancelled" && !cancelled)
    return { code: "attention", label: "Order needs attention" };
  return cancelled &&
    !["cancelled", "shipped", "partially_shipped", "unavailable"].includes(
      warehouse.code,
    )
    ? { code: "cancelling", label: "Cancellation processing" }
    : { ...warehouse };
}

/** Missing warehouse evidence must not replace a known native storefront fact. */
export function knownCustomerOrderFulfillment(
  fulfillment: CustomerOrderFulfillment | undefined,
): CustomerOrderFulfillment | undefined {
  return fulfillment?.code === "unavailable" ? undefined : fulfillment;
}
