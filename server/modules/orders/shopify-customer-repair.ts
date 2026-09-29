import { ValidationError } from "../../../shared/errors";
import { normalizeShopifyOrderGid } from "./shopify-order-id";

/** A provider identity, never a display order number or an internal OMS id. */
export interface ShopifyCustomerRepairScope {
  shopDomain: string;
  externalOrderId: string;
}

export function normalizeShopifyRepairShopDomain(value: unknown): string {
  if (typeof value !== "string") {
    throw new ValidationError(
      "Customer repair requires a configured Shopify shop domain.",
    );
  }
  const normalized = value.trim().toLowerCase();
  const domain = normalized.includes(".")
    ? normalized
    : `${normalized}.myshopify.com`;
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.myshopify\.com$/.test(domain)) {
    throw new ValidationError(
      "Customer repair requires a canonical myshopify.com domain.",
    );
  }
  return domain;
}

export function normalizeShopifyRepairOrderId(value: unknown): string {
  // JSON numbers must be lossless before conversion. String provider ids retain
  // their exact digits, including ids beyond JavaScript's safe integer range.
  if (
    typeof value === "number" &&
    (!Number.isSafeInteger(value) || value <= 0)
  ) {
    throw new ValidationError(
      "Customer repair requires an exact Shopify order id.",
    );
  }
  if (typeof value !== "string" && typeof value !== "number") {
    throw new ValidationError(
      "Customer repair requires an exact Shopify order id.",
    );
  }
  const raw = String(value).trim();
  if (!/^(?:gid:\/\/shopify\/Order\/)?[1-9][0-9]{0,31}$/.test(raw)) {
    throw new ValidationError(
      "Customer repair requires an exact Shopify order id.",
    );
  }
  return normalizeShopifyOrderGid(raw);
}
