import type { OrderEditOperation } from "@shared/order-edits/order-edit.contract";
import type { CustomerOrderFulfillment } from "@shared/customer-account/order-fulfillment";
import type { CustomerOrderProgress } from "@shared/customer-account/order-progress";

/** A shipping-owned package/dispatch fact wins over stale edit eligibility. */
export function customerOrderShippingCutoff(input: {
  fulfillment?: CustomerOrderFulfillment; progress?: CustomerOrderProgress | null; nativeFulfillment?: string;
}): boolean {
  return input.nativeFulfillment === "fulfilled" ||
    ["shipped", "partially_shipped"].includes(input.fulfillment?.code ?? "") ||
    Boolean(input.progress?.delivery);
}

const cutoffCodes = new Set([
  "ORDER_EDIT_PROVIDER_NOT_EDITABLE",
  "ORDER_EDIT_PROVIDER_LABEL_EXISTS",
  "ORDER_EDIT_SHIPMENT_NOT_EDITABLE",
  "ORDER_EDIT_PICKING_CUTOFF",
  "ORDER_EDIT_INELIGIBLE",
  "ORDER_EDIT_SHIPMENT_CHANGED",
  "ORDER_EDIT_PROVIDER_IDENTITY_UNVERIFIED",
  "ORDER_EDIT_HELD_PARTITION_UNVERIFIED",
  "ORDER_EDIT_PROVIDER_SPLIT_UNVERIFIED",
]);

/** A proven unsubmitted cutoff is not a failed price calculation. Submitted or
 * uncertain commands must retain the existing observation/recovery flow. */
export function customerOrderEditUnavailable(
  operation: OrderEditOperation | null,
): boolean {
  return Boolean(
    operation &&
      operation.status === "review_required" &&
      operation.canAbandon &&
      operation.commandInProgress !== true &&
      operation.error &&
      cutoffCodes.has(operation.error.code),
  );
}
