import { describe, expect, it, vi } from "vitest";

import {
  buildShopifyProductMappingSummary,
  type ShopifyProductMappingSource,
} from "../../shopify-product-mapping.domain";
import {
  createShopifyProductMappingReconciliationService,
} from "../../shopify-product-mapping-reconciliation.service";
import {
  type LoadedLocalProduct,
  type ShopifyProductMappingReconciliationRepository,
} from "../../shopify-product-mapping-reconciliation.repository";
import type {
  ShopifyProductMappingVerifier,
} from "../../shopify-product-mapping-verifier";

const fixedNow = new Date("2026-07-24T12:00:00.000Z");
const context = {
  channel: {
    id: 36,
    name: "Shopify",
    shopDomain: "cardshellz.myshopify.com",
  },
  credentials: {
    shopDomain: "cardshellz.myshopify.com",
    accessToken: "shpat_test",
    apiVersion: "2024-01",
  },
};

function source(
  input: Partial<ShopifyProductMappingSource> = {},
): ShopifyProductMappingSource {
  return {
    productId: 10,
    productName: "100PT Toploader",
    productSku: "SHLZ-TOP-100PT",
    catalogProductId: "9001",
    channel: context.channel,
    variants: [
      {
        variantId: 101,
        sku: "SHLZ-TOP-100PT-P20",
        isActive: true,
        catalogBarcode: null,
        catalogVariantId: "2001",
        catalogInventoryItemId: "3001",
        feedId: 401,
        feedIsActive: true,
        feedProductId: "9001",
        feedVariantId: "2001",
        feedInventoryItemId: "3001",
        listingId: 501,
        listingProductId: "9001",
        listingVariantId: "2001",
      },
      {
        variantId: 102,
        sku: "SHLZ-TOP-100PT-ARCHIVED",
        isActive: false,
        catalogBarcode: null,
        catalogVariantId: "2002",
        catalogInventoryItemId: "3002",
        feedId: 402,
        feedIsActive: false,
        feedProductId: "9001",
        feedVariantId: "2003",
        feedInventoryItemId: "3003",
        listingId: 502,
        listingProductId: "9001",
        listingVariantId: "2004",
      },
    ],
    ...input,
  };
}

function loadedProduct(): LoadedLocalProduct {
  const summary = buildShopifyProductMappingSummary(source());
  return {
    summary,
    local: {
      productId: summary.productId,
      productName: summary.productName,
      productSku: summary.productSku,
      rawShopifyProductId: "9001",
      shopifyProductId: summary.catalogProductId,
      shippingGroupCode: "protection",
      mappingStatus: summary.status,
      mappingFingerprint: summary.fingerprint,
      evidenceProductIds: summary.evidenceProductIds,
      activeVariantCount: summary.activeVariantCount,
      activeVariantIssueIds: summary.activeVariantIssueIds,
    },
  };
}

function dependencies() {
  const loaded = loadedProduct();
  const repository: ShopifyProductMappingReconciliationRepository = {
    loadChannelContext: vi.fn().mockResolvedValue(context),
    listMappedProducts: vi.fn().mockResolvedValue([loaded]),
    loadMappedProduct: vi.fn().mockResolvedValue(loaded),
    retireStaleMapping: vi.fn().mockResolvedValue({
      productId: 10,
      retiredShopifyProductId: "9001",
      disabledFeedCount: 2,
      resetListingCount: 2,
      clearedVariantCount: 2,
      afterStatus: "unmapped",
    }),
  };
  const verifier: ShopifyProductMappingVerifier = {
    lookupProducts: vi.fn().mockResolvedValue(new Map([
      ["9001", {
        productId: "9001",
        exists: true,
        title: "100PT Toploader",
        status: "ACTIVE",
        shippingGroupCode: "protection",
      }],
    ])),
    verifyProductAndVariants: vi.fn().mockResolvedValue({
      remoteProductExists: false,
      liveVariantIds: [],
    }),
  };
  const service = createShopifyProductMappingReconciliationService({
    repository,
    verifier,
    clock: () => fixedNow,
  });
  return { loaded, repository, verifier, service };
}

describe("Shopify product mapping reconciliation service", () => {
  it("runs a read-only live scan without invoking retirement", async () => {
    const { repository, verifier, service } = dependencies();

    const result = await service.scan(36);

    expect(repository.loadChannelContext).toHaveBeenCalledWith(36);
    expect(repository.listMappedProducts).toHaveBeenCalledWith(36);
    expect(verifier.lookupProducts).toHaveBeenCalledWith(
      context.credentials,
      ["9001"],
    );
    expect(repository.retireStaleMapping).not.toHaveBeenCalled();
    expect(result.generatedAt).toBe(fixedNow.toISOString());
    expect(result.summary.healthyProductCount).toBe(1);
  });

  it("rejects a stale optimistic-lock fingerprint before calling Shopify", async () => {
    const { verifier, repository, service } = dependencies();

    await expect(service.retireStaleMapping({
      productId: 10,
      channelId: 36,
      expectedProductId: "9001",
      expectedFingerprint: "stale-fingerprint",
      expectedShopDomain: "cardshellz.myshopify.com",
      actor: "user:42",
    })).rejects.toMatchObject({
      code: "SHOPIFY_MAPPING_CHANGED",
      statusCode: 409,
    });
    expect(verifier.verifyProductAndVariants).not.toHaveBeenCalled();
    expect(repository.retireStaleMapping).not.toHaveBeenCalled();
  });

  it("rejects retirement when the Shopify store changed after the scan", async () => {
    const { loaded, verifier, repository, service } = dependencies();

    await expect(service.retireStaleMapping({
      productId: 10,
      channelId: 36,
      expectedProductId: "9001",
      expectedFingerprint: loaded.summary.fingerprint,
      expectedShopDomain: "different-store.myshopify.com",
      actor: "user:42",
    })).rejects.toMatchObject({
      code: "SHOPIFY_MAPPING_STORE_CHANGED",
      statusCode: 409,
      context: {
        expectedShopDomain: "different-store.myshopify.com",
        currentShopDomain: "cardshellz.myshopify.com",
      },
    });
    expect(repository.loadMappedProduct).not.toHaveBeenCalled();
    expect(verifier.verifyProductAndVariants).not.toHaveBeenCalled();
    expect(repository.retireStaleMapping).not.toHaveBeenCalled();
  });

  it("rejects an invalid scanned shop domain before loading the mapping", async () => {
    const { verifier, repository, service } = dependencies();

    await expect(service.retireStaleMapping({
      productId: 10,
      channelId: 36,
      expectedProductId: "9001",
      expectedFingerprint: "fingerprint-10",
      expectedShopDomain: "attacker.example",
      actor: "user:42",
    })).rejects.toMatchObject({
      code: "SHOPIFY_SHOP_DOMAIN_INVALID",
      statusCode: 400,
    });
    expect(repository.loadChannelContext).not.toHaveBeenCalled();
    expect(repository.loadMappedProduct).not.toHaveBeenCalled();
    expect(verifier.verifyProductAndVariants).not.toHaveBeenCalled();
  });

  it("requires a traceable actor at the application boundary", async () => {
    const { loaded, verifier, repository, service } = dependencies();

    await expect(service.retireStaleMapping({
      productId: 10,
      channelId: 36,
      expectedProductId: "9001",
      expectedFingerprint: loaded.summary.fingerprint,
      expectedShopDomain: "cardshellz.myshopify.com",
      actor: " ",
    })).rejects.toMatchObject({
      code: "AUTHENTICATED_ACTOR_REQUIRED",
      statusCode: 401,
    });
    expect(repository.loadChannelContext).not.toHaveBeenCalled();
    expect(repository.loadMappedProduct).not.toHaveBeenCalled();
    expect(verifier.verifyProductAndVariants).not.toHaveBeenCalled();
  });

  it("does not mutate when Shopify still owns the product", async () => {
    const { loaded, verifier, repository, service } = dependencies();
    vi.mocked(verifier.verifyProductAndVariants).mockResolvedValue({
      remoteProductExists: true,
      liveVariantIds: [],
    });

    await expect(service.retireStaleMapping({
      productId: 10,
      channelId: 36,
      expectedProductId: "9001",
      expectedFingerprint: loaded.summary.fingerprint,
      expectedShopDomain: "cardshellz.myshopify.com",
      actor: "user:42",
    })).rejects.toMatchObject({
      code: "SHOPIFY_PRODUCT_STILL_EXISTS",
      statusCode: 409,
    });
    expect(repository.retireStaleMapping).not.toHaveBeenCalled();
  });

  it("does not mutate when any referenced Shopify variant still exists", async () => {
    const { loaded, verifier, repository, service } = dependencies();
    vi.mocked(verifier.verifyProductAndVariants).mockResolvedValue({
      remoteProductExists: false,
      liveVariantIds: ["2003"],
    });

    await expect(service.retireStaleMapping({
      productId: 10,
      channelId: 36,
      expectedProductId: "9001",
      expectedFingerprint: loaded.summary.fingerprint,
      expectedShopDomain: "cardshellz.myshopify.com",
      actor: "user:42",
    })).rejects.toMatchObject({
      code: "SHOPIFY_VARIANT_STILL_EXISTS",
      statusCode: 409,
      context: { liveVariantIds: ["2003"] },
    });
    expect(repository.retireStaleMapping).not.toHaveBeenCalled();
  });

  it("passes every active and archived mapped variant through verification", async () => {
    const { loaded, verifier, repository, service } = dependencies();

    await expect(service.retireStaleMapping({
      productId: 10,
      channelId: 36,
      expectedProductId: "gid://shopify/Product/9001",
      expectedFingerprint: loaded.summary.fingerprint,
      expectedShopDomain: "cardshellz.myshopify.com",
      actor: "user:42",
    })).resolves.toMatchObject({
      productId: 10,
      retiredShopifyProductId: "9001",
      afterStatus: "unmapped",
    });

    expect(verifier.verifyProductAndVariants).toHaveBeenCalledWith(
      context.credentials,
      "9001",
      ["2001", "2002", "2003", "2004"],
    );
    expect(repository.retireStaleMapping).toHaveBeenCalledWith({
      productId: 10,
      channelId: 36,
      expectedProductId: "9001",
      expectedFingerprint: loaded.summary.fingerprint,
      actor: "user:42",
      verifiedMissingVariantIds: ["2001", "2002", "2003", "2004"],
      now: fixedNow,
    });
  });
});
