import {
  customerReturnOrderChoicesSchema,
  type CustomerReturnOrderChoice,
} from "@shared/returns/customer-return-access.contract";
import { customerOrderActionPageSchema, customerOrderActionReferenceKey } from "@shared/customer-account/order-actions";
import type { OrderActionProjectionReader } from "../../customer-account/application/order-action-projection.ports";
import type { CustomerReturnCustomerSession } from "../application/customer-return-customer-auth.service";
import { customerReturnOrderAccessResultSchema, type CustomerReturnOrderAccessResult } from "../application/customer-return-order-access.service";
import { CustomerReturnOrderChoicesError, type CustomerReturnOrderChoicesReader } from "../application/customer-return-order-choices.ports";

/** Reuse the account's locally maintained return inspection. The cache reader
 * rechecks current OMS ownership; cached capability data never authorizes a command. */
export class CachedCustomerReturnOrderChoicesReader implements CustomerReturnOrderChoicesReader {
  constructor(private readonly dependencies: {
    principal: Pick<CustomerReturnCustomerSession, "channelId" | "externalCustomerId">;
    projection: OrderActionProjectionReader;
    now: () => Date;
  }) {}

  async read(raw: readonly CustomerReturnOrderAccessResult[]) {
    if (raw.length > 10) throw new CustomerReturnOrderChoicesError("RETURN_ORDER_CHOICES_PAGE_TOO_LARGE");
    const candidates = raw.map(order => customerReturnOrderAccessResultSchema.parse(order));
    if (new Set(candidates.map(order => order.omsOrderId)).size !== candidates.length)
      throw new CustomerReturnOrderChoicesError("RETURN_ORDER_CHOICES_DUPLICATE_IDENTITY");
    if (candidates.some(order => order.channelId !== this.dependencies.principal.channelId))
      throw new CustomerReturnOrderChoicesError("RETURN_ORDER_CHOICES_SCOPE_MISMATCH");
    // Canonical return inspection already gives a cancelled order zero eligible
    // units. Honor that channel fact even while its cached inspection refreshes;
    // refunds alone are not cancellation evidence and are never consulted here.
    const owned = candidates.filter(order => !order.cancelledAt);
    if (!owned.length) return { orders: [], unavailableOrderCount: 0 };
    const requested = owned.map(order => ({
      externalOrderId: order.externalOrderId.replace(/^gid:\/\/shopify\/Order\//, ""),
      orderReference: order.externalOrderNumber,
    }));
    const page = customerOrderActionPageSchema.parse(await this.dependencies.projection.read({
      ...this.dependencies.principal, orders: requested,
    }, this.dependencies.now()));
    if (page.orders.length !== owned.length) throw new CustomerReturnOrderChoicesError("RETURN_ORDER_CHOICES_INCOMPLETE_READ");
    const orders: CustomerReturnOrderChoice[] = [];
    let unavailableOrderCount = 0;
    for (const [index, purchase] of owned.entries()) {
      const row = page.orders[index];
      if (row.externalOrderId !== requested[index].externalOrderId ||
          customerOrderActionReferenceKey(row.orderReference) !== customerOrderActionReferenceKey(purchase.externalOrderNumber))
        throw new CustomerReturnOrderChoicesError("RETURN_ORDER_CHOICES_IDENTITY_MISMATCH");
      // A missing OMS match represents an ownership/identity change, not an
      // unbuilt cache. Never fall back to that purchase's earlier identity.
      if (row.state === "not_managed") { unavailableOrderCount++; continue; }
      if (row.omsOrderId !== purchase.omsOrderId) throw new CustomerReturnOrderChoicesError("RETURN_ORDER_CHOICES_IDENTITY_MISMATCH");
      const inspected = row.state === "ready" && !row.snapshot?.returnFailed
        ? row.snapshot?.returnOrder ?? null : null;
      const count = inspected ? inspected.order.lines.reduce((sum, line) => sum + line.eligibleQuantity, 0) : null;
      if (count !== null && !Number.isSafeInteger(count)) throw new CustomerReturnOrderChoicesError("RETURN_ORDER_CHOICES_QUANTITY_INVALID");
      if (count === 0) continue;
      orders.push({ omsOrderId: purchase.omsOrderId, orderReference: purchase.externalOrderNumber,
        purchasedAt: inspected?.order.purchasedAt ?? null, eligibleItemCount: count });
    }
    const result = customerReturnOrderChoicesSchema.parse({ orders, unavailableOrderCount, nextBeforeOmsOrderId: null });
    return { orders: result.orders, unavailableOrderCount: result.unavailableOrderCount };
  }
}
