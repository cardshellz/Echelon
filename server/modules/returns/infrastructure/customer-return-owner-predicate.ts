import type { CustomerReturnCustomerPrincipal } from "../application/customer-return-customer-operations.service";

/** Fixed alias and bound values only. A null customer never grants access to
 * other guest purchases: it is valid only with an exact verified order scope. */
export function returnOwnerPredicate(principal: CustomerReturnCustomerPrincipal, first: number) {
  if (principal.orderScope) return {
    sql: `o.external_customer_id IS NOT DISTINCT FROM $${first} AND o.id=$${first + 1}
      AND o.external_order_id=$${first + 2}`,
    values: [principal.externalCustomerId, principal.orderScope.omsOrderId, principal.orderScope.externalOrderId],
  };
  return { sql: `o.external_customer_id=$${first}`, values: [principal.externalCustomerId] };
}
