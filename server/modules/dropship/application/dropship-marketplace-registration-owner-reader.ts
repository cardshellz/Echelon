import type { MarketplaceListingRegistrationOwnerReader } from "../../marketplace-listings/application/registration-ports";
import type { ListingRegistrationOwnerSnapshot } from "../../marketplace-listings/domain/listing-registration-plan";
import { MarketplaceListingRegistrationError } from "../../marketplace-listings/domain/registration-errors";
import type { ListingOwnerRef } from "../../marketplace-listings/domain/listing-replacement-plan";
import type { DropshipSupportedStorePlatform } from "../domain/store-connection";

export interface DropshipRegistrationStoreConnectionRecord {
  readonly id: number;
  readonly vendorId: number;
  readonly platform: DropshipSupportedStorePlatform;
  readonly status: string;
  readonly marketplaceIds: readonly string[];
}

export interface DropshipRegistrationProductAccessRecord {
  readonly vendorId: number;
  readonly productId: number;
  readonly canList: boolean;
}

export interface DropshipRegistrationVariantRecord {
  readonly id: number;
  readonly productId: number;
  readonly sku: string | null;
  readonly isActive: boolean;
  readonly availableQuantity: number;
}

/**
 * Dropship-owned persistence boundary. `loadAllProductVariants` returns the
 * complete customer-sellable family without active or positive-quantity
 * filtering, so archived and zero-quantity members remain observable while
 * internal build identities never enter marketplace registration.
 */
export interface DropshipMarketplaceRegistrationOwnerRepository {
  loadStoreConnection(
    storeConnectionId: number,
  ): Promise<DropshipRegistrationStoreConnectionRecord | null>;
  loadProductAccess(input: {
    vendorId: number;
    storeConnectionId: number;
    productId: number;
  }): Promise<DropshipRegistrationProductAccessRecord | null>;
  loadAllProductVariants(input: {
    storeConnectionId: number;
    productId: number;
  }): Promise<readonly DropshipRegistrationVariantRecord[]>;
}

export class DropshipMarketplaceRegistrationOwnerReader
  implements MarketplaceListingRegistrationOwnerReader
{
  constructor(
    private readonly repository: DropshipMarketplaceRegistrationOwnerRepository,
  ) {}

  async loadRegistrationSnapshot(
    owner: ListingOwnerRef,
  ): Promise<ListingRegistrationOwnerSnapshot> {
    assertDropshipOwner(owner);
    const connection = await this.repository.loadStoreConnection(
      owner.storeConnectionId,
    );
    if (!connection || connection.id !== owner.storeConnectionId) {
      throw ownerReadError(
        "DROPSHIP_MARKETPLACE_REGISTRATION_STORE_NOT_FOUND",
        "The requested Dropship store connection does not exist.",
        { storeConnectionId: owner.storeConnectionId },
      );
    }
    const provider = connection.platform.trim().toLowerCase();
    if (provider !== owner.provider) {
      throw ownerReadError(
        "DROPSHIP_MARKETPLACE_REGISTRATION_PROVIDER_MISMATCH",
        "The requested Dropship owner provider does not match its store connection.",
        {
          storeConnectionId: owner.storeConnectionId,
          requestedProvider: owner.provider,
          actualProvider: provider,
        },
      );
    }
    if (connection.status !== "connected") {
      throw ownerReadError(
        "DROPSHIP_MARKETPLACE_REGISTRATION_STORE_NOT_CONNECTED",
        "The Dropship store connection must be connected before a listing can be registered.",
        {
          storeConnectionId: owner.storeConnectionId,
          status: connection.status,
        },
      );
    }
    const marketplaceIds = new Set(
      connection.marketplaceIds.map((value) => value.trim()).filter(Boolean),
    );
    if (!marketplaceIds.has(owner.marketplaceId)) {
      throw ownerReadError(
        "DROPSHIP_MARKETPLACE_REGISTRATION_MARKETPLACE_MISMATCH",
        "The requested marketplace is not configured for this Dropship store connection.",
        {
          storeConnectionId: owner.storeConnectionId,
          marketplaceId: owner.marketplaceId,
        },
      );
    }

    const [productAccess, variants] = await Promise.all([
      this.repository.loadProductAccess({
        vendorId: connection.vendorId,
        storeConnectionId: connection.id,
        productId: owner.productId,
      }),
      this.repository.loadAllProductVariants({
        storeConnectionId: owner.storeConnectionId,
        productId: owner.productId,
      }),
    ]);
    if (
      !productAccess
      || productAccess.productId !== owner.productId
      || productAccess.vendorId !== connection.vendorId
    ) {
      throw ownerReadError(
        "DROPSHIP_MARKETPLACE_REGISTRATION_PRODUCT_NOT_FOUND",
        "The requested product is not available to this Dropship vendor.",
        {
          vendorId: connection.vendorId,
          productId: owner.productId,
        },
      );
    }
    if (!productAccess.canList) {
      throw ownerReadError(
        "DROPSHIP_MARKETPLACE_REGISTRATION_PRODUCT_ACCESS_DENIED",
        "The Dropship vendor is not allowed to list the requested product.",
        {
          vendorId: connection.vendorId,
          productId: owner.productId,
        },
      );
    }
    if (variants.length === 0) {
      throw ownerReadError(
        "DROPSHIP_MARKETPLACE_REGISTRATION_PRODUCT_VARIANTS_EMPTY",
        "The requested catalog product has no variants.",
        { productId: owner.productId },
      );
    }

    const ids = new Set<number>();
    const skus = new Set<string>();
    const memberCandidates = variants.map((variant) => {
      if (!Number.isSafeInteger(variant.id) || variant.id <= 0) {
        throw ownerReadError(
          "DROPSHIP_MARKETPLACE_REGISTRATION_VARIANT_ID_INVALID",
          "A catalog variant has an invalid identifier.",
          { productId: owner.productId, productVariantId: variant.id },
        );
      }
      if (variant.productId !== owner.productId) {
        throw ownerReadError(
          "DROPSHIP_MARKETPLACE_REGISTRATION_PRODUCT_OWNERSHIP_MISMATCH",
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
          "DROPSHIP_MARKETPLACE_REGISTRATION_VARIANT_DUPLICATE",
          "The owner repository returned a duplicate catalog variant.",
          { productVariantId: variant.id },
        );
      }
      ids.add(variant.id);

      const sku = normalizeSku(variant.sku, variant.id);
      if (skus.has(sku)) {
        throw ownerReadError(
          "DROPSHIP_MARKETPLACE_REGISTRATION_SKU_DUPLICATE",
          "The owner repository returned a duplicate SKU.",
          { sku },
        );
      }
      skus.add(sku);
      if (!Number.isSafeInteger(variant.availableQuantity)) {
        throw ownerReadError(
          "DROPSHIP_MARKETPLACE_REGISTRATION_QUANTITY_INVALID",
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

function assertDropshipOwner(
  owner: ListingOwnerRef,
): asserts owner is Extract<ListingOwnerRef, { kind: "dropship" }> {
  if (owner.kind !== "dropship") {
    throw ownerReadError(
      "DROPSHIP_MARKETPLACE_REGISTRATION_OWNER_KIND_INVALID",
      "The Dropship owner reader only accepts Dropship owners.",
      { ownerKind: owner.kind },
    );
  }
  if (
    !Number.isSafeInteger(owner.storeConnectionId)
    || owner.storeConnectionId <= 0
    || !Number.isSafeInteger(owner.productId)
    || owner.productId <= 0
  ) {
    throw ownerReadError(
      "DROPSHIP_MARKETPLACE_REGISTRATION_OWNER_ID_INVALID",
      "The Dropship listing owner contains an invalid identifier.",
    );
  }
  if (!owner.provider.trim() || !owner.marketplaceId.trim()) {
    throw ownerReadError(
      "DROPSHIP_MARKETPLACE_REGISTRATION_OWNER_INVALID",
      "The Dropship listing owner must declare a provider and marketplace.",
    );
  }
}

function normalizeSku(value: string | null, productVariantId: number): string {
  const sku = typeof value === "string" ? value.trim() : "";
  if (sku.length === 0 || sku.length > 100) {
    throw ownerReadError(
      "DROPSHIP_MARKETPLACE_REGISTRATION_SKU_INVALID",
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
