import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

export const CUSTOMER_RETURN_PROXY_MAX_AGE_SECONDS = 300;
export const CUSTOMER_RETURN_PROXY_FUTURE_SKEW_SECONDS = 30;
const MAX_QUERY_BYTES = 8192;
const MAX_QUERY_PARAMETERS = 40;
const authorityParameters = new Set([
  "signature",
  "shop",
  "logged_in_customer_id",
  "timestamp",
  "state",
  "path_prefix",
]);

export const customerReturnShopSchema = z
  .string()
  .max(255)
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.myshopify\.com$/);
export const customerReturnStateSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{43}$/);
export const customerReturnCustomerIdSchema = z
  .string()
  .max(30)
  .regex(/^[1-9][0-9]*$/);
const proofSchema = z
  .object({
    shop: customerReturnShopSchema,
    customerId: z.union([z.literal(""), customerReturnCustomerIdSchema]),
    // The application must compare this signed value to its configured proxy
    // path. Verification does not infer which storefront path is authorized.
    pathPrefix: z.string().min(1).max(2048),
    state: customerReturnStateSchema.optional(),
    timestamp: z
      .string()
      .regex(/^[0-9]{1,11}$/)
      .transform(Number),
  })
  .strict();
export type CustomerReturnShopifyProof = z.output<typeof proofSchema>;

export class CustomerReturnShopifyProofError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "CustomerReturnShopifyProofError";
  }
}

function invalidProof(): CustomerReturnShopifyProofError {
  return new CustomerReturnShopifyProofError(
    "RETURN_HANDOFF_PROOF_INVALID",
    401,
    "Open the returns link from the Shopify storefront again.",
  );
}

/** Shopify's documented query algorithm: decode, group repeated values with
 * commas, sort key=value strings, concatenate, and HMAC SHA-256. Identity and
 * state fields may never repeat; no alternate canonicalization is accepted.
 * https://shopify.dev/docs/apps/build/online-store/app-proxies/authenticate-app-proxies
 */
export function verifyCustomerReturnShopifyProof(input: {
  rawQuery: string;
  shopifySecret: string;
  expectedShop: string;
  now: Date;
}): CustomerReturnShopifyProof {
  if (!(input.now instanceof Date) || !Number.isFinite(input.now.getTime())) {
    throw new CustomerReturnShopifyProofError(
      "RETURN_HANDOFF_CLOCK_INVALID",
      503,
      "Returns sign-in is temporarily unavailable.",
    );
  }
  if (
    typeof input.rawQuery !== "string" ||
    Buffer.byteLength(input.rawQuery, "utf8") > MAX_QUERY_BYTES ||
    !input.shopifySecret ||
    !customerReturnShopSchema.safeParse(input.expectedShop).success
  )
    throw invalidProof();
  const entries = input.rawQuery.split("&");
  if (entries.length > MAX_QUERY_PARAMETERS) throw invalidProof();
  const values = new Map<string, string[]>();
  try {
    for (const entry of entries) {
      const separator = entry.indexOf("=");
      if (separator <= 0) throw invalidProof();
      const key = decodeURIComponent(
        entry.slice(0, separator).replace(/\+/g, " "),
      );
      const value = decodeURIComponent(
        entry.slice(separator + 1).replace(/\+/g, " "),
      );
      if (
        !key ||
        // Shopify concatenates key=value entries without separators. An '='
        // in a decoded key can recast a signed guest query as customer proof.
        key.includes("=") ||
        key.length > 128 ||
        value.length > 2048 ||
        /[\u0000-\u001f\u007f]/.test(key + value)
      )
        throw invalidProof();
      if (authorityParameters.has(key) && values.has(key)) throw invalidProof();
      values.set(key, [...(values.get(key) ?? []), value]);
    }
  } catch {
    throw invalidProof();
  }
  const signature = values.get("signature")?.[0];
  if (!signature || !/^[0-9a-f]{64}$/.test(signature)) throw invalidProof();
  const message = [...values.entries()]
    .filter(([key]) => key !== "signature")
    .map(([key, value]) => `${key}=${value.join(",")}`)
    .sort()
    .join("");
  const calculated = createHmac("sha256", input.shopifySecret)
    .update(message)
    .digest();
  if (!timingSafeEqual(calculated, Buffer.from(signature, "hex")))
    throw invalidProof();
  const parsed = proofSchema.safeParse({
    shop: values.get("shop")?.[0],
    customerId: values.get("logged_in_customer_id")?.[0],
    pathPrefix: values.get("path_prefix")?.[0],
    timestamp: values.get("timestamp")?.[0],
    ...(values.has("state") ? { state: values.get("state")?.[0] } : {}),
  });
  if (!parsed.success) throw invalidProof();
  if (parsed.data.shop !== input.expectedShop) {
    throw new CustomerReturnShopifyProofError(
      "RETURN_HANDOFF_SHOP_MISMATCH",
      403,
      "This returns link does not belong to the configured shop.",
    );
  }
  const nowSeconds = Math.floor(input.now.getTime() / 1000);
  if (
    parsed.data.timestamp <
      nowSeconds - CUSTOMER_RETURN_PROXY_MAX_AGE_SECONDS ||
    parsed.data.timestamp >
      nowSeconds + CUSTOMER_RETURN_PROXY_FUTURE_SKEW_SECONDS
  ) {
    throw new CustomerReturnShopifyProofError(
      "RETURN_HANDOFF_PROOF_EXPIRED",
      401,
      "The returns sign-in link expired. Open it from the Shopify storefront again.",
    );
  }
  return parsed.data;
}
