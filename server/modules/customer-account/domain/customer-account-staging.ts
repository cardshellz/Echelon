import { z } from "zod";
import type { CustomerReturnCustomerSession, ReturnCustomerAuthConfig } from "../../returns/application/customer-return-customer-auth.service";
import { CustomerReturnCustomerAccessError } from "../../returns/application/customer-return-customer-auth.service";

const id = z.string().max(30).regex(/^[1-9][0-9]*$/);
const configSchema = z.object({
  themeId: id,
  shops: z.record(z.string().regex(/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/),
    z.object({ customerIds: z.array(id).min(1).max(50).refine(ids => new Set(ids).size === ids.length) }).strict()),
}).strict();
export type CustomerAccountStagingConfig = z.infer<typeof configSchema>;
export function readCustomerAccountStagingConfig(raw: string | undefined): CustomerAccountStagingConfig | null {
  if (!raw) return null;
  try { return configSchema.parse(JSON.parse(raw)); }
  catch { throw new CustomerReturnCustomerAccessError("CUSTOMER_ACCOUNT_CONFIGURATION_INVALID", "Account testing is not configured yet.", 503); }
}

/** Theme IDs are a routing hint, never authentication. Only an independently
 * signed Shopify customer in the explicit tester allowlist can use this surface. */
export function requireCustomerAccountStaging(input: {
  config: CustomerAccountStagingConfig | null; authConfig: ReturnCustomerAuthConfig;
  principal: CustomerReturnCustomerSession; themeId: string; expectedCustomerId: string;
  origin: string | undefined; commandHeader: string | undefined; sessionKey?: string | null;
}): void {
  const { config, principal } = input;
  if (!config || config.themeId !== input.themeId ||
      !config.shops[principal.shopDomain]?.customerIds.includes(principal.externalCustomerId)) {
    throw new CustomerReturnCustomerAccessError("CUSTOMER_ACCOUNT_TESTING_UNAVAILABLE", "This account is not enabled for staging testing yet.", 403);
  }
  const shop = input.authConfig.shops[principal.shopDomain];
  if (!shop || input.origin !== new URL(shop.proxyUrl).origin || input.commandHeader !== "1") {
    throw new CustomerReturnCustomerAccessError("CUSTOMER_ACCOUNT_ORIGIN_REJECTED", "Open this page from your store account.", 403);
  }
  if (principal.externalCustomerId !== input.expectedCustomerId ||
      (input.sessionKey !== undefined && input.sessionKey !== principal.sessionKey)) {
    throw new CustomerReturnCustomerAccessError("CUSTOMER_ACCOUNT_IDENTITY_CHANGED", "Your sign-in changed. Reload your account page before continuing.", 401);
  }
}
