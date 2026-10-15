import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { canonicalJson } from "@shared/utils/canonical-json";
import { publicationMappingPreparationReceiptSchema, type PublicationMappingPreparationReceipt } from "@shared/types/inventory-publication-mapping-preparation";
import type { PublicationMembershipBlocker } from "@shared/types/inventory-publication-membership";
import { InventoryPublicationMembershipError } from "../application/inventory-publication-membership.service";
import { reviewInventoryPublicationQuantities } from "../application/inventory-publication-quantity-review";
import type { ActivePublicationVariantMappingSnapshot } from "../application/inventory-channel-exposure-runtime.service";
import { loadAndLockRuntimeAuthority } from "./inventory-availability-runtime-atp.repository";
import { captureActiveSupplySnapshotInsideTransaction } from "./inventory-availability-shadow.repository";
import { loadActivePublicationTargets, loadManagedSellableVariantIds } from "./inventory-channel-exposure-runtime.repository";
import { createTransactionScopedInventoryPublicationService, loadZeroPublicationTargets } from "./inventory-availability-runtime-publication.repository";
import { zeroPublicationIntents, type ActivePublicationVariantMapping } from "../application/inventory-availability-runtime-publication.service";
import { readPublicationStockSelection } from "./inventory-publication-selection.reader";
import { loadPublicationTargetScopes, PUBLICATION_TARGET_SCOPE_LOCK_SEED } from "./inventory-publication-target-stop.repository";
import { quantityPublicationScopeLockKey } from "./quantity-publication-admission.repository";
const id = z.number().int().positive();
const targetSchema = z.object({ id, channel_id: id, channel_connection_id: id.nullable(), dropship_store_connection_id: id.nullable(),
    destination_kind: z.enum(["channel_connection", "dropship_store_connection"]), provider_key: z.string(), provider_scope_type: z.enum(["location", "account"]),
    external_scope_id: z.string(), revision: z.string(), state: z.enum(["disabled", "preview", "live"]), publication_authority: z.string(),
    hold_reason: z.string().nullable(), held_at: z.date().nullable(), source_ready: z.boolean() });
export type MappingPreparationTarget = z.infer<typeof targetSchema>;
export interface PublicationMappingProposal {
    mappings: readonly ActivePublicationVariantMappingSnapshot[];
    newMappingVariantIds: readonly number[];
    /** Exact proposed identities, including members without a saved mapping yet. */
    identities: readonly ActivePublicationVariantMapping[];
}
export const mappingPreparationDigest = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
const fail = (code: string, message: string): never => { throw new InventoryPublicationMembershipError(code, message); };
const blocker = (code: string, message: string, productVariantId: number | null = null): PublicationMembershipBlocker => ({ code, message, productVariantId, action: "configure_inventory" });
export async function readTargets(client: PoolClient, channelId?: number, connectionId?: number, targetId?: number, lock = false): Promise<MappingPreparationTarget[]> {
    const result = await client.query(`SELECT t.id,t.channel_id,t.channel_connection_id,t.dropship_store_connection_id,t.destination_kind,
    c.provider AS provider_key,t.provider_scope_type,t.external_scope_id,t.revision::text,t.state,t.publication_authority,t.hold_reason,t.held_at,
    (EXISTS(SELECT 1 FROM inventory.publication_source_binding_heads h JOIN inventory.publication_source_binding_versions b
      ON b.id=h.active_binding_id AND b.lifecycle_status='sealed' JOIN inventory.publication_source_binding_members m ON m.binding_id=b.id WHERE h.publication_target_id=t.id)
    AND NOT EXISTS(SELECT 1 FROM inventory.publication_source_binding_heads h JOIN inventory.publication_source_binding_versions b ON b.id=h.active_binding_id
      JOIN inventory.publication_source_binding_members m ON m.binding_id=b.id LEFT JOIN warehouse.fulfillment_nodes n ON n.id=m.fulfillment_node_id
      WHERE h.publication_target_id=t.id AND(n.id IS NULL OR n.lifecycle_status<>'active' OR(c.provider='walmart' AND n.warehouse_id IS DISTINCT FROM w.warehouse_id)))
    AND c.status='active' AND(c.provider<>'walmart' OR(w.connection_id=t.channel_connection_id AND w.ship_node_id=t.external_scope_id AND t.provider_scope_type='location'))) IS TRUE AS source_ready
    FROM inventory.inventory_publication_targets t JOIN channels.channels c ON c.id=t.channel_id
    LEFT JOIN channels.walmart_connections w ON w.channel_id=t.channel_id
    WHERE($1::integer IS NULL OR t.channel_id=$1) AND($2::integer IS NULL OR t.channel_connection_id=$2) AND($3::integer IS NULL OR t.id=$3)
    ORDER BY t.id ${lock ? "FOR UPDATE OF t" : ""}`, [channelId ?? null, connectionId ?? null, targetId ?? null]);
    return result.rows.map(row => targetSchema.parse(row));
}
export function mappingTargetBlockers(target: MappingPreparationTarget): PublicationMembershipBlocker[] {
    const issues: PublicationMembershipBlocker[] = [];
    if (target.state !== "live" || target.publication_authority !== "echelon")
        issues.push(blocker("PUBLICATION_DESTINATION_NOT_LIVE", "Review and activate this exact stock destination in Channel Inventory."));
    if (!target.source_ready)
        issues.push(blocker("PUBLICATION_SOURCE_NOT_READY", "Seal an active supply binding matching the configured fulfillment warehouse and destination."));
    if (target.held_at)
        issues.push(blocker("STOCK_LISTING_HELD", "This stock destination is on hold. Review the hold before publishing."));
    return issues;
}
/** Quantity preview uses the existing planner and the listing owner's selection.
 * A mapping proposal may supply exact reviewed identities, never selection. */
export async function reviewMappingPreparation(client: PoolClient, input: {
    publicationTargetId: number;
    expectedTargetRevision: string;
    productId: number;
    productVariantIds: readonly number[];
    allowRetainedZero?: boolean;
}, lock: boolean, proposal?: PublicationMappingProposal) {
    const authority = await loadAndLockRuntimeAuthority(client);
    const target = (await readTargets(client, undefined, undefined, input.publicationTargetId, lock))[0];
    if (!target)
        fail("STOCK_LISTING_TARGET_MISMATCH", "The exact stock destination no longer exists.");
    const blockers = mappingTargetBlockers(target);
    if (target.revision !== input.expectedTargetRevision)
        blockers.push(blocker("STOCK_MAPPING_TARGET_CHANGED", "The stock destination changed during preparation."));
    if (authority.authority !== "canonical")
        blockers.push(blocker("CANONICAL_AUTHORITY_REQUIRED", "Complete the separately reviewed inventory activation before publishing stock."));
    const snapshot = await captureActiveSupplySnapshotInsideTransaction(client, input.productId);
    const managedSellableVariantIds = await loadManagedSellableVariantIds(client, input.productId);
    const targets = await loadActivePublicationTargets(client, input.productId, managedSellableVariantIds);
    const selected = targets.find(candidate => candidate.publicationTargetId === target.id);
    const selection = await readPublicationStockSelection(client, {
        destinationKind: target.destination_kind, channelId: target.channel_id,
        channelConnectionId: target.channel_connection_id, dropshipStoreConnectionId: target.dropship_store_connection_id,
    }, { productId: input.productId, productVariantIds: input.productVariantIds });
    if (!selected)
        blockers.push(blocker("STOCK_LISTING_TARGET_UNAVAILABLE", "This destination has no active stock plan."));
    for (const variantId of input.productVariantIds) {
        const decision = selection.variants.find(row => row.productVariantId === variantId);
        if (decision?.action !== "publish" && !(input.allowRetainedZero && decision?.action === "zero"))
            blockers.push(blocker("STOCK_LISTING_NOT_SELECTED", decision?.reason ?? "Select this exact variant in its channel listing before publishing stock.", variantId));
        for (const issue of decision?.blockers ?? [])
            blockers.push(blocker(issue.code, issue.message, variantId));
    }
    const publicationTargets = targets.map(candidate => candidate.publicationTargetId !== target.id || !proposal ? candidate : { ...candidate,
        mappings: [...candidate.mappings.filter(mapping => !proposal.mappings.some(row => row.productVariantId === mapping.productVariantId)), ...proposal.mappings] });
    const plan = reviewInventoryPublicationQuantities({ ...authority, supplySnapshot: snapshot, managedSellableVariantIds, publicationTargets }, input.productId);
    const targetPlan = plan.targets.find(candidate => candidate.publicationTargetId === target.id);
    for (const issue of targetPlan?.blockers ?? [])
        blockers.push(blocker(issue.code, issue.message));
    // Inactive retained members are intentionally absent from positive ATP.
    // Use the publication owner's existing removal projection, not a fabricated
    // ATP row or a second quantity rule in the eBay integration.
    const retainedQuantities = [];
    if (input.allowRetainedZero && blockers.length === 0) {
        for (const variantId of input.productVariantIds.filter(id => !managedSellableVariantIds.includes(id))) {
            if (selection.variants.find(row => row.productVariantId === variantId)?.action !== "zero") continue;
            const rows = await zeroPublicationIntents({ ...authority, loadActivePublicationTargets: async request =>
                (await loadZeroPublicationTargets(client, request)).map(candidate => candidate.publicationTargetId !== target.id || !proposal
                    ? candidate : { ...candidate, mappings: [...candidate.mappings.filter(mapping =>
                        !proposal.identities.some(identity => identity.productVariantId === mapping.productVariantId)), ...proposal.identities] }),
            }, input.productId, variantId, target.channel_id, target.id);
            retainedQuantities.push(...rows);
        }
    }
    const quantities = [];
    for (const variantId of input.productVariantIds) {
        const row = targetPlan?.rows.find(candidate => candidate.productVariantId === variantId);
        if (!row) {
            const retained = retainedQuantities.find(candidate => candidate.productVariantId === variantId);
            if (retained) {
                quantities.push({ productVariantId: variantId, desiredQuantity: retained.desiredQuantity });
                continue;
            }
            blockers.push(blocker("STOCK_LISTING_QUANTITY_UNAVAILABLE", "The canonical stock planner did not return this exact selected SKU.", variantId));
            continue;
        }
        for (const issue of row.blockers)
            if (!(issue.code === "PUBLICATION_TARGET_VARIANT_MAPPING_MISSING" && proposal?.newMappingVariantIds.includes(variantId)))
                blockers.push(blocker(issue.code, issue.message, variantId));
        quantities.push({ productVariantId: variantId, desiredQuantity: row.desiredQuantity });
    }
    const review = { publicationTargetId: target.id, targetRevision: target.revision, productId: input.productId, productVariantIds: [...input.productVariantIds].sort((a, b) => a - b),
        ready: blockers.length === 0, blockers, quantities, selectionFingerprint: selection.fingerprint };
    return { target, review: { ...review, reviewHash: mappingPreparationDigest({ review, plan: plan.evidenceHash, proposal }) } };
}
/** Shares rollback and provider session locks with mapping promotion. No remote
 * I/O occurs while these configuration locks are held. */
export class PublicationMappingPreparationStore {
    constructor(private readonly pool: Pick<Pool, "connect">) { }
    async transaction<T>(write: boolean | "configuration", work: (client: PoolClient, scopeKeys: string[]) => Promise<T>, rollback = false): Promise<T> {
        const client = await this.pool.connect(), scopeKeys: string[] = [];
        let discard: Error | undefined;
        try {
            await client.query(write === "configuration" ? "BEGIN ISOLATION LEVEL READ COMMITTED" : write ? "BEGIN ISOLATION LEVEL SERIALIZABLE" : "BEGIN ISOLATION LEVEL REPEATABLE READ");
            await client.query("SET LOCAL lock_timeout='5s'");
            await client.query("SET LOCAL statement_timeout='60s'");
            const result = await work(client, scopeKeys);
            await client.query(rollback ? "ROLLBACK" : "COMMIT");
            return result;
        }
        catch (error) {
            try {
                await client.query("ROLLBACK");
            }
            catch (rollbackError) {
                discard = rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError));
                throw new AggregateError([error, rollbackError], "Mapping preparation and rollback failed.");
            }
            if (error && typeof error === "object" && "code" in error && ["40001", "40P01", "55P03"].includes(String(error.code)))
                fail("STOCK_MAPPING_CONCURRENT_CHANGE", "Concurrent inventory work changed this preparation. Retry the saved listing request.");
            throw error;
        }
        finally {
            for (const key of scopeKeys.reverse())
                try {
                    if (!(await client.query<{
                        released: boolean;
                    }>("SELECT pg_advisory_unlock(hashtextextended($1,$2)) AS released", [key, PUBLICATION_TARGET_SCOPE_LOCK_SEED])).rows[0]?.released)
                        discard = new Error("Mapping scope release was not confirmed.");
                }
                catch (error) {
                    discard = error instanceof Error ? error : new Error(String(error));
                }
            client.release(discard);
            if (discard)
                fail("STOCK_MAPPING_CLEANUP_UNCERTAIN", "Connection cleanup is uncertain. Retry the same saved request.");
        }
    }
}
export async function applyMappingPreparation(client: PoolClient, scopeKeys: string[], input: {
    publicationTargetId: number;
    expectedTargetRevision: string;
    productId: number;
    productVariantIds: readonly number[];
    allowRetainedZero?: boolean;
    expectedReviewHash: string;
    idempotencyKey: string;
}, actor: string, requestHash: string, now: Date, changedVariantIds: readonly number[], replacementListingVariantIds: readonly number[] = []): Promise<PublicationMappingPreparationReceipt> {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`mapping-preparation:${input.idempotencyKey}`]);
    const previous = (await client.query<{
        request_hash: string;
        receipt: unknown;
    }>("SELECT request_hash,receipt FROM inventory.publication_mapping_preparations WHERE idempotency_key=$1", [input.idempotencyKey])).rows[0];
    if (previous) {
        if (previous.request_hash !== requestHash)
            fail("STOCK_MAPPING_COMMAND_CONFLICT", "This saved mapping command belongs to another identity or actor.");
        return { ...publicationMappingPreparationReceiptSchema.parse(previous.receipt), alreadyApplied: true };
    }
    const evidence = await reviewMappingPreparation(client, input, true);
    if (evidence.review.reviewHash !== input.expectedReviewHash)
        fail("STOCK_MAPPING_REVIEW_STALE", "Stock selection, mappings or quantities changed during preparation.");
    if (!evidence.review.ready)
        fail("STOCK_MAPPING_NOT_READY", evidence.review.blockers.map(row => row.message).join(" "));
    const { target } = evidence;
    for (const key of [...new Set((await loadPublicationTargetScopes(client, target, input.productId)).map(quantityPublicationScopeLockKey))].sort()) {
        if (!(await client.query<{
            acquired: boolean;
        }>("SELECT pg_try_advisory_lock(hashtextextended($1,$2)) AS acquired", [key, PUBLICATION_TARGET_SCOPE_LOCK_SEED])).rows[0]?.acquired)
            fail("STOCK_MAPPING_PROVIDER_BUSY", "A provider request is in flight. The saved listing will retry after it finishes.");
        scopeKeys.push(key);
    }
    // Both callers only add exact missing mappings or seal an unchanged SKU
    // identity. Promotion fences the mapping head's revision; no destination,
    // source, policy or existing provider identity changes. Bumping the target
    // revision would invalidate unrelated products and make their mapping gaps
    // roll back this preparation. The canonical owner below locks each affected
    // target/variant pair and supersedes only a changed desired revision.
    const publisher = createTransactionScopedInventoryPublicationService(client, { channelId: target.channel_id,
        replacementListings: replacementListingVariantIds.map(productVariantId => ({ publicationTargetId: target.id, productVariantId })) });
    const result = await publisher.publishProduct({ productId: input.productId, publicationTargetId: target.id, dryRun: false, triggeredBy: "listing_mapping_preparation" }, async () => null);
    if (result.authority !== "canonical")
        return fail("STOCK_MAPPING_AUTHORITY_CHANGED", "Canonical stock authority changed during preparation.");
    const receipt = publicationMappingPreparationReceiptSchema.parse({ publicationTargetId: target.id, revision: target.revision, reviewHash: evidence.review.reviewHash, changedProductVariantIds: [...changedVariantIds], publicationRows: result.publication.enqueuedRows, appliedAt: now.toISOString(), appliedBy: actor, alreadyApplied: false });
    await client.query(`INSERT INTO inventory.publication_mapping_preparations(idempotency_key,publication_target_id,request_hash,actor,occurred_at,review,receipt)
    VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb)`, [input.idempotencyKey, target.id, requestHash, actor, now, JSON.stringify(evidence.review), JSON.stringify(receipt)]);
    await client.query(`INSERT INTO public.audit_events(timestamp,level,actor,action,target,changes,context) VALUES($1,'AUDIT',$2,'inventory_availability.listing_mapping.prepared',$3,$4::jsonb,$5::jsonb)`, [now, actor, `inventory.inventory_publication_target:${target.id}`, JSON.stringify(receipt), JSON.stringify({ idempotencyKey: input.idempotencyKey, requestHash, selectionFingerprint: evidence.review.selectionFingerprint })]);
    return receipt;
}
