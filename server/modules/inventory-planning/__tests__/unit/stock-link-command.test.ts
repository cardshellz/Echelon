import { beforeEach, describe, expect, it, vi } from "vitest";

// Channels PR2 (PLAN-CH2 v4.1 §4.3, §5): the stock-link command runner's fixed order and its step-6 locks, with a fake
// store and client. The policies' real behaviour is pinned over PostgreSQL (stock-link.integration.test.ts, PG 2-26).
const fence = vi.hoisted(() => vi.fn());
vi.mock("../../../../db", () => ({ pool: {}, db: {} }));
vi.mock("../../infrastructure/inventory-cutover-admission-fence.repository", () => ({ acquireInventoryCutoverFenceInsideTransaction: fence }));

import {
  STOCK_LINK_HEADS_FOR_UPDATE_SQL, lockStockLinkCommandMembers, runStockLinkCommand, type StockLinkCommandLocks,
  type StockLinkCommandPolicy, type StockLinkTransactionOutcome,
} from "../../infrastructure/stock-link-command";

type Answer = (values: readonly unknown[]) => { rows: unknown[] };
const calls: string[] = [];

/** A client that records every statement and answers from `answers` (by statement prefix); anything else: no rows. */
function fakeClient(answers: Array<[string, Answer]> = []) {
  return { query: vi.fn(async (text: string, values: readonly unknown[] = []) => {
    calls.push(`sql:${text === STOCK_LINK_HEADS_FOR_UPDATE_SQL ? "heads FOR UPDATE" : text.split("(")[0]!.trim()}`);
    const answer = answers.find(([prefix]) => text.startsWith(prefix));
    return answer ? answer[1](values) : { rows: [] };
  }) };
}

const acquired = (value: boolean): Answer => () => ({ rows: [{ acquired: value }] });

/** The mapping-preparation store's contract: one transaction with its own scope-key list, failures rethrown. */
function fakeStore(client: ReturnType<typeof fakeClient>, scopeKeys: string[] = []) {
  return { transaction: vi.fn(async (_mode: unknown, work: (client: never, scopeKeys: string[]) => Promise<unknown>) => {
    calls.push("begin");
    const result = await work(client as never, scopeKeys);
    calls.push("commit");
    return result;
  }) } as never;
}

const locks = (overrides: Partial<StockLinkCommandLocks> = {}): StockLinkCommandLocks => ({ publicationTargetId: 9,
  pairVariantIds: [102, 101], scopeKeys: ["key-b", "key-a"],
  heads: [{ productVariantId: 102, expectedRevision: "0" }, { productVariantId: 101, expectedRevision: "4" }], ...overrides });

function policy(overrides: Partial<StockLinkCommandPolicy<string, string, string, string, string>> = {}) {
  const base: StockLinkCommandPolicy<string, string, string, string, string> = {
    lockKey: "stock-link:cmd",
    beforeTransaction: vi.fn(async () => { calls.push("before"); return { kind: "transaction" as const }; }),
    readRecorded: vi.fn(async () => { calls.push("readRecorded"); return null; }),
    prepare: vi.fn(async () => { calls.push("prepare"); return { kind: "apply" as const, prepared: "prepared", locks: locks() }; }),
    preLock: vi.fn(async () => { calls.push("preLock"); }),
    apply: vi.fn(async () => { calls.push("apply"); return "applied"; }),
    afterCommit: vi.fn(async (outcome: StockLinkTransactionOutcome<string, string, string>, hold: number | null) => {
      calls.push(`afterCommit:${outcome.kind}:${hold}`); return "result"; }),
    onError: vi.fn(async (_error: unknown, hold: number | null) => { calls.push(`onError:${hold}`); return "failed"; }),
  };
  return { ...base, ...overrides };
}

const heads = (rows: Array<{ product_variant_id: number; revision: string; active_mapping_id?: number | null }>): Answer => () => ({
  rows: rows.map(row => ({ active_mapping_id: null, draft_mapping_id: null, ...row })) });

beforeEach(() => {
  calls.length = 0;
  fence.mockReset();
  fence.mockImplementation(async () => { calls.push("fence"); });
});

describe("runStockLinkCommand", () => {
  it("runs the steps in order: fence, command lock, receipt, claim, pre-lock, pair and scope TRY locks, heads, apply, commit", async () => {
    const client = fakeClient([["SELECT pg_try_advisory", acquired(true)], [STOCK_LINK_HEADS_FOR_UPDATE_SQL,
      heads([{ product_variant_id: 101, revision: "4", active_mapping_id: 61 }])]]);
    const scopeKeys: string[] = [];
    const hooks = policy();
    let clock = 100;
    expect(await runStockLinkCommand(fakeStore(client, scopeKeys), hooks, { monotonicNow: () => (clock += 400) })).toBe("result");
    expect(calls).toEqual(["before", "begin", "fence", "sql:SELECT pg_advisory_xact_lock", "readRecorded", "prepare", "preLock",
      "sql:SELECT pg_try_advisory_xact_lock", "sql:SELECT pg_try_advisory_xact_lock", "sql:SELECT pg_try_advisory_lock",
      "sql:SELECT pg_try_advisory_lock", "sql:heads FOR UPDATE", "apply", "commit", "afterCommit:applied:400"]);
    expect(fence).toHaveBeenCalledWith(client, { expectedAuthority: "canonical", expectedConfigurationRunId: null });
    // The command lock is the policy's string, as the Dropship writer takes it (hashtextextended(<key>, 0)).
    expect(client.query).toHaveBeenCalledWith("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", ["stock-link:cmd"]);
    // Pairs and scope keys in a stable order; scope keys handed to the store only once held.
    expect(client.query.mock.calls.filter(([text]) => String(text).startsWith("SELECT pg_try_advisory_xact_lock")).map(([, values]) => values))
      .toEqual([[9, 101], [9, 102]]);
    expect(client.query.mock.calls.filter(([text]) => String(text).startsWith("SELECT pg_try_advisory_lock")).map(([, values]) => values))
      .toEqual([["key-a", 918420], ["key-b", 918420]]);
    expect(scopeKeys).toEqual(["key-a", "key-b"]);
    expect(hooks.apply).toHaveBeenCalledWith(client, scopeKeys, "prepared", [
      { productVariantId: 101, revision: "4", activeMappingId: 61, draftMappingId: null },
      { productVariantId: 102, revision: "0", activeMappingId: null, draftMappingId: null },
    ]);
  });

  it("ends at the receipt: nothing is claimed or locked, the recorded outcome goes to the final assert", async () => {
    const hooks = policy({ readRecorded: vi.fn(async () => { calls.push("readRecorded"); return "receipt"; }) });
    await runStockLinkCommand(fakeStore(fakeClient()), hooks, { monotonicNow: () => 0 });
    expect(calls).toEqual(["before", "begin", "fence", "sql:SELECT pg_advisory_xact_lock", "readRecorded", "commit", "afterCommit:recorded:0"]);
    expect(hooks.afterCommit).toHaveBeenCalledWith({ kind: "recorded", recorded: "receipt" }, 0);
  });

  it("settles without the step-6 locks when the policy stops (switch off, halted, already done)", async () => {
    const hooks = policy({ prepare: vi.fn(async () => { calls.push("prepare"); return { kind: "settled" as const, settled: "stopped" }; }) });
    await runStockLinkCommand(fakeStore(fakeClient()), hooks, { monotonicNow: () => 0 });
    expect(calls).toEqual(["before", "begin", "fence", "sql:SELECT pg_advisory_xact_lock", "readRecorded", "prepare", "commit",
      "afterCommit:settled:0"]);
    expect(hooks.preLock).not.toHaveBeenCalled();
  });

  it("returns the policy's early result, or skips the transaction with a settled outcome (no fence hold)", async () => {
    const early = policy({ beforeTransaction: vi.fn(async () => ({ kind: "result" as const, result: "fast" })) });
    const store = fakeStore(fakeClient());
    expect(await runStockLinkCommand(store, early, { monotonicNow: () => 0 })).toBe("fast");
    const skip = policy({ beforeTransaction: vi.fn(async () => ({ kind: "skip" as const, settled: "already" })) });
    expect(await runStockLinkCommand(store, skip, { monotonicNow: () => 0 })).toBe("result");
    expect(skip.afterCommit).toHaveBeenCalledWith({ kind: "settled", settled: "already" }, null);
    expect((store as unknown as { transaction: { mock: { calls: unknown[] } } }).transaction.mock.calls).toHaveLength(0);
    expect(fence).not.toHaveBeenCalled();
  });

  it("hands every failure to onError with the fence hold so far, or null before the fence", async () => {
    const failing = { transaction: vi.fn(async () => { throw Object.assign(new Error("lost"), { code: "08006" }); }) } as never;
    const hooks = policy();
    expect(await runStockLinkCommand(failing, hooks, { monotonicNow: () => 0 })).toBe("failed");
    expect(hooks.onError).toHaveBeenCalledWith(expect.objectContaining({ code: "08006" }), null);
    const afterFence = policy({ prepare: vi.fn(async () => { throw new Error("claim lost"); }) });
    let clock = 0;
    await runStockLinkCommand(fakeStore(fakeClient()), afterFence, { monotonicNow: () => (clock += 250) });
    expect(afterFence.onError).toHaveBeenCalledWith(expect.objectContaining({ message: "claim lost" }), 250);
    expect(afterFence.afterCommit).not.toHaveBeenCalled();
  });
});

describe("lockStockLinkCommandMembers (step 6)", () => {
  it("is busy, without waiting, when another holder has a member's pair (create members too)", async () => {
    const client = fakeClient([["SELECT pg_try_advisory_xact_lock", values => ({ rows: [{ acquired: values[1] !== 102 }] })]]);
    const scopeKeys: string[] = [];
    await expect(lockStockLinkCommandMembers(client as never, scopeKeys, locks())).rejects.toMatchObject({
      code: "STOCK_LINK_PAIR_BUSY", errorClass: "transient", context: { publicationTargetId: 9, productVariantId: 102 } });
    expect(scopeKeys).toEqual([]);
    expect(client.query.mock.calls.some(([text]) => String(text).includes("FOR UPDATE"))).toBe(false);
  });

  it("is busy when a provider request holds a scope key, handing the store only the keys it holds", async () => {
    const client = fakeClient([["SELECT pg_try_advisory_xact_lock", acquired(true)],
      ["SELECT pg_try_advisory_lock", values => ({ rows: [{ acquired: values[0] === "key-a" }] })]]);
    const scopeKeys: string[] = [];
    await expect(lockStockLinkCommandMembers(client as never, scopeKeys, locks())).rejects.toMatchObject({ code: "STOCK_LINK_SCOPE_BUSY" });
    expect(scopeKeys).toEqual(["key-a"]);
  });

  it.each([
    { name: "a decided revision moved", rows: [{ product_variant_id: 101, revision: "5" }], variant: 101 },
    { name: "a size decided without a head has one now", rows: [{ product_variant_id: 101, revision: "4" }, { product_variant_id: 102, revision: "1" }],
      variant: 102 },
    { name: "a decided head is gone", rows: [], variant: 101 },
  ])("refuses STOCK_LINK_HEAD_CHANGED when $name", async ({ rows, variant }) => {
    const client = fakeClient([["SELECT pg_try_advisory", acquired(true)], [STOCK_LINK_HEADS_FOR_UPDATE_SQL, heads(rows)]]);
    await expect(lockStockLinkCommandMembers(client as never, [], locks())).rejects.toMatchObject({ code: "STOCK_LINK_HEAD_CHANGED",
      errorClass: "transient", context: expect.objectContaining({ productVariantId: variant }) });
  });

  it("locks nothing for a policy without members to lock", async () => {
    const client = fakeClient();
    expect(await lockStockLinkCommandMembers(client as never, [], locks({ pairVariantIds: [], scopeKeys: [], heads: [] }))).toEqual([]);
    expect(client.query).not.toHaveBeenCalled();
  });
});
