import { z } from "zod";
import { selectedCatalogTargets, type SelectedCatalogReader } from "./dropship-selected-catalog";
import { listingContentTargetSchema, listingContentSettingSchema, previewListingContentInputSchema,
  saveListingContentInputSchema, saveContentProfileInputSchema, type ContentProfileState, type ListingContentTarget,
  type ListingContentSetting, type SavedListingContent, type SaveContentProfileInput, type SaveListingContentInput } from "../../../../shared/dropship/listing-content";
import type { ListingPriceCatalogReader } from "./dropship-listing-price-service";
import type { DropshipListingCatalogCandidate } from "./dropship-listing-preview-service";
import type { DropshipClock, DropshipLogger } from "./dropship-ports";
import { evaluateDropshipCatalogExposure } from "../domain/catalog-exposure";
import { evaluateDropshipVendorCatalogSelection } from "../domain/vendor-selection";
import { DropshipError } from "../domain/errors";
import { contentHash, resolveListingContent } from "./dropship-listing-content-resolver";

export interface ContentTransaction extends SelectedCatalogReader {
  vendorId: number;
  catalog: ListingPriceCatalogReader;
  loadProfile(): Promise<ContentProfileState>;
  loadSaved(variantId: number): Promise<SavedListingContent | null>;
  findReplay(kind: "profile" | "listing", key: string, hash: string): Promise<boolean>;
  saveProfile(input: SaveContentProfileInput, hash: string, now: Date): Promise<void>;
  saveListing(variantId: number, input: SaveListingContentInput, hash: string, now: Date): Promise<void>;
}
export interface ContentRepository {
  execute<T>(input: { memberId: string; storeConnectionId: number; productVariantId?: number; idempotencyKey?: string },
    operation: (tx: ContentTransaction) => Promise<T>): Promise<T>;
}
const storeIdSchema = z.number().int().positive().max(2_147_483_647);

export class DropshipListingContentService {
  constructor(private readonly deps: { repository: ContentRepository; clock: DropshipClock; logger: DropshipLogger }) {}

  async getProfile(memberId: string, storeId: unknown): Promise<ContentProfileState> {
    return this.execute(memberId, storeId, {}, (tx) => tx.loadProfile());
  }
  async targetsForMember(memberId: string, storeId: unknown, input: unknown) {
    return this.execute(memberId, storeId, {}, (tx) => selectedCatalogTargets(tx, this.deps.clock.now(), input));
  }
  async saveProfile(memberId: string, storeId: unknown, input: unknown): Promise<{ state: ContentProfileState; idempotentReplay: boolean }> {
    const parsed = saveContentProfileInputSchema.parse(input);
    const id = storeIdSchema.parse(storeId);
    const hash = contentHash({ kind: "content_profile_v1", storeId: id, ...parsed });
    const result = await this.execute(memberId, id, { idempotencyKey: parsed.idempotencyKey }, async (tx) => {
      const replay = await tx.findReplay("profile", parsed.idempotencyKey, hash);
      if (!replay) {
        const before = await tx.loadProfile();
        if (before.revisionId !== parsed.expectedRevisionId) throw contentConflict();
        await tx.saveProfile(parsed, hash, this.deps.clock.now());
      }
      return { state: await tx.loadProfile(), idempotentReplay: replay };
    });
    this.log(memberId, id, result.state.revisionId, "templates", result.idempotentReplay);
    return result;
  }
  async getForMember(memberId: string, target: unknown): Promise<ListingContentSetting> {
    const parsed = listingContentTargetSchema.parse(target);
    return this.execute(memberId, parsed.storeConnectionId, parsed, async (tx) => {
      const candidate = await this.authorizeListing(tx, parsed.productVariantId);
      return project(parsed, candidate, await tx.loadProfile(), await tx.loadSaved(parsed.productVariantId));
    });
  }
  async previewForMember(memberId: string, target: unknown, input: unknown): Promise<ListingContentSetting> {
    const parsedTarget = listingContentTargetSchema.parse(target);
    const parsed = previewListingContentInputSchema.parse(input);
    return this.execute(memberId, parsedTarget.storeConnectionId, parsedTarget, async (tx) => {
      const candidate = await this.authorizeListing(tx, parsedTarget.productVariantId);
      const profile = await tx.loadProfile();
      const saved = await tx.loadSaved(parsedTarget.productVariantId);
      const current = project(parsedTarget, candidate, profile, saved);
      assertCurrent(current, parsed);
      // The transient revision never leaves this operation or enters persistence.
      return project(parsedTarget, candidate, profile, { revisionId: saved?.revisionId ?? null,
        customText: parsed.customText, catalogHash: current.resolved.catalogHash,
        updatedAt: saved?.updatedAt ?? this.deps.clock.now().toISOString() });
    });
  }
  async saveForMember(memberId: string, target: unknown, input: unknown): Promise<{ content: ListingContentSetting; idempotentReplay: boolean }> {
    const parsedTarget = listingContentTargetSchema.parse(target);
    const parsed = saveListingContentInputSchema.parse(input);
    const hash = contentHash({ kind: "listing_content_v1", ...parsedTarget, ...parsed });
    const result = await this.execute(memberId, parsedTarget.storeConnectionId,
      { ...parsedTarget, idempotencyKey: parsed.idempotencyKey }, async (tx) => {
        const candidate = await this.authorizeListing(tx, parsedTarget.productVariantId);
        const profile = await tx.loadProfile();
        const replay = await tx.findReplay("listing", parsed.idempotencyKey, hash);
        if (!replay) {
          const current = project(parsedTarget, candidate, profile, await tx.loadSaved(parsedTarget.productVariantId));
          assertCurrent(current, parsed);
          await tx.saveListing(parsedTarget.productVariantId, parsed, hash, this.deps.clock.now());
        }
        // An old retry returns current state and never restores an older draft.
        return { content: project(parsedTarget, candidate, profile, await tx.loadSaved(parsedTarget.productVariantId)), idempotentReplay: replay };
      });
    this.log(memberId, parsedTarget.storeConnectionId, result.content.revisionId, "description", result.idempotentReplay);
    return result;
  }
  private async execute<T>(memberId: string, storeId: unknown, extra: { productVariantId?: number; idempotencyKey?: string }, operation: (tx: ContentTransaction) => Promise<T>): Promise<T> {
    if (typeof memberId !== "string" || !memberId.trim()) throw new DropshipError("DROPSHIP_AUTH_REQUIRED", "Sign in to manage descriptions.");
    const storeConnectionId = storeIdSchema.parse(storeId);
    return this.deps.repository.execute({ memberId, storeConnectionId, ...extra }, async (tx) => {
      const context = await tx.catalog.loadStoreContext({ vendorId: tx.vendorId, storeConnectionId });
      if (!context) throw new DropshipError("DROPSHIP_STORE_CONNECTION_REQUIRED", "Store connection was not found.");
      if (!["active", "onboarding"].includes(context.vendorStatus) || context.entitlementStatus !== "active"
        || !["connected", "needs_reauth", "refresh_failed"].includes(context.storeStatus)) {
        throw new DropshipError("DROPSHIP_CONTENT_NOT_ALLOWED", "An active .ops entitlement and available store are required to manage descriptions.");
      }
      return operation(tx);
    });
  }
  private async authorizeListing(tx: ContentTransaction, variantId: number): Promise<DropshipListingCatalogCandidate> {
    const [candidates, rules, selections, overrides] = await Promise.all([
      tx.catalog.listCatalogCandidates([variantId]), tx.catalog.listCatalogExposureRules(), tx.catalog.listSelectionRules(tx.vendorId),
      tx.catalog.listVariantOverrides({ vendorId: tx.vendorId, productVariantIds: [variantId] }),
    ]);
    const candidate = candidates.find((row) => row.productVariantId === variantId);
    if (candidate) {
      const exposure = evaluateDropshipCatalogExposure(candidate, rules, this.deps.clock.now());
      const selection = evaluateDropshipVendorCatalogSelection({ candidate, adminExposureDecision: exposure,
        rules: selections, rawAtpUnits: 0, override: overrides.find((row) => row.productVariantId === variantId) ?? null });
      if (exposure.exposed && selection.selected) return candidate;
    }
    throw new DropshipError("DROPSHIP_CONTENT_NOT_AVAILABLE", "Select an available catalog item before editing its description.");
  }
  private log(actorId: string, storeId: number, revisionId: number | null, kind: string, replay: boolean): void {
    this.deps.logger.info({ code: "DROPSHIP_CONTENT_SAVED", message: "Local content draft saved; no marketplace update requested.",
      context: { actorId, storeId, revisionId, kind, idempotentReplay: replay } });
  }
}
function project(target: ListingContentTarget, candidate: DropshipListingCatalogCandidate, profile: ContentProfileState,
  saved: (Omit<SavedListingContent, "revisionId"> & { revisionId: number | null }) | null): ListingContentSetting {
  return listingContentSettingSchema.parse({ ...target, customText: saved?.customText ?? null, revisionId: saved?.revisionId ?? null,
    updatedAt: saved?.updatedAt ?? null, resolved: resolveListingContent({ candidate, profile, saved }) });
}
function assertCurrent(current: ListingContentSetting, input: { expectedRevisionId: number | null; expectedProfileRevisionId: number | null; expectedCatalogHash: string }): void {
  if (current.revisionId !== input.expectedRevisionId || current.resolved.profileRevisionId !== input.expectedProfileRevisionId
    || current.resolved.catalogHash !== input.expectedCatalogHash) throw contentConflict();
}
export function contentConflict(): DropshipError {
  return new DropshipError("DROPSHIP_CONTENT_VERSION_CONFLICT", "The description, catalog facts, or templates changed. Reload and review the current content before saving or publishing.");
}
