import { z } from "zod";
import {
  customerAccountOverviewSchema,
  type CustomerAccountOverview,
} from "@shared/customer-account/account-overview";
import {
  customerAccountOrderSummariesInputSchema,
  customerAccountOrderSummariesSchema,
  type CustomerAccountOrderSummariesInput,
} from "@shared/customer-account/customer-account-orders";
import { customerOrderActionPageSchema } from "@shared/customer-account/order-actions";
import {
  customerAccountPageConfigSchema,
  type CustomerAccountPageConfig,
} from "./account-page-config";
import { CUSTOMER_ACCOUNT_COMMAND_HEADER } from "@shared/customer-account/customer-account.contract";
import { CustomerAccountRequestError } from "./account-request-error";
import { retainedOrderActions } from "./order-action-display";
import { customerAccountBootstrapSchema } from "@shared/customer-account/customer-account.contract";

// Optional action evidence has a separate failure boundary from verified money.
// The server still publishes the strict overview DTO; this reader also handles
// a malformed/outdated optional owner without discarding valid purchase facts.
export const accountOverviewReadSchema = z.object({
  bootstrap: customerAccountBootstrapSchema,
  summaries: customerAccountOrderSummariesSchema,
  actions: z.unknown(),
}).strict();

export function parseAccountOverview(raw: unknown, input: CustomerAccountOrderSummariesInput): CustomerAccountOverview {
  const parsed = accountOverviewReadSchema.parse(raw);
  const actions = customerOrderActionPageSchema.safeParse(parsed.actions);
  const actionsMatch = actions.success && actions.data.orders.length === input.orders.length
    && new Set(actions.data.orders.map(order => order.externalOrderId)).size === input.orders.length
    && actions.data.orders.every(order => input.orders.some(expected =>
      expected.externalOrderId === order.externalOrderId && expected.orderReference === order.orderReference));
  const result = { ...parsed, actions: actionsMatch ? actions.data : {
    orders: input.orders.map(identity => ({...identity,omsOrderId:null,state:"failed" as const,
      snapshot:null,verifiedAt:null,validUntil:null})),
  } };
  verifyOverviewIdentities(result, input);
  return customerAccountOverviewSchema.parse(result);
}

const TTL_MS = 30_000;
const PREFIX = "csz-account-display-v1:";
const displaySchema = z
  .object({
    savedAt: z.number().int().nonnegative().safe(),
    summaries: customerAccountOrderSummariesSchema,
    actions: customerOrderActionPageSchema,
  })
  .strict();
export type AccountDisplay = Pick<
  CustomerAccountOverview,
  "summaries" | "actions"
>;
export function verifyOverviewIdentities(
  result: AccountDisplay,
  input: CustomerAccountOrderSummariesInput,
): void {
  const received = [
    ...result.summaries.orders.map((order) => order.externalOrderId),
    ...result.summaries.unavailableExternalOrderIds,
  ];
  if (
    received.length !== input.orders.length ||
    new Set(received).size !== received.length ||
    received.some(
      (id) => !input.orders.some((order) => order.externalOrderId === id),
    ) ||
    result.summaries.orders.some(
      (order) =>
        !input.orders.some(
          (expected) =>
            expected.externalOrderId === order.externalOrderId &&
            expected.orderReference === order.orderReference,
        ),
    ) ||
    result.actions.orders.length !== input.orders.length ||
    new Set(result.actions.orders.map((order) => order.externalOrderId))
      .size !== input.orders.length ||
    result.actions.orders.some(
      (order) =>
        !input.orders.some(
          (expected) =>
            expected.externalOrderId === order.externalOrderId &&
            expected.orderReference === order.orderReference,
        ),
    )
  )
    throw new Error("ACCOUNT_OVERVIEW_IDENTITY_MISMATCH");
}

/** Display facts only. No session key or authority to execute commands is saved. */
export function accountOverviewClient(
  raw: CustomerAccountPageConfig,
  rawOrders: unknown,
  dependencies: {
    storage?: Storage;
    now(): number;
    request: typeof fetch;
    origin: string;
  },
) {
  const config = customerAccountPageConfigSchema.parse(raw);
  const input = customerAccountOrderSummariesInputSchema.parse(rawOrders);
  const scope = `${dependencies.origin}:${config.themeId}:${config.customerId}:`;
  const key = PREFIX + scope + JSON.stringify(input.orders);
  function readCache(): AccountDisplay | null {
    try {
      const stored = dependencies.storage?.getItem(key);
      if (!stored) return null;
      const result = displaySchema.parse(JSON.parse(stored));
      const age = dependencies.now() - result.savedAt;
      if (age < 0 || age >= TTL_MS) {
        dependencies.storage?.removeItem(key);
        return null;
      }
      verifyOverviewIdentities(result, input);
      return { summaries: result.summaries, actions: result.actions };
    } catch {
      console.debug(
        JSON.stringify({
          event: "account_display_cache",
          code: "CACHE_READ_UNAVAILABLE",
        }),
      );
      return null;
    } // Storage may be disabled; the authenticated read still works.
  }
  function writeCache(result: AccountDisplay): void {
    verifyOverviewIdentities(result, input);
    const previous = readCache();
    const actions = { orders: result.actions.orders.map(current =>
      retainedOrderActions(current, previous?.actions.orders.find(prior => prior.externalOrderId === current.externalOrderId)) ?? current,
    ) };
    try {
      // Drop another customer's session-display cache on account changes.
      const keys = Array.from(
        { length: dependencies.storage?.length ?? 0 },
        (_, index) => dependencies.storage?.key(index),
      );
      for (const existing of keys)
        if (
          existing?.startsWith(PREFIX) &&
          !existing.startsWith(PREFIX + scope)
        )
          dependencies.storage?.removeItem(existing);
      dependencies.storage?.setItem(
        key,
        JSON.stringify(
          displaySchema.parse({
            savedAt: dependencies.now(),
            summaries: result.summaries,
            actions,
          }),
        ),
      );
    } catch {
      console.debug(
        JSON.stringify({
          event: "account_display_cache",
          code: "CACHE_WRITE_UNAVAILABLE",
        }),
      );
      /* Optional display cache; never block authentication or commands. */
    }
  }
  async function read(signal?: AbortSignal): Promise<CustomerAccountOverview> {
    const request = dependencies.request;
    const response = await request(`${config.proxyPath}/account`, {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      signal,
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        [CUSTOMER_ACCOUNT_COMMAND_HEADER]: "1",
      },
      body: JSON.stringify({
        themeId: config.themeId,
        expectedCustomerId: config.customerId,
        method: "POST",
        path: "/account/overview",
        body: input,
        query: {},
      }),
    });
    if (!response.ok) {
      const error = z
        .object({
          error: z.object({
            code: z.string().max(100).optional(),
            message: z.string().max(500),
          }),
        })
        .safeParse(await response.json().catch(() => null));
      throw new CustomerAccountRequestError(
        error.success ? error.data.error.code : undefined,
        error.success
          ? error.data.error.message
          : "Your orders could not be loaded. Please try again.",
      );
    }
    const result = parseAccountOverview(await response.json(), input);
    if (
      !result.bootstrap.session.authenticated ||
      !result.bootstrap.session.sessionKey
    )
      throw new Error("ACCOUNT_OVERVIEW_SESSION_INVALID");
    writeCache(result);
    return result;
  }
  return { key, input, readCache, writeCache, read };
}
export interface AccountOverviewHandoff extends HTMLElement {
  accountOverview?: {
    key: string;
    display: AccountDisplay | null;
    request: Promise<CustomerAccountOverview>;
  };
}
