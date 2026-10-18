import { z } from "zod";
import { loadSelectedCandidates } from "./dropship-selected-catalog";
import { RULE_PRICE_OUTSIDE_LIMIT_ISSUE, isTypedListingPrice, resolveListingPrice } from "../../../../shared/dropship/listing-price";
import { applyPricingRulesInputSchema, reviewPricingRulesInputSchema, pricingImpactRowSchema,
  PRICING_REVIEW_PAGE_SIZE, MAX_PRICING_REVIEW_ITEMS, RETAIL_FALLBACK_RULE_NAME, pricingAmountCentsSchema, pricingBasisCents,
  type PricingProfileState, type ReviewPricingRulesInput, type RulePriceBasis,
  type PricingImpactRow, type PricingReviewResponse, type ApplyPricingRulesInput } from "../../../../shared/dropship/pricing-rules";
import { DropshipError } from "../domain/errors";
import { evaluateListingPriceAgainstCost } from "../domain/listing-price-cost";
import { olderGroupRulesClosed, olderGroupRulesEdit } from "../domain/older-group-rules-edit";
import { evaluateListingPricingPolicy, withRulePriceLimitCheck, type DropshipListingPreviewRepository,
  type DropshipListingCatalogCandidate } from "./dropship-listing-preview-service";
import type { ListingSettingLayers } from "./dropship-listing-setting-layers";
import type { DropshipClock, DropshipLogger } from "./dropship-ports";
import type { DropshipProductCostReader } from "./dropship-product-cost";
import { createRulePriceResolver, pricingHash, rulePriceContextOf } from "./dropship-rule-price";

export interface StoredPricingReview {
  id: string; input: ReviewPricingRulesInput; rows: PricingImpactRow[]; hash: string; createdAt: Date;
}
export interface PricingRulesTransaction {
  vendorId: number;
  catalog: DropshipListingPreviewRepository;
  costs: DropshipProductCostReader;
  listVariantIds(afterId: number, limit: number): Promise<number[]>;
  listProductLines(ids: number[]): Promise<Array<{ id: number; name: string }>>;
  loadProfile(): Promise<PricingProfileState>;
  /**
   * The product and category listing settings of these sizes, read in this
   * transaction, so a review and its apply price each size as the preview
   * does: a product's or a category's own price beats the store's recipes
   * where the listing settings design puts it (plan 4.4).
   */
  loadRuleLayers(candidates: readonly { productId: number; categoryId: number | null }[]): Promise<ListingSettingLayers>;
  /**
   * The selection SHARE locks W9 takes (plan PR 9, P37), after the store lock
   * and the owner rows: from here to commit no selection or exposure rule
   * changes, so the apply's recompute is what it writes. Apply only, after
   * the replay check; reviews and reads never take it.
   */
  lockSelection(): Promise<void>;
  storeReview(review: StoredPricingReview): Promise<void>;
  loadReview(id: string): Promise<StoredPricingReview | null>;
  findApplication(input: ApplyPricingRulesInput): Promise<{ revisionId: number } | null>;
  applyReview(review: StoredPricingReview, input: ApplyPricingRulesInput, now: Date): Promise<number>;
}
export interface PricingRulesRepository {
  execute<T>(memberId: string, storeConnectionId: number, operation: (tx: PricingRulesTransaction) => Promise<T>): Promise<T>;
}
const targetSchema = z.number().int().positive().max(2_147_483_647);

export class DropshipPricingRulesService {
  constructor(private readonly deps: { repository: PricingRulesRepository; clock: DropshipClock; newId: () => string; logger: DropshipLogger }) {}

  async getForMember(memberId: string, storeId: unknown): Promise<PricingProfileState> {
    return this.execute(memberId, storeId, async (tx) => tx.loadProfile());
  }

  async reviewForMember(memberId: string, storeId: unknown, input: unknown): Promise<PricingReviewResponse> {
    const parsed = reviewPricingRulesInputSchema.parse(input);
    return this.execute(memberId, storeId, async (tx, storeConnectionId) => {
      const createdAt = this.deps.clock.now();
      const rows = await this.buildImpact(tx, storeConnectionId, parsed, createdAt);
      const review = { id: z.string().uuid().parse(this.deps.newId()), input: parsed, rows,
        hash: pricingHash({ input: parsed, rows }), createdAt };
      await tx.storeReview(review);
      return projectReview(review, 0);
    });
  }

  async reviewPageForMember(memberId: string, storeId: unknown, reviewId: unknown, page: unknown): Promise<PricingReviewResponse> {
    const id = z.string().uuid().parse(reviewId);
    const parsedPage = z.number().int().min(0).max(MAX_PRICING_REVIEW_ITEMS / PRICING_REVIEW_PAGE_SIZE).parse(page);
    return this.execute(memberId, storeId, async (tx) => projectReview(await requireReview(tx, id), parsedPage));
  }

  async applyForMember(memberId: string, storeId: unknown, input: unknown): Promise<{ revisionId: number; idempotentReplay: boolean }> {
    const parsed = applyPricingRulesInputSchema.parse(input);
    const result = await this.execute(memberId, storeId, async (tx, storeConnectionId) => {
      const replay = await tx.findApplication(parsed);
      if (replay) return { ...replay, idempotentReplay: true };
      await tx.lockSelection();
      const review = await requireReview(tx, parsed.reviewId);
      if (review.hash !== parsed.reviewHash) throw staleReview();
      if (review.rows.some((row) => row.issues.length > 0)) {
        throw new DropshipError("DROPSHIP_PRICING_REVIEW_BLOCKED", "Resolve the blocked prices and review again before applying rules.");
      }
      const now = this.deps.clock.now();
      const currentRows = await this.buildImpact(tx, storeConnectionId, review.input, now);
      if (pricingHash({ input: review.input, rows: currentRows }) !== review.hash) throw staleReview();
      return { revisionId: await tx.applyReview(review, parsed, now), idempotentReplay: false };
    });
    this.deps.logger.info({ code: "DROPSHIP_PRICING_RULES_APPLIED", message: "Store pricing rules applied locally; no marketplace update requested.",
      context: { memberId, storeConnectionId: storeId, reviewId: parsed.reviewId, ...result } });
    return result;
  }

  private async execute<T>(memberId: string, storeId: unknown, operation: (tx: PricingRulesTransaction, id: number) => Promise<T>): Promise<T> {
    if (typeof memberId !== "string" || !memberId.trim()) throw new DropshipError("DROPSHIP_AUTH_REQUIRED", "Sign in to manage pricing.");
    const id = targetSchema.parse(storeId);
    return this.deps.repository.execute(memberId, id, async (tx) => {
      const context = await tx.catalog.loadStoreContext({ vendorId: tx.vendorId, storeConnectionId: id });
      if (!context) throw new DropshipError("DROPSHIP_STORE_CONNECTION_REQUIRED", "Store connection was not found.");
      if (!["active", "onboarding"].includes(context.vendorStatus) || context.entitlementStatus !== "active"
        || !["connected", "needs_reauth", "refresh_failed"].includes(context.storeStatus)) {
        throw new DropshipError("DROPSHIP_PRICING_NOT_ALLOWED", "An active .ops entitlement and available store are required to manage pricing.");
      }
      return operation(tx, id);
    });
  }

  private async buildImpact(tx: PricingRulesTransaction, storeConnectionId: number, input: ReviewPricingRulesInput, now: Date): Promise<PricingImpactRow[]> {
    const current = await tx.loadProfile();
    if (current.revisionId !== input.expectedRevisionId) throw staleReview();
    // Older group rules are closed (Listing settings PR 12, D9-D10): after the revision check, so a stale page gets its
    // conflict, and before any read or write. The review and the apply's recompute both pass here, so a review stored
    // before PR 12 that adds or changes a group is never applied.
    const groupEdit = olderGroupRulesEdit("pricing", current.profile?.groups ?? [], input.profile.groups);
    if (!groupEdit.allowed) throw olderGroupRulesClosed(storeConnectionId, "pricing", groupEdit);
    const selected = await loadSelectedCandidates(tx, now);
    const ids = selected.map((row) => row.productVariantId);
    const [saved, listings, costs, guardrails] = await Promise.all([
      tx.catalog.listSavedListingPrices({ vendorId: tx.vendorId, storeConnectionId, productVariantIds: ids }),
      tx.catalog.listExistingListings({ storeConnectionId, productVariantIds: ids }),
      tx.costs.loadProductCosts({ vendorId: tx.vendorId, productVariantIds: ids }), tx.catalog.listPricingPolicies(),
    ]);
    const layers = await tx.loadRuleLayers(selected);
    const savedById = new Map(saved.map((row) => [row.productVariantId, row]));
    const listingById = new Map(listings.map((row) => [row.productVariantId, row]));
    const proposed: PricingProfileState = { revisionId: input.expectedRevisionId, profile: input.profile, updatedAt: null };
    // One resolver per profile for the whole review: each hashes its profile once, not once per size.
    // Both price from the same product and category settings: the review changes only the store's recipes.
    const currentRules = createRulePriceResolver(rulePriceContextOf(current, layers));
    const proposedRules = createRulePriceResolver(rulePriceContextOf(proposed, layers));
    return selected.map((candidate) => {
      const setting = savedById.get(candidate.productVariantId) ?? null;
      const existing = listingById.get(candidate.productVariantId)?.vendorRetailPriceCents ?? null;
      const cost = costs.get(candidate.productVariantId) ?? null;
      const productCostCents = cost?.status === "available" ? cost.unitCostCents : null;
      const oldRule = currentRules.covers(candidate) ? currentRules.price(candidate, cost) : null;
      const old = resolveListingPrice({ saved: setting, existingListingPriceCents: existing,
        defaultPriceCents: candidate.defaultRetailPriceCents, rulePrice: withRulePriceLimitCheck(candidate, guardrails, oldRule) });
      // Only a typed price is preserved. A price an earlier push saved on the
      // listing was derived, not chosen, so the rules replace it.
      const preserved = !input.releaseFixedOverrides && isTypedListingPrice(setting);
      const rule = proposedRules.price(candidate, cost);
      // A size that follows the store's pricing keeps doing so (applying does
      // not re-save it). It is priced as its listing will be: the new rule
      // price when the rules give a usable one, else the retail price, so a
      // rule that cannot price it, or whose price a blocking Card Shellz limit
      // refuses, is not a blocker while a retail price exists.
      const checkedRule = setting?.pricingMode === "inherit" ? withRulePriceLimitCheck(candidate, guardrails, rule) : null;
      const inherited = checkedRule
        ? resolveListingPrice({ saved: setting, existingListingPriceCents: existing,
          defaultPriceCents: candidate.defaultRetailPriceCents, rulePrice: checkedRule })
        : null;
      const onRetail = inherited !== null && inherited.source !== "rules" && inherited.effectivePriceCents !== null;
      // Why it is on its retail price, so the check can tell the vendor (L1).
      const retailFallbackIssue = onRetail
        ? rule.issue ?? (checkedRule?.blockedByLimit ? RULE_PRICE_OUTSIDE_LIMIT_ISSUE : null)
        : null;
      const priceCents = preserved ? old.effectivePriceCents : inherited ? inherited.effectivePriceCents : rule.priceCents;
      // A preserved row is not changed by applying, so like its issues, its
      // notes and basis describe nothing the vendor is about to do.
      const policy = preserved ? null : evaluateListingPricingPolicy(candidate, guardrails, priceCents);
      const ruleIssue = onRetail ? null : rule.issue;
      const issues = policy ? [ruleIssue, ...policy.blockers].filter((issue): issue is string => issue !== null) : [];
      const warnings = policy
        ? [...policy.warnings, ...evaluateListingPriceAgainstCost({ priceCents, unitCostCents: productCostCents }).warnings]
        : [];
      const basis = preserved ? null : onRetail ? "catalog_retail" : rule.basis;
      // The level is named only where the row names the rule (`ruleName` = the rule's).
      const ruleLevel = preserved || onRetail ? undefined : rule.ruleLevel;
      return pricingImpactRowSchema.parse({ productVariantId: candidate.productVariantId,
        title: candidate.title?.trim() || candidate.productName, sku: candidate.sku,
        previousPriceCents: old.effectivePriceCents, priceCents, productCostCents,
        ruleName: preserved ? "Fixed override preserved" : onRetail ? RETAIL_FALLBACK_RULE_NAME : rule.ruleName, preserved, issues,
        settingRevisionId: setting?.revisionId ?? null,
        evidenceHash: pricingHash({ rule: rule.evidenceHash, oldRule: oldRule?.evidenceHash ?? null, setting, existing, guardrails }),
        sizeName: candidate.variantName, basis,
        basisCents: basisAmountCents(basis, { productCostCents, catalogRetailCents: candidate.defaultRetailPriceCents }),
        warnings, ...(inherited ? { followsStorePricing: true as const } : {}),
        ...(retailFallbackIssue ? { retailFallbackIssue } : {}), ...(ruleLevel ? { ruleLevel } : {}) });
    });
  }
}


/**
 * The amount a basis starts from, or null when it is missing or not a usable
 * cents value. A null basis (no recipe chose the price) has no amount.
 */
function basisAmountCents(basis: RulePriceBasis | null, amounts: {
  productCostCents: number | null; catalogRetailCents: number | null;
}): number | null {
  if (basis === null) return null;
  const amount = pricingAmountCentsSchema.safeParse(pricingBasisCents(basis, amounts));
  return amount.success ? amount.data : null;
}
async function requireReview(tx: PricingRulesTransaction, id: string): Promise<StoredPricingReview> {
  const review = await tx.loadReview(id);
  if (!review) throw new DropshipError("DROPSHIP_PRICING_REVIEW_NOT_FOUND", "Pricing review was not found for this store.");
  return review;
}
function staleReview(): DropshipError {
  return new DropshipError("DROPSHIP_PRICING_REVIEW_STALE", "Prices, rules, costs, or selected listings changed. Review the current impact before applying.");
}
function projectReview(review: StoredPricingReview, page: number): PricingReviewResponse {
  return { reviewId: review.id, reviewHash: review.hash, createdAt: review.createdAt.toISOString(), page,
    rows: review.rows.slice(page * PRICING_REVIEW_PAGE_SIZE, (page + 1) * PRICING_REVIEW_PAGE_SIZE),
    summary: { total: review.rows.length, changed: review.rows.filter((row) => !row.preserved && row.previousPriceCents !== row.priceCents).length,
      preserved: review.rows.filter((row) => row.preserved).length, blocked: review.rows.filter((row) => row.issues.length > 0).length } };
}
