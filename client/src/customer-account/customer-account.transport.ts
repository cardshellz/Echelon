import { z } from "zod";
import { CUSTOMER_ACCOUNT_COMMAND_HEADER, customerAccountRequestSchema, customerAccountBootstrapSchema, customerAccountOrderIdentitySchema, customerAccountOrderIdentityInputSchema } from "@shared/customer-account/customer-account.contract";
import { ORDER_EDIT_API } from "@shared/order-edits/order-edit.contract";
import { CUSTOMER_RETURNS_API, RETURN_CUSTOMER_SESSION_HEADER } from "@shared/returns/customer-return-access.contract";
import { PreviewAccessError } from "@/lib/customer-return-preview";
import { createOrderEditTransport } from "@/lib/order-edits";
import { createCustomerReturnTransport } from "@/lib/customer-return-customer";

export const customerAccountPageConfigSchema = z.object({
  themeId: z.string().max(30).regex(/^[1-9][0-9]*$/),
  customerId: z.string().max(30).regex(/^[1-9][0-9]*$/),
  proxyPath: z.string().regex(/^\/(apps|a|community|tools)\/[a-z0-9][a-z0-9-]*$/).refine(path => !path.endsWith("/member-portal")),
}).strict();
export type CustomerAccountPageConfig = z.infer<typeof customerAccountPageConfigSchema>;
export function createCustomerAccountTransport(raw: CustomerAccountPageConfig, request: typeof fetch = fetch) {
  const config = customerAccountPageConfigSchema.parse(raw);
  let sessionKey: string | undefined;
  async function call(input: { method: "GET" | "POST"; path: string; query?: Record<string, string>; body?: unknown; commandKey?: string }, signal?: AbortSignal | null): Promise<Response> {
    const body = customerAccountRequestSchema.parse({ ...input, themeId: config.themeId, expectedCustomerId: config.customerId, ...(sessionKey ? { sessionKey } : {}) });
    return request(`${config.proxyPath}/account`, { method: "POST", credentials: "same-origin", cache: "no-store", redirect: "error", signal,
      headers: { "Content-Type": "application/json", Accept: "application/json", [CUSTOMER_ACCOUNT_COMMAND_HEADER]: "1" }, body: JSON.stringify(body) });
  }
  async function json<T>(response: Response, schema: z.ZodType<T, z.ZodTypeDef, unknown>): Promise<T> {
    const value: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const error = z.object({ error: z.object({ message: z.string().max(500) }) }).safeParse(value);
      throw new Error(error.success ? error.data.error.message : "Account tools are temporarily unavailable. Please try again.");
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
      if (!result.session.authenticated || !result.session.sessionKey) throw new Error("Sign in to your store account before continuing.");
      sessionKey = result.session.sessionKey;
      return result;
    },
    resolve: async (raw: unknown, signal?: AbortSignal) => json(await call({ method: "POST", path: "/account/resolve", body: customerAccountOrderIdentityInputSchema.parse(raw) }, signal), customerAccountOrderIdentitySchema),
    edits: createOrderEditTransport(bridge),
    returns: (key: string) => createCustomerReturnTransport(bridge, key),
    request: bridge,
  };
}
export type CustomerAccountTransport = ReturnType<typeof createCustomerAccountTransport>;
