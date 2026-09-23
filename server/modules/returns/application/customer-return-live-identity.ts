import { CustomerReturnLiveError } from "./customer-return-live-error";

/** Never coerce provider identities through Number, even for legacy REST IDs. */
export function customerReturnProviderGid(resource: string, raw: string): string {
  const pattern = new RegExp(`^(?:gid://shopify/${resource}/)?([1-9]\\d*)$`);
  const match = pattern.exec(raw);
  if (!match) throw new CustomerReturnLiveError("RETURN_LIVE_IDENTITY_INVALID",
    "The order's source identities could not be verified.", 503);
  return `gid://shopify/${resource}/${match[1]}`;
}
