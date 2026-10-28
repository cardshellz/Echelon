import type { Pool, PoolClient } from "pg";
import { performance } from "node:perf_hooks";
import { z } from "zod";
import {
  dropshipEbayStockActorSchema, dropshipEbayStockReadinessResultSchema,
  type DropshipEbayStockReadinessInput, type DropshipEbayStockReadinessResult,
} from "@shared/types/dropship-ebay-stock-readiness";
import type { PublicationMembershipBlocker } from "@shared/types/inventory-publication-membership";
import type { PublicationMappingPreparationReceipt } from "@shared/types/inventory-publication-mapping-preparation";
import { InventoryPublicationMembershipError } from "../application/inventory-publication-membership.service";
import { InventoryAvailabilityMasterDataError } from "../domain/inventory-availability-master-data.contracts";
import { QuantityPublicationAdmissionError } from "../domain/quantity-publication-admission";
import {
  DROPSHIP_EBAY_STOCK_CHANGE_REASON, DROPSHIP_EBAY_STOCK_KEY_PREFIX, FENCE_HOLD_WARN_MS, PLANS_IN_FENCE,
  dropshipEbayStockCommandKey, dropshipEbayStockPreparationKey, dropshipEbayStockRequestHash, normalizeDropshipEbayStockInput,
} from "../domain/dropship-ebay-stock-readiness";
import { logger as platformLogger } from "../../../platform/observability/logger";
import { readCanonicalQuantityPublicationMember } from "./canonical-quantity-publication-member.reader";
import { PublicationMappingPreparationStore, type MappingPreparationTarget } from "./publication-mapping-preparation.repository";
import { applyExactEbaySkuMappingsInsideTransaction } from "./exact-ebay-sku-mapping.apply";
import {
  captureDropshipEbayStockReadiness, readDropshipEbayStockMemberRows, reviewDropshipEbayStockMembers,
  type DropshipEbayStockCapture,
} from "./dropship-ebay-stock-readiness.read";
import { runStockLinkCommand, type StockLinkCommandLocks, type StockLinkCommandPolicy } from "./stock-link-command";

type ConnectionPool = Pick<Pool, "connect" | "query">;
const fail = (code: string, message: string): never => { throw new InventoryPublicationMembershipError(code, message); };

/** Structured JSON lines (root CLAUDE.md section 10). ERROR is reserved for the
 * caller, which knows whether a refusal needs a human. */
export interface DropshipEbayStockReadinessLogger {
  debug(event: Readonly<Record<string, unknown>>): void;
  info(event: Readonly<Record<string, unknown>>): void;
  warn(event: Readonly<Record<string, unknown>>): void;
}
/** The platform JSON logger (PLAN-CH2 v4.1 C28): each event's own `action` names the line; logs only. */
const defaultLogger: DropshipEbayStockReadinessLogger = {
  debug: event => platformLogger.debug(String(event.action), event),
  info: event => platformLogger.info(String(event.action), event),
  warn: event => platformLogger.warn(String(event.action), event),
};

/** Same singleton read as the canonical catch-up owner (quantity-publication-runtime.ts).
 * A missing or unknown authority is an invariant failure, never a guess. */
export async function readDropshipEbayStockAuthority(pool: Pick<Pool, "query">): Promise<"legacy" | "canonical"> {
  const rows = (await pool.query<{ authority: unknown }>(
    "SELECT authority FROM inventory.availability_runtime_authority WHERE singleton_key=true")).rows;
  const parsed = z.enum(["legacy", "canonical"]).safeParse(rows[0]?.authority);
  if (rows.length !== 1 || !parsed.success) fail("PUBLICATION_AUTHORITY_MISSING", "Runtime publication authority is unavailable.");
  return parsed.data!;
}

/** Read-only review of what a link would do now (no fence, no writes). */
export async function reviewDropshipEbayStockReadiness(pool: Pick<Pool, "connect">, raw: unknown) {
  const source = normalizeDropshipEbayStockInput(raw);
  const capture = await new PublicationMappingPreparationStore(pool).transaction(false,
    client => captureDropshipEbayStockReadiness(client, source, { lock: false, quantityReview: true }));
  return { publicationTargetId: capture.target?.id ?? null, liveTargetCount: capture.liveTargetCount,
    ready: capture.blockers.length === 0, currentlyReady: capture.currentlyReady,
    variants: capture.variants, blockers: capture.blockers };
}

/** Rolls the apply transaction back with its business refusal. Internal only. */
class DropshipEbayStockBlocked extends Error {
  constructor(readonly publicationTargetId: number | null, readonly targetCount: number,
    readonly blockers: readonly PublicationMembershipBlocker[]) {
    super("Dropship eBay stock link refused.");
    this.name = "DropshipEbayStockBlocked";
  }
}

/** The draft writer's own business refusals (a race the locked capture did not
 * see). They are returned as blocked results, like every other business refusal. */
const DRAFT_WRITER_REFUSALS = new Set(["INVENTORY_PUBLICATION_VARIANT_MAPPING_IDENTITY_CONFLICT",
  "INVENTORY_PUBLICATION_VARIANT_MAPPING_SCOPE_INVALID"]);

/** The gate's own predicate (canonical-quantity-publication-member.reader.ts):
 * every member resolves to one sealed active mapping on one live Echelon
 * destination of this store account. Returns that destination, or null. */
async function readLinkedTarget(client: PoolClient, source: DropshipEbayStockReadinessInput): Promise<number | null> {
  const targets = new Set<number>();
  for (const variant of source.variants) {
    try {
      const member = await readCanonicalQuantityPublicationMember(client, { destinationKind: "dropship_store_connection",
        connectionId: source.storeConnectionId, providerKey: "ebay", providerScopeType: "account", externalScopeId: source.accountId,
        externalInventoryItemId: variant.sku, productId: source.productId, productVariantId: variant.productVariantId });
      targets.add(member.target_id);
    } catch (error) {
      if (error instanceof QuantityPublicationAdmissionError && error.code === "PUBLICATION_LISTING_TARGET_UNMAPPED") return null;
      throw error;
    }
  }
  return targets.size === 1 ? [...targets][0]! : null;
}

async function readPreparationRequestHash(client: PoolClient, idempotencyKey: string): Promise<string | null> {
  const row = (await client.query<{ request_hash: string }>(
    "SELECT request_hash FROM inventory.publication_mapping_preparations WHERE idempotency_key=$1", [idempotencyKey])).rows[0];
  return row?.request_hash ?? null;
}

/** What the locked capture decided (§5 "confirm: locked capture"), carried from step 4 to steps 7-10. */
interface DropshipEbayStockPrepared {
  readonly target: MappingPreparationTarget;
  readonly capture: DropshipEbayStockCapture;
}

/** What steps 7-10 applied. */
interface DropshipEbayStockApplied {
  readonly targetId: number;
  readonly preparation: PublicationMappingPreparationReceipt;
  readonly actions: DropshipEbayStockCapture["variants"];
}

/** Every member already has its exact sealed mapping: nothing to apply; the final assert decides. */
type DropshipEbayStockSettled = { readonly kind: "already" };

/** §5: no retire member, so no pair, scope or head lock in the runner's step 6 (the shared core takes the provider
 * scope TRY locks itself, as it always has). The command lock is the runner's. */
const noCommandLocks = (publicationTargetId: number): StockLinkCommandLocks =>
  ({ publicationTargetId, pairVariantIds: [], scopeKeys: [], heads: [] });

/**
 * Makes a Dropship eBay store listing's exact SKU stock link, or says precisely why
 * it cannot. Under legacy authority it is a no-op. Otherwise:
 *  1. fast path: the gate's own predicate already holds (no planner, no fence);
 *  2. a recorded preparation for this command whose link no longer holds is never
 *     re-applied under the same key (STOCK_MAPPING_LINK_CHANGED_AFTER_APPLY);
 *  3. a read-only pre-check refuses without taking the fence;
 *  4. one configuration transaction: cutover fence, command lock, locked capture,
 *     exact SKU draft + seal (shared core), canonical review and exact-variant
 *     publication with the preparation receipt, and this writer's audit row;
 *  5. the gate's predicate must hold afterwards.
 * Business refusals are returned as `blocked`. Concurrency and infrastructure
 * conditions (busy scope, serialization, fence, cleanup) are thrown for the caller
 * to classify and retry. No provider I/O happens here.
 *
 * Since channels PR2 (PLAN-CH2 v4.1 §5) this is the Dropship policy of the shared
 * stock-link command (stock-link-command.ts): steps 1-3 are its `beforeTransaction`,
 * the runner owns step 4's transaction, fence, hold timer and command lock
 * (`pg_advisory_xact_lock(hashtextextended('dropship-ebay-stock:<uuid>',0))`), and
 * step 5 is its `afterCommit`. Keys, request hash, receipt, target selection, audit
 * row, result and log lines are unchanged (IP/__tests__/unit/dropship-ebay-stock-keys.golden.test.ts,
 * dropship-ebay-stock-command-lock.integration.test.ts and both Dropship stock suites pin them).
 */
export async function ensureDropshipEbayStockReady(pool: ConnectionPool, raw: unknown, options: {
  actor: string; now: Date; requestedBy?: string; monotonicNow?: () => number; logger?: DropshipEbayStockReadinessLogger;
}): Promise<DropshipEbayStockReadinessResult> {
  const source = normalizeDropshipEbayStockInput(raw);
  const actor = dropshipEbayStockActorSchema.parse(options.actor);
  const now = z.date().parse(options.now);
  const requestedBy = options.requestedBy === undefined ? null : z.string().trim().min(1).max(100).parse(options.requestedBy);
  const monotonicNow = options.monotonicNow ?? (() => performance.now());
  const logger = options.logger ?? defaultLogger;
  const commandKey = dropshipEbayStockCommandKey(source.storeConnectionId, source.origin);
  const requestHash = dropshipEbayStockRequestHash(source, actor);
  const preparationKey = dropshipEbayStockPreparationKey(commandKey);
  const variantIds = source.variants.map(row => row.productVariantId);
  const correlation = { action: "inventory_availability.dropship_ebay_stock.ensure", vendor_id: source.vendorId,
    store_connection_id: source.storeConnectionId, product_id: source.productId, product_variant_ids: variantIds,
    command_key: commandKey, origin_kind: source.origin.kind, listing_id: source.origin.listingId,
    ...(source.origin.kind === "listing_push" ? { job_id: source.origin.jobId, job_item_id: source.origin.jobItemId } : {}) };
  const store = new PublicationMappingPreparationStore(pool);
  const finish = (result: DropshipEbayStockReadinessResult) => dropshipEbayStockReadinessResultSchema.parse(result);
  const blocked = (publicationTargetId: number | null, targetCount: number, blockers: readonly PublicationMembershipBlocker[],
    fenceHoldMs: number | null = null) => {
    logger.debug({ ...correlation, outcome: "blocked", publication_target_id: publicationTargetId, target_count: targetCount,
      inventory_codes: blockers.map(row => row.code), fence_hold_ms: fenceHoldMs });
    return finish({ status: "blocked", commandKey, publicationTargetId, targetCount, blockers: [...blockers] });
  };
  const ready = (publicationTargetId: number, alreadyLinked: boolean, mappingActions: DropshipEbayStockCapture["variants"],
    preparation: PublicationMappingPreparationReceipt | null, fenceHoldMs: number | null) => finish({ status: "ready", commandKey,
    publicationTargetId, linkedProductVariantIds: variantIds, alreadyLinked,
    mappingActions: mappingActions.map(row => ({ productVariantId: row.productVariantId, mappingAction: row.mappingAction })),
    preparation, fenceHoldMs });
  const noActions = source.variants.map(row => ({ ...row, mappingAction: "none" as const, desiredQuantity: null }));
  /** The gate's predicate does not hold: report the current refusal. A command
   * that already applied is never re-linked under its key; one that did not
   * apply lost a race with another link writer and is retried by the caller. */
  const classifyLostLink = async (fenceHoldMs: number | null, appliedByThisCommand: boolean) => {
    const capture = await store.transaction(false, client => captureDropshipEbayStockReadiness(client, source, { lock: false, quantityReview: true }));
    if (capture.blockers.length) return blocked(capture.target?.id ?? null, capture.liveTargetCount, capture.blockers, fenceHoldMs);
    if (!appliedByThisCommand) return fail("STOCK_MAPPING_CONCURRENT_CHANGE",
      "Concurrent inventory work changed this stock link while it was checked. Retry the saved listing request.");
    return blocked(capture.target?.id ?? null, capture.liveTargetCount, [{ code: "STOCK_MAPPING_LINK_CHANGED_AFTER_APPLY",
      message: "This command already linked the SKU, and that stock link was retired or replaced afterwards. Queue the listing again.",
      action: "review_mapping", productVariantId: null }], fenceHoldMs);
  };
  const recordedCommand = async (recordedHash: string, fenceHoldMs: number | null) => {
    if (recordedHash !== requestHash) return blocked(null, 0, [{ code: "STOCK_MAPPING_COMMAND_CONFLICT",
      message: "This stock link command was already used for a different SKU, store account or listing.",
      action: "review_variant", productVariantId: null }], fenceHoldMs);
    return classifyLostLink(fenceHoldMs, true);
  };
  /** The read-only pre-check (no fence); a draft-writer refusal inside the transaction is reported against it. */
  let precheck: DropshipEbayStockCapture | null = null;

  const policy: StockLinkCommandPolicy<DropshipEbayStockReadinessResult, string, DropshipEbayStockSettled,
    DropshipEbayStockPrepared, DropshipEbayStockApplied> = {
    lockKey: preparationKey,

    async beforeTransaction() {
      // 1. Legacy authority: Dropship pushes keep today's behavior; nothing is read or written.
      if (await readDropshipEbayStockAuthority(pool) === "legacy") {
        logger.debug({ ...correlation, outcome: "not_applicable", reason: "legacy_authority" });
        return { kind: "result", result: finish({ status: "not_applicable", reason: "legacy_authority" }) };
      }
      // 2. Fast path: exactly the gate's predicate. No planner work, no fence.
      const linkedTarget = await store.transaction(false, client => readLinkedTarget(client, source));
      if (linkedTarget !== null) {
        logger.debug({ ...correlation, outcome: "already_linked", publication_target_id: linkedTarget });
        return { kind: "result", result: ready(linkedTarget, true, noActions, null, null) };
      }
      // 3. This command already applied once, and its link no longer holds.
      const recorded = await store.transaction(false, client => readPreparationRequestHash(client, preparationKey));
      if (recorded !== null) return { kind: "result", result: await recordedCommand(recorded, null) };
      // 4. Pre-check without the fence. Its review hash is deliberately not kept: the
      // locked capture below decides what is applied (ATP may move while we wait).
      const checked = await store.transaction(false, client => captureDropshipEbayStockReadiness(client, source, { lock: false, quantityReview: true }));
      precheck = checked;
      if (checked.blockers.length) {
        return { kind: "result", result: blocked(checked.target?.id ?? null, checked.liveTargetCount, checked.blockers) };
      }
      // Already exact: no fence is taken (fence hold null); the final assert decides.
      return checked.currentlyReady ? { kind: "skip", settled: { kind: "already" } } : { kind: "transaction" };
    },

    // Lock order (same as the channel writer): fence -> command lock -> destination
    // FOR UPDATE -> store/sync settings/catalog/vendor listings FOR SHARE -> draft
    // writer -> definitions -> mapping-preparation key -> provider scope TRY locks.
    readRecorded: client => readPreparationRequestHash(client, preparationKey),

    async prepare(client) {
      const capture = await captureDropshipEbayStockReadiness(client, source, { lock: true, quantityReview: false });
      if (capture.blockers.length || !capture.target)
        throw new DropshipEbayStockBlocked(capture.target?.id ?? null, capture.liveTargetCount, capture.blockers);
      if (capture.currentlyReady) return { kind: "settled", settled: { kind: "already" } };
      return { kind: "apply", prepared: { target: capture.target, capture }, locks: noCommandLocks(capture.target.id) };
    },

    // §5: no pre-lock; the draft writer takes its own lock (918428) as it always has.
    preLock: async () => {},

    async apply(client, scopeKeys, { target, capture }) {
      const preparation = await applyExactEbaySkuMappingsInsideTransaction(client, scopeKeys, {
        target, variants: capture.variants, rows: capture.rows, productId: source.productId,
        allowRetainedZero: source.purpose === "sync", exactVariantScope: true,
        idempotencyPrefix: DROPSHIP_EBAY_STOCK_KEY_PREFIX, commandKey, requestHash, actor, now,
        changeReason: DROPSHIP_EBAY_STOCK_CHANGE_REASON,
        // Planner-free confirmation of the write: every member is now exactly mapped.
        afterPromotion: async promotedClient => {
          const promoted = reviewDropshipEbayStockMembers(source, target.id,
            await readDropshipEbayStockMemberRows(promotedClient, target.id, variantIds));
          if (promoted.blockers.length || promoted.variants.some(row => row.mappingAction !== "none"))
            throw new DropshipEbayStockBlocked(target.id, capture.liveTargetCount, promoted.blockers.length ? promoted.blockers
              : [{ code: "STOCK_MAPPING_NOT_READY", message: "The exact SKU stock link was not sealed.", action: "review_mapping", productVariantId: null }]);
        },
        assertReviewReady: review => {
          if (!review.ready) throw new DropshipEbayStockBlocked(target.id, capture.liveTargetCount, review.blockers);
        },
      });
      // The statement text is byte-for-byte the pre-wrapper one (template indentation included).
      await client.query(`INSERT INTO public.audit_events(timestamp,level,actor,action,target,changes,context)
          VALUES($1,'AUDIT',$2,'inventory_availability.dropship_ebay_stock.linked',$3,$4::jsonb,$5::jsonb)`,
      [now, actor, `inventory.inventory_publication_target:${target.id}`,
        JSON.stringify({ before: { publicationTargetId: target.id, targetRevision: target.revision,
          variants: capture.variants.map(row => ({ productVariantId: row.productVariantId, sku: row.sku, mappingAction: row.mappingAction })) },
        after: preparation }),
        JSON.stringify({ commandKey, requestHash, vendorId: source.vendorId, storeConnectionId: source.storeConnectionId,
          productId: source.productId, origin: source.origin, requestedBy })]);
      return { targetId: target.id, preparation, actions: capture.variants };
    },

    async afterCommit(outcome, fenceHoldMs) {
      if (outcome.kind === "recorded") return recordedCommand(outcome.recorded, fenceHoldMs);
      // 5. Final assert: the gate's own predicate must hold now.
      const finalTarget = await store.transaction(false, client => readLinkedTarget(client, source));
      if (finalTarget === null) return classifyLostLink(fenceHoldMs, outcome.kind === "applied");
      if (outcome.kind === "settled") {
        logger.debug({ ...correlation, outcome: "already_linked", publication_target_id: finalTarget, fence_hold_ms: fenceHoldMs });
        return ready(finalTarget, true, noActions, null, fenceHoldMs);
      }
      const applied = outcome.applied;
      const event = { ...correlation, outcome: "linked", publication_target_id: applied.targetId,
        before: { mappingActions: applied.actions.map(row => ({ productVariantId: row.productVariantId, mappingAction: row.mappingAction })) },
        after: { linkedProductVariantIds: variantIds, publicationRows: applied.preparation.publicationRows },
        fence_hold_ms: fenceHoldMs, plans_in_fence: PLANS_IN_FENCE };
      logger.info(event);
      if (fenceHoldMs !== null && fenceHoldMs > FENCE_HOLD_WARN_MS) logger.warn({ ...event, outcome: "fence_hold_slow", threshold_ms: FENCE_HOLD_WARN_MS });
      return ready(applied.targetId, false, applied.actions, applied.preparation, fenceHoldMs);
    },

    // Business refusals are returned; everything else (busy scope, serialization, fence, cleanup) is thrown.
    async onError(error, fenceHoldMs) {
      if (error instanceof DropshipEbayStockBlocked) return blocked(error.publicationTargetId, error.targetCount, error.blockers, fenceHoldMs);
      const checked = precheck;
      if (checked !== null && error instanceof InventoryAvailabilityMasterDataError && DRAFT_WRITER_REFUSALS.has(error.code))
        return blocked(checked.target?.id ?? null, checked.liveTargetCount,
          [{ code: error.code, message: error.message, action: "review_mapping", productVariantId: null }], fenceHoldMs);
      throw error;
    },
  };
  return runStockLinkCommand(store, policy, { monotonicNow });
}
