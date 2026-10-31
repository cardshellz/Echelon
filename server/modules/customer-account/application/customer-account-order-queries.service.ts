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
import { customerOrderProgressSchema } from "@shared/customer-account/order-progress";
import type { CustomerAccountProgressReader } from "./customer-account-progress.ports";
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
      progress?: CustomerAccountProgressReader;
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
    if (!this.dependencies.actions || !this.dependencies.now)
      throw new OrderEditError(
        "CUSTOMER_ACCOUNT_ACTIONS_UNAVAILABLE",
        "Order options are temporarily unavailable. Please try again.",
        503,
      );
    const principal = this.dependencies.principal;
    return this.dependencies.actions.read(
      {
        ...input,
        channelId: principal.channelId,
        externalCustomerId: principal.externalCustomerId,
      },
      this.dependencies.now(),
    );
  }

  async summaries(
    raw: unknown,
    options: { progress?: boolean } = {},
  ): Promise<CustomerAccountOrderSummaries> {
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
        ...(options.progress
          ? {
              progress:
                contexts === null || matchingContexts.length > 1
                  ? null
                  : {
                      unavailable: [],
                      delivery: null,
                      packages: [],
                      returns: [],
                      refunds: [],
                    },
            }
          : {}),
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
    if (options.progress) {
      try {
        if (!this.dependencies.progress || !this.dependencies.now)
          throw new Error("Progress reader unavailable");
        const progress = await this.dependencies.progress.read(
          {
            channelId: principal.channelId,
            externalCustomerId: principal.externalCustomerId,
            orders: orders
              .filter((order) => order.omsOrderId !== null)
              .map((order) => ({
                omsOrderId: order.omsOrderId!,
                externalOrderId: order.externalOrderId,
              })),
          },
          this.dependencies.now(),
        );
        if (
          [...progress.keys()].some(
            (id) => !orders.some((order) => order.omsOrderId === id),
          )
        )
          throw new Error("Progress returned an unrequested identity");
        const verified = orders
          .filter((order) => order.omsOrderId !== null)
          .map((order) => ({
            order,
            value: customerOrderProgressSchema.parse(
              progress.get(order.omsOrderId!),
            ),
          }));
        for (const { order, value } of verified) order.progress = value;
      } catch {
        // A progress outage must not hide verified totals or invent completion.
        statusUnavailable = true;
        for (const order of orders)
          if (order.omsOrderId !== null) order.progress = null;
        this.dependencies.report({
          code: "CUSTOMER_ACCOUNT_PROGRESS_UNAVAILABLE",
        });
      }
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
