import type { PoolClient } from "pg";
import { z } from "zod";
import {
  catalogPublicationMediaPlanSchema,
  type CatalogPublicationMediaPlan,
} from "@shared/types/catalog-publication-media";
import { ProductAssetError } from "./product-asset-errors";

const referenceSchema = z
  .object({
    owner: z.enum(["channels", "marketplace-listings", "dropship"]),
    referenceKey: z.string().min(1).max(200),
    kind: z.enum(["pending", "current"]),
    plan: catalogPublicationMediaPlanSchema,
    now: z.date(),
  })
  .strict();

/** Call inside the command owner's acceptance transaction; never create a separate commit. */
export async function pinCatalogPublicationMediaVersions(
  client: Pick<PoolClient, "query">,
  input: {
    owner: "channels" | "marketplace-listings" | "dropship";
    referenceKey: string;
    kind: "pending" | "current";
    plan: CatalogPublicationMediaPlan;
    now: Date;
  },
): Promise<void> {
  const command = referenceSchema.parse(input);
  const inserted = await client.query(
    `
    INSERT INTO catalog.publication_media_references(owner,reference_key,source_revision,kind,created_at)
    VALUES ($1,$2,$3,$4,$5) ON CONFLICT (owner,reference_key) DO NOTHING
  `,
    [
      command.owner,
      command.referenceKey,
      command.plan.sourceRevision,
      command.kind,
      command.now,
    ],
  );
  if (!inserted.rowCount) {
    const existing = await client.query<{
      source_revision: string;
      kind: string;
      retired_at: Date | null;
    }>(
      `
      SELECT source_revision,kind,retired_at FROM catalog.publication_media_references
      WHERE owner=$1 AND reference_key=$2 FOR UPDATE
    `,
      [command.owner, command.referenceKey],
    );
    if (
      existing.rows[0]?.source_revision !== command.plan.sourceRevision ||
      existing.rows[0]?.kind !== command.kind ||
      existing.rows[0]?.retired_at !== null
    ) {
      throw new ProductAssetError(
        "CATALOG_MEDIA_REFERENCE_CONFLICT",
        "This publication media reference belongs to another plan or has been retired.",
        409,
      );
    }
  }
  const versions = new Map<string, { assetId: number; hash: string }>();
  for (const photo of [
    ...command.plan.group.selected,
    ...command.plan.variants.flatMap((variant) => variant.gallery.selected),
  ]) {
    if (photo.versionHash !== null && photo.assetId !== null)
      versions.set(`${photo.assetId}:${photo.versionHash}`, {
        assetId: photo.assetId,
        hash: photo.versionHash,
      });
  }
  for (const { assetId, hash } of versions.values()) {
    const result = await client.query(
      `
      INSERT INTO catalog.publication_media_version_pins(owner,reference_key,asset_id,content_hash)
      SELECT $1,$2,asset_id,content_hash FROM catalog.product_asset_versions
      WHERE asset_id=$3 AND content_hash=$4
      ON CONFLICT DO NOTHING
      RETURNING asset_id
    `,
      [command.owner, command.referenceKey, assetId, hash],
    );
    if (!result.rowCount) {
      const existing = await client.query(
        `SELECT 1 FROM catalog.publication_media_version_pins
        WHERE owner=$1 AND reference_key=$2 AND asset_id=$3 AND content_hash=$4`,
        [command.owner, command.referenceKey, assetId, hash],
      );
      if (!existing.rowCount)
        throw new ProductAssetError(
          "CATALOG_MEDIA_VERSION_UNAVAILABLE",
          "A selected uploaded image version is unavailable. Review the publication again.",
          409,
        );
    }
  }
}
