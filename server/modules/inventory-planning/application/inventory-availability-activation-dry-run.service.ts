import { createHash } from "node:crypto";

import type {
  InventoryAvailabilityBackfillQueueResponse,
  InventoryAvailabilityBackfillQueueRow,
  InventoryAvailabilityChannelPreview,
} from "@shared/types/inventory-availability-backfill";
import type {
  InventoryChannelExposureAdminView,
  InventoryChannelExposurePreview,
} from "@shared/types/inventory-channel-exposure";
import {
  inventoryActivationDryRunSchema,
  runInventoryActivationDryRunRequestSchema,
  type ActivationDryRunBlocker,
  type ActivationDryRunProduct,
  type CurrentPublicationEvidence,
  type InventoryActivationDryRun,
} from "@shared/types/inventory-availability-phase4";
import { canonicalJson } from "@shared/utils/canonical-json";
import { z } from "zod";

import {
  InventoryAvailabilityBackfillService,
} from "./inventory-availability-backfill.service";
import { InventoryAvailabilityMasterDataError } from "../domain/inventory-availability-master-data.contracts";
import { findPartitionedShareOverages } from "../domain/inventory-channel-exposure";

const actorSchema = z.string().trim().min(1).max(100);
const ACTIVATION_DRY_RUN_CONTRACT_VERSION = "exact_publication_targets_v3";
const MAX_PROVIDER_READBACK_AGE_MS = 15 * 60 * 1000;

export interface PublicationEvidenceKey {
  channelId: number;
  productVariantId: number;
}

export interface PersistActivationDryRunInput {
  requestHash: string;
  resultHash: string;
  expectedCatalogInputHash: string;
  expectedCatalogResultHash: string;
  catalogInputHash: string;
  catalogResultHash: string;
  idempotencyKey: string;
  reason: string;
  requestedBy: string;
  startedAt: Date;
  completedAt: Date;
  state: "blocked" | "ready_for_publication";
  summary: InventoryActivationDryRun["summary"];
  products: ActivationDryRunProduct[];
  blockers: ActivationDryRunBlocker[];
}

export interface InventoryAvailabilityActivationDryRunStore {
  captureCurrentPublicationEvidence(
    keys: readonly PublicationEvidenceKey[],
  ): Promise<CurrentPublicationEvidence[]>;
  persistActivationDryRun(input: PersistActivationDryRunInput): Promise<InventoryActivationDryRun>;
}

export interface InventoryAvailabilityActivationDryRunClock {
  now(): Date;
}

const systemClock: InventoryAvailabilityActivationDryRunClock = { now: () => new Date() };

export class InventoryAvailabilityActivationDryRunServiceError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: string[] = [],
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "InventoryAvailabilityActivationDryRunServiceError";
  }
}

type BackfillReader = Pick<
  InventoryAvailabilityBackfillService,
  "getMigrationQueue" | "getChannelPreview"
>;

export interface InventoryChannelExposureReadinessReader {
  getView(productId?: number | null): Promise<InventoryChannelExposureAdminView>;
  preview(publicationTargetId: number, productId: number): Promise<InventoryChannelExposurePreview>;
}

type ProductWork = {
  queue: InventoryAvailabilityBackfillQueueRow;
  legacyPreview: InventoryAvailabilityChannelPreview | null;
  targetPreviews: InventoryChannelExposurePreview[];
  blockers: ActivationDryRunBlocker[];
};

export class InventoryAvailabilityActivationDryRunService {
  constructor(
    private readonly backfillReader: BackfillReader,
    private readonly store: InventoryAvailabilityActivationDryRunStore,
    private readonly channelExposureReader: InventoryChannelExposureReadinessReader,
    private readonly clock: InventoryAvailabilityActivationDryRunClock = systemClock,
  ) {}

  async runDryRun(input: unknown, actorInput: string): Promise<InventoryActivationDryRun> {
    const parsed = runInventoryActivationDryRunRequestSchema.safeParse(input);
    if (!parsed.success) {
      throw new InventoryAvailabilityActivationDryRunServiceError(
        400,
        "INVENTORY_AVAILABILITY_INVALID_ACTIVATION_DRY_RUN",
        "Review the full-catalog activation dry-run fields.",
        parsed.error.issues.map((issue) => `${issue.path.join(".") || "request"}: ${issue.message}`),
      );
    }
    const actor = parseActor(actorInput);
    const startedAt = validNow(this.clock, "start");
    const queue = await this.backfillReader.getMigrationQueue();
    assertExpectedCatalog(queue, parsed.data.expectedCatalogInputHash, parsed.data.expectedCatalogResultHash);
    const exposureView = await this.channelExposureReader.getView(null);
    const previewTargets = exposureView.publicationTargets
      .filter((target) => target.state !== "disabled")
      .sort((left, right) => left.id - right.id);
    const channelProviderById = new Map(exposureView.channels.map((channel) => [
      channel.id,
      channel.provider,
    ] as const));
    const globalBlockers: ActivationDryRunBlocker[] = [];
    if (previewTargets.length === 0) {
      globalBlockers.push(blocker(
        "PUBLICATION_TARGET_PREVIEW_MISSING",
        "blocking",
        "No exact publication target is enabled for readiness preview.",
        null,
        {},
      ));
    }

    const work = await mapWithConcurrency(
      queue.products.filter((product) => product.queueState !== "excluded"),
      5,
      async (product): Promise<ProductWork> => {
        const blockers = queueBlockers(product);
        let legacyPreview: InventoryAvailabilityChannelPreview | null = null;
        try {
          legacyPreview = await this.backfillReader.getChannelPreview(product.productId);
        } catch (error) {
          if (!(error instanceof InventoryAvailabilityMasterDataError)
            || error.code !== "INVENTORY_AVAILABILITY_SHADOW_RUN_NOT_FOUND") {
            throw error;
          }
          blockers.push(blocker(
            "CHANNEL_PREVIEW_NOT_AVAILABLE",
            "blocking",
            "No current channel publication preview exists for this product.",
            product.productId,
            {},
          ));
        }
        if (legacyPreview) {
          blockers.push(...legacyPreview.blockers.map((entry) => blocker(
            entry.code,
            entry.severity,
            entry.message,
            product.productId,
            entry.context,
          )));
        }
        const targetPreviews = await mapWithConcurrency(
          previewTargets,
          5,
          async (target): Promise<InventoryChannelExposurePreview | null> => {
            try {
              const preview = await this.channelExposureReader.preview(target.id, product.productId);
              if (preview.publicationTargetRevision !== target.revision
                || preview.publicationTargetState !== target.state
                || preview.channelId !== target.channelId
                || preview.channelConnectionId !== target.channelConnectionId) {
                blockers.push(blocker(
                  "PUBLICATION_TARGET_CHANGED_DURING_DRY_RUN",
                  "blocking",
                  "The exact publication target changed while readiness evidence was being captured.",
                  product.productId,
                  { publicationTargetId: target.id, expectedRevision: target.revision,
                    capturedRevision: preview.publicationTargetRevision },
                ));
              }
              blockers.push(...preview.blockers.map((entry) => blocker(
                entry.code,
                "blocking",
                entry.message,
                product.productId,
                entry.context,
              )));
              for (const row of preview.rows) {
                if (BigInt(row.publishedUnits) > BigInt(row.canonicalAtpUnits)) {
                  blockers.push(blocker(
                    "CHANNEL_QUANTITY_EXCEEDS_CANONICAL_ATP",
                    "blocking",
                    "A proposed target quantity exceeds canonical ATP for the same sellable SKU.",
                    product.productId,
                    { publicationTargetId: target.id, channelId: target.channelId,
                      productVariantId: row.productVariantId,
                      proposedPublishedUnits: row.publishedUnits,
                      proposedAtpUnits: row.canonicalAtpUnits },
                  ));
                }
              }
              return preview;
            } catch (error) {
              if (!(error instanceof InventoryAvailabilityMasterDataError)
                || !["INVENTORY_CHANNEL_EXPOSURE_SHADOW_NOT_FOUND",
                  "INVENTORY_AVAILABILITY_SHADOW_RUN_NOT_FOUND"].includes(error.code)) {
                throw error;
              }
              blockers.push(blocker(
                "TARGET_CHANNEL_PREVIEW_NOT_AVAILABLE",
                "blocking",
                "No current target-aware channel exposure preview exists for this product.",
                product.productId,
                { publicationTargetId: target.id },
              ));
              return null;
            }
          },
        );
        const resolvedTargetPreviews = targetPreviews.filter(
          (preview): preview is InventoryChannelExposurePreview => preview !== null,
        );
        const partitionOverages = findPartitionedShareOverages(resolvedTargetPreviews.flatMap((preview) =>
          preview.rows.flatMap((row) => row.policy ? [{
            productVariantId: row.productVariantId,
            sourceWarehouseIds: preview.warehouseIds,
            policy: row.policy,
          }] : [])));
        for (const overage of partitionOverages) {
          blockers.push(blocker(
            "PARTITIONED_CHANNEL_SHARE_EXCEEDS_SOURCE_CAPACITY",
            "blocking",
            "Partitioned target shares exceed 100 percent for an overlapping SKU and source warehouse.",
            product.productId,
            overage,
          ));
        }
        const targetScopesByChannelVariant = new Map<string, Array<{
          publicationTargetId: number;
          providerScopeType: "account" | "location";
        }>>();
        for (const preview of resolvedTargetPreviews) {
          for (const row of preview.rows) {
            if (!row.policy?.eligible) continue;
            const key = `${preview.channelId}:${row.productVariantId}`;
            const scopes = targetScopesByChannelVariant.get(key) ?? [];
            scopes.push({
              publicationTargetId: preview.publicationTargetId,
              providerScopeType: preview.providerScopeType,
            });
            targetScopesByChannelVariant.set(key, scopes);
          }
        }
        for (const [key, scopes] of targetScopesByChannelVariant) {
          if (scopes.length <= 1 || !scopes.some((scope) => scope.providerScopeType === "account")) {
            continue;
          }
          const [channelId, productVariantId] = key.split(":").map(Number);
          blockers.push(blocker(
            "PUBLICATION_TARGET_SCOPE_AMBIGUOUS",
            "blocking",
            "An account-scoped target cannot overlap another enabled target for the same channel and SKU.",
            product.productId,
            { channelId, productVariantId,
              publicationTargetIds: scopes.map((scope) => scope.publicationTargetId).sort((a, b) => a - b) },
          ));
        }
        return { queue: product, legacyPreview, targetPreviews: resolvedTargetPreviews, blockers };
      },
    );

    const evidenceKeys = work.flatMap(({ legacyPreview, targetPreviews }) => [
      ...(legacyPreview?.rows.map((row) => ({
        channelId: row.channelId,
        productVariantId: row.productVariantId,
      })) ?? []),
      ...targetPreviews.flatMap((preview) => preview.rows.map((row) => ({
        channelId: preview.channelId,
        productVariantId: row.productVariantId,
      }))),
    ]);
    const publicationEvidence = await this.store.captureCurrentPublicationEvidence(evidenceKeys);
    const evidenceByKey = new Map(publicationEvidence.map((entry) => [publicationKey(entry), entry] as const));
    const productByVariant = new Map<number, number>();
    for (const { queue: product, legacyPreview, targetPreviews } of work) {
      for (const row of legacyPreview?.rows ?? []) productByVariant.set(row.productVariantId, product.productId);
      for (const preview of targetPreviews) {
        for (const row of preview.rows) productByVariant.set(row.productVariantId, product.productId);
      }
    }

    const products = work.map(({ queue: product, legacyPreview, targetPreviews, blockers }) => {
      const productEvidence = publicationEvidence
        .filter((entry) => productByVariant.get(entry.productVariantId) === product.productId)
        .sort((left, right) => left.channelId - right.channelId
          || left.productVariantId - right.productVariantId);
      for (const row of legacyPreview?.rows ?? []) {
        const evidence = evidenceByKey.get(publicationKey(row));
        if (!evidence) {
          blockers.push(blocker(
            "CURRENT_PUBLICATION_EVIDENCE_NOT_CAPTURED",
            "blocking",
            "Current publication evidence was not captured for a legacy channel row.",
            product.productId,
            { channelId: row.channelId, productVariantId: row.productVariantId },
          ));
          continue;
        }
        blockers.push(...legacyPublicationCoverageBlockers(product.productId, evidence, startedAt));
      }
      const legacyRows = new Map((legacyPreview?.rows ?? []).map((row) => [publicationKey(row), row] as const));
      const proposedPublications = targetPreviews.flatMap((preview) => preview.rows.map((row) => {
        const current = evidenceByKey.get(publicationKey({
          channelId: preview.channelId,
          productVariantId: row.productVariantId,
        }));
        if (!current) {
          blockers.push(blocker(
            "CURRENT_PUBLICATION_EVIDENCE_NOT_CAPTURED",
            "blocking",
            "Current publication evidence was not captured for an exact target row.",
            product.productId,
            { publicationTargetId: preview.publicationTargetId,
              channelId: preview.channelId, productVariantId: row.productVariantId },
          ));
        } else {
          blockers.push(...targetPublicationBlockers(product.productId, current, preview, row, startedAt));
        }
        const legacy = legacyRows.get(publicationKey({
          channelId: preview.channelId,
          productVariantId: row.productVariantId,
        }));
        const mapping = row.mapping;
        const disposition = !row.policy
          ? "blocked" as const
          : !row.policy.eligible
            ? "skip_ineligible" as const
            : preview.sourceBindingId === null || mapping === null
              ? "blocked" as const
              : preview.publicationAuthority === "echelon"
                ? "publish" as const
                : "observe_only" as const;
        return {
          publicationTargetId: preview.publicationTargetId,
          channelId: preview.channelId,
          channelConnectionId: preview.channelConnectionId,
          channelProvider: channelProviderById.get(preview.channelId) ?? "unknown",
          providerScopeType: preview.providerScopeType,
          externalScopeId: preview.externalScopeId,
          publicationAuthority: preview.publicationAuthority,
          publicationTargetRevision: preview.publicationTargetRevision,
          disposition,
          productVariantId: row.productVariantId,
          canonicalAtpUnits: row.canonicalAtpUnits,
          legacyCalculatedUnits: legacy?.legacyPublishedUnits ?? "0",
          desiredUnits: row.publishedUnits,
          differenceFromLastAcknowledgedUnits: current?.lastAcknowledgedUnits === null
            || current?.lastAcknowledgedUnits === undefined
            ? null
            : (BigInt(row.publishedUnits) - BigInt(current.lastAcknowledgedUnits)).toString(),
          sourceBindingId: preview.sourceBindingId,
          sourceBindingVersion: preview.sourceBindingVersion,
          sourceBindingDefinitionHash: preview.sourceBindingDefinitionHash,
          sourceWarehouseIds: preview.warehouseIds,
          sourceWarehouseBreakdown: row.sourceWarehouseBreakdown,
          mappingId: mapping?.mappingId ?? null,
          mappingVersion: mapping?.version ?? null,
          mappingDefinitionHash: mapping?.definitionHash ?? null,
          externalInventoryItemId: mapping?.externalInventoryItemId ?? null,
          externalSku: mapping?.externalSku ?? null,
          policySelections: preview.selectedPolicies,
        };
      }));
      const resolvedBlockers = uniqueBlockers(blockers);
      const firstPreview = targetPreviews[0] ?? null;
      const evidence: ActivationDryRunProduct = {
        productId: product.productId,
        queueState: product.queueState,
        status: resolvedBlockers.some((entry) => entry.severity === "blocking") ? "blocked" : "ready",
        draftModelId: product.draft?.modelId ?? null,
        draftModelVersion: product.draft?.version ?? null,
        draftDefinitionHash: product.draft?.definitionHash ?? null,
        reviewId: product.review?.reviewId ?? null,
        shadowRunId: firstPreview?.shadowRunId ?? legacyPreview?.shadowRunId
          ?? product.latestShadow?.runId ?? null,
        shadowSnapshotFingerprint: firstPreview?.snapshotFingerprint
          ?? legacyPreview?.snapshotFingerprint ?? product.latestShadow?.snapshotFingerprint ?? null,
        channelPreviewHash: targetPreviews.length > 0 || legacyPreview
          ? hash({ legacyPreview, targetPreviews }) : null,
        proposedPublications,
        publicationEvidence: productEvidence,
        blockers: resolvedBlockers,
      };
      return evidence;
    }).sort((left, right) => left.productId - right.productId);

    const blockedProducts = products.filter((product) => product.status === "blocked").length;
    const publicationRows = products.reduce(
      (total, product) => total + product.proposedPublications.length,
      0,
    );
    const summary = {
      totalProducts: products.length,
      readyProducts: products.length - blockedProducts,
      blockedProducts,
      publicationRows,
    };
    const state = blockedProducts > 0
      || globalBlockers.some((entry) => entry.severity === "blocking")
      ? "blocked" as const
      : "ready_for_publication" as const;
    const completedAt = validNow(this.clock, "completion");
    const requestHash = hash({
      commandType: "inventory_availability_activation_dry_run",
      contractVersion: ACTIVATION_DRY_RUN_CONTRACT_VERSION,
      requestedBy: actor,
      reason: parsed.data.reason,
      expectedCatalogInputHash: parsed.data.expectedCatalogInputHash,
      expectedCatalogResultHash: parsed.data.expectedCatalogResultHash,
    });
    const resultHash = hash({
      mode: "dry_run",
      scope: "full_catalog",
      state,
      catalogInputHash: queue.catalogInputHash,
      catalogResultHash: queue.catalogResultHash,
      summary,
      products,
      blockers: globalBlockers,
    });
    return inventoryActivationDryRunSchema.parse(await this.store.persistActivationDryRun({
      requestHash,
      resultHash,
      expectedCatalogInputHash: parsed.data.expectedCatalogInputHash,
      expectedCatalogResultHash: parsed.data.expectedCatalogResultHash,
      catalogInputHash: queue.catalogInputHash,
      catalogResultHash: queue.catalogResultHash,
      idempotencyKey: parsed.data.idempotencyKey,
      reason: parsed.data.reason,
      requestedBy: actor,
      startedAt,
      completedAt,
      state,
      summary,
      products,
      blockers: globalBlockers,
    }));
  }
}

function queueBlockers(product: InventoryAvailabilityBackfillQueueRow): ActivationDryRunBlocker[] {
  const blockers = product.issues.map((entry) => blocker(
    entry.code,
    entry.severity,
    entry.message,
    product.productId,
    entry.context,
  ));
  if (product.queueState !== "approved") {
    blockers.push(blocker(
      "PRODUCT_MODEL_NOT_APPROVED",
      "blocking",
      "The product does not have a current approved transformation-model draft.",
      product.productId,
      { queueState: product.queueState },
    ));
  }
  return blockers;
}

function legacyPublicationCoverageBlockers(
  productId: number,
  evidence: CurrentPublicationEvidence,
  capturedAt: Date,
): ActivationDryRunBlocker[] {
  const context = {
    channelId: evidence.channelId,
    productVariantId: evidence.productVariantId,
    feedId: evidence.feedId,
  };
  const blockers: ActivationDryRunBlocker[] = [];
  if (evidence.mappingState === "missing" || evidence.mappingState === "inactive") {
    blockers.push(blocker(
      "ACTIVE_LEGACY_FEED_MAPPING_MISSING",
      "blocking",
      "A legacy channel preview row has no active feed identity.",
      productId,
      context,
    ));
    return blockers;
  }
  if (evidence.mappingState === "quarantined") {
    blockers.push(blocker(
      "PUBLICATION_MAPPING_QUARANTINED",
      "blocking",
      "The current publication mapping is quarantined.",
      productId,
      context,
    ));
  }
  if (evidence.lastAcknowledgedUnits === null || evidence.lastAcknowledgedAt === null) {
    blockers.push(blocker(
      "CURRENT_ACKNOWLEDGED_QUANTITY_MISSING",
      "blocking",
      "The legacy feed has no complete last-acknowledged quantity evidence.",
      productId,
      context,
    ));
  }
  if (evidence.configuredTargets.length === 0) {
    blockers.push(blocker(
      "EXPLICIT_PUBLICATION_TARGET_MISSING",
      "blocking",
      "The active legacy feed is not bound to an exact publication target.",
      productId,
      context,
    ));
  }
  const enabledTargets = evidence.configuredTargets.filter((target) => target.state !== "disabled");
  if (evidence.configuredTargets.length > 0 && enabledTargets.length === 0) {
    blockers.push(blocker(
      "PUBLICATION_TARGET_NOT_IN_PREVIEW",
      "blocking",
      "Every configured publication target is disabled; activation review requires preview state.",
      productId,
      context,
    ));
  }
  const accountTargets = enabledTargets.filter((target) => target.providerScopeType === "account");
  if (accountTargets.length > 0 && enabledTargets.length !== 1) {
    blockers.push(blocker(
      "PUBLICATION_TARGET_SCOPE_AMBIGUOUS",
      "blocking",
      "An account-scoped target cannot be enabled with any other target for the same channel and SKU.",
      productId,
      { ...context, publicationTargetIds: enabledTargets.map((target) => target.publicationTargetId) },
    ));
  }
  const targetsMissingMapping = enabledTargets
    .filter((target) => target.mapping === null)
    .map((target) => target.publicationTargetId);
  if (targetsMissingMapping.length > 0) {
    blockers.push(blocker(
      "EXACT_TARGET_VARIANT_MAPPING_MISSING",
      "blocking",
      "An active legacy feed is not mapped to every enabled exact publication target.",
      productId,
      { ...context, publicationTargetIds: targetsMissingMapping },
    ));
  }
  const targetsMissingReadback = enabledTargets
    .filter((target) => target.latestReadbackUnits === null || target.latestReadbackAt === null)
    .map((target) => target.publicationTargetId);
  if (targetsMissingReadback.length > 0) {
    blockers.push(blocker(
      "PROVIDER_READBACK_MISSING",
      "blocking",
      "Provider acknowledgement is not provider quantity readback; no verified readback is available.",
      productId,
      { ...context, publicationTargetIds: targetsMissingReadback },
    ));
  }
  const targetsWithStaleReadback = enabledTargets
    .filter((target) => target.latestReadbackAt !== null
      && readbackIsStale(target.latestReadbackAt, capturedAt))
    .map((target) => target.publicationTargetId);
  if (targetsWithStaleReadback.length > 0) {
    blockers.push(blocker(
      "PROVIDER_READBACK_STALE",
      "blocking",
      "Provider quantity readback is older than the activation freshness window.",
      productId,
      { ...context, publicationTargetIds: targetsWithStaleReadback,
        maxAgeMilliseconds: MAX_PROVIDER_READBACK_AGE_MS },
    ));
  }
  const targetsWithStaleReadbackIdentity = enabledTargets
    .filter((target) => target.mapping !== null
      && target.latestReadbackUnits !== null
      && target.latestReadbackAt !== null
      && !readbackMatchesTarget(target))
    .map((target) => target.publicationTargetId);
  if (targetsWithStaleReadbackIdentity.length > 0) {
    blockers.push(blocker(
      "PROVIDER_READBACK_IDENTITY_MISMATCH",
      "blocking",
      "Provider readback evidence does not identify the selected exact target/SKU mapping.",
      productId,
      { ...context, publicationTargetIds: targetsWithStaleReadbackIdentity },
    ));
  }
  return blockers;
}

function targetPublicationBlockers(
  productId: number,
  evidence: CurrentPublicationEvidence,
  preview: InventoryChannelExposurePreview,
  row: InventoryChannelExposurePreview["rows"][number],
  capturedAt: Date,
): ActivationDryRunBlocker[] {
  const context = {
    publicationTargetId: preview.publicationTargetId,
    channelId: preview.channelId,
    productVariantId: row.productVariantId,
  };
  const target = evidence.configuredTargets.find((candidate) =>
    candidate.publicationTargetId === preview.publicationTargetId);
  if (!target) {
    return [blocker(
      "EXACT_PUBLICATION_TARGET_EVIDENCE_MISSING",
      "blocking",
      "The exact publication target disappeared while readiness evidence was being captured.",
      productId,
      context,
    )];
  }
  const blockers: ActivationDryRunBlocker[] = [];
  if (target.state === "disabled") {
    blockers.push(blocker(
      "PUBLICATION_TARGET_NOT_IN_PREVIEW",
      "blocking",
      "The exact publication target is disabled.",
      productId,
      context,
    ));
  }
  if (row.policy?.eligible && row.mapping === null) {
    blockers.push(blocker(
      "EXACT_TARGET_VARIANT_MAPPING_MISSING",
      "blocking",
      "An eligible target/SKU row has no exact provider inventory identity.",
      productId,
      context,
    ));
  }
  if (row.mapping && (
    target.mapping?.mappingId !== row.mapping.mappingId
    || target.mapping.definitionHash !== row.mapping.definitionHash
  )) {
    blockers.push(blocker(
      "PUBLICATION_VARIANT_MAPPING_CHANGED_DURING_DRY_RUN",
      "blocking",
      "The exact target/SKU mapping changed while readiness evidence was being captured.",
      productId,
      { ...context, previewMappingId: row.mapping.mappingId,
        evidenceMappingId: target.mapping?.mappingId ?? null },
    ));
  }
  if (row.policy?.eligible
    && (target.latestReadbackUnits === null || target.latestReadbackAt === null)) {
    blockers.push(blocker(
      "PROVIDER_READBACK_MISSING",
      "blocking",
      "No authoritative provider quantity readback exists for this exact target/SKU identity.",
      productId,
      context,
    ));
  }
  if (row.policy?.eligible && target.latestReadbackAt !== null
    && readbackIsStale(target.latestReadbackAt, capturedAt)) {
    blockers.push(blocker(
      "PROVIDER_READBACK_STALE",
      "blocking",
      "Provider quantity readback is older than the activation freshness window.",
      productId,
      { ...context, latestReadbackAt: target.latestReadbackAt,
        maxAgeMilliseconds: MAX_PROVIDER_READBACK_AGE_MS },
    ));
  }
  if (row.policy?.eligible && row.mapping
    && target.latestReadbackUnits !== null && target.latestReadbackAt !== null
    && (!readbackMatchesTarget(target)
      || target.latestReadbackExternalInventoryItemId !== row.mapping.externalInventoryItemId)) {
    blockers.push(blocker(
      "PROVIDER_READBACK_IDENTITY_MISMATCH",
      "blocking",
      "Provider readback evidence does not identify the selected exact target/SKU mapping.",
      productId,
      { ...context, expectedExternalInventoryItemId: row.mapping.externalInventoryItemId,
        observedExternalInventoryItemId: target.latestReadbackExternalInventoryItemId },
    ));
  }
  return blockers;
}

function readbackMatchesTarget(
  target: CurrentPublicationEvidence["configuredTargets"][number],
): boolean {
  return target.latestReadbackExternalInventoryItemId === target.mapping?.externalInventoryItemId
    && target.latestReadbackChannelConnectionId === target.channelConnectionId
    && target.latestReadbackProviderScopeType === target.providerScopeType
    && target.latestReadbackExternalScopeId === target.externalScopeId
    && target.latestReadbackPublicationTargetRevision === target.revision;
}

function readbackIsStale(observedAt: string, reference: Date): boolean {
  const observed = Date.parse(observedAt);
  return !Number.isFinite(observed)
    || observed > reference.getTime()
    || reference.getTime() - observed > MAX_PROVIDER_READBACK_AGE_MS;
}

function blocker(
  code: string,
  severity: "review" | "blocking",
  message: string,
  productId: number | null,
  context: Record<string, unknown>,
): ActivationDryRunBlocker {
  return { code, severity, message, productId, context };
}

function uniqueBlockers(values: readonly ActivationDryRunBlocker[]): ActivationDryRunBlocker[] {
  const byKey = new Map<string, ActivationDryRunBlocker>();
  for (const entry of values) {
    const key = `${entry.code}:${entry.productId ?? "catalog"}:${canonicalJson(entry.context)}`;
    if (!byKey.has(key)) byKey.set(key, entry);
  }
  return [...byKey.values()].sort((left, right) =>
    left.code.localeCompare(right.code) || canonicalJson(left.context).localeCompare(canonicalJson(right.context)));
}

function publicationKey(value: PublicationEvidenceKey): string {
  return `${value.channelId}:${value.productVariantId}`;
}

function hash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function parseActor(value: string): string {
  const parsed = actorSchema.safeParse(value);
  if (!parsed.success) {
    throw new InventoryAvailabilityActivationDryRunServiceError(
      401,
      "INVENTORY_AVAILABILITY_ACTOR_REQUIRED",
      "An authenticated operator is required.",
    );
  }
  return parsed.data;
}

function validNow(clock: InventoryAvailabilityActivationDryRunClock, phase: string): Date {
  const now = clock.now();
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new InventoryAvailabilityActivationDryRunServiceError(
      500,
      "INVENTORY_AVAILABILITY_INVALID_CLOCK",
      `The injected activation dry-run ${phase} clock returned an invalid time.`,
    );
  }
  return now;
}

function assertExpectedCatalog(
  queue: InventoryAvailabilityBackfillQueueResponse,
  expectedInputHash: string,
  expectedResultHash: string,
): void {
  if (queue.catalogInputHash !== expectedInputHash || queue.catalogResultHash !== expectedResultHash) {
    throw new InventoryAvailabilityActivationDryRunServiceError(
      409,
      "INVENTORY_AVAILABILITY_CATALOG_PREVIEW_STALE",
      "The full-catalog migration queue changed; reload it before starting an activation dry run.",
    );
  }
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>,
): Promise<R[]> {
  const result = new Array<R>(values.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      result[index] = await mapper(values[index]!);
    }
  });
  await Promise.all(workers);
  return result;
}
