import {
  productMergeExecuteSchema,
  productMergePreviewSchema,
  productMergeRequestSchema,
  TERMINAL_PRODUCT_MERGE_STATUSES,
  type ProductMergeExecuteRequest,
  type ProductMergePreview,
  type ProductMergeResult,
  type ProductMergeRun,
  type ProductMergeRunOrder,
  type ProductMergeRunStatus,
} from "@shared/catalog/product-merge";
import {
  evaluateProductMerge,
  ordersToRelease,
  productMergeHash,
  productMergeRequestHash,
  type ProductMergeSnapshot,
  type ResolvedPair,
} from "../domain/product-merge";

/**
 * Orchestrates one product merge as a durable, resumable run:
 *
 *   releasing   → release the reservation of every open order on the source
 *   merging     → ONE database transaction: re-check the preview, move stock
 *                 through the ledger, re-point open order lines, PO lines,
 *                 supplier links and bins, archive the source, rename SKUs
 *   reclaiming  → re-reserve each released order (now on the target)
 *   completed | completed_with_review
 *
 * Why three steps instead of one transaction: canonical inventory claims own
 * their own SERIALIZABLE transaction and refuse to join another one
 * (CANONICAL_EXTERNAL_RESERVATION_TRANSACTION_UNSUPPORTED), and stock that is
 * reserved cannot be converted. The run row records every step, so a crash or
 * transient error resumes exactly where it stopped.
 *
 * If the merge transaction fails permanently (stale preview, new blocker,
 * stock still held by something other than these orders) nothing was moved;
 * the run compensates by re-reserving the released orders on the source and
 * ends as `failed`.
 */

export type MergeErrorClass = "transient" | "permanent";

export class ProductMergeError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode = 409,
    readonly classification: MergeErrorClass = "permanent",
    readonly context: Record<string, unknown> = {},
  ) { super(message); this.name = "ProductMergeError"; }
}

export interface ProductMergeRunRecord extends ProductMergeRun {
  idempotencyKey: string;
  requestHash: string;
  request: ProductMergeExecuteRequest;
  actor: string;
}

export interface ProductMergeRepository {
  loadSnapshot(sourceProductId: number, targetProductId: number): Promise<ProductMergeSnapshot>;
  findRunByKey(idempotencyKey: string): Promise<ProductMergeRunRecord | null>;
  findRun(runId: number): Promise<ProductMergeRunRecord | null>;
  /** Fails with MERGE_RUN_ACTIVE when another unfinished run touches either product. */
  createRun(input: {
    idempotencyKey: string; requestHash: string; sourceProductId: number; request: ProductMergeExecuteRequest;
    actor: string; orders: ProductMergeRunOrder[]; now: Date;
  }): Promise<ProductMergeRunRecord>;
  /** Optimistic update: applies only while the run is still in `expectedStatus`
   * and unchanged since `expectedUpdatedAt`; otherwise MERGE_RUN_CONCURRENT_UPDATE. */
  updateRun(run: Pick<ProductMergeRunRecord, "id" | "updatedAt">, expectedStatus: ProductMergeRunStatus, patch: {
    status?: ProductMergeRunStatus; orders?: ProductMergeRunOrder[]; result?: ProductMergeResult | null;
    errorCode?: string | null; errorMessage?: string | null;
  }, now: Date): Promise<ProductMergeRunRecord>;
  /**
   * The single merge transaction. Re-evaluates the merge from a locked
   * snapshot, rejects a changed preview (MERGE_PREVIEW_STALE), performs every
   * write, and moves the run from `merging` to `reclaiming` in the same commit.
   */
  merge(input: {
    run: ProductMergeRunRecord;
    evaluate: (snapshot: ProductMergeSnapshot) => { hash: string; blocked: boolean; pairs: ResolvedPair[] };
    now: Date;
  }): Promise<{ run: ProductMergeRunRecord; result: ProductMergeResult }>;
}

export interface ProductMergeReservations {
  /** Whole-order release. Returns how many held lines were released. */
  release(wmsOrderId: number, reason: string, actor: string): Promise<{ releasedLines: number }>;
  /** Whole-order claim against the order's current lines. */
  reclaim(wmsOrderId: number, reason: string, actor: string): Promise<{ failedLines: number }>;
}

export interface ProductMergeLogger {
  info(event: Record<string, unknown>): void;
  warn(event: Record<string, unknown>): void;
  error(event: Record<string, unknown>): void;
}

/** Postgres conditions that are safe to retry by resuming the run. */
const TRANSIENT_SQLSTATES = new Set(["40001", "40P01", "55P03", "57014", "08000", "08003", "08006"]);

export function classifyMergeFailure(error: unknown): ProductMergeError {
  if (error instanceof ProductMergeError) return error;
  const sqlState = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  const message = error instanceof Error ? error.message : String(error);
  if (typeof sqlState === "string" && TRANSIENT_SQLSTATES.has(sqlState)) {
    return new ProductMergeError("MERGE_TRANSIENT_DATABASE_ERROR", message, 503, "transient", { sqlState });
  }
  const code = typeof sqlState === "string" && /^[A-Z][A-Z0-9_]+$/.test(sqlState) ? sqlState : "MERGE_STEP_FAILED";
  return new ProductMergeError(code, message, 409, "permanent");
}

export class ProductMergeService {
  constructor(
    private readonly repository: ProductMergeRepository,
    private readonly reservations: ProductMergeReservations,
    private readonly clock: () => Date,
    private readonly logger: ProductMergeLogger,
  ) {}

  async preview(sourceProductId: number, rawRequest: unknown): Promise<ProductMergePreview> {
    const parsed = productMergeRequestSchema.safeParse(rawRequest);
    if (!parsed.success) throw new ProductMergeError("MERGE_INVALID_REQUEST", "Invalid merge request", 400);
    const snapshot = await this.repository.loadSnapshot(sourceProductId, parsed.data.targetProductId);
    const evaluation = evaluateProductMerge(sourceProductId, parsed.data, snapshot);
    return productMergePreviewSchema.parse({ ...evaluation.preview, previewHash: productMergeHash(evaluation.hashBasis) });
  }

  /** Start (or, with the same idempotency key, continue) a merge run. */
  async execute(sourceProductId: number, rawRequest: unknown, idempotencyKey: string, actor: string): Promise<ProductMergeRun> {
    const parsed = productMergeExecuteSchema.safeParse(rawRequest);
    if (!parsed.success) throw new ProductMergeError("MERGE_INVALID_REQUEST", "Invalid merge request", 400);
    const request = parsed.data;
    const requestHash = productMergeRequestHash(sourceProductId, request);

    const existing = await this.repository.findRunByKey(idempotencyKey);
    if (existing) {
      if (existing.requestHash !== requestHash) {
        throw new ProductMergeError("MERGE_IDEMPOTENCY_CONFLICT", "This idempotency key was used for a different merge", 409);
      }
      return this.advance(existing);
    }

    // Fail fast before touching reservations: the preview must still match.
    const snapshot = await this.repository.loadSnapshot(sourceProductId, request.targetProductId);
    const evaluation = evaluateProductMerge(sourceProductId, request, snapshot);
    if (evaluation.preview.status !== "ready") {
      throw new ProductMergeError("MERGE_BLOCKED", "The merge is blocked; review the preview", 409,
        "permanent", { blockers: evaluation.preview.blockers });
    }
    if (productMergeHash(evaluation.hashBasis) !== request.expectedPreviewHash) {
      throw new ProductMergeError("MERGE_PREVIEW_STALE", "The products changed since the preview; preview again", 409);
    }
    const sourceIds = new Set(snapshot.sourceVariants.map(variant => variant.id));
    const orders = ordersToRelease(snapshot.openOrderLines.filter(line => sourceIds.has(line.productVariantId)))
      .map(wmsOrderId => ({ wmsOrderId, released: null, reclaimed: null, errorCode: null, errorMessage: null }));

    const run = await this.repository.createRun({
      idempotencyKey, requestHash, sourceProductId, request, actor, orders, now: this.clock(),
    });
    this.log("info", run, "product_merge.started", { orderCount: orders.length });
    return this.advance(run);
  }

  async getRun(runId: number): Promise<ProductMergeRun> {
    const run = await this.repository.findRun(runId);
    if (!run) throw new ProductMergeError("MERGE_RUN_NOT_FOUND", "Merge run not found", 404);
    return publicRun(run);
  }

  async resume(runId: number): Promise<ProductMergeRun> {
    const run = await this.repository.findRun(runId);
    if (!run) throw new ProductMergeError("MERGE_RUN_NOT_FOUND", "Merge run not found", 404);
    return this.advance(run);
  }

  /** Drive the run forward until it is terminal or a transient error stops it. */
  private async advance(initial: ProductMergeRunRecord): Promise<ProductMergeRun> {
    let run = initial;
    for (let step = 0; step < productMergeRunStatusesInOrder.length + 1; step++) {
      if (TERMINAL_PRODUCT_MERGE_STATUSES.includes(run.status)) return publicRun(run);
      try {
        run = await this.step(run);
      } catch (raw) {
        const error = classifyMergeFailure(raw);
        // The step may have persisted progress before failing; always act on
        // the stored run, never on the copy this loop started with.
        const latest = (await this.repository.findRun(run.id)) ?? run;
        if (error.code === CONCURRENT_UPDATE || latest.status !== run.status) {
          // Another request is advancing this run; report its current state.
          return publicRun(latest);
        }
        this.log(error.classification === "transient" ? "warn" : "error", latest, "product_merge.step_failed",
          { errorCode: error.code, errorMessage: error.message, classification: error.classification });
        if (error.classification === "transient") {
          // Leave the status untouched so `resume` repeats this step.
          run = await this.repository.updateRun(latest, latest.status, { errorCode: error.code, errorMessage: error.message }, this.clock());
          return publicRun(run);
        }
        if (latest.status === "merging" || latest.status === "releasing") {
          run = await this.repository.updateRun(latest, latest.status,
            { status: "compensating", errorCode: error.code, errorMessage: error.message }, this.clock());
          continue;
        }
        throw error;
      }
    }
    return publicRun(run);
  }

  private async step(run: ProductMergeRunRecord): Promise<ProductMergeRunRecord> {
    switch (run.status) {
      case "releasing": return this.releaseOrders(run);
      case "merging": return this.mergeProducts(run);
      case "reclaiming": return this.reclaimOrders(run, "reclaiming");
      case "compensating": return this.reclaimOrders(run, "compensating");
      default: return run;
    }
  }

  private async releaseOrders(run: ProductMergeRunRecord): Promise<ProductMergeRunRecord> {
    const orders = [...run.orders];
    for (let index = 0; index < orders.length; index++) {
      if (orders[index].released !== null) continue;
      const { releasedLines } = await this.reservations.release(orders[index].wmsOrderId,
        `Product merge ${run.id}: move order to product ${run.targetProductId}`, run.actor);
      orders[index] = { ...orders[index], released: releasedLines > 0 };
      // Persist after every order so a crash never forgets a released hold.
      run = await this.repository.updateRun(run, "releasing", { orders }, this.clock());
    }
    return this.repository.updateRun(run, "releasing", { status: "merging", errorCode: null, errorMessage: null }, this.clock());
  }

  private async mergeProducts(run: ProductMergeRunRecord): Promise<ProductMergeRunRecord> {
    const { run: merged, result } = await this.repository.merge({
      run,
      evaluate: snapshot => {
        const evaluation = evaluateProductMerge(run.sourceProductId, run.request, snapshot);
        return { hash: productMergeHash(evaluation.hashBasis), blocked: evaluation.preview.status !== "ready",
          pairs: evaluation.pairs };
      },
      now: this.clock(),
    });
    this.log("info", merged, "product_merge.merged", { result });
    return merged;
  }

  /**
   * Re-reserve released orders. During `reclaiming` the lines already point at
   * the target; during `compensating` nothing moved, so the same call restores
   * the original reservation on the source. A per-order failure is recorded
   * for review instead of retried forever.
   */
  private async reclaimOrders(run: ProductMergeRunRecord, phase: "reclaiming" | "compensating"): Promise<ProductMergeRunRecord> {
    const orders = [...run.orders];
    for (let index = 0; index < orders.length; index++) {
      const order = orders[index];
      if (order.reclaimed !== null || order.released !== true) continue;
      try {
        const { failedLines } = await this.reservations.reclaim(order.wmsOrderId,
          `Product merge ${run.id}: ${phase === "reclaiming" ? "reserve on merged product" : "restore reservation after failed merge"}`,
          run.actor);
        orders[index] = { ...order, reclaimed: true,
          errorCode: failedLines > 0 ? "MERGE_RECLAIM_SHORT" : null,
          errorMessage: failedLines > 0 ? `${failedLines} line(s) could not be fully reserved` : null };
      } catch (raw) {
        const error = classifyMergeFailure(raw);
        if (error.classification === "transient") throw error;
        orders[index] = { ...order, reclaimed: false, errorCode: error.code, errorMessage: error.message };
      }
      run = await this.repository.updateRun(run, phase, { orders }, this.clock());
    }
    if (phase === "compensating") {
      return this.repository.updateRun(run, phase, { status: "failed" }, this.clock());
    }
    // An order whose release found nothing held was not re-reserved: surface it.
    const needsReview = orders.some(order => order.errorCode !== null || order.released === false);
    return this.repository.updateRun(run, phase,
      { status: needsReview ? "completed_with_review" : "completed", errorCode: null, errorMessage: null }, this.clock());
  }

  private log(level: keyof ProductMergeLogger, run: ProductMergeRunRecord, action: string, extra: Record<string, unknown>) {
    this.logger[level]({
      level, action, merge_run_id: run.id, source_product_id: run.sourceProductId,
      target_product_id: run.targetProductId, status: run.status, actor: run.actor, ...extra,
    });
  }
}

export const CONCURRENT_UPDATE = "MERGE_RUN_CONCURRENT_UPDATE";

const productMergeRunStatusesInOrder: ProductMergeRunStatus[] = ["releasing", "merging", "reclaiming", "compensating"];

function publicRun(run: ProductMergeRunRecord): ProductMergeRun {
  return {
    id: run.id, status: run.status, sourceProductId: run.sourceProductId, targetProductId: run.targetProductId,
    orders: run.orders, result: run.result, errorCode: run.errorCode, errorMessage: run.errorMessage,
    createdAt: run.createdAt, updatedAt: run.updatedAt,
  };
}
