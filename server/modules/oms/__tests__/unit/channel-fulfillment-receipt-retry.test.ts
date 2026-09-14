import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";
import {
  previewChannelFulfillmentReceiptRetry,
  receiptRetryIdempotencyKey,
  type ChannelFulfillmentReceiptRetrySnapshot,
} from "../../channel-fulfillment-receipt-retry.domain";
import { createChannelFulfillmentReceiptRetryService } from "../../channel-fulfillment-receipt-retry.service";
import type { ChannelFulfillmentReceiptRetryRepository } from "../../channel-fulfillment-receipt-retry.repository";
import { createChannelFulfillmentReceiptRetryRepository } from "../../channel-fulfillment-receipt-retry.repository";
import { remediateOmsFlowIssue } from "../../oms-flow-reconciliation.service";
import { CHANNEL_FULFILLMENT_RECEIPT_RETRY } from "../../channel-fulfillment-receipt-retry.domain";

const NOW = new Date("2026-09-14T12:00:00.000Z");

function snapshot(
  overrides: Partial<ChannelFulfillmentReceiptRetrySnapshot> = {},
): ChannelFulfillmentReceiptRetrySnapshot {
  return {
    receiptId: 1917105,
    receiptKey: "shopify:fulfillment:6404748411039:create",
    requestHash: "a".repeat(64),
    sourceProvider: "shopify",
    sourceOrderId: "12252735242399",
    sourceFulfillmentId: "6404748411039",
    sourceEventId: "6404748411039",
    eventKind: "created",
    processingStatus: "review",
    attemptCount: 1,
    retryFailureCount: 0,
    leaseToken: null,
    leaseExpiresAt: null,
    errorCode: "INVENTORY_RECORD_FAILED",
    errorMessage: "Legacy shipment recording requires a valid source location.",
    processedAt: "2026-09-10T19:27:20.000Z",
    omsOrderId: 852106,
    orderNumber: "#62922",
    externalOrderId: "12252735242399",
    physicalShipmentId: 3804,
    trackingNumber: "1Z999",
    physicalShipmentStatus: "shipped",
    items: [{
      receiptItemId: 1,
      sourceFulfillmentLineId: "118226",
      channelOrderLineId: "118226",
      quantity: 4,
      omsOrderLineId: 118226,
      omsOrderId: 852106,
      omsChannelOrderLineId: "118226",
      omsProductVariantId: 510,
      omsSku: "SHOPIFY-WWP",
      omsRequiresShipping: false,
      omsPaidQuantity: 4,
      omsMaxPaidQuantity: 4,
      wmsOrderItemId: 320588,
      wmsOrderId: 208252,
      wmsOmsOrderLineId: 118226,
      wmsProductId: 510,
      wmsSku: "SHOPIFY-WWP",
      wmsQuantity: 4,
      wmsPickedQuantity: 4,
      wmsFulfilledQuantity: 4,
      wmsItemStatus: "completed",
      wmsRequiresShipping: 0,
      wmsItemOnHold: false,
      wmsOrderStatus: "partially_shipped",
      wmsOrderOnHold: 0,
      catalogVariantId: 510,
      catalogProductId: 364,
      catalogSku: "SHOPIFY-WWP",
      catalogIsActive: false,
      catalogRequiresShipping: false,
      catalogTrackInventory: false,
      sourceShipmentItemId: 22298,
      sourceShipmentId: 17240,
      sourceOrderItemId: 320588,
      sourceHeaderOrderId: 208252,
      sourceReplacementForOrderItemId: null,
      sourceCorrectionForShipmentItemId: null,
      sourceProductVariantId: 510,
      sourceQuantity: 4,
      sourcePurpose: "customer_fulfillment",
      sourceFromLocationId: null,
      sourceShipmentStatus: "shipped",
      sourceShipmentHeld: false,
      physicalShipmentItemId: 9092,
      physicalShipmentId: 3804,
      physicalOrderItemId: 320588,
      physicalLegacySourceShipmentItemId: 22298,
      physicalReplacementForOrderItemId: null,
      physicalCorrectionForShipmentItemId: null,
      physicalPackageAllocationEntryId: null,
      physicalProductVariantId: 510,
      physicalSku: "SHOPIFY-WWP",
      physicalQuantity: 4,
      physicalAdjustmentQuantity: 0,
      physicalPurpose: "customer_fulfillment",
      physicalShipmentStatus: "shipped",
      inventoryTransactionCount: 0,
    }],
    ...overrides,
  };
}

function repositoryFixture(initial = snapshot(), failUpdate = false) {
  let current = structuredClone(initial);
  let audit: Record<string, any> | null = null;
  const calls: string[] = [];
  const dialect = new PgDialect();
  const execute = vi.fn(async (query: SQL) => {
    const { sql: text } = dialect.sqlToQuery(query);
    calls.push(text);
    if (text.includes("SELECT jsonb_build_object")) {
      return { rows: [{ snapshot: structuredClone(current) }] };
    }
    if (text.includes("FROM public.audit_events")) {
      return { rows: audit ? [structuredClone(audit)] : [] };
    }
    if (text.includes("UPDATE oms.channel_fulfillment_receipts")) {
      if (failUpdate) throw Object.assign(new Error("simulated state race"), { code: "40001" });
      current = {
        ...current,
        processingStatus: "pending",
        errorCode: null,
        errorMessage: null,
        processedAt: null,
      };
      return { rows: [{ id: current.receiptId }] };
    }
    throw new Error(`Unexpected receipt retry query: ${text}`);
  });
  const insert = vi.fn(() => ({
    values: vi.fn(async (value: Record<string, unknown>) => {
      audit = structuredClone(value);
    }),
  }));
  const transaction = vi.fn(async <T>(
    work: (tx: { execute: typeof execute; insert: typeof insert }) => Promise<T>,
  ): Promise<T> => {
    const before = structuredClone(current);
    const priorAudit = structuredClone(audit);
    try {
      return await work({ execute, insert });
    } catch (error) {
      current = before;
      audit = priorAudit;
      throw error;
    }
  });
  const repository = createChannelFulfillmentReceiptRetryRepository({
    execute,
    insert,
    transaction,
  } as never);
  return {
    repository,
    execute,
    insert,
    transaction,
    calls,
    current: () => current,
    audit: () => audit,
  };
}

function execution(current = snapshot()) {
  return {
    receiptId: current.receiptId,
    expectedStateFingerprint: previewChannelFulfillmentReceiptRetry(current).stateFingerprint,
    actor: "user:7",
    reason: "Retry the exact non-inventory fulfillment after the policy correction",
    requeuedAt: NOW,
  };
}

describe("reviewed inbound channel fulfillment receipt retry", () => {
  it("accepts exact retired non-inventory lineage without reactivating the catalog variant", () => {
    const current = snapshot();
    const preview = previewChannelFulfillmentReceiptRetry(current);

    expect(preview).toMatchObject({
      receiptId: 1917105,
      eligibleForRetry: true,
      blockers: [],
      inventoryImpact: "none",
      providerValidation: "not_performed",
      snapshot: {
        orderNumber: "#62922",
        trackingNumber: "1Z999",
        items: [{ catalogVariantId: 510, catalogIsActive: false }],
      },
    });
    expect(current.items[0]!.catalogIsActive).toBe(false);
  });

  it.each([
    ["non-review state", (value: ChannelFulfillmentReceiptRetrySnapshot) => { value.processingStatus = "processed"; }, "RECEIPT_NOT_IN_REVIEW"],
    ["active lease", (value: ChannelFulfillmentReceiptRetrySnapshot) => { value.leaseToken = "worker"; }, "RECEIPT_HAS_ACTIVE_LEASE"],
    ["unsupported error", (value: ChannelFulfillmentReceiptRetrySnapshot) => { value.errorCode = "OTHER"; }, "REVIEW_REASON_NOT_SUPPORTED"],
    ["variant mismatch", (value: ChannelFulfillmentReceiptRetrySnapshot) => { value.items[0]!.physicalProductVariantId = 414; }, "LINE_IDENTITY_CONFLICT"],
    ["quantity mismatch", (value: ChannelFulfillmentReceiptRetrySnapshot) => { value.items[0]!.sourceQuantity = 3; }, "LINE_QUANTITY_CONFLICT"],
    ["source bin", (value: ChannelFulfillmentReceiptRetrySnapshot) => { value.items[0]!.sourceFromLocationId = 17; }, "LINE_FULFILLMENT_STATE_CONFLICT"],
    ["replacement lineage", (value: ChannelFulfillmentReceiptRetrySnapshot) => { value.items[0]!.physicalReplacementForOrderItemId = 99; }, "LINE_FULFILLMENT_STATE_CONFLICT"],
    ["correction lineage", (value: ChannelFulfillmentReceiptRetrySnapshot) => { value.items[0]!.physicalCorrectionForShipmentItemId = 99; }, "LINE_FULFILLMENT_STATE_CONFLICT"],
    ["package-allocation authority", (value: ChannelFulfillmentReceiptRetrySnapshot) => { value.items[0]!.physicalPackageAllocationEntryId = 99; }, "LINE_FULFILLMENT_STATE_CONFLICT"],
    ["quantity adjustment", (value: ChannelFulfillmentReceiptRetrySnapshot) => { value.items[0]!.physicalAdjustmentQuantity = -1; }, "LINE_QUANTITY_CONFLICT"],
    ["tracked item", (value: ChannelFulfillmentReceiptRetrySnapshot) => {
      value.items[0]!.omsRequiresShipping = true;
      value.items[0]!.wmsRequiresShipping = 1;
      value.items[0]!.catalogRequiresShipping = true;
      value.items[0]!.catalogTrackInventory = true;
    }, "INVENTORY_POSTING_REQUIRED"],
    ["prior inventory write", (value: ChannelFulfillmentReceiptRetrySnapshot) => { value.items[0]!.inventoryTransactionCount = 1; }, "INVENTORY_TRANSACTION_EXISTS"],
  ])("blocks %s", (_name, mutate, blocker) => {
    const current = structuredClone(snapshot());
    mutate(current);
    const preview = previewChannelFulfillmentReceiptRetry(current);
    expect(preview.eligibleForRetry).toBe(false);
    expect(preview.blockers).toContain(blocker);
  });

  it("rejects duplicate physical lineage and makes evidence changes alter the fingerprint", () => {
    const current = snapshot();
    current.items.push({ ...current.items[0]!, receiptItemId: 2 });
    const duplicate = previewChannelFulfillmentReceiptRetry(current);
    expect(duplicate.blockers).toContain("DUPLICATE_OMS_LINE");
    expect(duplicate.blockers).toContain("DUPLICATE_PHYSICAL_ITEM");

    const original = previewChannelFulfillmentReceiptRetry(snapshot());
    const changed = snapshot();
    changed.items[0]!.catalogIsActive = true;
    expect(previewChannelFulfillmentReceiptRetry(changed).stateFingerprint)
      .not.toBe(original.stateFingerprint);
  });

  it("defaults to preview and requires fingerprint plus a meaningful reason for execution", async () => {
    const preview = previewChannelFulfillmentReceiptRetry(snapshot());
    const repository: ChannelFulfillmentReceiptRetryRepository = {
      preview: vi.fn(async () => preview),
      requeue: vi.fn(async () => ({ ...preview, mode: "execute", replayed: false, requeued: true })),
    };
    const clock = { now: vi.fn(() => NOW) };
    const service = createChannelFulfillmentReceiptRetryService({ repository, clock });

    await expect(service.review({ receiptId: 1917105 }, "user:7")).resolves.toMatchObject({
      mode: "preview",
      requeued: false,
    });
    expect(repository.requeue).not.toHaveBeenCalled();
    await expect(service.review({ receiptId: 1917105, previewOnly: false }, "user:7"))
      .rejects.toMatchObject({ code: "INVALID_RECEIPT_RETRY_INPUT", status: 400 });

    await expect(service.review({
      receiptId: 1917105,
      previewOnly: false,
      expectedStateFingerprint: preview.stateFingerprint,
      reason: "Re-run exact non-inventory fulfillment after the policy correction",
    }, "user:7")).resolves.toMatchObject({ mode: "execute", requeued: true });
    expect(repository.requeue).toHaveBeenCalledWith({
      receiptId: 1917105,
      expectedStateFingerprint: preview.stateFingerprint,
      actor: "user:7",
      reason: "Re-run exact non-inventory fulfillment after the policy correction",
      requeuedAt: NOW,
    });
  });

  it("binds idempotency to actor, reason, receipt and exact state, but not execution time", () => {
    const base = {
      receiptId: 1917105,
      expectedStateFingerprint: "a".repeat(64),
      actor: "user:7",
      reason: "Retry the exact reviewed non-inventory receipt",
      requeuedAt: NOW,
    };
    expect(receiptRetryIdempotencyKey(base)).toBe(receiptRetryIdempotencyKey({
      ...base,
      requeuedAt: new Date(NOW.getTime() + 1),
    }));
    for (const changed of [
      { receiptId: 2 },
      { expectedStateFingerprint: "b".repeat(64) },
      { actor: "user:8" },
      { reason: "A different reviewed recovery decision" },
    ]) {
      expect(receiptRetryIdempotencyKey({ ...base, ...changed }))
        .not.toBe(receiptRetryIdempotencyKey(base));
    }
  });

  it("routes the Ops remediation code only through the inbound receipt owner", async () => {
    const preview = previewChannelFulfillmentReceiptRetry(snapshot());
    const review = vi.fn(async () => ({
      ...preview,
      mode: "preview" as const,
      replayed: false,
      requeued: false,
    }));
    const result = await remediateOmsFlowIssue({}, {
      code: CHANNEL_FULFILLMENT_RECEIPT_RETRY,
      receiptId: 1917105,
      previewOnly: true,
      operator: "user:7",
    }, {
      reservation: null,
      fulfillmentAuthority: {} as never,
      receiptRetry: { review },
    });

    expect(review).toHaveBeenCalledWith({
      receiptId: 1917105,
      previewOnly: true,
      expectedStateFingerprint: undefined,
      reason: undefined,
    }, "user:7");
    expect(result).toMatchObject({
      code: CHANNEL_FULFILLMENT_RECEIPT_RETRY,
      action: "previewed_channel_receipt_retry",
      changed: false,
      omsOrderId: 852106,
      receiptRetry: { receiptId: 1917105 },
    });
  });

  it("captures preview in one read-only snapshot and performs no write", async () => {
    const fixture = repositoryFixture();

    await expect(fixture.repository.preview({ receiptId: 1917105 })).resolves.toMatchObject({
      eligibleForRetry: true,
      inventoryImpact: "none",
    });

    expect(fixture.transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: "repeatable read",
      accessMode: "read only",
    });
    expect(fixture.insert).not.toHaveBeenCalled();
    expect(fixture.calls).toHaveLength(1);
  });

  it("atomically audits and requeues only the exact reviewed receipt", async () => {
    const fixture = repositoryFixture();
    const input = execution();

    await expect(fixture.repository.requeue(input)).resolves.toMatchObject({
      mode: "execute",
      requeued: true,
      replayed: false,
      inventoryImpact: "none",
    });

    expect(fixture.transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: "serializable",
      accessMode: "read write",
    });
    expect(fixture.calls[0]).toContain("FOR UPDATE OF receipt");
    expect(fixture.audit()).toMatchObject({
      actor: "user:7",
      action: "oms.channel_fulfillment_receipt.review_requeued",
      target: "oms.channel_fulfillment_receipt:1917105",
      context: {
        reason: input.reason,
        expectedStateFingerprint: input.expectedStateFingerprint,
        inventoryTransactionCount: 0,
        inventoryImpact: "none",
      },
    });
    expect(fixture.current()).toMatchObject({
      processingStatus: "pending",
      attemptCount: 1,
      retryFailureCount: 0,
      errorCode: null,
      errorMessage: null,
    });
    const update = fixture.calls.find((query) => query.includes("UPDATE oms.channel_fulfillment_receipts"));
    expect(update).toContain("processing_status = 'pending'");
    expect(update).not.toMatch(/UPDATE\s+(?:inventory|catalog|wms)\./i);
  });

  it("rejects stale evidence without an audit and rolls audit back on a serializable failure", async () => {
    const stale = repositoryFixture();
    await expect(stale.repository.requeue({
      ...execution(),
      expectedStateFingerprint: "b".repeat(64),
    })).rejects.toMatchObject({ code: "RECEIPT_RETRY_STATE_CHANGED", status: 409 });
    expect(stale.audit()).toBeNull();
    expect(stale.current().processingStatus).toBe("review");

    const failed = repositoryFixture(snapshot(), true);
    await expect(failed.repository.requeue(execution())).rejects.toMatchObject({
      code: "RECEIPT_RETRY_DATABASE_ERROR",
      status: 503,
      context: { postgresCode: "40001", retryable: true },
    });
    expect(failed.audit()).toBeNull();
    expect(failed.current().processingStatus).toBe("review");
  });

  it("replays the exact audited action without issuing a second write", async () => {
    const fixture = repositoryFixture();
    const input = execution();
    await fixture.repository.requeue(input);
    const priorInsertCount = fixture.insert.mock.calls.length;

    await expect(fixture.repository.requeue(input)).resolves.toMatchObject({
      replayed: true,
      requeued: false,
    });

    expect(fixture.insert).toHaveBeenCalledTimes(priorInsertCount);
    expect(fixture.current().processingStatus).toBe("pending");
  });

  it("rejects missing audit identity and invalid execution time before database access", async () => {
    const fixture = repositoryFixture();
    await expect(fixture.repository.requeue({ ...execution(), actor: "unknown" }))
      .rejects.toMatchObject({ code: "INVALID_RECEIPT_RETRY_INPUT", status: 400 });
    await expect(fixture.repository.requeue({ ...execution(), requeuedAt: new Date("invalid") }))
      .rejects.toMatchObject({ code: "INVALID_RECEIPT_RETRY_INPUT", status: 400 });
    expect(fixture.execute).not.toHaveBeenCalled();
    expect(fixture.transaction).not.toHaveBeenCalled();
  });
});
