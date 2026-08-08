import { asc, eq } from "drizzle-orm";

import { channelConnections, channels, products, productVariants } from "@shared/schema";
import { db as defaultDb } from "../../../../db";
import { createInventoryAtpService } from "../../../inventory";
import { MarketplaceListingRegistrationError } from "../../../marketplace-listings/domain/registration-errors";
import type {
  EbayMarketplaceRegistrationOwnerRepository,
  EbayRegistrationChannelRecord,
  EbayRegistrationProductRecord,
  EbayRegistrationVariantRecord,
} from "./ebay-marketplace-registration-owner.reader";

type EbayMarketplaceRegistrationReadDb = Pick<typeof defaultDb, "select">;

export interface EbayRegistrationAtpReader {
  getDirectVariantAtp(variantIds: number[]): Promise<Map<number, number>>;
}

/**
 * PostgreSQL-backed Channels owner repository. Catalog membership deliberately
 * has no active or quantity predicate: archived and zero-ATP variants are part
 * of the registration snapshot and must remain available for remote discovery.
 */
export class PgEbayMarketplaceRegistrationOwnerRepository
  implements EbayMarketplaceRegistrationOwnerRepository
{
  constructor(
    private readonly db: EbayMarketplaceRegistrationReadDb = defaultDb,
    private readonly atp: EbayRegistrationAtpReader =
      createInventoryAtpService(db),
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
    const rows = await this.db
      .select({
        id: productVariants.id,
        productId: productVariants.productId,
        sku: productVariants.sku,
        isActive: productVariants.isActive,
        unitsPerVariant: productVariants.unitsPerVariant,
      })
      .from(productVariants)
      .where(eq(productVariants.productId, productId))
      .orderBy(asc(productVariants.id));
    const directAtp = await this.atp.getDirectVariantAtp(rows.map((row) => row.id));

    return rows.map((row) => {
      if (
        !Number.isSafeInteger(row.unitsPerVariant) ||
        row.unitsPerVariant <= 0
      ) {
        throw repositoryError(
          "CHANNEL_MARKETPLACE_REGISTRATION_UNITS_PER_VARIANT_INVALID",
          "A catalog variant has invalid units-per-variant configuration.",
          { productId, productVariantId: row.id },
        );
      }
      return {
        id: row.id,
        productId: row.productId,
        sku: row.sku,
        isActive: row.isActive,
        availableQuantity: requireValidDirectAtp(
          directAtp.get(row.id),
          productId,
          row.id,
        ),
      };
    });
  }
}

function requireValidDirectAtp(
  value: number | undefined,
  productId: number,
  productVariantId: number,
): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw repositoryError(
      "CHANNEL_MARKETPLACE_REGISTRATION_ATP_INVALID",
      "The authoritative inventory service returned an invalid ATP value.",
      { productId, productVariantId },
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
