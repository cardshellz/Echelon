import { orderEditOrderSchema, type OrderEditOrder } from "@shared/order-edits/order-edit.contract";
import { customerReturnCustomerOrderSchema, type CustomerReturnCustomerOrder } from "@shared/returns/customer-return-access.contract";
import { OrderEditError } from "../../order-edits/domain/order-edit-error";
import { CustomerReturnLiveError } from "../../returns/application/customer-return-live-error";
import type { OrderActionScope, OrderActionProjectionInspector } from "./order-action-projection.ports";

function classify(error: unknown): "permanent" | "transient" {
  if ((error instanceof OrderEditError || error instanceof CustomerReturnLiveError)
    && ((error.status >= 400 && error.status < 409) || ["RETURN_PORTAL_POLICY_MISSING", "RETURN_PORTAL_POLICY_UNSUPPORTED",
      "RETURN_PORTAL_POLICY_AMBIGUOUS", "RETURN_LIVE_SHOP_UNAVAILABLE", "RETURN_SHOPIFY_SCOPE_MISSING",
      "RETURN_LIVE_EVIDENCE_UNRESOLVED"].includes(error.code))) return "permanent";
  return "transient";
}

/** Uses the existing owners' inspections; never recreates eligibility rules.
 * Dependencies expose no command that could edit an order, points or a label. */
export class OrderActionProjectionInspectorService implements OrderActionProjectionInspector {
  constructor(private readonly dependencies: {
    readEdit(scope: OrderActionScope): Promise<OrderEditOrder>;
    inspectReturnAndRetainMeasurements(scope: OrderActionScope): Promise<CustomerReturnCustomerOrder>;
    report(event: { action: string; outcome: string; omsOrderId: number; code: string }): void;
  }) {}

  async inspect(scope: OrderActionScope) {
    const failures: Array<"permanent" | "transient"> = [];
    let order: OrderEditOrder | null = null;
    let returnOrder: CustomerReturnCustomerOrder | null = null;
    let orderFailed = false, returnFailed = false;
    try {
      order = orderEditOrderSchema.parse(await this.dependencies.readEdit(scope));
      if (order.omsOrderId !== scope.omsOrderId || order.connectionId !== scope.connectionId || order.orderNumber !== scope.orderReference)
        throw new OrderEditError("ORDER_ACTION_IDENTITY_CHANGED", "The order identity changed.", 409);
    } catch (error) {
      order = null; orderFailed = true; failures.push(classify(error));
      this.dependencies.report({ action: "order_action_edit_inspection", outcome: "failed", omsOrderId: scope.omsOrderId, code: "ORDER_ACTION_EDIT_UNAVAILABLE" });
    }
    // The returns owner decides from delivered quantities and existing claims.
    // A warehouse hold or edit restriction must not hide an eligible return.
    {
      try {
        returnOrder = customerReturnCustomerOrderSchema.parse(await this.dependencies.inspectReturnAndRetainMeasurements(scope));
        if (returnOrder.omsOrderId !== scope.omsOrderId
          || returnOrder.order.orderReference.replace(/^#/, "") !== scope.orderReference.replace(/^#/, ""))
          throw new OrderEditError("ORDER_ACTION_IDENTITY_CHANGED", "The return identity changed.", 409);
      } catch (error) {
        returnOrder = null; returnFailed = true; failures.push(classify(error));
        this.dependencies.report({ action: "order_action_return_inspection", outcome: "failed", omsOrderId: scope.omsOrderId, code: "ORDER_ACTION_RETURN_UNAVAILABLE" });
      }
    }
    // A permanent fault waits for source/configuration invalidation instead of
    // retrying the same rejected evidence. Unknown failures have bounded retries.
    return { order, returnOrder, orderFailed, returnFailed,
      ...(failures.length ? { failureClass: failures.includes("permanent") ? "permanent" as const : "transient" as const } : {}) };
  }
}
