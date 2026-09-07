import type { PoolClient } from "pg";
import { contentProfileStateSchema, descriptionTextSchema, type ContentProfileState, type SavedListingContent } from "../../../../shared/dropship/listing-content";
import { prepareContentProfile, resolveListingContent } from "../application/dropship-listing-content-resolver";
import type { DropshipListingCatalogCandidate } from "../application/dropship-listing-preview-service";

type Reader = Pick<PoolClient, "query">;
export async function readContentProfile(client: Reader, vendorId: number, storeId: number): Promise<ContentProfileState> {
  const result = await client.query<{ id: number; profile: unknown; created_at: Date }>(
    `SELECT r.id, r.profile, r.created_at FROM dropship.dropship_content_profiles p
     JOIN dropship.dropship_content_profile_revisions r ON r.id = p.revision_id
       AND r.vendor_id = p.vendor_id AND r.store_connection_id = p.store_connection_id
     WHERE p.vendor_id = $1 AND p.store_connection_id = $2`, [vendorId, storeId]);
  const row = result.rows[0];
  const state = contentProfileStateSchema.safeParse(row ? { revisionId: row.id, profile: row.profile, updatedAt: row.created_at.toISOString() }
    : { revisionId: null, profile: null, updatedAt: null });
  if (!state.success) throw new Error("Persisted description templates failed their contract.");
  return state.data;
}
export interface ContentRevisionRow {
  id: number; product_variant_id: number; custom_text: string | null; catalog_hash: string; created_at: Date;
}
export function mapContentRevision(row: ContentRevisionRow): SavedListingContent {
  const body = descriptionTextSchema.nullable().safeParse(row.custom_text);
  if (!body.success || !/^[a-f0-9]{64}$/.test(row.catalog_hash)) throw new Error("Persisted listing description failed its contract.");
  return { revisionId: row.id, customText: body.data, catalogHash: row.catalog_hash, updatedAt: row.created_at.toISOString() };
}
export async function readListingContentSettings(client: Reader, vendorId: number, storeId: number, ids: readonly number[]): Promise<Map<number, SavedListingContent>> {
  if (!ids.length) return new Map();
  const result = await client.query<ContentRevisionRow>(
    `SELECT r.id, r.product_variant_id, r.custom_text, r.catalog_hash, r.created_at
     FROM dropship.dropship_listing_content_settings s JOIN dropship.dropship_listing_content_revisions r
       ON r.id = s.revision_id AND r.vendor_id = s.vendor_id AND r.store_connection_id = s.store_connection_id
       AND r.product_variant_id = s.product_variant_id
     WHERE s.vendor_id = $1 AND s.store_connection_id = $2 AND s.product_variant_id = ANY($3::int[])`, [vendorId, storeId, ids]);
  return new Map(result.rows.map((row) => [row.product_variant_id, mapContentRevision(row)]));
}
export async function readResolvedListingContents(client: Reader, input: {
  vendorId: number; storeConnectionId: number; candidates: readonly DropshipListingCatalogCandidate[];
}) {
  const profile = await readContentProfile(client, input.vendorId, input.storeConnectionId);
  const preparedProfile = prepareContentProfile(profile);
  const settings = await readListingContentSettings(client, input.vendorId, input.storeConnectionId, input.candidates.map((row) => row.productVariantId));
  return new Map(input.candidates.map((candidate) => [candidate.productVariantId,
    resolveListingContent({ candidate, profile, preparedProfile, saved: settings.get(candidate.productVariantId) ?? null })]));
}
