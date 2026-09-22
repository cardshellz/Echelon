import { describe, expect, it, vi } from "vitest";
import {
  CustomerReturnAuthorizationService,
  type CustomerReturnAuthorizationDependencies,
  type CustomerReturnAuthorizationPreview,
  type CustomerReturnTrustedSource,
} from "../../application/customer-return-authorization.service";
import type {
  CustomerReturnAuthorizationResult,
  CustomerReturnAuthorizationStore,
  CustomerReturnAuthorizationTransaction,
  LockedCustomerReturnAuthorizationSource,
  PersistCustomerReturnAuthorizationInput,
} from "../../application/customer-return-authorization.ports";

const NOW = "2026-09-22T12:00:00.000Z";
const LINE_ID = "gid://shopify/LineItem/1001";
const ORDER = { omsOrderId: 101, channelId: 36, externalOrderId: "gid://shopify/Order/5001", externalOrderNumber: "#63210" };

function trustedSource(): CustomerReturnTrustedSource {
  return {
    observedAt: NOW,
    facts: {
      policy: { channelId: 36, version: 4, returnWindowDays: 365 },
      order: {
        orderId: ORDER.externalOrderId, channelId: 36, provider: "shopify", destinationCountryCode: "US",
        purchasedAt: "2026-08-20T12:00:00.000Z",
        lines: [{
          lineId: LINE_ID, sku: "SKU-1", requiresShipping: true, purchasedQuantity: 3, claims: [],
          allocations: [1, 2].map((value) => ({
            allocationId: `allocation-${value}`, fulfillmentId: `fulfillment-${value}`,
            fulfillmentLineItemId: `fulfillment-line-${value}`, quantity: value === 1 ? 2 : 1,
            status: "active" as const, staffDeliveryOverride: null,
            deliveryEvidence: [{
              evidenceId: `delivery-${value}`, source: "shopify" as const, status: "delivered" as const,
              occurredAt: "2026-09-21T17:36:00.000Z", observedAt: NOW,
            }],
          })),
        }],
      },
    },
    mappings: [{ lineId: LINE_ID, omsOrderLineId: 301, externalLineItemId: LINE_ID,
      allocations: [{ allocationId: "allocation-1", wmsOrderItemId: 401 }, { allocationId: "allocation-2", wmsOrderItemId: 402 }] }],
    warehouse: { warehouseId: 7, version: 2, address: { name: "Returns", address1: "123 Warehouse Lane", address2: null,
      city: "Cleveland", state: "OH", postalCode: "44101", countryCode: "US" } },
  };
}

function lockedSource(): LockedCustomerReturnAuthorizationSource {
  return {
    channelId: 36, omsOrderId: 101,
    lines: [{ omsOrderLineId: 301, externalLineItemId: LINE_ID, orderedQuantity: 3, legacyExpectedQuantity: 0, claimedQuantity: 0,
      wmsItems: [{ wmsOrderId: 201, wmsOrderItemId: 401, fulfilledQuantity: 2, legacyExpectedQuantity: 0, claimedQuantity: 0 },
        { wmsOrderId: 202, wmsOrderItemId: 402, fulfilledQuantity: 1, legacyExpectedQuantity: 0, claimedQuantity: 0 }] }],
    allocationClaims: [],
  };
}

function fixture() {
  type StoredCommand = NonNullable<Awaited<ReturnType<CustomerReturnAuthorizationTransaction["findCommand"]>>>;
  const state = {
    source: trustedSource(), locked: lockedSource() as LockedCustomerReturnAuthorizationSource | null,
    now: new Date(NOW), ready: true, accessError: null as Error | null, sourceError: null as Error | null,
    result: { authorizationId: 501, authorizationNumber: "RMA-0000000501", replayed: false } as CustomerReturnAuthorizationResult,
    commands: new Map<string, StoredCommand>(),
  };
  const trace: string[] = [];
  const persisted: PersistCustomerReturnAuthorizationInput[] = [];
  let transactionDepth = 0;
  const lockCommand = vi.fn<CustomerReturnAuthorizationTransaction["lockCommand"]>(async () => { trace.push("lock-command"); });
  const findCommand = vi.fn<CustomerReturnAuthorizationTransaction["findCommand"]>(async (command) => {
    trace.push("find-command");
    return state.commands.get(`${command.channelId}:${command.idempotencyKey}`) ?? null;
  });
  const lockSource = vi.fn<CustomerReturnAuthorizationTransaction["lockSource"]>(async () => {
    trace.push("lock-source"); return structuredClone(state.locked);
  });
  const persist = vi.fn<CustomerReturnAuthorizationTransaction["persist"]>(async (command) => {
    trace.push("persist");
    persisted.push(structuredClone(command));
    state.commands.set(`${command.channelId}:${command.idempotencyKey}`, { semanticHash: command.semanticHash, result: state.result });
    return state.result;
  });
  const tx: CustomerReturnAuthorizationTransaction = { lockCommand, findCommand, lockSource, persist };
  const store: CustomerReturnAuthorizationStore = {
    async transaction<T>(work: (transaction: CustomerReturnAuthorizationTransaction) => Promise<T>): Promise<T> {
      transactionDepth += 1; trace.push("transaction-start");
      try { return await work(tx); }
      finally { transactionDepth -= 1; trace.push("transaction-end"); }
    },
  };
  const resolve = vi.fn<CustomerReturnAuthorizationDependencies["orderAccess"]["resolve"]>(async () => {
    trace.push("access"); if (state.accessError) throw state.accessError; return { ...ORDER };
  });
  const read = vi.fn<CustomerReturnAuthorizationDependencies["sourceReader"]["read"]>(async () => {
    trace.push("provider-read");
    if (transactionDepth !== 0) throw new Error("Provider I/O occurred under transaction locks");
    if (state.sourceError) throw state.sourceError;
    return structuredClone(state.source);
  });
  const actor = vi.fn(async () => { trace.push("actor"); return "customer:trusted-55"; });
  const clock = vi.fn(() => new Date(state.now));
  const isIntakeReady = vi.fn(() => state.ready);
  const reportFailure = vi.fn<NonNullable<CustomerReturnAuthorizationDependencies["reportFailure"]>>();
  const dependencies: CustomerReturnAuthorizationDependencies = {
    orderAccess: { resolve }, sourceReader: { read }, store, actor, clock, maxSourceAgeMs: 60_000, isIntakeReady, reportFailure,
  };
  return { state, trace, persisted, resolve, read, actor, clock, isIntakeReady, reportFailure, lockCommand, findCommand, lockSource, persist,
    dependencies, service: new CustomerReturnAuthorizationService(dependencies) };
}

function submission(preview: CustomerReturnAuthorizationPreview, quantity = 3) {
  return { orderReference: "63210", idempotencyKey: "customer-return-1", eligibilityRevision: preview.eligibilityRevision,
    lines: [{ lineId: LINE_ID, quantity }] };
}

describe("CustomerReturnAuthorizationService", () => {
  it("prepares trusted facts and current claims without creating a command or authorization", async () => {
    const f = fixture();
    const preview = await f.service.prepare({ orderReference: "#63210" });
    expect(f.resolve).toHaveBeenCalledWith({ orderReference: "#63210" });
    expect(f.read).toHaveBeenCalledWith(ORDER);
    expect(preview.eligibility).toMatchObject({ eligibleQuantity: 3, hasEligibleItems: true });
    expect(preview.eligibilityRevision).toMatch(/^[a-f0-9]{64}$/);
    expect(f.lockSource).toHaveBeenCalledWith({ channelId: 36, omsOrderId: 101, omsOrderLineIds: [301] });
    expect(f.persist).not.toHaveBeenCalled();
    expect(f.lockCommand).not.toHaveBeenCalled();
    expect(f.actor).not.toHaveBeenCalled();
    expect(f.trace).toEqual(["access", "provider-read", "transaction-start", "lock-source", "transaction-end"]);
  });

  it("allocates one purchased line across distinct WMS orders and preserves null customer reason and destination snapshot", async () => {
    const f = fixture();
    const expectedWarehouse = structuredClone(f.state.source.warehouse);
    const preview = await f.service.prepare({ orderReference: "63210" });
    expect(await f.service.submit(submission(preview))).toEqual(f.state.result);
    expect(f.persisted).toHaveLength(1);
    expect(f.persisted[0]).toMatchObject({
      channelId: 36, omsOrderId: 101, actor: "customer:trusted-55", now: new Date(NOW),
      policySnapshot: { channelId: 36, version: 4, returnWindowDays: 365, refundAuthority: "manual_shopify", windowBasis: "purchase" },
      warehouseSnapshot: expectedWarehouse,
      lines: [{ omsOrderLineId: 301, externalLineItemId: LINE_ID, quantity: 3, reasonCode: null,
        allocations: [{ wmsOrderItemId: 401, fulfillmentId: "fulfillment-1", quantity: 2, eligibleQuantity: 2 },
          { wmsOrderItemId: 402, fulfillmentId: "fulfillment-2", quantity: 1, eligibleQuantity: 1 }] }],
    });
    f.state.source.warehouse.address.address1 = "Changed afterward";
    expect(f.persisted[0].warehouseSnapshot).toEqual(expectedWarehouse);
  });

  it("revalidates ownership before replay and returns the same completed RMA with the provider down and intake paused", async () => {
    const f = fixture();
    const preview = await f.service.prepare({ orderReference: "63210" });
    const command = submission(preview);
    await f.service.submit(command);
    f.state.ready = false;
    f.state.sourceError = new Error("Shopify unavailable");
    f.trace.length = 0;
    f.read.mockClear(); f.actor.mockClear(); f.lockSource.mockClear(); f.persist.mockClear();
    const replay = await f.service.submit({ ...command, orderReference: "#63210", eligibilityRevision: "f".repeat(64) });
    expect(replay).toEqual({ ...f.state.result, replayed: true });
    expect(f.trace).toEqual(["access", "transaction-start", "lock-command", "find-command", "transaction-end"]);
    expect(f.read).not.toHaveBeenCalled(); expect(f.actor).not.toHaveBeenCalled();
    expect(f.lockSource).not.toHaveBeenCalled(); expect(f.persist).not.toHaveBeenCalled();
  });

  it("never reveals a stored RMA after ownership verification fails", async () => {
    const f = fixture();
    const preview = await f.service.prepare({ orderReference: "63210" });
    const command = submission(preview); await f.service.submit(command);
    f.state.accessError = new Error("Order unavailable");
    f.findCommand.mockClear(); f.read.mockClear();
    await expect(f.service.submit(command)).rejects.toMatchObject({ code: "RETURN_SERVICE_UNAVAILABLE" });
    expect(f.findCommand).not.toHaveBeenCalled(); expect(f.read).not.toHaveBeenCalled();
  });

  it.each(["quantity", "reason"] as const)("rejects changed semantic %s for an existing idempotency key", async (kind) => {
    const f = fixture();
    const preview = await f.service.prepare({ orderReference: "63210" });
    const command = submission(preview); await f.service.submit(command);
    f.read.mockClear(); f.persist.mockClear();
    const changed = kind === "quantity" ? [{ lineId: LINE_ID, quantity: 1 }]
      : [{ lineId: LINE_ID, quantity: 3, reasonCode: "damaged" }];
    await expect(f.service.submit({ ...command, lines: changed })).rejects.toMatchObject({ code: "RETURN_COMMAND_CONFLICT" });
    expect(f.read).not.toHaveBeenCalled(); expect(f.persist).not.toHaveBeenCalled();
  });

  it("rejects a review after another writer claims units under the quantity lock", async () => {
    const f = fixture();
    const preview = await f.service.prepare({ orderReference: "63210" });
    const current = f.state.locked!;
    current.lines[0].claimedQuantity = 1;
    current.lines[0].wmsItems[0].claimedQuantity = 1;
    current.allocationClaims = [{ omsOrderLineId: 301, fulfillmentId: "fulfillment-1", fulfillmentLineItemId: "fulfillment-line-1", quantity: 1 }];
    await expect(f.service.submit(submission(preview))).rejects.toMatchObject({ code: "RETURN_REVIEW_CHANGED" });
    expect(f.persist).not.toHaveBeenCalled();
    expect((await f.service.prepare({ orderReference: "63210" })).eligibility.eligibleQuantity).toBe(2);
  });

  it("does not invalidate a review when only observation/evaluation times refresh", async () => {
    const f = fixture();
    const preview = await f.service.prepare({ orderReference: "63210" });
    const fresh = "2026-09-22T12:00:30.000Z";
    f.state.now = new Date(fresh);
    f.state.source.observedAt = fresh;
    for (const allocation of f.state.source.facts.order.lines[0].allocations) allocation.deliveryEvidence[0].observedAt = fresh;
    const renewed = await f.service.prepare({ orderReference: "63210" });
    expect(renewed.eligibilityRevision).toBe(preview.eligibilityRevision);
    await f.service.submit(submission(preview));
    expect(f.persisted[0].now).toEqual(new Date(fresh));
  });

  it("keeps review semantics stable when equivalent fact/mapping collections are reordered", async () => {
    const f = fixture();
    const preview = await f.service.prepare({ orderReference: "63210" });
    f.state.source.facts.order.lines[0].allocations.reverse();
    f.state.source.mappings[0].allocations.reverse();
    expect((await f.service.prepare({ orderReference: "#63210" })).eligibilityRevision).toBe(preview.eligibilityRevision);
    await f.service.submit(submission(preview, 1));
    expect(f.persisted[0].lines[0].allocations).toHaveLength(1);
    expect(f.persisted[0].lines[0].allocations[0]).toMatchObject({ wmsOrderItemId: 401, quantity: 1 });
  });

  it("changes the review when the warehouse snapshot changes", async () => {
    const f = fixture();
    const preview = await f.service.prepare({ orderReference: "63210" });
    f.state.source.warehouse.version += 1;
    f.state.source.warehouse.address.address1 = "456 New Warehouse Lane";
    await expect(f.service.submit(submission(preview))).rejects.toMatchObject({ code: "RETURN_REVIEW_CHANGED" });
    expect(f.persist).not.toHaveBeenCalled();
  });

  it("reads providers outside transactions and reserves only after command and source locks", async () => {
    const f = fixture();
    const preview = await f.service.prepare({ orderReference: "63210" });
    f.trace.length = 0;
    await f.service.submit(submission(preview));
    expect(f.trace).toEqual([
      "access", "transaction-start", "lock-command", "find-command", "transaction-end",
      "provider-read", "actor", "transaction-start", "lock-command", "find-command", "lock-source", "persist", "transaction-end",
    ]);
  });

  it("does no new work when the intake gate is closed", async () => {
    const f = fixture();
    f.state.ready = false;
    await expect(f.service.submit({ orderReference: "63210", idempotencyKey: "new", eligibilityRevision: "a".repeat(64),
      lines: [{ lineId: LINE_ID, quantity: 1 }] })).rejects.toMatchObject({ code: "RETURN_INTAKE_NOT_READY" });
    expect(f.read).not.toHaveBeenCalled(); expect(f.actor).not.toHaveBeenCalled();
    expect(f.lockSource).not.toHaveBeenCalled(); expect(f.persist).not.toHaveBeenCalled();
  });

  it("rechecks the intake gate after the provider read, before claiming any quantities", async () => {
    const f = fixture();
    const preview = await f.service.prepare({ orderReference: "63210" });
    f.read.mockImplementationOnce(async () => { f.state.ready = false; return structuredClone(f.state.source); });
    f.lockSource.mockClear();
    await expect(f.service.submit(submission(preview))).rejects.toMatchObject({ code: "RETURN_INTAKE_NOT_READY" });
    expect(f.lockSource).not.toHaveBeenCalled(); expect(f.persist).not.toHaveBeenCalled();
  });

  it("replays a concurrently completed command during the second transaction", async () => {
    const f = fixture();
    const preview = await f.service.prepare({ orderReference: "63210" });
    const command = submission(preview); await f.service.submit(command);
    const saved = f.state.commands.get("36:customer-return-1")!;
    f.state.commands.clear(); f.lockSource.mockClear(); f.persist.mockClear();
    f.actor.mockImplementationOnce(async () => { f.state.commands.set("36:customer-return-1", saved); return "customer:trusted-55"; });
    expect(await f.service.submit(command)).toEqual({ ...f.state.result, replayed: true });
    expect(f.lockSource).not.toHaveBeenCalled(); expect(f.persist).not.toHaveBeenCalled();
  });

  it("blocks unknown legacy fulfillment claims instead of guessing available units", async () => {
    const f = fixture();
    f.state.locked!.lines[0].legacyExpectedQuantity = 1;
    f.state.locked!.lines[0].wmsItems[0].legacyExpectedQuantity = 1;
    const preview = await f.service.prepare({ orderReference: "63210" });
    expect(preview.eligibility.lines[0]).toMatchObject({ eligibleQuantity: 0, reasons: ["claim_allocation_unknown"] });
    await expect(f.service.submit(submission(preview, 1))).rejects.toMatchObject({ code: "RETURN_QUANTITY_UNAVAILABLE" });
    expect(f.persist).not.toHaveBeenCalled();
  });

  it.each(["non_shopify", "international"] as const)("does not authorize %s source facts", async (kind) => {
    const f = fixture();
    if (kind === "non_shopify") f.state.source.facts.order.provider = "ebay";
    else f.state.source.facts.order.destinationCountryCode = "CA";
    const preview = await f.service.prepare({ orderReference: "63210" });
    expect(preview.eligibility.hasEligibleItems).toBe(false);
    await expect(f.service.submit(submission(preview, 1))).rejects.toMatchObject({ code: "RETURN_QUANTITY_UNAVAILABLE" });
    expect(f.persist).not.toHaveBeenCalled();
  });

  it.each([
    (source: CustomerReturnTrustedSource) => { source.facts.order.orderId = "different-order"; },
    (source: CustomerReturnTrustedSource) => { source.facts.order.channelId = 42; },
    (source: CustomerReturnTrustedSource) => { source.facts.policy.channelId = 42; },
    (source: CustomerReturnTrustedSource) => { source.mappings[0].externalLineItemId = "different-line"; },
    (source: CustomerReturnTrustedSource) => { source.mappings[0].allocations.pop(); },
  ])("rejects mismatched trusted-source provenance before taking quantity locks %#", async (change) => {
    const f = fixture(); change(f.state.source);
    await expect(f.service.prepare({ orderReference: "63210" })).rejects.toMatchObject({ code: "RETURN_SOURCE_MISMATCH" });
    expect(f.lockSource).not.toHaveBeenCalled(); expect(f.persist).not.toHaveBeenCalled();
  });

  it("rejects malformed trusted facts before evaluating or persisting them", async () => {
    const f = fixture();
    f.state.source.facts.order.lines[0].purchasedQuantity = -1;
    await expect(f.service.prepare({ orderReference: "63210" })).rejects.toThrow();
    expect(f.lockSource).not.toHaveBeenCalled(); expect(f.persist).not.toHaveBeenCalled();
  });

  it.each([
    (locked: LockedCustomerReturnAuthorizationSource) => { locked.omsOrderId = 102; },
    (locked: LockedCustomerReturnAuthorizationSource) => { locked.channelId = 42; },
    (locked: LockedCustomerReturnAuthorizationSource) => { locked.lines[0].orderedQuantity = 4; },
    (locked: LockedCustomerReturnAuthorizationSource) => { locked.lines[0].externalLineItemId = "different-line"; },
    (locked: LockedCustomerReturnAuthorizationSource) => { locked.lines[0].wmsItems.pop(); },
    (locked: LockedCustomerReturnAuthorizationSource) => { locked.lines[0].claimedQuantity = 1; locked.lines[0].wmsItems[0].claimedQuantity = 1; },
  ])("rejects stale or inconsistent locked source %#", async (change) => {
    const f = fixture(); change(f.state.locked!);
    await expect(f.service.prepare({ orderReference: "63210" })).rejects.toMatchObject({ code: "RETURN_SOURCE_MISMATCH" });
    expect(f.persist).not.toHaveBeenCalled();
  });

  it("rejects a missing locked order", async () => {
    const f = fixture(); f.state.locked = null;
    await expect(f.service.prepare({ orderReference: "63210" })).rejects.toMatchObject({ code: "RETURN_SOURCE_MISMATCH" });
  });

  it.each(["stale", "future"] as const)("rejects %s source observation times", async (kind) => {
    const f = fixture();
    f.state.source.observedAt = kind === "stale" ? "2026-09-22T11:58:59.999Z" : "2026-09-22T12:00:00.001Z";
    await expect(f.service.prepare({ orderReference: "63210" })).rejects.toMatchObject({ code: "RETURN_SOURCE_STALE" });
    expect(f.lockSource).not.toHaveBeenCalled();
  });

  it("rechecks source freshness under the lock when time advances during command processing", async () => {
    const f = fixture();
    const preview = await f.service.prepare({ orderReference: "63210" });
    f.actor.mockImplementationOnce(async () => { f.state.now = new Date("2026-09-22T12:01:00.001Z"); return "customer:trusted-55"; });
    await expect(f.service.submit(submission(preview))).rejects.toMatchObject({ code: "RETURN_SOURCE_STALE" });
    expect(f.persist).not.toHaveBeenCalled();
  });

  it("uses the under-lock eligibility instant for persistence without reading a later clock", async () => {
    const f = fixture();
    const preview = await f.service.prepare({ orderReference: "63210" });
    f.clock.mockReset();
    f.clock.mockReturnValueOnce(new Date(NOW)).mockReturnValueOnce(new Date("2026-09-22T12:00:10Z"))
      .mockImplementation(() => { throw new Error("Unexpected third clock read"); });
    await f.service.submit(submission(preview));
    expect(f.persisted[0].now).toEqual(new Date("2026-09-22T12:00:10Z"));
    expect(f.clock).toHaveBeenCalledTimes(2);
  });

  it("rejects zero or excessive requested units, duplicate selections and unknown customer fields", async () => {
    const f = fixture();
    const preview = await f.service.prepare({ orderReference: "63210" });
    await expect(f.service.submit(submission(preview, 0))).rejects.toMatchObject({ code: "RETURN_INPUT_INVALID" });
    await expect(f.service.submit(submission(preview, 4))).rejects.toMatchObject({ code: "RETURN_QUANTITY_UNAVAILABLE" });
    await expect(f.service.submit({ ...submission(preview), lines: [{ lineId: LINE_ID, quantity: 1 }, { lineId: LINE_ID, quantity: 1 }] }))
      .rejects.toMatchObject({ code: "RETURN_INPUT_INVALID" });
    await expect(f.service.submit({ ...submission(preview), destination: "customer-controlled" })).rejects.toMatchObject({ code: "RETURN_INPUT_INVALID" });
    expect(f.persist).not.toHaveBeenCalled();
  });

  it("validates new and replayed persistence result DTOs", async () => {
    const f = fixture();
    const preview = await f.service.prepare({ orderReference: "63210" });
    f.state.result = { authorizationId: 0, authorizationNumber: "bad", replayed: false };
    await expect(f.service.submit(submission(preview))).rejects.toMatchObject({ code: "RETURN_INPUT_INVALID" });
    await expect(f.service.submit(submission(preview))).rejects.toMatchObject({ code: "RETURN_INPUT_INVALID" });
  });
});
