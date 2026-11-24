import {
  toShopifyGid,
  toShopifyNumericId,
  type ShopifyGid,
} from "@shared/types/ids";

const SHOPIFY_ORDER_GID_PREFIX = "gid://shopify/Order/";

export function normalizeShopifyOrderGid(value: string | number): ShopifyGid {
  const raw = String(value).trim();
  const numericId = raw.startsWith(SHOPIFY_ORDER_GID_PREFIX)
    ? raw.slice(SHOPIFY_ORDER_GID_PREFIX.length)
    : raw;
  const validatedId = toShopifyNumericId(numericId);
  return toShopifyGid(`${SHOPIFY_ORDER_GID_PREFIX}${validatedId}`);
}
