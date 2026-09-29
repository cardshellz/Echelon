import { describe, expect, it, vi } from "vitest";

import {
  EbayMarketplaceListingReplacementProvider,
  type EbayListingReplacementClient,
  type EbayReplacementItemGroup,
  type EbayReplacementOffer,
} from "../../infrastructure/providers/ebay/ebay-listing-replacement.provider";
import type { ListingReplacementExecutionContext } from "../../application/execution-ports";

describe("EbayMarketplaceListingReplacementProvider", () => {
  it("closes a stale replacement by observing the later verified P50/C750 listing, without writes", async () => {
    const harness = correctedHarness();
    await expect(
      harness.provider.ensureTargetNotSellable(
        correctedContext(),
        "target-off",
      ),
    ).resolves.toMatchObject({ evidence: { targetGroupAbsent: true } });
    await expect(
      harness.provider.ensureSourceLive(correctedContext(), "reconcile"),
    ).resolves.toMatchObject({
      externalListingId: "corrected-listing",
      evidence: {
        recoveryMode: "verified_source_read_only",
        sourceVerificationId: 8,
        excludedSkus: ["ARM-ENV-SGL-C700"],
      },
      memberIdentities: [{ productVariantId: 12 }, { productVariantId: 13 }],
    });
    expectNoProviderWrites(harness);
  });

  it.each([
    "missing",
    "excluded-live",
    "split",
    "duplicate",
    "offer-changed",
    "unknown-group-member",
    "target-present",
  ])(
    "does not mutate eBay when read-only recovery proof fails: %s",
    async (failure) => {
      const harness = correctedHarness();
      if (failure === "missing") harness.offers.set("ARM-ENV-SGL-C750", []);
      if (failure === "excluded-live")
        harness.offers.set("ARM-ENV-SGL-C700", [
          offer("offer-c700", "ARM-ENV-SGL-C700"),
        ]);
      if (failure === "split")
        harness.offers.set("ARM-ENV-SGL-C750", [
          {
            ...offer("offer-c750", "ARM-ENV-SGL-C750"),
            listingId: "other-listing",
          },
        ]);
      if (failure === "duplicate")
        harness.offers
          .get("ARM-ENV-SGL-C750")!
          .push(offer("another", "ARM-ENV-SGL-C750"));
      if (failure === "offer-changed")
        harness.offers.set("ARM-ENV-SGL-C750", [
          {
            ...offer("another", "ARM-ENV-SGL-C750"),
            listingId: "corrected-listing",
          },
        ]);
      if (failure === "unknown-group-member")
        harness.groups.set("ARM-ENV-SGL-V1", {
          ...harness.groups.get("ARM-ENV-SGL-V1")!,
          variantSKUs: ["UNKNOWN"],
        });
      if (failure === "target-present")
        harness.groups.set(
          "ARM-ENV-SGL-V1-R52",
          harness.groups.get("ARM-ENV-SGL-V1")!,
        );
      await expect(
        harness.provider.ensureSourceLive(correctedContext(), "reconcile"),
      ).rejects.toMatchObject({
        code: `MARKETPLACE_LISTING_REPLACEMENT_EBAY_${["target-present", "split", "duplicate", "offer-changed"].includes(failure) ? "RECOVERY_TARGET_NOT_ABSENT" : "RECOVERY_SOURCE_CHANGED"}`,
      });
      expectNoProviderWrites(harness);
    },
  );

  it("does not close an absent target group while one of its other offers is still live", async () => {
    const harness = correctedHarness();
    const recovery = {
      ...correctedContext(),
      targetMembers: [
        ...correctedContext().targetMembers,
        member(14, "ORPHAN", "offer-orphan"),
      ],
    };
    harness.offers.set("ORPHAN", [
      { ...offer("offer-orphan", "ORPHAN"), listingId: "abandoned-target" },
    ]);
    await expect(
      harness.provider.ensureTargetNotSellable(recovery, "target-off"),
    ).rejects.toMatchObject({
      code: "MARKETPLACE_LISTING_REPLACEMENT_EBAY_RECOVERY_TARGET_NOT_ABSENT",
    });
    expectNoProviderWrites(harness);
  });

  it("does not mutate eBay when its read fails", async () => {
    const harness = correctedHarness();
    harness.client.getInventoryItemGroup.mockRejectedValueOnce(
      new Error("read unavailable"),
    );
    await expect(
      harness.provider.ensureSourceLive(correctedContext(), "reconcile"),
    ).rejects.toThrow("read unavailable");
    expectNoProviderWrites(harness);
  });

  it("withdraws the source, publishes an exact target group, and verifies it", async () => {
    const harness = makeHarness();
    await expect(
      harness.provider.preflight(context(), "preflight-key"),
    ).resolves.toMatchObject({
      evidence: { sourceListingId: "source-listing" },
    });
    await harness.provider.quiesceSource(context(), "quiesce-key");
    expect(
      harness.client.withdrawOfferByInventoryItemGroup,
    ).toHaveBeenCalledWith("ARM-ENV-SGL-V1", "EBAY_US");

    const created = await harness.provider.createTarget(
      context(),
      "create-key",
    );
    expect(created).toMatchObject({
      externalListingId: "target-listing",
      providerPublicationKey: "ARM-ENV-SGL-V1-R52",
      memberIdentities: [
        { productVariantId: 12, externalOfferId: "offer-c750" },
        { productVariantId: 13, externalOfferId: "offer-p50" },
      ],
    });
    expect(harness.groups.get("ARM-ENV-SGL-V1-R52")?.variantSKUs).toEqual([
      "ARM-ENV-SGL-C750",
      "ARM-ENV-SGL-P50",
    ]);
    expect(harness.groups.get("ARM-ENV-SGL-V1-R52")?.variesBy).toEqual({
      specifications: [
        { name: "Style", values: ["Case of 750", "Pack of 50"] },
      ],
    });
    expect(
      harness.client.deleteInventoryItemGroup.mock.invocationCallOrder[0],
    ).toBeLessThan(
      harness.client.createOrReplaceInventoryItemGroup.mock
        .invocationCallOrder[0],
    );

    await expect(
      harness.provider.verifyTarget(stagedContext(), "verify-key"),
    ).resolves.toMatchObject({
      externalListingId: "target-listing",
    });
  });

  it("recognizes an already-live restored source under a new listing ID", async () => {
    const harness = makeHarness();
    const staleContext = {
      ...context(),
      sourcePublication: {
        ...context().sourcePublication,
        externalListingId: "withdrawn-listing",
      },
    };

    await expect(
      harness.provider.ensureSourceLive(staleContext, "recovery-key"),
    ).resolves.toMatchObject({
      externalListingId: "source-listing",
      evidence: {
        sourceLive: true,
        alreadyLive: true,
        previousSourceListingId: "withdrawn-listing",
        sourceListingId: "source-listing",
      },
    });
    expect(
      harness.client.publishOfferByInventoryItemGroup,
    ).not.toHaveBeenCalled();
  });
  it("treats an absent target group as already not sellable", async () => {
    const harness = makeHarness();

    await expect(
      harness.provider.ensureTargetNotSellable(context(), "target-off-key"),
    ).resolves.toMatchObject({
      evidence: {
        targetNotSellable: true,
        alreadyNotSellable: true,
        targetGroupAbsent: true,
        withdrawnOfferIds: [],
      },
    });
    expect(
      harness.client.withdrawOfferByInventoryItemGroup,
    ).not.toHaveBeenCalled();
  });

  it("compensates by withdrawing the target and restoring the original listing", async () => {
    const harness = makeHarness();
    await harness.provider.quiesceSource(context(), "quiesce-key");
    await harness.provider.createTarget(context(), "create-key");

    await expect(
      harness.provider.ensureTargetNotSellable(context(), "target-off-key"),
    ).resolves.toMatchObject({ evidence: { targetNotSellable: true } });
    expect(
      harness.client.withdrawOfferByInventoryItemGroup,
    ).toHaveBeenLastCalledWith("ARM-ENV-SGL-V1-R52", "EBAY_US");

    await expect(
      harness.provider.ensureSourceLive(stagedContext(), "source-live-key"),
    ).resolves.toMatchObject({ evidence: { sourceLive: true } });
    expect(
      harness.client.publishOfferByInventoryItemGroup,
    ).toHaveBeenLastCalledWith("ARM-ENV-SGL-V1", "EBAY_US");
    expect(harness.groups.has("ARM-ENV-SGL-V1-R52")).toBe(false);
    expect(harness.groups.get("ARM-ENV-SGL-V1")?.variantSKUs).toEqual([
      "ARM-ENV-SGL-C700",
      "ARM-ENV-SGL-P50",
    ]);
  });

  it("retries a target group create while eBay releases deleted source membership", async () => {
    const harness = makeHarness();
    harness.client.createOrReplaceInventoryItemGroup.mockImplementationOnce(
      async () => {
        throw new Error('{"errorId":25703}');
      },
    );

    await expect(
      harness.provider.createTarget(context(), "create-key"),
    ).resolves.toMatchObject({ externalListingId: "target-listing" });
    expect(
      harness.client.createOrReplaceInventoryItemGroup,
    ).toHaveBeenCalledTimes(2);
    expect(harness.consistency.sleep).toHaveBeenCalledWith(250);
  });

  it("rejects a target group containing an excluded stale SKU", async () => {
    const harness = makeHarness();
    harness.groups.set("ARM-ENV-SGL-V1-R52", {
      ...harness.groups.get("ARM-ENV-SGL-V1")!,
      variantSKUs: ["ARM-ENV-SGL-C700", "ARM-ENV-SGL-C750", "ARM-ENV-SGL-P50"],
    });

    await expect(
      harness.provider.createTarget(context(), "create-key"),
    ).rejects.toMatchObject({
      code: "MARKETPLACE_LISTING_REPLACEMENT_EBAY_GROUP_MEMBERSHIP_MISMATCH",
    });
  });
});

function context(): ListingReplacementExecutionContext {
  return {
    operationId: 100,
    operationStateVersion: 2,
    owner: {
      kind: "channel",
      channelId: 67,
      productId: 33,
      provider: "ebay",
      marketplaceId: "EBAY_US",
    },
    sourcePublication: {
      publicationId: 51,
      generation: 1,
      status: "active",
      desiredStateHash: "a".repeat(64),
      providerPublicationKey: "ARM-ENV-SGL-V1",
      externalListingId: "source-listing",
    },
    targetPublicationId: 52,
    targetGeneration: 2,
    targetProviderPublicationKey: null,
    targetExternalListingId: null,
    desiredStateHash: "b".repeat(64),
    sourceProviderSnapshot: {
      inventoryItemGroupKey: "ARM-ENV-SGL-V1",
      title: "Armaloope Envelope Single Pocket",
      description: "Envelope",
      aspects: {},
      imageUrls: [],
      variesBy: {
        specifications: [
          { name: "Style", values: ["Case of 700", "Pack of 50"] },
        ],
      },
      variantSKUs: ["ARM-ENV-SGL-C700", "ARM-ENV-SGL-P50"],
    },
    sourceMembers: [
      member(11, "ARM-ENV-SGL-C700", "offer-c700"),
      member(13, "ARM-ENV-SGL-P50", "offer-p50"),
    ],
    targetMembers: [
      member(12, "ARM-ENV-SGL-C750", null),
      member(13, "ARM-ENV-SGL-P50", null),
    ],
    actor: { type: "user", id: "admin-1" },
    correlationId: null,
  };
}

function correctedContext(): ListingReplacementExecutionContext {
  return {
    ...context(),
    sourceVerification: { id: 8, readOnlyRecovery: true },
    sourcePublication: {
      ...context().sourcePublication,
      externalListingId: "corrected-listing",
    },
    sourceMembers: [
      {
        ...member(11, "ARM-ENV-SGL-C700", null),
        disposition: "excluded",
        reasonCode: "not_in_observed_publication",
      },
      member(12, "ARM-ENV-SGL-C750", "offer-c750"),
      member(13, "ARM-ENV-SGL-P50", "offer-p50"),
    ],
  };
}

function correctedHarness() {
  const harness = makeHarness();
  harness.groups.set("ARM-ENV-SGL-V1", {
    ...harness.groups.get("ARM-ENV-SGL-V1")!,
    variantSKUs: ["ARM-ENV-SGL-C700", "ARM-ENV-SGL-C750", "ARM-ENV-SGL-P50"],
  });
  harness.offers.set("ARM-ENV-SGL-C700", [
    {
      ...offer("offer-c700", "ARM-ENV-SGL-C700"),
      status: "UNPUBLISHED",
      listingId: undefined,
    },
  ]);
  for (const sku of ["ARM-ENV-SGL-P50", "ARM-ENV-SGL-C750"]) {
    harness.offers.set(
      sku,
      harness.offers
        .get(sku)!
        .map((entry) => ({ ...entry, listingId: "corrected-listing" })),
    );
  }
  return harness;
}

function expectNoProviderWrites(harness: ReturnType<typeof makeHarness>) {
  for (const method of [
    "createOrReplaceInventoryItemGroup",
    "deleteInventoryItemGroup",
    "createOffer",
    "publishOffer",
    "publishOfferByInventoryItemGroup",
    "withdrawOffer",
    "withdrawOfferByInventoryItemGroup",
  ] as const) {
    expect(harness.client[method]).not.toHaveBeenCalled();
  }
}

function stagedContext(): ListingReplacementExecutionContext {
  return {
    ...context(),
    operationStateVersion: 8,
    targetProviderPublicationKey: "ARM-ENV-SGL-V1-R52",
    targetExternalListingId: "target-listing",
    targetMembers: context().targetMembers.map((member) => ({
      ...member,
      externalVariantId:
        member.productVariantId === 12 ? "offer-c750" : "offer-p50",
      externalOfferId:
        member.productVariantId === 12 ? "offer-c750" : "offer-p50",
      externalInventoryItemId: member.skuSnapshot,
    })),
  };
}

function member(
  productVariantId: number,
  skuSnapshot: string,
  offerId: string | null,
) {
  return {
    productVariantId,
    skuSnapshot,
    disposition: "included" as const,
    reasonCode: null,
    externalVariantId: offerId,
    externalOfferId: offerId,
    externalInventoryItemId: skuSnapshot,
  };
}

function makeHarness() {
  const groups = new Map<string, EbayReplacementItemGroup>([
    [
      "ARM-ENV-SGL-V1",
      {
        inventoryItemGroupKey: "ARM-ENV-SGL-V1",
        title: "Armaloope Envelope Single Pocket",
        description: "Envelope",
        aspects: {},
        imageUrls: [],
        variesBy: { specifications: [] },
        variantSKUs: ["ARM-ENV-SGL-C700", "ARM-ENV-SGL-P50"],
      },
    ],
  ]);
  const offers = new Map<string, EbayReplacementOffer[]>([
    ["ARM-ENV-SGL-C700", [offer("offer-c700", "ARM-ENV-SGL-C700")]],
    ["ARM-ENV-SGL-C750", [offer("offer-c750", "ARM-ENV-SGL-C750")]],
    ["ARM-ENV-SGL-P50", [offer("offer-p50", "ARM-ENV-SGL-P50")]],
  ]);
  const setListing = (groupKey: string, listingId: string, status: string) => {
    const group = groups.get(groupKey);
    for (const sku of group?.variantSKUs ?? []) {
      const existing = offers.get(sku);
      if (!existing) continue;
      offers.set(
        sku,
        existing.map((item) => ({ ...item, listingId, status })),
      );
    }
  };
  const consistency = { sleep: vi.fn(async () => undefined) };
  const client = {
    getInventoryItemGroup: vi.fn(
      async (key: string) => groups.get(key) ?? null,
    ),
    createOrReplaceInventoryItemGroup: vi.fn(
      async (key: string, group: EbayReplacementItemGroup) => {
        groups.set(key, { ...group, inventoryItemGroupKey: key });
      },
    ),
    getInventoryItem: vi.fn(async (sku: string) => ({
      product: {
        aspects: {
          Style: [
            sku.endsWith("C750")
              ? "Case of 750"
              : sku.endsWith("C700")
                ? "Case of 700"
                : "Pack of 50",
          ],
        },
      },
    })),
    deleteInventoryItemGroup: vi.fn(async (key: string) => {
      groups.delete(key);
    }),
    getOffers: vi.fn(async (sku: string) => offers.get(sku) ?? []),
    createOffer: vi.fn(async () => "new-offer"),
    publishOffer: vi.fn(async () => ({ listingId: "target-listing" })),
    publishOfferByInventoryItemGroup: vi.fn(async (key: string) => {
      const listingId =
        key === "ARM-ENV-SGL-V1" ? "source-listing" : "target-listing";
      setListing(key, listingId, "PUBLISHED");
      return { listingId };
    }),
    withdrawOffer: vi.fn(async () => undefined),
    withdrawOfferByInventoryItemGroup: vi.fn(async (key: string) => {
      const listingId =
        key === "ARM-ENV-SGL-V1" ? "source-listing" : "target-listing";
      setListing(key, listingId, "WITHDRAWN");
    }),
  } satisfies EbayListingReplacementClient;
  return {
    groups,
    offers,
    client,
    consistency,
    provider: new EbayMarketplaceListingReplacementProvider(
      { forOwner: async () => client },
      consistency,
    ),
  };
}

function offer(offerId: string, sku: string): EbayReplacementOffer {
  return {
    offerId,
    sku,
    listingId: "source-listing",
    status: "PUBLISHED",
  };
}
