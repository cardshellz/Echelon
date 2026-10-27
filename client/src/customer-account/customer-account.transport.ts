import { z } from "zod";
import { CUSTOMER_ACCOUNT_COMMAND_HEADER, customerAccountRequestSchema, customerAccountBootstrapSchema, customerAccountOrderIdentitySchema, customerAccountOrderIdentityInputSchema } from "@shared/customer-account/customer-account.contract";
import { ORDER_EDIT_API } from "@shared/order-edits/order-edit.contract";
import { CUSTOMER_RETURNS_API, RETURN_CUSTOMER_SESSION_HEADER } from "@shared/returns/customer-return-access.contract";
import { PreviewAccessError } from "@/lib/customer-return-preview";
import { createOrderEditTransport } from "@/lib/order-edits";
import { createCustomerReturnTransport } from "@/lib/customer-return-customer";
import { ORDER_EDIT_PRICING_DISPLAY_HEADER, ORDER_EDIT_PRICING_DISPLAY_VERSION } from "@shared/order-edits/order-edit-financials";
import { rewardWidgetStateSchema, rewardWidgetIssueResultSchema, rewardWidgetManagementStateSchema, rewardWidgetCancelResultSchema } from "@shared/customer-account/reward-widget";
import { customerOrderCancellationInputSchema, customerOrderCancellationReviewSchema, customerOrderCancellationSchema } from "@shared/customer-account/order-cancellation";
import { customerAccountOrderSummariesInputSchema, customerAccountOrderSummariesSchema, customerAccountOrderDetailsSchema } from "@shared/customer-account/customer-account-orders";
import { customerOrderActionPageSchema } from "@shared/customer-account/order-actions";

export const customerAccountPageConfigSchema = z.object({
  themeId: z.string().max(30).regex(/^[1-9][0-9]*$/),
  customerId: z.string().max(30).regex(/^[1-9][0-9]*$/),
  loginPath: z.string().max(100).regex(/^\/(?:[a-z]{2}(?:-[a-z0-9]{2,8})?\/)?account\/login$/i).default("/account/login"),
  proxyPath: z.string().regex(/^\/(apps|a|community|tools)\/[a-z0-9][a-z0-9-]*$/).refine(path => !path.endsWith("/member-portal")),
}).strict();
export type CustomerAccountPageConfig = z.input<typeof customerAccountPageConfigSchema>;
// Bound storefront waits; a timed-out mutation must still be reconciled.
export const CUSTOMER_ACCOUNT_REQUEST_TIMEOUT_MS = 25_000;
export class CustomerAccountRequestError extends Error {
  constructor(public readonly code: string | undefined, message: string) { super(message); }
}
export function createCustomerAccountTransport(raw: CustomerAccountPageConfig, request: typeof fetch = fetch) {
  const config = customerAccountPageConfigSchema.parse(raw);
  let sessionKey: string | undefined;
  async function call(input: { method: "GET" | "POST"; path: string; query?: Record<string, string>; body?: unknown; commandKey?: string }, signal?: AbortSignal | null): Promise<Response> {
    const body = customerAccountRequestSchema.parse({ ...input, themeId: config.themeId, expectedCustomerId: config.customerId, ...(sessionKey ? { sessionKey } : {}) });
    const controller = new AbortController();
    const cancel = () => controller.abort(signal?.reason);
    if (signal?.aborted) cancel();
    else signal?.addEventListener("abort", cancel, { once: true });
    const timer = setTimeout(() => controller.abort(new DOMException("The request took too long. Please try again.", "TimeoutError")), CUSTOMER_ACCOUNT_REQUEST_TIMEOUT_MS);
    try {
      if (controller.signal.aborted) throw controller.signal.reason;
      const response = await request(`${config.proxyPath}/account`, { method: "POST", credentials: "same-origin", cache: "no-store", redirect: "error", signal: controller.signal,
        headers: { "Content-Type": "application/json", Accept: "application/json", [CUSTOMER_ACCOUNT_COMMAND_HEADER]: "1" }, body: JSON.stringify(body) });
      // Include body download in the deadline. Canonical clients still own
      // validation and uncertain mutation results; no command is retried here.
      const bytes = await response.arrayBuffer();
      return new Response([204, 205, 304].includes(response.status) ? null : bytes, {
        status: response.status, statusText: response.statusText, headers: response.headers,
      });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
    }
  }
  async function json<T>(response: Response, schema: z.ZodType<T, z.ZodTypeDef, unknown>): Promise<T> {
    const value: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const error = z.object({ error: z.object({ code: z.string().max(100).optional(), message: z.string().max(500) }) }).safeParse(value);
      throw new CustomerAccountRequestError(error.success ? error.data.error.code : undefined,
        error.success ? error.data.error.message : "Account tools are temporarily unavailable. Please try again.");
    }
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw new Error("Your account details could not be verified. Refresh this page before continuing.");
    return parsed.data;
  }
  /** Reuse the canonical clients' validation, command keys and uncertain-result
   * recovery. Only their transport changes; no staff API is called by the theme. */
  const bridge: typeof fetch = async (target, options) => {
    if (typeof target !== "string") throw new Error("An account API path is required.");
    const url = new URL(target, "https://account.invalid");
    if (url.origin !== "https://account.invalid") throw new Error("External account requests are not allowed.");
    const prefix = url.pathname.startsWith(`${ORDER_EDIT_API}/`) ? ORDER_EDIT_API : url.pathname.startsWith(`${CUSTOMER_RETURNS_API}/`) ? CUSTOMER_RETURNS_API : null;
    if (!prefix) throw new Error("This account request is unavailable.");
    const method = z.enum(["GET", "POST"]).parse(options?.method ?? "GET");
    const fields: Record<string, string> = {};
    for (const [key, value] of url.searchParams) {
      if (Object.hasOwn(fields, key)) throw new Error("Duplicate account parameters are not allowed.");
      fields[key] = value;
    }
    const headers = new Headers(options?.headers);
    if (prefix === ORDER_EDIT_API && headers.get(ORDER_EDIT_PRICING_DISPLAY_HEADER) === ORDER_EDIT_PRICING_DISPLAY_VERSION)
      fields.pricingDisplayVersion = ORDER_EDIT_PRICING_DISPLAY_VERSION;
    if (prefix === CUSTOMER_RETURNS_API && headers.get(RETURN_CUSTOMER_SESSION_HEADER) !== sessionKey) {
      throw new PreviewAccessError("Your signed-in account changed. Refresh this page before continuing.");
    }
    const key = headers.get("Idempotency-Key");
    return call({ method, path: `${prefix === ORDER_EDIT_API ? "/order-edits" : "/returns"}${url.pathname.slice(prefix.length)}`, query: fields,
      ...(options?.body === undefined ? {} : { body: JSON.parse(z.string().parse(options.body)) }),
      ...(key ? { commandKey: key } : {}) }, options?.signal);
  };
  return {
    async bootstrap(signal?: AbortSignal) {
      const result = await json(await call({ method: "GET", path: "/account/bootstrap" }, signal), customerAccountBootstrapSchema);
      if (!result.session.authenticated || !result.session.sessionKey) throw new CustomerAccountRequestError("CUSTOMER_ACCOUNT_SESSION_INVALID", "The account response could not be verified.");
      sessionKey = result.session.sessionKey;
      return result;
    },
    resolve: async (raw: unknown, signal?: AbortSignal) => json(await call({ method: "POST", path: "/account/resolve", body: customerAccountOrderIdentityInputSchema.parse(raw) }, signal), customerAccountOrderIdentitySchema),
    orderActions: async (raw: unknown, signal?: AbortSignal) => {
      const input = customerAccountOrderSummariesInputSchema.parse(raw);
      const result = await json(await call({ method: "POST", path: "/account/order-actions", body: input }, signal), customerOrderActionPageSchema);
      if (result.orders.length !== input.orders.length || result.orders.some(row => !input.orders.some(
        expected => row.externalOrderId === expected.externalOrderId && row.orderReference === expected.orderReference)))
        throw new CustomerAccountRequestError("CUSTOMER_ACCOUNT_ACTION_MISMATCH", "Order options could not be verified. Please try again.");
      return result;
    },
    orderSummaries: async (raw: unknown, signal?: AbortSignal) => {
      const input = customerAccountOrderSummariesInputSchema.parse(raw);
      const result = await json(await call({ method: "POST", path: "/account/order-summaries", body: input }, signal), customerAccountOrderSummariesSchema);
      const expected = input.orders.map(order => order.externalOrderId);
      const received = [...result.orders.map(order => order.externalOrderId), ...result.unavailableExternalOrderIds];
      if (received.length !== expected.length || received.some(id => !expected.includes(id)) || result.orders.some(order => !input.orders.some(item => item.externalOrderId === order.externalOrderId && item.orderReference === order.orderReference)))
        throw new CustomerAccountRequestError("CUSTOMER_ACCOUNT_ORDER_MISMATCH", "Order history could not be verified. Please try again.");
      return result;
    },
    orderDetails: async (raw: unknown, signal?: AbortSignal) => {
      const input = customerAccountOrderIdentityInputSchema.parse(raw);
      const result = await json(await call({ method: "POST", path: "/account/order-details", body: input }, signal), customerAccountOrderDetailsSchema);
      if (result.externalOrderId !== input.externalOrderId || result.orderReference !== input.orderReference)
        throw new CustomerAccountRequestError("CUSTOMER_ACCOUNT_ORDER_MISMATCH", "Order details could not be verified. Please try again.");
      return result;
    },
    edits: createOrderEditTransport(bridge),
    cancellation: {
      review: async (connectionId: number, omsOrderId: number, signal?: AbortSignal) => json(await call({
        method: "GET", path: `/account/orders/${omsOrderId}/cancellation/review`, query: { connectionId: String(connectionId) },
      }, signal), customerOrderCancellationReviewSchema),
      submit: async (raw: unknown, signal?: AbortSignal) => {
        const { connectionId, omsOrderId, ...body } = customerOrderCancellationInputSchema.parse(raw);
        return json(await call({ method: "POST", path: `/account/orders/${omsOrderId}/cancellation`, query: { connectionId: String(connectionId) }, body, commandKey: body.requestKey }, signal), customerOrderCancellationSchema);
      },
      status: async (connectionId: number, omsOrderId: number, requestKey: string, signal?: AbortSignal) => json(await call({
        method: "GET", path: `/account/orders/${omsOrderId}/cancellation/status`, query: { connectionId: String(connectionId), requestKey: z.string().uuid().parse(requestKey) },
      }, signal), customerOrderCancellationSchema),
    },
    rewards: {
      manage: async (connectionId: number, omsOrderId: number, signal?: AbortSignal) => json(await call({
        method: "GET", path: `/order-edits/orders/${omsOrderId}/rewards/manage`, query: { connectionId: String(connectionId) },
      }, signal), rewardWidgetManagementStateSchema),
      cancel: async (connectionId: number, omsOrderId: number, input: { rewardId: string; requestKey: string }) => json(await call({
        method: "POST", path: `/order-edits/orders/${omsOrderId}/rewards/cancel`, query: { connectionId: String(connectionId) },
        body: input, commandKey: input.requestKey,
      }), rewardWidgetCancelResultSchema),
      state: async (connectionId: number, omsOrderId: number, signal?: AbortSignal) => json(await call({
        method: "GET", path: `/order-edits/orders/${omsOrderId}/rewards`, query: { connectionId: String(connectionId) },
      }, signal), rewardWidgetStateSchema),
      issue: async (connectionId: number, omsOrderId: number, input: { points: number; requestKey: string }) => json(await call({
        method: "POST", path: `/order-edits/orders/${omsOrderId}/rewards/issue`, query: { connectionId: String(connectionId) },
        body: input, commandKey: input.requestKey,
      }), rewardWidgetIssueResultSchema),
    },
    returns: (key: string) => createCustomerReturnTransport(bridge, key),
    request: bridge,
  };
}
export type CustomerAccountTransport = ReturnType<typeof createCustomerAccountTransport>;
