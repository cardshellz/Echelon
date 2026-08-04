import { describe, expect, it, vi } from "vitest";

import { buildListingRegistrationPlan } from "../../../marketplace-listings/domain/listing-registration-plan";
import {
  EbayMarketplaceRegistrationObserver,
} from "../../../marketplace-listings/infrastructure/providers/ebay/ebay-registration-observer";
import {
  FetchEbayRegistrationReadTransport,
  buildEbayProviderAccountEvidenceHash,
  type EbayRegistrationReadRequest,
  type EbayRegistrationReadResponse,
  type EbayRegistrationReadTransport,
} from "../../../marketplace-listings/infrastructure/providers/ebay/ebay-registration-contracts";
import {
  EbayMarketplaceListingProviderAccountClaimer,
} from "../../adapters/ebay/ebay-marketplace-registration.provider-adapters";

const fixedNow = new Date("2026-08-04T16:00:00.000Z");
const owner = {
  kind: "channel" as const,
  channelId: 67,
  productId: 10,
  provider: "ebay",
  marketplaceId: "EBAY_US",
};
const candidates = [
  {
    productVariantId: 701,
    sku: "ARM-ENV-SGL-C700",
    isActive: false,
    availableQuantity: 0,
  },
  {
    productVariantId: 702,
    sku: "ARM-ENV-SGL-C750",
    isActive: true,
    availableQuantity: 507,
  },
];

interface RawOffer {
  offerId: string;
  sku: string;
  marketplaceId: string;
  status: "PUBLISHED" | "UNPUBLISHED";
  listing?: { listingId: string; listingStatus: string };
}

interface FixtureOptions {
  readonly username?: string;
  readonly userId?: string;
  readonly groupKey?: string;
  readonly groupSkus: readonly string[];
  readonly groupIdsBySku?: Readonly<Record<string, readonly string[]>>;
  readonly offersBySku: Readonly<Record<string, readonly RawOffer[]>>;
}

function publishedOffer(
  offerId: string,
  sku: string,
  listingId: string,
  listingStatus = "ACTIVE",
): RawOffer {
  return {
    offerId,
    sku,
    marketplaceId: "EBAY_US",
    status: "PUBLISHED",
    listing: { listingId, listingStatus },
  };
}

function fixtureTransport(options: FixtureOptions): EbayRegistrationReadTransport & {
  get: ReturnType<typeof vi.fn>;
} {
  const groupKey = options.groupKey ?? "ARM-ENV-SGL-V1";
  return {
    get: vi.fn(async (request: EbayRegistrationReadRequest): Promise<EbayRegistrationReadResponse> => {
      const baseUrl = request.environment === "sandbox"
        ? "https://api.sandbox.ebay.com"
        : "https://api.ebay.com";
      const url = new URL(request.path, baseUrl);
      if (url.pathname === "/commerce/identity/v1/user/") {
        return {
          status: 200,
          body: {
            userId: options.userId ?? "immutable-seller-1",
            username: options.username ?? "display-seller",
          },
        };
      }
      if (url.pathname.includes("/inventory_item_group/")) {
        return {
          status: 200,
          body: {
            inventoryItemGroupKey: groupKey,
            variantSKUs: [...options.groupSkus],
          },
        };
      }
      if (url.pathname.includes("/inventory_item/")) {
        const sku = decodeURIComponent(url.pathname.split("/").at(-1)!);
        return {
          status: 200,
          body: {
            sku,
            groupIds: options.groupIdsBySku?.[sku] ?? [groupKey],
          },
        };
      }
      if (url.pathname.endsWith("/offer")) {
        const sku = url.searchParams.get("sku")!;
        const offset = Number(url.searchParams.get("offset"));
        const limit = Number(url.searchParams.get("limit"));
        const all = [...(options.offersBySku[sku] ?? [])];
        return {
          status: 200,
          body: {
            total: all.length,
            offers: all.slice(offset, offset + limit),
          },
        };
      }
      throw new Error(`Unexpected eBay read ${request.path}`);
    }),
  };
}

function observer(
  transport: EbayRegistrationReadTransport,
  pageSize = 200,
): EbayMarketplaceRegistrationObserver {
  return new EbayMarketplaceRegistrationObserver(
    {
      loadFreshCredential: vi.fn(async () => ({
        accessToken: "access-token",
        environment: "production" as const,
      })),
    },
    transport,
    {

      now: () => fixedNow,
      pageSize,
    },
  );
}

function groupInput(
  memberCandidates = candidates,
  externalListingId: string | null = "listing-123",
) {
  return {
    owner,
    locator: {
      providerPublicationKey: "ARM-ENV-SGL-V1",
      externalListingId,
    },
    memberCandidates,
  };
}

describe("EbayMarketplaceRegistrationObserver", () => {
  it("observes complete group membership including inactive C700 and zero quantity", async () => {
    const transport = fixtureTransport({
      groupSkus: ["ARM-ENV-SGL-C700", "ARM-ENV-SGL-C750"],
      offersBySku: {
        "ARM-ENV-SGL-C700": [
          publishedOffer("offer-c700", "ARM-ENV-SGL-C700", "listing-123", "OUT_OF_STOCK"),
        ],
        "ARM-ENV-SGL-C750": [
          publishedOffer("offer-c750", "ARM-ENV-SGL-C750", "listing-123"),
        ],
      },
    });

    const result = await observer(transport).observeExistingPublication(groupInput());

    expect(result).toMatchObject({
      providerAccount: {
        provider: "ebay",
        externalAccountId: "immutable-seller-1",
        identityScheme: "provider_user_id",
      },
      marketplaceId: "EBAY_US",
      publicationKeyIdentity: { externalId: "ARM-ENV-SGL-V1" },
      listingIdentity: { externalId: "listing-123" },
      isPublished: true,
      observedAt: fixedNow,
    });
    expect(result.members).toEqual([
      expect.objectContaining({
        sku: "ARM-ENV-SGL-C700",
        variantIdentity: null,
        offerIdentity: expect.objectContaining({ externalId: "offer-c700" }),
        inventoryItemIdentity: expect.objectContaining({ externalId: "ARM-ENV-SGL-C700" }),
      }),
      expect.objectContaining({
        sku: "ARM-ENV-SGL-C750",
        variantIdentity: null,
        offerIdentity: expect.objectContaining({ externalId: "offer-c750" }),
        inventoryItemIdentity: expect.objectContaining({ externalId: "ARM-ENV-SGL-C750" }),
      }),
    ]);
  });

  it("exhausts offer pagination and selects the exact listing instead of offers[0]", async () => {
    const transport = fixtureTransport({
      groupSkus: ["ARM-ENV-SGL-C750"],
      offersBySku: {
        "ARM-ENV-SGL-C750": [
          publishedOffer("wrong-first", "ARM-ENV-SGL-C750", "listing-old"),
          publishedOffer("exact-second", "ARM-ENV-SGL-C750", "listing-123"),
        ],
      },
    });

    const result = await observer(transport, 1).observeExistingPublication(
      groupInput([candidates[1]]),
    );

    expect(result.members[0].offerIdentity?.externalId).toBe("exact-second");
    const offerOffsets = transport.get.mock.calls
      .map(([request]) => new URL(request.path, "https://api.ebay.com"))
      .filter((url) => url.pathname.endsWith("/offer"))
      .map((url) => url.searchParams.get("offset"));
    expect(offerOffsets).toEqual(["0", "1"]);
  });

  it("rejects multiple matching offers instead of choosing one", async () => {
    const transport = fixtureTransport({
      groupSkus: ["ARM-ENV-SGL-C750"],
      offersBySku: {
        "ARM-ENV-SGL-C750": [
          publishedOffer("offer-1", "ARM-ENV-SGL-C750", "listing-123"),
          publishedOffer("offer-2", "ARM-ENV-SGL-C750", "listing-123"),
        ],
      },
    });

    await expect(
      observer(transport).observeExistingPublication(groupInput([candidates[1]])),
    ).rejects.toMatchObject({ code: "EBAY_REGISTRATION_OFFER_AMBIGUOUS" });
  });

  it("rejects group/listing and reverse-membership inconsistencies", async () => {
    const listingMismatch = fixtureTransport({
      groupSkus: ["ARM-ENV-SGL-C700", "ARM-ENV-SGL-C750"],
      offersBySku: {
        "ARM-ENV-SGL-C700": [
          publishedOffer("offer-c700", "ARM-ENV-SGL-C700", "listing-123"),
        ],
        "ARM-ENV-SGL-C750": [
          publishedOffer("offer-c750", "ARM-ENV-SGL-C750", "listing-999"),
        ],
      },
    });
    const groupMismatch = fixtureTransport({
      groupSkus: ["ARM-ENV-SGL-C700"],
      groupIdsBySku: { "ARM-ENV-SGL-C700": [] },
      offersBySku: {
        "ARM-ENV-SGL-C700": [
          publishedOffer("offer-c700", "ARM-ENV-SGL-C700", "listing-123"),
        ],
      },
    });

    await expect(
      observer(listingMismatch).observeExistingPublication(
        groupInput(candidates, null),
      ),
    ).rejects.toMatchObject({ code: "EBAY_REGISTRATION_LISTING_AMBIGUOUS" });
    await expect(
      observer(groupMismatch).observeExistingPublication(
        groupInput([candidates[0]]),
      ),
    ).rejects.toMatchObject({
      code: "EBAY_REGISTRATION_GROUP_MEMBERSHIP_INCONSISTENT",
    });
  });

  it("rejects a published offer whose listing is no longer live", async () => {
    const transport = fixtureTransport({
      groupSkus: ["ARM-ENV-SGL-C750"],
      offersBySku: {
        "ARM-ENV-SGL-C750": [
          publishedOffer("offer-c750", "ARM-ENV-SGL-C750", "listing-123", "ENDED"),
        ],
      },
    });

    await expect(
      observer(transport).observeExistingPublication(groupInput([candidates[1]])),
    ).rejects.toMatchObject({ code: "EBAY_REGISTRATION_LISTING_NOT_LIVE" });
  });

  it("returns unknown remote group SKUs so the registration domain rejects them", async () => {
    const transport = fixtureTransport({
      groupSkus: ["ARM-ENV-SGL-C750", "REMOTE-UNKNOWN"],
      offersBySku: {
        "ARM-ENV-SGL-C750": [
          publishedOffer("offer-c750", "ARM-ENV-SGL-C750", "listing-123"),
        ],
        "REMOTE-UNKNOWN": [
          publishedOffer("offer-remote", "REMOTE-UNKNOWN", "listing-123"),
        ],
      },
    });
    const input = groupInput([candidates[1]]);
    const observation = await observer(transport).observeExistingPublication(input);

    expect(observation.members.map((member) => member.sku)).toEqual([
      "ARM-ENV-SGL-C750",
      "REMOTE-UNKNOWN",
    ]);
    expect(() => buildListingRegistrationPlan({
      owner,
      locator: input.locator,
      requestedBy: { type: "user", id: "user-1" },
      snapshot: { owner, memberCandidates: input.memberCandidates },
      observation,
      idempotencyKey: "registration-1",
      correlationId: null,
    })).toThrowError(expect.objectContaining({
      code: "MARKETPLACE_LISTING_REGISTRATION_REMOTE_UNKNOWN_SKU",
    }));
  });

  it("discovers one shared group from a listing locator without treating repeated group IDs as ambiguous", async () => {
    const transport = fixtureTransport({
      groupSkus: ["ARM-ENV-SGL-C700", "ARM-ENV-SGL-C750"],
      offersBySku: {
        "ARM-ENV-SGL-C700": [
          publishedOffer("offer-c700", "ARM-ENV-SGL-C700", "listing-123"),
        ],
        "ARM-ENV-SGL-C750": [
          publishedOffer("offer-c750", "ARM-ENV-SGL-C750", "listing-123"),
        ],
      },
    });
    const result = await observer(transport).observeExistingPublication({
      owner,
      locator: {
        providerPublicationKey: null,
        externalListingId: "listing-123",
      },
      memberCandidates: candidates,
    });

    expect(result.publicationKeyIdentity?.externalId).toBe("ARM-ENV-SGL-V1");
    expect(result.members.map((member) => member.sku)).toEqual([
      "ARM-ENV-SGL-C700",
      "ARM-ENV-SGL-C750",
    ]);
  });

  it("validates candidate input before requesting an auth token", async () => {
    const loadFreshCredential = vi.fn(async () => ({
      accessToken: "access-token",
      environment: "production" as const,
    }));
    const instance = new EbayMarketplaceRegistrationObserver(
      { loadFreshCredential },
      fixtureTransport({
        groupSkus: ["ARM-ENV-SGL-C750"],
        offersBySku: {
          "ARM-ENV-SGL-C750": [
            publishedOffer("offer-c750", "ARM-ENV-SGL-C750", "listing-123"),
          ],
        },
      }),
      { now: () => fixedNow },
    );

    await expect(instance.observeExistingPublication({
      owner,
      locator: {
        providerPublicationKey: "ARM-ENV-SGL-V1",
        externalListingId: "listing-123",
      },
      memberCandidates: [],
    })).rejects.toThrow();
    expect(loadFreshCredential).not.toHaveBeenCalled();
  });

  it("keeps account evidence stable when the display username changes", async () => {
    const fixture = {
      groupSkus: ["ARM-ENV-SGL-C750"],
      offersBySku: {
        "ARM-ENV-SGL-C750": [
          publishedOffer("offer-c750", "ARM-ENV-SGL-C750", "listing-123"),
        ],
      },
    };
    const before = await observer(fixtureTransport({
      ...fixture,
      username: "old-display-name",
      userId: "immutable-seller-1",
    })).observeExistingPublication(groupInput([candidates[1]]));
    const after = await observer(fixtureTransport({
      ...fixture,
      username: "new-display-name",
      userId: "immutable-seller-1",
    })).observeExistingPublication(groupInput([candidates[1]]));

    expect(before.providerAccount.externalDisplayNameSnapshot).toBe(
      "old-display-name",
    );
    expect(after.providerAccount.externalDisplayNameSnapshot).toBe(
      "new-display-name",
    );
    expect(after.providerAccount.evidenceHash).toBe(
      before.providerAccount.evidenceHash,
    );
  });

  it("hashes account evidence without username or observation time", () => {
    expect(
      buildEbayProviderAccountEvidenceHash("production", "immutable-seller-1"),
    ).toBe(
      buildEbayProviderAccountEvidenceHash("production", "immutable-seller-1"),
    );
    expect(
      buildEbayProviderAccountEvidenceHash("sandbox", "immutable-seller-1"),
    ).not.toBe(
      buildEbayProviderAccountEvidenceHash("production", "immutable-seller-1"),
    );
  });

  it("claims the exact environment-qualified account only during confirmation", async () => {
    const claimObservedProviderAccount = vi.fn(async () => ({
      kind: "claimed" as const,
      account: {
        externalAccountId: "immutable-seller-1",
        externalAccountDisplayName: "display-seller",
        externalAccountIdentityScheme: "provider_user_id" as const,
        externalAccountVerifiedAt: fixedNow,
      },
    }));
    const authService = {
      getEnvironment: () => "production" as const,
      claimObservedProviderAccount,
    };
    const claimer = new EbayMarketplaceListingProviderAccountClaimer(
      authService as any,
    );
    const providerAccount = {
      provider: "ebay",
      accountNamespace: "production",
      externalAccountId: "immutable-seller-1",
      identityScheme: "provider_user_id" as const,
      externalDisplayNameSnapshot: "display-seller",
      evidenceHash: buildEbayProviderAccountEvidenceHash(
        "production",
        "immutable-seller-1",
      ),
    };

    await expect(claimer.claimStableProviderAccount({
      owner,
      providerAccount,
      idempotencyKey: "registration-1",
      observationHash: "a".repeat(64),
      observedAt: fixedNow,
      requestedBy: { type: "user", id: "user-1" },
      correlationId: null,
    })).resolves.toMatchObject({
      kind: "claimed",
      owner,
      accountNamespace: "production",
      externalAccountId: "immutable-seller-1",
      verifiedAt: fixedNow,
    });
    expect(claimObservedProviderAccount).toHaveBeenCalledWith(
      67,
      expect.objectContaining({
        externalAccountId: "immutable-seller-1",
        externalAccountDisplayName: "display-seller",
      }),
      expect.objectContaining({
        idempotencyKey: "registration-1",
        observationHash: "a".repeat(64),
        requestedBy: { type: "user", id: "user-1" },
      }),
    );

    await expect(claimer.claimStableProviderAccount({
      owner,
      providerAccount: { ...providerAccount, accountNamespace: "sandbox" },
      idempotencyKey: "registration-2",
      observationHash: "b".repeat(64),
      observedAt: fixedNow,
      requestedBy: { type: "user", id: "user-1" },
      correlationId: null,
    })).rejects.toMatchObject({
      code: "EBAY_REGISTRATION_ACCOUNT_CLAIM_INVALID",
    });
    expect(claimObservedProviderAccount).toHaveBeenCalledTimes(1);
  });

  it("uses an HTTP transport that can only issue approved eBay GET requests", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    const transport = new FetchEbayRegistrationReadTransport(
      fetchFn,
    );

    await transport.get({
      environment: "production",
      path: "/commerce/identity/v1/user/",
      accessToken: "token",
      marketplaceId: "EBAY_US",
    });

    expect(fetchFn).toHaveBeenCalledWith(
      "https://api.ebay.com/commerce/identity/v1/user/",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("rejects bearer-token exfiltration to non-eBay or wrong-environment URLs", async () => {
    const fetchFn = vi.fn<typeof fetch>();
    const transport = new FetchEbayRegistrationReadTransport(
      fetchFn,
    );

    await expect(transport.get({
      environment: "production",
      path: "https://attacker.example/sell/inventory/v1/offer",
      accessToken: "secret-token",
      marketplaceId: "EBAY_US",
    })).rejects.toMatchObject({
      code: "EBAY_REGISTRATION_READ_PATH_INVALID",
    });
    await expect(transport.get({
      environment: "production",
      path: "//api.sandbox.ebay.com/sell/inventory/v1/offer",
      accessToken: "secret-token",
      marketplaceId: "EBAY_US",
    })).rejects.toMatchObject({
      code: "EBAY_REGISTRATION_READ_PATH_INVALID",
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
