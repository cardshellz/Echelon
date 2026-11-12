import type { AccountNativeReader } from "./account-native-summaries.ports";
import type { CustomerReturnCustomerSession } from "../../returns/customer-return-access-contracts.api";
import {
  OrderEditError,
  OrderEditProviderError,
  type OrderEditService,
} from "../../order-edits/customer-account.api";
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
import type {
  CustomerAccountOrderSummary,
  CustomerAccountOrderSummaries,
  CustomerAccountOrderDetails,
} from "@shared/customer-account/customer-account-orders";
import { customerOrderProgressSchema } from "@shared/customer-account/order-progress";
import type { CustomerAccountProgressReader } from "./customer-account-progress.ports";
import type {
  OrderActionProjectionReader,
  OrderActionProjectionRefresher,
} from "./order-action-projection.ports";

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

const ACCOUNT_NATIVE_MAX_REFRESH_LAG_MS = 2 * 60_000;

/** Query-only account surface. Shopify owns current money; OMS/WMS enrich the
 * status when present. Historical purchases need no OMS record or edit draft. */
export class CustomerAccountOrderQueriesService {
  constructor(
    private readonly dependencies: {
      principal: CustomerReturnCustomerSession;
      connection(): Promise<OrderEditConnection>;
      edits: Pick<OrderEditService, "orderSummaries" | "customerOrderDetails">;
      context: CustomerAccountOrderContextReader;
      native?: AccountNativeReader;
      actions?: OrderActionProjectionReader;
      actionRefresh?: OrderActionProjectionRefresher;
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

  async actions(raw: unknown, options: { allowUnavailable?: boolean } = {}) {
    const input = customerAccountOrderSummariesInputSchema.parse(raw);
    try {
      if (!this.dependencies.actions || !this.dependencies.now)
        throw new OrderEditError(
          "CUSTOMER_ACCOUNT_ACTIONS_UNAVAILABLE",
          "Order options are temporarily unavailable. Please try again.",
          503,
        );
      const principal = this.dependencies.principal;
      return await this.dependencies.actions.read(
        {
          ...input,
          channelId: principal.channelId,
          externalCustomerId: principal.externalCustomerId,
        },
        this.dependencies.now(),
      );
    } catch (cause) {
      if (!options.allowUnavailable) throw cause;
      this.dependencies.report({
        code: "CUSTOMER_ACCOUNT_ACTIONS_UNAVAILABLE",
      });
      return {
        orders: input.orders.map((identity) => ({
          ...identity,
          omsOrderId: null,
          state: "failed" as const,
          snapshot: null,
          verifiedAt: null,
          validUntil: null,
        })),
      };
    }
  }

  async refreshActions(raw: unknown) {
    const input = customerAccountOrderSummariesInputSchema.parse(raw);
    if (!this.dependencies.actionRefresh || !this.dependencies.now)
      throw new OrderEditError(
        "CUSTOMER_ACCOUNT_ACTIONS_UNAVAILABLE",
        "Order options are temporarily unavailable. Please try again.",
        503,
      );
    const { channelId, externalCustomerId } = this.dependencies.principal;
    await this.dependencies.actionRefresh.requestRefresh(
      { ...input, channelId, externalCustomerId },
      this.dependencies.now(),
    );
    return this.actions(input);
  }

  private async savedNative(
    input: import("@shared/customer-account/customer-account-orders").CustomerAccountOrderSummariesInput,
    connection: OrderEditConnection,
  ) {
    if (!this.dependencies.native || !this.dependencies.now)
      throw new Error("ACCOUNT_NATIVE_READER_UNAVAILABLE");
    const principal = this.dependencies.principal;
    const facts = await this.dependencies.native.read({
      ...input,
      channelId: principal.channelId,
      connectionId: connection.connectionId,
      shopDomain: principal.shopDomain,
      externalCustomerId: principal.externalCustomerId,
    });
    const missing = input.orders.filter(
      (order) =>
        !facts.some((fact) => fact.externalOrderId === order.externalOrderId),
    );
    const orders = facts.map(
      ({ externalCustomerId, connectionId: _connection, sourceUpdatedAt: _version,
        freshThrough: _freshThrough, ...fact }) => ({ ...fact,
        customerId: externalCustomerId ? `gid://shopify/Customer/${externalCustomerId}` : null }),
    );
    if (missing.length) {
      try {
        // A historical purchase may have neither an OMS row nor a saved fact,
        // so the refresh queue cannot prove its owner yet. Resolve this bounded
        // cold batch directly from Shopify; its reader retains versioned facts.
        // Warm requests perform no provider read, pricing or edit calculation.
        const recovered = await this.dependencies.edits.orderSummaries(
          connection.connectionId, missing.map(order => order.externalOrderId),
        );
        orders.push(...recovered.filter(order =>
          order.channelId === principal.channelId && order.shopDomain === principal.shopDomain &&
          order.customerId === `gid://shopify/Customer/${principal.externalCustomerId}` &&
          missing.some(expected => expected.externalOrderId === order.externalOrderId && expected.orderReference === order.orderReference),
        ));
      } catch (cause) {
        // A failed cold lookup must not discard unrelated, verified totals.
        this.dependencies.report({ code: "CUSTOMER_ACCOUNT_NATIVE_LOOKUP_FAILED",
          ...(cause instanceof OrderEditError || cause instanceof OrderEditProviderError ? { causeCode: cause.code } : {}) });
      }
    }
    const now = this.dependencies.now();
    const stale = facts.filter(
      (fact) =>
        fact.freshThrough.getTime() <
        now.getTime() - ACCOUNT_NATIVE_MAX_REFRESH_LAG_MS,
    );
    const refresh = [
      ...new Set([
        ...missing.filter(expected => !orders.some(order => order.externalOrderId === expected.externalOrderId))
          .map((order) => order.externalOrderId),
        ...stale.map((fact) => fact.externalOrderId),
      ]),
    ];
    if (refresh.length) {
      // Stale saved facts stay available while the normal worker refreshes.
      try {
        await this.dependencies.native.request(
          {
            channelId: principal.channelId,
            externalCustomerId: principal.externalCustomerId,
            externalOrderIds: refresh,
          },
          this.dependencies.now(),
        );
      } catch {
        // Queue availability must not discard already verified display facts.
        this.dependencies.report({
          code: "CUSTOMER_ACCOUNT_NATIVE_REFRESH_QUEUE_FAILED",
        });
      }
    }
    return {
      stale: stale.length > 0,
      orders,
    };
  }

  async summaries(
    raw: unknown,
    options: { progress?: boolean; saved?: boolean } = {},
  ): Promise<CustomerAccountOrderSummaries> {
    const input = customerAccountOrderSummariesInputSchema.parse(raw);
    const connection = await this.connection();
    const principal = this.dependencies.principal;
    const ids = input.orders.map((order) => order.externalOrderId);
    const [nativeResult, contexts] = await Promise.all([
      options.saved
        ? this.savedNative(input, connection)
        : this.dependencies.edits
            .orderSummaries(connection.connectionId, ids)
            .then((orders) => ({ orders, stale: false })),
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
    let statusUnavailable = contexts === null || nativeResult.stale;
    for (const requested of input.orders) {
      const matches = nativeResult.orders.filter(
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
