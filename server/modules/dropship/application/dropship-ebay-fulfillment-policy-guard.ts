import {
  evaluateDropshipEbayFulfillmentPolicyCompatibility,
  type DropshipEbayFulfillmentPolicyIssue,
} from "../domain/ebay-fulfillment-policy-compatibility";
import { DropshipError } from "../domain/errors";
import type {
  DropshipEbayFulfillmentCapabilityProvider,
} from "./dropship-ebay-fulfillment-capability-service";
import type {
  DropshipEbayListingSetupDirectory,
} from "./dropship-ebay-listing-setup-service";

export interface DropshipEbayFulfillmentPolicyPreflight {
  compatible: boolean;
  fulfillmentPolicyId: string;
  capabilityEvidenceHash: string;
  originWarehouseId: number | null;
  issues: DropshipEbayFulfillmentPolicyIssue[];
}

export interface DropshipEbayFulfillmentPolicyGuard {
  evaluateForStoreConnection(input: {
    vendorId: number;
    storeConnectionId: number;
    marketplaceId: string;
    fulfillmentPolicyId: string;
    fresh?: boolean;
  }): Promise<DropshipEbayFulfillmentPolicyPreflight>;
  evaluateWithAccessToken(input: {
    storeConnectionId: number;
    marketplaceId: string;
    fulfillmentPolicyId: string;
    accessToken: string;
    environment: "sandbox" | "production";
    fresh?: boolean;
  }): Promise<DropshipEbayFulfillmentPolicyPreflight>;
}

export class DropshipEbayFulfillmentPolicyGuardService
implements DropshipEbayFulfillmentPolicyGuard {
  constructor(private readonly deps: {
    directory: DropshipEbayListingSetupDirectory;
    capabilities: DropshipEbayFulfillmentCapabilityProvider;
  }) {}

  async evaluateForStoreConnection(input: {
    vendorId: number;
    storeConnectionId: number;
    marketplaceId: string;
    fulfillmentPolicyId: string;
    fresh?: boolean;
  }): Promise<DropshipEbayFulfillmentPolicyPreflight> {
    const [policy, capability] = await Promise.all([
      this.deps.directory.getFulfillmentPolicyForStoreConnection(input),
      this.deps.capabilities.getForStoreConnection({
        storeConnectionId: input.storeConnectionId,
        marketplaceId: input.marketplaceId,
        fresh: input.fresh,
      }),
    ]);
    return evaluate(input.fulfillmentPolicyId, policy, capability);
  }

  async evaluateWithAccessToken(input: {
    storeConnectionId: number;
    marketplaceId: string;
    fulfillmentPolicyId: string;
    accessToken: string;
    environment: "sandbox" | "production";
    fresh?: boolean;
  }): Promise<DropshipEbayFulfillmentPolicyPreflight> {
    const [policy, capability] = await Promise.all([
      this.deps.directory.getFulfillmentPolicyWithAccessToken(input),
      this.deps.capabilities.getForStoreConnection({
        storeConnectionId: input.storeConnectionId,
        marketplaceId: input.marketplaceId,
        fresh: input.fresh,
      }),
    ]);
    return evaluate(input.fulfillmentPolicyId, policy, capability);
  }
}

function evaluate(
  selectedPolicyId: string,
  policy: Parameters<typeof evaluateDropshipEbayFulfillmentPolicyCompatibility>[0]["policy"],
  capability: Parameters<typeof evaluateDropshipEbayFulfillmentPolicyCompatibility>[0]["capability"],
): DropshipEbayFulfillmentPolicyPreflight {
  if (policy.id !== selectedPolicyId) {
    throw new DropshipError(
      "DROPSHIP_EBAY_FULFILLMENT_POLICY_RESPONSE_MISMATCH",
      "eBay returned a different fulfillment policy than requested.",
      {
        selectedPolicyId,
        returnedPolicyId: policy.id,
        retryable: false,
      },
    );
  }
  const compatibility = evaluateDropshipEbayFulfillmentPolicyCompatibility({
    policy,
    capability,
  });
  return {
    compatible: compatibility.compatible,
    fulfillmentPolicyId: policy.id,
    capabilityEvidenceHash: capability.evidenceHash,
    originWarehouseId: capability.source.originWarehouseId,
    issues: compatibility.issues,
  };
}
