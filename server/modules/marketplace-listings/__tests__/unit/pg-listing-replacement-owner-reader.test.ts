import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

import type { ListingOwnerRef } from "../../domain/listing-replacement-plan";
import { PgMarketplaceListingReplacementOwnerReader } from "../../infrastructure/pg-listing-replacement-owner-reader";

const CHANNEL_OWNER: ListingOwnerRef = {
  kind: "channel",
  channelId: 7,
  productId: 33,
  provider: "ebay",
  marketplaceId: "EBAY_US",
};

describe("PgMarketplaceListingReplacementOwnerReader", () => {
  it("loads a deterministic Channel snapshot from the active registered publication", async () => {
    const query = vi.fn(async () => ({
      rows: [
        row(12, "ARM-ENV-SGL-C750", "included"),
        row(13, "ARM-ENV-SGL-P50", "excluded"),
      ],
    }));
    const reader = new PgMarketplaceListingReplacementOwnerReader({
      query,
    } as unknown as Pool);

    await expect(reader.loadSnapshot(CHANNEL_OWNER)).resolves.toEqual({
      owner: CHANNEL_OWNER,
      scopeId: 41,
      sourcePublication: {
        publicationId: 51,
        generation: 2,
        status: "active",
        desiredStateHash: "a".repeat(64),
        providerPublicationKey: "ARM-ENV-SGL",
        externalListingId: "36412213011",
      },
      nextGeneration: 3,
      memberCandidates: [
        {
          productVariantId: 12,
          sku: "ARM-ENV-SGL-C750",
          currentlyPublished: true,
        },
        {
          productVariantId: 13,
          sku: "ARM-ENV-SGL-P50",
          currentlyPublished: false,
        },
      ],
    });
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("cls.channel_id = $5"),
      ["channel", "ebay", "EBAY_US", 33, 7],
    );
  });

  it("uses the Dropship binding without changing the shared snapshot contract", async () => {
    const owner: ListingOwnerRef = {
      kind: "dropship",
      storeConnectionId: 91,
      productId: 33,
      provider: "ebay",
      marketplaceId: "EBAY_US",
    };
    const query = vi.fn(async () => ({
      rows: [row(12, "ARM-ENV-SGL-C750", "included")],
    }));
    const reader = new PgMarketplaceListingReplacementOwnerReader({
      query,
    } as unknown as Pool);

    await expect(reader.loadSnapshot(owner)).resolves.toMatchObject({
      owner,
      scopeId: 41,
    });
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("dls.store_connection_id = $5"),
      ["dropship", "ebay", "EBAY_US", 33, 91],
    );
  });

  it("fails closed when no active source is registered", async () => {
    const reader = new PgMarketplaceListingReplacementOwnerReader({
      query: vi.fn(async () => ({ rows: [] })),
    } as unknown as Pool);
    await expect(reader.loadSnapshot(CHANNEL_OWNER)).rejects.toMatchObject({
      code: "MARKETPLACE_LISTING_REPLACEMENT_ACTIVE_SOURCE_NOT_FOUND",
    });
  });

  it("rejects inconsistent rows instead of merging publications", async () => {
    const changed = {
      ...row(13, "ARM-ENV-SGL-P50", "included"),
      publication_id: "52",
    };
    const reader = new PgMarketplaceListingReplacementOwnerReader({
      query: vi.fn(async () => ({
        rows: [row(12, "ARM-ENV-SGL-C750", "included"), changed],
      })),
    } as unknown as Pool);
    await expect(reader.loadSnapshot(CHANNEL_OWNER)).rejects.toMatchObject({
      code: "MARKETPLACE_LISTING_REPLACEMENT_SOURCE_CONTRACT_INVALID",
    });
  });
});

function row(productVariantId: number, sku: string, disposition: string) {
  return {
    scope_id: "41",
    publication_id: "51",
    generation: 2,
    desired_state_hash: "a".repeat(64),
    provider_publication_key: "ARM-ENV-SGL",
    external_listing_id: "36412213011",
    product_variant_id: productVariantId,
    sku_snapshot: sku,
    disposition,
  };
}
