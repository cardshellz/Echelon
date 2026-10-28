import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { stockLinkDestinationSchema, type StockLinkDestination } from "@shared/types/stock-link";
import {
  publicationMappingPreparationReceiptSchema, type PublicationMappingPreparationReceipt,
} from "@shared/types/inventory-publication-mapping-preparation";
import { logger as platformLogger } from "../../../platform/observability/logger";
import type { StockLinkSource } from "../application/stock-link.ports";
import { FENCE_HOLD_WARN_MS } from "../domain/dropship-ebay-stock-readiness";
import {
  STOCK_LINK_ACTOR, STOCK_LINK_COMMAND_MEMBERS_MAX, STOCK_LINK_EVIDENCE_MAX_AGE_MS, STOCK_LINK_KEY_PREFIX, normalizeShopifyItemId,
  normalizeStockLinkSku, stockLinkCommandIdentity, type StockLinkCommandIdentity, type StockLinkCommandPlan,
  type StockLinkRandom, type StockLinkSizeDecision,
} from "../domain/stock-link";
import { stockLinkCheckAfterDecision, stockLinkCheckAfterFailure } from "../domain/stock-link-check-outcome";
import {
  STOCK_LINK_ERROR_CODES, STOCK_LINK_UPSTREAM_CODES, StockLinkError, classifyStockLinkFailure,
  type StockLinkFailureClassification,
} from "../domain/stock-link-errors";
import { quantityPublicationScopeSchema } from "../domain/quantity-publication-admission";
import { VARIANT_MAPPING_LOCK_NAMESPACE } from "./inventory-channel-exposure-admin.repository";
import {
  applyStockIdentityChangeInsideTransaction, type ExactStockIdentityMember, type MappingPreparationReview,
  type StockIdentityChangeResult,
} from "./exact-stock-identity.apply";
import { PublicationMappingPreparationStore, readTargets, type MappingPreparationTarget } from "./publication-mapping-preparation.repository";
import { quantityPublicationScopeLockKey } from "./quantity-publication-admission.repository";
import {
  insertStockLinkReceipt, lockClaimedStockLinkChecks, readStockLinkDestinationSwitch, readStockLinkReceipt,
  recordStockLinkCheckOutcomes, wakeStockLinkChecksWaitingOn, writeStockLinkCheckOutcomes,
  type LockedStockLinkCheck, type StockLinkCheckClaim, type StockLinkCheckGuard, type StockLinkReceipt,
} from "./stock-link-checks.repository";
import {
  runStockLinkCommand, type StockLinkCommandPolicy, type StockLinkLockedHead, type StockLinkTransactionOutcome,
} from "./stock-link-command";

/**
 * The stock-link engine's command policy for Card Shellz's own Shopify stores (channels PR2, PLAN-CH2 v4.1 §4.3, §5
 * "Shopify policy"): one destination, one product, the sizes the tick decided to link, relink or retire. It plugs into
 * runStockLinkCommand (stock-link-command.ts) with:
 * - fast path: every member's head already holds the decided state (the chosen item active, normalised compare; or,
 *   for a retire, no active version) → its rows settle, no fence;
 * - receipt: public.idempotency_keys `stock-link:<commandKey>`; same request hash → final assert, other → permanent;
 * - claim + switch: the claimed check rows FOR UPDATE at the claim's lease and revision, the destination row FOR SHARE
 *   (switch off or halted → stop, no change), the target FOR UPDATE (live, Echelon, same revision);
 * - confirm: the source locks the connection and the members' SKU rows and the engine compares them with the reads;
 * - pre-lock: the draft writer's pg_advisory_xact_lock(918428, targetId) before the heads (N3);
 * - apply: retire, then the exact-identity link (exactVariantScope), the stock_link audit row, the receipt, the
 *   rows' outcomes and the freed-item wake, in the one transaction;
 * - final assert: the fast-path predicate; a mismatch after an applied command is permanent.
 * A failure is classified (§4.6): busy, transient and permanent are written to the claimed rows (guarded by the lease);
 * destination and tick failures are returned for the tick, which owns pauses, halts and stopping.
 */

export type StockLinkCommandLogger = Pick<typeof platformLogger, "debug" | "info" | "warn" | "error">;

export interface StockLinkCommandRequest {
  readonly destination: StockLinkDestination;
  /** One command of planStockLinkBatch (one product); every member links, relinks or retires. */
  readonly command: StockLinkCommandPlan;
  /** The tick's claim of each member's check row (§7.2 step 4). */
  readonly claims: readonly StockLinkCheckClaim[];
  /** What the decision was made on: when the provider reads were made and with which credentials (§6.1). */
  readonly evidence: { readonly observedAt: string; readonly readFingerprint: string };
}

export interface StockLinkCommandDeps {
  readonly source: Pick<StockLinkSource, "lockForConfirmation">;
  /** The injected clock: every timestamp the command writes. */
  readonly clock: () => Date;
  readonly monotonicNow: () => number;
  readonly random: StockLinkRandom;
  readonly logger?: StockLinkCommandLogger;
}

export type StockLinkCommandAction = "linked" | "relinked" | "retired";

export type StockLinkCommandResult =
  | { readonly status: "applied"; readonly commandKey: string; readonly action: StockLinkCommandAction;
      readonly preparation: PublicationMappingPreparationReceipt | null; readonly retiredMappingIds: readonly number[];
      readonly wokenProductVariantIds: readonly number[]; readonly fenceHoldMs: number | null;
      /** The store could not confirm its scope unlock after COMMIT; the receipt proves the command applied (TST-7). */
      readonly cleanupUncertain: boolean }
  | { readonly status: "already_linked" | "replayed"; readonly commandKey: string; readonly recordedProductVariantIds: readonly number[];
      readonly fenceHoldMs: number | null }
  | { readonly status: "stopped"; readonly commandKey: string; readonly reason: "switch_off" | "halted";
      readonly fenceHoldMs: number | null }
  | { readonly status: "failed"; readonly commandKey: string; readonly failure: StockLinkFailureClassification;
      readonly message: string; readonly recordedProductVariantIds: readonly number[]; readonly fenceHoldMs: number | null };

const RETIRE_REASON = "The store item no longer carries this size's SKU (automatic stock link check).";
const LINK_REASON = "Linked to the store item that carries this size's SKU (automatic stock link check).";

const uuid = z.string().uuid();
const claimSchema = z.object({ productVariantId: z.number().int().positive(), leaseToken: uuid,
  revision: z.string().regex(/^[1-9]\d{0,18}$/) }).strict();
const evidenceSchema = z.object({ observedAt: z.string().datetime({ offset: true }),
  readFingerprint: z.string().regex(/^[a-f0-9]{64}$/) }).strict();

/** What the receipt keeps (§4.3 step 10): enough for a cleanup-uncertain command to report what it applied. */
const receiptResultSchema = z.object({
  action: z.enum(["linked", "relinked", "retired"]),
  preparation: publicationMappingPreparationReceiptSchema.nullable(),
  retiredMappingIds: z.array(z.number().int().positive()),
}).passthrough();

/** The members' heads as committed: the fast path and the final assert read them. */
interface CommittedHead { readonly activeMappingId: number | null; readonly activeItemId: string | null }

/**
 * The fast-path predicate (§4.3 step 0, step 11): a linking member's head has the chosen item active (normalised
 * compare) under a version other than the one it replaces; a retiring member's head has no active version.
 */
export function stockLinkCommandHolds(members: readonly StockLinkSizeDecision[], heads: ReadonlyMap<number, CommittedHead>): boolean {
  return members.every(member => {
    const head = heads.get(member.productVariantId);
    if (member.link === null) return (head?.activeMappingId ?? null) === null;
    return head !== undefined && head.activeMappingId !== null && head.activeMappingId !== member.replacesMappingId
      && normalizeShopifyItemId(head.activeItemId) === member.link.itemId;
  });
}

/** One audit action per command (C15): a relink anywhere names it; otherwise a retire; otherwise a first link. */
export function stockLinkCommandAction(members: readonly StockLinkSizeDecision[]): StockLinkCommandAction {
  if (members.some(member => member.change === "relink")) return "relinked";
  if (members.some(member => member.change === "retire")) return "retired";
  return "linked";
}

/**
 * §4.3 step 5: the destination's credentials and every member's Card Shellz SKU, as locked now, must be what the
 * decision read. A trimmed SKU compare (case included): any change is decided again from the new value.
 */
export function assertStockLinkConfirmation(input: { publicationTargetId: number; readFingerprint: string;
  members: readonly Pick<StockLinkSizeDecision, "productVariantId" | "cardShellzSku">[] },
  confirmation: Awaited<ReturnType<StockLinkSource["lockForConfirmation"]>>): void {
  if (confirmation.fingerprint !== input.readFingerprint) {
    throw new StockLinkError(STOCK_LINK_ERROR_CODES.connectionChanged,
      "The store's connection changed after its items were read; the size is checked again with the new connection.",
      { publicationTargetId: input.publicationTargetId });
  }
  for (const member of input.members) {
    const current = confirmation.skus.find(row => row.productVariantId === member.productVariantId);
    const now = normalizeStockLinkSku(current?.cardShellzSku ?? null);
    const decided = normalizeStockLinkSku(member.cardShellzSku);
    const same = current !== undefined && (now.kind === "blank" ? decided.kind === "blank" : decided.kind === "sku" && decided.value === now.value);
    if (!same) {
      throw new StockLinkError(STOCK_LINK_ERROR_CODES.skuChangedSinceRead,
        "The size's Card Shellz SKU changed after it was checked; it is decided again with the new SKU.",
        { publicationTargetId: input.publicationTargetId, productVariantId: member.productVariantId });
    }
  }
}

interface Prepared {
  readonly target: MappingPreparationTarget;
  readonly checks: readonly LockedStockLinkCheck[];
  readonly replacedItems: ReadonlyMap<number, string>;
}

interface Applied {
  readonly change: StockIdentityChangeResult;
  readonly action: StockLinkCommandAction;
  readonly woken: readonly number[];
  /** Members this command flagged that were not flagged for the same reason before: one ERROR each, after COMMIT. */
  readonly newlyFlagged: readonly StockLinkSizeDecision[];
}

type Settled = { readonly kind: "stopped"; readonly reason: "switch_off" | "halted" };

/**
 * Runs one Shopify stock-link command end to end, including its check rows. Never throws for a classified failure:
 * the result says what happened. Throws only when recording the outcome itself fails (the tick classifies that).
 */
export async function runShopifyStockLinkCommand(pool: Pick<Pool, "connect" | "query">, request: StockLinkCommandRequest,
  deps: StockLinkCommandDeps): Promise<StockLinkCommandResult> {
  const input = validateRequest(request);
  const now = deps.clock();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime()))
    throw new StockLinkError(STOCK_LINK_ERROR_CODES.stateInvalid, "The stock-link clock returned an invalid time.", {});
  const log = deps.logger ?? platformLogger;
  const { destination, command, claims } = input;
  const targetId = destination.publicationTargetId;
  const members = command.members;
  const variantIds = members.map(member => member.productVariantId);
  const identity: StockLinkCommandIdentity = stockLinkCommandIdentity({ destination, command, actor: STOCK_LINK_ACTOR });
  const decisions = new Map(members.map(member => [member.productVariantId, member]));
  const correlation = { publication_target_id: targetId, destination_kind: destination.destinationKind,
    provider_key: destination.providerKey, connection_id: destination.channelConnectionId, product_id: command.productId,
    product_variant_ids: variantIds, command_key: identity.commandKey, lease_tokens: claims.map(claim => claim.leaseToken),
    actor: STOCK_LINK_ACTOR };
  const store = new PublicationMappingPreparationStore(pool);
  const claimGuards: StockLinkCheckGuard[] = claims.map(claim => ({ ...claim }));

  const readHeads = () => store.transaction(false, client => readCommittedHeads(client, targetId, variantIds));
  /** §10: ERROR on entering `flagged` (a person must fix a SKU), once per reason. */
  const logFlagged = (flagged: readonly StockLinkSizeDecision[]) => {
    for (const member of flagged) {
      log.error("inventory_availability.stock_link.flagged", { ...correlation, outcome: "flagged",
        product_variant_ids: [member.productVariantId], error_code: member.code, rule: member.rule });
    }
  };
  const entersFlagged = (member: StockLinkSizeDecision, previous: Pick<LockedStockLinkCheck, "status" | "reasonCode">) =>
    member.status === "flagged" && (previous.status !== "flagged" || previous.reasonCode !== member.code);
  /** Each member's row as its decision settles it, guarded by `guards` (fast path, replay). */
  const recordDecisions = async (guards: readonly StockLinkCheckGuard[]) => {
    const flagged: StockLinkSizeDecision[] = [];
    const recorded = await recordStockLinkCheckOutcomes(pool, targetId, guards, now, (variantId, previous) => {
      const member = decisions.get(variantId)!;
      if (entersFlagged(member, previous)) flagged.push(member);
      return stockLinkCheckAfterDecision(member, previous, now, deps.random);
    });
    logFlagged(flagged);
    return recorded;
  };

  const failed = async (error: unknown, fenceHoldMs: number | null,
    guards: readonly StockLinkCheckGuard[] = claimGuards): Promise<StockLinkCommandResult> => {
    const failure = classifyStockLinkFailure(error);
    const message = error instanceof Error ? error.message : String(error);
    const event = { ...correlation, outcome: failure.kind, error_code: failure.code, error_class: failure.errorClass,
      cause_code: failure.causeCode, fence_hold_ms: fenceHoldMs };
    if (failure.kind === "cleanup_uncertain") {
      // TST-7: the store discarded its connection after COMMIT or ROLLBACK. The receipt decides, read afresh.
      const receipt = await readStockLinkReceipt(pool, identity.preparationKey);
      if (receipt !== null && receipt.requestHash === identity.requestHash) {
        const result = receiptResultSchema.parse((receipt.responseBody as { result?: unknown } | null)?.result);
        log.warn("inventory_availability.stock_link.command", { ...event, outcome: "applied_cleanup_uncertain" });
        return { status: "applied", commandKey: identity.commandKey, action: result.action, preparation: result.preparation,
          retiredMappingIds: result.retiredMappingIds, wokenProductVariantIds: [], fenceHoldMs, cleanupUncertain: true };
      }
    }
    if (failure.scope !== "row" || !["busy", "transient", "permanent", "cleanup_uncertain"].includes(failure.kind)) {
      // A destination pause or halt, or a lost database: the tick owns those, and logs the ERROR of a halt once.
      log.debug("inventory_availability.stock_link.command", { ...event, outcome: `failed_${failure.scope}` });
      return { status: "failed", commandKey: identity.commandKey, failure, message, recordedProductVariantIds: [], fenceHoldMs };
    }
    const firstOfStreak: number[] = [];
    const recorded = await recordStockLinkCheckOutcomes(pool, targetId, guards, now, (variantId, previous) => {
      if (previous.attemptCount === 0) firstOfStreak.push(variantId);
      return stockLinkCheckAfterFailure(failure, message, previous, now, deps.random);
    });
    if (failure.kind === "permanent") log.error("inventory_availability.stock_link.command", { ...event, outcome: "error",
      recorded_product_variant_ids: recorded });
    else if (failure.kind !== "busy" && firstOfStreak.length > 0) log.warn("inventory_availability.stock_link.command",
      { ...event, outcome: "retry_scheduled", recorded_product_variant_ids: recorded });
    else log.debug("inventory_availability.stock_link.command", { ...event, outcome: failure.kind === "busy" ? "busy" : "retry_scheduled",
      recorded_product_variant_ids: recorded });
    return { status: "failed", commandKey: identity.commandKey, failure, message, recordedProductVariantIds: recorded, fenceHoldMs };
  };

  const policy: StockLinkCommandPolicy<StockLinkCommandResult, StockLinkReceipt, Settled, Prepared, Applied> = {
    lockKey: identity.preparationKey,

    async beforeTransaction() {
      try {
        // Step 0: the decided state already holds (an earlier command of this plan committed, or another writer did
        // the same): settle the rows, take no fence.
        if (stockLinkCommandHolds(members, await readHeads())) {
          const recorded = await recordDecisions(claimGuards);
          log.debug("inventory_availability.stock_link.command", { ...correlation, outcome: "already_linked", recorded_product_variant_ids: recorded });
          return { kind: "result", result: { status: "already_linked", commandKey: identity.commandKey,
            recordedProductVariantIds: recorded, fenceHoldMs: null } };
        }
        const age = now.getTime() - Date.parse(input.evidence.observedAt);
        if (age > STOCK_LINK_EVIDENCE_MAX_AGE_MS) {
          throw new StockLinkError(STOCK_LINK_ERROR_CODES.evidenceStale,
            "The store was read too long ago to act on; the size is read again.", { publicationTargetId: targetId, ageMs: age });
        }
        return { kind: "transaction" };
      } catch (error) {
        return { kind: "result", result: await failed(error, null) };
      }
    },

    readRecorded: client => readStockLinkReceipt(client, identity.preparationKey),

    async prepare(client) {
      // Step 4: the claim, the switch and the destination, under row locks.
      const checks = await lockClaimedStockLinkChecks(client, targetId, claims);
      const switchState = await readStockLinkDestinationSwitch(client, targetId);
      if (switchState === null) {
        throw new StockLinkError(STOCK_LINK_ERROR_CODES.stateInvalid, "A claimed destination has no stock-link destination row.",
          { publicationTargetId: targetId });
      }
      if (!switchState.autoLinkEnabled) return { kind: "settled", settled: { kind: "stopped", reason: "switch_off" } };
      if (switchState.haltedAt !== null) return { kind: "settled", settled: { kind: "stopped", reason: "halted" } };
      const target = (await readTargets(client, undefined, undefined, targetId, true))[0];
      assertTargetMatches(destination, target);
      // Step 5: the credentials and the members' SKUs cannot change until COMMIT, and are what the decision read.
      assertStockLinkConfirmation({ publicationTargetId: targetId, readFingerprint: input.evidence.readFingerprint, members },
        await deps.source.lockForConfirmation(client, destination, variantIds));
      const replacedItems = await readReplacedItems(client, targetId, members);
      // Scope keys of every item the command stops or starts writing (C18): a provider request in flight to either
      // makes the command busy. The draft writer's later keys are the same session locks, re-entrant.
      const items = new Set<string>([...replacedItems.values(), ...members.flatMap(member => member.link ? [member.link.itemId] : [])]);
      const scopeKeys = [...items].map(item => quantityPublicationScopeLockKey(quantityPublicationScopeSchema.parse({
        destinationKind: target.destination_kind, connectionId: target.channel_connection_id, providerKey: target.provider_key,
        providerScopeType: target.provider_scope_type, externalScopeId: target.external_scope_id, externalInventoryItemId: item,
        productId: null, productVariantId: null })));
      return { kind: "apply", prepared: { target, checks, replacedItems }, locks: { publicationTargetId: targetId,
        pairVariantIds: variantIds, scopeKeys,
        heads: members.map(member => ({ productVariantId: member.productVariantId, expectedRevision: member.expectedHeadRevision })) } };
    },

    async preLock(client) {
      // N3: the draft writer takes this lock before it locks a head; so does the engine, so the two never deadlock.
      await client.query("SELECT pg_advisory_xact_lock($1, $2)", [VARIANT_MAPPING_LOCK_NAMESPACE, targetId]);
    },

    async apply(client, scopeKeys, prepared, heads) {
      const before = await readHeadVersions(client, heads);
      const retire = members.filter(member => member.replacesMappingId !== null).map(member => ({
        productVariantId: member.productVariantId, mappingId: member.replacesMappingId!, expectedHeadRevision: member.expectedHeadRevision }));
      const linkMembers = members.flatMap(member => member.link ? [exactMember(member)] : []);
      const linked = members.filter(member => member.link !== null);
      // Steps 7-8: retire first, then link (exact-stock-identity.apply.ts).
      const change = await applyStockIdentityChangeInsideTransaction(client, scopeKeys, {
        publicationTargetId: targetId, actor: STOCK_LINK_ACTOR, now, retire, retireReason: RETIRE_REASON,
        link: linkMembers.length === 0 ? null : {
          target: prepared.target, members: linkMembers, productId: command.productId,
          allowRetainedZero: command.purpose === "sync",
          // Only the decided sizes are published: an unlinked selected sibling must not refuse the product (PG 22).
          exactVariantScope: true,
          idempotencyPrefix: STOCK_LINK_KEY_PREFIX,
          commandKey: identity.commandKey, requestHash: identity.requestHash, actor: STOCK_LINK_ACTOR, now,
          changeReason: LINK_REASON,
          afterPromotion: promotedClient => assertLinkedAsChosen(promotedClient, targetId, linked),
          assertReviewReady: assertReviewReady(targetId),
        },
      });
      const action = stockLinkCommandAction(members);
      // Step 9: one stock_link audit row beside the draft writer's and the preparation's own (C15).
      await client.query(`INSERT INTO public.audit_events(timestamp, level, actor, action, target, changes, context)
        VALUES($1, 'AUDIT', $2, $3, $4, $5::jsonb, $6::jsonb)`,
      [now, STOCK_LINK_ACTOR, `inventory_availability.stock_link.${action}`, `inventory.inventory_publication_target:${targetId}`,
        JSON.stringify({ before, after: members.map(member => ({ productVariantId: member.productVariantId, change: member.change,
          status: member.status, code: member.code, rule: member.rule, itemId: member.link?.itemId ?? null,
          storeSku: member.link?.storeSku ?? null, mappingAction: member.link?.mappingAction ?? null,
          replacedMappingId: member.replacesMappingId, replacedDraftMappingId: member.link?.mappingAction === "replace_draft"
            ? member.link.draft?.mappingId ?? null : null })),
        retired: change.retired.map(row => ({ productVariantId: row.productVariantId, mappingId: row.mappingId,
          itemId: row.externalInventoryItemId, retiredAt: row.retiredAt, supersededOutboxIds: row.supersededOutboxIds })),
        preparation: change.preparation }),
        JSON.stringify({ commandKey: identity.commandKey, requestHash: identity.requestHash, originKey: identity.originKey,
          lookupHash: identity.lookupHash, productId: command.productId, purpose: command.purpose, evidence: input.evidence,
          destination: { destinationKind: destination.destinationKind, providerKey: destination.providerKey,
            channelId: destination.channelId, channelConnectionId: destination.channelConnectionId,
            externalScopeId: destination.externalScopeId, targetRevision: destination.targetRevision },
          freedItemIds: command.freedItemIds })]);
      // Step 10: the receipt, the freed-item wake (SAF-5) and the members' rows, ending their claim.
      await insertStockLinkReceipt(client, { key: identity.preparationKey, requestHash: identity.requestHash, now, result: {
        action, preparation: change.preparation, retiredMappingIds: change.retired.map(row => row.mappingId),
        publicationTargetId: targetId, productId: command.productId, productVariantIds: variantIds } });
      const woken = await wakeStockLinkChecksWaitingOn(client, targetId, command.freedItemIds, now);
      await writeStockLinkCheckOutcomes(client, targetId, claims.map(claim => ({ guard: claim,
        write: stockLinkCheckAfterDecision(decisions.get(claim.productVariantId)!,
          prepared.checks.find(row => row.productVariantId === claim.productVariantId)!, now, deps.random) })), now, true);
      const newlyFlagged = members.filter(member =>
        entersFlagged(member, prepared.checks.find(row => row.productVariantId === member.productVariantId)!));
      return { change, action, woken, newlyFlagged };
    },

    async afterCommit(outcome: StockLinkTransactionOutcome<StockLinkReceipt, Settled, Applied>, fenceHoldMs) {
      try {
        if (outcome.kind === "settled") {
          log.debug("inventory_availability.stock_link.command", { ...correlation, outcome: "stopped",
            reason: outcome.settled.reason, fence_hold_ms: fenceHoldMs });
          return { status: "stopped", commandKey: identity.commandKey, reason: outcome.settled.reason, fenceHoldMs };
        }
        if (outcome.kind === "recorded") {
          // Step 3: with SAF-2's keys a receipt is found only for a true replay or a real conflict.
          if (outcome.recorded.requestHash !== identity.requestHash) {
            return await failed(new StockLinkError(STOCK_LINK_UPSTREAM_CODES.mappingCommandConflict,
              "This stock link command was already used for a different request.", { publicationTargetId: targetId }), fenceHoldMs);
          }
          if (!stockLinkCommandHolds(members, await readHeads())) return await failed(linkChangedAfterApply(targetId), fenceHoldMs);
          const recorded = await recordDecisions(claimGuards);
          log.debug("inventory_availability.stock_link.command", { ...correlation, outcome: "replayed", fence_hold_ms: fenceHoldMs });
          return { status: "replayed", commandKey: identity.commandKey, recordedProductVariantIds: recorded, fenceHoldMs };
        }
        const { change, action, woken, newlyFlagged } = outcome.applied;
        // Step 11: the committed state is the decided one. Step 10 ended the claim (lease cleared, revision + 1).
        if (!stockLinkCommandHolds(members, await readHeads())) {
          return await failed(linkChangedAfterApply(targetId), fenceHoldMs,
            claims.map(claim => ({ productVariantId: claim.productVariantId, leaseToken: null, revision: String(BigInt(claim.revision) + BigInt(1)) })));
        }
        const event = { ...correlation, outcome: action,
          before: members.map(member => ({ productVariantId: member.productVariantId, replacedMappingId: member.replacesMappingId })),
          after: members.map(member => ({ productVariantId: member.productVariantId, change: member.change, status: member.status,
            itemId: member.link?.itemId ?? null })),
          publication_rows: change.preparation?.publicationRows ?? 0, woken_product_variant_ids: woken, fence_hold_ms: fenceHoldMs };
        log.info("inventory_availability.stock_link.command", event);
        logFlagged(newlyFlagged);
        if (fenceHoldMs !== null && fenceHoldMs > FENCE_HOLD_WARN_MS)
          log.warn("inventory_availability.stock_link.command", { ...event, outcome: "fence_hold_slow", threshold_ms: FENCE_HOLD_WARN_MS });
        return { status: "applied", commandKey: identity.commandKey, action, preparation: change.preparation,
          retiredMappingIds: change.retired.map(row => row.mappingId), wokenProductVariantIds: woken, fenceHoldMs, cleanupUncertain: false };
      } catch (error) {
        return failed(error, fenceHoldMs);
      }
    },

    onError: (error, fenceHoldMs) => failed(error, fenceHoldMs),
  };
  return runStockLinkCommand(store, policy, { monotonicNow: deps.monotonicNow });
}

function validateRequest(request: StockLinkCommandRequest): StockLinkCommandRequest {
  const destination = stockLinkDestinationSchema.parse(request.destination);
  if (destination.destinationKind !== "channel_connection" || destination.providerKey !== "shopify") {
    throw new StockLinkError(STOCK_LINK_ERROR_CODES.policyMissing, "This command policy links Shopify store destinations only.",
      { publicationTargetId: destination.publicationTargetId, destinationKind: destination.destinationKind, providerKey: destination.providerKey });
  }
  const command = request.command;
  const members = command.members;
  const variantIds = members.map(member => member.productVariantId);
  const invalid = (message: string) => new StockLinkError(STOCK_LINK_ERROR_CODES.stateInvalid, message,
    { publicationTargetId: destination.publicationTargetId, productId: command.productId });
  if (members.length === 0 || members.length > STOCK_LINK_COMMAND_MEMBERS_MAX) throw invalid("A stock-link command needs 1 to 500 sizes.");
  if (new Set(variantIds).size !== variantIds.length) throw invalid("A stock-link command names a size twice.");
  for (const member of members) {
    if (member.productId !== command.productId || member.change === "none"
      || (member.change === "retire") !== (member.link === null)
      || (member.change === "link") !== (member.replacesMappingId === null)) {
      throw invalid("A stock-link command member does not link, relink or retire as its change says.");
    }
  }
  const claims = request.claims.map(claim => claimSchema.parse(claim));
  if (claims.length !== members.length || claims.some(claim => !variantIds.includes(claim.productVariantId))) {
    throw invalid("A stock-link command needs exactly one claim per size.");
  }
  return { destination, command, claims, evidence: evidenceSchema.parse(request.evidence) };
}

/** The destination the tick decided for is the target as locked now: the same identity (else fatal), live, Echelon
 * and at the same revision (else the target changed: transient). */
function assertTargetMatches(destination: StockLinkDestination, target: MappingPreparationTarget | undefined):
  asserts target is MappingPreparationTarget {
  if (!target || target.destination_kind !== destination.destinationKind || target.channel_id !== destination.channelId
    || target.channel_connection_id !== destination.channelConnectionId || target.provider_key !== destination.providerKey
    || target.provider_scope_type !== destination.providerScopeType || target.external_scope_id !== destination.externalScopeId) {
    throw new StockLinkError(STOCK_LINK_UPSTREAM_CODES.listingTargetMismatch, "The stock destination is not the one the link was decided for.",
      { publicationTargetId: destination.publicationTargetId });
  }
  if (target.state !== "live" || target.publication_authority !== "echelon" || target.revision !== destination.targetRevision) {
    throw new StockLinkError(STOCK_LINK_UPSTREAM_CODES.mappingTargetChanged, "The stock destination changed after the link was checked.",
      { publicationTargetId: destination.publicationTargetId, expectedRevision: destination.targetRevision, revision: target.revision });
  }
}

async function readCommittedHeads(client: PoolClient, targetId: number, variantIds: readonly number[]): Promise<Map<number, CommittedHead>> {
  const rows = (await client.query<{ product_variant_id: number; active_mapping_id: number | null; active_item_id: string | null }>(
    `SELECT h.product_variant_id, h.active_mapping_id, m.external_inventory_item_id AS active_item_id
     FROM inventory.publication_variant_mapping_heads h
     LEFT JOIN inventory.publication_variant_mapping_versions m ON m.id = h.active_mapping_id
     WHERE h.publication_target_id = $1 AND h.product_variant_id = ANY($2::integer[])`, [targetId, [...variantIds]])).rows;
  return new Map(rows.map(row => [Number(row.product_variant_id), {
    activeMappingId: row.active_mapping_id === null ? null : Number(row.active_mapping_id), activeItemId: row.active_item_id }]));
}

/** The items the replaced versions name (trimmed, as the outbox snapshots them): their scope keys are locked too. */
async function readReplacedItems(client: PoolClient, targetId: number, members: readonly StockLinkSizeDecision[]):
  Promise<Map<number, string>> {
  const ids = members.flatMap(member => member.replacesMappingId === null ? [] : [member.replacesMappingId]);
  if (ids.length === 0) return new Map();
  const rows = (await client.query<{ product_variant_id: number; item: string }>(
    `SELECT product_variant_id, btrim(external_inventory_item_id) AS item FROM inventory.publication_variant_mapping_versions
     WHERE publication_target_id = $1 AND id = ANY($2::bigint[])`, [targetId, ids])).rows;
  return new Map(rows.map(row => [Number(row.product_variant_id), row.item]));
}

/** The audit row's before-state: each member's head revision and its active and draft versions. */
async function readHeadVersions(client: PoolClient, heads: readonly StockLinkLockedHead[]) {
  const ids = heads.flatMap(head => [head.activeMappingId, head.draftMappingId]).filter((id): id is number => id !== null);
  const versions = ids.length === 0 ? [] : (await client.query<{ id: number; external_inventory_item_id: string; external_sku: string | null }>(
    `SELECT id, external_inventory_item_id, external_sku FROM inventory.publication_variant_mapping_versions WHERE id = ANY($1::bigint[])`,
    [ids])).rows;
  const version = (id: number | null) => {
    const row = id === null ? undefined : versions.find(candidate => Number(candidate.id) === id);
    return row ? { mappingId: Number(row.id), itemId: row.external_inventory_item_id, externalSku: row.external_sku } : null;
  };
  return heads.map(head => ({ productVariantId: head.productVariantId, headRevision: head.revision,
    active: version(head.activeMappingId), draft: version(head.draftMappingId) }));
}

function exactMember(member: StockLinkSizeDecision): ExactStockIdentityMember {
  const link = member.link!;
  if (link.mappingAction === "promote_draft") {
    return { productVariantId: member.productVariantId, mappingAction: "promote_draft", draft: link.draft! };
  }
  const base = { productVariantId: member.productVariantId, externalInventoryItemId: link.itemId, externalSku: link.storeSku,
    expectedHeadRevision: member.expectedHeadRevision };
  return link.mappingAction === "create" ? { ...base, mappingAction: "create" } : { ...base, mappingAction: "replace_draft", draft: link.draft! };
}

/** After the seal: each linking member's head names exactly the chosen item as its active version, with no draft. */
async function assertLinkedAsChosen(client: PoolClient, targetId: number, linked: readonly StockLinkSizeDecision[]): Promise<void> {
  const rows = (await client.query<{ product_variant_id: number; item: string | null; external_sku: string | null; draft_mapping_id: number | null }>(
    `SELECT h.product_variant_id, m.external_inventory_item_id AS item, m.external_sku, h.draft_mapping_id
     FROM inventory.publication_variant_mapping_heads h
     LEFT JOIN inventory.publication_variant_mapping_versions m ON m.id = h.active_mapping_id AND m.lifecycle_status = 'sealed'
     WHERE h.publication_target_id = $1 AND h.product_variant_id = ANY($2::integer[])`,
    [targetId, linked.map(member => member.productVariantId)])).rows;
  for (const member of linked) {
    const row = rows.find(candidate => Number(candidate.product_variant_id) === member.productVariantId);
    if (!row || row.item !== member.link!.itemId || row.external_sku !== member.link!.storeSku || row.draft_mapping_id !== null) {
      throw new StockLinkError(STOCK_LINK_ERROR_CODES.stateInvalid, "The sealed stock link does not name the chosen store item.",
        { publicationTargetId: targetId, productVariantId: member.productVariantId });
    }
  }
}

/** The canonical review refused the linked sizes (selection or plan changed since the decision): decided again. */
function assertReviewReady(targetId: number) {
  return (review: MappingPreparationReview) => {
    if (!review.ready) {
      throw new StockLinkError(STOCK_LINK_UPSTREAM_CODES.mappingNotReady, review.blockers.map(row => row.message).join(" ").slice(0, 900)
        || "The stock plan is not ready for this link.",
      { publicationTargetId: targetId, blockerCodes: review.blockers.map(row => row.code) });
    }
  };
}

function linkChangedAfterApply(targetId: number): StockLinkError {
  return new StockLinkError(STOCK_LINK_UPSTREAM_CODES.mappingLinkChangedAfterApply,
    "This command already changed the stock link, and that link changed again afterwards.", { publicationTargetId: targetId });
}
