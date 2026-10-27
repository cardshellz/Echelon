import type { CustomerReturnCustomerSession } from "../../returns/application/customer-return-customer-auth.service";
import type { OrderEditService } from "../../order-edits/application/order-edit.service";
import type { OrderEditConnection } from "@shared/order-edits/order-edit.contract";
import { orderEditConnectionSchema } from "@shared/order-edits/order-edit.contract";
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
import type {
  CustomerAccountOrderSummary,
  CustomerAccountOrderSummaries,
  CustomerAccountOrderDetails,
} from "@shared/customer-account/customer-account-orders";
import type { OrderActionProjectionReader } from "./order-action-projection.ports";

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
      actions?: OrderActionProjectionReader;
      now?: () => Date;
      report(event: { code: string; causeCode?: string }): void;
    },
  ) {}
  private async connection(): Promise<OrderEditConnection> {
    const connection = orderEditConnectionSchema.parse(
      await this.dependencies.connection(),
    );
    if (
      connection.channelId !== this.dependencies.principal.channelId ||
      connection.shopDomain !== this.dependencies.principal.shopDomain
    )
      throw new OrderEditError(
        "CUSTOMER_ACCOUNT_CONNECTION_UNAVAILABLE",
        "Order history is temporarily unavailable. Please try again.",
        503,
      );
    return connection;
  }

  async actions(raw: unknown) {
    const input = customerAccountOrderSummariesInputSchema.parse(raw);
    if (!this.dependencies.actions || !this.dependencies.now) throw new OrderEditError(
      "CUSTOMER_ACCOUNT_ACTIONS_UNAVAILABLE", "Order options are temporarily unavailable. Please try again.", 503);
    const principal = this.dependencies.principal;
    return this.dependencies.actions.read({ ...input, channelId: principal.channelId,
      externalCustomerId: principal.externalCustomerId }, this.dependencies.now());
  }

  async summaries(raw: unknown): Promise<CustomerAccountOrderSummaries> {
    const input = customerAccountOrderSummariesInputSchema.parse(raw);
    const connection = await this.connection();
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
        order.channelId !== principal.channelId ||
        order.shopDomain !== principal.shopDomain ||
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
      const {
        customerId: _customerId,
        channelId: _channelId,
        shopDomain: _shopDomain,
        ...summary
      } = order;
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
    const connection = await this.connection();
    const details = await this.dependencies.edits.customerOrderDetails(
      connection.connectionId,
      input.externalOrderId,
      `gid://shopify/Customer/${this.dependencies.principal.externalCustomerId}`,
      {
        channelId: this.dependencies.principal.channelId,
        shopDomain: this.dependencies.principal.shopDomain,
      },
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
