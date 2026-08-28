import { createHash } from "node:crypto";

import type {
  InventoryAvailabilityBackfillQueueResponse,
  InventoryAvailabilityBackfillQueueRow,
  InventoryAvailabilityChannelPreview,
} from "@shared/types/inventory-availability-backfill";
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

const actorSchema = z.string().trim().min(1).max(100);

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

type ProductWork = {
  queue: InventoryAvailabilityBackfillQueueRow;
  preview: InventoryAvailabilityChannelPreview | null;
  blockers: ActivationDryRunBlocker[];
};

export class InventoryAvailabilityActivationDryRunService {
  constructor(
    private readonly backfillReader: BackfillReader,
    private readonly store: InventoryAvailabilityActivationDryRunStore,
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

    const work = await mapWithConcurrency(queue.products, 5, async (product): Promise<ProductWork> => {
      const blockers = queueBlockers(product);
      let preview: InventoryAvailabilityChannelPreview | null = null;
      try {
        preview = await this.backfillReader.getChannelPreview(product.productId);
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
      if (preview) {
        blockers.push(...preview.blockers.map((entry) => blocker(
          entry.code,
          entry.severity,
          entry.message,
          product.productId,
          entry.context,
        )));
        for (const row of preview.rows) {
          if (BigInt(row.proposedPublishedUnits) > BigInt(row.proposedAtpUnits)) {
            blockers.push(blocker(
              "CHANNEL_QUANTITY_EXCEEDS_CANONICAL_ATP",
              "blocking",
              "A proposed channel quantity exceeds canonical ATP for the same sellable SKU.",
              product.productId,
              {
                channelId: row.channelId,
                productVariantId: row.productVariantId,
                proposedPublishedUnits: row.proposedPublishedUnits,
                proposedAtpUnits: row.proposedAtpUnits,
              },
            ));
          }
        }
      }
      return { queue: product, preview, blockers };
    });

    const evidenceKeys = work.flatMap(({ preview }) => preview?.rows.map((row) => ({
      channelId: row.channelId,
      productVariantId: row.productVariantId,
    })) ?? []);
    const publicationEvidence = await this.store.captureCurrentPublicationEvidence(evidenceKeys);
    const evidenceByKey = new Map(publicationEvidence.map((entry) => [publicationKey(entry), entry] as const));
    const productByVariant = new Map<number, number>();
    for (const { queue: product, preview } of work) {
      for (const row of preview?.rows ?? []) productByVariant.set(row.productVariantId, product.productId);
    }

    const products = work.map(({ queue: product, preview, blockers }) => {
      const productEvidence = publicationEvidence
        .filter((entry) => productByVariant.get(entry.productVariantId) === product.productId)
        .sort((left, right) => left.channelId - right.channelId
          || left.productVariantId - right.productVariantId);
      for (const row of preview?.rows ?? []) {
        const evidence = evidenceByKey.get(publicationKey(row));
        if (!evidence) {
          blockers.push(blocker(
            "CURRENT_PUBLICATION_EVIDENCE_NOT_CAPTURED",
            "blocking",
            "Current publication evidence was not captured for a proposed channel row.",
            product.productId,
            { channelId: row.channelId, productVariantId: row.productVariantId },
          ));
          continue;
        }
        blockers.push(...publicationBlockers(product.productId, evidence, row));
      }
      const proposedPublications = (preview?.rows ?? []).map((row) => {
        const current = evidenceByKey.get(publicationKey(row));
        return {
          channelId: row.channelId,
          channelProvider: row.channelProvider,
          productVariantId: row.productVariantId,
          canonicalAtpUnits: row.proposedAtpUnits,
          legacyCalculatedUnits: row.legacyPublishedUnits,
          desiredUnits: row.proposedPublishedUnits,
          differenceFromLastAcknowledgedUnits: current?.lastAcknowledgedUnits === null
            || current?.lastAcknowledgedUnits === undefined
            ? null
            : (BigInt(row.proposedPublishedUnits) - BigInt(current.lastAcknowledgedUnits)).toString(),
          warehouseBreakdown: row.warehouseBreakdown.map((warehouse) => ({
            warehouseId: warehouse.warehouseId,
            desiredUnits: String(warehouse.proposedQty),
          })),
        };
      });
      const resolvedBlockers = uniqueBlockers(blockers);
      const evidence: ActivationDryRunProduct = {
        productId: product.productId,
        queueState: product.queueState,
        status: resolvedBlockers.some((entry) => entry.severity === "blocking") ? "blocked" : "ready",
        draftModelId: product.draft?.modelId ?? null,
        draftModelVersion: product.draft?.version ?? null,
        draftDefinitionHash: product.draft?.definitionHash ?? null,
        reviewId: product.review?.reviewId ?? null,
        shadowRunId: preview?.shadowRunId ?? product.latestShadow?.runId ?? null,
        shadowSnapshotFingerprint: preview?.snapshotFingerprint
          ?? product.latestShadow?.snapshotFingerprint
          ?? null,
        channelPreviewHash: preview ? hash(preview) : null,
        proposedPublications,
        publicationEvidence: productEvidence,
        blockers: resolvedBlockers,
      };
      return evidence;
    }).sort((left, right) => left.productId - right.productId);

    const globalBlockers: ActivationDryRunBlocker[] = [];
    const blockedProducts = products.filter((product) => product.status === "blocked").length;
    const summary = {
      totalProducts: products.length,
      readyProducts: products.length - blockedProducts,
      blockedProducts,
      publicationRows: evidenceKeys.length,
    };
    const state = blockedProducts > 0
      || globalBlockers.some((entry) => entry.severity === "blocking")
      ? "blocked" as const
      : "ready_for_publication" as const;
    const completedAt = validNow(this.clock, "completion");
    const requestHash = hash({
      commandType: "inventory_availability_activation_dry_run",
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

function publicationBlockers(
  productId: number,
  evidence: CurrentPublicationEvidence,
  proposed: InventoryAvailabilityChannelPreview["rows"][number],
): ActivationDryRunBlocker[] {
  const context = {
    channelId: evidence.channelId,
    productVariantId: evidence.productVariantId,
    feedId: evidence.feedId,
  };
  const blockers: ActivationDryRunBlocker[] = [];
  if ((evidence.mappingState === "missing" || evidence.mappingState === "inactive")
    && BigInt(proposed.proposedPublishedUnits) > BigInt(0)) {
    blockers.push(blocker(
      "PUBLISHABLE_FEED_MAPPING_MISSING",
      "blocking",
      "The proposed quantity is positive but no active external SKU mapping exists.",
      productId,
      { ...context, proposedPublishedUnits: proposed.proposedPublishedUnits },
    ));
  }
  if (evidence.mappingState === "missing" || evidence.mappingState === "inactive") return blockers;
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
  } else if (accountTargets.length === 0) {
    for (const warehouse of proposed.warehouseBreakdown.filter((entry) =>
      entry.proposedQty > 0 || entry.legacyQty > 0)) {
      const matchingTargets = enabledTargets.filter((target) =>
        target.providerScopeType === "location" && target.warehouseId === warehouse.warehouseId);
      if (matchingTargets.length !== 1) {
        blockers.push(blocker(
          "PUBLICATION_LOCATION_TARGET_UNRESOLVED",
          "blocking",
          "A proposed warehouse quantity must resolve to exactly one enabled location target.",
          productId,
          {
            ...context,
            warehouseId: warehouse.warehouseId,
            proposedQty: warehouse.proposedQty,
            publicationTargetIds: matchingTargets.map((target) => target.publicationTargetId),
          },
        ));
      }
    }
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
  return blockers;
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
