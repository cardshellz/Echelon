import { z } from "zod";
import {
  EBAY_POLICY_KINDS,
  EBAY_POLICY_LABELS,
  EbayBusinessPolicyError,
  type EbayPolicyCatalog,
  type EbayPolicyScope,
  type EbayPolicyOption,
} from "@shared/ebay-business-policies";
import type { EbayAuthService } from "../adapters/ebay/ebay-auth.service";

type PolicyAuth = Pick<EbayAuthService, "getEnvironment" | "getAccessToken"> & {
  getVerifiedProviderAccount(
    channelId: number,
  ): Promise<{ externalAccountId: string } | null>;
};
/** Transport only: it translates complete successful Account API responses. */
export class EbayBusinessPolicyProvider {
  constructor(
    private readonly auth: PolicyAuth,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}
  async readCatalog(scope: EbayPolicyScope): Promise<EbayPolicyCatalog> {
    let accessToken: string;
    try {
      accessToken = await this.auth.getAccessToken(scope.channelId);
      const account = await this.auth.getVerifiedProviderAccount(
        scope.channelId,
      );
      if (
        this.auth.getEnvironment() !== scope.environment ||
        account?.externalAccountId !== scope.accountId
      )
        throw new EbayBusinessPolicyError(
          "EBAY_POLICY_SCOPE_CHANGED",
          "The eBay account changed while reading policies. Refresh Connection settings.",
          409,
        );
    } catch (error) {
      if (error instanceof EbayBusinessPolicyError) throw error;
      throw new EbayBusinessPolicyError(
        "EBAY_POLICY_CATALOG_UNAVAILABLE",
        "Echelon could not authenticate the eBay policy catalog. Check Connection settings and retry.",
        503,
      );
    }
    const baseUrl =
      scope.environment === "sandbox"
        ? "https://api.sandbox.ebay.com"
        : "https://api.ebay.com";
    const result = await Promise.all(
      EBAY_POLICY_KINDS.map(async (kind) => {
        try {
          const response = await this.fetchFn(
            `${baseUrl}/sell/account/v1/${kind}_policy?marketplace_id=${encodeURIComponent(scope.marketplaceId)}`,
            {
              headers: {
                Authorization: `Bearer ${accessToken}`,
                Accept: "application/json",
              },
              signal: AbortSignal.timeout(20_000),
            },
          );
          if (!response.ok)
            throw new EbayBusinessPolicyError(
              "EBAY_POLICY_CATALOG_UNAVAILABLE",
              `eBay could not load ${EBAY_POLICY_LABELS[kind].toLowerCase()} policies (HTTP ${response.status}). Retry loading policies; saved selections have not changed.`,
              502,
              { policyKind: kind, status: response.status },
            );
          const body: unknown = await response.json();
          const policies = z
            .object({ [`${kind}Policies`]: z.array(z.record(z.unknown())) })
            .parse(body)[`${kind}Policies`];
          const total = (body as Record<string, unknown>).total;
          if (
            total !== undefined &&
            z.number().int().nonnegative().parse(total) !== policies.length
          )
            throw new Error("Incomplete provider policy catalog");
          const parsed: EbayPolicyOption[] = policies.map((policy) => {
            const id = z
              .string()
              .min(1)
              .max(100)
              .refine((value) => value === value.trim())
              .parse(policy[`${kind}PolicyId`]);
            const name = z.string().trim().min(1).parse(policy.name);
            if (policy.marketplaceId !== scope.marketplaceId)
              throw new Error(
                "Policy marketplace does not match the requested marketplace",
              );
            return {
              id,
              name,
              marketplaceId: scope.marketplaceId,
              ...(kind === "fulfillment" ? { packageRequirements: fulfillmentPackageRequirements() } : {}),
              ...(typeof policy.description === "string"
                ? { description: policy.description }
                : {}),
            };
          });
          if (new Set(parsed.map((policy) => policy.id)).size !== parsed.length)
            throw new Error("Duplicate provider policy identity");
          return parsed;
        } catch (error) {
          if (error instanceof EbayBusinessPolicyError) throw error;
          throw new EbayBusinessPolicyError(
            "EBAY_POLICY_CATALOG_UNAVAILABLE",
            `eBay returned an unavailable or invalid ${EBAY_POLICY_LABELS[kind].toLowerCase()} policy catalog. Retry loading policies; saved selections have not changed.`,
            502,
            { policyKind: kind },
          );
        }
      }),
    );
    return {
      scope: { ...scope },
      fulfillmentPolicies: result[0],
      returnPolicies: result[1],
      paymentPolicies: result[2],
    };
  }
}

/** Every policy scope and listing operation uses the same package rule.
 * Dimensions affect shipping accuracy, but the shipping cost type alone does
 * not prove that eBay will refuse this listing. Warn without inventing values;
 * the saved execution owner retains any actual provider rejection. */
function fulfillmentPackageRequirements() {
  return { weight: true, dimensions: "recommended" as const };
}
