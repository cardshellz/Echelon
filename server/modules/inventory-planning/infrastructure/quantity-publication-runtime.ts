import { readCanonicalQuantityPublicationMember } from "./canonical-quantity-publication-member.reader";
import { pool } from "../../../db";
import type { PoolClient } from "pg";
import { PostgresQuantityPublicationAdmission } from "./quantity-publication-admission.repository";
import { QuantityPublicationAdmissionError, quantityPublicationScopeSchema, type QuantityPublicationScope } from "../domain/quantity-publication-admission";
import { PostgresInventoryAvailabilityRuntimePublicationExecutor } from "./inventory-availability-runtime-publication.repository";
import { AuthorityAwareInventoryPublicationService, type InventoryAvailabilityRuntimePublicationContext } from "../application/inventory-availability-runtime-publication.service";
import { QuantityPublicationCatchupService } from "../application/quantity-publication-admission.port";
import type { EbayQuantityRequestAdmission } from "../../channels/quantity-publication-request";
import { PostgresQuantityProviderResponseRecovery } from "./quantity-provider-response-recovery.repository";
import { EbayAutomaticPublicationRecoveryService } from "../application/ebay-automatic-publication-recovery.service";
import { PostgresEbayAutomaticPublicationRecoveryRepository } from "./ebay-automatic-publication-recovery.repository";
import { PostgresEbayPublicationReconciliationRepository } from "./ebay-publication-reconciliation.repository";
import { PostgresEbayPublicationRejectionReader } from "./ebay-publication-rejection.reader";
import { PostgresEbayLegacyMaintenanceEvidenceReader } from "../../channels/infrastructure/ebay-legacy-maintenance-evidence";

/** Shared production instance bounds nested provider connections across the known quantity owners. */
export const quantityPublicationAdmission = new PostgresQuantityPublicationAdmission(pool);
export const quantityProviderResponseRecovery = new PostgresQuantityProviderResponseRecovery(pool, () => new Date());
export const ebayPublicationRejectionReader = new PostgresEbayPublicationRejectionReader(pool);
export const automaticEbayPublicationRecovery = new EbayAutomaticPublicationRecoveryService(
  new PostgresEbayAutomaticPublicationRecoveryRepository(pool, new PostgresEbayLegacyMaintenanceEvidenceReader()));
export const ebayPublicationReconciliationRepository = new PostgresEbayPublicationReconciliationRepository(pool);

function ebayRequestAdmission(base: Omit<QuantityPublicationScope, "externalInventoryItemId">,
  environment?: "production" | "sandbox"): EbayQuantityRequestAdmission {
  const scope = (identity: string): QuantityPublicationScope => ({ ...base, externalInventoryItemId: identity });
  return {
    item: (sku, work) => quantityPublicationAdmission.runListing(scope(sku), () => planCurrentCanonicalListingQuantity(scope(sku)), work),
    group: (groupKey, skus, work, maintenance) => quantityPublicationAdmission.runListingGroup(scope(`group:${groupKey}`), skus.map(scope),
      planCurrentCanonicalListingQuantity, work, maintenance && environment ? { environment, market: maintenance.marketplaceId } : undefined),
    reducing: (identity, work, memberSkus) => quantityPublicationAdmission.runQuantityReducingLifecycle(scope(identity), work, memberSkus?.map(scope)),
  };
}

export async function createChannelEbayQuantityRequestAdmission(input: {
  channelId: number; externalAccountId: string; expectedConnectionId?: number; environment?: "production" | "sandbox";
}): Promise<EbayQuantityRequestAdmission> {
  const connections = (await pool.query<{ id: number }>(
    "SELECT id FROM channels.channel_connections WHERE channel_id=$1 ORDER BY id LIMIT 2", [input.channelId],
  )).rows;
  if (connections.length !== 1) throw new QuantityPublicationAdmissionError(
    "PUBLICATION_CONNECTION_AMBIGUOUS", "An exact channel credential connection is required before quantity publication.");
  if(input.expectedConnectionId!==undefined && connections[0].id!==input.expectedConnectionId) throw new QuantityPublicationAdmissionError(
    "EBAY_SYNC_IDENTITY_CHANGED","The listing sync credential connection changed before publication.");
  return ebayRequestAdmission({ destinationKind: "channel_connection", connectionId: connections[0].id,
    providerKey: "ebay", providerScopeType: "account", externalScopeId: input.externalAccountId, productId: null, productVariantId: null }, input.environment);
}

export function createDropshipEbayQuantityRequestAdmission(input: {
  storeConnectionId: number; externalAccountId: string | null; externalAccountVerifiedAt: Date | null; providerEnvironment?: string | null;
}): EbayQuantityRequestAdmission {
  if (!input.externalAccountId || !input.externalAccountVerifiedAt) throw new QuantityPublicationAdmissionError(
    "PUBLICATION_PROVIDER_ACCOUNT_UNVERIFIED", "Provider-verified eBay store identity is required before publishing quantity.");
  return ebayRequestAdmission({ destinationKind: "dropship_store_connection", connectionId: input.storeConnectionId,
    providerKey: "ebay", providerScopeType: "account", externalScopeId: input.externalAccountId, productId: null, productVariantId: null },
    input.providerEnvironment === "production" || input.providerEnvironment === "sandbox" ? input.providerEnvironment : undefined);
}

export async function planCurrentCanonicalListingQuantity(raw: QuantityPublicationScope): Promise<{ outboxId: string; quantity: number }> {
  const scope = quantityPublicationScopeSchema.parse(raw);
  // The existing executor owns capacity, SERIALIZABLE isolation and authority
  // locks. Exact mapping resolution, desired state and handoff commit together;
  // provider I/O remains outside under admission's retained session scope locks.
  return new PostgresInventoryAvailabilityRuntimePublicationExecutor(pool).executeWithClient((client, context) =>
    planCanonicalListingQuantityInsideTransaction(client, context, scope));
}

async function planCanonicalListingQuantityInsideTransaction(client: PoolClient,
  context: InventoryAvailabilityRuntimePublicationContext, scope: QuantityPublicationScope): Promise<{ outboxId: string; quantity: number }> {
  if (context.authority !== "canonical") throw new QuantityPublicationAdmissionError("PUBLICATION_AUTHORITY_CHANGED",
    "Canonical listing planning cannot fall back to legacy ATP.");
  const mapping = await readCanonicalQuantityPublicationMember(client, scope);
  const publisher = new AuthorityAwareInventoryPublicationService({ execute: work => work(context) });
  const result = await publisher.publishProduct({
    productId: mapping.product_id, publicationTargetId: mapping.target_id, productVariantIds: [mapping.product_variant_id],
    dryRun: false, triggeredBy: "canonical_listing_quantity_refresh",
  }, async () => { throw new QuantityPublicationAdmissionError("PUBLICATION_AUTHORITY_CHANGED", "Canonical listing planning cannot fall back to legacy ATP."); });
  if (result.authority !== "canonical") throw new QuantityPublicationAdmissionError("PUBLICATION_AUTHORITY_CHANGED", "Canonical listing authority changed.");
  const currentIntents = result.publication.rows.filter(row => row.publicationTargetId === mapping.target_id
    && row.productVariantId === mapping.product_variant_id && row.destinationKind === scope.destinationKind
    && (row.channelConnectionId ?? row.dropshipStoreConnectionId) === scope.connectionId
    && row.providerKey === scope.providerKey && row.providerScopeType === scope.providerScopeType
    && row.externalScopeId === scope.externalScopeId && row.externalInventoryItemId === scope.externalInventoryItemId);
  if (currentIntents.length !== 1) throw new QuantityPublicationAdmissionError("PUBLICATION_LISTING_PLAN_OMITTED",
    "The current canonical plan did not authorize this exact listing; an older outbox quantity is not authority.", { scope });
  const intent = currentIntents[0];
  const row = (await client.query<{ id: string; desired_quantity: string }>(`SELECT id::text,desired_quantity::text
    FROM inventory.inventory_publication_outbox o WHERE publication_target_id=$1 AND product_variant_id=$2
    AND activation_run_id=$3 AND publication_phase='full' AND publication_target_revision_snapshot=$4 AND desired_quantity=$5
    AND destination_kind_snapshot=$6 AND COALESCE(channel_connection_id_snapshot,dropship_store_connection_id_snapshot)=$7
    AND provider_key_snapshot=$8 AND provider_scope_type_snapshot=$9 AND external_scope_id_snapshot=$10
    AND external_inventory_item_id_snapshot=$11
    AND NOT EXISTS (SELECT 1 FROM inventory.inventory_publication_outbox newer WHERE
      newer.publication_target_id=o.publication_target_id AND newer.product_variant_id=o.product_variant_id AND newer.desired_revision>o.desired_revision)
    ORDER BY desired_revision DESC LIMIT 1`, [mapping.target_id,mapping.product_variant_id,result.publication.activationRunId,
      intent.publicationTargetRevision,intent.desiredQuantity,scope.destinationKind,scope.connectionId,scope.providerKey,
      scope.providerScopeType,scope.externalScopeId,scope.externalInventoryItemId])).rows[0];
  const quantity = Number(row?.desired_quantity);
  if (!row || !Number.isSafeInteger(quantity) || quantity < 0) throw new QuantityPublicationAdmissionError(
    "PUBLICATION_LISTING_PLAN_MISSING", "Canonical planning did not produce an exact desired quantity.");
  return { outboxId: row.id, quantity };
}

/** A callback must inspect failures: resolving a promise is not evidence that legacy adapters published. */
export function createQuantityPublicationCatchupService(input: {
  refreshLegacyChannelScope: (scope: QuantityPublicationScope) => Promise<void>;
}): QuantityPublicationCatchupService {
  return new QuantityPublicationCatchupService(quantityPublicationAdmission, async (scope, claim) => {
    const authority = (await pool.query<{ authority: string }>(
      "SELECT authority FROM inventory.availability_runtime_authority WHERE singleton_key=true",
    )).rows[0]?.authority;
    if (authority === "canonical") return planCurrentCanonicalListingQuantity(scope);
    if (authority !== "legacy") throw new QuantityPublicationAdmissionError("PUBLICATION_AUTHORITY_MISSING", "Runtime publication authority is unavailable.");
    if (scope.destinationKind === "dropship_store_connection") {
      const { refreshDropshipQuantityPublicationCatchup } = await import("../../dropship/infrastructure/dropship-quantity-publication-catchup.provider");
      await refreshDropshipQuantityPublicationCatchup(scope, claim);
      return;
    }
    // Constrain the actual adapter admission, not the planning work. A resolver
    // failure before provider I/O must not manufacture an uncertain write.
    // The adapter still owns the gate, authority recheck and attempt journal.
    await quantityPublicationAdmission.withLegacyCatchupScope(scope, () => input.refreshLegacyChannelScope(scope), claim);
  }, limit => quantityProviderResponseRecovery.reconcile(undefined,limit));
}
