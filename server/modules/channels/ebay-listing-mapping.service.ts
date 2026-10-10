import { z } from "zod";
import { listingRegistrationOwnerSnapshotSchema, type ListingRegistrationVariantCandidate,
  type MarketplaceObservedListingPublication, type ObserveMarketplaceListingInput } from "../marketplace-listings";
import { ebayListingMappingApplySchema, ebayListingMappingResultSchema, mappingRepairFailureDisposition, type EbayListingMappingResult,
  type EbayListingMappingReview } from "@shared/types/ebay-listing-mapping";
import { EbayListingSyncError, ebayListingSyncIdentitySchema, syncStageHash, type EbayListingSyncIdentity } from "./ebay-listing-sync.domain";
import { assertEbayListingSourceIdentityUnchanged } from "./ebay-existing-listing-identity";
import { buildEbayListingMappingDiagnosis, mappingBlockedReview, mappingReadFailure,
  type EbayListingMappingDiagnosis } from "./ebay-listing-mapping.domain";

export interface EbayListingMappingSource {
  identity: EbayListingSyncIdentity;
  environment: "production" | "sandbox";
  candidates: readonly ListingRegistrationVariantCandidate[];
}
export interface EbayListingMappingRepairPlan {
  source: EbayListingMappingSource;
  provenIdentity: EbayListingSyncIdentity;
  observation: MarketplaceObservedListingPublication;
  reviewHash: string;
  commandKey: string;
  requestHash: string;
  actor: string;
  now: Date;
}
export interface EbayListingMappingRepairStore {
  findReplay(input: { productId: number; channelId: number; commandKey: string; requestHash?: string; actor?: string }): Promise<EbayListingMappingResult | null>;
  apply(plan: EbayListingMappingRepairPlan): Promise<EbayListingMappingResult>;
  rejectReviewedCommand(input: EbayListingMappingRejectedCommand): Promise<EbayListingMappingResult>;
}
export interface EbayListingMappingRejectedCommand {
  productId: number;
  channelId: number;
  commandKey: string;
  reviewHash: string;
  requestHash: string;
  actor: string;
  code: string;
  message: string;
  now: Date;
}

export interface EbayListingMappingDependencies {
  readSource(productId: number): Promise<EbayListingMappingSource>;
  inspect(input: Omit<ObserveMarketplaceListingInput, "locator">): Promise<unknown>;
  assertCompatible(source: EbayListingMappingSource, observation: MarketplaceObservedListingPublication, provenIdentity: EbayListingSyncIdentity): Promise<void>;
  store: EbayListingMappingRepairStore;
  now(): Date;
  reportDiagnosticFailure(event: { productId: number; phase: "source" | "provider" | "compatibility"; code: string; errorName: string }): void;
}
const idSchema = z.number().int().positive().max(2147483647);

/** One explicit review/confirmation owner. Provider reads establish the repair;
 * the store owns atomic mapping, audit, and canonical sync admission. */
export class EbayListingMappingService {
  constructor(private readonly dependencies: EbayListingMappingDependencies) {}

  async diagnose(productId: number, channelId: number): Promise<EbayListingMappingReview> {
    idSchema.parse(productId); idSchema.parse(channelId);
    try { return (await this.evaluate(productId, channelId)).diagnosis.review; }
    catch (error) { return this.failedReview(productId, error).review; }
  }

  async apply(productId: number, channelId: number, actor: string, input: unknown): Promise<EbayListingMappingResult> {
    idSchema.parse(productId); idSchema.parse(channelId);
    const command = ebayListingMappingApplySchema.parse(input);
    const parsedActor = z.string().trim().min(1).max(200).parse(actor);
    const requestHash = syncStageHash({ productId, channelId, actor: parsedActor, reviewHash: command.reviewHash });
    const lookup = { productId, channelId, actor: parsedActor, commandKey: command.commandKey, requestHash };
    // A lost response must not require eBay to be available or recreate evidence.
    const replay = await this.dependencies.store.findReplay(lookup);
    if (replay) return this.result(replay, productId, command.commandKey, command.reviewHash);
    try {
      const { source, diagnosis } = await this.evaluate(productId, channelId);
      if (!diagnosis.review.canApply || !diagnosis.provenIdentity || !diagnosis.observation) {
        const diagnosticCode = diagnosis.review.diagnosticCode ?? "EBAY_MAPPING_REPAIR_UNSAFE";
        const manualRefusal = ["manual", "review_registered_listing"].includes(diagnosis.review.action.kind);
        const code = manualRefusal && mappingRepairFailureDisposition(diagnosticCode) !== "review_again"
          ? "EBAY_MAPPING_REPAIR_UNSAFE" : diagnosticCode;
        throw new EbayListingSyncError(code, diagnosis.review.explanation);
      }
      if (diagnosis.review.reviewHash !== command.reviewHash)
        throw new EbayListingSyncError("EBAY_MAPPING_REVIEW_STALE", "The saved mapping or eBay listing changed after your review. Check eBay again before applying a fix.");
      return this.result(await this.dependencies.store.apply({ source, provenIdentity: diagnosis.provenIdentity,
        observation: diagnosis.observation, reviewHash: command.reviewHash, commandKey: command.commandKey,
        requestHash, actor: parsedActor, now: this.now() }), productId, command.commandKey, command.reviewHash);
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || typeof error.code !== "string"
        || mappingRepairFailureDisposition(error.code) !== "review_again") throw error;
      // A concurrent request using this same command might have committed while
      // this request was reading eBay. The locked owner returns that receipt or
      // seals a refusal so no slower copy can later apply the abandoned command.
      return this.result(await this.dependencies.store.rejectReviewedCommand({ ...lookup,
        reviewHash: command.reviewHash, code: error.code, message: error.message, now: this.now() }),
      productId, command.commandKey, command.reviewHash);
    }
  }

  async getReceipt(productId: number, channelId: number, commandKey: string): Promise<EbayListingMappingResult | null> {
    idSchema.parse(productId); idSchema.parse(channelId); z.string().uuid().parse(commandKey);
    const receipt = await this.dependencies.store.findReplay({ productId, channelId, commandKey });
    return receipt ? this.result(receipt, productId, commandKey) : null;
  }

  private async evaluate(productId: number, channelId: number): Promise<{ source: EbayListingMappingSource; diagnosis: EbayListingMappingDiagnosis }> {
    const source = await this.loadSource(productId, channelId);
    let diagnosis: EbayListingMappingDiagnosis;
    try {
      const inspected = await this.dependencies.inspect({ owner: { kind: "channel", channelId, productId, provider: "ebay", marketplaceId: source.identity.marketplaceId },
        memberCandidates: source.candidates });
      diagnosis = buildEbayListingMappingDiagnosis(source, inspected);
    } catch (error) { return { source, diagnosis: this.failedReview(productId, error, source, "provider") }; }
    const current = await this.loadSource(productId, channelId);
    assertEbayListingSourceIdentityUnchanged(source.identity, current.identity);
    if (source.environment !== current.environment || syncStageHash(this.members(source)) !== syncStageHash(this.members(current)))
      throw new EbayListingSyncError("EBAY_MAPPING_REVIEW_STALE", "The account environment or product membership changed during the eBay check. Check again.");
    if (diagnosis.observation && diagnosis.provenIdentity) {
      try { await this.dependencies.assertCompatible(source, diagnosis.observation, diagnosis.provenIdentity); }
      catch (error) {
        if (error instanceof Error && "code" in error && error.code === "EBAY_MAPPING_CANONICAL_CONFLICT") {
          diagnosis = mappingBlockedReview({ productId, observedAt: this.now(), rows: diagnosis.review.rows,
            title: "Registered listing needs reconciliation",
            explanation: "The verified eBay listing conflicts with this product's registered marketplace publication. Review that registered publication and its members before changing the channel mapping.",
            kind: "review_registered_listing", code: "EBAY_MAPPING_CANONICAL_CONFLICT", membership: diagnosis.review.membership });
        } else if (error instanceof Error && "code" in error && error.code === "EBAY_MAPPING_OWNERSHIP_CONFLICT") {
          diagnosis = mappingBlockedReview({ productId, observedAt: this.now(), rows: diagnosis.review.rows,
            title: "eBay identity belongs to another local variant", explanation: error.message,
            kind: "manual", code: "EBAY_MAPPING_OWNERSHIP_CONFLICT", membership: diagnosis.review.membership });
        } else { diagnosis = this.failedReview(productId, error, source, "compatibility"); }
      }
    }
    return { source, diagnosis };
  }

  private source(raw: EbayListingMappingSource, productId: number, channelId: number): EbayListingMappingSource {
    const identity = ebayListingSyncIdentitySchema.parse(raw.identity);
    if (identity.productId !== productId || identity.channelId !== channelId)
      throw new EbayListingSyncError("EBAY_MAPPING_SCOPE_INVALID", "This saved mapping does not belong to the requested product and channel.");
    const environment = z.enum(["production", "sandbox"]).parse(raw.environment);
    const { memberCandidates } = listingRegistrationOwnerSnapshotSchema.parse({
      owner: { kind: "channel", productId, channelId, provider: "ebay", marketplaceId: identity.marketplaceId }, memberCandidates: raw.candidates });
    const byId = new Map(memberCandidates.map(member => [member.productVariantId, member]));
    if (byId.size !== memberCandidates.length || byId.size !== identity.variants.length
      || identity.variants.some(member => byId.get(member.variantId)?.sku !== member.sku))
      throw new EbayListingSyncError("EBAY_MAPPING_SCOPE_INVALID", "The eBay check must include every saved product variant with its exact SKU.");
    return { identity, environment, candidates: memberCandidates };
  }
  private async loadSource(productId: number, channelId: number): Promise<EbayListingMappingSource> {
    try { return this.source(await this.dependencies.readSource(productId), productId, channelId); }
    catch (error) {
      if (error instanceof z.ZodError || (error instanceof Error && "code" in error && error.code === "EBAY_SYNC_MAPPING_INVALID"))
        throw new EbayListingSyncError("EBAY_MAPPING_SOURCE_INVALID", "The saved eBay mapping has missing or invalid product variant identities.");
      throw error;
    }
  }

  private members(source: EbayListingMappingSource) {
    return source.candidates.map(({ availableQuantity: _quantity, ...member }) => member).sort((a,b) => a.productVariantId-b.productVariantId);
  }
  private failedReview(productId: number, error: unknown, source?: EbayListingMappingSource, phase: "source" | "provider" | "compatibility" = "source"): EbayListingMappingDiagnosis {
    const code = error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : "EBAY_REGISTRATION_PROVIDER_READ_UNAVAILABLE";
    const context = error instanceof Error && "context" in error && error.context && typeof error.context === "object" ? error.context : null;
    const status = context && "status" in context && typeof context.status === "number" ? context.status : undefined;
    this.dependencies.reportDiagnosticFailure({ productId, phase,
      code: /^[A-Z0-9_]{1,150}$/.test(code) ? code : "EBAY_REGISTRATION_PROVIDER_READ_UNAVAILABLE",
      errorName: error instanceof Error && /^[A-Za-z0-9_]{1,80}$/.test(error.name) ? error.name : "Error" });
    const rows = source?.identity.variants.map(member => ({ variantId: member.variantId, catalogSku: member.catalogSku ?? member.sku,
      savedSku: member.externalSku, savedOfferId: member.offerId, savedListingId: member.listingId, observedOffers: [],
      problem: "read_failed" as const, recommendation: "No complete provider evidence is available. Check again before changing this mapping." })) ?? [];
    return mappingBlockedReview({ productId, observedAt: this.now(), rows,
      ...mappingReadFailure({ code: error instanceof z.ZodError ? "EBAY_SYNC_PROVIDER_RESPONSE_INVALID" : code, status, message: "Provider identity could not be verified." }) });
  }
  private now(): Date { return new Date(z.date().parse(this.dependencies.now())); }
  private result(raw: unknown, productId: number, commandKey: string, reviewHash?: string): EbayListingMappingResult {
    const result = ebayListingMappingResultSchema.parse(raw);
    if (result.receipt.productId !== productId || result.receipt.commandKey !== commandKey || result.job.productId !== productId
      || (reviewHash !== undefined && result.receipt.reviewHash !== reviewHash))
      throw new EbayListingSyncError("EBAY_MAPPING_RECEIPT_SCOPE_INVALID", "The saved repair receipt does not belong to this product and command.");
    return result;
  }
}
