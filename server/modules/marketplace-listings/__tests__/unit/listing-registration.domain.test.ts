import { describe, expect, it } from "vitest";

import {
  buildListingRegistrationPlan,
  type BuildListingRegistrationPlanInput,
} from "../../domain/listing-registration-plan";

describe("marketplace listing registration plan", () => {
  it("includes observed inactive and zero-quantity variants and explicitly excludes unobserved variants", () => {
    const plan = buildListingRegistrationPlan(planInput());

    expect(plan.members).toEqual([
      expect.objectContaining({
        productVariantId: 11,
        skuSnapshot: "ARM-ENV-SGL-C750",
        isActiveSnapshot: false,
        availableQuantitySnapshot: 0,
        disposition: "included",
        reasonCode: null,
      }),
      expect.objectContaining({
        productVariantId: 12,
        skuSnapshot: "ARM-ENV-SGL-P50",
        isActiveSnapshot: true,
        availableQuantitySnapshot: 71,
        disposition: "included",
        reasonCode: null,
      }),
      expect.objectContaining({
        productVariantId: 13,
        skuSnapshot: "ARM-ENV-SGL-C700",
        disposition: "excluded",
        reasonCode: "not_in_observed_publication",
      }),
    ]);
    expect(plan.identityClaims.map((claim) => claim.role)).toEqual([
      "listing_id",
      "publication_key",
      "inventory_item_id",
      "offer_id",
      "inventory_item_id",
      "offer_id",
    ]);
  });

  it("keeps all hashes deterministic while excluding volatile observation evidence and inventory from membership identity", () => {
    const firstInput = planInput();
    const secondInput = planInput();
    secondInput.snapshot = {
      ...secondInput.snapshot,
      memberCandidates: secondInput.snapshot.memberCandidates.map(
        (candidate, index) =>
          index === 0
            ? {
                ...candidate,
                isActive: true,
                availableQuantity: 999,
              }
            : candidate,
      ),
    };
    secondInput.observation = {
      ...secondInput.observation,
      externalUrl: "https://example.test/changed",
      observedAt: new Date("2026-08-04T12:05:00.000Z"),
      evidence: { requestId: "different" },
      providerAccount: {
        ...secondInput.observation.providerAccount,
        externalDisplayNameSnapshot: "Renamed seller",
        evidenceHash: "b".repeat(64),
      },
      members: [...secondInput.observation.members].reverse(),
    };

    const first = buildListingRegistrationPlan(firstInput);
    const second = buildListingRegistrationPlan(secondInput);

    expect(second.requestHash).toBe(first.requestHash);
    expect(second.observationHash).toBe(first.observationHash);
    expect(second.desiredStateHash).toBe(first.desiredStateHash);
  });

  it("keeps a remote-only SKU in the observation hash without creating a local member", () => {
    const input = planInput();
    input.observation = {
      ...input.observation,
      members: [
        ...input.observation.members,
        observedMember("UNKNOWN-SKU", "unknown-offer"),
      ],
    };

    const plan = buildListingRegistrationPlan(input);
    const withoutRemoteOnly = buildListingRegistrationPlan(planInput());

    expect(plan.members).not.toContainEqual(
      expect.objectContaining({ skuSnapshot: "UNKNOWN-SKU" }),
    );
    expect(plan.observationHash).not.toBe(withoutRemoteOnly.observationHash);
    expect(plan.identityClaims).not.toContainEqual(
      expect.objectContaining({ externalId: "unknown-offer" }),
    );
  });

  it("requires at least one observed local SKU even when eBay has remote-only variations", () => {
    const input = planInput();
    input.observation = {
      ...input.observation,
      members: [observedMember("UNKNOWN-SKU", "unknown-offer")],
    };

    expect(() => buildListingRegistrationPlan(input)).toThrowError(
      expect.objectContaining({
        code: "MARKETPLACE_LISTING_REGISTRATION_INCLUDED_MEMBER_REQUIRED",
      }),
    );
  });

  it("rejects duplicate remote SKUs after normalization", () => {
    const input = planInput();
    input.observation = {
      ...input.observation,
      members: [
        ...input.observation.members,
        observedMember(" ARM-ENV-SGL-C750 ", "duplicate-offer"),
      ],
    };

    expect(() => buildListingRegistrationPlan(input)).toThrowError(
      expect.objectContaining({
        code: "MARKETPLACE_LISTING_REGISTRATION_REMOTE_DUPLICATE_SKU",
      }),
    );
  });

  it("rejects username or other mutable account identity schemes", () => {
    const input = planInput();
    input.observation = {
      ...input.observation,
      providerAccount: {
        ...input.observation.providerAccount,
        identityScheme: "username",
      } as typeof input.observation.providerAccount,
    };

    expect(() => buildListingRegistrationPlan(input)).toThrowError(
      expect.objectContaining({
        code: "MARKETPLACE_LISTING_REGISTRATION_ACCOUNT_IDENTITY_UNSTABLE",
      }),
    );
  });
});

function planInput(): MutablePlanInput {
  return {
    owner: {
      kind: "channel",
      channelId: 7,
      productId: 33,
      provider: "ebay",
      marketplaceId: "EBAY_US",
    },
    locator: {
      providerPublicationKey: "ARM-ENV-SGL-V2",
      externalListingId: "36412213011",
    },
    requestedBy: { type: "user", id: "admin@example.test" },
    idempotencyKey: "register-arm-envelope-v2",
    correlationId: "correlation-1",
    snapshot: {
      owner: {
        kind: "channel",
        channelId: 7,
        productId: 33,
        provider: "ebay",
        marketplaceId: "EBAY_US",
      },
      memberCandidates: [
        {
          productVariantId: 11,
          sku: "ARM-ENV-SGL-C750",
          isActive: false,
          availableQuantity: 0,
        },
        {
          productVariantId: 12,
          sku: "ARM-ENV-SGL-P50",
          isActive: true,
          availableQuantity: 71,
        },
        {
          productVariantId: 13,
          sku: "ARM-ENV-SGL-C700",
          isActive: false,
          availableQuantity: 4,
        },
      ],
    },
    observation: {
      providerAccount: {
        provider: "ebay",
        accountNamespace: "production",
        externalAccountId: "provider-user-123",
        identityScheme: "provider_user_id",
        externalDisplayNameSnapshot: "Cardshellz",
        evidenceHash: "a".repeat(64),
      },
      marketplaceId: "EBAY_US",
      publicationKeyIdentity: {
        identityNamespace: "ebay.sell.inventory.inventory_item_group",
        externalId: "ARM-ENV-SGL-V2",
      },
      listingIdentity: {
        identityNamespace: "ebay.sell.inventory.listing",
        externalId: "36412213011",
      },
      externalUrl: "https://example.test/listing/36412213011",
      isPublished: true,
      members: [
        observedMember("ARM-ENV-SGL-P50", "offer-p50"),
        observedMember("ARM-ENV-SGL-C750", "offer-c750"),
      ],
      evidence: { requestId: "request-1" },
      observedAt: new Date("2026-08-04T12:00:00.000Z"),
    },
  };
}

function observedMember(sku: string, offerId: string) {
  return {
    sku,
    variantIdentity: null,
    offerIdentity: {
      identityNamespace: "ebay.sell.inventory.offer",
      externalId: offerId,
    },
    inventoryItemIdentity: {
      identityNamespace: "ebay.sell.inventory.inventory_item",
      externalId: sku.trim(),
    },
  };
}

type MutablePlanInput = {
  -readonly [
    Key in keyof BuildListingRegistrationPlanInput
  ]: BuildListingRegistrationPlanInput[Key] extends readonly (infer Item)[]
    ? Item[]
    : BuildListingRegistrationPlanInput[Key];
};
