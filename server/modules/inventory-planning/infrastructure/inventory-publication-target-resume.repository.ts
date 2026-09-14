import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";

import {
  inventoryPublicationTargetResumeResultSchema,
  inventoryPublicationTargetResumeReviewSchema,
  type InventoryPublicationTargetResumeBlocker,
  type InventoryPublicationTargetResumeResult,
  type InventoryPublicationTargetResumeReview,
} from "@shared/types/inventory-publication-target-resume";
import type { InventoryChannelExposureRuntimePlan } from "@shared/types/inventory-channel-exposure";
import { canonicalJson } from "@shared/utils/canonical-json";

import { pool as defaultPool } from "../../../db";
import type {
  InventoryPublicationTargetResumeStore,
  ResumeInventoryPublicationTargetCommand,
  ReviewInventoryPublicationTargetResumeCommand,
} from "../application/inventory-publication-target-resume.service";
import { planInventoryChannelExposureProduct } from "../application/inventory-channel-exposure-runtime.service";
import { InventoryAvailabilityMasterDataError } from "../domain/inventory-availability-master-data.contracts";
import {
  quantityPublicationScopeSchema,
  type QuantityPublicationScope,
} from "../domain/quantity-publication-admission";
import { captureActiveSupplySnapshotInsideTransaction } from "./inventory-availability-shadow.repository";
import { loadAndLockRuntimeAuthority } from "./inventory-availability-runtime-atp.repository";
import { createTransactionScopedInventoryPublicationService } from "./inventory-availability-runtime-publication.repository";
import {
  loadActivePublicationTargets,
  loadManagedSellableVariantIds,
  loadPreviewPublicationTargetForResume,
} from "./inventory-channel-exposure-runtime.repository";
import { quantityPublicationScopeLockKey } from "./quantity-publication-admission.repository";

const IDEMPOTENCY_LOCK_NAMESPACE = 918421;
const SCOPE_LOCK_SEED = 918420;
const RECEIPT_PREFIX = "inventory-publication-target-resume:";
const MAX_PROVIDER_READBACK_AGE_MS = 15 * 60 * 1000;

type TargetRow = {
  id: number;
  state: string;
  revision: string;
  destination_kind: string;
  channel_id: number;
  channel_connection_id: number | null;
  dropship_store_connection_id: number | null;
  provider_key: string | null;
  provider_scope_type: string;
  external_scope_id: string;
  publication_authority: string;
};

type ReadbackRow = {
  product_variant_id: number;
  observed_quantity: string;
  observed_at: Date;
  evidence_hash: string;
  external_inventory_item_id_snapshot: string | null;
  destination_kind_snapshot: string | null;
  channel_connection_id_snapshot: number | null;
  dropship_store_connection_id_snapshot: number | null;
  provider_scope_type_snapshot: string | null;
  external_scope_id_snapshot: string | null;
  publication_target_revision_snapshot: string | null;
};

type TargetIdentityCensusRow = {
  product_variant_id: unknown;
  product_id: unknown;
  external_inventory_item_id: unknown;
  evidence_sources: unknown;
  covered_by_current_mapping: unknown;
};

type ResumeEvidence = Omit<
  InventoryPublicationTargetResumeReview,
  "resumeReviewId" | "evidenceHash" | "alreadyApplied"
>;
type ResumeEvidenceWithoutReadinessHash = Omit<ResumeEvidence, "readinessHash">;

export interface InventoryPublicationTargetResumeReadinessMaterial {
  publicationTargetId: number;
  publicationTargetRevision: string;
  authorityRevision: string;
  activationRunId: string;
  configurationHash: string;
  identityCensus: Array<{
    productId: number | null;
    productVariantId: number;
    externalInventoryItemId: string;
    evidenceSources: string[];
    coveredByCurrentMapping: boolean;
  }>;
  products: Array<{
    productId: number;
    snapshotFingerprint: string;
    desiredRows: Array<{
      productVariantId: number;
      externalInventoryItemId: string | null;
      publishedUnits: string;
    }>;
    readbacks: Array<{
      productVariantId: number;
      externalInventoryItemId: string;
      observedQuantity: string;
      observedAt: string;
      evidenceHash: string;
    }>;
  }>;
}

export function inventoryPublicationTargetResumeReadinessHash(
  material: InventoryPublicationTargetResumeReadinessMaterial,
): string {
  return hash(material);
}

export class PostgresInventoryPublicationTargetResumeStore
implements InventoryPublicationTargetResumeStore {
  constructor(private readonly connectionPool: Pick<Pool, "connect"> = defaultPool) {}

  async review(
    command: ReviewInventoryPublicationTargetResumeCommand,
  ): Promise<InventoryPublicationTargetResumeReview> {
    return inSerializableTransaction(this.connectionPool, async (client) => {
      await lockIdempotency(client, `review:${command.idempotencyKey}`);
      const replay = await loadReviewReplay(client, command.idempotencyKey, command.requestHash);
      if (replay) return replay;

      const authority = await requireCanonicalAuthority(client);
      const target = await loadTargetForUpdate(client, command.publicationTargetId, false);
      assertPreviewTarget(target, command.expectedRevision);
      await assertPreviouslyStopped(client, target.id);
      const captured = await captureResumeEvidence(client, target, authority, command);
      const evidenceHash = hash(captured);
      const inserted = (await client.query<{ id: string }>(
        `INSERT INTO inventory.inventory_publication_target_resume_reviews (
           publication_target_id, publication_target_revision, authority_revision,
           activation_run_id, state, configuration_hash, readiness_hash, evidence_hash,
           evidence_payload, idempotency_key, request_hash, requested_by,
           reason, captured_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,$14)
         RETURNING id::text`,
        [
          target.id,
          target.revision,
          authority.authorityRevision,
          authority.activationRunId,
           captured.state,
           captured.configurationHash,
           captured.readinessHash,
           evidenceHash,
          JSON.stringify(captured),
          command.idempotencyKey,
          command.requestHash,
          command.actorId,
          command.reason,
          command.occurredAt,
        ],
      )).rows[0];
      if (!inserted) {
        throw resumeError(
          500,
          "INVENTORY_PUBLICATION_TARGET_RESUME_REVIEW_INSERT_FAILED",
          "The target resume review was not durably recorded.",
        );
      }
      return inventoryPublicationTargetResumeReviewSchema.parse({
        ...captured,
        resumeReviewId: inserted.id,
        evidenceHash,
        alreadyApplied: false,
      });
    });
  }

  async resume(
    command: ResumeInventoryPublicationTargetCommand,
  ): Promise<InventoryPublicationTargetResumeResult> {
    const client = await this.connectionPool.connect();
    const scopeKeys: string[] = [];
    let began = false;
    let result: InventoryPublicationTargetResumeResult | undefined;
    let workError: unknown;
    let discard: Error | undefined;
    try {
      await client.query("BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE");
      began = true;
      await client.query("SET LOCAL lock_timeout = '5s'");
      await client.query("SET LOCAL statement_timeout = '60s'");
      await lockIdempotency(client, `resume:${command.idempotencyKey}`);
      const receiptKey = `${RECEIPT_PREFIX}${command.idempotencyKey}`;
      const replay = await loadResumeReplay(client, receiptKey, command.requestHash);
      if (replay) {
        result = replay;
        await client.query("COMMIT");
        began = false;
      } else {
        const authority = await requireCanonicalAuthority(client);
        const target = await loadTargetForUpdate(client, command.publicationTargetId, true);
        assertPreviewTarget(target, command.expectedRevision);
        await assertPreviouslyStopped(client, target.id);
        const review = await loadResumeReview(client, command.resumeReviewId);
        assertRequestedReview(review, command, authority);

        const current = await captureResumeEvidence(client, target, authority, command);
        if (current.state !== "ready" || current.blockers.length > 0) {
          throw resumeError(
            409,
            "INVENTORY_PUBLICATION_TARGET_RESUME_NO_LONGER_READY",
            "The exact target is no longer ready to resume. Capture and review fresh evidence.",
            current.blockers.map((blocker) => blocker.code),
          );
        }
        if (current.readinessHash !== review.readinessHash) {
          throw resumeError(
            409,
            "INVENTORY_PUBLICATION_TARGET_RESUME_EVIDENCE_CHANGED",
            "Canonical supply, desired quantities, readback evidence, or target configuration changed after readiness review.",
          );
        }

        const scopes = await loadTargetScopes(client, target);
        for (const scope of scopes.sort((left, right) =>
          quantityPublicationScopeLockKey(left).localeCompare(quantityPublicationScopeLockKey(right)))) {
          const scopeKey = quantityPublicationScopeLockKey(scope);
          const acquired = (await client.query<{ acquired: boolean }>(
            "SELECT pg_try_advisory_lock(hashtextextended($1,$2)) AS acquired",
            [scopeKey, SCOPE_LOCK_SEED],
          )).rows[0]?.acquired === true;
          if (!acquired) {
            throw resumeError(
              409,
              "INVENTORY_PUBLICATION_TARGET_BUSY",
              "A provider quantity request is in flight for this target. Retry after it finishes; the target was not changed.",
            );
          }
          scopeKeys.push(scopeKey);
        }

        await client.query(
          `INSERT INTO public.idempotency_keys(
             key, request_hash, response_body, created_at, expires_at
           ) VALUES ($1,$2,NULL,$3,NULL)`,
          [receiptKey, command.requestHash, command.occurredAt],
        );
        const updated = (await client.query<{ revision: string }>(
          `UPDATE inventory.inventory_publication_targets
           SET state='live', activated_by=$3, activated_at=$4,
               revision=revision+1, updated_at=$4
           WHERE id=$1 AND revision=$2::bigint AND state='preview'
             AND publication_authority='echelon'
           RETURNING revision::text`,
          [target.id, command.expectedRevision, command.actorId, command.occurredAt],
        )).rows[0];
        if (!updated) {
          throw resumeError(
            409,
            "INVENTORY_PUBLICATION_TARGET_RESUME_CONCURRENT_CHANGE",
            "A concurrent target change prevented resume. Reload and retry.",
          );
        }

        const publisher = createTransactionScopedInventoryPublicationService(client, {
          channelId: target.channel_id,
        });
        let publicationRows = 0;
        const expectedRows = new Set(current.products.flatMap((product) =>
          product.target.rows.map((row) => `${product.productId}:${row.productVariantId}`)));
        const actualRows = new Set<string>();
        for (const product of current.products.slice().sort((left, right) => left.productId - right.productId)) {
          const routed = await publisher.publishProduct({
            productId: product.productId,
            publicationTargetId: target.id,
            channelId: target.channel_id,
            dryRun: false,
            triggeredBy: "publication_target_resume",
          }, async () => {
            throw resumeError(
              500,
              "INVENTORY_PUBLICATION_TARGET_RESUME_LEGACY_FALLBACK",
              "A target resume cannot fall back to legacy inventory publication.",
            );
          });
          if (routed.authority !== "canonical") {
            throw resumeError(
              500,
              "INVENTORY_PUBLICATION_TARGET_RESUME_AUTHORITY_CHANGED",
              "Canonical publication authority changed while the target was resuming.",
            );
          }
          if (routed.publication.rows.some((row) => row.blockerCodes.length > 0)) {
            throw resumeError(
              409,
              "INVENTORY_PUBLICATION_TARGET_RESUME_PUBLICATION_BLOCKED",
              "The current canonical planner blocked the target's initial resumed publication.",
            );
          }
          if (routed.publication.enqueuedRows !== routed.publication.rows.length
            || routed.publication.coalescedRows !== 0) {
            throw resumeError(
              500,
              "INVENTORY_PUBLICATION_TARGET_RESUME_OUTBOX_INCOMPLETE",
              "The initial resumed target snapshot was not durably enqueued exactly once.",
            );
          }
          for (const row of routed.publication.rows) {
            actualRows.add(`${product.productId}:${row.productVariantId}`);
          }
          publicationRows += routed.publication.enqueuedRows;
        }
        if (publicationRows <= 0 || canonicalJson([...actualRows].sort()) !== canonicalJson([...expectedRows].sort())) {
          throw resumeError(
            500,
            "INVENTORY_PUBLICATION_TARGET_RESUME_COVERAGE_CHANGED",
            "The current planner did not persist the complete reviewed target/SKU set.",
          );
        }

        result = inventoryPublicationTargetResumeResultSchema.parse({
          publicationTargetId: target.id,
          revision: updated.revision,
          state: "live",
          activationRunId: authority.activationRunId,
          authorityRevision: authority.authorityRevision,
          resumeReviewId: review.resumeReviewId,
          evidenceHash: review.evidenceHash,
          publicationRows,
          alreadyApplied: false,
          runtimeAuthorityChanged: false,
          providerWriteAttempted: false,
          outboxEnqueued: true,
        });
        await client.query(
          `INSERT INTO public.audit_events(
             timestamp, level, actor, action, target, changes, context
           ) VALUES ($1,'AUDIT',$2,$3,$4,$5::jsonb,$6::jsonb)`,
          [
            command.occurredAt,
            command.actorId,
            "inventory_availability.publication_target.resumed",
            `inventory.inventory_publication_target:${target.id}`,
            JSON.stringify({
              before: { state: "preview", revision: command.expectedRevision },
              after: { state: "live", revision: result.revision },
            }),
            JSON.stringify({
              reason: command.reason,
              idempotencyKey: command.idempotencyKey,
              requestHash: command.requestHash,
              resumeReviewId: review.resumeReviewId,
              evidenceHash: review.evidenceHash,
              publicationRows,
            }),
          ],
        );
        await client.query(
          `UPDATE public.idempotency_keys SET response_body=$2::jsonb WHERE key=$1`,
          [receiptKey, JSON.stringify({ commandType: "inventory_publication_target_resume", result })],
        );
        await client.query("COMMIT");
        began = false;
      }
    } catch (error) {
      workError = error;
      if (began) {
        try {
          await client.query("ROLLBACK");
          began = false;
        } catch (rollbackError) {
          discard = rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError));
        }
      }
    } finally {
      for (const scopeKey of scopeKeys.reverse()) {
        try {
          const released = (await client.query<{ released: boolean }>(
            "SELECT pg_advisory_unlock(hashtextextended($1,$2)) AS released",
            [scopeKey, SCOPE_LOCK_SEED],
          )).rows[0]?.released;
          if (!released) discard = new Error("Publication target scope-lock release was not confirmed.");
        } catch (error) {
          discard = error instanceof Error ? error : new Error(String(error));
        }
      }
      client.release(discard);
    }
    if (workError) throw workError;
    if (discard) {
      throw resumeError(
        503,
        "INVENTORY_PUBLICATION_TARGET_RESUME_CLEANUP_UNCERTAIN",
        "The resume outcome may have committed, but connection cleanup was uncertain. Retry the same idempotency key.",
      );
    }
    if (!result) {
      throw resumeError(
        500,
        "INVENTORY_PUBLICATION_TARGET_RESUME_RESULT_MISSING",
        "The target resume transaction returned no result.",
      );
    }
    return result;
  }
}

async function captureResumeEvidence(
  client: PoolClient,
  target: TargetRow,
  authority: { authorityRevision: string; activationRunId: string },
  command: { actorId: string; reason: string; occurredAt: Date },
): Promise<ResumeEvidence> {
  const identityCensus = await loadTargetIdentityCensus(client, target.id);
  const productIds = [...new Set(identityCensus
    .filter((identity) => identity.coveredByCurrentMapping && identity.productId !== null)
    .map((identity) => identity.productId!))].sort((left, right) => left - right);
  const blockers: InventoryPublicationTargetResumeBlocker[] = [];
  if (identityCensus.length === 0) {
    blockers.push(blocker(
      "INVENTORY_PUBLICATION_TARGET_RESUME_MAPPING_MISSING",
      "The stopped target has no current or historical target/SKU inventory identity to resume.",
      { publicationTargetId: target.id },
    ));
  }
  for (const identity of identityCensus) {
    if (identity.productId === null) {
      blockers.push(blocker(
        "INVENTORY_PUBLICATION_TARGET_RESUME_IDENTITY_PRODUCT_MISSING",
        "A current or historical provider inventory identity no longer resolves to a catalog product.",
        {
          publicationTargetId: target.id,
          productVariantId: identity.productVariantId,
          externalInventoryItemId: identity.externalInventoryItemId,
          evidenceSources: identity.evidenceSources,
        },
      ));
    }
    if (!identity.coveredByCurrentMapping) {
      blockers.push(blocker(
        "INVENTORY_PUBLICATION_TARGET_RESUME_HISTORICAL_IDENTITY_UNCOVERED",
        "A provider inventory identity previously owned by this target is not covered by the current exact mapping and cannot be omitted from an absolute resume snapshot.",
        {
          publicationTargetId: target.id,
          productId: identity.productId,
          productVariantId: identity.productVariantId,
          externalInventoryItemId: identity.externalInventoryItemId,
          evidenceSources: identity.evidenceSources,
        },
      ));
    }
  }
  const products: InventoryPublicationTargetResumeReview["products"] = [];
  for (const productId of productIds) {
    const supplySnapshot = await captureActiveSupplySnapshotInsideTransaction(client, productId);
    const managedSellableVariantIds = await loadManagedSellableVariantIds(client, productId);
    const liveTargets = await loadActivePublicationTargets(
      client,
      productId,
      managedSellableVariantIds,
      target.channel_id,
    );
    const previewTargets = await loadPreviewPublicationTargetForResume(
      client,
      productId,
      managedSellableVariantIds,
      target.id,
    );
    if (previewTargets.length !== 1) {
      blockers.push(blocker(
        "INVENTORY_PUBLICATION_TARGET_RESUME_ACTIVE_CONFIGURATION_MISSING",
        "The preview target's prior sealed publication configuration could not be resolved.",
        { publicationTargetId: target.id, productId },
      ));
      continue;
    }
    const plan = planInventoryChannelExposureProduct({
      authority: "canonical",
      authorityRevision: authority.authorityRevision,
      activationRunId: authority.activationRunId,
      supplySnapshot,
      managedSellableVariantIds,
      publicationTargets: [
        ...liveTargets.filter((candidate) => candidate.publicationTargetId !== target.id),
        previewTargets[0]!,
      ],
    }, productId);
    const targetPlan = plan.targets.find((candidate) => candidate.publicationTargetId === target.id);
    if (!targetPlan) {
      blockers.push(blocker(
        "INVENTORY_PUBLICATION_TARGET_RESUME_PLAN_MISSING",
        "The canonical planner did not return the exact preview target.",
        { publicationTargetId: target.id, productId },
      ));
      continue;
    }
    const plannedIdentityKeys = new Set(targetPlan.rows
      .filter((row) => row.mapping !== null)
      .map((row) => `${row.productVariantId}:${row.mapping!.externalInventoryItemId}`));
    for (const identity of identityCensus.filter((candidate) =>
      candidate.productId === productId && candidate.coveredByCurrentMapping)) {
      const identityKey = `${identity.productVariantId}:${identity.externalInventoryItemId}`;
      if (!plannedIdentityKeys.has(identityKey)) {
        blockers.push(blocker(
          "INVENTORY_PUBLICATION_TARGET_RESUME_CURRENT_IDENTITY_NOT_PLANNED",
          "A current exact target/SKU identity is not covered by the canonical full-target plan.",
          {
            publicationTargetId: target.id,
            productId,
            productVariantId: identity.productVariantId,
            externalInventoryItemId: identity.externalInventoryItemId,
          },
        ));
      }
    }
    for (const issue of [
      ...targetPlan.blockers,
      ...targetPlan.rows.flatMap((row) => row.blockers),
    ]) {
      blockers.push(blocker(issue.code, issue.message, { ...issue.context, productId }));
    }
    for (const row of targetPlan.rows) {
      if (BigInt(row.publishedUnits) > BigInt(Number.MAX_SAFE_INTEGER)) {
        blockers.push(blocker(
          "INVENTORY_PUBLICATION_TARGET_RESUME_QUANTITY_OUT_OF_RANGE",
          "A desired provider quantity exceeds the supported safe-integer range.",
          { publicationTargetId: target.id, productId, productVariantId: row.productVariantId },
        ));
      }
    }
    const readback = await loadCurrentReadbacks(client, target, targetPlan, command.occurredAt);
    blockers.push(...readback.blockers.map((entry) => ({
      ...entry,
      context: { ...entry.context, productId },
    })));
    products.push({
      productId,
      snapshotFingerprint: plan.snapshotFingerprint!,
      target: targetPlan,
      readbacks: readback.readbacks,
    });
  }
  const uniqueBlockers = dedupeBlockers(blockers);
  const configurationHash = hash(configurationEvidence(target, products));
  const evidenceWithoutReadinessHash: ResumeEvidenceWithoutReadinessHash = {
    publicationTargetId: target.id,
    publicationTargetRevision: target.revision,
    authorityRevision: authority.authorityRevision,
    activationRunId: authority.activationRunId,
    state: uniqueBlockers.length === 0
      && products.length > 0
      && products.every((product) => product.target.publishable)
      ? "ready"
      : "blocked",
    configurationHash,
    requestedBy: command.actorId,
    reason: command.reason,
    capturedAt: command.occurredAt.toISOString(),
    identityCensus,
    products,
    blockers: uniqueBlockers,
    runtimeAuthorityChanged: false,
    providerWriteAttempted: false,
    outboxEnqueued: false,
  };
  return {
    ...evidenceWithoutReadinessHash,
    readinessHash: inventoryPublicationTargetResumeReadinessHash(
      readinessEvidence(evidenceWithoutReadinessHash),
    ),
  };
}

async function loadTargetIdentityCensus(
  client: PoolClient,
  publicationTargetId: number,
): Promise<InventoryPublicationTargetResumeReview["identityCensus"]> {
  const rows = (await client.query<TargetIdentityCensusRow>(
    `WITH identity_evidence AS (
       SELECT head.product_variant_id,
              mapping.external_inventory_item_id,
              'active_mapping'::text AS evidence_source
       FROM inventory.publication_variant_mapping_heads AS head
       JOIN inventory.publication_variant_mapping_versions AS mapping
         ON mapping.id=head.active_mapping_id AND mapping.lifecycle_status='sealed'
       WHERE head.publication_target_id=$1
       UNION ALL
       SELECT outbox.product_variant_id,
              outbox.external_inventory_item_id_snapshot,
              'outbox'::text AS evidence_source
       FROM inventory.inventory_publication_outbox AS outbox
       WHERE outbox.publication_target_id=$1
       UNION ALL
       SELECT readback.product_variant_id,
              COALESCE(readback.external_inventory_item_id_snapshot,
                       outbox.external_inventory_item_id_snapshot),
              'readback'::text AS evidence_source
       FROM inventory.inventory_publication_readbacks AS readback
       LEFT JOIN inventory.inventory_publication_outbox AS outbox ON outbox.id=readback.outbox_id
       WHERE readback.publication_target_id=$1
         AND COALESCE(readback.external_inventory_item_id_snapshot,
                      outbox.external_inventory_item_id_snapshot) IS NOT NULL
     )
     SELECT evidence.product_variant_id,
            variant.product_id,
            evidence.external_inventory_item_id,
            array_agg(DISTINCT evidence.evidence_source ORDER BY evidence.evidence_source) AS evidence_sources,
            bool_or(evidence.evidence_source='active_mapping') AS covered_by_current_mapping
     FROM identity_evidence AS evidence
     LEFT JOIN catalog.product_variants AS variant ON variant.id=evidence.product_variant_id
     GROUP BY evidence.product_variant_id, variant.product_id, evidence.external_inventory_item_id
     ORDER BY variant.product_id NULLS LAST, evidence.product_variant_id, evidence.external_inventory_item_id`,
    [publicationTargetId],
  )).rows;
  return rows.map((row) => {
    const rawSources = Array.isArray(row.evidence_sources) ? row.evidence_sources : [];
    const evidenceSources = rawSources.map((source) => {
      if (source !== "active_mapping" && source !== "outbox" && source !== "readback") {
        throw resumeError(
          500,
          "INVENTORY_PUBLICATION_TARGET_RESUME_DATABASE_INVALID",
          "A target identity census contains an invalid evidence source.",
        );
      }
      return source;
    });
    if (evidenceSources.length === 0 || typeof row.covered_by_current_mapping !== "boolean") {
      throw resumeError(
        500,
        "INVENTORY_PUBLICATION_TARGET_RESUME_DATABASE_INVALID",
        "A target identity census row is incomplete.",
      );
    }
    return {
      productVariantId: positiveInteger(row.product_variant_id, "identityCensus.productVariantId"),
      productId: row.product_id == null
        ? null
        : positiveInteger(row.product_id, "identityCensus.productId"),
      externalInventoryItemId: nonblank(
        row.external_inventory_item_id,
        "identityCensus.externalInventoryItemId",
        240,
      ),
      evidenceSources,
      coveredByCurrentMapping: row.covered_by_current_mapping,
    };
  });
}

async function loadCurrentReadbacks(
  client: PoolClient,
  target: TargetRow,
  targetPlan: InventoryChannelExposureRuntimePlan["targets"][number],
  capturedAt: Date,
): Promise<{
  readbacks: InventoryPublicationTargetResumeReview["products"][number]["readbacks"];
  blockers: InventoryPublicationTargetResumeBlocker[];
}> {
  const variantIds = targetPlan.rows.map((row) => row.productVariantId);
  if (variantIds.length === 0) return { readbacks: [], blockers: [] };
  const rows = (await client.query<ReadbackRow>(
    `SELECT DISTINCT ON (readback.product_variant_id)
            readback.product_variant_id, readback.observed_quantity::text,
            readback.observed_at, readback.evidence_hash,
            COALESCE(readback.external_inventory_item_id_snapshot,
                     outbox.external_inventory_item_id_snapshot) AS external_inventory_item_id_snapshot,
            COALESCE(readback.destination_kind_snapshot,
                     outbox.destination_kind_snapshot) AS destination_kind_snapshot,
            COALESCE(readback.channel_connection_id_snapshot,
                     outbox.channel_connection_id_snapshot) AS channel_connection_id_snapshot,
            COALESCE(readback.dropship_store_connection_id_snapshot,
                     outbox.dropship_store_connection_id_snapshot) AS dropship_store_connection_id_snapshot,
            COALESCE(readback.provider_scope_type_snapshot,
                     outbox.provider_scope_type_snapshot) AS provider_scope_type_snapshot,
            COALESCE(readback.external_scope_id_snapshot,
                     outbox.external_scope_id_snapshot) AS external_scope_id_snapshot,
            COALESCE(readback.publication_target_revision_snapshot,
                     outbox.publication_target_revision_snapshot)::text AS publication_target_revision_snapshot
     FROM inventory.inventory_publication_readbacks AS readback
     LEFT JOIN inventory.inventory_publication_outbox AS outbox ON outbox.id=readback.outbox_id
     WHERE readback.publication_target_id=$1
       AND readback.product_variant_id=ANY($2::integer[])
     ORDER BY readback.product_variant_id, readback.observed_at DESC, readback.id DESC`,
    [target.id, variantIds],
  )).rows;
  const byVariant = new Map(rows.map((row) => [Number(row.product_variant_id), row]));
  const readbacks: InventoryPublicationTargetResumeReview["products"][number]["readbacks"] = [];
  const blockers: InventoryPublicationTargetResumeBlocker[] = [];
  for (const planned of targetPlan.rows) {
    const observed = byVariant.get(planned.productVariantId);
    const mapping = planned.mapping;
    if (!observed || !mapping) {
      blockers.push(blocker(
        "INVENTORY_PUBLICATION_TARGET_RESUME_READBACK_MISSING",
        "No provider readback exists for the exact target/SKU identity.",
        { publicationTargetId: target.id, productVariantId: planned.productVariantId },
      ));
      continue;
    }
    const identityMatches = observed.external_inventory_item_id_snapshot === mapping.externalInventoryItemId
      && observed.destination_kind_snapshot === target.destination_kind
      && nullableNumber(observed.channel_connection_id_snapshot) === target.channel_connection_id
      && nullableNumber(observed.dropship_store_connection_id_snapshot) === target.dropship_store_connection_id
      && observed.provider_scope_type_snapshot === target.provider_scope_type
      && observed.external_scope_id_snapshot === target.external_scope_id
      && observed.publication_target_revision_snapshot === target.revision;
    if (!identityMatches) {
      blockers.push(blocker(
        "INVENTORY_PUBLICATION_TARGET_RESUME_READBACK_IDENTITY_CHANGED",
        "The latest provider readback does not belong to the reviewed exact target/SKU identity.",
        { publicationTargetId: target.id, productVariantId: planned.productVariantId },
      ));
      continue;
    }
    const observedAt = observed.observed_at instanceof Date
      ? observed.observed_at
      : new Date(observed.observed_at);
    if (!Number.isFinite(observedAt.getTime())
      || observedAt.getTime() > capturedAt.getTime()
      || capturedAt.getTime() - observedAt.getTime() > MAX_PROVIDER_READBACK_AGE_MS) {
      blockers.push(blocker(
        "INVENTORY_PUBLICATION_TARGET_RESUME_READBACK_STALE",
        "The exact provider readback is missing, future-dated, or older than the readiness window.",
        {
          publicationTargetId: target.id,
          productVariantId: planned.productVariantId,
          observedAt: Number.isFinite(observedAt.getTime()) ? observedAt.toISOString() : null,
          maxAgeMilliseconds: MAX_PROVIDER_READBACK_AGE_MS,
        },
      ));
      continue;
    }
    readbacks.push({
      productVariantId: planned.productVariantId,
      externalInventoryItemId: mapping.externalInventoryItemId,
      observedQuantity: nonnegativeBigintString(observed.observed_quantity, "readback.observedQuantity"),
      observedAt: observedAt.toISOString(),
      evidenceHash: sha256(observed.evidence_hash, "readback.evidenceHash"),
    });
  }
  return { readbacks, blockers };
}

function configurationEvidence(
  target: TargetRow,
  products: InventoryPublicationTargetResumeReview["products"],
): Record<string, unknown> {
  return {
    publicationTarget: {
      id: target.id,
      revision: target.revision,
      destinationKind: target.destination_kind,
      channelId: target.channel_id,
      channelConnectionId: target.channel_connection_id,
      dropshipStoreConnectionId: target.dropship_store_connection_id,
      providerKey: target.provider_key,
      providerScopeType: target.provider_scope_type,
      externalScopeId: target.external_scope_id,
      publicationAuthority: target.publication_authority,
    },
    products: products.slice().sort((left, right) => left.productId - right.productId).map((product) => ({
      productId: product.productId,
      sourceBinding: product.target.sourceBinding,
      selectedPolicies: product.target.selectedPolicies,
      rows: product.target.rows.map((row) => ({
        productVariantId: row.productVariantId,
        sku: row.sku,
        unitsPerVariant: row.unitsPerVariant,
        sourceWarehouseIds: row.sourceWarehouseBreakdown.map((entry) => entry.warehouseId),
        policy: row.policy,
        mapping: row.mapping,
      })),
    })),
  };
}

function readinessEvidence(
  evidence: ResumeEvidenceWithoutReadinessHash,
): InventoryPublicationTargetResumeReadinessMaterial {
  return {
    publicationTargetId: evidence.publicationTargetId,
    publicationTargetRevision: evidence.publicationTargetRevision,
    authorityRevision: evidence.authorityRevision,
    activationRunId: evidence.activationRunId,
    configurationHash: evidence.configurationHash,
    identityCensus: evidence.identityCensus.map((identity) => ({
      productId: identity.productId,
      productVariantId: identity.productVariantId,
      externalInventoryItemId: identity.externalInventoryItemId,
      evidenceSources: identity.evidenceSources,
      coveredByCurrentMapping: identity.coveredByCurrentMapping,
    })),
    products: evidence.products.map((product) => ({
      productId: product.productId,
      snapshotFingerprint: product.snapshotFingerprint,
      desiredRows: product.target.rows.map((row) => ({
        productVariantId: row.productVariantId,
        externalInventoryItemId: row.mapping?.externalInventoryItemId ?? null,
        publishedUnits: row.publishedUnits,
      })),
      readbacks: product.readbacks.map((readback) => ({
        productVariantId: readback.productVariantId,
        externalInventoryItemId: readback.externalInventoryItemId,
        observedQuantity: readback.observedQuantity,
        observedAt: readback.observedAt,
        evidenceHash: readback.evidenceHash,
      })),
    })),
  };
}

async function requireCanonicalAuthority(client: PoolClient): Promise<{
  authorityRevision: string;
  activationRunId: string;
}> {
  const authority = await loadAndLockRuntimeAuthority(client);
  if (authority.authority !== "canonical" || !authority.activationRunId) {
    throw resumeError(
      409,
      "INVENTORY_PUBLICATION_TARGET_RESUME_CANONICAL_AUTHORITY_REQUIRED",
      "A publication target can resume only after canonical inventory authority is active.",
    );
  }
  const activation = (await client.query<{ state: string }>(
    `SELECT state FROM inventory.availability_activation_runs
     WHERE id=$1 AND mode='activation' FOR SHARE`,
    [authority.activationRunId],
  )).rows[0];
  if (!activation || activation.state !== "active") {
    throw resumeError(
      409,
      "INVENTORY_PUBLICATION_TARGET_RESUME_ACTIVATION_NOT_ACTIVE",
      "The canonical activation owning publication is not active.",
    );
  }
  return {
    authorityRevision: authority.authorityRevision,
    activationRunId: authority.activationRunId,
  };
}

async function loadTargetForUpdate(
  client: PoolClient,
  publicationTargetId: number,
  forUpdate: boolean,
): Promise<TargetRow> {
  const targets = (await client.query<TargetRow>(
    `SELECT target.id, target.state, target.revision::text,
            target.destination_kind, target.channel_id,
            target.channel_connection_id, target.dropship_store_connection_id,
            lower(CASE target.destination_kind
              WHEN 'channel_connection' THEN channel_row.provider
              WHEN 'dropship_store_connection' THEN dropship_connection.platform
            END) AS provider_key,
            target.provider_scope_type, target.external_scope_id,
            target.publication_authority
     FROM inventory.inventory_publication_targets AS target
     JOIN channels.channels AS channel_row ON channel_row.id=target.channel_id
     LEFT JOIN dropship.dropship_store_connections AS dropship_connection
       ON dropship_connection.id=target.dropship_store_connection_id
     WHERE target.id=$1 ${forUpdate ? "FOR UPDATE OF target" : "FOR SHARE OF target"}`,
    [publicationTargetId],
  )).rows;
  if (targets.length !== 1) {
    throw resumeError(
      404,
      "INVENTORY_PUBLICATION_TARGET_NOT_FOUND",
      "The publication target does not exist.",
    );
  }
  return targets[0]!;
}

function assertPreviewTarget(target: TargetRow, expectedRevision: string): void {
  if (target.revision !== expectedRevision) {
    throw resumeError(
      409,
      "INVENTORY_PUBLICATION_TARGET_RESUME_STALE",
      "The publication target changed. Reload it before reviewing or resuming.",
    );
  }
  if (target.state !== "preview") {
    throw resumeError(
      409,
      "INVENTORY_PUBLICATION_TARGET_RESUME_PREVIEW_REQUIRED",
      "A stopped publication target must enter preview before it can resume.",
    );
  }
  if (target.publication_authority !== "echelon") {
    throw resumeError(
      409,
      "INVENTORY_PUBLICATION_TARGET_RESUME_AUTHORITY_INVALID",
      "Only an Echelon-owned publication target can be resumed.",
    );
  }
}

async function assertPreviouslyStopped(client: PoolClient, publicationTargetId: number): Promise<void> {
  const event = (await client.query<{ present: boolean }>(
    `SELECT true AS present
     FROM public.audit_events
     WHERE action='inventory_availability.publication_target.stopped'
       AND target=$1
     ORDER BY id DESC
     LIMIT 1`,
    [`inventory.inventory_publication_target:${publicationTargetId}`],
  )).rows[0];
  if (event?.present === true) return;
  throw resumeError(
    409,
    "INVENTORY_PUBLICATION_TARGET_RESUME_PRIOR_STOP_REQUIRED",
    "This command only resumes a target that was previously live and stopped through the audited target-stop command.",
  );
}

async function loadTargetScopes(client: PoolClient, target: TargetRow): Promise<QuantityPublicationScope[]> {
  const connectionId = target.destination_kind === "channel_connection"
    ? target.channel_connection_id
    : target.dropship_store_connection_id;
  if (!connectionId || !target.provider_key) {
    throw resumeError(
      409,
      "INVENTORY_PUBLICATION_TARGET_IDENTITY_INVALID",
      "The publication target has an incomplete destination identity.",
    );
  }
  const items = (await client.query<{ external_inventory_item_id: string }>(
    `SELECT mapping.external_inventory_item_id
     FROM inventory.publication_variant_mapping_heads AS head
     JOIN inventory.publication_variant_mapping_versions AS mapping
       ON mapping.id=head.active_mapping_id
     WHERE head.publication_target_id=$1
     UNION
     SELECT outbox.external_inventory_item_id_snapshot
     FROM inventory.inventory_publication_outbox AS outbox
     WHERE outbox.publication_target_id=$1
       AND outbox.state IN ('desired','queued','leased','retryable','drifted','acknowledged')
     ORDER BY 1`,
    [target.id],
  )).rows;
  const scopes = items.map((item) => quantityPublicationScopeSchema.parse({
    destinationKind: target.destination_kind,
    connectionId,
    providerKey: target.provider_key,
    providerScopeType: target.provider_scope_type,
    externalScopeId: target.external_scope_id,
    externalInventoryItemId: item.external_inventory_item_id,
    productId: null,
    productVariantId: null,
  }));
  return [...new Map(scopes.map((scope) => [quantityPublicationScopeLockKey(scope), scope])).values()];
}

async function loadReviewReplay(
  client: PoolClient,
  idempotencyKey: string,
  requestHash: string,
): Promise<InventoryPublicationTargetResumeReview | null> {
  const row = (await client.query<Record<string, unknown>>(
    `SELECT * FROM inventory.inventory_publication_target_resume_reviews
     WHERE idempotency_key=$1`,
    [idempotencyKey],
  )).rows[0];
  if (!row) return null;
  if (String(row.request_hash) !== requestHash) {
    throw resumeError(
      409,
      "INVENTORY_PUBLICATION_TARGET_RESUME_REVIEW_IDEMPOTENCY_CONFLICT",
      "The resume-review idempotency key was already used with different inputs.",
    );
  }
  return reviewFromRow(row, true);
}

async function loadResumeReview(
  client: PoolClient,
  resumeReviewId: string,
): Promise<InventoryPublicationTargetResumeReview> {
  const row = (await client.query<Record<string, unknown>>(
    `SELECT * FROM inventory.inventory_publication_target_resume_reviews
     WHERE id=$1 FOR SHARE`,
    [resumeReviewId],
  )).rows[0];
  if (!row) {
    throw resumeError(
      404,
      "INVENTORY_PUBLICATION_TARGET_RESUME_REVIEW_NOT_FOUND",
      "The target resume readiness review does not exist.",
    );
  }
  return reviewFromRow(row, false);
}

function reviewFromRow(
  row: Record<string, unknown>,
  alreadyApplied: boolean,
): InventoryPublicationTargetResumeReview {
  const payload = row.evidence_payload as Record<string, unknown> | null;
  if (!payload || hash(payload) !== String(row.evidence_hash)) {
    throw resumeError(
      500,
      "INVENTORY_PUBLICATION_TARGET_RESUME_REVIEW_EVIDENCE_INVALID",
      "Persisted target resume evidence is missing or does not match its immutable hash.",
    );
  }
  const parsed = inventoryPublicationTargetResumeReviewSchema.parse({
    ...payload,
    resumeReviewId: String(row.id),
    evidenceHash: String(row.evidence_hash),
    alreadyApplied,
  });
  const capturedAt = row.captured_at instanceof Date
    ? row.captured_at.toISOString()
    : new Date(String(row.captured_at)).toISOString();
  const columnsMatch = parsed.publicationTargetId === Number(row.publication_target_id)
    && parsed.publicationTargetRevision === String(row.publication_target_revision)
    && parsed.authorityRevision === String(row.authority_revision)
    && parsed.activationRunId === String(row.activation_run_id)
    && parsed.state === String(row.state)
    && parsed.configurationHash === String(row.configuration_hash)
    && parsed.readinessHash === String(row.readiness_hash)
    && parsed.requestedBy === String(row.requested_by)
    && parsed.reason === String(row.reason)
    && parsed.capturedAt === capturedAt;
  if (!columnsMatch) {
    throw resumeError(
      500,
      "INVENTORY_PUBLICATION_TARGET_RESUME_REVIEW_COLUMNS_INVALID",
      "Persisted target resume evidence does not match its indexed immutable columns.",
    );
  }
  return parsed;
}

function assertRequestedReview(
  review: InventoryPublicationTargetResumeReview,
  command: ResumeInventoryPublicationTargetCommand,
  authority: { authorityRevision: string; activationRunId: string },
): void {
  if (review.publicationTargetId !== command.publicationTargetId
    || review.publicationTargetRevision !== command.expectedRevision
    || review.evidenceHash !== command.expectedEvidenceHash) {
    throw resumeError(
      409,
      "INVENTORY_PUBLICATION_TARGET_RESUME_REVIEW_MISMATCH",
      "The selected readiness review does not match the exact target, revision, and evidence hash.",
    );
  }
  if (review.state !== "ready") {
    throw resumeError(
      409,
      "INVENTORY_PUBLICATION_TARGET_RESUME_REVIEW_BLOCKED",
      "Resolve every readiness blocker and capture a new review before resuming.",
      review.blockers.map((blocker) => blocker.code),
    );
  }
  if (review.authorityRevision !== authority.authorityRevision
    || review.activationRunId !== authority.activationRunId) {
    throw resumeError(
      409,
      "INVENTORY_PUBLICATION_TARGET_RESUME_AUTHORITY_CHANGED",
      "Canonical runtime authority changed after the readiness review.",
    );
  }
}

async function loadResumeReplay(
  client: PoolClient,
  receiptKey: string,
  requestHash: string,
): Promise<InventoryPublicationTargetResumeResult | null> {
  const receipt = (await client.query<{ request_hash: string; response_body: unknown }>(
    "SELECT request_hash,response_body FROM public.idempotency_keys WHERE key=$1",
    [receiptKey],
  )).rows[0];
  if (!receipt) return null;
  if (receipt.request_hash !== requestHash) {
    throw resumeError(
      409,
      "INVENTORY_PUBLICATION_TARGET_RESUME_IDEMPOTENCY_CONFLICT",
      "The resume idempotency key was already used with different inputs.",
    );
  }
  const body = receipt.response_body as Record<string, unknown> | null;
  const result = inventoryPublicationTargetResumeResultSchema.safeParse(body?.result);
  if (!result.success) {
    throw resumeError(
      500,
      "INVENTORY_PUBLICATION_TARGET_RESUME_RECEIPT_INVALID",
      "The prior target resume command has an incomplete receipt.",
    );
  }
  return { ...result.data, alreadyApplied: true };
}

async function lockIdempotency(client: PoolClient, key: string): Promise<void> {
  await client.query(
    "SELECT pg_advisory_xact_lock($1, hashtext($2))",
    [IDEMPOTENCY_LOCK_NAMESPACE, key],
  );
}

async function inSerializableTransaction<T>(
  connectionPool: Pick<Pool, "connect">,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await connectionPool.connect();
  let began = false;
  try {
    await client.query("BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE");
    began = true;
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL statement_timeout = '60s'");
    const result = await work(client);
    await client.query("COMMIT");
    began = false;
    return result;
  } catch (error) {
    if (began) await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function blocker(
  code: string,
  message: string,
  context: Record<string, unknown>,
): InventoryPublicationTargetResumeBlocker {
  return { code, message, context };
}

function dedupeBlockers(
  values: readonly InventoryPublicationTargetResumeBlocker[],
): InventoryPublicationTargetResumeBlocker[] {
  const byKey = new Map<string, InventoryPublicationTargetResumeBlocker>();
  for (const value of values) {
    byKey.set(`${value.code}:${canonicalJson(value.context)}`, value);
  }
  return [...byKey.values()].sort((left, right) => left.code.localeCompare(right.code)
    || canonicalJson(left.context).localeCompare(canonicalJson(right.context)));
}

function hash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function positiveInteger(value: unknown, field: string): number {
  const parsed = Number(value);
  if (Number.isSafeInteger(parsed) && parsed > 0 && parsed <= 2_147_483_647) return parsed;
  throw resumeError(500, "INVENTORY_PUBLICATION_TARGET_RESUME_DATABASE_INVALID", `${field} must be positive.`);
}

function nullableNumber(value: unknown): number | null {
  return value == null ? null : Number(value);
}

function nonblank(value: unknown, field: string, max: number): string {
  if (typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= max) {
    return value;
  }
  throw resumeError(500, "INVENTORY_PUBLICATION_TARGET_RESUME_DATABASE_INVALID", `${field} must be nonblank.`);
}

function nonnegativeBigintString(value: unknown, field: string): string {
  const parsed = String(value ?? "");
  if (/^(0|[1-9]\d*)$/.test(parsed)) return parsed;
  throw resumeError(500, "INVENTORY_PUBLICATION_TARGET_RESUME_DATABASE_INVALID", `${field} must be nonnegative.`);
}

function sha256(value: unknown, field: string): string {
  const parsed = String(value ?? "");
  if (/^[0-9a-f]{64}$/.test(parsed)) return parsed;
  throw resumeError(500, "INVENTORY_PUBLICATION_TARGET_RESUME_DATABASE_INVALID", `${field} must be a SHA-256 hash.`);
}

function resumeError(
  status: number,
  code: string,
  message: string,
  details: string[] = [],
): InventoryAvailabilityMasterDataError {
  return new InventoryAvailabilityMasterDataError(status, code, message, details);
}
