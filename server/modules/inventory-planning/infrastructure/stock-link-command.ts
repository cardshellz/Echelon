import type { PoolClient } from "pg";
import { STOCK_LINK_ERROR_CODES, StockLinkError } from "../domain/stock-link-errors";
import { acquireInventoryCutoverFenceInsideTransaction } from "./inventory-cutover-admission-fence.repository";
import { PUBLICATION_TARGET_SCOPE_LOCK_SEED } from "./inventory-publication-target-stop.repository";
import type { PublicationMappingPreparationStore } from "./publication-mapping-preparation.repository";

/**
 * One stock-link command (channels PR2, PLAN-CH2 v4.1 §4.3, §5): the fixed order of the engine's one configuration
 * transaction, shared by every policy. The runner never branches on the policy kind; a policy supplies its fast path,
 * receipt, claim and confirmation, pre-lock, apply and result builders (§5 "Policy hooks").
 *
 *  0. `beforeTransaction`, outside any transaction (fast path, evidence age, pre-checks);
 *  1. the mapping-preparation store's READ COMMITTED configuration transaction (lock_timeout 5 s, statement_timeout 60 s);
 *  2. the canonical cutover fence; the monotonic fence-hold timer starts;
 *  3. the command lock pg_advisory_xact_lock(hashtextextended('<prefix>:<commandKey>', 0)) and the policy's receipt;
 *  4-5. `prepare`: claim, switch, destination and confirmation under row locks; it may settle without a change;
 *  6. locks, in this order: the policy's pre-lock; pg_try_advisory_xact_lock(targetId, variantId) for every member;
 *     session TRY locks on the provider request scope keys (sorted, pushed into the store's scopeKeys so the store
 *     releases them after COMMIT or ROLLBACK); the members' mapping heads FOR UPDATE at their decided revisions;
 *  7-10. `apply`: retire, link, audit, receipt, check rows;
 *  11. COMMIT (the store), then `afterCommit` (final assert). Any failure goes to `onError` with the fence hold.
 *
 * Nothing here waits on a lock it can only TRY (pair, scope): another holder makes the command busy, never blocked
 * behind a provider request. No provider I/O happens inside the transaction.
 */

/** What step 6 locks for one command. Empty lists lock nothing (a policy without retire members, §5). */
export interface StockLinkCommandLocks {
  readonly publicationTargetId: number;
  /** Every member, create members too (SAF-4): the enqueue's own TRY lock is then re-entrant. */
  readonly pairVariantIds: readonly number[];
  /** Provider request scope keys (quantityPublicationScopeLockKey) of the items the command stops or starts writing. */
  readonly scopeKeys: readonly string[];
  /** The heads to lock and the revision each must still have ("0" = the size must have no head). */
  readonly heads: readonly { readonly productVariantId: number; readonly expectedRevision: string }[];
}

/** A member's head as step 6 locked it: the before-state of the audit row (null = no head). */
export interface StockLinkLockedHead {
  readonly productVariantId: number;
  readonly revision: string;
  readonly activeMappingId: number | null;
  readonly draftMappingId: number | null;
}

/** What `beforeTransaction` decided: end with a result, skip the transaction with a settled outcome, or run it. */
export type StockLinkBeforeTransaction<TResult, TSettled> =
  | { readonly kind: "result"; readonly result: TResult }
  | { readonly kind: "skip"; readonly settled: TSettled }
  | { readonly kind: "transaction" };

export type StockLinkPrepared<TSettled, TPrepared> =
  | { readonly kind: "settled"; readonly settled: TSettled }
  | { readonly kind: "apply"; readonly prepared: TPrepared; readonly locks: StockLinkCommandLocks };

/** How the transaction ended: a recorded receipt (nothing written), a settled outcome (committed, no change), or applied. */
export type StockLinkTransactionOutcome<TRecorded, TSettled, TApplied> =
  | { readonly kind: "recorded"; readonly recorded: TRecorded }
  | { readonly kind: "settled"; readonly settled: TSettled }
  | { readonly kind: "applied"; readonly applied: TApplied };

export interface StockLinkCommandPolicy<TResult, TRecorded, TSettled, TPrepared, TApplied> {
  /** `<prefix>:<commandKey>`: the command lock string (C14); Dropship keeps `dropship-ebay-stock:<uuid>`. */
  readonly lockKey: string;
  beforeTransaction(): Promise<StockLinkBeforeTransaction<TResult, TSettled>>;
  /** Step 3, under the command lock: this command's receipt, or null. */
  readRecorded(client: PoolClient): Promise<TRecorded | null>;
  /** Steps 4-5. */
  prepare(client: PoolClient): Promise<StockLinkPrepared<TSettled, TPrepared>>;
  /** Step 6, before any other lock of the step (N3: the draft writer's lock before the heads). */
  preLock(client: PoolClient, prepared: TPrepared): Promise<void>;
  /** Steps 7-10, with every lock of step 6 held. */
  apply(client: PoolClient, scopeKeys: string[], prepared: TPrepared, heads: readonly StockLinkLockedHead[]): Promise<TApplied>;
  /** Step 11, after COMMIT; `fenceHoldMs` is null when the transaction did not run. */
  afterCommit(outcome: StockLinkTransactionOutcome<TRecorded, TSettled, TApplied>, fenceHoldMs: number | null): Promise<TResult>;
  /** Every failure of steps 1-11 (the store already rolled back, and released its scope locks). May rethrow. */
  onError(error: unknown, fenceHoldMs: number | null): Promise<TResult>;
}

export interface StockLinkCommandRunnerDeps {
  /** Injected monotonic clock (ms) for the fence hold, as the Dropship writer measures it. */
  readonly monotonicNow: () => number;
}

export async function runStockLinkCommand<TResult, TRecorded, TSettled, TPrepared, TApplied>(
  store: Pick<PublicationMappingPreparationStore, "transaction">,
  policy: StockLinkCommandPolicy<TResult, TRecorded, TSettled, TPrepared, TApplied>,
  deps: StockLinkCommandRunnerDeps,
): Promise<TResult> {
  const before = await policy.beforeTransaction();
  if (before.kind === "result") return before.result;
  if (before.kind === "skip") return policy.afterCommit({ kind: "settled", settled: before.settled }, null);
  let fenceStartedAt: number | null = null;
  const holdMs = () => fenceStartedAt === null ? null : Math.max(0, Math.round(deps.monotonicNow() - fenceStartedAt));
  let outcome: StockLinkTransactionOutcome<TRecorded, TSettled, TApplied>;
  try {
    outcome = await store.transaction("configuration", async (client, scopeKeys):
      Promise<StockLinkTransactionOutcome<TRecorded, TSettled, TApplied>> => {
      await acquireInventoryCutoverFenceInsideTransaction(client, { expectedAuthority: "canonical", expectedConfigurationRunId: null });
      fenceStartedAt = deps.monotonicNow();
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [policy.lockKey]);
      const recorded = await policy.readRecorded(client);
      if (recorded !== null) return { kind: "recorded", recorded };
      const prepared = await policy.prepare(client);
      if (prepared.kind === "settled") return { kind: "settled", settled: prepared.settled };
      await policy.preLock(client, prepared.prepared);
      const heads = await lockStockLinkCommandMembers(client, scopeKeys, prepared.locks);
      return { kind: "applied", applied: await policy.apply(client, scopeKeys, prepared.prepared, heads) };
    });
  } catch (error) {
    return policy.onError(error, holdMs());
  }
  return policy.afterCommit(outcome, holdMs());
}

/** The engine's heads read under lock (step 6); tests pause on this exact statement (PG 9). */
export const STOCK_LINK_HEADS_FOR_UPDATE_SQL = `SELECT product_variant_id, revision::text AS revision, active_mapping_id, draft_mapping_id
       FROM inventory.publication_variant_mapping_heads
       WHERE publication_target_id = $1 AND product_variant_id = ANY($2::integer[])
       ORDER BY product_variant_id
       FOR UPDATE`;

/**
 * Step 6 after the policy's pre-lock. Every lock is a TRY lock except the heads' row locks, which are taken last and
 * only after the draft writer's per-destination lock (the policy's pre-lock), so a manual draft save and the engine
 * always meet on that lock first (N3, PG 9).
 */
export async function lockStockLinkCommandMembers(client: PoolClient, scopeKeys: string[],
  locks: StockLinkCommandLocks): Promise<StockLinkLockedHead[]> {
  const targetId = locks.publicationTargetId;
  for (const productVariantId of [...new Set(locks.pairVariantIds)].sort((a, b) => a - b)) {
    // The outbox worker holds this pair as a session lock across its provider call (runIfCurrent); the enqueue
    // TRY-locks it (runtime publication repository). Taking it here first makes the command's own enqueue re-entrant
    // and keeps the identity check of a worker that starts later on the committed state (§4.8).
    const acquired = (await client.query<{ acquired: boolean }>("SELECT pg_try_advisory_xact_lock($1, $2) AS acquired",
      [targetId, productVariantId])).rows[0]?.acquired;
    if (acquired !== true) {
      throw new StockLinkError(STOCK_LINK_ERROR_CODES.pairBusy,
        "A stock update for this size is in flight; the link is checked again shortly.", { publicationTargetId: targetId, productVariantId });
    }
  }
  for (const key of [...new Set(locks.scopeKeys)].sort()) {
    const acquired = (await client.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_lock(hashtextextended($1,$2)) AS acquired", [key, PUBLICATION_TARGET_SCOPE_LOCK_SEED])).rows[0]?.acquired;
    if (acquired !== true) {
      throw new StockLinkError(STOCK_LINK_ERROR_CODES.scopeBusy,
        "A provider request for this store item is in flight; the link is checked again shortly.", { publicationTargetId: targetId });
    }
    // Pushed only once held: the store releases exactly the keys this transaction took (C18).
    scopeKeys.push(key);
  }
  const expected = new Map(locks.heads.map(head => [head.productVariantId, head.expectedRevision]));
  if (expected.size === 0) return [];
  const rows = (await client.query<{ product_variant_id: number; revision: string; active_mapping_id: number | null;
    draft_mapping_id: number | null }>(STOCK_LINK_HEADS_FOR_UPDATE_SQL, [targetId, [...expected.keys()]])).rows;
  const locked = new Map(rows.map(row => [Number(row.product_variant_id), row]));
  const heads: StockLinkLockedHead[] = [];
  for (const [productVariantId, revision] of [...expected].sort(([a], [b]) => a - b)) {
    const row = locked.get(productVariantId);
    if ((row?.revision ?? "0") !== revision) {
      throw new StockLinkError(STOCK_LINK_ERROR_CODES.headChanged,
        "The size's stock link changed after it was checked; it is decided again on the next check.",
        { publicationTargetId: targetId, productVariantId, expectedHeadRevision: revision, headRevision: row?.revision ?? "0" });
    }
    heads.push({ productVariantId, revision, activeMappingId: row ? nullableId(row.active_mapping_id) : null,
      draftMappingId: row ? nullableId(row.draft_mapping_id) : null });
  }
  return heads;
}

function nullableId(value: number | string | null): number | null {
  return value === null ? null : Number(value);
}
