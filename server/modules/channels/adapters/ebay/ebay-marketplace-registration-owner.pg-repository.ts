import { and, asc, eq } from "drizzle-orm";

import { channelConnections, channels, products, productVariants } from "@shared/schema";
import { db as defaultDb, pool as defaultPool } from "../../../../db";
import { createAuthorityAwareInventoryAtpService } from "../../../inventory-planning/infrastructure/inventory-availability-runtime-atp.repository";
import { MarketplaceListingRegistrationError } from "../../../marketplace-listings/domain/registration-errors";
import { isInventoryManagedVariant } from "@shared/catalog/variant-inventory-eligibility";
import type {
  EbayMarketplaceRegistrationOwnerRepository,
  EbayRegistrationChannelRecord,
  EbayRegistrationProductRecord,
  EbayRegistrationVariantRecord,
} from "./ebay-marketplace-registration-owner.reader";

type EbayMarketplaceRegistrationReadDb = Pick<typeof defaultDb, "select">;

export interface EbayRegistrationAtpReader {
  getAtpPerVariant(productId: number): Promise<readonly {
    productVariantId: number;
    atpUnits: number;
  }[]>;
}

/**
 * PostgreSQL-backed Channels owner repository. Customer-sellable catalog
 * membership deliberately has no active or quantity predicate: archived,
 * zero-ATP, and unmanaged sellable variants remain observable for remote
 * cleanup. Internal-only build identities never enter registration.
 */
export class PgEbayMarketplaceRegistrationOwnerRepository
  implements EbayMarketplaceRegistrationOwnerRepository
{
  constructor(
    private readonly db: EbayMarketplaceRegistrationReadDb = defaultDb,
    private readonly atp: EbayRegistrationAtpReader =
      createAuthorityAwareInventoryAtpService(defaultPool),
  ) {}

  async loadChannel(
    channelId: number,
  ): Promise<EbayRegistrationChannelRecord | null> {
    const [channel] = await this.db
      .select({ id: channels.id, provider: channels.provider })
      .from(channels)
      .where(eq(channels.id, channelId))
      .limit(1);
    if (!channel) return null;
    const connections = await this.db
      .select({
        id: channelConnections.id,
        metadata: channelConnections.metadata,
      })
      .from(channelConnections)
      .where(eq(channelConnections.channelId, channelId))
      .orderBy(asc(channelConnections.id))
      .limit(2);
    if (connections.length !== 1) {
      throw repositoryError(
        connections.length === 0
          ? "CHANNEL_MARKETPLACE_REGISTRATION_CONNECTION_NOT_FOUND"
          : "CHANNEL_MARKETPLACE_REGISTRATION_CONNECTION_AMBIGUOUS",
        connections.length === 0
          ? "The eBay Channel has no connection configuration."
          : "The eBay Channel has multiple connection configurations and cannot be registered deterministically.",
        { channelId, connectionCount: connections.length },
      );
    }
    const metadata = asMetadata(connections[0].metadata);
    const marketplaceId = typeof metadata.marketplaceId === "string"
      && metadata.marketplaceId.trim()
      ? metadata.marketplaceId.trim()
      : "EBAY_US";
    return { ...channel, marketplaceId };
  }

  async loadProduct(
    productId: number,
  ): Promise<EbayRegistrationProductRecord | null> {
    const [row] = await this.db
      .select({ id: products.id })
      .from(products)
      .where(eq(products.id, productId))
      .limit(1);
    return row ?? null;
  }

  async loadAllProductVariants(
    productId: number,
  ): Promise<readonly EbayRegistrationVariantRecord[]> {
    const [rows, variantAtp] = await Promise.all([
      this.db
        .select({
          id: productVariants.id,
          productId: productVariants.productId,
          sku: productVariants.sku,
          isActive: productVariants.isActive,
          requiresShipping: productVariants.requiresShipping,
          trackInventory: productVariants.trackInventory,
        })
        .from(productVariants)
        .where(and(
          eq(productVariants.productId, productId),
          eq(productVariants.salesEligibility, "sellable"),
        ))
        .orderBy(asc(productVariants.id)),
      this.atp.getAtpPerVariant(productId),
    ]);
    const atpByVariantId = new Map(variantAtp.map((variant) => [
      variant.productVariantId,
      normalizeVariantAtp(variant.atpUnits, productId, variant.productVariantId),
    ] as const));

    return rows.map((row) => {
      return {
        id: row.id,
        productId: row.productId,
        sku: row.sku,
        isActive: row.isActive,
        availableQuantity: isInventoryManagedVariant(row)
          ? atpByVariantId.get(row.id) ?? 0
          : 0,
      };
    });
  }
}

function normalizeVariantAtp(value: number, productId: number, productVariantId: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw repositoryError(
      "CHANNEL_MARKETPLACE_REGISTRATION_ATP_INVALID",
      "The authoritative inventory service returned an invalid variant ATP value.",
      { productId, productVariantId, value },
    );
  }
  return value;
}

function asMetadata(value: unknown): Readonly<Record<string, unknown>> {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
  ) {
    return {};
  }
  return value as Readonly<Record<string, unknown>>;
}

function repositoryError(
  code: string,
  message: string,
  context: Readonly<Record<string, unknown>>,
): MarketplaceListingRegistrationError {
  return new MarketplaceListingRegistrationError(code, message, context);
}
