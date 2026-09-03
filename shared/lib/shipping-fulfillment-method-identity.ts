import type {
  ShippingFulfillmentMethodIdentity,
} from "../types/shipping-fulfillment-routing";

const KEY_SEPARATOR = "\u0000";

/** Exact internal identity used by catalog dedupe, routing selection, and persistence. */
export function shippingFulfillmentMethodIdentityKey(
  method: ShippingFulfillmentMethodIdentity,
): string {
  return [
    method.providerConnectionId,
    method.provider,
    method.providerAccountId,
    method.serviceCode,
    method.domestic ? "domestic" : "",
    method.international ? "international" : "",
  ].join(KEY_SEPARATOR);
}

/** Presentation-only grouping key. Variants inside a group remain independently selectable. */
export function shippingFulfillmentMethodGroupKey(
  method: Pick<
    ShippingFulfillmentMethodIdentity,
    "providerConnectionId" | "provider" | "providerAccountId" | "serviceCode"
  >,
): string {
  return [
    method.providerConnectionId,
    method.provider,
    method.providerAccountId,
    method.serviceCode,
  ].join(KEY_SEPARATOR);
}

export function shippingFulfillmentMethodScopeLabel(
  method: Pick<ShippingFulfillmentMethodIdentity, "domestic" | "international">,
): string {
  if (method.domestic && method.international) return "Domestic and international";
  if (method.domestic) return "Domestic";
  if (method.international) return "International";
  return "No destination scope";
}
