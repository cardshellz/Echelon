import { createHash } from "node:crypto";
import {
  RULE_PRICE_OUTSIDE_LIMIT_ISSUE, listingAmountCentsSchema, listingPriceCentsSchema, listingPriceSettingSchema, listingPriceTargetSchema,
  saveListingPriceInputSchema, type ListingPriceSetting, type ListingPriceTarget,
  type SaveListingPriceInput, type SavedListingPriceRevision, resolveListingPrice,
} from "../../../../shared/dropship/listing-price";
import { evaluateDropshipCatalogExposure } from "../domain/catalog-exposure";
import { evaluateDropshipVendorCatalogSelection } from "../domain/vendor-selection";
import { DropshipError } from "../domain/errors";
import { refuseListingPriceSave, type ListingPriceSaveRefusal } from "../domain/listing-price-save-guard";
import { evaluateListingPricingPolicy, withRulePriceLimitCheck, type DropshipListingPreviewRepository,
  type DropshipListingCatalogCandidate, type DropshipPricingPolicyRecord } from "./dropship-listing-preview-service";
import type { DropshipProductCost } from "./dropship-product-cost";
import type { ListingRulePrice } from "./dropship-rule-price";
import type { DropshipClock, DropshipLogger } from "./dropship-ports";

export type ListingPriceCatalogReader = Pick<DropshipListingPreviewRepository,
  "loadStoreContext" | "listCatalogCandidates" | "listCatalogExposureRules" |
  "listSelectionRules" | "listVariantOverrides" | "listExistingListings">;
export interface ListingPriceTransaction {
  vendorId: number;
  // The price writer also checks Card Shellz's price limits. The other users of
  // ListingPriceCatalogReader (content, categories, the selected catalog) do not.
  catalog: ListingPriceCatalogReader & Pick<DropshipListingPreviewRepository, "listPricingPolicies">;
  loadSaved(): Promise<SavedListingPriceRevision | null>;
  loadRulePrice?(candidate: DropshipListingCatalogCandidate): Promise<ListingRulePrice | null>;
  /** The vendor's .ops cost for the size, shown next to its price. */
  loadProductCost(candidate: DropshipListingCatalogCandidate): Promise<DropshipProductCost | null>;
  /**
   * What an earlier save with this key wrote, or null when the key is new.
   * Throws DROPSHIP_IDEMPOTENCY_CONFLICT when the key was used for another change.
   */
  loadReplay(input: { idempotencyKey: string; requestHash: string }): Promise<SavedListingPriceRevision | null>;
  save(input: SaveListingPriceInput & { requestHash: string; now: Date }): Promise<{
    saved: SavedListingPriceRevision; idempotentReplay: boolean;
  }>;
}
export interface ListingPriceRepository {
  execute<T>(input: ListingPriceTarget & { memberId: string; idempotencyKey?: string },
    operation: (transaction: ListingPriceTransaction) => Promise<T>): Promise<T>;
}

export class DropshipListingPriceService {
  constructor(private readonly deps: { repository: ListingPriceRepository; clock: DropshipClock; logger: DropshipLogger }) {}

  async getForMember(memberId: string, target: unknown): Promise<ListingPriceSetting> {
    const parsed = listingPriceTargetSchema.parse(target);
    assertMember(memberId);
    return this.deps.repository.execute({ ...parsed, memberId }, async (tx) => {
      const { candidate, sources } = await authorizeListingPrice(tx, parsed, this.deps.clock.now());
      return projectSetting(parsed, sources, await tx.loadSaved(), await loadCost(tx, candidate, sources));
    });
  }

  async saveForMember(memberId: string, target: unknown, input: unknown): Promise<{
    price: ListingPriceSetting; idempotentReplay: boolean;
  }> {
    const parsedTarget = listingPriceTargetSchema.parse(target);
    const parsed = saveListingPriceInputSchema.parse(input);
    assertMember(memberId);
    const now = this.deps.clock.now();
    const requestHash = createHash("sha256").update(JSON.stringify({
      operation: "listing_price_v1", ...parsedTarget,
      priceCents: parsed.priceCents, expectedRevisionId: parsed.expectedRevisionId,
      ...(parsed.pricingMode ? { pricingMode: parsed.pricingMode } : {}),
    })).digest("hex");
    const result = await this.deps.repository.execute({ ...parsedTarget, memberId, idempotencyKey: parsed.idempotencyKey },
      (tx) => saveListingPriceInTransaction(tx, parsedTarget, parsed, requestHash, now));
    this.deps.logger.info({
      code: result.idempotentReplay ? "DROPSHIP_LISTING_PRICE_REPLAYED" : "DROPSHIP_LISTING_PRICE_SAVED",
      message: "Local listing price setting saved; no marketplace publication was requested.",
      context: { ...parsedTarget, revisionId: result.price.revisionId, pricingMode: result.price.pricingMode ?? null,
        actorId: memberId, idempotentReplay: result.idempotentReplay },
    });
    return result;
  }
}

/**
 * W9's save of one size's price inside `tx`: authorize the store, vendor and
 * entitlement and the size's selection, replay a saved key, refuse "rules" without
 * a rule price, refuse a price that would be lost or break a Card Shellz limit
 * (assertPriceKept), then save. Exported so a listing-settings transaction writes
 * size prices only through these checks (plan D29). `target` and `input` must
 * already be parsed (listingPriceTargetSchema, saveListingPriceInputSchema); the
 * caller logs. `target` must be the store and size `tx` was built for: the checks
 * read `target`, while `tx` reads and writes its own size's rows. A revision for
 * another size is refused (assertSameSize) before the caller can commit.
 */
export async function saveListingPriceInTransaction(tx: ListingPriceTransaction, target: ListingPriceTarget,
  input: SaveListingPriceInput, requestHash: string, now: Date): Promise<{ price: ListingPriceSetting; idempotentReplay: boolean }> {
  const { candidate, sources, policies } = await authorizeListingPrice(tx, target, now);
  // A retried save returns what the first one wrote and is not checked again:
  // it already happened, and the rules below may have changed since.
  const replay = await tx.loadReplay({ idempotencyKey: input.idempotencyKey, requestHash });
  if (replay) {
    assertSameSize(target, replay);
    return { price: projectSetting(target, sources, replay, await loadCost(tx, candidate, sources)), idempotentReplay: true };
  }
  if (input.pricingMode === "rules" && !sources.rulePrice) {
    throw new DropshipError("DROPSHIP_PRICING_RULES_NOT_CONFIGURED", "Configure store pricing rules before using them for this listing.");
  }
  await assertPriceKept(tx, target, candidate, sources, policies, input);
  const saved = await tx.save({ ...input, requestHash, now });
  assertSameSize(target, saved.saved);
  return { price: projectSetting(target, sources, saved.saved, await loadCost(tx, candidate, sources)),
    idempotentReplay: saved.idempotentReplay };
}

/**
 * A `tx` built for another size than `target` would write that size after the
 * checks ran on `target`'s prices, limits and selection. Throwing inside the
 * transaction rolls the write back. W9 builds both from one target, so this
 * never fires on its path; it guards a caller that pairs them wrongly (D29).
 */
function assertSameSize(target: ListingPriceTarget, revision: SavedListingPriceRevision): void {
  if (revision.productVariantId === target.productVariantId) return;
  throw new DropshipError("DROPSHIP_LISTING_PRICE_INVARIANT_FAILED", "The listing price transaction is for a different size.", {
    ...target, transactionProductVariantId: revision.productVariantId,
  });
}

async function authorizeListingPrice(tx: ListingPriceTransaction, target: ListingPriceTarget, now: Date): Promise<{
  candidate: DropshipListingCatalogCandidate; sources: PriceSources; policies: DropshipPricingPolicyRecord[];
}> {
  const context = await tx.catalog.loadStoreContext({ vendorId: tx.vendorId, storeConnectionId: target.storeConnectionId });
  if (!context) throw new DropshipError("DROPSHIP_STORE_CONNECTION_REQUIRED", "Store connection was not found.");
  if (!["active", "onboarding"].includes(context.vendorStatus)) {
    throw new DropshipError("DROPSHIP_LISTING_VENDOR_BLOCKED", "Your vendor status does not permit listing-price changes.");
  }
  if (context.entitlementStatus !== "active") {
    throw new DropshipError("DROPSHIP_LISTING_ENTITLEMENT_BLOCKED", "An active .ops entitlement is required.");
  }
  // Token health is not authority for a local draft. Paused, grace-period, and
  // disconnected connections remain blocked; actual publication keeps its gates.
  if (!["connected", "needs_reauth", "refresh_failed"].includes(context.storeStatus)) {
    throw new DropshipError("DROPSHIP_LISTING_STORE_BLOCKED", "This store is not available for listing-price changes.");
  }
  const [candidates, rules, selections, overrides, listings, policies] = await Promise.all([
    tx.catalog.listCatalogCandidates([target.productVariantId]),
    tx.catalog.listCatalogExposureRules(), tx.catalog.listSelectionRules(tx.vendorId),
    tx.catalog.listVariantOverrides({ vendorId: tx.vendorId, productVariantIds: [target.productVariantId] }),
    tx.catalog.listExistingListings({ storeConnectionId: target.storeConnectionId, productVariantIds: [target.productVariantId] }),
    // Every answer needs the limits, not only a save: an `inherit` size whose
    // rule price a blocking limit refuses is on its retail price (L1).
    tx.catalog.listPricingPolicies(),
  ]);
  const candidate = candidates.find((row) => row.productVariantId === target.productVariantId);
  if (!candidate) throw new DropshipError("DROPSHIP_LISTING_PRICE_NOT_AVAILABLE", "Listing price is not available for this item.");
  const exposure = evaluateDropshipCatalogExposure(candidate, rules, now);
  const selection = evaluateDropshipVendorCatalogSelection({
    candidate, adminExposureDecision: exposure, rules: selections, rawAtpUnits: 0,
    override: overrides.find((row) => row.productVariantId === target.productVariantId) ?? null,
  });
  if (!exposure.exposed || !selection.selected) {
    throw new DropshipError("DROPSHIP_LISTING_PRICE_NOT_AVAILABLE", "Select an available catalog item before setting its listing price.");
  }
  return { candidate, policies, sources: { defaultPriceCents: candidate.defaultRetailPriceCents,
    rulePrice: withRulePriceLimitCheck(candidate, policies, await tx.loadRulePrice?.(candidate) ?? null),
    existingListingPriceCents: listings.find((row) => row.productVariantId === target.productVariantId)?.vendorRetailPriceCents ?? null } };
}

interface PriceSources {
  defaultPriceCents: number | null; existingListingPriceCents: number | null;
  /** With `blockedByLimit` from the Card Shellz price limits (withRulePriceLimitCheck). */
  rulePrice: (ListingRulePrice & { blockedByLimit: boolean }) | null;
}

/** A store with rules loaded the cost with the rule price; read it once either way. */
async function loadCost(tx: ListingPriceTransaction, candidate: DropshipListingCatalogCandidate,
  sources: PriceSources): Promise<DropshipProductCost | null> {
  return sources.rulePrice ? sources.rulePrice.productCost : tx.loadProductCost(candidate);
}

/**
 * Refuses a save that would leave a size without a price it can be listed at
 * (see refuseListingPriceSave). Before and after are resolved the same way the
 * preview and the push resolve them, and checked against the same limits.
 */
async function assertPriceKept(tx: ListingPriceTransaction, target: ListingPriceTarget, candidate: DropshipListingCatalogCandidate,
  sources: PriceSources, policies: readonly DropshipPricingPolicyRecord[], input: SaveListingPriceInput): Promise<void> {
  const current = await tx.loadSaved();
  // An out-of-date request is refused by the save's version check instead: the
  // vendor first needs to see the price as it is now.
  if ((current?.revisionId ?? null) !== input.expectedRevisionId) return;
  const before = resolveListingPrice({ ...sources, saved: current }).effectivePriceCents;
  const after = resolveListingPrice({ ...sources, saved: { overridePriceCents: input.priceCents,
    pricingMode: input.pricingMode ?? (input.priceCents === null ? "catalog_default" : "fixed") } }).effectivePriceCents;
  const beforeBlockers = evaluateListingPricingPolicy(candidate, policies, before).blockers;
  const afterBlockers = evaluateListingPricingPolicy(candidate, policies, after).blockers;
  const refusal = refuseListingPriceSave({ before: { priceCents: before, blockers: beforeBlockers },
    after: { priceCents: after, blockers: afterBlockers, typed: input.priceCents !== null } });
  if (!refusal) return;
  throw new DropshipError(refusal, refusalMessage(refusal, after, afterBlockers, policies), {
    ...target, beforePriceCents: before, afterPriceCents: after, blockers: afterBlockers,
    pricingMode: input.pricingMode ?? null,
  });
}

const LIMIT_CODE = /^pricing:(below_floor|above_ceiling):policy_(\d+)$/;

/** Names the Card Shellz limit a price breaks, with its amount, so the vendor can fix it. */
function refusalMessage(refusal: ListingPriceSaveRefusal, afterCents: number | null, blockers: readonly string[],
  policies: readonly DropshipPricingPolicyRecord[]): string {
  const limits = describeBrokenLimits(blockers, policies);
  if (refusal === "DROPSHIP_LISTING_PRICE_OUTSIDE_LIMIT") {
    return `That price is ${limits ?? "outside what Card Shellz allows for this item"}. Enter a price Card Shellz allows.`;
  }
  const outcome = afterCents === null ? "be left with no price"
    : `move to ${formatUsdCents(afterCents)}, ${limits ?? "which Card Shellz does not allow for this item"}`;
  return `This size would ${outcome}, so it could not be listed and a live listing would stop getting stock updates. Type an exact price instead.`;
}

function describeBrokenLimits(blockers: readonly string[], policies: readonly DropshipPricingPolicyRecord[]): string | null {
  const byId = new Map(policies.map((policy) => [policy.id, policy]));
  const floors: number[] = [];
  const ceilings: number[] = [];
  for (const blocker of blockers) {
    const match = LIMIT_CODE.exec(blocker);
    const policy = match ? byId.get(Number(match[2])) : undefined;
    if (match?.[1] === "below_floor" && policy?.floorPriceCents != null) floors.push(policy.floorPriceCents);
    if (match?.[1] === "above_ceiling" && policy?.ceilingPriceCents != null) ceilings.push(policy.ceilingPriceCents);
  }
  // The highest floor and the lowest ceiling are the ones the price must clear.
  if (floors.length) return `below the Card Shellz minimum of ${formatUsdCents(Math.max(...floors))} for this item`;
  if (ceilings.length) return `above the Card Shellz maximum of ${formatUsdCents(Math.min(...ceilings))} for this item`;
  return null;
}

/** Integer cents as dollars, e.g. 1499 -> "$14.99", in the client's format and without floating point. */
function formatUsdCents(cents: number): string {
  const value = BigInt(cents);
  return `$${value / BigInt(100)}.${String(value % BigInt(100)).padStart(2, "0")}`;
}

function projectSetting(target: ListingPriceTarget, sources: PriceSources, saved: SavedListingPriceRevision | null,
  cost: DropshipProductCost | null): ListingPriceSetting {
  const defaultPrice = listingPriceCentsSchema.safeParse(sources.defaultPriceCents);
  const costCents = listingAmountCentsSchema.safeParse(cost?.status === "available" ? cost.unitCostCents : null);
  return listingPriceSettingSchema.parse({
    ...target, revisionId: saved?.revisionId ?? null, overridePriceCents: saved?.overridePriceCents ?? null,
    defaultPriceCents: defaultPrice.success ? defaultPrice.data : null,
    pricingMode: saved?.pricingMode ?? (saved ? (saved.overridePriceCents === null ? "catalog_default" : "fixed")
      : sources.rulePrice ? "rules" : sources.existingListingPriceCents !== null ? "fixed" : "catalog_default"),
    ruleName: sources.rulePrice?.ruleName ?? null, pricingIssue: rulePriceIssue(sources.rulePrice),
    rulePriceCents: sources.rulePrice?.priceCents ?? null, rulesConfigured: sources.rulePrice !== null,
    ruleBasis: sources.rulePrice?.basis ?? null, productCostCents: costCents.success ? costCents.data : null,
    ...resolveListingPrice({ ...sources, saved }), updatedAt: saved?.updatedAt ?? null,
  });
}
/** Why the rule price can't price the size: the rules' issue, or a blocking Card Shellz limit that refuses it. */
function rulePriceIssue(rulePrice: PriceSources["rulePrice"]): string | null {
  if (!rulePrice) return null;
  return rulePrice.issue ?? (rulePrice.blockedByLimit ? RULE_PRICE_OUTSIDE_LIMIT_ISSUE : null);
}
function assertMember(memberId: string): void {
  if (!memberId.trim()) throw new DropshipError("DROPSHIP_AUTH_REQUIRED", "Dropship authentication is required.");
}
