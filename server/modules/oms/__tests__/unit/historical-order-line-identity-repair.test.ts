import { describe, expect, it, vi } from "vitest";

import {
  HistoricalOrderLineIdentityRepairService,
} from "../../application/historical-order-line-identity-repair.service";
import {
  assessHistoricalIdentityRepairLine,
  extractHistoricalRepairSourceLine,
  historicalIdentityRepairPreviewHash,
  HistoricalIdentityRepairError,
  type HistoricalIdentityRepairCommandRecord,
  type HistoricalRepairLineEvidence,
  type HistoricalRepairOrderAggregate,
} from "../../domain/historical-order-line-identity-repair";
import type { ResolvedOrderLineIdentity } from "../../domain/order-line-catalog-identity";
import type { HistoricalIdentityRepairRepository } from "../../infrastructure/historical-order-line-identity-repair.repository";

const NOW = new Date("2026-09-11T15:00:00.000Z");
const KEY = "ba01e537-6af2-46f1-bc92-9de0105aff19";

const identity: ResolvedOrderLineIdentity = Object.freeze({
  id: 11,
  sku: "EXAMPLE-P5",
  isActive: true,
  compareAtPriceCents: 2500,
  matchedBy: "channel_variant_id",
});

function lineEvidence(overrides: Partial<HistoricalRepairLineEvidence> = {}): HistoricalRepairLineEvidence {
  return Object.freeze({
    omsLine: Object.freeze({
      id: 21,
      orderId: 7,
      productVariantId: null,
      externalLineItemId: "9001",
      externalProductId: "1000",
      sourceSku: null,
      quantity: 2,
      requiresShipping: true,
      giftCard: false,
      productExists: true,
      authoritySourceInboxId: 31,
    }),
    wmsItems: Object.freeze([Object.freeze({
      id: 41,
      orderId: 51,
      warehouseStatus: "ready",
      productVariantId: null,
      sku: "UNKNOWN",
      quantity: 2,
      status: "pending",
      pickedQuantity: 0,
      fulfilledQuantity: 0,
    })]),
    sourceInbox: Object.freeze({
      id: 31,
      provider: "shopify",
      topic: "orders/updated",
      status: "succeeded",
      payload: {
        line_items: [{
          id: 9001,
          product_id: 1000,
          variant_id: 1001,
          sku: null,
          requires_shipping: true,
          gift_card: false,
          product_exists: true,
        }],
      },
    }),
    ...overrides,
  });
}

function aggregate(line = lineEvidence()): HistoricalRepairOrderAggregate {
  return Object.freeze({
    order: Object.freeze({
      id: 7,
      channelId: 2,
      status: "confirmed",
      fulfillmentStatus: "unfulfilled",
      financialStatus: "paid",
      linkedWmsOrderIds: Object.freeze([51]),
    }),
    lines: Object.freeze([line]),
  });
}

function claimResult() {
  return {
    reconciled: true,
    release: { released: 0, failed: [] },
    reservation: {
      orderId: 51,
      reserved: 1,
      promised: 0,
      failed: [],
      totalBaseUnits: 5,
      totalPromisedBaseUnits: 0,
    },
  };
}

function harness(options: {
  aggregate?: HistoricalRepairOrderAggregate;
  resolvedIdentity?: ResolvedOrderLineIdentity | null;
} = {}) {
  let command: HistoricalIdentityRepairCommandRecord | null = null;
  const repository = {
    transaction: vi.fn(async (work: (repository: HistoricalIdentityRepairRepository) => Promise<unknown>) =>
      work(repository as unknown as HistoricalIdentityRepairRepository)),
    acquireOrderLock: vi.fn(async () => undefined),
    loadOrderEvidence: vi.fn(async () => options.aggregate ?? aggregate()),
    resolveIdentity: vi.fn(async () => options.resolvedIdentity === undefined ? identity : options.resolvedIdentity),
    repairLine: vi.fn(async (input: any) => Object.freeze({
      omsOrderLineId: input.omsOrderLineId,
      wmsOrderItemId: input.wmsOrderItemId,
      previousOmsVariantId: input.previousOmsVariantId,
      productVariantId: input.identity.id,
      previousWmsVariantId: input.previousWmsVariantId,
      previousWmsSku: input.previousWmsSku,
      catalogSku: input.identity.sku,
    })),
    findCommand: vi.fn(async () => command),
    findCommandById: vi.fn(async () => command),
    insertCommand: vi.fn(async (input: any) => {
      command = Object.freeze({
        id: 61,
        omsOrderId: input.omsOrderId,
        wmsOrderId: input.wmsOrderId,
        idempotencyKey: input.idempotencyKey,
        requestHash: input.requestHash,
        previewHash: input.previewHash,
        operator: input.operator,
        reason: input.reason,
        status: "claim_pending" as const,
        targetOmsLineIds: Object.freeze([...input.targetOmsLineIds]),
        repairResult: input.repairResult,
        claimResult: null,
        lastErrorCode: null,
        lastError: null,
      });
      return command;
    }),
    recordPreparedEvent: vi.fn(async () => undefined),
    markCommandSucceeded: vi.fn(async (_commandId: number, claim: unknown) => {
      if (!command) throw new Error("fixture command missing");
      command = Object.freeze({ ...command, status: "succeeded" as const, claimResult: claim });
      return command;
    }),
    markCommandFailed: vi.fn(async (_commandId: number, code: string, message: string) => {
      if (!command) throw new Error("fixture command missing");
      command = Object.freeze({ ...command, status: "failed" as const, lastErrorCode: code, lastError: message });
    }),
    recordClaimEvent: vi.fn(async () => undefined),
  };
  const claimOwner = { reconcileOrderDemand: vi.fn(async () => claimResult()) };
  const service = new HistoricalOrderLineIdentityRepairService(
    repository as unknown as HistoricalIdentityRepairRepository,
    claimOwner,
    () => NOW,
  );
  return { service, repository, claimOwner, command: () => command };
}

describe("historical order-line identity repair domain", () => {
  it("extracts only the exact source line and retains missing source SKU", () => {
    const evidence = lineEvidence();
    expect(extractHistoricalRepairSourceLine(evidence.sourceInbox!, "9001")).toEqual({
      externalLineItemId: "9001",
      externalProductId: "1000",
      externalVariantId: "1001",
      sku: null,
    });
  });

  it.each([
    [{ line_items: [] }, /exactly one/],
    [{ line_items: [{ id: 9001, product_id: 1000, variant_id: null }] }, /variant_id is required/],
    [{ line_items: [{ id: 9001, product_id: 1000, variant_id: 1001, requires_shipping: false }] }, /not an active physical/],
    [{ line_items: [
      { id: 9001, product_id: 1000, variant_id: 1001 },
      { id: "9001", product_id: 1000, variant_id: 1001 },
    ] }, /exactly one/],
  ])("rejects incomplete or ambiguous source evidence %#", (payload, message) => {
    const evidence = lineEvidence();
    expect(() => extractHistoricalRepairSourceLine({ ...evidence.sourceInbox!, payload }, "9001"))
      .toThrow(message);
  });

  it("requires exact channel mapping and untouched WMS progress", () => {
    const evidence = lineEvidence();
    const source = extractHistoricalRepairSourceLine(evidence.sourceInbox!, "9001");
    expect(assessHistoricalIdentityRepairLine({
      order: aggregate().order,
      evidence,
      source,
      identity,
    })).toMatchObject({ disposition: "safe", code: "READY", resolvedVariantId: 11 });
    expect(assessHistoricalIdentityRepairLine({
      order: aggregate().order,
      evidence,
      source,
      identity: { ...identity, matchedBy: "sku" },
    })).toMatchObject({ disposition: "review", code: "CHANNEL_VARIANT_MAPPING_REQUIRED" });
    expect(assessHistoricalIdentityRepairLine({
      order: aggregate().order,
      evidence: lineEvidence({
        wmsItems: [{ ...evidence.wmsItems[0], pickedQuantity: 1 }],
      }),
      source,
      identity,
    })).toMatchObject({ disposition: "review", code: "WMS_PHYSICAL_PROGRESS_PRESENT" });
    expect(assessHistoricalIdentityRepairLine({
      order: aggregate().order,
      evidence: lineEvidence({
        wmsItems: [{ ...evidence.wmsItems[0], warehouseStatus: "picking" }],
      }),
      source,
      identity,
    })).toMatchObject({ disposition: "review", code: "WMS_ORDER_ACTIVE" });
    expect(assessHistoricalIdentityRepairLine({
      order: aggregate().order,
      evidence: lineEvidence({
        wmsItems: [{ ...evidence.wmsItems[0], quantity: 1 }],
      }),
      source,
      identity,
    })).toMatchObject({ disposition: "review", code: "DEMAND_QUANTITY_INVALID" });
  });

  it("hashes evidence deterministically and changes when physical progress changes", () => {
    const order = aggregate().order;
    const baseLine = assessHistoricalIdentityRepairLine({
      order,
      evidence: lineEvidence(),
      source: extractHistoricalRepairSourceLine(lineEvidence().sourceInbox!, "9001"),
      identity,
    });
    const first = historicalIdentityRepairPreviewHash({ order, lines: [baseLine] });
    const second = historicalIdentityRepairPreviewHash({ order: { ...order }, lines: [{ ...baseLine }] });
    const changed = historicalIdentityRepairPreviewHash({
      order,
      lines: [{ ...baseLine, pickedQuantity: 1 }],
    });
    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(changed).not.toBe(first);
  });
});

describe("historical order-line identity repair application service", () => {
  it("previews without any write or claim side effect", async () => {
    const h = harness();
    const preview = await h.service.preview(7);
    expect(preview).toMatchObject({
      contractVersion: 1,
      omsOrderId: 7,
      safeCount: 1,
      reviewCount: 0,
      generatedAt: NOW.toISOString(),
    });
    expect(preview.previewHash).toMatch(/^[0-9a-f]{64}$/);
    expect(h.repository.insertCommand).not.toHaveBeenCalled();
    expect(h.repository.repairLine).not.toHaveBeenCalled();
    expect(h.claimOwner.reconcileOrderDemand).not.toHaveBeenCalled();
  });

  it("revalidates the reviewed hash under an order lock before applying", async () => {
    const h = harness();
    await expect(h.service.apply(7, {
      expectedPreviewHash: "a".repeat(64),
      idempotencyKey: KEY,
      reason: "Repair the reviewed historical line",
    }, { operator: "user:7", userId: "7" })).rejects.toMatchObject({
      code: "REPAIR_PREVIEW_STALE",
      status: 409,
    });
    expect(h.repository.acquireOrderLock).toHaveBeenCalledWith(7);
    expect(h.repository.insertCommand).not.toHaveBeenCalled();
    expect(h.repository.repairLine).not.toHaveBeenCalled();
  });

  it("atomically prepares identity changes, then hands demand to the canonical claim owner", async () => {
    const h = harness();
    const preview = await h.service.preview(7);
    const result = await h.service.apply(7, {
      expectedPreviewHash: preview.previewHash,
      idempotencyKey: KEY,
      reason: "Repair the reviewed historical line",
    }, { operator: "user:7", userId: "7" });
    expect(result).toMatchObject({
      commandId: 61,
      status: "succeeded",
      idempotentReplay: false,
      repair: { omsOrderId: 7, wmsOrderId: 51, repairedLines: [{ catalogSku: "EXAMPLE-P5" }] },
      claim: { reconciled: true },
    });
    expect(h.repository.repairLine).toHaveBeenCalledWith(expect.objectContaining({
      omsOrderLineId: 21,
      wmsOrderItemId: 41,
      sourceEventId: `historical-line-identity-repair:${KEY}`,
    }));
    expect(h.claimOwner.reconcileOrderDemand).toHaveBeenCalledWith({
      orderId: 51,
      sourceEventId: `historical-line-identity-repair:${KEY}`,
      demandChanged: true,
      reason: "Historical order-line identity repair: Repair the reviewed historical line",
      userId: "7",
    });
    expect(h.repository.recordPreparedEvent).toHaveBeenCalledTimes(1);
    expect(h.repository.recordClaimEvent).toHaveBeenCalledWith(expect.objectContaining({
      initiatedBy: "user:7",
      reconciledBy: "user:7",
    }));
  });

  it("returns a completed command without reapplying identity or claims", async () => {
    const h = harness();
    const preview = await h.service.preview(7);
    const request = {
      expectedPreviewHash: preview.previewHash,
      idempotencyKey: KEY,
      reason: "Repair the reviewed historical line",
    };
    await h.service.apply(7, request, { operator: "user:7" });
    h.repository.repairLine.mockClear();
    h.claimOwner.reconcileOrderDemand.mockClear();
    const replay = await h.service.apply(7, request, { operator: "user:7" });
    expect(replay.idempotentReplay).toBe(true);
    expect(h.repository.repairLine).not.toHaveBeenCalled();
    expect(h.claimOwner.reconcileOrderDemand).not.toHaveBeenCalled();
  });

  it("persists a resumable failure after identity commit and retries only the claim handoff", async () => {
    const h = harness();
    const preview = await h.service.preview(7);
    h.claimOwner.reconcileOrderDemand.mockRejectedValueOnce(Object.assign(new Error("claim unavailable"), {
      code: "CANONICAL_DEMAND_RECONCILIATION_FAILED",
    }));
    const request = {
      expectedPreviewHash: preview.previewHash,
      idempotencyKey: KEY,
      reason: "Repair the reviewed historical line",
    };
    await expect(h.service.apply(7, request, { operator: "user:7" })).rejects.toMatchObject({
      code: "REPAIR_CLAIM_RECONCILIATION_FAILED",
      status: 503,
      context: { commandId: 61, identityRepairCommitted: true },
    });
    expect(h.command()).toMatchObject({ status: "failed", lastErrorCode: "CANONICAL_DEMAND_RECONCILIATION_FAILED" });
    h.repository.loadOrderEvidence.mockClear();
    h.repository.repairLine.mockClear();
    const retried = await h.service.apply(7, request, { operator: "user:7" });
    expect(retried).toMatchObject({ status: "succeeded", idempotentReplay: true });
    expect(h.repository.loadOrderEvidence).not.toHaveBeenCalled();
    expect(h.repository.repairLine).not.toHaveBeenCalled();
    expect(h.claimOwner.reconcileOrderDemand).toHaveBeenCalledTimes(2);
  });

  it("rejects reuse of an idempotency key with a different reviewed command", async () => {
    const h = harness();
    const preview = await h.service.preview(7);
    await h.service.apply(7, {
      expectedPreviewHash: preview.previewHash,
      idempotencyKey: KEY,
      reason: "Original reason",
    }, { operator: "user:7" });
    await expect(h.service.apply(7, {
      expectedPreviewHash: preview.previewHash,
      idempotencyKey: KEY,
      reason: "Different reason",
    }, { operator: "user:7" })).rejects.toBeInstanceOf(HistoricalIdentityRepairError);
    await expect(h.service.apply(7, {
      expectedPreviewHash: preview.previewHash,
      idempotencyKey: KEY,
      reason: "Different reason",
    }, { operator: "user:7" })).rejects.toMatchObject({ code: "REPAIR_IDEMPOTENCY_KEY_REUSED" });
  });

  it("refuses an order linked to more than one WMS order", async () => {
    const current = aggregate();
    const h = harness({
      aggregate: Object.freeze({
        ...current,
        order: Object.freeze({
          ...current.order,
          linkedWmsOrderIds: Object.freeze([51, 52]),
        }),
      }),
    });
    const preview = await h.service.preview(7);
    expect(preview).toMatchObject({
      safeCount: 0,
      reviewCount: 1,
      linkedWmsOrderIds: [51, 52],
      lines: [{ code: "WMS_ORDER_CARDINALITY_INVALID" }],
    });
    expect(h.repository.insertCommand).not.toHaveBeenCalled();
    expect(h.repository.repairLine).not.toHaveBeenCalled();
    expect(h.claimOwner.reconcileOrderDemand).not.toHaveBeenCalled();
  });
});
