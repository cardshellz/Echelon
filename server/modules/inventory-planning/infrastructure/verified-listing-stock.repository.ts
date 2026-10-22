import type { Pool } from "pg";
import { readCatalogStockVariantOwners } from "../../catalog/catalog-stock-selection.reader";
import type { VerifiedStockListing, VerifiedListingStockResult, VerifiedListingStockStore } from "../application/verified-listing-stock.service";
import { InventoryPublicationMembershipError } from "../application/inventory-publication-membership.service";
import { acquireInventoryCutoverFenceInsideTransaction } from "./inventory-cutover-admission-fence.repository";
import { readPublicationStockSelection } from "./inventory-publication-selection.reader";
import { prepareVerifiedStockMapping } from "./verified-listing-stock-mapping.repository";
import { assertRecreatedListingStockReady, readRecreationStockScope, recordRecreationStockReceipt } from "./listing-recreation-stock.repository";
import { PublicationMappingPreparationStore, applyMappingPreparation, mappingPreparationDigest, mappingTargetBlockers, readTargets, reviewMappingPreparation } from "./publication-mapping-preparation.repository";
import { blockedOnlyByMissingStockLink } from "../application/inventory-availability-runtime-publication.service";
export class PostgresVerifiedListingStockStore implements VerifiedListingStockStore {
    private readonly transactions: PublicationMappingPreparationStore;
    constructor(pool: Pick<Pool, "connect">) { this.transactions = new PublicationMappingPreparationStore(pool); }
    pending(channelId: number, connectionId: number, variantIds: number[]): Promise<number[]> {
        return this.transactions.transaction(false, async (client) => {
            const targets = await readTargets(client, channelId, connectionId);
            if (targets.length !== 1 || targets[0].provider_key !== "walmart" || mappingTargetBlockers(targets[0]).length)
                return [];
            const owners = await readCatalogStockVariantOwners(client, variantIds), pending: number[] = [];
            for (const productId of [...new Set(owners.map(row => row.productId))]) {
                const candidates = owners.filter(row => row.productId === productId).map(row => row.id);
                const selection = await readPublicationStockSelection(client, { destinationKind: "channel_connection", channelId, channelConnectionId: connectionId, dropshipStoreConnectionId: null }, { productId, productVariantIds: candidates });
                const selected = selection.variants.filter(row => row.action === "publish" && !row.blockers.length).map(row => row.productVariantId);
                const result = await client.query<{
                    id: number;
                }>(`SELECT candidate.id FROM unnest($2::integer[]) candidate(id)
          WHERE NOT EXISTS(SELECT 1 FROM inventory.publication_variant_mapping_heads h JOIN inventory.publication_variant_mapping_versions m ON m.id=h.active_mapping_id
            WHERE h.publication_target_id=$1 AND h.product_variant_id=candidate.id AND m.lifecycle_status='sealed')
          AND EXISTS(SELECT 1 FROM channels.sync_settings WHERE global_enabled=true) ORDER BY candidate.id`, [targets[0].id, selected]);
                pending.push(...result.rows.map(row => row.id));
            }
            return pending.sort((a, b) => a - b);
        });
    }
    connect(input: VerifiedStockListing, now: Date, dryRun: boolean): Promise<VerifiedListingStockResult> {
        return this.transactions.transaction("configuration", async (client, scopeKeys) => {
            await acquireInventoryCutoverFenceInsideTransaction(client, { expectedAuthority: "canonical", expectedConfigurationRunId: null });
            const targets = await readTargets(client, input.channelId, input.connectionId, undefined, true);
            if (targets.length !== 1 || targets[0].provider_key !== "walmart" || targets[0].external_scope_id !== input.externalScopeId)
                throw new InventoryPublicationMembershipError("STOCK_LISTING_TARGET_MISMATCH", "The verified listing does not match one exact Walmart stock destination.");
            const target = targets[0], issues = mappingTargetBlockers(target);
            if (issues.length)
                throw new InventoryPublicationMembershipError("STOCK_LISTING_TARGET_NOT_READY", issues.map(row => row.message).join(" "));
            const owner = (await readCatalogStockVariantOwners(client, [input.productVariantId]))[0];
            if (!owner)
                throw new InventoryPublicationMembershipError("STOCK_LISTING_LINK_CHANGED", "The verified Walmart variant no longer exists.");
            const selection = await readPublicationStockSelection(client, { destinationKind: "channel_connection", channelId: input.channelId, channelConnectionId: input.connectionId, dropshipStoreConnectionId: null }, { productId: owner.productId, productVariantIds: [input.productVariantId], now });
            const decision = selection.variants[0];
            if (decision.blockers.length)
                throw new InventoryPublicationMembershipError(decision.blockers[0].code, decision.blockers[0].message);
            if (decision.action !== "publish")
                return { state: "excluded", dryRun, receipt: null, quantities: [] };
            const actor = "walmart-stock-connection", requestHash = mappingPreparationDigest({ targetId: target.id, channelId: input.channelId, connectionId: input.connectionId,
                variantId: input.productVariantId, sku: input.sku, externalProductId: input.externalProductId, actor,
                ...(input.setupOperationId ? { setupOperationId: input.setupOperationId } : {}) });
            const recreation = await readRecreationStockScope(client, target.id, input);
            if (!input.setupOperationId) await assertRecreatedListingStockReady(client, [{ destinationKind: "channel_connection",
                connectionId: input.connectionId, providerKey: "walmart", providerScopeType: "location",
                externalScopeId: input.externalScopeId, externalInventoryItemId: input.sku,
                productId: owner.productId, productVariantId: input.productVariantId }]);
            const changed = await prepareVerifiedStockMapping(client, target.id, input, requestHash, actor, now);
            if (recreation?.completed)
                return { state: "already_connected", dryRun, receipt: null, quantities: [], publicationState: recreation.publicationState };
            if (!changed && !recreation)
                return { state: "already_connected", dryRun, receipt: null, quantities: [] };
            const command = { publicationTargetId: target.id, expectedTargetRevision: target.revision, productId: owner.productId, productVariantIds: [input.productVariantId] };
            const { review, targetRows } = await reviewMappingPreparation(client, command, true);
            if (!review.ready)
                throw new InventoryPublicationMembershipError("STOCK_LISTING_ATP_NOT_READY", review.blockers.map(row => row.message).join(" "));
            // Publish only this verified size. Each Walmart size links through its own
            // verified listing, so a selected sibling that is not linked yet must not
            // refuse this publication and roll the new link back (PLAN-CH-v3 PR1).
            // That is the only sibling problem skipped. Any other sibling blocker makes
            // every later fan-out withhold this whole destination (rowIsolatedVariantIds),
            // which would freeze this size at its link-time quantity, so refuse as before.
            const blockedSibling = targetRows.find(row => row.productVariantId !== input.productVariantId
                && row.blockers.length > 0 && !blockedOnlyByMissingStockLink(row.blockers));
            if (blockedSibling)
                throw new InventoryPublicationMembershipError("STOCK_LISTING_ATP_NOT_READY",
                    `Another size of this product (variant ${blockedSibling.productVariantId}) is not ready for this Walmart store: ${blockedSibling.blockers.map(row => row.message).join(" ")}`);
            const receipt = await applyMappingPreparation(client, scopeKeys, { ...command, exactVariantScope: true, expectedReviewHash: review.reviewHash, idempotencyKey: `verified-stock:${requestHash}` }, actor, requestHash, now,
                changed ? [input.productVariantId] : [], recreation ? [input.productVariantId] : []);
            if (recreation) await recordRecreationStockReceipt(client, recreation.id, target.id, input, actor, now);
            return { state: "connected", dryRun, receipt, quantities: review.quantities, ...(recreation ? { publicationState: "queued" as const } : {}) };
        }, dryRun);
    }
}
