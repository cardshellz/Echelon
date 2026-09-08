import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import {
  previewChannelFulfillmentReviewRetry,
  reviewRetryIdempotencyKey,
  type ChannelFulfillmentReviewRetrySnapshot,
} from "../../channel-fulfillment-review-retry.domain";
import { createChannelFulfillmentReviewRetryRepository } from "../../channel-fulfillment-review-retry.repository";
import { createChannelFulfillmentReviewRetryService } from "../../channel-fulfillment-review-retry.service";

const NOW = new Date("2026-09-08T17:00:00.000Z");
function snapshot(overrides: Partial<ChannelFulfillmentReviewRetrySnapshot> = {}): ChannelFulfillmentReviewRetrySnapshot {
  return {
    commandId: 3024, omsOrderId: 901, orderNumber: "#SPLIT-1", externalOrderId: "640001",
    channelId: 12, provider: "shopify", physicalShipmentId: 101,
    providerPhysicalShipmentId: "44011", trackingNumber: "TRACK-B", carrier: "USPS",
    trackingUrl: null, shippedAt: null, channelFulfillmentScopeKey: "split-B", metadata: {},
    commandKey: "fulfillment:v1:split-B", requestHash: "a".repeat(64), status: "review",
    attemptCount: 1, maxAttempts: 12, lastErrorCode: "channel_fulfillment_lineage_mismatch",
    lastError: "The old adapter compared source2 with package1", leaseToken: null,
    items: [{
      pushItemId: 1, physicalShipmentItemId: 11, omsOrderLineId: 21,
      channelOrderLineId: "640002", quantity: 1, sku: "SKU-SPLIT",
    }],
    ...overrides,
  };
}

function fixture(initial = snapshot(), failUpdate = false) {
  let current = structuredClone(initial);
  let audit: Record<string, unknown> | null = null;
  const calls: string[] = [];
  const dialect = new PgDialect();
  const execute = vi.fn(async (query: SQL) => {
    const { sql: text, params } = dialect.sqlToQuery(query);
    calls.push(text);
    if (text.includes("SELECT jsonb_build_object")) {
      return { rows: params[0] === current.commandId && params[1] === current.omsOrderId
        ? [{ snapshot: structuredClone(current) }] : [] };
    }
    if (text.includes("SELECT operator, reason")) {
      return { rows: audit?.idempotency_key === params[1] ? [structuredClone(audit)] : [] };
    }
    if (text.includes("INSERT INTO oms.channel_fulfillment_push_requeues")) {
      audit = {
        idempotency_key: params[1], operator: params[2], reason: params[3],
        previous_status: params[4], previous_attempt_count: params[5],
        previous_error_code: params[6], previous_error_message: params[7],
        previous_request_hash: params[8], created_at: params[9],
      };
      return { rows: [{ id: 1 }] };
    }
    if (text.includes("UPDATE oms.channel_fulfillment_pushes")) {
      if (failUpdate) throw Object.assign(new Error("simulated update failure"), { code: "40001" });
      current = { ...current, status: "pending", lastErrorCode: null, lastError: null };
      return { rows: [{ id: current.commandId }] };
    }
    throw new Error(`Unexpected owner query: ${text}`);
  });
  const transaction = vi.fn(async <T>(work: (tx: { execute: typeof execute }) => Promise<T>): Promise<T> => {
    const before = structuredClone(current);
    const previousAudit = structuredClone(audit);
    try { return await work({ execute }); }
    catch (error) { current = before; audit = previousAudit; throw error; }
  });
  const repository = createChannelFulfillmentReviewRetryRepository({ execute, transaction });
  const clock = { now: vi.fn(() => NOW) };
  return {
    repository,
    service: createChannelFulfillmentReviewRetryService({ repository, clock }),
    clock, execute, transaction, calls,
    current: () => current,
    audit: () => audit,
    advance: (next: Partial<ChannelFulfillmentReviewRetrySnapshot>) => { current = { ...current, ...next }; },
    corruptAudit: (next: Record<string, unknown>) => { audit = { ...audit, ...next }; },
  };
}

function execution(current = snapshot()) {
  return {
    commandId: current.commandId, omsOrderId: current.omsOrderId,
    expectedStateFingerprint: previewChannelFulfillmentReviewRetry(current).stateFingerprint,
    actor: "user:7", reason: "Recheck after the reviewed provider correction", requeuedAt: NOW,
  };
}

describe("reviewed channel fulfillment retry", () => {
  it("defaults to read-only preview with exact human and immutable package evidence", async () => {
    const f = fixture();
    const result = await f.service.review({ commandId: 3024, omsOrderId: 901 }, "user:7");
    expect(result).toMatchObject({
      mode: "preview", eligibleForRecheck: true, requeued: false, replayed: false,
      providerValidation: "not_performed", snapshot: { orderNumber: "#SPLIT-1", trackingNumber: "TRACK-B" },
    });
    expect(f.transaction).not.toHaveBeenCalled();
    expect(f.clock.now).not.toHaveBeenCalled();
    expect(f.calls).toHaveLength(1);
    expect(f.current().status).toBe("review");
    expect(f.audit()).toBeNull();
  });

  it.each([
    [{ commandId: 0, omsOrderId: 901 }],
    [{ commandId: "3024", omsOrderId: 901 }],
    [{ commandId: 3024, omsOrderId: 901, previewOnly: "false" }],
    [{ commandId: 3024, omsOrderId: 901, previewOnly: false }],
    [{ commandId: 3024, omsOrderId: 901, previewOnly: false, expectedStateFingerprint: "a".repeat(64), reason: " " }],
    [{ commandId: 3024, omsOrderId: 901, commandIds: [3024, 3025] }],
  ])("rejects invalid or broad input before repository access: %j", async (input) => {
    const f = fixture();
    await expect(f.service.review(input, "user:7")).rejects.toMatchObject({ code: "INVALID_REVIEW_RETRY_INPUT", status: 400 });
    expect(f.execute).not.toHaveBeenCalled();
  });

  it.each(["success", "ignored", "dead", "pending", "processing", "retry"])("does not reopen %s commands", async (status) => {
    const f = fixture(snapshot({ status }));
    await expect(f.repository.requeue(execution(f.current()))).rejects.toMatchObject({ code: "REVIEW_RETRY_NOT_ELIGIBLE" });
    expect(f.audit()).toBeNull();
    expect(f.current().status).toBe(status);
  });

  it.each([
    { lastErrorCode: "COMMAND_REQUEST_CONFLICT" },
    { provider: "ebay", lastErrorCode: "channel_fulfillment_lineage_mismatch" },
    { provider: "shopify", lastErrorCode: "ebay_fulfillment_idempotency_conflict" },
    { attemptCount: 12 },
    { leaseToken: "active-worker" },
    { items: [] },
  ])("retains unsupported, exhausted, leased or empty review state: %j", async (overrides) => {
    const f = fixture(snapshot(overrides));
    await expect(f.repository.requeue(execution(f.current()))).rejects.toMatchObject({ code: "REVIEW_RETRY_NOT_ELIGIBLE" });
    expect(f.audit()).toBeNull();
    expect(f.current().status).toBe("review");
  });

  it("allows the known eBay error class for recheck without claiming its subtype is proven", () => {
    expect(previewChannelFulfillmentReviewRetry(snapshot({
      provider: "ebay", lastErrorCode: "ebay_fulfillment_idempotency_conflict",
    }))).toMatchObject({ eligibleForRecheck: true, providerValidation: "not_performed" });
  });

  it("locks one exact command/order, records the prior state and enqueues without resetting attempts", async () => {
    const f = fixture();
    const before = structuredClone(f.current());
    await expect(f.repository.requeue(execution(before))).resolves.toMatchObject({ mode: "execute", requeued: true, replayed: false });
    expect(f.calls[0]).toContain("FOR UPDATE OF command");
    expect(f.audit()).toMatchObject({
      operator: "user:7", reason: execution().reason, previous_status: "review",
      previous_attempt_count: 1, previous_error_code: before.lastErrorCode,
      previous_error_message: before.lastError, previous_request_hash: before.requestHash,
    });
    expect(f.current()).toEqual({ ...before, status: "pending", lastErrorCode: null, lastError: null });
    const update = f.calls.find((query) => query.includes("UPDATE oms.channel_fulfillment_pushes"));
    expect(update?.split("WHERE")[0]).not.toMatch(/attempt_count\s*=|request_hash\s*=/);
  });

  it("rejects stale state and wrong order without an audit or update", async () => {
    const f = fixture();
    await expect(f.repository.requeue({ ...execution(), expectedStateFingerprint: "b".repeat(64) })).rejects.toMatchObject({ code: "REVIEW_RETRY_STATE_CHANGED" });
    await expect(f.repository.requeue({ ...execution(), omsOrderId: 902 })).rejects.toMatchObject({ code: "REVIEW_RETRY_COMMAND_NOT_FOUND" });
    expect(f.audit()).toBeNull();
  });

  it("rolls the audit back when updating the command fails", async () => {
    const f = fixture(snapshot(), true);
    await expect(f.repository.requeue(execution())).rejects.toMatchObject({
      code: "REVIEW_RETRY_DATABASE_ERROR", status: 503, context: { postgresCode: "40001", retryable: true },
    });
    expect(f.current().status).toBe("review");
    expect(f.audit()).toBeNull();
  });

  it.each(["pending", "processing", "success", "review"])("replays the exact audited action without requeue after worker advances to %s", async (status) => {
    const f = fixture();
    const input = execution();
    await f.repository.requeue(input);
    f.advance({ status, attemptCount: 2, lastErrorCode: status === "review" ? snapshot().lastErrorCode : null });
    const priorCount = f.calls.length;
    await expect(f.repository.requeue(input)).resolves.toMatchObject({ replayed: true, requeued: false });
    expect(f.current().status).toBe(status);
    expect(f.calls.slice(priorCount).some((query) => /INSERT|UPDATE oms\./.test(query))).toBe(false);
  });

  it.each([
    { operator: "user:8" }, { reason: "another reason" }, { previous_request_hash: "f".repeat(64) },
  ])("rejects corrupt replay audit evidence: %j", async (corruption) => {
    const f = fixture();
    await f.repository.requeue(execution());
    f.corruptAudit(corruption);
    await expect(f.repository.requeue(execution())).rejects.toMatchObject({ code: "REVIEW_RETRY_IDEMPOTENCY_CONFLICT" });
  });

  it("binds idempotency to actor, reason, exact state and order, but not response time", () => {
    const input = execution();
    expect(reviewRetryIdempotencyKey(input)).toBe(reviewRetryIdempotencyKey({ ...input, requeuedAt: new Date(NOW.getTime() + 1) }));
    for (const changed of [{ actor: "user:8" }, { reason: "other" }, { omsOrderId: 902 }, { expectedStateFingerprint: "b".repeat(64) }]) {
      expect(reviewRetryIdempotencyKey({ ...input, ...changed })).not.toBe(reviewRetryIdempotencyKey(input));
    }
  });

  it("rejects missing actor and invalid clock at the owner boundary", async () => {
    const f = fixture();
    await expect(f.repository.requeue({ ...execution(), actor: "unknown" })).rejects.toMatchObject({ code: "INVALID_REVIEW_RETRY_INPUT" });
    await expect(f.repository.requeue({ ...execution(), requeuedAt: new Date("invalid") })).rejects.toMatchObject({ code: "INVALID_REVIEW_RETRY_INPUT" });
    expect(f.execute).not.toHaveBeenCalled();
  });
});
