import { describe, expect, it, vi } from "vitest";
import {
  ProductMergeError,
  ProductMergeService,
  classifyMergeFailure,
  type ProductMergeRepository,
  type ProductMergeReservations,
  type ProductMergeRunRecord,
} from "../../application/product-merge.service";
import { evaluateProductMerge, productMergeHash, type ProductMergeSnapshot } from "../../domain/product-merge";
import type { ProductMergeResult } from "@shared/catalog/product-merge";

const NOW = new Date("2026-11-09T20:00:00.000Z");
const clock = () => new Date(NOW);

function snapshot(): ProductMergeSnapshot {
  const v = (id: number, productId: number, sku: string, units: number) =>
    ({ id, productId, sku, name: sku, unitsPerVariant: units, isActive: true, trackInventory: true });
  const line = (wmsOrderId: number, variantId: number) => ({
    omsOrderId: wmsOrderId + 1000, omsLineId: wmsOrderId + 2000, wmsOrderId, wmsItemId: wmsOrderId + 3000,
    orderNumber: `#${wmsOrderId}`, warehouseStatus: "ready", productVariantId: variantId, quantity: 1,
    pickedQuantity: 0, fulfilledQuantity: 0, hasFulfillmentPlan: false,
  });
  return {
    source: { id: 101, sku: "SKU-BLU", name: "dup", status: "active", isActive: true },
    target: { id: 17, sku: "SKU", name: "real", status: "active", isActive: true },
    sourceVariants: [v(439, 101, "SKU-BLU-P25", 25)],
    targetVariants: [v(33, 17, "SKU-P25", 25)],
    stock: [{ productVariantId: 439, onHand: 32, reserved: 2, picked: 0, packed: 0 }],
    binAssignments: [], openOrderLines: [line(11, 439), line(12, 439)],
    purchaseLines: [], supplierLinks: [], sourceChannelLinks: 0,
    foreignActiveVariantSkus: [], foreignProductSkus: [],
    history: { shippedOrderLines: 0, inventoryTransactions: 0 },
  };
}

const RESULT: ProductMergeResult = {
  stockUnitsMoved: 32, stockLocationsMoved: 1, orderLinesMoved: 2, purchaseOrderLinesMoved: 0, supplierLinksMoved: 0,
  binAssignmentsMoved: 0, variantsRenamed: 1, sourceProductSku: "SKU-BLU-MERGED-101", targetProductSku: "SKU-BLU",
};

/** In-memory repository with the same optimistic-concurrency contract as Postgres. */
class FakeRepository implements ProductMergeRepository {
  runs: ProductMergeRunRecord[] = [];
  current = snapshot();
  mergeImpl: (run: ProductMergeRunRecord, decision: { hash: string; blocked: boolean }) => void = () => undefined;
  mergeCalls = 0;
  private tick = 0;
  private stamp() { return new Date(NOW.getTime() + ++this.tick).toISOString(); }

  async loadSnapshot() { return structuredClone(this.current); }
  async findRunByKey(key: string) { return this.runs.find(run => run.idempotencyKey === key) ?? null; }
  async findRun(id: number) { return this.runs.find(run => run.id === id) ?? null; }
  async createRun(input: Parameters<ProductMergeRepository["createRun"]>[0]) {
    if (this.runs.some(run => run.sourceProductId === input.sourceProductId && !["completed", "completed_with_review", "failed"].includes(run.status))) {
      throw new ProductMergeError("MERGE_RUN_ACTIVE", "active", 409);
    }
    const at = this.stamp();
    const run: ProductMergeRunRecord = {
      id: this.runs.length + 1, idempotencyKey: input.idempotencyKey, requestHash: input.requestHash, request: input.request,
      actor: input.actor, status: "releasing", sourceProductId: input.sourceProductId, targetProductId: input.request.targetProductId,
      orders: input.orders, result: null, errorCode: null, errorMessage: null, createdAt: at, updatedAt: at,
    };
    this.runs.push(run);
    return structuredClone(run);
  }
  async updateRun(ref: Pick<ProductMergeRunRecord, "id" | "updatedAt">, expectedStatus: ProductMergeRunRecord["status"],
    patch: Parameters<ProductMergeRepository["updateRun"]>[2]) {
    const index = this.runs.findIndex(run => run.id === ref.id);
    const stored = this.runs[index];
    if (!stored || stored.status !== expectedStatus || stored.updatedAt !== ref.updatedAt) {
      throw new ProductMergeError("MERGE_RUN_CONCURRENT_UPDATE", "concurrent", 409, "transient");
    }
    this.runs[index] = { ...stored, ...patch, updatedAt: this.stamp() } as ProductMergeRunRecord;
    return structuredClone(this.runs[index]);
  }
  async merge({ run, evaluate }: Parameters<ProductMergeRepository["merge"]>[0]) {
    this.mergeCalls++;
    const decision = evaluate(structuredClone(this.current));
    this.mergeImpl(run, decision);
    if (decision.blocked) throw new ProductMergeError("MERGE_BLOCKED", "blocked", 409);
    if (decision.hash !== run.request.expectedPreviewHash) throw new ProductMergeError("MERGE_PREVIEW_STALE", "stale", 409);
    const advanced = await this.updateRun(run, "merging", { status: "reclaiming", result: RESULT, errorCode: null, errorMessage: null });
    return { run: advanced, result: RESULT };
  }
}

function setup() {
  const repository = new FakeRepository();
  const calls: string[] = [];
  const reservations: ProductMergeReservations = {
    release: vi.fn(async (orderId: number) => { calls.push(`release:${orderId}`); return { releasedLines: 1 }; }),
    reclaim: vi.fn(async (orderId: number) => { calls.push(`reclaim:${orderId}`); return { failedLines: 0 }; }),
  };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const service = new ProductMergeService(repository, reservations, clock, logger);
  const previewHash = productMergeHash(evaluateProductMerge(101, { targetProductId: 17, adoptSourceSku: true }, snapshot()).hashBasis);
  const body = { targetProductId: 17, adoptSourceSku: true, expectedPreviewHash: previewHash };
  return { repository, reservations, calls, logger, service, body };
}

describe("ProductMergeService", () => {
  it("previews with a hash that the execute step accepts", async () => {
    const { service, body } = setup();
    const preview = await service.preview(101, { targetProductId: 17, adoptSourceSku: true });
    expect(preview.status).toBe("ready");
    expect(preview.previewHash).toBe(body.expectedPreviewHash);
  });

  it("rejects malformed input before reading anything", async () => {
    const { service, repository } = setup();
    const spy = vi.spyOn(repository, "loadSnapshot");
    await expect(service.preview(101, { targetProductId: "17" })).rejects.toMatchObject({ code: "MERGE_INVALID_REQUEST", statusCode: 400 });
    await expect(service.execute(101, { targetProductId: 17, adoptSourceSku: true }, "key-1", "user:1"))
      .rejects.toMatchObject({ code: "MERGE_INVALID_REQUEST" });
    expect(spy).not.toHaveBeenCalled();
  });

  it("releases every open order, merges once, then re-reserves in order", async () => {
    const { service, body, calls, repository } = setup();
    const run = await service.execute(101, body, "key-1", "user:1");
    expect(run.status).toBe("completed");
    expect(calls).toEqual(["release:11", "release:12", "reclaim:11", "reclaim:12"]);
    expect(repository.mergeCalls).toBe(1);
    expect(run.result).toEqual(RESULT);
    expect(run.orders).toEqual([
      { wmsOrderId: 11, released: true, reclaimed: true, errorCode: null, errorMessage: null },
      { wmsOrderId: 12, released: true, reclaimed: true, errorCode: null, errorMessage: null },
    ]);
  });

  it("refuses a stale preview without touching any reservation", async () => {
    const { service, body, reservations, repository } = setup();
    repository.current = { ...snapshot(), stock: [{ productVariantId: 439, onHand: 31, reserved: 0, picked: 0, packed: 0 }] };
    await expect(service.execute(101, body, "key-1", "user:1")).rejects.toMatchObject({ code: "MERGE_PREVIEW_STALE" });
    expect(reservations.release).not.toHaveBeenCalled();
    expect(repository.runs).toHaveLength(0);
  });

  it("refuses a blocked merge with the blockers in the error context", async () => {
    const { service, body, repository } = setup();
    repository.current = { ...snapshot(), sourceChannelLinks: 1 };
    await expect(service.execute(101, body, "key-1", "user:1")).rejects.toMatchObject({
      code: "MERGE_BLOCKED", context: { blockers: [expect.objectContaining({ code: "MERGE_SOURCE_CHANNEL_LINKED" })] },
    });
  });

  it("replays the same idempotency key without repeating any step", async () => {
    const { service, body, calls } = setup();
    const first = await service.execute(101, body, "key-1", "user:1");
    const second = await service.execute(101, body, "key-1", "user:1");
    expect(second).toEqual(first);
    expect(calls).toHaveLength(4);
  });

  it("rejects an idempotency key reused for a different merge", async () => {
    const { service, body } = setup();
    await service.execute(101, body, "key-1", "user:1");
    await expect(service.execute(101, { ...body, adoptSourceSku: false }, "key-1", "user:1"))
      .rejects.toMatchObject({ code: "MERGE_IDEMPOTENCY_CONFLICT" });
  });

  it("compensates a permanent merge failure by restoring the released holds", async () => {
    const { service, body, calls, repository } = setup();
    // An order appears between release and merge: the locked re-check sees a new hash.
    repository.mergeImpl = () => { repository.current = { ...snapshot(), openOrderLines: [...snapshot().openOrderLines,
      { ...snapshot().openOrderLines[0], wmsOrderId: 99, wmsItemId: 99, omsLineId: 99 }] }; };
    repository.mergeImpl = (() => {
      const original = repository.mergeImpl;
      return (run, decision) => { original(run, decision); throw new ProductMergeError("MERGE_PREVIEW_STALE", "stale", 409); };
    })();
    const run = await service.execute(101, body, "key-1", "user:1");
    expect(run.status).toBe("failed");
    expect(run.errorCode).toBe("MERGE_PREVIEW_STALE");
    expect(calls).toEqual(["release:11", "release:12", "reclaim:11", "reclaim:12"]);
    expect(run.result).toBeNull();
  });

  it("stops on a transient failure and resumes the same step later", async () => {
    const { service, body, repository, calls } = setup();
    let failures = 1;
    repository.mergeImpl = () => {
      if (failures-- > 0) throw Object.assign(new Error("could not serialize access"), { code: "40001" });
    };
    const stopped = await service.execute(101, body, "key-1", "user:1");
    expect(stopped.status).toBe("merging");
    expect(stopped.errorCode).toBe("MERGE_TRANSIENT_DATABASE_ERROR");
    const resumed = await service.resume(stopped.id);
    expect(resumed.status).toBe("completed");
    expect(resumed.errorCode).toBeNull();
    // Releases are not repeated on resume.
    expect(calls.filter(call => call.startsWith("release"))).toHaveLength(2);
  });

  it("resumes a release step that crashed half way without releasing twice", async () => {
    const { service, body, repository, reservations, calls } = setup();
    vi.mocked(reservations.release)
      .mockImplementationOnce(async orderId => { calls.push(`release:${orderId}`); return { releasedLines: 1 }; })
      .mockImplementationOnce(async () => { throw Object.assign(new Error("connection reset"), { code: "08006" }); });
    const stopped = await service.execute(101, body, "key-1", "user:1");
    expect(stopped.status).toBe("releasing");
    expect(stopped.orders.map(order => order.released)).toEqual([true, null]);
    const resumed = await service.resume(stopped.id);
    expect(resumed.status).toBe("completed");
    expect(calls.filter(call => call === "release:11")).toHaveLength(1);
    expect(repository.mergeCalls).toBe(1);
  });

  it("finishes with review when an order cannot be fully re-reserved, and never retries it", async () => {
    const { service, body, reservations } = setup();
    vi.mocked(reservations.reclaim)
      .mockResolvedValueOnce({ failedLines: 1 })
      .mockRejectedValueOnce(new ProductMergeError("ORDER_ITEM_VARIANT_MISSING", "missing", 409));
    const run = await service.execute(101, body, "key-1", "user:1");
    expect(run.status).toBe("completed_with_review");
    expect(run.orders).toEqual([
      expect.objectContaining({ wmsOrderId: 11, reclaimed: true, errorCode: "MERGE_RECLAIM_SHORT" }),
      expect.objectContaining({ wmsOrderId: 12, reclaimed: false, errorCode: "ORDER_ITEM_VARIANT_MISSING" }),
    ]);
    expect(await service.resume(run.id)).toEqual(run);
    expect(reservations.reclaim).toHaveBeenCalledTimes(2);
  });

  it("does not re-reserve an order that held nothing, and flags it for review", async () => {
    const { service, body, reservations } = setup();
    vi.mocked(reservations.release).mockResolvedValueOnce({ releasedLines: 0 });
    const run = await service.execute(101, body, "key-1", "user:1");
    expect(run.status).toBe("completed_with_review");
    expect(reservations.reclaim).toHaveBeenCalledTimes(1);
    expect(reservations.reclaim).toHaveBeenCalledWith(12, expect.any(String), "user:1");
  });

  it("reports the latest state when another request is advancing the same run", async () => {
    const { service, body, repository } = setup();
    repository.mergeImpl = (run) => {
      // Simulate a concurrent request that already advanced this run.
      const stored = repository.runs.find(candidate => candidate.id === run.id)!;
      stored.updatedAt = new Date(NOW.getTime() + 999).toISOString();
    };
    const run = await service.execute(101, body, "key-1", "user:1");
    expect(run.status).toBe("merging");
  });

  it("returns 404 for an unknown run", async () => {
    const { service } = setup();
    await expect(service.getRun(5)).rejects.toMatchObject({ code: "MERGE_RUN_NOT_FOUND", statusCode: 404 });
    await expect(service.resume(5)).rejects.toMatchObject({ code: "MERGE_RUN_NOT_FOUND" });
  });
});

describe("classifyMergeFailure", () => {
  it("treats serialization, deadlock, lock and connection errors as transient", () => {
    for (const code of ["40001", "40P01", "55P03", "08006"]) {
      expect(classifyMergeFailure(Object.assign(new Error("x"), { code })).classification).toBe("transient");
    }
  });
  it("treats domain and unknown errors as permanent", () => {
    expect(classifyMergeFailure(Object.assign(new Error("x"), { code: "CATALOG_STOCK_IN_USE" }))).toMatchObject({
      classification: "permanent", code: "CATALOG_STOCK_IN_USE" });
    expect(classifyMergeFailure(new Error("boom"))).toMatchObject({ classification: "permanent", code: "MERGE_STEP_FAILED" });
    expect(classifyMergeFailure(Object.assign(new Error("x"), { code: "23505" })).code).toBe("MERGE_STEP_FAILED");
  });
});
