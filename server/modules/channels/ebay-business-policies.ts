import { pool } from "../../db";
import {
  EbayBusinessPolicyError,
  ebayPolicyScopeSchema,
} from "@shared/ebay-business-policies";
import { createEbayBusinessPolicyService } from "./ebay-business-policies.service";
import { PgEbayBusinessPolicyRepository } from "./infrastructure/ebay-business-policies.repository";
import { EbayBusinessPolicyProvider } from "./infrastructure/ebay-business-policies.provider";
import {
  getAuthService,
  EBAY_CHANNEL_ID,
} from "./infrastructure/ebay-api-runtime";

export const ebayBusinessPolicies = createEbayBusinessPolicyService({
  repository: new PgEbayBusinessPolicyRepository(pool),
  provider: {
    async readCatalog(scope) {
      const auth = getAuthService();
      if (!auth)
        throw new EbayBusinessPolicyError(
          "EBAY_POLICY_CATALOG_UNAVAILABLE",
          "Connect the intended eBay account before loading policies.",
          503,
        );
      return new EbayBusinessPolicyProvider(auth).readCatalog(scope);
    },
  },
  async scopeReader() {
    const auth = getAuthService();
    if (!auth)
      throw new EbayBusinessPolicyError(
        "EBAY_POLICY_CATALOG_UNAVAILABLE",
        "Connect the intended eBay account before loading policies.",
        503,
      );
    const account = await auth.getVerifiedProviderAccount(EBAY_CHANNEL_ID);
    const connections = await pool.query<{
      id: number;
      metadata: Record<string, unknown> | null;
    }>(
      "SELECT id,metadata FROM channels.channel_connections WHERE channel_id=$1 ORDER BY id LIMIT 2",
      [EBAY_CHANNEL_ID],
    );
    if (!account || connections.rows.length !== 1)
      throw new EbayBusinessPolicyError(
        "EBAY_POLICY_SCOPE_CHANGED",
        "One verified eBay account connection is required. Reconnect the intended account in Connection settings.",
        409,
      );
    return ebayPolicyScopeSchema.parse({
      channelId: EBAY_CHANNEL_ID,
      connectionId: connections.rows[0].id,
      accountId: account.externalAccountId,
      environment: auth.getEnvironment(),
      marketplaceId: connections.rows[0].metadata?.marketplaceId ?? "EBAY_US",
    });
  },
});
