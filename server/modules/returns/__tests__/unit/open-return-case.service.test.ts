import { describe, expect, it, vi } from "vitest";
import type { ReturnPolicy } from "@shared/schema";
import {
  OpenReturnCaseService,
  type LockedReturnSourceContext,
  type OpenReturnCaseStore,
  type OpenReturnCaseTransaction,
} from "../../application/open-return-case.service";

const NOW = new Date("2026-08-11T12:00:00.000Z");

function policy(overrides: Partial<ReturnPolicy> = {}): ReturnPolicy {
  return {
    id: 41,
    name: "Retail returns",
    scopeKind: "channel_context",
    scopeKey: "context:retail:channel:36",
    businessContext: "retail",
    channelId: 36,
    vendorId: null,
    storeConnectionId: null,
    version: 3,
    status: "active",
    returnWindowDays: 30,
    returnDestination: "card_shellz",
    approvalAuthority: "card_shellz",
    labelProvider: "shipstation",
    returnShippingPayer: "customer",
    inspectionRequirement: "required",
    inspectionOwner: "card_shellz",
    customerRefundAuthority: "card_shellz",
    vendorSettlementTrigger: "none",
    returnlessRefundAllowed: false,
    notes: null,
    supersedesPolicyId: null,
    createdBy: "admin:test",
    retiredBy: null,
    retiredAt: null,
    createdAt: NOW,
    ...overrides,
  };
}

function source(overrides: Partial<LockedReturnSourceContext> = {}): LockedReturnSourceContext {
  return {
    omsOrderId: 101,
    wmsOrderId: 201,
    channelId: 36,
    businessContext: "retail",
    vendorId: null,
    storeConnectionId: null,
    policies: [policy() as LockedReturnSourceContext["policies"][number]],
    items: [{
      wmsOrderItemId: 301,
      omsOrderLineId: 401,
      externalLineItemId: "line-1",
      sku: "SKU-1",
      title: "Test item",
      fulfilledQuantity: 3,
      alreadyExpectedQuantity: 1,
      returnableQuantity: 2,
      unitPaidPriceCents: 499,
    }],
    ...overrides,
  };
}

function fixture(options: {
  existing?: Awaited<ReturnType<OpenReturnCaseTransaction["findExisting"]>>;
  source?: LockedReturnSourceContext | null;
} = {}) {
  const tx: OpenReturnCaseTransaction = {
    lockCommand: vi.fn().mockResolvedValue(undefined),
    findExisting: vi.fn().mockResolvedValue(options.existing ?? null),
    loadSourceForUpdate: vi.fn().mockResolvedValue(options.source === undefined ? source() : options.source),
    persist: vi.fn().mockResolvedValue({ caseId: 501, caseNumber: "RMA-00000501", wmsReturnId: 601, replayed: false }),
  };
  const store: OpenReturnCaseStore = {
    searchSourceOrders: vi.fn(),
    getSourceOrder: vi.fn(),
    transaction: vi.fn(async (work) => work(tx)),
  };
  return { service: new OpenReturnCaseService(store, () => NOW), store, tx };
}

function command() {
  return {
    idempotencyKey: "return-command-1",
    actor: "user:7",
    omsOrderId: 101,
    wmsOrderId: 201,
    reasonCode: "buyer_return" as const,
    notes: "  customer requested return  ",
    items: [{ wmsOrderItemId: 301, quantity: 2 }],
  };
}

describe("OpenReturnCaseService", () => {
  it("locks, resolves policy, and persists a normalized policy-snapshotted case", async () => {
    const { service, tx } = fixture();

    await expect(service.open(command())).resolves.toEqual({
      caseId: 501,
      caseNumber: "RMA-00000501",
      wmsReturnId: 601,
      replayed: false,
    });

    expect(tx.lockCommand).toHaveBeenCalledWith("return-command-1");
    expect(tx.loadSourceForUpdate).toHaveBeenCalledWith({
      omsOrderId: 101,
      wmsOrderId: 201,
      wmsOrderItemIds: [301],
    });
    expect(tx.persist).toHaveBeenCalledWith(expect.objectContaining({
      actor: "user:7",
      notes: "customer requested return",
      lifecycle: {
        caseStatus: "open",
        approvalStatus: "approved",
        logisticsStatus: "awaiting_return",
        inspectionStatus: "pending",
        customerRefundStatus: "pending",
        vendorSettlementStatus: "not_applicable",
      },
      selectedItems: [expect.objectContaining({ wmsOrderItemId: 301, quantity: 2 })],
      now: NOW,
    }));
  });

  it("returns an idempotent replay before locking source inventory", async () => {
    const first = fixture();
    const firstResult = await first.service.open(command());
    const requestHash = vi.mocked(first.tx.persist).mock.calls[0][0].requestHash;
    const replay = fixture({ existing: { requestHash, result: firstResult } });

    await expect(replay.service.open(command())).resolves.toEqual({ ...firstResult, replayed: true });
    expect(replay.tx.loadSourceForUpdate).not.toHaveBeenCalled();
    expect(replay.tx.persist).not.toHaveBeenCalled();
  });

  it("rejects reuse of an idempotency key for a different command", async () => {
    const { service, tx } = fixture({
      existing: {
        requestHash: "different-hash",
        result: { caseId: 1, caseNumber: "RMA-00000001", wmsReturnId: 2, replayed: false },
      },
    });

    await expect(service.open(command())).rejects.toMatchObject({ code: "RETURN_CASE_IDEMPOTENCY_CONFLICT", status: 409 });
    expect(tx.persist).not.toHaveBeenCalled();
  });

  it("rejects quantities above the remaining fulfilled quantity", async () => {
    const { service, tx } = fixture();

    await expect(service.open({ ...command(), items: [{ wmsOrderItemId: 301, quantity: 3 }] }))
      .rejects.toMatchObject({ code: "RETURN_CASE_QUANTITY_UNAVAILABLE", status: 409 });
    expect(tx.persist).not.toHaveBeenCalled();
  });

  it("fails closed when no active policy applies", async () => {
    const { service, tx } = fixture({ source: source({ policies: [] }) });

    await expect(service.open(command())).rejects.toMatchObject({ code: "RETURN_CASE_POLICY_NOT_CONFIGURED", status: 409 });
    expect(tx.persist).not.toHaveBeenCalled();
  });

  it("rejects invalid commands before opening a transaction", async () => {
    const { service, store } = fixture();

    await expect(service.open({ ...command(), items: [{ wmsOrderItemId: 301, quantity: 0 }] }))
      .rejects.toMatchObject({ code: "RETURN_CASE_INPUT_INVALID", status: 400 });
    expect(store.transaction).not.toHaveBeenCalled();
  });
});
