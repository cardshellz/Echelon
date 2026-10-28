import type { z } from "zod";

export class ShopifyProductRequestError extends Error {
  constructor(message: string, readonly code: string | null, readonly retryable: boolean) {
    super(message);
    this.name = "ShopifyProductRequestError";
  }
}

/** The caller owns the saved intent key. A transport failure never silently
 * retries a product write with a new command or discards its recovery state. */
export async function shopifyProductFetch<T>(url: string, body?: unknown, schema?: z.ZodType<T, z.ZodTypeDef, unknown>): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, { method: body === undefined ? "GET" : "POST", credentials: "include",
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new ShopifyProductRequestError("The request did not return a result. Retry the saved command to check what completed.", "SHOPIFY_TRANSPORT_UNCERTAIN", true);
  }
  let data: unknown;
  try { data = await response.json(); }
  catch { throw new ShopifyProductRequestError("The server returned an unreadable result. Refresh and retry the saved command.", "SHOPIFY_RESPONSE_UNREADABLE", true); }
  if (!response.ok) {
    const error = data && typeof data === "object" ? data as Record<string, unknown> : {};
    throw new ShopifyProductRequestError(typeof error.error === "string" ? error.error : "The Shopify request could not be completed.",
      typeof error.code === "string" ? error.code : null, error.retryable === true || response.status >= 500 || response.status === 429);
  }
  if (!data || typeof data !== "object") throw new ShopifyProductRequestError("The server returned an invalid Shopify result.", "SHOPIFY_RESPONSE_INVALID", true);
  if (schema) {
    const parsed = schema.safeParse(data);
    if (!parsed.success) throw new ShopifyProductRequestError("The Shopify result could not be verified. Check the saved command's status before retrying.", "SHOPIFY_RESPONSE_INVALID", true);
    return parsed.data;
  }
  return data as T;
}
