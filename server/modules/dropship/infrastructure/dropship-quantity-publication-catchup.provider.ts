import type { Pool } from "pg";
import { z } from "zod";
import type { QuantityPublicationCatchup } from "../../inventory-planning/application/quantity-publication-admission.port";
import { quantityPublicationScopeSchema, QuantityPublicationAdmissionError, type QuantityPublicationScope } from "../../inventory-planning/domain/quantity-publication-admission";
import type { DropshipListingPreviewService } from "../application/dropship-listing-preview-service";
import type { DropshipListingPushWorkerService } from "../application/dropship-listing-push-worker-service";
import type { DropshipListingPushOpsService } from "../application/dropship-listing-push-ops-service";

const actor = { actorType: "system" as const, actorId: "inventory_publication_catchup" };
const bigintId = z.string().regex(/^[1-9][0-9]{0,18}$/).refine(value => BigInt(value) <= BigInt("9223372036854775807"));
const claimIdentitySchema = z.object({ catchupId: bigintId, revision: bigintId });
interface ListingIdentity { listing_id: number; vendor_id: number; product_variant_id: number; product_id: number; sku: string; status: string }
interface ExistingJob { id: number; vendor_id: number; store_connection_id: number; status: string; item_count: number; exact_item_count: number }

export interface DropshipQuantityPublicationCatchupDependencies {
  database: Pick<Pool, "query">;
  preview: Pick<DropshipListingPreviewService, "generatePreview" | "createListingPushJob">;
  /** The production worker refreshes the intent from CURRENT preview before every provider call. */
  worker: Pick<DropshipListingPushWorkerService, "processJob">;
  operations: Pick<DropshipListingPushOpsService, "retryJob">;
}

/** Reuses listing owners; it never writes a quantity, listing or job table directly. */
export class DropshipQuantityPublicationCatchupProvider {
  constructor(private readonly dependencies: DropshipQuantityPublicationCatchupDependencies) {}

  async refresh(rawScope: QuantityPublicationScope, claim: QuantityPublicationCatchup): Promise<void> {
    const scope = quantityPublicationScopeSchema.parse(rawScope);
    const retainedScope = quantityPublicationScopeSchema.parse(claim.scope);
    const identity = claimIdentitySchema.parse(claim);
    if (Object.keys(scope).some(key => scope[key as keyof QuantityPublicationScope] !== retainedScope[key as keyof QuantityPublicationScope])) {
      throw failure("PUBLICATION_CATCHUP_SCOPE_MISMATCH", "Catch-up scope does not match its retained obligation.");
    }
    // This owner publishes a single eBay SKU. Group/batch mutations need their
    // persisted multi-item manifest; choosing one variant would be unsafe.
    if (scope.destinationKind !== "dropship_store_connection" || scope.providerKey !== "ebay"
      || scope.providerScopeType !== "account" || /^(group|batch):/.test(scope.externalInventoryItemId)) {
      throw failure("PUBLICATION_CATCHUP_OWNER_UNRESOLVED", "This retained identity has no exact single-listing quantity owner.");
    }
    const listing = await this.resolveListing(scope);
    const jobKey = `inventory-publication-catchup:${identity.catchupId}:${identity.revision}`;
    // Replay before preview: the original creation hash includes quantity and
    // pricing, which may legitimately change while a failed job awaits retry.
    const jobs = (await this.dependencies.database.query<ExistingJob>(
      `SELECT job.id,job.vendor_id,job.store_connection_id,job.status,
        COUNT(item.id)::integer AS item_count,
        COUNT(item.id) FILTER (WHERE item.listing_id=$2 AND item.product_variant_id=$3)::integer AS exact_item_count
       FROM dropship.dropship_listing_push_jobs job
       LEFT JOIN dropship.dropship_listing_push_job_items item ON item.job_id=job.id
       WHERE job.idempotency_key=$1
       GROUP BY job.id,job.vendor_id,job.store_connection_id,job.status ORDER BY job.id LIMIT 2`,
      [jobKey, listing.listing_id, listing.product_variant_id],
    )).rows;
    if (jobs.length > 1) throw failure("PUBLICATION_CATCHUP_JOB_AMBIGUOUS", "Catch-up job identity is not unique.");
    let jobId: number;
    let status: string;
    if (jobs.length === 1) {
      const job = jobs[0];
      if (job.vendor_id !== listing.vendor_id || job.store_connection_id !== scope.connectionId
        || job.item_count !== 1 || job.exact_item_count !== 1) {
        throw failure("PUBLICATION_CATCHUP_JOB_MISMATCH", "Stored catch-up job does not own this exact listing.");
      }
      jobId = job.id;
      status = job.status;
    } else {
      const preview = await this.dependencies.preview.generatePreview({
        vendorId: listing.vendor_id, storeConnectionId: scope.connectionId,
        productVariantIds: [listing.product_variant_id], actor,
      });
      const row = preview.rows[0];
      if (preview.vendorId !== listing.vendor_id || preview.storeConnectionId !== scope.connectionId
        || preview.platform !== scope.providerKey || preview.rows.length !== 1
        || row.productVariantId !== listing.product_variant_id || row.productId !== listing.product_id
        || row.sku !== listing.sku || row.previewStatus === "blocked" || row.listingIntent === null) {
        throw failure("PUBLICATION_CATCHUP_PREVIEW_BLOCKED", "Current listing preview is blocked or no longer matches the retained destination.");
      }
      const variantKey = String(listing.product_variant_id);
      const created = await this.dependencies.preview.createListingPushJob({
        vendorId: listing.vendor_id, storeConnectionId: scope.connectionId,
        productVariantIds: [listing.product_variant_id], requestedBy: actor, idempotencyKey: jobKey,
        expectedContentEvidenceHashesByVariantId: row.contentEvidenceHash ? { [variantKey]: row.contentEvidenceHash } : {},
        expectedRuleEvidenceHashesByVariantId: row.rulePriceEvidenceHash ? { [variantKey]: row.rulePriceEvidenceHash } : {},
        expectedPriceRevisionIdsByVariantId: { [variantKey]: row.priceSettingRevisionId ?? null },
        expectedPriceCentsByVariantId: { [variantKey]: row.priceCents },
      });
      if (created.job.vendorId !== listing.vendor_id || created.job.storeConnectionId !== scope.connectionId
        || created.items.length !== 1 || created.items[0].listingId !== listing.listing_id
        || created.items[0].productVariantId !== listing.product_variant_id) {
        throw failure("PUBLICATION_CATCHUP_JOB_MISMATCH", "Created catch-up job does not own this exact listing.");
      }
      jobId = created.job.jobId;
      status = created.job.status;
    }
    if (status === "failed") {
      await this.dependencies.operations.retryJob({ jobId, idempotencyKey: `${jobKey}:retry`, actor,
        reason: "Recalculate retained inventory publication from current authoritative listing preview." });
    } else if (status !== "queued" && status !== "processing" && status !== "completed") {
      throw failure("PUBLICATION_CATCHUP_JOB_NOT_RUNNABLE", "Catch-up listing job is cancelled or otherwise not runnable.");
    }
    const result = await this.dependencies.worker.processJob({ jobId,
      workerId: actor.actorId, idempotencyKey: `${jobKey}:process` });
    if (result.job.jobId !== jobId || result.job.vendorId !== listing.vendor_id
      || result.job.storeConnectionId !== scope.connectionId || result.job.status !== "completed"
      || result.items.length !== 1 || result.items[0].listingId !== listing.listing_id
      || result.items[0].productVariantId !== listing.product_variant_id || result.items[0].status !== "completed") {
      throw failure("PUBLICATION_CATCHUP_JOB_INCOMPLETE", "Current listing publication has not completed successfully.");
    }
    // The planning owner independently requires a successful exact-scope
    // admission newer than this retained revision's durable attempt boundary.
  }

  private async resolveListing(scope: QuantityPublicationScope): Promise<ListingIdentity> {
    const offerMatch = /^offer:([^:]+)(?::publish)?$/.exec(scope.externalInventoryItemId);
    if (scope.externalInventoryItemId.startsWith("offer:") && !offerMatch) {
      throw failure("PUBLICATION_CATCHUP_OWNER_UNRESOLVED", "Retained offer identity is not an exact supported offer path.");
    }
    const rows = (await this.dependencies.database.query<ListingIdentity>(
      `SELECT listing.id AS listing_id,listing.vendor_id,listing.product_variant_id,
        variant.product_id,variant.sku,listing.status
       FROM dropship.dropship_vendor_listings listing
       JOIN dropship.dropship_store_connections connection ON connection.id=listing.store_connection_id
         AND connection.vendor_id=listing.vendor_id AND connection.platform=listing.platform
       JOIN catalog.product_variants variant ON variant.id=listing.product_variant_id
       WHERE listing.store_connection_id=$1 AND listing.platform=$2 AND connection.external_account_id=$3
         AND (($4::text IS NOT NULL AND listing.external_offer_id=$4)
           OR ($4::text IS NULL AND variant.sku=$5))
       ORDER BY listing.id LIMIT 2`,
      [scope.connectionId, scope.providerKey, scope.externalScopeId, offerMatch?.[1] ?? null, scope.externalInventoryItemId],
    )).rows;
    if (rows.length !== 1) throw failure("PUBLICATION_CATCHUP_OWNER_UNRESOLVED", "Exactly one persisted listing must own the retained provider identity.");
    const row = rows[0];
    if ((scope.productId !== null && scope.productId !== row.product_id)
      || (scope.productVariantId !== null && scope.productVariantId !== row.product_variant_id)
      || !row.sku || row.status === "paused" || row.status === "ended") {
      throw failure("PUBLICATION_CATCHUP_LISTING_CHANGED", "Listing identity or explicit listing lifecycle no longer permits this catch-up.");
    }
    return row;
  }
}

function failure(code: string, message: string): QuantityPublicationAdmissionError {
  return new QuantityPublicationAdmissionError(code, message);
}

export async function refreshDropshipQuantityPublicationCatchup(scope: QuantityPublicationScope,
  claim: QuantityPublicationCatchup): Promise<void> {
  const [{ pool }, { createDropshipListingPreviewServiceFromEnv }, { createDropshipListingPushWorkerServiceFromEnv },
    { createDropshipListingPushOpsServiceFromEnv }] = await Promise.all([
    import("../../../db"), import("./dropship-listing-preview.factory"),
    import("./dropship-listing-push-worker.factory"), import("./dropship-listing-push-ops.factory"),
  ]);
  await new DropshipQuantityPublicationCatchupProvider({ database: pool,
    preview: createDropshipListingPreviewServiceFromEnv(), worker: createDropshipListingPushWorkerServiceFromEnv(),
    operations: createDropshipListingPushOpsServiceFromEnv() }).refresh(scope, claim);
}
