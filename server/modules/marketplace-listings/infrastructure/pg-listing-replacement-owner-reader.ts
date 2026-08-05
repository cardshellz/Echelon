import type { Pool, QueryResultRow } from "pg";

import { pool as defaultPool } from "../../../db";
import type { MarketplaceListingOwnerReader } from "../application/ports";
import { MarketplaceListingReplacementError } from "../domain/errors";
import type {
  ListingOwnerRef,
  ListingOwnerSnapshot,
} from "../domain/listing-replacement-plan";

interface Row extends QueryResultRow {
  scope_id: string | number;
  publication_id: string | number;
  generation: number;
  desired_state_hash: string;
  provider_publication_key: string | null;
  external_listing_id: string | null;
  product_variant_id: number;
  sku_snapshot: string;
  disposition: string;
}

/** Reads only registered marketplace source state; it never writes owner data. */
export class PgMarketplaceListingReplacementOwnerReader implements MarketplaceListingOwnerReader {
  constructor(private readonly dbPool: Pool = defaultPool) {}

  async loadSnapshot(owner: ListingOwnerRef): Promise<ListingOwnerSnapshot> {
    const result = await this.dbPool.query<Row>(sql(owner), params(owner));
    const first = result.rows[0];
    if (!first)
      throw failure(
        "MARKETPLACE_LISTING_REPLACEMENT_ACTIVE_SOURCE_NOT_FOUND",
        "No active registered marketplace publication exists for this owner.",
        owner,
      );
    const scopeId = positive(first.scope_id, "scope_id");
    const publicationId = positive(first.publication_id, "publication_id");
    if (!first.external_listing_id)
      throw failure(
        "MARKETPLACE_LISTING_REPLACEMENT_SOURCE_EXTERNAL_ID_MISSING",
        "The active source publication has no external listing ID.",
        owner,
      );
    const memberCandidates = result.rows.map((row) => {
      if (
        positive(row.scope_id, "scope_id") !== scopeId ||
        positive(row.publication_id, "publication_id") !== publicationId ||
        row.generation !== first.generation ||
        row.desired_state_hash !== first.desired_state_hash ||
        row.provider_publication_key !== first.provider_publication_key ||
        row.external_listing_id !== first.external_listing_id
      )
        throw failure(
          "MARKETPLACE_LISTING_REPLACEMENT_SOURCE_CONTRACT_INVALID",
          "Active source query returned inconsistent publication rows.",
          owner,
        );
      if (row.disposition !== "included" && row.disposition !== "excluded")
        throw failure(
          "MARKETPLACE_LISTING_REPLACEMENT_SOURCE_CONTRACT_INVALID",
          "Active source query returned an invalid member disposition.",
          owner,
        );
      return {
        productVariantId: row.product_variant_id,
        sku: row.sku_snapshot,
        currentlyPublished: row.disposition === "included",
      };
    });
    return {
      owner: { ...owner },
      scopeId,
      sourcePublication: {
        publicationId,
        generation: first.generation,
        status: "active",
        desiredStateHash: first.desired_state_hash,
        providerPublicationKey: first.provider_publication_key,
        externalListingId: first.external_listing_id,
      },
      nextGeneration: first.generation + 1,
      memberCandidates,
    };
  }
}

function sql(owner: ListingOwnerRef): string {
  const binding =
    owner.kind === "channel"
      ? "cls.channel_id = $5"
      : "dls.store_connection_id = $5";
  return `SELECT s.id AS scope_id, p.id AS publication_id, p.generation, p.desired_state_hash, p.provider_publication_key, p.external_listing_id, m.product_variant_id, m.sku_snapshot, m.disposition FROM marketplace.listing_scopes s JOIN marketplace.listing_publications p ON p.scope_id = s.id AND p.status = 'active' JOIN marketplace.listing_publication_members m ON m.publication_id = p.id LEFT JOIN marketplace.channel_listing_scopes cls ON cls.scope_id = s.id LEFT JOIN marketplace.dropship_listing_scopes dls ON dls.scope_id = s.id WHERE s.owner_kind = $1 AND s.provider = $2 AND s.marketplace_id = $3 AND s.product_id = $4 AND ${binding} ORDER BY m.product_variant_id ASC`;
}
function params(owner: ListingOwnerRef): unknown[] {
  return [
    owner.kind,
    owner.provider,
    owner.marketplaceId,
    owner.productId,
    owner.kind === "channel" ? owner.channelId : owner.storeConnectionId,
  ];
}
function positive(value: string | number, field: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0)
    throw new MarketplaceListingReplacementError(
      "MARKETPLACE_LISTING_REPLACEMENT_SOURCE_CONTRACT_INVALID",
      "Active source query returned an invalid identifier.",
      { field, value },
    );
  return parsed;
}
function failure(
  code: string,
  message: string,
  owner: ListingOwnerRef,
): MarketplaceListingReplacementError {
  return new MarketplaceListingReplacementError(
    code,
    message,
    owner.kind === "channel"
      ? { channelId: owner.channelId, productId: owner.productId }
      : {
          storeConnectionId: owner.storeConnectionId,
          productId: owner.productId,
        },
  );
}
