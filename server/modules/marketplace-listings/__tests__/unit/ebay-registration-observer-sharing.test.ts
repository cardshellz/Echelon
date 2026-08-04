import { describe, expect, it, vi } from "vitest";

import type { EbayAuthService } from "../../../channels/adapters/ebay/ebay-auth.service";
import { createEbayMarketplaceRegistrationAdapters } from "../../../channels/adapters/ebay/ebay-marketplace-registration.factory";
import type { EbayMarketplaceRegistrationOwnerRepository } from "../../../channels/adapters/ebay/ebay-marketplace-registration-owner.reader";
import type { DropshipMarketplaceRegistrationOwnerRepository } from "../../../dropship/application/dropship-marketplace-registration-owner-reader";
import type { DropshipEbayRegistrationCredentialProvider } from "../../../dropship/infrastructure/dropship-ebay-registration-credentials";
import { createDropshipMarketplaceRegistrationAdapters } from "../../../dropship/infrastructure/dropship-marketplace-registration.factory";
import type { MarketplaceListingProviderAccountClaimer } from "../../application/registration-ports";
import type { ListingOwnerRef } from "../../domain/listing-replacement-plan";
import {
  buildEbayRegistrationIdentityNamespace,
  type EbayRegistrationReadRequest,
  type EbayRegistrationReadResponse,
  type EbayRegistrationReadTransport,
} from "../../infrastructure/providers/ebay/ebay-registration-contracts";
import { EbayMarketplaceRegistrationObserver } from "../../infrastructure/providers/ebay/ebay-registration-observer";

const fixedNow = new Date("2026-08-04T18:00:00.000Z");
const channelOwner = {
  kind: "channel" as const,
  channelId: 67,
  productId: 10,
  provider: "ebay",
  marketplaceId: "EBAY_US",
};
const dropshipOwner = {
  kind: "dropship" as const,
  storeConnectionId: 21,
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
] as const;

describe("shared eBay marketplace registration observer", () => {
  it("produces identical canonical identities for Channel and Dropship owners", async () => {
    const credentialOwners: ListingOwnerRef[] = [];
    const observer = new EbayMarketplaceRegistrationObserver(
      {
        loadFreshCredential: vi.fn(async (owner: ListingOwnerRef) => {
          credentialOwners.push(owner);
          return {
            accessToken: "shared-access-token",
            environment: "production" as const,
          };
        }),
      },
      completeGroupTransport(),
      { now: () => fixedNow },
    );
    const locator = {
      providerPublicationKey: "ARM-ENV-SGL-V1",
      externalListingId: "listing-123",
    };

    const channel = await observer.observeExistingPublication({
      owner: channelOwner,
      locator,
      memberCandidates: candidates,
    });
    const dropship = await observer.observeExistingPublication({
      owner: dropshipOwner,
      locator,
      memberCandidates: candidates,
    });

    expect(identityProjection(channel)).toEqual(identityProjection(dropship));
    expect(identityProjection(channel)).toEqual({
      accountNamespace: "production",
      publicationNamespace:
        "ebay:production:EBAY_US:inventory_item_group",
      listingNamespace: "ebay:production:EBAY_US:listing",
      memberNamespaces: [
        {
          sku: "ARM-ENV-SGL-C700",
          offer: "ebay:production:EBAY_US:offer",
          inventoryItem: "ebay:production:EBAY_US:inventory_item",
        },
        {
          sku: "ARM-ENV-SGL-C750",
          offer: "ebay:production:EBAY_US:offer",
          inventoryItem: "ebay:production:EBAY_US:inventory_item",
        },
      ],
    });
    expect(credentialOwners).toEqual([channelOwner, dropshipOwner]);
  });

  it("composes the exact shared observer class in both owner factories", () => {
    const transport = completeGroupTransport();
    const channelRepository: EbayMarketplaceRegistrationOwnerRepository = {
      loadChannel: vi.fn(),
      loadProduct: vi.fn(),
      loadAllProductVariants: vi.fn(),
    };
    const channelAdapters = createEbayMarketplaceRegistrationAdapters({
      authService: {
        getEnvironment: () => "production",
        getAccessToken: vi.fn(async () => "channel-token"),
        claimObservedProviderAccount: vi.fn(),
      } as unknown as EbayAuthService,
      ownerRepository: channelRepository,
      transport,
    });

    const dropshipRepository: DropshipMarketplaceRegistrationOwnerRepository = {
      loadStoreConnection: vi.fn(),
      loadProductAccess: vi.fn(),
      loadAllProductVariants: vi.fn(),
    };
    const accountClaimer: MarketplaceListingProviderAccountClaimer = {
      claimStableProviderAccount: vi.fn(),
    };
    const credentialProvider: DropshipEbayRegistrationCredentialProvider = {
      loadFreshForStoreConnection: vi.fn(),
    };
    const dropshipAdapters = createDropshipMarketplaceRegistrationAdapters({
      ownerRepository: dropshipRepository,
      accountClaimer,
      credentialProvider,
      transport,
    });

    expect(channelAdapters.observer).toBeInstanceOf(
      EbayMarketplaceRegistrationObserver,
    );
    expect(dropshipAdapters.observer).toBeInstanceOf(
      EbayMarketplaceRegistrationObserver,
    );
    expect(channelAdapters.observer.constructor).toBe(
      dropshipAdapters.observer.constructor,
    );
  });

  it("rejects identity namespace values outside the closed contract", () => {
    expect(() => buildEbayRegistrationIdentityNamespace({
      environment: "production",
      marketplaceId: "EBAY_US",
      role: "listing",
    })).not.toThrow();
    expect(() => buildEbayRegistrationIdentityNamespace({
      environment: "production",
      marketplaceId: "EBAY_US",
      role: "publication" as "listing",
    })).toThrowError(expect.objectContaining({
      code: "EBAY_REGISTRATION_IDENTITY_ROLE_INVALID",
    }));
  });
});

function completeGroupTransport(): EbayRegistrationReadTransport {
  return {
    async get(
      request: EbayRegistrationReadRequest,
    ): Promise<EbayRegistrationReadResponse> {
      const url = new URL(request.path, "https://api.ebay.com");
      if (url.pathname === "/commerce/identity/v1/user/") {
        return {
          status: 200,
          body: { userId: "seller-immutable-1", username: "seller-name" },
        };
      }
      if (url.pathname.endsWith("/inventory_item_group/ARM-ENV-SGL-V1")) {
        return {
          status: 200,
          body: {
            inventoryItemGroupKey: "ARM-ENV-SGL-V1",
            variantSKUs: ["ARM-ENV-SGL-C700", "ARM-ENV-SGL-C750"],
          },
        };
      }
      if (url.pathname.includes("/inventory_item/")) {
        const sku = decodeURIComponent(url.pathname.split("/").at(-1)!);
        return {
          status: 200,
          body: { sku, groupIds: ["ARM-ENV-SGL-V1"] },
        };
      }
      if (url.pathname.endsWith("/offer")) {
        const sku = url.searchParams.get("sku");
        return {
          status: 200,
          body: {
            total: 1,
            offers: [{
              offerId: sku === "ARM-ENV-SGL-C700"
                ? "offer-c700"
                : "offer-c750",
              sku,
              marketplaceId: "EBAY_US",
              status: "PUBLISHED",
              listing: {
                listingId: "listing-123",
                listingStatus: sku === "ARM-ENV-SGL-C700"
                  ? "OUT_OF_STOCK"
                  : "ACTIVE",
              },
            }],
          },
        };
      }
      throw new Error(`Unexpected eBay registration read: ${request.path}`);
    },
  };
}

function identityProjection(observation: {
  readonly providerAccount: { readonly accountNamespace: string };
  readonly publicationKeyIdentity: { readonly identityNamespace: string } | null;
  readonly listingIdentity: { readonly identityNamespace: string };
  readonly members: readonly {
    readonly sku: string;
    readonly offerIdentity: { readonly identityNamespace: string } | null;
    readonly inventoryItemIdentity: { readonly identityNamespace: string } | null;
  }[];
}) {
  return {
    accountNamespace: observation.providerAccount.accountNamespace,
    publicationNamespace:
      observation.publicationKeyIdentity?.identityNamespace ?? null,
    listingNamespace: observation.listingIdentity.identityNamespace,
    memberNamespaces: observation.members.map((member) => ({
      sku: member.sku,
      offer: member.offerIdentity?.identityNamespace ?? null,
      inventoryItem:
        member.inventoryItemIdentity?.identityNamespace ?? null,
    })),
  };
}
