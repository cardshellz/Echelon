import { z } from "zod";
import { CUSTOMER_ACCOUNT_COMMAND_HEADER } from "@shared/customer-account/customer-account.contract";
import { CUSTOMER_RETURNS_API, RETURN_CUSTOMER_SESSION_HEADER } from "@shared/returns/customer-return-access.contract";
import { returnGuestChallengeSchema, returnGuestSessionSchema, returnGuestAccountSchema, returnGuestProofSchema,
  returnGuestLookupSchema, returnGuestVerifySchema,
  type ReturnGuestSession } from "@shared/returns/customer-return-guest.contract";
import { createCustomerReturnTransport } from "@/lib/customer-return-customer";
import type { ReturnPortalPageConfig } from "./return-portal-config";
import { customerAccountPageConfigSchema } from "./customer-account.transport";

export function createGuestReturnTransport(rawConfig: Pick<ReturnPortalPageConfig, "themeId" | "proxyPath">, request: typeof fetch = fetch) {
  const config = customerAccountPageConfigSchema.pick({ themeId: true, proxyPath: true }).strict()
    .parse({ themeId: rawConfig.themeId, proxyPath: rawConfig.proxyPath });
  async function call(action: string, input: unknown, proof?: unknown, signal?: AbortSignal | null) {
    const controller = new AbortController();
    const cancel = () => controller.abort(signal?.reason);
    if (signal?.aborted) cancel(); else signal?.addEventListener("abort", cancel, { once: true });
    const timer = setTimeout(() => controller.abort(), 25_000);
    try {
      const response = await request(`${config.proxyPath}/guest`, { method: "POST", credentials: "same-origin", cache: "no-store", redirect: "error",
        signal: controller.signal, headers: { "Content-Type": "application/json", [CUSTOMER_ACCOUNT_COMMAND_HEADER]: "1" },
        body: JSON.stringify({ themeId: config.themeId, action, input, ...(proof ? { proof } : {}) }) });
      const bytes = await response.arrayBuffer();
      return new Response(bytes, { status: response.status, headers: response.headers });
    } finally { clearTimeout(timer); signal?.removeEventListener("abort", cancel); }
  }
  async function json<T extends z.ZodTypeAny>(response: Response, schema: T): Promise<z.infer<T>> {
    const data: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const error = z.object({ error: z.object({ message: z.string().max(500) }) }).safeParse(data);
      throw new Error(error.success ? error.data.error.message : "We couldn't load your return. Please try again.");
    }
    const parsed = schema.safeParse(data);
    if (!parsed.success) throw new Error("We couldn't verify the response. Please try again.");
    return parsed.data;
  }
  function returns(rawSession: ReturnGuestSession) {
    const session = returnGuestSessionSchema.parse(rawSession);
    const proof = returnGuestProofSchema.parse({ challengeId: session.challengeId, browserKey: session.browserKey, grant: session.grant });
    const bridge: typeof fetch = async (target, options) => {
      if (typeof target !== "string") throw new Error("A return API path is required.");
      const url = new URL(target, "https://return.invalid");
      if (url.origin !== "https://return.invalid" || !url.pathname.startsWith(`${CUSTOMER_RETURNS_API}/`)) throw new Error("This return request is unavailable.");
      if (new Headers(options?.headers).get(RETURN_CUSTOMER_SESSION_HEADER) !== session.sessionKey)
        throw new Error("Your verified order changed. Open your return again before continuing.");
      if (url.pathname === `${CUSTOMER_RETURNS_API}/logout`) return call("logout", proof, undefined, options?.signal);
      const query: Record<string, string> = {};
      for (const [key, value] of url.searchParams) {
        if (Object.hasOwn(query, key)) throw new Error("Duplicate return parameters are not allowed.");
        query[key] = value;
      }
      return call("returns", { path: `/returns${url.pathname.slice(CUSTOMER_RETURNS_API.length)}`,
        method: z.enum(["GET", "POST"]).parse(options?.method ?? "GET"), query,
        ...(options?.body === undefined ? {} : { body: JSON.parse(z.string().parse(options.body)) }) }, proof, options?.signal);
    };
    return { transport: createCustomerReturnTransport(bridge, session.sessionKey), request: bridge };
  }
  return {
    lookup: async (input: unknown, signal?: AbortSignal) => json(await call("lookup", returnGuestLookupSchema.parse(input), undefined, signal), returnGuestChallengeSchema),
    verify: async (input: unknown, signal?: AbortSignal) => json(await call("verify", returnGuestVerifySchema.parse(input), undefined, signal), returnGuestSessionSchema),
    account: async (session: ReturnGuestSession, signal?: AbortSignal) => json(await call("account", {
      challengeId: session.challengeId, browserKey: session.browserKey, grant: session.grant }, undefined, signal), returnGuestAccountSchema),
    returns,
  };
}
