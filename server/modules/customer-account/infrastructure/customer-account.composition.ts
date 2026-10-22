import type { Pool } from "pg";
import type { OrderEditService } from "../../order-edits/application/order-edit.service";
import type { CustomerReturnCustomerSession } from "../../returns/application/customer-return-customer-auth.service";
import { CustomerReturnOrderAccessService } from "../../returns/application/customer-return-order-access.service";
import { PostgresCustomerReturnOrderAccessRepository } from "../../returns/infrastructure/customer-return-order-access.repository";
import { createCustomerReturnCustomerServices } from "../../returns/infrastructure/customer-return-customer.composition";
import { PostgresOrderEditStore } from "../../order-edits/infrastructure/postgres-order-edit.store";
import { CustomerOrderEditService } from "../application/customer-order-edit.service";
import { ClubOrderEditCodeRedemptions } from "../../order-edits/infrastructure/club-order-edit-code-redemptions";
import { CustomerAccountOrderQueriesService } from "../application/customer-account-order-queries.service";
import { PostgresCustomerAccountOrderContextReader } from "./customer-account-order-context.repository";

export function customerAccountServices(pool: Pool, edits: OrderEditService) {
  const store = new PostgresOrderEditStore(pool);
  const rewards = new ClubOrderEditCodeRedemptions(
    process.env.SHELLZ_CLUB_API_URL,
    process.env.INTERNAL_API_KEY,
  );
  return (principal: CustomerReturnCustomerSession) => {
    const customerEdits = new CustomerOrderEditService({
      principal,
      edits,
      store,
      rewards,
      access: new CustomerReturnOrderAccessService({
        channelId: principal.channelId,
        principalReader: {
          getVerifiedPrincipal: async () => ({
            kind: "customer",
            channelId: principal.channelId,
            externalCustomerId: principal.externalCustomerId,
          }),
        },
        repository: new PostgresCustomerReturnOrderAccessRepository(pool),
      }),
    });
    return {
      edits: customerEdits,
      orders: new CustomerAccountOrderQueriesService({
        principal,
        edits,
        connection: () => customerEdits.connection(),
        context: new PostgresCustomerAccountOrderContextReader(pool),
        report: (event) =>
          console.error(
            JSON.stringify({
              event: "customer_account_order_status_failed",
              ...event,
            }),
          ),
      }),
      // Bootstrap/catalog reads do not initialize shipping providers or inspect returns.
      returns: () => createCustomerReturnCustomerServices(principal),
    };
  };
}
