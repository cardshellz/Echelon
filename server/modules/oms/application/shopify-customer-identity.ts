// Matches the capacity of oms.oms_orders.external_customer_id.
const MAX_EXTERNAL_CUSTOMER_ID_LENGTH = 100;

export class ShopifyCustomerIdentityError extends Error {
  constructor(
    readonly code: "OMS_CUSTOMER_ID_INVALID" | "OMS_CUSTOMER_ID_MISSING" | "OMS_CUSTOMER_ID_CONFLICT" | "OMS_ORDER_IDENTITY_UNAVAILABLE",
    message: string,
    readonly context: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "ShopifyCustomerIdentityError";
  }
}

/** Numeric and GID representations identify the same Shopify customer. */
export function normalizeShopifyCustomerId(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === "string") {
    const id = value.trim().replace(/^gid:\/\/shopify\/Customer\//, "");
    if (id.length <= MAX_EXTERNAL_CUSTOMER_ID_LENGTH && /^[1-9][0-9]*$/.test(id)) return id;
  }
  throw new ShopifyCustomerIdentityError("OMS_CUSTOMER_ID_INVALID", "Shopify customer identity is malformed.");
}

export function isShopifyOrderSource(topic: string | undefined): boolean {
  return topic?.startsWith("shopify/") === true ||
    ["orders/paid", "orders/updated", "orders/cancelled", "orders/fulfilled"].includes(topic ?? "");
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/** Check the copy before any OMS write; a guest order may genuinely have no ID. */
export function validateShopifyCustomerIdentityCopy(input: {
  sourceTopic?: string;
  externalCustomerId?: string | null;
  rawPayload?: unknown;
}): void {
  if (!isShopifyOrderSource(input.sourceTopic)) return;
  const payload = record(input.rawPayload);
  const source = input.sourceTopic === "shopify/bridge" ? record(payload?.order) : record(payload?.customer);
  const sourceKey = input.sourceTopic === "shopify/bridge" ? "shopify_customer_id" : "id";
  const sourceKnown = (source !== null && Object.hasOwn(source, sourceKey)) ||
    (input.sourceTopic !== "shopify/bridge" && payload !== null && payload.customer === null);
  const sourceId = normalizeShopifyCustomerId(source?.[sourceKey]);
  const copiedId = normalizeShopifyCustomerId(input.externalCustomerId);
  if (!sourceKnown) return;
  if (sourceId !== null && copiedId === null) {
    throw new ShopifyCustomerIdentityError("OMS_CUSTOMER_ID_MISSING", "The source Shopify customer ID was omitted from the OMS order.");
  }
  if (copiedId !== sourceId) {
    throw new ShopifyCustomerIdentityError("OMS_CUSTOMER_ID_CONFLICT", "The copied customer ID does not match the source Shopify order.");
  }
}
