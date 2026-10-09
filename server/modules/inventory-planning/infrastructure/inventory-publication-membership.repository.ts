import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { canonicalJson } from "@shared/utils/canonical-json";
import {
  publicationMembershipReceiptSchema,
  type InspectPublicationMembership,
  type ReviewPublicationMembership,
  type ApplyPublicationMembership,
  type PublicationMembershipInspection,
  type PublicationMembershipReview,
  type PublicationMembershipReceipt,
  type PublicationMembershipBlocker,
} from "@shared/types/inventory-publication-membership";
import {
  InventoryPublicationMembershipError,
  type InventoryPublicationMembershipStore,
} from "../application/inventory-publication-membership.service";
import { planInventoryChannelExposureProduct } from "../application/inventory-channel-exposure-runtime.service";
import { resolvePromiseWarehouseIds } from "../domain/inventory-warehouse-scope";
import { loadAndLockRuntimeAuthority } from "./inventory-availability-runtime-atp.repository";
import { captureActiveSupplySnapshotInsideTransaction } from "./inventory-availability-shadow.repository";
import {
  loadActivePublicationTargets,
  loadManagedSellableVariantIds,
} from "./inventory-channel-exposure-runtime.repository";
import { createTransactionScopedInventoryPublicationService } from "./inventory-availability-runtime-publication.repository";
import {
  loadPublicationTargetScopes,
  PUBLICATION_TARGET_SCOPE_LOCK_SEED,
} from "./inventory-publication-target-stop.repository";
import { quantityPublicationScopeLockKey } from "./quantity-publication-admission.repository";
import type { VerifiedStockListing, VerifiedListingStockResult, VerifiedListingStockStore } from "../application/verified-listing-stock.service";
import { acquireInventoryCutoverFenceInsideTransaction } from "./inventory-cutover-admission-fence.repository";
import { prepareVerifiedStockMapping } from "./verified-listing-stock-mapping.repository";

const id = z.number().int().positive();
const targetSchema = z.object({
  id,
  channel_id: id,
  channel_connection_id: id.nullable(),
  dropship_store_connection_id: id.nullable(),
  destination_kind: z.enum(["channel_connection", "dropship_store_connection"]),
  provider_key: z.string(),
  provider_scope_type: z.enum(["location", "account"]),
  external_scope_id: z.string(),
  revision: z.string(),
  membership_mode: z.enum(["whole_product", "explicit"]),
  state: z.enum(["disabled", "preview", "live"]),
  publication_authority: z.string(),
  hold_reason: z.string().nullable(),
  held_at: z.date().nullable(),
  source_ready: z.boolean(),
});
type Target = z.infer<typeof targetSchema>;
const variantSchema = z.object({
  id,
  product_id: id,
  eligible: z.boolean(),
  included: z.boolean(),
  mapping_id: id.nullable(),
  mapping_hash: z.string().nullable(),
  external_inventory_item_id: z.string().nullable(),
  external_sku: z.string().nullable(),
  mapping_ready: z.boolean(),
  held_at: z.date().nullable(),
  zero_verified: z.boolean(),
});
type Variant = z.infer<typeof variantSchema>;
const digest = (value: unknown) =>
  createHash("sha256").update(canonicalJson(value)).digest("hex");
const error = (code: string, message: string, status = 409) =>
  new InventoryPublicationMembershipError(code, message, status);
const issue = (
  code: string,
  message: string,
  action: PublicationMembershipBlocker["action"],
  productVariantId: number | null = null,
): PublicationMembershipBlocker => ({
  code,
  message,
  action,
  productVariantId,
});

interface ReviewEvidence {
  review: PublicationMembershipReview;
  target: Target;
  variants: Variant[];
  includedIds: number[];
}

/** Inventory owns membership and verified listing enrollment. Enrollment uses
 * the existing mapping promotion and canonical publication owners. All current
 * target work is replanned after its revision changes, including other products. */
export class PostgresInventoryPublicationMembershipStore
  implements InventoryPublicationMembershipStore, VerifiedListingStockStore
{
  constructor(private readonly pool: Pick<Pool, "connect">) {}

  /** Existing exclusions are operator decisions, not missing setup. */
  pending(channelId: number, connectionId: number, variantIds: number[]): Promise<number[]> {
    return this.transaction(false, async client => {
      const targets = await readTargets(client, channelId, connectionId);
      if (targets.length !== 1 || targets[0].provider_key !== "walmart"
        || targetBlockers(targets[0]).length || targets[0].held_at) return [];
      const result = await client.query<{ id: number }>(`SELECT candidate.id FROM unnest($2::integer[]) candidate(id)
        WHERE NOT EXISTS (SELECT 1 FROM inventory.publication_membership_heads h
          WHERE h.publication_target_id=$1 AND h.product_variant_id=candidate.id)
        AND EXISTS (SELECT 1 FROM channels.sync_settings WHERE global_enabled=true)
        ORDER BY candidate.id`, [targets[0].id, variantIds]);
      return result.rows.map(row => row.id);
    });
  }

  /** Atomically connects an already-linked, freshly verified listing to an
   * enabled destination. A dry run exercises the same writes then rolls back. */
  connect(input: VerifiedStockListing, now: Date, dryRun: boolean): Promise<VerifiedListingStockResult> {
    return this.transaction("configuration", async (client, scopeKeys) => {
      await acquireInventoryCutoverFenceInsideTransaction(client, {
        expectedAuthority: "canonical", expectedConfigurationRunId: null,
      });
      const targets = await readTargets(client, input.channelId, input.connectionId, undefined, true);
      if (targets.length !== 1 || targets[0].provider_key !== "walmart" || targets[0].external_scope_id !== input.externalScopeId) {
        throw error("STOCK_LISTING_TARGET_MISMATCH", "The verified listing does not match one exact Walmart stock destination.");
      }
      const target = targets[0];
      const blockers = targetBlockers(target);
      if (blockers.length || target.held_at) {
        throw error("STOCK_LISTING_TARGET_NOT_READY", blockers.map(row => row.message).join(" ") || "Stock for this account is on hold.");
      }
      const member = (await client.query<{ included: boolean }>(`SELECT v.included FROM inventory.publication_membership_heads h
        JOIN inventory.publication_membership_versions v ON v.id=h.active_version_id
        WHERE h.publication_target_id=$1 AND h.product_variant_id=$2`, [target.id, input.productVariantId])).rows[0];
      if (member) return { state: member.included ? "already_connected" : "excluded", dryRun, receipt: null, quantities: [] };
      const actor = "walmart-stock-connection";
      const requestHash = digest({ targetId: target.id, channelId: input.channelId, connectionId: input.connectionId,
        variantId: input.productVariantId, sku: input.sku, externalProductId: input.externalProductId, actor });
      await prepareVerifiedStockMapping(client, target.id, input, requestHash, actor, now);
      const command = { publicationTargetId: target.id, expectedTargetRevision: target.revision,
        changes: [{ productVariantId: input.productVariantId, included: true }] };
      const { review } = await captureReview(client, command, true);
      if (!review.ready) throw error("STOCK_LISTING_ATP_NOT_READY", review.blockers.map(row => row.message).join(" "));
      const receipt = await this.applyInsideTransaction(client, scopeKeys, { ...command,
        expectedReviewHash: review.reviewHash, idempotencyKey: `verified-stock:${requestHash}` }, actor, requestHash, now);
      return { state: "connected", dryRun, receipt, quantities: review.quantities };
    }, dryRun);
  }

  inspect(
    input: InspectPublicationMembership,
  ): Promise<PublicationMembershipInspection> {
    return this.transaction(false, async (client) => {
      const authority = await loadAndLockRuntimeAuthority(client);
      const targets = await readTargets(
        client,
        input.channelId,
        input.channelConnectionId,
      );
      const blockers: PublicationMembershipBlocker[] =
        authority.authority === "canonical"
          ? []
          : [
              issue(
                "CANONICAL_AUTHORITY_REQUIRED",
                "Automatic stock publication requires the separately reviewed inventory activation.",
                "configure_inventory",
              ),
            ];
      if (targets.length !== 1)
        blockers.push(
          issue(
            "EXACT_PUBLICATION_TARGET_REQUIRED",
            "Configure one exact publication destination for this connection.",
            "configure_inventory",
          ),
        );
      const results: PublicationMembershipInspection["targets"] = [];
      for (const target of targets) {
        blockers.push(...targetBlockers(target));
        const variants = await readVariants(
          client,
          target,
          input.productVariantIds,
        );
        for (const variantId of input.productVariantIds) {
          const variant = variants.find(
            (candidate) => candidate.id === variantId,
          );
          blockers.push(...inclusionBlockers(variant, variantId));
        }
        results.push({
          publicationTargetId: target.id,
          revision: target.revision,
          mode: target.membership_mode,
          state: target.state,
          externalScopeId: target.external_scope_id,
          sourceReady: target.source_ready,
          variants: input.productVariantIds.map((productVariantId) => {
            const variant = variants.find(
              (candidate) => candidate.id === productVariantId,
            );
            return {
              productVariantId,
              included: variant?.included ?? false,
              mappingReady: variant?.mapping_ready ?? false,
              externalInventoryItemId:
                variant?.external_inventory_item_id ?? null,
              externalSku: variant?.external_sku ?? null,
            };
          }),
        });
        if (blockers.length === 0) {
          const preview = await captureReview(
            client,
            {
              publicationTargetId: target.id,
              expectedTargetRevision: target.revision,
              changes: input.productVariantIds.map((productVariantId) => ({
                productVariantId,
                included: true,
              })),
            },
            false,
          );
          blockers.push(...preview.review.blockers);
        }
      }
      return {
        channelId: input.channelId,
        channelConnectionId: input.channelConnectionId,
        authority: authority.authority,
        authorityRevision: authority.authorityRevision,
        targets: results,
        blockers,
        ready: blockers.length === 0,
      };
    });
  }

  review(
    input: ReviewPublicationMembership,
  ): Promise<PublicationMembershipReview> {
    return this.transaction(
      false,
      async (client) => (await captureReview(client, input, false)).review,
    );
  }

  apply(
    input: ApplyPublicationMembership,
    actor: string,
    requestHash: string,
    now: Date,
  ): Promise<PublicationMembershipReceipt> {
    return this.transaction(true, (client, scopeKeys) => this.applyInsideTransaction(client, scopeKeys, input, actor, requestHash, now));
  }

  private async applyInsideTransaction(client: PoolClient, scopeKeys: string[], input: ApplyPublicationMembership,
    actor: string, requestHash: string, now: Date): Promise<PublicationMembershipReceipt> {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
        [`publication_membership:${input.idempotencyKey}`],
      );
      const previous = (
        await client.query<{ request_hash: string; receipt: unknown }>(
          "SELECT request_hash,receipt FROM inventory.publication_membership_applications WHERE idempotency_key=$1",
          [input.idempotencyKey],
        )
      ).rows[0];
      if (previous) {
        if (previous.request_hash !== requestHash)
          throw error(
            "MEMBERSHIP_COMMAND_CONFLICT",
            "This retry key belongs to another membership command or actor.",
          );
        return {
          ...publicationMembershipReceiptSchema.parse(previous.receipt),
          alreadyApplied: true,
        };
      }
      const evidence = await captureReview(client, input, true);
      const { review, target } = evidence;
      if (review.reviewHash !== input.expectedReviewHash)
        throw error(
          "MEMBERSHIP_REVIEW_STALE",
          "Inventory or selected membership changed; review again.",
        );
      if (!review.ready)
        throw error(
          "MEMBERSHIP_REVIEW_BLOCKED",
          review.blockers.map((blocker) => blocker.message).join(" "),
        );

      // Session locks are the existing provider admission exclusion boundary.
      // A running request wins; no membership effect occurs until it finishes.
      const scopes = await loadPublicationTargetScopes(client, target);
      for (const scopeKey of [
        ...new Set(scopes.map(quantityPublicationScopeLockKey)),
      ].sort()) {
        const locked = (
          await client.query<{ acquired: boolean }>(
            "SELECT pg_try_advisory_lock(hashtextextended($1,$2)) AS acquired",
            [scopeKey, PUBLICATION_TARGET_SCOPE_LOCK_SEED],
          )
        ).rows[0]?.acquired;
        if (!locked)
          throw error(
            "MEMBERSHIP_PROVIDER_BUSY",
            "A provider request is in flight; retry this command after it completes.",
          );
        scopeKeys.push(scopeKey);
      }
      const changes = review.changes.filter(
        (change) => change.before !== change.after,
      );
      for (const change of changes) {
        const definitionHash = digest({
          publicationTargetId: target.id,
          productVariantId: change.productVariantId,
          included: change.after,
        });
        const inserted = (
          await client.query<{ id: string }>(
            `INSERT INTO inventory.publication_membership_versions
          (publication_target_id,product_variant_id,version,included,definition_hash,review_hash,created_by,created_at)
          SELECT $1,$2,COALESCE(MAX(version),0)+1,$3,$4,$5,$6,$7 FROM inventory.publication_membership_versions
          WHERE publication_target_id=$1 AND product_variant_id=$2 RETURNING id::text`,
            [
              target.id,
              change.productVariantId,
              change.after,
              definitionHash,
              review.reviewHash,
              actor,
              now,
            ],
          )
        ).rows[0];
        if (!inserted)
          throw error(
            "MEMBERSHIP_PERSISTENCE_FAILED",
            "Membership version was not persisted.",
            500,
          );
        await client.query(
          `INSERT INTO inventory.publication_membership_heads(publication_target_id,product_variant_id,active_version_id)
          VALUES($1,$2,$3) ON CONFLICT(publication_target_id,product_variant_id) DO UPDATE SET active_version_id=EXCLUDED.active_version_id`,
          [target.id, change.productVariantId, inserted.id],
        );
      }
      let revision = target.revision;
      let publicationRows = 0;
      if (changes.length) {
        const updated = (
          await client.query<{ revision: string }>(
            `UPDATE inventory.inventory_publication_targets
          SET revision=revision+1,updated_at=$3 WHERE id=$1 AND revision=$2::bigint RETURNING revision::text`,
            [target.id, target.revision, now],
          )
        ).rows[0];
        if (!updated)
          throw error(
            "MEMBERSHIP_TARGET_CHANGED",
            "The publication target changed during the command.",
          );
        revision = updated.revision;
        await client.query(
          `UPDATE inventory.inventory_publication_outbox SET state='superseded',lease_token=NULL,lease_expires_at=NULL,
          last_error_class='PUBLICATION_MEMBERSHIP_CHANGED',last_error_message='Replaced by reviewed membership',updated_at=$2
          WHERE publication_target_id=$1 AND state IN ('desired','queued','leased','retryable','drifted')`,
          [target.id, now],
        );
        const publisher = createTransactionScopedInventoryPublicationService(
          client,
          { channelId: target.channel_id },
        );
        for (const productId of review.affectedProductIds) {
          const planned = await publisher.publishProduct(
            {
              productId,
              publicationTargetId: target.id,
              dryRun: false,
              triggeredBy: "publication_membership_apply",
            },
            async () => null,
          );
          if (planned.authority !== "canonical")
            throw error(
              "MEMBERSHIP_AUTHORITY_CHANGED",
              "Canonical publication authority changed.",
            );
          publicationRows += planned.publication.enqueuedRows;
        }
      }
      const receipt: PublicationMembershipReceipt = {
        publicationTargetId: target.id,
        revision,
        reviewHash: review.reviewHash,
        changedProductVariantIds: changes.map(
          (change) => change.productVariantId,
        ),
        publicationRows,
        appliedAt: now.toISOString(),
        appliedBy: actor,
        alreadyApplied: false,
      };
      await client.query(
        `INSERT INTO inventory.publication_membership_applications
        (publication_target_id,idempotency_key,request_hash,actor,occurred_at,review,receipt) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb)`,
        [
          target.id,
          input.idempotencyKey,
          requestHash,
          actor,
          now,
          JSON.stringify(review),
          JSON.stringify(receipt),
        ],
      );
      await client.query(
        `INSERT INTO public.audit_events(timestamp,level,actor,action,target,changes,context)
        VALUES($1,'AUDIT',$2,'inventory_availability.publication_membership.applied',$3,$4::jsonb,$5::jsonb)`,
        [
          now,
          actor,
          `inventory.inventory_publication_target:${target.id}`,
          JSON.stringify(review.changes),
          JSON.stringify({
            idempotencyKey: input.idempotencyKey,
            requestHash,
            receipt,
          }),
        ],
      );
      return receipt;
  }

  private async transaction<T>(
    write: boolean | "configuration",
    work: (client: PoolClient, scopeKeys: string[]) => Promise<T>,
    rollback = false,
  ): Promise<T> {
    const client = await this.pool.connect();
    const scopeKeys: string[] = [];
    let discard: Error | undefined;
    try {
      await client.query(
        write === "configuration" ? "BEGIN ISOLATION LEVEL READ COMMITTED" : write
          ? "BEGIN ISOLATION LEVEL SERIALIZABLE"
          : "BEGIN ISOLATION LEVEL REPEATABLE READ",
      );
      await client.query("SET LOCAL lock_timeout='5s'");
      await client.query("SET LOCAL statement_timeout='60s'");
      const result = await work(client, scopeKeys);
      await client.query(rollback ? "ROLLBACK" : "COMMIT");
      return result;
    } catch (failure) {
      try {
        await client.query("ROLLBACK");
      } catch (rollback) {
        discard =
          rollback instanceof Error ? rollback : new Error(String(rollback));
        throw new AggregateError(
          [failure, rollback],
          "Membership command and rollback failed.",
        );
      }
      if (
        failure &&
        typeof failure === "object" &&
        "code" in failure &&
        (failure.code === "40001" || failure.code === "40P01")
      ) {
        throw error(
          "MEMBERSHIP_CONCURRENT_CHANGE",
          "Concurrent inventory work changed the review; retry the same command key or review again.",
        );
      }
      throw failure;
    } finally {
      for (const scopeKey of scopeKeys.reverse()) {
        try {
          if (
            !(
              await client.query<{ released: boolean }>(
                "SELECT pg_advisory_unlock(hashtextextended($1,$2)) AS released",
                [scopeKey, PUBLICATION_TARGET_SCOPE_LOCK_SEED],
              )
            ).rows[0]?.released
          )
            discard = new Error(
              "Membership scope lock release was not confirmed.",
            );
        } catch (failure) {
          discard =
            failure instanceof Error ? failure : new Error(String(failure));
        }
      }
      client.release(discard);
      if (discard)
        throw error(
          "MEMBERSHIP_CLEANUP_UNCERTAIN",
          "Connection cleanup is uncertain; retry the same command key.",
          503,
        );
    }
  }
}

async function captureReview(
  client: PoolClient,
  input: ReviewPublicationMembership,
  lock: boolean,
): Promise<ReviewEvidence> {
  const authority = await loadAndLockRuntimeAuthority(client);
  const target = (
    await readTargets(
      client,
      undefined,
      undefined,
      input.publicationTargetId,
      lock,
    )
  )[0];
  if (!target)
    throw error(
      "MEMBERSHIP_TARGET_NOT_FOUND",
      "Publication destination was not found.",
      404,
    );
  const blockers = targetBlockers(target);
  if (target.revision !== input.expectedTargetRevision)
    blockers.push(
      issue(
        "MEMBERSHIP_TARGET_STALE",
        "Reload the changed publication destination.",
        "refresh",
      ),
    );
  if (authority.authority !== "canonical")
    blockers.push(
      issue(
        "CANONICAL_AUTHORITY_REQUIRED",
        "Inventory activation must be completed separately before membership Apply.",
        "configure_inventory",
      ),
    );
  const current = (
    await client.query<{ product_variant_id: number }>(
      `SELECT h.product_variant_id FROM inventory.publication_membership_heads h
    JOIN inventory.publication_membership_versions v ON v.id=h.active_version_id WHERE h.publication_target_id=$1 AND v.included=true ORDER BY h.product_variant_id`,
      [target.id],
    )
  ).rows;
  const variants = await readVariants(client, target, [
    ...new Set([
      ...current.map((row) => row.product_variant_id),
      ...input.changes.map((change) => change.productVariantId),
    ]),
  ]);
  const included = new Set(current.map((row) => row.product_variant_id));
  const changes = input.changes.map((change) => {
    const before = included.has(change.productVariantId);
    const variant = variants.find(
      (value) => value.id === change.productVariantId,
    );
    if (change.included) {
      blockers.push(...inclusionBlockers(variant, change.productVariantId));
      included.add(change.productVariantId);
    } else {
      if (
        before &&
        (!variant?.zero_verified || !(target.held_at || variant.held_at))
      ) {
        blockers.push(
          issue(
            "MEMBERSHIP_REMOVAL_REQUIRES_VERIFIED_ZERO",
            "Hold this SKU and verify current destination stock is zero before excluding it.",
            "hold_and_verify_zero",
            change.productVariantId,
          ),
        );
      }
      included.delete(change.productVariantId);
    }
    return {
      productVariantId: change.productVariantId,
      before,
      after: change.included,
    };
  });
  const affectedProductIds = [
    ...new Set(
      variants
        .filter((variant) => included.has(variant.id))
        .map((variant) => variant.product_id),
    ),
  ].sort((a, b) => a - b);
  if (affectedProductIds.length > 1000)
    throw error(
      "MEMBERSHIP_SCOPE_TOO_LARGE",
      "The complete destination exceeds 1000 products; no partial apply is allowed.",
      422,
    );
  const quantities: PublicationMembershipReview["quantities"] = [];
  const plans: unknown[] = [];
  if (blockers.length === 0) {
    for (const productId of affectedProductIds) {
      const snapshot = await captureActiveSupplySnapshotInsideTransaction(
        client,
        productId,
      );
      const managedSellableVariantIds = await loadManagedSellableVariantIds(
        client,
        productId,
      );
      const targets = await loadActivePublicationTargets(
        client,
        productId,
        managedSellableVariantIds,
      );
      const selectedIds = variants
        .filter(
          (variant) =>
            variant.product_id === productId && included.has(variant.id),
        )
        .map((variant) => variant.id);
      const publicationTargets = targets.map((candidate) =>
        candidate.publicationTargetId === target.id
          ? {
              ...candidate,
              membership: {
                mode: "explicit" as const,
                includedVariantIds: selectedIds,
              },
            }
          : candidate,
      );
      const plan = planInventoryChannelExposureProduct(
        {
          ...authority,
          supplySnapshot: snapshot,
          managedSellableVariantIds,
          publicationTargets,
        },
        productId,
      );
      // Capture time is observational metadata, not a configuration change.
      // Stable review identity still includes stock fingerprint and every row.
      const { snapshotCapturedAt: _capturedAt, ...stablePlan } = plan;
      plans.push(stablePlan);
      const selected = plan.targets.find(
        (candidate) => candidate.publicationTargetId === target.id,
      );
      if (!selected)
        blockers.push(
          issue(
            "MEMBERSHIP_TARGET_UNAVAILABLE",
            "The selected destination has no current inventory plan.",
            "configure_inventory",
          ),
        );
      for (const problem of selected?.blockers ?? [])
        blockers.push(
          issue(problem.code, problem.message, "configure_inventory"),
        );
      // ATP reports physical contributions from the hub and its active reserves.
      // Validate SKU overrides against that same group, not just the binding's
      // root IDs; an unrelated warehouse must still block enrollment.
      const configuredPromiseWarehouseIds = new Set(resolvePromiseWarehouseIds(
        snapshot.warehouses,
        selected?.sourceBinding?.warehouseIds ?? [],
      ));
      for (const row of selected?.rows ?? []) {
        for (const problem of row.blockers)
          blockers.push(
            issue(
              problem.code,
              problem.message,
              "configure_inventory",
              row.productVariantId,
            ),
          );
        if (
          target.provider_key === "walmart" &&
          row.sourceWarehouseBreakdown.some(
            (source) =>
              BigInt(source.canonicalAtpUnits) > BigInt(0) &&
              !configuredPromiseWarehouseIds.has(source.warehouseId),
          )
        ) {
          blockers.push(
            issue(
              "WALMART_SOURCE_OVERRIDE_MISMATCH",
              "The selected SKU's source must match its configured Walmart fulfillment warehouse or an active reserve linked to it.",
              "review_source",
              row.productVariantId,
            ),
          );
        }
        quantities.push({
          productVariantId: row.productVariantId,
          desiredQuantity: row.publishedUnits,
        });
      }
    }
  }
  const body = {
    publicationTargetId: target.id,
    targetRevision: target.revision,
    authorityRevision: authority.authorityRevision,
    ready: blockers.length === 0,
    blockers,
    changes,
    affectedProductIds,
    quantities,
  };
  return {
    target,
    variants,
    includedIds: [...included].sort((a, b) => a - b),
    review: { ...body, reviewHash: digest({ body, target, variants, plans }) },
  };
}

function targetBlockers(target: Target): PublicationMembershipBlocker[] {
  const result: PublicationMembershipBlocker[] = [];
  if (target.membership_mode !== "explicit")
    result.push(
      issue(
        "MEMBERSHIP_MODE_NOT_EXPLICIT",
        "This destination retains whole-product scope; do not change it through selective enrollment.",
        "review_existing_scope",
      ),
    );
  if (target.state !== "live" || target.publication_authority !== "echelon")
    result.push(
      issue(
        "PUBLICATION_DESTINATION_NOT_LIVE",
        "Review and activate this exact stock destination in Channel Inventory.",
        "configure_inventory",
      ),
    );
  if (!target.source_ready)
    result.push(
      issue(
        "PUBLICATION_SOURCE_NOT_READY",
        "Seal an active supply binding matching the configured fulfillment warehouse and destination.",
        "review_source",
      ),
    );
  return result;
}
function inclusionBlockers(
  variant: Variant | undefined,
  variantId: number,
): PublicationMembershipBlocker[] {
  if (!variant?.eligible)
    return [
      issue(
        "PUBLICATION_VARIANT_INELIGIBLE",
        "The selected variant is missing or is not an active physical sellable SKU.",
        "review_variant",
        variantId,
      ),
    ];
  if (!variant.mapping_ready)
    return [
      issue(
        "PUBLICATION_MAPPING_NOT_READY",
        "Verify the channel SKU and seal its exact inventory mapping before enrollment.",
        "review_mapping",
        variantId,
      ),
    ];
  return [];
}

async function readTargets(
  client: PoolClient,
  channelId?: number,
  connectionId?: number,
  targetId?: number,
  lock = false,
): Promise<Target[]> {
  const result = await client.query(
    `SELECT t.id,t.channel_id,t.channel_connection_id,t.dropship_store_connection_id,t.destination_kind,
    c.provider AS provider_key,t.provider_scope_type,t.external_scope_id,t.revision::text,t.membership_mode,t.state,t.publication_authority,t.hold_reason,t.held_at,
    (EXISTS (SELECT 1 FROM inventory.publication_source_binding_heads h JOIN inventory.publication_source_binding_versions b
      ON b.id=h.active_binding_id AND b.lifecycle_status='sealed' JOIN inventory.publication_source_binding_members m ON m.binding_id=b.id
      WHERE h.publication_target_id=t.id)
    AND NOT EXISTS (SELECT 1 FROM inventory.publication_source_binding_heads h JOIN inventory.publication_source_binding_versions b
      ON b.id=h.active_binding_id JOIN inventory.publication_source_binding_members m ON m.binding_id=b.id
      LEFT JOIN warehouse.fulfillment_nodes n ON n.id=m.fulfillment_node_id
      WHERE h.publication_target_id=t.id AND (n.id IS NULL OR n.lifecycle_status<>'active' OR (c.provider='walmart' AND n.warehouse_id IS DISTINCT FROM w.warehouse_id)))
    AND c.status='active'
    AND (c.provider<>'walmart' OR (w.connection_id=t.channel_connection_id AND w.ship_node_id=t.external_scope_id AND t.provider_scope_type='location'))) IS TRUE AS source_ready
    FROM inventory.inventory_publication_targets t JOIN channels.channels c ON c.id=t.channel_id
    LEFT JOIN channels.walmart_connections w ON w.channel_id=t.channel_id
    WHERE ($1::integer IS NULL OR t.channel_id=$1) AND ($2::integer IS NULL OR t.channel_connection_id=$2)
      AND ($3::integer IS NULL OR t.id=$3) ORDER BY t.id ${lock ? "FOR UPDATE OF t" : ""}`,
    [channelId ?? null, connectionId ?? null, targetId ?? null],
  );
  return result.rows.map((value) => targetSchema.parse(value));
}

async function readVariants(
  client: PoolClient,
  target: Target,
  variantIds: number[],
): Promise<Variant[]> {
  if (!variantIds.length) return [];
  const result = await client.query(
    `SELECT v.id,v.product_id,
    (p.is_active AND p.status='active' AND v.is_active AND v.requires_shipping AND v.track_inventory IS TRUE AND v.sales_eligibility='sellable') IS TRUE AS eligible,
    COALESCE(member.included,false) AS included,m.id AS mapping_id,m.definition_hash AS mapping_hash,m.external_inventory_item_id,m.external_sku,h.held_at,
    (m.id IS NOT NULL AND EXISTS (SELECT 1 FROM channels.channel_feeds f WHERE f.channel_id=$3 AND f.product_variant_id=v.id
      AND f.is_active=1 AND f.quarantined_at IS NULL AND f.channel_inventory_item_id=m.external_inventory_item_id
      AND f.channel_sku IS NOT DISTINCT FROM m.external_sku)) AS mapping_ready,
    EXISTS (SELECT 1 FROM inventory.inventory_publication_outbox o JOIN inventory.inventory_publication_readbacks r ON r.outbox_id=o.id
      WHERE o.publication_target_id=$1 AND o.product_variant_id=v.id AND o.state='verified' AND o.desired_quantity=0
      AND o.publication_target_revision_snapshot=$4::bigint AND o.external_inventory_item_id_snapshot=m.external_inventory_item_id
      AND r.matches_desired=true AND r.observed_quantity=0 AND r.publication_target_revision_snapshot=$4::bigint
      AND r.external_inventory_item_id_snapshot=m.external_inventory_item_id
      AND r.observed_at>=COALESCE($5::timestamptz,h.held_at)
      AND NOT EXISTS (SELECT 1 FROM inventory.inventory_publication_outbox newer WHERE newer.publication_target_id=o.publication_target_id
        AND newer.product_variant_id=o.product_variant_id AND newer.desired_revision>o.desired_revision)) AS zero_verified
    FROM catalog.product_variants v JOIN catalog.products p ON p.id=v.product_id
    LEFT JOIN inventory.publication_membership_heads mh ON mh.publication_target_id=$1 AND mh.product_variant_id=v.id
    LEFT JOIN inventory.publication_membership_versions member ON member.id=mh.active_version_id
    LEFT JOIN inventory.publication_variant_mapping_heads mhead ON mhead.publication_target_id=$1 AND mhead.product_variant_id=v.id
    LEFT JOIN inventory.publication_variant_mapping_versions m ON m.id=mhead.active_mapping_id AND m.lifecycle_status='sealed'
    LEFT JOIN inventory.inventory_publication_target_variant_holds h ON h.publication_target_id=$1 AND h.product_variant_id=v.id
    WHERE v.id=ANY($2::integer[]) ORDER BY v.id`,
    [target.id, variantIds, target.channel_id, target.revision, target.held_at],
  );
  return result.rows.map((value) => variantSchema.parse(value));
}
