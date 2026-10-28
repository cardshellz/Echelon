import { stockLinkOfferLookupSchema, type StockLinkOfferLookup } from "@shared/types/stock-link";
import { STOCK_LINK_EVIDENCE_MAX_AGE_MS } from "../domain/stock-link";
import {
  STOCK_LINK_ENROLLMENT_ACTOR, STOCK_LINK_ENROLLMENT_CODES, buildEnrollmentSkuIndex, decideEnrollmentBeforeLookup,
  decideEnrollmentFromOffers, enrollmentBlockedOutcome, enrollmentLinkInput, stockLinkCheckAfterEnrollment,
  type StockLinkEnrollmentDecision, type StockLinkEnrollmentRowResult, type StockLinkEnrollmentSize,
} from "../domain/stock-link-enrollment";
import { STOCK_LINK_ERROR_CODES, StockLinkError } from "../domain/stock-link-errors";
import type { StockLinkClaimedCheck } from "../infrastructure/stock-link-checks.repository";
import type { StockLinkBinding, StockLinkEnrollmentBinding } from "./stock-link.ports";
import type {
  DestinationRun, Flow, StepResult, StockLinkLogger, StockLinkSelectionFact, StockLinkServiceDeps, STOCK_LINK_TICK_LIMITS,
} from "./stock-link.service";

/**
 * The tick's pass for a listing-enrollment destination (channels PR3: Dropship eBay listings that were live before stock
 * links existed). The same tick, lock, budgets, check rows and Ops Health as the store-item pass
 * (stock-link.service.ts); only the reads, the decision (domain/stock-link-enrollment.ts) and the writer differ:
 * 1. discovery (the owner's sweep) and the claim, as for every destination;
 * 2. the owner's listing rows, the destination's heads and the selection, from the database;
 * 3. one eBay offer lookup per SKU that needs one, outside any transaction, at most `callsPerDestination` per tick;
 * 4. per size: link through the existing Dropship writer (origin live_listing_enrollment, actor
 *    system:dropship-stock-enrollment; its command key is dropshipEbayStockCommandKey byte for byte), or wait, flag,
 *    keep, remove;
 * 5. every claimed row recorded guarded by its claim (lease token and revision).
 * No row lock is held across an eBay call; the writer takes its own fence and locks.
 */

const ACTION = "inventory_availability.stock_link.tick";
const C = STOCK_LINK_ERROR_CODES;

/** What the service lends this pass (stock-link.service.ts enrollmentContext). */
export interface StockLinkEnrollmentContext {
  readonly deps: StockLinkServiceDeps;
  readonly log: StockLinkLogger;
  readonly now: () => Date;
  readonly limits: typeof STOCK_LINK_TICK_LIMITS;
  readonly providerPauseCodes: readonly string[];
  step<T>(work: () => Promise<T>): Promise<StepResult<T>>;
  discover(run: DestinationRun<StockLinkBinding>): Promise<void>;
  failDestination(run: DestinationRun<StockLinkBinding>, result: StepResult<unknown> & { ok: false }, phase: string): Promise<Flow>;
  writeFailed(run: DestinationRun<StockLinkBinding>, result: StepResult<unknown> & { ok: false }, phase: string): Flow;
  releaseAndFail(run: DestinationRun<StockLinkBinding>, claims: readonly StockLinkClaimedCheck[],
    result: StepResult<unknown> & { ok: false }, phase: string): Promise<Flow>;
}

type Run = DestinationRun<StockLinkEnrollmentBinding>;

export async function runStockLinkEnrollment(context: StockLinkEnrollmentContext, run: Run): Promise<Flow> {
  const { deps, limits: L } = context;
  const targetId = run.destination.publicationTargetId;
  const storeConnectionId = run.destination.dropshipStoreConnectionId;
  if (storeConnectionId === null || deps.runEnrollment === undefined) {
    // A binding without its writer, or a destination that names no store: a configuration problem, never a guess.
    return context.failDestination(run, fatalOf(new StockLinkError(C.policyMissing,
      "A listing-enrollment destination has no Dropship store or no link writer.", { publicationTargetId: targetId })), "policy");
  }
  const discovered = await context.step(() => context.discover(run));
  if (!discovered.ok) {
    if (discovered.action === "halt" || discovered.action === "pause" || discovered.action === "stop_tick")
      return context.failDestination(run, discovered, "discovery");
    context.log.debug(ACTION, { ...run.correlation, phase: "discovery", outcome: "busy", error_code: discovered.failure.code });
  }
  if (run.tick.timeUp()) return "continue";
  const leaseToken = deps.newLeaseToken();
  const claimed = await context.step(() => deps.store.claimDue(targetId, { now: context.now(), leaseToken, leaseMs: L.leaseMs,
    limit: L.claimLimit }));
  if (!claimed.ok) return context.failDestination(run, claimed, "claim");
  const claims = claimed.value;
  run.tick.summary.claimed += claims.length;
  if (claims.length === 0) return "continue";
  const claimRun: Run = { ...run, correlation: { ...run.correlation, lease_token: leaseToken } };

  const facts = await context.step(() => readEnrollmentFacts(context, claimRun, claims));
  if (!facts.ok) return context.releaseAndFail(claimRun, claims, facts, "facts");
  const { sizes, skuIndex } = facts.value;
  const before = new Map(sizes.map(size => [size.productVariantId, decideEnrollmentBeforeLookup(size, skuIndex)]));

  // 3. One lookup per SKU, in claim order (oldest due first), within the call and time budgets.
  const lookups = new Map<string, StockLinkOfferLookup>();
  const rejected = new Map<string, StepResult<never> & { ok: false }>();
  let stoppedBy: (StepResult<never> & { ok: false }) | null = null;
  let callsUsed = 0;
  for (const size of sizes) {
    const outcome = before.get(size.productVariantId)!;
    if (outcome.kind !== "lookup" || lookups.has(outcome.sku) || rejected.has(outcome.sku)) continue;
    if (callsUsed >= L.callsPerDestination || claimRun.tick.timeUp()) break;
    callsUsed += 1;
    claimRun.tick.summary.providerCalls += 1;
    const read = await context.step(async () => validLookup(await claimRun.binding.adapter.findOffersBySku(claimRun.destination,
      outcome.sku, { signal: claimRun.tick.signal }), outcome.sku));
    if (!read.ok) {
      // eBay refused this one SKU's lookup (a row-scoped permanent): that size stops (`error`), the others go on.
      if (read.failure.kind === "permanent" && read.failure.scope === "row") {
        rejected.set(outcome.sku, read);
        continue;
      }
      if (read.action === "halt" || read.action === "pause" || read.action === "stop_tick")
        return context.failDestination(claimRun, read, "store_read");
      // Throttled or unavailable: the store's reads stop for this tick; the sizes not read retry on their own backoff.
      stoppedBy = read;
      break;
    }
    claimRun.tick.summary.lookups += 1;
    lookups.set(outcome.sku, read.value);
  }

  // 4. Decide, then link within the fence and time budgets.
  const results = new Map<number, StockLinkEnrollmentRowResult>();
  const uncarried: number[] = [];
  for (const size of sizes) {
    const outcome = before.get(size.productVariantId)!;
    let decision: StockLinkEnrollmentDecision | null;
    if (outcome.kind !== "lookup") decision = outcome;
    else {
      const lookup = lookups.get(outcome.sku);
      decision = lookup === undefined ? null : decideEnrollmentFromOffers(size, outcome.sku, lookup, storeConnectionId);
    }
    const refusal = outcome.kind === "lookup" ? rejected.get(outcome.sku) : undefined;
    if (refusal !== undefined) {
      results.set(size.productVariantId, { kind: "failure", failure: refusal.failure, message: refusal.message });
      continue;
    }
    if (decision === null) {
      results.set(size.productVariantId, stoppedBy === null
        ? { kind: "failure", failure: { kind: "busy", code: C.callBudgetUsed, retryAfterMs: null }, message: null }
        : { kind: "failure", failure: stoppedBy.failure, message: stoppedBy.message });
      continue;
    }
    if (decision.kind === "uncarried") { uncarried.push(size.productVariantId); continue; }
    if (decision.kind === "linked") { results.set(size.productVariantId, { kind: "linked" }); continue; }
    if (decision.kind === "wait" || decision.kind === "flag") {
      results.set(size.productVariantId, { kind: decision.kind, code: decision.code, message: decision.message });
      continue;
    }
    const lookup = lookups.get(decision.link.sku)!;
    const applied = await applyEnrollment(context, claimRun, size, decision.link, lookup, storeConnectionId);
    if (applied.kind === "flow") return applied.flow;
    results.set(size.productVariantId, applied.result);
  }

  // 5. Record (guarded by the claim). A size that is not the engine's to look after loses its row (D-P6-10).
  const guardOf = (claim: StockLinkClaimedCheck) => ({ productVariantId: claim.productVariantId, leaseToken: claim.leaseToken,
    revision: claim.revision });
  const removed = await context.step(() => deps.store.deleteClaimedChecks(targetId,
    claims.filter(claim => uncarried.includes(claim.productVariantId)).map(guardOf)));
  if (!removed.ok) return context.writeFailed(claimRun, removed, "record");
  const now = context.now();
  const flagged: { productVariantId: number; code: string }[] = [];
  const recorded = await context.step(() => deps.store.recordOutcomes(targetId,
    claims.filter(claim => results.has(claim.productVariantId)).map(guardOf), now, (productVariantId, previous) => {
      const result = results.get(productVariantId)!;
      if (result.kind === "flag" && (previous.status !== "flagged" || previous.reasonCode !== result.code))
        flagged.push({ productVariantId, code: result.code });
      return stockLinkCheckAfterEnrollment(productVariantId, result, previous, now, deps.random);
    }));
  if (!recorded.ok) return context.writeFailed(claimRun, recorded, "record");
  claimRun.tick.summary.flags += [...results.values()].filter(result => result.kind === "flag").length;
  for (const row of flagged) {
    // ERROR once on entering `flagged` (a person must fix a SKU or a mapping), as the store-item pass does.
    context.log.error("inventory_availability.stock_link.flagged", { ...claimRun.correlation, outcome: "flagged",
      product_variant_ids: [row.productVariantId], error_code: row.code, rule: "enrollment" });
  }
  // A store that answered lifts a login or store-unavailable pause (BUILD-NOTES D-P7-12).
  if (lookups.size > 0 && run.state.pausedCode !== null && context.providerPauseCodes.includes(run.state.pausedCode)) {
    const cleared = await context.step(() => deps.store.clearPause(targetId, context.providerPauseCodes, now));
    if (!cleared.ok) return context.writeFailed(claimRun, cleared, "pause");
    if (cleared.value !== null) context.log.info(ACTION, { ...claimRun.correlation, phase: "decision", outcome: "resumed", error_code: cleared.value });
  }
  return "continue";
}

/** §2 of the pass: the owner's listings, the heads and the owner's selection, in claim order. */
async function readEnrollmentFacts(context: StockLinkEnrollmentContext, run: Run, claims: readonly StockLinkClaimedCheck[]) {
  const { deps } = context;
  const ids = claims.map(claim => claim.productVariantId);
  const listings = new Map((await run.binding.source.readListings(deps.db, run.destination, ids)).map(row => [row.productVariantId, row]));
  const carried = await run.binding.source.listCarriedSkus(deps.db, run.destination);
  const heads = new Map((await deps.store.readHeads(run.destination.publicationTargetId)).map(head => [head.productVariantId, head]));
  const byProduct = new Map<number, number[]>();
  for (const id of ids) {
    const listing = listings.get(id);
    if (listing) byProduct.set(listing.productId, [...(byProduct.get(listing.productId) ?? []), id]);
  }
  const selection = new Map<number, StockLinkSelectionFact>();
  for (const [productId, variantIds] of [...byProduct].sort(([a], [b]) => a - b)) {
    for (const [id, fact] of await deps.store.readSelection(run.destination, productId, variantIds)) selection.set(id, fact);
  }
  const sizes: StockLinkEnrollmentSize[] = claims.map(claim => {
    const head = heads.get(claim.productVariantId) ?? null;
    return { productVariantId: claim.productVariantId, listing: listings.get(claim.productVariantId) ?? null,
      selection: selection.get(claim.productVariantId) ?? null, linked: head?.active != null, headRevision: head?.revision ?? "0" };
  });
  return { sizes, skuIndex: buildEnrollmentSkuIndex(carried) };
}

/** The adapter's answer as the engine trusts it: the shared schema, exactly the asked SKU (else a fatal contract break). */
function validLookup(raw: StockLinkOfferLookup, sku: string): StockLinkOfferLookup {
  const parsed = stockLinkOfferLookupSchema.safeParse(raw);
  if (!parsed.success || parsed.data.sku !== sku) {
    throw new StockLinkError(C.adapterContract, "The store's offer lookup broke its contract.", { sku });
  }
  return parsed.data;
}

function fatalOf(error: StockLinkError): StepResult<never> & { ok: false } {
  return { ok: false, failure: { kind: "fatal", errorClass: "fatal", code: error.code, causeCode: null, scope: "destination",
    countsAttempt: false, retryAfterMs: null }, action: "halt", message: error.message };
}

/** One link through the existing Dropship writer; a destination-level failure ends the destination's tick. */
async function applyEnrollment(context: StockLinkEnrollmentContext, run: Run, size: StockLinkEnrollmentSize,
  link: { sku: string; offerId: string; evidenceHash: string }, lookup: StockLinkOfferLookup, storeConnectionId: number):
  Promise<{ kind: "result"; result: StockLinkEnrollmentRowResult } | { kind: "flow"; flow: Flow }> {
  const busy = (code: string): { kind: "result"; result: StockLinkEnrollmentRowResult } =>
    ({ kind: "result", result: { kind: "failure", failure: { kind: "busy", code, retryAfterMs: null }, message: null } });
  const budget = run.tick.commandBudgetCode();
  if (budget !== null) return busy(budget);
  // Evidence older than 5 minutes is read again, never applied (§4.3 step 0).
  if (context.now().getTime() - Date.parse(lookup.observedAt) > STOCK_LINK_EVIDENCE_MAX_AGE_MS) {
    return { kind: "result", result: { kind: "failure", failure: { kind: "transient", code: C.evidenceStale, retryAfterMs: null },
      message: "The store's offers were read more than 5 minutes ago." } };
  }
  const listing = size.listing!;
  const input = enrollmentLinkInput({ storeConnectionId, accountId: run.destination.externalScopeId, listing,
    productVariantId: size.productVariantId, link });
  if (input === null) {
    return { kind: "result", result: { kind: "wait", code: STOCK_LINK_ENROLLMENT_CODES.enrollmentBlocked,
      message: "ENROLLMENT_BLOCKED: the store connection has no provider environment" } };
  }
  const correlation = { ...run.correlation, actor: STOCK_LINK_ENROLLMENT_ACTOR, product_id: listing.productId,
    product_variant_ids: [size.productVariantId], listing_id: listing.listingId, origin_kind: "live_listing_enrollment",
    origin_key: link.evidenceHash, external_offer_id: link.offerId };
  const ran = await context.step(() => context.deps.runEnrollment!(input));
  if (!ran.ok) {
    if (ran.action === "stop_tick" || ran.action === "pause" || ran.failure.kind === "fatal")
      return { kind: "flow", flow: await context.failDestination(run, ran, "command") };
    // busy / transient / cleanup-uncertain / permanent are the row's (permanent: `error`, never retried).
    context.log[ran.failure.kind === "permanent" ? "error" : "debug"](ACTION, { ...correlation, phase: "command",
      outcome: ran.failure.kind === "permanent" ? "error" : "retry_scheduled", error_code: ran.failure.code,
      error_class: ran.failure.errorClass });
    return { kind: "result", result: { kind: "failure", failure: ran.failure, message: ran.message } };
  }
  const result = ran.value;
  if (result.status === "not_applicable") return busy("CANONICAL_AUTHORITY_REQUIRED");
  if (result.status === "blocked") {
    const outcome = enrollmentBlockedOutcome(result.blockers.map(blocker => blocker.code));
    context.log.debug(ACTION, { ...correlation, phase: "command", outcome: "blocked", command_key: result.commandKey,
      inventory_codes: result.blockers.map(blocker => blocker.code), error_code: outcome.code });
    if (outcome.kind === "busy") return busy(outcome.code);
    if (outcome.kind === "transient") {
      return { kind: "result", result: { kind: "failure", failure: { kind: "transient", code: outcome.code, retryAfterMs: null },
        message: "The stock link met concurrent inventory work." } };
    }
    return { kind: "result", result: { kind: outcome.kind, code: outcome.code, message: outcome.message } };
  }
  run.tick.recordFenceHold(result.fenceHoldMs);
  if (result.publicationTargetId !== run.destination.publicationTargetId) {
    // The writer chose the store account's one live destination; it must be this one (the tick's own target).
    context.log.error(ACTION, { ...correlation, phase: "command", outcome: "target_mismatch", command_key: result.commandKey,
      error_code: STOCK_LINK_ENROLLMENT_CODES.mappingReview, linked_publication_target_id: result.publicationTargetId });
    return { kind: "result", result: { kind: "flag", code: STOCK_LINK_ENROLLMENT_CODES.mappingReview,
      message: `TARGET_MISMATCH: linked on publication target ${result.publicationTargetId}` } };
  }
  if (!result.alreadyLinked) {
    run.tick.summary.applies += 1;
    run.tick.summary.links += 1;
  }
  (result.alreadyLinked ? context.log.debug : context.log.info)("inventory_availability.stock_link.linked", { ...correlation,
    outcome: result.alreadyLinked ? "already_linked" : "linked", command_key: result.commandKey, fence_hold_ms: result.fenceHoldMs,
    before: { mappingActions: result.mappingActions }, after: { linkedProductVariantIds: result.linkedProductVariantIds } });
  return { kind: "result", result: { kind: "linked" } };
}
