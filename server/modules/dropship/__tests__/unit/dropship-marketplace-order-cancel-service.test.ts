import { describe, expect, it, vi } from "vitest";

import {
  DropshipMarketplaceOrderCancelService,
  type MarketplaceCancelStopCandidate,
  type MarketplaceCancelStopRecord,
  type MarketplaceCancelStopRecorded,
  type MarketplaceOrderCancelRepository,
} from "../../application/dropship-marketplace-order-cancel-service";
import type { DropshipMarketplaceCancelStop } from "../../application/dropship-ports";
import { DropshipError } from "../../domain/errors";
import type { OrderProcessingFailureDecision } from "../../domain/order-processing-retry";

/**
 * Accepted dropship orders eBay cancelled (eBay sync-back plan v4 §7.2): the
 * service asks OMS's stop and records the answer; a failed ask waits the
 * order-retry delays (§7.1) and goes to a person after 64; a permanent or
 * fatal failure is never retried (CLAUDE.md §6).
 */
const NOW = new Date("2026-10-22T12:00:00.000Z");

const candidate = (overrides: Partial<MarketplaceCancelStopCandidate> = {}): MarketplaceCancelStopCandidate => ({
  intakeId: 41, vendorId: 10, storeConnectionId: 22, omsOrderId: 9001, externalOrderId: "11-1", externalOrderNumber: "5001",
  attemptCount: 0, ...overrides });

class FakeRepository implements MarketplaceOrderCancelRepository {
  outcomes: MarketplaceCancelStopRecord[] = [];
  failures: Array<{ candidate: MarketplaceCancelStopCandidate; decision: OrderProcessingFailureDecision; errorCode: string; at: Date;
    omsAnswer?: string | null }> = [];
  recordAnswer: (input: MarketplaceCancelStopRecord) => Promise<MarketplaceCancelStopRecorded> = async (input) => ({
    applied: true,
    refund: input.outcome.refund ? { cashCents: 1724, rewardsCents: 300, orderDebitRefundCents: 1599, advanceFeeRefundCents: 125, replayed: false } : null,
  });

  constructor(private readonly due: MarketplaceCancelStopCandidate[]) {}

  async listDueStops(input: { now: Date; limit: number }) {
    expect(input.now).toEqual(NOW);
    return this.due.slice(0, input.limit);
  }

  async recordStopOutcome(input: MarketplaceCancelStopRecord) {
    this.outcomes.push(input);
    return this.recordAnswer(input);
  }

  async recordStopFailure(input: Parameters<MarketplaceOrderCancelRepository["recordStopFailure"]>[0]) {
    this.failures.push(input);
    return true;
  }
}

function logger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function service(repository: FakeRepository, stopper: DropshipMarketplaceCancelStop | null, log = logger()) {
  return { log, service: new DropshipMarketplaceOrderCancelService({ repository, stopper, clock: { now: () => NOW }, logger: log }) };
}

const stopperAnswering = (answer: Awaited<ReturnType<DropshipMarketplaceCancelStop["stopOrderForMarketplaceCancel"]>>) =>
  ({ stopOrderForMarketplaceCancel: vi.fn(async () => answer) });

describe("DropshipMarketplaceOrderCancelService.processDueStops", () => {
  it("does nothing when no stop is due", async () => {
    const stopper = stopperAnswering({ kind: "stopped", shipments: [] });
    const { service: subject, log } = service(new FakeRepository([]), stopper);
    expect(await subject.processDueStops({ limit: 25, workerId: "w" })).toEqual({ stopped: 0, review: 0, retrying: 0, notWired: 0 });
    expect(stopper.stopOrderForMarketplaceCancel).not.toHaveBeenCalled();
    expect(log.error).not.toHaveBeenCalled();
  });

  it("leaves due stops waiting, and tells a person, when OMS's stop is not wired in this process", async () => {
    const repository = new FakeRepository([candidate(), candidate({ intakeId: 42 })]);
    const { service: subject, log } = service(repository, null);
    expect(await subject.processDueStops({ limit: 25, workerId: "w" })).toEqual({ stopped: 0, review: 0, retrying: 0, notWired: 2 });
    expect(repository.outcomes).toEqual([]);
    expect(repository.failures).toEqual([]);
    expect(log.error).toHaveBeenCalledWith("dropship.order.marketplace_cancel_stop_unavailable", expect.objectContaining({
      error_code: "DROPSHIP_EBAY_ORDER_CANCEL_STOP_NOT_WIRED", due_count: 2 }));
  });

  it("records a stopped order with its refund and logs the state change at INFO with correlation ids", async () => {
    const repository = new FakeRepository([candidate()]);
    const stopper = stopperAnswering({ kind: "stopped", shipments: [{ id: 2001 }] });
    const { service: subject, log } = service(repository, stopper);

    expect(await subject.processDueStops({ limit: 25, workerId: "worker-1" })).toEqual({ stopped: 1, review: 0, retrying: 0, notWired: 0 });
    expect(stopper.stopOrderForMarketplaceCancel).toHaveBeenCalledWith({ omsOrderId: 9001, intakeId: 41 });
    expect(repository.outcomes).toEqual([{ candidate: candidate(), kind: "stopped", shipments: [{ id: 2001 }], at: NOW, workerId: "worker-1",
      outcome: { cancellationStatus: "marketplace_cancel_stopped", refund: true, notice: { kind: "order_cancel_refunded" }, requiresReview: false } }]);
    expect(log.info).toHaveBeenCalledWith("dropship.order.marketplace_cancel_stop_recorded", expect.objectContaining({
      intake_id: 41, vendor_id: 10, store_connection_id: 22, oms_order_id: 9001, external_order_id: "11-1", outcome: "stopped",
      before: { cancellationStatus: "marketplace_cancel_stop_pending" }, after: { cancellationStatus: "marketplace_cancel_stopped" },
      refund_cash_cents: 1724, refund_rewards_cents: 300, refund_replayed: false }));
  });

  it("sends an order OMS could not stop, or that shipped, to a person at ERROR with no refund", async () => {
    for (const [kind, status] of [["not_stopped", "marketplace_cancel_review"], ["already_shipped", "marketplace_cancel_after_shipment"]] as const) {
      const repository = new FakeRepository([candidate()]);
      const { service: subject, log } = service(repository, stopperAnswering({ kind, shipments: [] }));
      expect(await subject.processDueStops({ limit: 25, workerId: "w" }), kind).toEqual({ stopped: 0, review: 1, retrying: 0, notWired: 0 });
      expect(repository.outcomes[0]?.outcome).toMatchObject({ cancellationStatus: status, refund: false, requiresReview: true });
      expect(log.error).toHaveBeenCalledWith("dropship.order.marketplace_cancel_stop_recorded", expect.objectContaining({
        outcome: "requires_review", error_code: `DROPSHIP_EBAY_ORDER_CANCEL_${kind.toUpperCase()}`, refund_cash_cents: 0 }));
    }
  });

  it("answers not_found itself for an accepted intake that names no OMS order, without asking OMS", async () => {
    const repository = new FakeRepository([candidate({ omsOrderId: null })]);
    const stopper = stopperAnswering({ kind: "stopped", shipments: [] });
    const { service: subject } = service(repository, stopper);
    expect(await subject.processDueStops({ limit: 25, workerId: "w" })).toEqual({ stopped: 0, review: 1, retrying: 0, notWired: 0 });
    expect(stopper.stopOrderForMarketplaceCancel).not.toHaveBeenCalled();
    expect(repository.outcomes[0]).toMatchObject({ kind: "not_found", outcome: { notice: null, requiresReview: true } });
  });

  it("retries a failed OMS ask after the order-retry delay: WARN the first time, DEBUG after", async () => {
    const failing = { stopOrderForMarketplaceCancel: vi.fn(async () => {
      throw Object.assign(new Error("lock"), { code: "OMS_DROPSHIP_MARKETPLACE_CANCEL_RELEASE_FAILED", classification: "transient" });
    }) };
    const first = new FakeRepository([candidate()]);
    const one = service(first, failing);
    expect(await one.service.processDueStops({ limit: 25, workerId: "w" })).toEqual({ stopped: 0, review: 0, retrying: 1, notWired: 0 });
    expect(first.failures).toEqual([expect.objectContaining({ errorCode: "OMS_DROPSHIP_MARKETPLACE_CANCEL_RELEASE_FAILED", at: NOW,
      decision: { status: "retrying", attemptCount: 1, nextAttemptAt: new Date(NOW.getTime() + 60_000), exhausted: false } })]);
    expect(one.log.warn).toHaveBeenCalledWith("dropship.order.marketplace_cancel_stop_failed", expect.objectContaining({
      outcome: "retry_scheduled", error_class: "transient", attempt_count: 1 }));

    const second = new FakeRepository([candidate({ attemptCount: 1 })]);
    const two = service(second, failing);
    await two.service.processDueStops({ limit: 25, workerId: "w" });
    expect(two.log.warn).not.toHaveBeenCalled();
    expect(two.log.debug).toHaveBeenCalledWith("dropship.order.marketplace_cancel_stop_failed", expect.objectContaining({ attempt_count: 2 }));
  });

  it("goes to a person after the 64th failed ask", async () => {
    const repository = new FakeRepository([candidate({ attemptCount: 63 })]);
    const { service: subject, log } = service(repository, { stopOrderForMarketplaceCancel: vi.fn(async () => { throw new Error("timeout"); }) });
    expect(await subject.processDueStops({ limit: 25, workerId: "w" })).toEqual({ stopped: 0, review: 1, retrying: 0, notWired: 0 });
    expect(repository.failures[0]).toMatchObject({ errorCode: "DROPSHIP_EBAY_ORDER_CANCEL_STOP_FAILED",
      decision: { status: "failed", attemptCount: 64, exhausted: true } });
    expect(log.error).toHaveBeenCalledWith("dropship.order.marketplace_cancel_stop_failed", expect.objectContaining({ outcome: "requires_review", exhausted: true }));
  });

  it("never retries a stop OMS refused as a caller defect (fatal)", async () => {
    const repository = new FakeRepository([candidate()]);
    const { service: subject } = service(repository, { stopOrderForMarketplaceCancel: vi.fn(async () => {
      throw Object.assign(new Error("bad id"), { code: "OMS_DROPSHIP_MARKETPLACE_CANCEL_INPUT_INVALID", classification: "fatal" });
    }) });
    expect(await subject.processDueStops({ limit: 25, workerId: "w" })).toEqual({ stopped: 0, review: 1, retrying: 0, notWired: 0 });
    expect(repository.failures[0]?.decision).toEqual({ status: "failed", attemptCount: 1, nextAttemptAt: null, exhausted: false });
  });

  it("never retries a recording a ledger refuses for good, and retries one that failed in passing", async () => {
    const cases: Array<[unknown, "review" | "retrying"]> = [
      [new DropshipError("DROPSHIP_EBAY_ORDER_CANCEL_INVARIANT_FAILED", "broken ledger", { classification: "fatal" }), "review"],
      [new DropshipError("DROPSHIP_EBAY_ORDER_CANCEL_REFUND_REFUSED", "refused", { classification: "permanent" }), "review"],
      [Object.assign(new Error("duplicate key"), { code: "23505" }), "review"],
      [Object.assign(new Error("serialization"), { code: "40001" }), "retrying"],
      [new Error("connection reset"), "retrying"],
    ];
    for (const [error, expected] of cases) {
      const repository = new FakeRepository([candidate()]);
      repository.recordAnswer = async () => { throw error; };
      const { service: subject } = service(repository, stopperAnswering({ kind: "stopped", shipments: [] }));
      const summary = await subject.processDueStops({ limit: 25, workerId: "w" });
      expect(summary[expected], String((error as Error).message)).toBe(1);
      expect(repository.failures[0]?.decision.status).toBe(expected === "review" ? "failed" : "retrying");
    }
  });

  it("MS5: never retries an OMS stop that failed for good: an integrity or SQL error goes to review at once, with no retry", async () => {
    for (const code of ["23505", "42P01"]) {
      const repository = new FakeRepository([candidate()]);
      const { service: subject, log } = service(repository, { stopOrderForMarketplaceCancel: vi.fn(async () => {
        throw Object.assign(new Error(`sql ${code}`), { code });
      }) });
      expect(await subject.processDueStops({ limit: 25, workerId: "w" }), code).toEqual({ stopped: 0, review: 1, retrying: 0, notWired: 0 });
      expect(repository.failures[0], code).toMatchObject({ errorCode: code,
        decision: { status: "failed", attemptCount: 1, nextAttemptAt: null, exhausted: false } });
      expect(log.error).toHaveBeenCalledWith("dropship.order.marketplace_cancel_stop_failed", expect.objectContaining({
        error_class: "permanent", outcome: "requires_review" }));
    }
  });

  it("ARCH-7: tells the repository what OMS answered before a recording failed, and nothing when the ask itself failed", async () => {
    const refused = new FakeRepository([candidate()]);
    refused.recordAnswer = async () => { throw new DropshipError("DROPSHIP_EBAY_ORDER_CANCEL_REFUND_REFUSED", "refused", { classification: "permanent" }); };
    await service(refused, stopperAnswering({ kind: "stopped", shipments: [] })).service.processDueStops({ limit: 25, workerId: "w" });
    expect(refused.failures[0]).toMatchObject({ omsAnswer: "stopped", decision: { status: "failed" } });

    const unanswered = new FakeRepository([candidate()]);
    await service(unanswered, { stopOrderForMarketplaceCancel: vi.fn(async () => { throw new Error("timeout"); }) })
      .service.processDueStops({ limit: 25, workerId: "w" });
    expect(unanswered.failures[0]).toMatchObject({ omsAnswer: null, decision: { status: "retrying" } });
  });

  it("writes and logs nothing new when another worker already recorded the answer", async () => {
    const repository = new FakeRepository([candidate()]);
    repository.recordAnswer = async () => ({ applied: false });
    const { service: subject, log } = service(repository, stopperAnswering({ kind: "stopped", shipments: [] }));
    expect(await subject.processDueStops({ limit: 25, workerId: "w" })).toEqual({ stopped: 1, review: 0, retrying: 0, notWired: 0 });
    expect(log.info).not.toHaveBeenCalled();
    expect(log.debug).toHaveBeenCalledWith("dropship.order.marketplace_cancel_stop_recorded", expect.objectContaining({ outcome: "already_recorded" }));
  });
});
