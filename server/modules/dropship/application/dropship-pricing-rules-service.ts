import { z } from "zod";
import { loadSelectedCandidates, selectedCatalogTargets } from "./dropship-selected-catalog";
import { isTypedListingPrice, resolveListingPrice } from "../../../../shared/dropship/listing-price";
import { applyPricingRulesInputSchema, reviewPricingRulesInputSchema, pricingImpactRowSchema,
  PRICING_REVIEW_PAGE_SIZE, MAX_PRICING_REVIEW_ITEMS, pricingAmountCentsSchema, pricingBasisCents,
  type PricingProfileState, type ReviewPricingRulesInput, type RulePriceBasis,
  type PricingImpactRow, type PricingReviewResponse, type ApplyPricingRulesInput } from "../../../../shared/dropship/pricing-rules";
import { pricingTargetsInputSchema } from "../../../../shared/dropship/pricing-rules";
import { DropshipError } from "../domain/errors";
import { evaluateListingPriceAgainstCost } from "../domain/listing-price-cost";
import { evaluateListingPricingPolicy, type DropshipListingPreviewRepository, type DropshipListingCatalogCandidate } from "./dropship-listing-preview-service";
import type { DropshipClock, DropshipLogger } from "./dropship-ports";
import type { DropshipProductCostReader } from "./dropship-product-cost";
import { createRulePriceResolver, pricingHash } from "./dropship-rule-price";

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
  storeReview(review: StoredPricingReview): Promise<void>;
  loadReview(id: string): Promise<StoredPricingReview | null>;
  findApplication(input: ApplyPricingRulesInput): Promise<{ revisionId: number } | null>;
  applyReview(review: StoredPricingReview, input: ApplyPricingRulesInput, now: Date): Promise<number>;
}
export interface PricingRulesRepository {
  execute<T>(memberId: string, storeConnectionId: number, operation: (tx: PricingRulesTransaction) => Promise<T>): Promise<T>;
}
const targetSchema = z.number().int().positive().max(2_147_483_647);
/** The review's rule name for a size that follows the store's pricing but no rule can price. */
const RETAIL_FALLBACK_RULE_NAME = "Retail price (no rule prices this size)";

export class DropshipPricingRulesService {
  constructor(private readonly deps: { repository: PricingRulesRepository; clock: DropshipClock; newId: () => string; logger: DropshipLogger }) {}

  async getForMember(memberId: string, storeId: unknown): Promise<PricingProfileState> {
    return this.execute(memberId, storeId, async (tx) => tx.loadProfile());
  }

  async targetsForMember(memberId: string, storeId: unknown, input: unknown): Promise<{ total: number; rows: Array<{ id: string; name: string }> }> {
    const parsed = pricingTargetsInputSchema.parse(input);
    return this.execute(memberId, storeId, async (tx) => {
      return selectedCatalogTargets(tx, this.deps.clock.now(), parsed);
    });
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
    const selected = await loadSelectedCandidates(tx, now);
    const ids = selected.map((row) => row.productVariantId);
    const [saved, listings, costs, guardrails] = await Promise.all([
      tx.catalog.listSavedListingPrices({ vendorId: tx.vendorId, storeConnectionId, productVariantIds: ids }),
      tx.catalog.listExistingListings({ storeConnectionId, productVariantIds: ids }),
      tx.costs.loadProductCosts({ vendorId: tx.vendorId, productVariantIds: ids }), tx.catalog.listPricingPolicies(),
    ]);
    const savedById = new Map(saved.map((row) => [row.productVariantId, row]));
    const listingById = new Map(listings.map((row) => [row.productVariantId, row]));
    const proposed: PricingProfileState = { revisionId: input.expectedRevisionId, profile: input.profile, updatedAt: null };
    // One resolver per profile for the whole review: each hashes its profile once, not once per size.
    const currentRules = createRulePriceResolver({ state: current });
    const proposedRules = createRulePriceResolver({ state: proposed });
    return selected.map((candidate) => {
      const setting = savedById.get(candidate.productVariantId) ?? null;
      const existing = listingById.get(candidate.productVariantId)?.vendorRetailPriceCents ?? null;
      const cost = costs.get(candidate.productVariantId) ?? null;
      const productCostCents = cost?.status === "available" ? cost.unitCostCents : null;
      const oldRule = currentRules.configured ? currentRules.price(candidate, cost) : null;
      const old = resolveListingPrice({ saved: setting, existingListingPriceCents: existing,
        defaultPriceCents: candidate.defaultRetailPriceCents, rulePrice: oldRule });
      // Only a typed price is preserved. A price an earlier push saved on the
      // listing was derived, not chosen, so the rules replace it.
      const preserved = !input.releaseFixedOverrides && isTypedListingPrice(setting);
      const rule = proposedRules.price(candidate, cost);
      // A size that follows the store's pricing keeps doing so (applying does
      // not re-save it). It is priced as its listing will be: the new rule
      // price when the rules give one, else the retail price, so a rule that
      // cannot price it is not a blocker while a retail price exists.
      const inherited = setting?.pricingMode === "inherit"
        ? resolveListingPrice({ saved: setting, existingListingPriceCents: existing,
          defaultPriceCents: candidate.defaultRetailPriceCents, rulePrice: rule })
        : null;
      const onRetail = inherited !== null && inherited.source !== "rules" && inherited.effectivePriceCents !== null;
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
      return pricingImpactRowSchema.parse({ productVariantId: candidate.productVariantId,
        title: candidate.title?.trim() || candidate.productName, sku: candidate.sku,
        previousPriceCents: old.effectivePriceCents, priceCents, productCostCents,
        ruleName: preserved ? "Fixed override preserved" : onRetail ? RETAIL_FALLBACK_RULE_NAME : rule.ruleName, preserved, issues,
        settingRevisionId: setting?.revisionId ?? null,
        evidenceHash: pricingHash({ rule: rule.evidenceHash, oldRule: oldRule?.evidenceHash ?? null, setting, existing, guardrails }),
        sizeName: candidate.variantName, basis,
        basisCents: basisAmountCents(basis, { productCostCents, catalogRetailCents: candidate.defaultRetailPriceCents }),
        warnings, ...(inherited ? { followsStorePricing: true as const } : {}) });
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
