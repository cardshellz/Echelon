import { z } from "zod";
import { loadSelectedCandidates, selectedCatalogTargets } from "./dropship-selected-catalog";
import { resolveListingPrice, type SavedListingPriceRevision } from "../../../../shared/dropship/listing-price";
import { applyPricingRulesInputSchema, reviewPricingRulesInputSchema, pricingImpactRowSchema,
  PRICING_REVIEW_PAGE_SIZE, MAX_PRICING_REVIEW_ITEMS, type PricingProfileState, type ReviewPricingRulesInput,
  type PricingImpactRow, type PricingReviewResponse, type ApplyPricingRulesInput } from "../../../../shared/dropship/pricing-rules";
import { pricingTargetsInputSchema } from "../../../../shared/dropship/pricing-rules";
import { DropshipError } from "../domain/errors";
import { evaluateListingPricingPolicy, type DropshipListingPreviewRepository, type DropshipListingCatalogCandidate } from "./dropship-listing-preview-service";
import type { DropshipClock, DropshipLogger } from "./dropship-ports";
import type { DropshipProductCostReader } from "./dropship-product-cost";
import { pricingHash, resolveListingRulePrice } from "./dropship-rule-price";

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
    return selected.map((candidate) => {
      const setting = savedById.get(candidate.productVariantId) ?? null;
      const existing = listingById.get(candidate.productVariantId)?.vendorRetailPriceCents ?? null;
      const cost = costs.get(candidate.productVariantId) ?? null;
      const oldRule = current.profile ? resolveListingRulePrice({ state: current, candidate, cost }) : null;
      const old = resolveListingPrice({ saved: setting, existingListingPriceCents: existing,
        defaultPriceCents: candidate.defaultRetailPriceCents, rulePrice: oldRule });
      const preserved = !input.releaseFixedOverrides && isFixedPrice(setting, existing);
      const rule = resolveListingRulePrice({ state: proposed, candidate, cost });
      const priceCents = preserved ? old.effectivePriceCents : rule.priceCents;
      const issues = preserved ? [] : [rule.issue, ...evaluateListingPricingPolicy(candidate, guardrails, priceCents).blockers]
        .filter((issue): issue is string => issue !== null);
      return pricingImpactRowSchema.parse({ productVariantId: candidate.productVariantId,
        title: candidate.title?.trim() || candidate.productName, sku: candidate.sku,
        previousPriceCents: old.effectivePriceCents, priceCents, productCostCents: cost?.status === "available" ? cost.unitCostCents : null,
        ruleName: preserved ? "Fixed override preserved" : rule.ruleName, preserved, issues,
        settingRevisionId: setting?.revisionId ?? null,
        evidenceHash: pricingHash({ rule: rule.evidenceHash, oldRule: oldRule?.evidenceHash ?? null, setting, existing, guardrails }) });
    });
  }
}


function isFixedPrice(saved: SavedListingPriceRevision | null, existing: number | null): boolean {
  return saved ? saved.overridePriceCents !== null : existing !== null;
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
