import { z } from "zod";
import type { LegacyMaintenanceEvidenceReader, LegacyMaintenanceProof } from "../../inventory-planning/application/legacy-maintenance-evidence.port";
import type { InventoryAvailabilityTransactionQueryClient } from "../../inventory-planning/application/inventory-availability-transaction-query.port";
import { quantityPublicationScopeSchema } from "../../inventory-planning/domain/quantity-publication-admission";
import { quantityPublicationScopeLockKey } from "../../inventory-planning/infrastructure/quantity-publication-admission.repository";
import { ebayListingSyncIdentitySchema, syncStageHash, type EbayListingSyncIdentity } from "../ebay-listing-sync.domain";

const eventSchema = z.object({ id: z.string(), revision: z.string(), ownerToken: z.string().uuid(), event: z.string(),
  createdAt: z.string(), evidence: z.record(z.unknown()) });
const sourceSchema = z.object({
  job: z.object({ id: z.string().uuid(), operation: z.string(), identity: ebayListingSyncIdentitySchema }),
  current: z.object({ id: z.string().uuid(), revision: z.string(), identity: ebayListingSyncIdentitySchema }),
  stage: eventSchema, next: eventSchema,
  attempt: z.object({ id: z.string(), startedAt: z.string(), scope: quantityPublicationScopeSchema,
    affectedScopes: z.array(quantityPublicationScopeSchema).min(1).max(251) }),
});

// Identity includes provider resources, not mutable content flags or quantities.
// A retired member must still be present in the replacement's clearing scope.
function resources(identity: EbayListingSyncIdentity): unknown {
  return { channelId: identity.channelId, connectionId: identity.connectionId, productId: identity.productId,
    accountId: identity.accountId, marketplaceId: identity.marketplaceId, groupKey: identity.groupKey,
    retainedGroupSkus: [...(identity.retainedGroupSkus ?? [])].sort(),
    variants: identity.variants.map(member => ({ variantId: member.variantId, sku: member.sku,
      externalSku: member.externalSku, offerId: member.offerId, listingId: member.listingId })).sort((a, b) => a.variantId - b.variantId) };
}

/** Compatibility adapter for the old saved worker's synchronous maintenance
 * stages. It never infers "not sent" from a GET failure or an empty journal. */
export class PostgresEbayLegacyMaintenanceEvidenceReader implements LegacyMaintenanceEvidenceReader {
  async read(client: InventoryAvailabilityTransactionQueryClient,
    input: Parameters<LegacyMaintenanceEvidenceReader["read"]>[1]): Promise<LegacyMaintenanceProof | null> {
    const rows = (await client.query<{ source: unknown }>(
      "SELECT source FROM channels.legacy_maintenance_replacement_sources($1,$2,$3)",
      [input.attemptId, input.syncJobId, input.syncRevision])).rows;
    // Timestamps alone cannot choose between two plausible old commands.
    if (rows.length !== 1) return null;
    const parsed = sourceSchema.safeParse(rows[0]!.source);
    if (!parsed.success) return null;
    const { job, current, stage, next, attempt } = parsed.data;
    if (job.operation !== "sync" || current.id !== input.syncJobId || current.revision !== input.syncRevision
      || attempt.id !== input.attemptId || stage.event !== "stage_started"
      || !["recovering", "awaiting_evidence", "needs_attention"].includes(next.event)
      || stage.revision !== next.revision || stage.ownerToken !== next.ownerToken
      || !z.string().regex(/^[a-f0-9]{64}$/).safeParse(stage.evidence.preparedIntentHash).success
      // Admission contention/setup errors do not prove this stage entered its
      // provider callback. Retained legacy HTTP diagnostics do; neither GET nor
      // PUT here authorizes publishing or deleting an uncertain old resource.
      || next.evidence.code !== "EBAY_LISTING_SYNC_FAILED"
      || typeof next.evidence.message !== "string"
      || !/^eBay API (GET|PUT) \/sell\/inventory\/v1\/(inventory_item|inventory_item_group|offer)(\/[^\s?#]+|\?[^\s#]+) failed \([45][0-9]{2}\): /.test(next.evidence.message)
      || job.identity.variants.some(member => !member.offerId || !member.listingId || member.externalSku !== member.sku)) return null;
    const key = stage.evidence.key;
    const group = job.identity.groupKey !== null && key === `group:${job.identity.groupKey}`;
    const member = job.identity.variants.find(value => key === `item:${value.sku}` || key === `offer:${value.offerId}`);
    if (!group && !member) return null;
    const expectedRoot = group ? `group:${job.identity.groupKey}` : member!.sku;
    const expectedSkus = group ? [expectedRoot, ...job.identity.variants.map(value => value.sku)] : [expectedRoot];
    if (attempt.scope.externalInventoryItemId !== expectedRoot || attempt.scope.providerKey !== "ebay"
      || attempt.scope.destinationKind !== "channel_connection" || attempt.scope.providerScopeType !== "account"
      || attempt.scope.connectionId !== job.identity.connectionId || attempt.scope.externalScopeId !== job.identity.accountId
      || attempt.affectedScopes.some(scope => scope.connectionId !== job.identity.connectionId || scope.externalScopeId !== job.identity.accountId
        || scope.providerKey !== "ebay" || scope.providerScopeType !== "account" || scope.destinationKind !== "channel_connection")
      || attempt.affectedScopes.length !== expectedSkus.length
      || new Set(attempt.affectedScopes.map(scope => scope.externalInventoryItemId)).size !== expectedSkus.length
      || expectedSkus.some(sku => !attempt.affectedScopes.some(scope => scope.externalInventoryItemId === sku))) return null;
    return { source: rows[0]!.source, policy: { effect: "replace_existing", previousTarget: syncStageHash(resources(job.identity)),
      currentTarget: syncStageHash(resources(current.identity)), affectedScopeKeys: attempt.affectedScopes.map(quantityPublicationScopeLockKey),
      replacementScopeKeys: input.scopes.map(quantityPublicationScopeLockKey) } };
  }
}
