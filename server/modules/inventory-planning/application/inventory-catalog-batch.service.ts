import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJson } from "@shared/utils/canonical-json";
import {
  catalogBatchExecutionPreview,
  inventoryCatalogBatchExecuteRequestSchema,
  inventoryCatalogBatchPreviewRequestSchema,
  inventoryCatalogBatchPreviewSchema,
  inventoryCatalogBatchResultSchema,
  type InventoryCatalogBatchPreview,
  type InventoryCatalogBatchResult,
} from "@shared/types/inventory-catalog-batch";
import { InventoryAvailabilityMasterDataError } from "../domain/inventory-availability-master-data.contracts";
import type { InventoryAvailabilityBackfillService } from "./inventory-availability-backfill.service";
import { logger, type LogEntry } from "../../../platform/observability/logger";

type Backfill = Pick<InventoryAvailabilityBackfillService,
  "getMigrationQueue" | "applyProductDraft" | "refreshProductDraft" | "reviewProductDraft">;
type ResultRow = InventoryCatalogBatchResult["rows"][number];
type Log = (event: LogEntry) => void;
const defaultLog: Log = ({ level, action, ...data }) => logger[level](action, data);

export class InventoryCatalogBatchService {
  constructor(private readonly backfill: Backfill,
    private readonly log: Log = defaultLog) {}

  async preview(input: unknown): Promise<InventoryCatalogBatchPreview> {
    const request = parse(inventoryCatalogBatchPreviewRequestSchema, input);
    const queue = await this.backfill.getMigrationQueue();
    const products = request.productIds.slice().sort((a, b) => a - b).map((id) => {
      const product = queue.products.find((row) => row.productId === id);
      if (!product) throw new InventoryAvailabilityMasterDataError(404,
        "INVENTORY_CATALOG_BATCH_PRODUCT_NOT_FOUND", `Active product ${id} is not in the catalog queue.`);
      return product;
    });
    const manifest = { version: "inventory_catalog_batch_v1" as const, mode: request.mode, products };
    const { previewHash: _placeholder, ...evidence } = catalogBatchExecutionPreview({ ...manifest, previewHash: "0".repeat(64) });
    return inventoryCatalogBatchPreviewSchema.parse({ ...manifest, previewHash: digest(evidence) });
  }

  async execute(input: unknown, actorInput: string): Promise<InventoryCatalogBatchResult> {
    const actor = parse(z.string().trim().min(1).max(100), actorInput);
    const request = parse(inventoryCatalogBatchExecuteRequestSchema, input);
    const { previewHash, ...manifest } = request.preview;
    if (digest(manifest) !== previewHash) throw new InventoryAvailabilityMasterDataError(409,
      "INVENTORY_CATALOG_BATCH_PREVIEW_CHANGED", "The batch preview changed. Generate a new preview.");
    const current = await this.backfill.getMigrationQueue();
    const rows: ResultRow[] = [];
    let aborted = false;
    for (const product of manifest.products) {
      const action = product.action;
      const result: ResultRow = { productId: product.productId, action, status: "skipped",
        code: "INVENTORY_CATALOG_BATCH_INELIGIBLE", message: `No ${manifest.mode} action for ${product.queueState}.`,
        failureClass: null, modelId: null, reviewId: null };
      if (aborted) {
        rows.push({ ...result, status: "not_attempted", code: "INVENTORY_CATALOG_BATCH_ABORTED",
          message: "Not attempted after an unexpected failure. Retry the unchanged preview after investigation.",
          failureClass: "fatal" });
        continue;
      }
      if (action === "skip") { rows.push(result); continue; }
      // The unchanged manifest, actor and decision reproduce each persisted per-product receipt key.
      const idempotencyKey = `catalog-batch:${digest({ previewHash, actor, reason: request.reason,
        decision: request.decision, productId: product.productId, action })}`;
      try {
        const actual = current.products.find((row) => row.productId === product.productId);
        if (action !== "review" && actual?.inputHash === product.inputHash
          && actual.resultHash === product.resultHash && actual.draft?.candidateMatch
          && actual.draft.origin === "phase3_backfill"
          && actual.draft.definitionHash === product.candidateDefinitionHash) {
          // A lost response (or another operator) may have converged this row. Do not claim a new audit write.
          result.status = "already_current";
          result.code = "INVENTORY_CATALOG_BATCH_ALREADY_CURRENT";
          result.message = "The exact deterministic draft is already current; no write attempted.";
          result.modelId = actual.draft.modelId;
        } else if (action === "review") {
          const draft = product.draft!;
          const reviewed = await this.backfill.reviewProductDraft(product.productId, {
            expectedModelId: draft.modelId, expectedModelVersion: draft.version,
            expectedDefinitionHash: draft.definitionHash, expectedHeadRevision: draft.headRevision,
            expectedLatestReviewId: product.expectedLatestReviewId,
            decision: request.decision, reason: request.reason, idempotencyKey,
          }, actor);
          result.status = reviewed.alreadyApplied ? "replayed" : "applied";
          result.modelId = reviewed.review.modelId;
          result.reviewId = reviewed.review.reviewId;
          result.code = "INVENTORY_CATALOG_BATCH_REVIEW_RECORDED";
          result.message = reviewed.alreadyApplied ? "Original review receipt returned; no new review recorded."
            : "Review recorded against the exact model, version and definition.";
        } else {
          const evidence = { expectedInputHash: product.inputHash, expectedResultHash: product.resultHash,
            changeReason: request.reason, idempotencyKey };
          const draft = product.draft;
          const saved = action === "create"
            ? await this.backfill.applyProductDraft(product.productId, evidence, actor)
            : await this.backfill.refreshProductDraft(product.productId, draft!.modelId, {
              ...evidence, expectedDraftVersion: draft!.version,
              expectedDraftDefinitionHash: draft!.definitionHash, expectedDraftHeadRevision: draft!.headRevision,
              expectedDraftOriginInputHash: draft!.originInputHash,
              expectedDraftOriginResultHash: draft!.originResultHash,
            }, actor);
          result.status = saved.alreadyApplied ? "replayed" : "applied";
          result.modelId = saved.modelId;
          result.code = "INVENTORY_CATALOG_BATCH_DRAFT_SAVED";
          result.message = "Deterministic draft saved. A separate review is still required.";
        }
      } catch (error) {
        Object.assign(result, classifyFailure(error));
        aborted = result.failureClass === "fatal";
        if (aborted) this.log({ level: "error", action: "inventory_catalog_batch.failure",
          outcome: "aborted", previewHash, productId: product.productId,
          error_code: result.code, error: error instanceof Error ? error.message : "Non-Error failure" });
      }
      rows.push(result);
      this.log({ level: result.status === "failed" ? (aborted ? "error" : "debug") : "info",
        action: "inventory_catalog_batch.product", outcome: result.status, actor, previewHash,
        idempotencyKey, productId: product.productId, before: product.draft, after: result,
        error_code: result.status === "failed" ? result.code : undefined });
    }
    return inventoryCatalogBatchResultSchema.parse({ previewHash, rows,
      runtimeAuthorityChanged: false, inventoryWriteAttempted: false, providerWriteAttempted: false });
  }
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function parse<T extends z.ZodTypeAny>(schema: T, input: unknown): z.output<T> {
  const result = schema.safeParse(input);
  if (!result.success) throw new InventoryAvailabilityMasterDataError(400,
    "INVENTORY_CATALOG_BATCH_INVALID_INPUT", "Review the batch fields.",
    result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`));
  return result.data;
}

function classifyFailure(error: unknown): Pick<ResultRow, "status" | "code" | "message" | "failureClass"> {
  if (error instanceof InventoryAvailabilityMasterDataError && error.status < 500) return {
    status: "failed", code: error.code, message: error.message, failureClass: "permanent",
  };
  const code = error && typeof error === "object" && "code" in error ? error.code : null;
  if (code === "40001" || code === "40P01") return { status: "failed",
    code: "INVENTORY_CATALOG_BATCH_CONCURRENT_CHANGE", message: "Concurrent write; retry the unchanged preview.",
    failureClass: "transient" };
  if (code === "23505" || code === "23503" || code === "23514") return { status: "failed",
    code: "INVENTORY_CATALOG_BATCH_REFERENCE_CHANGED", message: "Catalog evidence changed. Generate a new preview.",
    failureClass: "permanent" };
  return { status: "failed", code: "INVENTORY_CATALOG_BATCH_UNEXPECTED_FAILURE",
    message: "Unexpected failure; batch stopped. Check server diagnostics before retrying.", failureClass: "fatal" };
}
