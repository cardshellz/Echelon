import type { MarketplaceListingRegistrationOwnerReader } from "../../../marketplace-listings/application/registration-ports";
import type { ListingRegistrationOwnerSnapshot } from "../../../marketplace-listings/domain/listing-registration-plan";
import { MarketplaceListingRegistrationError } from "../../../marketplace-listings/domain/registration-errors";
import type { ListingOwnerRef } from "../../../marketplace-listings/domain/listing-replacement-plan";

const EBAY_PROVIDER = "ebay" as const;

export interface EbayRegistrationChannelRecord {
  readonly id: number;
  readonly provider: string;
  readonly marketplaceId: string;
}

export interface EbayRegistrationProductRecord {
  readonly id: number;
}

export interface EbayRegistrationVariantRecord {
  readonly id: number;
  readonly productId: number;
  readonly sku: string | null;
  readonly isActive: boolean;
  readonly availableQuantity: number;
}

/**
 * Channels-owned persistence boundary. `loadAllProductVariants` returns the
 * complete customer-sellable family without active/status/quantity filtering,
 * so archived and zero-quantity members remain observable while internal build
 * identities never enter marketplace registration.
 */
export interface EbayMarketplaceRegistrationOwnerRepository {
  loadChannel(channelId: number): Promise<EbayRegistrationChannelRecord | null>;
  loadProduct(productId: number): Promise<EbayRegistrationProductRecord | null>;
  loadAllProductVariants(
    productId: number,
  ): Promise<readonly EbayRegistrationVariantRecord[]>;
}

export class EbayMarketplaceRegistrationOwnerReader
  implements MarketplaceListingRegistrationOwnerReader
{
  constructor(
    private readonly repository: EbayMarketplaceRegistrationOwnerRepository,
  ) {}

  async loadRegistrationSnapshot(
    owner: ListingOwnerRef,
  ): Promise<ListingRegistrationOwnerSnapshot> {
    assertEbayChannelOwner(owner);

    const [channel, product, variants] = await Promise.all([
      this.repository.loadChannel(owner.channelId),
      this.repository.loadProduct(owner.productId),
      this.repository.loadAllProductVariants(owner.productId),
    ]);
    if (!channel || channel.id !== owner.channelId) {
      throw ownerReadError(
        "CHANNEL_MARKETPLACE_REGISTRATION_CHANNEL_NOT_FOUND",
        "The requested Channels owner does not exist.",
        { channelId: owner.channelId },
      );
    }
    if (channel.provider.trim().toLowerCase() !== EBAY_PROVIDER) {
      throw ownerReadError(
        "CHANNEL_MARKETPLACE_REGISTRATION_PROVIDER_MISMATCH",
        "The requested Channels owner is not backed by eBay.",
        { channelId: owner.channelId, provider: channel.provider },
      );
    }
    if (channel.marketplaceId !== owner.marketplaceId) {
      throw ownerReadError(
        "CHANNEL_MARKETPLACE_REGISTRATION_MARKETPLACE_MISMATCH",
        "The requested marketplace does not match the configured eBay Channel marketplace.",
        {
          channelId: owner.channelId,
          requestedMarketplaceId: owner.marketplaceId,
          configuredMarketplaceId: channel.marketplaceId,
        },
      );
    }
    if (!product || product.id !== owner.productId) {
      throw ownerReadError(
        "CHANNEL_MARKETPLACE_REGISTRATION_PRODUCT_NOT_FOUND",
        "The requested catalog product does not exist.",
        { productId: owner.productId },
      );
    }
    if (variants.length === 0) {
      throw ownerReadError(
        "CHANNEL_MARKETPLACE_REGISTRATION_PRODUCT_VARIANTS_EMPTY",
        "The requested catalog product has no variants.",
        { productId: owner.productId },
      );
    }

    const ids = new Set<number>();
    const skus = new Set<string>();
    const memberCandidates = variants.map((variant) => {
      if (!Number.isSafeInteger(variant.id) || variant.id <= 0) {
        throw ownerReadError(
          "CHANNEL_MARKETPLACE_REGISTRATION_VARIANT_ID_INVALID",
          "A catalog variant has an invalid identifier.",
          { productId: owner.productId, productVariantId: variant.id },
        );
      }
      if (variant.productId !== owner.productId) {
        throw ownerReadError(
          "CHANNEL_MARKETPLACE_REGISTRATION_PRODUCT_OWNERSHIP_MISMATCH",
          "A returned catalog variant belongs to a different product.",
          {
            requestedProductId: owner.productId,
            actualProductId: variant.productId,
            productVariantId: variant.id,
          },
        );
      }
      if (ids.has(variant.id)) {
        throw ownerReadError(
          "CHANNEL_MARKETPLACE_REGISTRATION_VARIANT_DUPLICATE",
          "The owner repository returned a duplicate catalog variant.",
          { productVariantId: variant.id },
        );
      }
      ids.add(variant.id);

      const sku = normalizeSku(variant.sku, variant.id);
      if (skus.has(sku)) {
        throw ownerReadError(
          "CHANNEL_MARKETPLACE_REGISTRATION_SKU_DUPLICATE",
          "The owner repository returned a duplicate SKU.",
          { sku },
        );
      }
      skus.add(sku);
      if (!Number.isSafeInteger(variant.availableQuantity)) {
        throw ownerReadError(
          "CHANNEL_MARKETPLACE_REGISTRATION_QUANTITY_INVALID",
          "A catalog variant has an invalid available quantity.",
          { productVariantId: variant.id },
        );
      }

      return {
        productVariantId: variant.id,
        sku,
        isActive: variant.isActive,
        availableQuantity: variant.availableQuantity,
      };
    });

    return {
      owner: { ...owner },
      memberCandidates: memberCandidates.sort(
        (left, right) => left.productVariantId - right.productVariantId,
      ),
    };
  }
}

function assertEbayChannelOwner(
  owner: ListingOwnerRef,
): asserts owner is Extract<ListingOwnerRef, { kind: "channel" }> {
  if (owner.kind !== "channel") {
    throw ownerReadError(
      "CHANNEL_MARKETPLACE_REGISTRATION_OWNER_KIND_INVALID",
      "The eBay Channels owner reader only accepts channel owners.",
      { ownerKind: owner.kind },
    );
  }
  if (
    !Number.isSafeInteger(owner.channelId) ||
    owner.channelId <= 0 ||
    !Number.isSafeInteger(owner.productId) ||
    owner.productId <= 0
  ) {
    throw ownerReadError(
      "CHANNEL_MARKETPLACE_REGISTRATION_OWNER_ID_INVALID",
      "The eBay Channels owner contains an invalid identifier.",
    );
  }
  if (owner.provider.trim().toLowerCase() !== EBAY_PROVIDER) {
    throw ownerReadError(
      "CHANNEL_MARKETPLACE_REGISTRATION_OWNER_PROVIDER_INVALID",
      "The eBay Channels owner must declare provider ebay.",
      { provider: owner.provider },
    );
  }
  if (!owner.marketplaceId.trim()) {
    throw ownerReadError(
      "CHANNEL_MARKETPLACE_REGISTRATION_MARKETPLACE_INVALID",
      "The eBay Channels owner must declare a marketplace.",
    );
  }
}

function normalizeSku(value: string | null, productVariantId: number): string {
  const sku = typeof value === "string" ? value.trim() : "";
  if (sku.length === 0 || sku.length > 100) {
    throw ownerReadError(
      "CHANNEL_MARKETPLACE_REGISTRATION_SKU_INVALID",
      "Every catalog variant must have a valid SKU before registration.",
      { productVariantId },
    );
  }
  return sku;
}

function ownerReadError(
  code: string,
  message: string,
  context: Readonly<Record<string, unknown>> = {},
): MarketplaceListingRegistrationError {
  return new MarketplaceListingRegistrationError(code, message, context);
}
