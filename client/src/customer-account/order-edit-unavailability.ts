import type { OrderEditOperation } from "@shared/order-edits/order-edit.contract";

const cutoffCodes = new Set([
  "ORDER_EDIT_PROVIDER_NOT_EDITABLE",
  "ORDER_EDIT_PROVIDER_LABEL_EXISTS",
  "ORDER_EDIT_SHIPMENT_NOT_EDITABLE",
  "ORDER_EDIT_PICKING_CUTOFF",
  "ORDER_EDIT_INELIGIBLE",
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
