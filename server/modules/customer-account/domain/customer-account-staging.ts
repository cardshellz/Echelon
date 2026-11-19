import { z } from "zod";
import {
  CustomerReturnCustomerAccessError,
  type CustomerReturnCustomerSession,
  type ReturnCustomerAuthConfig,
} from "../../returns/customer-return-access-contracts.api";

const id = z.string().max(30).regex(/^[1-9][0-9]*$/);
// Keep rollout configuration bounded; theme IDs do not authenticate customers.
const MAX_ADDITIONAL_ACCOUNT_THEMES = 10;
const configSchema = z.object({
  themeId: id,
  // Preserve the original single-theme configuration and allow an explicitly
  // configured live theme without disabling an existing staging preview.
  additionalThemeIds: z.array(id).max(MAX_ADDITIONAL_ACCOUNT_THEMES).optional(),
  shops: z.record(z.string().regex(/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/),
    z.object({ enabled: z.boolean() }).strict()),
}).strict().superRefine((config, context) => {
  const themes = [config.themeId, ...(config.additionalThemeIds ?? [])];
  if (new Set(themes).size !== themes.length)
    context.addIssue({ code: "custom", path: ["additionalThemeIds"], message: "Account theme IDs must be unique." });
});
export type CustomerAccountStagingConfig = z.infer<typeof configSchema>;
export interface CustomerAccountOriginContext {
  origin: "primary_storefront" | "shopify_storefront" | "missing" | "rejected";
  commandHeader: "valid" | "missing" | "rejected";
}
export class CustomerAccountOriginAccessError extends CustomerReturnCustomerAccessError {
  constructor(readonly context: CustomerAccountOriginContext) {
    super("CUSTOMER_ACCOUNT_ORIGIN_REJECTED", "Open this page from your store account.", 403);
  }
}
export function readCustomerAccountStagingConfig(raw: string | undefined): CustomerAccountStagingConfig | null {
  if (!raw) return null;
  try { return configSchema.parse(JSON.parse(raw)); }
  catch { throw new CustomerReturnCustomerAccessError("CUSTOMER_ACCOUNT_CONFIGURATION_INVALID", "Account tools are not configured yet.", 503); }
}

/** Theme IDs select the rollout, never authenticate it. The enabled shop admits
 * every independently signed customer; application services enforce ownership. */
export function requireCustomerAccountStaging(input: {
  config: CustomerAccountStagingConfig | null; authConfig: ReturnCustomerAuthConfig;
  principal: CustomerReturnCustomerSession; themeId: string; expectedCustomerId: string;
  origin: string | undefined; commandHeader: string | undefined; sessionKey?: string | null;
}): void {
  requireCustomerAccountStorefront({ ...input, shopDomain: input.principal.shopDomain });
  const { principal } = input;
  if (principal.externalCustomerId !== input.expectedCustomerId ||
      (input.sessionKey !== undefined && input.sessionKey !== principal.sessionKey)) {
    throw new CustomerReturnCustomerAccessError("CUSTOMER_ACCOUNT_IDENTITY_CHANGED", "Your sign-in changed. Reload your account page before continuing.", 401);
  }
}

/** Storefront transport gate only; callers must independently authenticate a
 * signed customer or a verified guest order before reading any purchase. */
export function requireCustomerAccountStorefront(input: {
  config: CustomerAccountStagingConfig | null; authConfig: ReturnCustomerAuthConfig;
  shopDomain: string; themeId: string; origin: string | undefined; commandHeader: string | undefined;
}): void {
  const { config, shopDomain } = input;
  if (!config || (config.themeId !== input.themeId && !config.additionalThemeIds?.includes(input.themeId)) ||
      !config.shops[shopDomain]?.enabled) {
    throw new CustomerReturnCustomerAccessError("CUSTOMER_ACCOUNT_TESTING_UNAVAILABLE", "Account tools are not enabled yet.", 403);
  }
  const shop = input.authConfig.shops[shopDomain];
  // Shopify serves theme previews on the shop's canonical myshopify host.
  // This origin comes from the independently verified Shopify principal, not
  // a client-supplied host or a wildcard across other Shopify stores.
  const origin: CustomerAccountOriginContext["origin"] = !input.origin ? "missing"
    : shop && input.origin === new URL(shop.proxyUrl).origin ? "primary_storefront"
    : shop && input.origin === `https://${shopDomain}` ? "shopify_storefront" : "rejected";
  const commandHeader: CustomerAccountOriginContext["commandHeader"] = input.commandHeader === "1" ? "valid"
    : input.commandHeader === undefined ? "missing" : "rejected";
  if ((origin !== "primary_storefront" && origin !== "shopify_storefront") || commandHeader !== "valid") {
    // Classifications make transport failures diagnosable without logging raw
    // headers, signed URLs, customer identifiers or authentication material.
    throw new CustomerAccountOriginAccessError({ origin, commandHeader });
  }
}
