import { z } from "zod";
import { productSyncStartSchema, productSyncWorkflowSchema, type ProductSyncStart, type ProductSyncWorkflow,
  type ProductSyncLinkScope } from "@shared/types/inventory-product-sync-workflow";
import type { InventoryProductSyncRequest, InventoryProductSyncReview } from "@shared/types/inventory-product-sync";
import { inventoryCutoverEvidenceHash } from "../domain/inventory-cutover-manifest";
import { missingProductSyncLinks, explainProductSyncLinks, productSyncLinksPending, PRODUCT_SYNC_WORKFLOW_LIMITS as L,
  type ProductSyncLinkCheck } from "../domain/product-sync-workflow";
import { InventoryProductSyncError, type InventoryProductSyncService } from "./inventory-product-sync.service";
import type { StockLinkService, StockLinkLogger } from "./stock-link.service";

export interface ProductSyncJob {
  idempotencyKey: string; productId: number; requestedBy: string; requestedAt: Date; updatedAt: Date;
  state: ProductSyncWorkflow["state"]; message: string; review: InventoryProductSyncReview;
  publicationCommand: InventoryProductSyncRequest | null; deadlineAt: Date; attempts: number; leaseToken: string | null;
}
export interface ProductSyncJobUpdate {
  state: ProductSyncJob["state"]; message: string; review: InventoryProductSyncReview;
  publicationCommand: InventoryProductSyncRequest | null; nextAttemptAt: Date;
}
export interface ProductSyncWorkflowStore {
  accept(command: ProductSyncStart, actor: string, hash: string, now: Date): Promise<ProductSyncJob>;
  read(key: string, actor: string): Promise<ProductSyncJob>;
  claim(now: Date, leaseToken: string): Promise<ProductSyncJob | null>;
  save(job: ProductSyncJob, update: ProductSyncJobUpdate, now: Date, release: boolean): Promise<void>;
  readLinkChecks(scope: ProductSyncLinkScope, now: Date): Promise<readonly ProductSyncLinkCheck[]>;
}
export interface ProductSyncWorkflowDeps {
  store: ProductSyncWorkflowStore;
  publication: Pick<InventoryProductSyncService, "review" | "sync" | "progress">;
  links: Pick<StockLinkService, "checkProduct">;
  clock(): Date; newLeaseToken(): string; enabled(): boolean; logger: StockLinkLogger;
}

/** Durable orchestration only. Existing stock-link and publication owners retain
 * all provider policies, transactional identity checks, quantities and delivery. */
export class ProductSyncWorkflowService {
  constructor(private readonly deps: ProductSyncWorkflowDeps) {}
  async start(input: unknown, actorInput: unknown): Promise<ProductSyncWorkflow> {
    const command = productSyncStartSchema.parse(input);
    const actor = z.string().trim().min(1).max(100).parse(actorInput);
    if (!this.deps.enabled()) throw new InventoryProductSyncError("PRODUCT_SYNC_WORKER_DISABLED", "Product inventory sync is paused by the server's inventory worker control.", 503);
    try {
      const job = await this.deps.store.accept(command, actor,
        inventoryCutoverEvidenceHash({ contract: "product_inventory_sync_workflow_v1", command, actor }), this.now());
      return await this.view(job);
    } catch (error) { throw outputFailure(error); }
  }
  async progress(keyInput: unknown, actorInput: unknown): Promise<ProductSyncWorkflow> {
    const key = z.string().uuid().parse(keyInput), actor = z.string().trim().min(1).max(100).parse(actorInput);
    try { return await this.view(await this.deps.store.read(key, actor)); }
    catch (error) { throw outputFailure(error); }
  }
  private async view(job: ProductSyncJob): Promise<ProductSyncWorkflow> {
    const delivery = job.state === "queued" ? await this.deps.publication.progress(job.idempotencyKey) : null;
    return productSyncWorkflowSchema.parse({ idempotencyKey: job.idempotencyKey, productId: job.productId,
      requestedBy: job.requestedBy, requestedAt: job.requestedAt.toISOString(), updatedAt: job.updatedAt.toISOString(),
      state: job.state, message: job.message, review: job.review, delivery });
  }
  async tick(): Promise<void> {
    if (!this.deps.enabled()) return;
    const job = await this.deps.store.claim(this.now(), this.deps.newLeaseToken());
    if (!job) return;
    try { await this.advance(job); }
    catch (error) {
      const code = error instanceof InventoryProductSyncError ? error.code : "PRODUCT_SYNC_WORKER_RETRY";
      const permanent = error instanceof z.ZodError || error instanceof InventoryProductSyncError &&
        ["PRODUCT_SYNC_COMMAND_CONFLICT", "PRODUCT_SYNC_EVIDENCE_INVALID", "PRODUCT_SYNC_RECEIPT_INVALID", "PRODUCT_SYNC_INCOMPLETE"].includes(error.code);
      (permanent ? this.deps.logger.error : this.deps.logger.warn)("inventory_product_sync_worker", { request_id: job.idempotencyKey,
        product_id: job.productId, actor: job.requestedBy, outcome: permanent ? "requires_review" : "retry", error_code: code });
      // Never replace a persisted command after an uncertain enqueue. The next
      // worker replays it, even if this attempt's response was lost after COMMIT.
      const current = await this.deps.store.read(job.idempotencyKey, job.requestedBy);
      if (current.leaseToken !== job.leaseToken) return; // A newer owner or a committed terminal transition wins.
      const stopped = permanent || this.now() >= job.deadlineAt;
      await this.save(current, { state: stopped ? "failed" : current.state,
        message: stopped ? "The sync could not be fully confirmed. Retry this same request to recover its outcome."
          : "Inventory sync is retrying after a temporary failure. Its original request is retained." }, true);
    }
  }
  private async advance(job: ProductSyncJob): Promise<void> {
    if (job.publicationCommand !== null) return this.publish(job);
    let review = await this.deps.publication.review({ productId: job.productId });
    if (review.blockers.length > 0) return this.save(job, { state: "blocked", review,
      message: review.blockers.join(" ") }, true);
    const scope = missingProductSyncLinks(review);
    if (scope.targets.length > 0) {
      const result = await this.deps.links.checkProduct(scope);
      if (result.summary.outcome !== "completed") throw new Error("The scoped stock-link pass did not complete.");
      review = await this.deps.publication.review({ productId: job.productId });
      const remaining = missingProductSyncLinks(review);
      const checks = await this.deps.store.readLinkChecks(remaining, this.now());
      review = explainProductSyncLinks(review, checks);
      if (productSyncLinksPending(checks, result.skippedTargets, this.now()) && this.now() < job.deadlineAt)
        return this.save(job, { state: "checking_links", review,
          message: "Checking this product's inventory links. Provider retries continue automatically." }, true);
    }
    if (!review.ready) return this.save(job, { state: "blocked", review,
      message: "No destination is ready to receive this product's inventory. Review the destination results." }, true);
    const publicationCommand = { productId: job.productId, idempotencyKey: job.idempotencyKey, expectedReviewHash: review.reviewHash };
    await this.save(job, { state: "publishing", review, publicationCommand,
      message: "Links checked. Queuing this product's inventory through ATP." }, false);
    return this.publish({ ...job, state: "publishing", review, publicationCommand });
  }
  private async publish(job: ProductSyncJob): Promise<void> {
    try {
      await this.deps.publication.sync(job.publicationCommand!, job.requestedBy);
      await this.save(job, { state: "queued", message: "Inventory queued through ATP. Waiting for channel verification." }, true);
    } catch (error) {
      if (error instanceof InventoryProductSyncError && error.code === "PRODUCT_SYNC_REVIEW_STALE") {
        // This rejection is transactional: no publication or receipt committed.
        return this.save(job, { state: "checking_links", publicationCommand: null,
          message: "Availability or settings changed. Recalculating with the current ATP rules." }, true);
      }
      throw error;
    }
  }
  private save(job: ProductSyncJob, change: Partial<ProductSyncJobUpdate>, release: boolean): Promise<void> {
    const now = this.now();
    return this.deps.store.save(job, { state: job.state, message: job.message, review: job.review,
      publicationCommand: job.publicationCommand, nextAttemptAt: new Date(now.getTime() + L.retryMs), ...change }, now, release);
  }
  private now(): Date { return z.date().parse(this.deps.clock()); }
}

function outputFailure(error: unknown): unknown {
  return error instanceof z.ZodError ? new InventoryProductSyncError("PRODUCT_SYNC_EVIDENCE_INVALID",
    "The saved inventory sync evidence could not be confirmed. Keep the same request and retry its status.", 503) : error;
}
