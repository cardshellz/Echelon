import type { CustomerReturnCustomerSession } from "../../returns/application/customer-return-customer-auth.service";
import type { OrderEditService } from "../../order-edits/application/order-edit.service";
import type { OrderEditConnection } from "@shared/order-edits/order-edit.contract";
import { customerAccountOrderIdentityInputSchema } from "@shared/customer-account/customer-account.contract";
import {
  customerAccountOrderSummariesInputSchema,
  customerAccountOrderSummariesSchema,
  customerAccountOrderDetailsSchema,
} from "@shared/customer-account/customer-account-orders";
import {
  presentCustomerOrderFulfillment,
  presentCustomerOrderLifecycle,
} from "@shared/customer-account/order-fulfillment";
import { OrderEditError } from "../../order-edits/domain/order-edit-error";
import type { CustomerAccountOrderSummary, CustomerAccountOrderSummaries, CustomerAccountOrderDetails } from "@shared/customer-account/customer-account-orders";

export interface CustomerAccountOrderContext {
  externalOrderId: string;
  omsOrderId: number;
  warehouseStatuses: string[];
  held: boolean;
}
export interface CustomerAccountOrderContextReader {
  read(input: {
    channelId: number;
    externalCustomerId: string;
    externalOrderIds: string[];
  }): Promise<CustomerAccountOrderContext[]>;
}

/** Query-only account surface. Shopify owns current money; OMS/WMS enrich the
 * status when present. Historical purchases need no OMS record or edit draft. */
export class CustomerAccountOrderQueriesService {
  constructor(
    private readonly dependencies: {
      principal: CustomerReturnCustomerSession;
      connection(): Promise<OrderEditConnection>;
      edits: Pick<OrderEditService, "orderSummaries" | "customerOrderDetails">;
      context: CustomerAccountOrderContextReader;
      report(event: { code: string; causeCode?: string }): void;
    },
  ) {}

  async summaries(raw: unknown): Promise<CustomerAccountOrderSummaries> {
    const input = customerAccountOrderSummariesInputSchema.parse(raw);
    const connection = await this.dependencies.connection();
    const principal = this.dependencies.principal;
    const ids = input.orders.map((order) => order.externalOrderId);
    const [native, contexts] = await Promise.all([
      this.dependencies.edits.orderSummaries(connection.connectionId, ids),
      this.dependencies.context
        .read({
          channelId: principal.channelId,
          externalCustomerId: principal.externalCustomerId,
          externalOrderIds: ids,
        })
        .catch((cause: unknown) => {
          // A status-store outage must not remove verified native financial facts.
          const code = cause instanceof OrderEditError ? cause.code : undefined;
          this.dependencies.report({
            code: "CUSTOMER_ACCOUNT_STATUS_UNAVAILABLE",
            ...(code ? { causeCode: code } : {}),
          });
          return null;
        }),
    ]);
    const expectedCustomerId = `gid://shopify/Customer/${principal.externalCustomerId}`;
    const orders: CustomerAccountOrderSummary[] = [];
    const unavailableExternalOrderIds: string[] = [];
    let statusUnavailable = contexts === null;
    for (const requested of input.orders) {
      const matches = native.filter(
        (order) => order.externalOrderId === requested.externalOrderId,
      );
      const order = matches.length === 1 ? matches[0] : null;
      // Do not distinguish a missing purchase from another customer's purchase.
      if (
        !order ||
        order.customerId !== expectedCustomerId ||
        order.orderReference !== requested.orderReference
      ) {
        unavailableExternalOrderIds.push(requested.externalOrderId);
        continue;
      }
      const matchingContexts =
        contexts?.filter(
          (item) => item.externalOrderId === requested.externalOrderId,
        ) ?? [];
      if (matchingContexts.length > 1) {
        statusUnavailable = true;
        this.dependencies.report({ code: "CUSTOMER_ACCOUNT_ORDER_AMBIGUOUS" });
      }
      const context =
        matchingContexts.length === 1 ? matchingContexts[0] : undefined;
      const { customerId: _customerId, ...summary } = order;
      orders.push({
        ...summary,
        omsOrderId: context?.omsOrderId ?? null,
        ...(context
          ? {
              fulfillment: presentCustomerOrderLifecycle(
                presentCustomerOrderFulfillment(context.warehouseStatuses, {
                  held: context.held,
                }),
                order.cancelled,
              ),
            }
          : {}),
      });
    }
    return customerAccountOrderSummariesSchema.parse({
      orders,
      unavailableExternalOrderIds,
      statusUnavailable,
    });
  }

  async details(raw: unknown): Promise<CustomerAccountOrderDetails> {
    const input = customerAccountOrderIdentityInputSchema.parse(raw);
    const connection = await this.dependencies.connection();
    const details = await this.dependencies.edits.customerOrderDetails(
      connection.connectionId,
      input.externalOrderId,
      `gid://shopify/Customer/${this.dependencies.principal.externalCustomerId}`,
    );
    if (details.orderReference !== input.orderReference)
      throw new OrderEditError(
        "CUSTOMER_ACCOUNT_ORDER_UNAVAILABLE",
        "This order is unavailable.",
        404,
      );
    return customerAccountOrderDetailsSchema.parse(details);
  }
}
