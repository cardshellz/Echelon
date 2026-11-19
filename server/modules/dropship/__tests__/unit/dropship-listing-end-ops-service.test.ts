import { describe, expect, it } from "vitest";
import type { ListingEndOpsListAnswer, ListingEndOpsRow } from "../../../../../shared/dropship/listing-end-ops";
import {
  DropshipListingEndOpsService,
  type DropshipListingEndOpsRepository,
  type ListingEndOpsLockedRow,
  type ListingEndOpsTransaction,
  type ListingEndOpsWrite,
} from "../../application/dropship-listing-end-ops-service";
import type { ListListingEndsInput } from "../../application/dropship-listing-end-ops-dtos";
import type { ListingEndRecoveryScope } from "../../domain/listing-end-staff";
import { DropshipError } from "../../domain/errors";

const NOW = new Date("2026-10-26T10:00:00.000Z");
const ACTOR = { actorType: "admin", actorId: "staff-1" } as const;
const KEY = "staff-key-0001";

const IDENTITY = {
  destinationKind: "dropship_store_connection", connectionId: 801, channelId: null, vendorId: 70, provider: "ebay",
  accountId: "seller-801", environment: "production", market: "EBAY_US", productId: 7001, productVariantId: 70011,
  externalSku: "S-70011", externalProductId: "L-801-70011", externalVariantId: "O-801-70011", externalInventoryItemId: null,
  identityConflict: false,
};
const SCOPE: ListingEndRecoveryScope = { destinationKind: "dropship_store_connection", connectionId: 801, providerKey: "ebay",
  providerScopeType: "account", externalScopeId: "seller-801", externalInventoryItemId: "S-70011", productId: null, productVariantId: null };

function lockedRow(overrides: Partial<ListingEndOpsLockedRow> = {}): ListingEndOpsLockedRow {
  return { endRequestId: 9, vendorId: 70, storeConnectionId: 801, listingId: 5, productVariantId: 70011, state: "failed", version: 4,
    code: "DROPSHIP_LISTING_END_WITHDRAW_UNCERTAIN", staffAction: null, staffActionKey: null, resolvedIdentity: IDENTITY,
    withdrawCallCount: 1, withdrawRequestedAt: new Date("2026-10-26T09:00:00.000Z"), ...overrides };
}

function wireRow(row: ListingEndOpsLockedRow): ListingEndOpsRow {
  return {
    endRequestId: row.endRequestId,
    vendor: { vendorId: row.vendorId, memberId: "member-70", businessName: null, email: null },
    store: { storeConnectionId: row.storeConnectionId, platform: "ebay", status: "connected", displayName: null },
    listing: { listingId: row.listingId, status: "active", externalListingId: "L-801-70011", externalOfferId: "O-801-70011" },
    productId: 7001, productVariantId: row.productVariantId, sku: "S-70011", reason: "size_removed", state: row.state, code: row.code,
    message: null, context: { lastCode: null, attemptIds: [], evidence: null, requiresReview: false }, attemptCount: 0, deferralCount: 0,
    withdraw: { callCount: row.withdrawCallCount, requestedAt: null, returnedAt: null, outcome: null }, staffAction: row.staffAction,
    decidedAt: null, createdAt: "2026-10-25T12:00:00.000Z", updatedAt: "2026-10-26T10:00:00.000Z",
  };
}

/** The repository's transaction in memory: the locked row, the writes made on it, and the commit or rollback. */
class FakeRepository implements DropshipListingEndOpsRepository {
  row: ListingEndOpsLockedRow | null = lockedRow();
  readonly writes: Array<{ kind: "retry" | "resolve_ended" | "resolve_left"; write: ListingEndOpsWrite }> = [];
  readonly lists: ListListingEndsInput[] = [];
  readonly events: string[] = [];
  listAnswer: ListingEndOpsListAnswer = { items: [], total: 0, page: 1, limit: 50, state: "failed" };

  async list(input: ListListingEndsInput) {
    this.lists.push(input);
    return this.listAnswer;
  }

  async withLockedEndRequest<T>(endRequestId: number, work: (tx: ListingEndOpsTransaction) => Promise<T>) {
    this.events.push(`lock:${endRequestId}`);
    if (!this.row || this.row.endRequestId !== endRequestId) return { found: false as const };
    const before = this.row;
    let after = before;
    const writes: typeof this.writes = [];
    const tx: ListingEndOpsTransaction = {
      row: before,
      retry: async (write) => {
        writes.push({ kind: "retry", write });
        after = { ...before, state: "pending", version: before.version + 1, staffAction: "retry", staffActionKey: write.idempotencyKey,
          code: null, withdrawCallCount: 0, withdrawRequestedAt: null };
      },
      resolveEnded: async (write) => {
        writes.push({ kind: "resolve_ended", write });
        after = { ...before, state: "ended", version: before.version + 1, staffAction: "resolve_ended", staffActionKey: write.idempotencyKey,
          code: "DROPSHIP_LISTING_END_ENDED_BY_STAFF" };
        return { listingWritten: true };
      },
      resolveLeft: async (write) => {
        writes.push({ kind: "resolve_left", write });
        after = { ...before, state: "resolved", version: before.version + 1, staffAction: "resolve_left", staffActionKey: write.idempotencyKey };
      },
    };
    try {
      const value = await work(tx);
      this.row = after;
      this.writes.push(...writes);
      this.events.push("commit");
      return { found: true as const, value, row: wireRow(after) };
    } catch (error) {
      this.events.push("rollback");
      throw error;
    }
  }
}

class FakeRecovery {
  readonly calls: ListingEndRecoveryScope[][] = [];
  answer = { resolved: [] as string[], unresolved: [] as string[], busy: false };
  async reconcile(scopes: readonly ListingEndRecoveryScope[]) {
    this.calls.push([...scopes]);
    return this.answer;
  }
}

function harness() {
  const repository = new FakeRepository();
  const recovery = new FakeRecovery();
  const lines: Array<{ level: string; action: string; fields: Record<string, unknown> }> = [];
  const service = new DropshipListingEndOpsService({ repository, recovery, clock: { now: () => NOW },
    log: { debug: (action, fields) => lines.push({ level: "debug", action, fields }),
      info: (action, fields) => lines.push({ level: "info", action, fields }) } });
  return { repository, recovery, service, lines };
}

async function refusal(work: Promise<unknown>): Promise<DropshipError> {
  const error = await work.then(() => null, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(DropshipError);
  return error as DropshipError;
}

describe("DropshipListingEndOpsService (PLAN-C v4.1 §10; TST-5, TST-7)", () => {
  it("lists failed ends by default and validates the answer it sends", async () => {
    const { repository, service, lines } = harness();
    await expect(service.list({})).resolves.toEqual({ items: [], total: 0, page: 1, limit: 50, state: "failed" });
    expect(repository.lists).toEqual([{ state: "failed", page: 1, limit: 50 }]);
    expect(lines).toEqual([expect.objectContaining({ level: "debug", action: "dropship.listing_end_ops.listed" })]);
    repository.listAnswer = { items: [], total: -1, page: 1, limit: 50, state: "failed" };
    await expect(service.list({})).rejects.toThrow();
  });

  it("refuses a list query outside its bounds before reading anything", async () => {
    const { repository, service } = harness();
    expect((await refusal(service.list({ limit: 201 }))).code).toBe("DROPSHIP_LISTING_END_OPS_LIST_INVALID_INPUT");
    expect(repository.lists).toEqual([]);
  });

  it("Retry: asks recovery about the SKU's scope inside the lock, then sets the request pending with the key, actor and reason", async () => {
    const { repository, recovery, service, lines } = harness();
    const answer = await service.retry({ endRequestId: 9, idempotencyKey: KEY, reason: "Attested in recovery", actor: ACTOR });
    expect(recovery.calls).toEqual([[SCOPE]]);
    expect(repository.writes).toEqual([{ kind: "retry", write: { idempotencyKey: KEY, reason: "Attested in recovery", actor: ACTOR, now: NOW } }]);
    expect(repository.events).toEqual(["lock:9", "commit"]);
    expect(answer).toMatchObject({ action: "retry", idempotentReplay: false, endRequest: { endRequestId: 9, state: "pending", staffAction: "retry" } });
    expect(lines).toContainEqual(expect.objectContaining({ level: "info", action: "dropship.listing_end_ops.applied", fields: expect.objectContaining({
      action: "retry", actor_id: "staff-1", reason: "Attested in recovery", before: { state: "failed", code: "DROPSHIP_LISTING_END_WITHDRAW_UNCERTAIN",
        version: 4 }, after: { state: "pending", code: null } }) }));
  });

  it("Retry: refuses 409 QUANTITY_RECOVERY_REQUIRED with the open attempt ids while an inventory request is unsettled, writing nothing", async () => {
    const { repository, recovery, service } = harness();
    recovery.answer = { resolved: [], unresolved: ["41", "42"], busy: false };
    const error = await refusal(service.retry({ endRequestId: 9, idempotencyKey: KEY, actor: ACTOR }));
    expect(error.code).toBe("DROPSHIP_LISTING_END_QUANTITY_RECOVERY_REQUIRED");
    expect(error.message).toBe("Settle the open inventory request first (Inventory publication recovery), then retry.");
    expect(error.context).toMatchObject({ attemptIds: ["41", "42"], reason: "unresolved_attempts", classification: "permanent", retryable: false });
    expect(repository.writes).toEqual([]);
    expect(repository.events).toEqual(["lock:9", "rollback"]);
  });

  it("Retry: a busy recovery is STAFF_BUSY (transient), never read as clear", async () => {
    const { repository, recovery, service } = harness();
    recovery.answer = { resolved: [], unresolved: [], busy: true };
    const error = await refusal(service.retry({ endRequestId: 9, idempotencyKey: KEY, actor: ACTOR }));
    expect(error.code).toBe("DROPSHIP_LISTING_END_STAFF_BUSY");
    expect(error.context).toMatchObject({ classification: "transient", retryable: true });
    expect(repository.writes).toEqual([]);
  });

  it("Retry: a request the claim never resolved sent nothing, so recovery is not asked; one that sent with no identity is refused", async () => {
    const first = harness();
    first.repository.row = lockedRow({ resolvedIdentity: null, withdrawCallCount: 0, withdrawRequestedAt: null,
      code: "DROPSHIP_LISTING_END_SHARED_LISTING" });
    await first.service.retry({ endRequestId: 9, idempotencyKey: KEY, actor: ACTOR });
    expect(first.recovery.calls).toEqual([]);
    expect(first.repository.writes.map((write) => write.kind)).toEqual(["retry"]);

    const second = harness();
    second.repository.row = lockedRow({ resolvedIdentity: null, withdrawCallCount: 1 });
    const error = await refusal(second.service.retry({ endRequestId: 9, idempotencyKey: KEY, actor: ACTOR }));
    expect(error).toMatchObject({ code: "DROPSHIP_LISTING_END_QUANTITY_RECOVERY_REQUIRED", context: expect.objectContaining({ reason: "identity_unreadable" }) });
    expect(second.recovery.calls).toEqual([]);
    expect(second.repository.writes).toEqual([]);
  });

  it("the same key and action answer 200 with the row as it now is, and write and ask nothing", async () => {
    const { repository, recovery, service, lines } = harness();
    repository.row = lockedRow({ state: "ending", staffAction: "retry", staffActionKey: KEY });
    const answer = await service.retry({ endRequestId: 9, idempotencyKey: KEY, actor: ACTOR });
    expect(answer).toMatchObject({ idempotentReplay: true, action: "retry", endRequest: { state: "ending" } });
    expect(recovery.calls).toEqual([]);
    expect(repository.writes).toEqual([]);
    expect(lines).toContainEqual(expect.objectContaining({ level: "debug", action: "dropship.listing_end_ops.replayed" }));
  });

  it("the same key with another action is 409 STAFF_KEY_REUSED; another state is 409 STAFF_STATE_INVALID; an unknown id 404", async () => {
    const reused = harness();
    reused.repository.row = lockedRow({ state: "pending", staffAction: "retry", staffActionKey: KEY });
    expect((await refusal(reused.service.resolve({ endRequestId: 9, outcome: "left_on_sale", reason: "Kept it.", idempotencyKey: KEY,
      actor: ACTOR }))).code).toBe("DROPSHIP_LISTING_END_STAFF_KEY_REUSED");
    expect(reused.repository.writes).toEqual([]);

    for (const state of ["pending", "ending", "ended", "superseded", "resolved"] as const) {
      const wrong = harness();
      wrong.repository.row = lockedRow({ state });
      expect((await refusal(wrong.service.retry({ endRequestId: 9, idempotencyKey: KEY, actor: ACTOR }))).code)
        .toBe("DROPSHIP_LISTING_END_STAFF_STATE_INVALID");
      expect(wrong.recovery.calls).toEqual([]);
      expect(wrong.repository.writes).toEqual([]);
    }

    const missing = harness();
    expect(await refusal(missing.service.retry({ endRequestId: 10, idempotencyKey: KEY, actor: ACTOR })))
      .toMatchObject({ code: "DROPSHIP_LISTING_END_NOT_FOUND", context: { endRequestId: 10 } });
  });

  it("Resolve: Ended on eBay and Left on sale each make their own write with the required reason; no recovery asked", async () => {
    const ended = harness();
    const answer = await ended.service.resolve({ endRequestId: 9, outcome: "ended_on_ebay", reason: " Ended it on eBay. ", idempotencyKey: KEY,
      actor: ACTOR });
    expect(answer).toMatchObject({ action: "resolve_ended", idempotentReplay: false,
      endRequest: { state: "ended", code: "DROPSHIP_LISTING_END_ENDED_BY_STAFF" } });
    expect(ended.repository.writes).toEqual([{ kind: "resolve_ended", write: { idempotencyKey: KEY, reason: "Ended it on eBay.", actor: ACTOR, now: NOW } }]);
    expect(ended.recovery.calls).toEqual([]);
    expect(ended.lines).toContainEqual(expect.objectContaining({ fields: expect.objectContaining({ listing_written: true }) }));

    const left = harness();
    expect(await left.service.resolve({ endRequestId: 9, outcome: "left_on_sale", reason: "Seller keeps it.", idempotencyKey: KEY, actor: ACTOR }))
      .toMatchObject({ action: "resolve_left", endRequest: { state: "resolved", staffAction: "resolve_left" } });
    expect(left.repository.writes.map((write) => write.kind)).toEqual(["resolve_left"]);
  });

  it("refuses an action without a key, a resolve without a reason or outcome, and a request without a staff actor, before locking", async () => {
    const { repository, service } = harness();
    for (const input of [
      { endRequestId: 9, actor: ACTOR },
      { endRequestId: 9, idempotencyKey: KEY, actor: { actorType: "admin" } },
    ]) {
      expect((await refusal(service.retry(input))).code).toBe("DROPSHIP_LISTING_END_OPS_ACTION_INVALID_INPUT");
    }
    for (const input of [
      { endRequestId: 9, outcome: "ended_on_ebay", idempotencyKey: KEY, actor: ACTOR },
      { endRequestId: 9, outcome: "ended_on_ebay", reason: "  ", idempotencyKey: KEY, actor: ACTOR },
      { endRequestId: 9, reason: "Ended it.", idempotencyKey: KEY, actor: ACTOR },
    ]) {
      expect((await refusal(service.resolve(input))).code).toBe("DROPSHIP_LISTING_END_OPS_ACTION_INVALID_INPUT");
    }
    expect(repository.events).toEqual([]);
  });
});
