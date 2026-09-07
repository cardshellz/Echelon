import { createHash } from "node:crypto";
import {
  listingPriceCentsSchema, listingPriceSettingSchema, listingPriceTargetSchema,
  saveListingPriceInputSchema, type ListingPriceSetting, type ListingPriceTarget,
  type SaveListingPriceInput, type SavedListingPriceRevision, resolveListingPrice,
} from "../../../../shared/dropship/listing-price";
import { evaluateDropshipCatalogExposure } from "../domain/catalog-exposure";
import { evaluateDropshipVendorCatalogSelection } from "../domain/vendor-selection";
import { DropshipError } from "../domain/errors";
import type { DropshipListingPreviewRepository, DropshipListingCatalogCandidate } from "./dropship-listing-preview-service";
import type { ListingRulePrice } from "./dropship-rule-price";
import type { DropshipClock, DropshipLogger } from "./dropship-ports";

export type ListingPriceCatalogReader = Pick<DropshipListingPreviewRepository,
  "loadStoreContext" | "listCatalogCandidates" | "listCatalogExposureRules" |
  "listSelectionRules" | "listVariantOverrides" | "listExistingListings">;
export interface ListingPriceTransaction {
  vendorId: number;
  catalog: ListingPriceCatalogReader;
  loadSaved(): Promise<SavedListingPriceRevision | null>;
  loadRulePrice?(candidate: DropshipListingCatalogCandidate): Promise<ListingRulePrice | null>;
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
      const context = await this.authorize(tx, parsed, this.deps.clock.now());
      return projectSetting(parsed, context, await tx.loadSaved());
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
    const result = await this.deps.repository.execute({ ...parsedTarget, memberId, idempotencyKey: parsed.idempotencyKey }, async (tx) => {
      const context = await this.authorize(tx, parsedTarget, now);
      if (parsed.pricingMode === "rules" && !context.rulePrice) {
        throw new DropshipError("DROPSHIP_PRICING_RULES_NOT_CONFIGURED", "Configure store pricing rules before using them for this listing.");
      }
      const saved = await tx.save({ ...parsed, requestHash, now });
      return { price: projectSetting(parsedTarget, context, saved.saved), idempotentReplay: saved.idempotentReplay };
    });
    this.deps.logger.info({
      code: result.idempotentReplay ? "DROPSHIP_LISTING_PRICE_REPLAYED" : "DROPSHIP_LISTING_PRICE_SAVED",
      message: "Local listing price setting saved; no marketplace publication was requested.",
      context: { ...parsedTarget, revisionId: result.price.revisionId, actorId: memberId, idempotentReplay: result.idempotentReplay },
    });
    return result;
  }

  private async authorize(tx: ListingPriceTransaction, target: ListingPriceTarget, now: Date): Promise<PriceSources> {
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
    const [candidates, rules, selections, overrides, listings] = await Promise.all([
      tx.catalog.listCatalogCandidates([target.productVariantId]),
      tx.catalog.listCatalogExposureRules(), tx.catalog.listSelectionRules(tx.vendorId),
      tx.catalog.listVariantOverrides({ vendorId: tx.vendorId, productVariantIds: [target.productVariantId] }),
      tx.catalog.listExistingListings({ storeConnectionId: target.storeConnectionId, productVariantIds: [target.productVariantId] }),
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
    return { defaultPriceCents: candidate.defaultRetailPriceCents,
      rulePrice: await tx.loadRulePrice?.(candidate) ?? null,
      existingListingPriceCents: listings.find((row) => row.productVariantId === target.productVariantId)?.vendorRetailPriceCents ?? null };
  }
}

interface PriceSources { defaultPriceCents: number | null; existingListingPriceCents: number | null; rulePrice: ListingRulePrice | null }
function projectSetting(target: ListingPriceTarget, sources: PriceSources, saved: SavedListingPriceRevision | null): ListingPriceSetting {
  const defaultPrice = listingPriceCentsSchema.safeParse(sources.defaultPriceCents);
  return listingPriceSettingSchema.parse({
    ...target, revisionId: saved?.revisionId ?? null, overridePriceCents: saved?.overridePriceCents ?? null,
    defaultPriceCents: defaultPrice.success ? defaultPrice.data : null,
    pricingMode: saved?.pricingMode ?? (saved ? (saved.overridePriceCents === null ? "catalog_default" : "fixed")
      : sources.existingListingPriceCents !== null ? "fixed" : sources.rulePrice ? "rules" : "catalog_default"),
    ruleName: sources.rulePrice?.ruleName ?? null, pricingIssue: sources.rulePrice?.issue ?? null,
    rulePriceCents: sources.rulePrice?.priceCents ?? null, rulesConfigured: sources.rulePrice !== null,
    ...resolveListingPrice({ ...sources, saved }), updatedAt: saved?.updatedAt ?? null,
  });
}
function assertMember(memberId: string): void {
  if (!memberId.trim()) throw new DropshipError("DROPSHIP_AUTH_REQUIRED", "Dropship authentication is required.");
}
