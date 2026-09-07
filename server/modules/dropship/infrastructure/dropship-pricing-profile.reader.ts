import type { PoolClient } from "pg";
import { pricingProfileStateSchema, type PricingProfileState } from "../../../../shared/dropship/pricing-rules";

export async function readPricingProfile(client: Pick<PoolClient, "query">, storeConnectionId: number, vendorId: number): Promise<PricingProfileState> {
  const result = await client.query<{ id: number; profile: unknown; created_at: Date }>(
    `SELECT r.id, r.profile, r.created_at FROM dropship.dropship_pricing_profiles p
     JOIN dropship.dropship_pricing_profile_revisions r ON r.id = p.revision_id
       AND r.vendor_id = p.vendor_id AND r.store_connection_id = p.store_connection_id
     WHERE p.store_connection_id = $1 AND p.vendor_id = $2`, [storeConnectionId, vendorId]);
  const row = result.rows[0];
  const parsed = pricingProfileStateSchema.safeParse(row ? { revisionId: row.id, profile: row.profile, updatedAt: row.created_at.toISOString() }
    : { revisionId: null, profile: null, updatedAt: null });
  if (!parsed.success) throw new Error("Persisted pricing profile failed its contract.");
  return parsed.data;
}
