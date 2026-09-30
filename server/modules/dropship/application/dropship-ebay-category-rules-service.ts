import { createHash } from "node:crypto";
import { z } from "zod";
import {
  ebayCategoryIdSchema,
  ebayCategoryRulesProfileSchema,
  ebayCategorySearchQuerySchema,
  reviewEbayCategoryRulesInputSchema,
  saveEbayCategoryRulesInputSchema,
  type EbayCategory,
  type EbayCategoryBrowseResult,
  type EbayCategoryOption,
  type EbayCategoryRulesDraft,
  type EbayCategoryRulesProfile,
  type EbayCategoryRulesReview,
  type EbayCategoryRulesState,
  type SaveEbayCategoryRulesInput,
} from "../../../../shared/dropship/ebay-category-rules";
import { DropshipError } from "../domain/errors";
import { prepareEbayCategoryRules, summarizeEbayCategoryRulesReview } from "./dropship-ebay-category-resolver";
import { DROPSHIP_DEFAULT_EBAY_MARKETPLACE_ID } from "./dropship-listing-config-service";
import type { DropshipListingStoreContext } from "./dropship-listing-preview-service";
import type { DropshipStoreListingConfig } from "./dropship-marketplace-listing-provider";
import type { DropshipClock, DropshipLogger } from "./dropship-ports";
import { loadSelectedCandidates, selectedCatalogTargets, type SelectedCatalogReader } from "./dropship-selected-catalog";

/** Raised when the vendor's eBay connection must be reauthorized before eBay can be asked. */
export const EBAY_CATEGORIES_PERMISSION_REQUIRED = "DROPSHIP_EBAY_CATEGORIES_PERMISSION_REQUIRED";
/**
 * The taxonomy reads the eBay US category tree, and dropship eBay listings are
 * US-only (the fulfillment capability check refuses any other marketplace).
 */
const SUPPORTED_EBAY_CATEGORY_MARKETPLACE_ID = "EBAY_US";
/** Same vendor gate as description templates. */
const RULE_MANAGING_VENDOR_STATUSES: ReadonlySet<string> = new Set(["active", "onboarding"]);
/** A store that needs reauthorization can still be configured; only eBay reads need a live connection. */
const RULE_MANAGING_STORE_STATUSES: ReadonlySet<string> = new Set(["connected", "needs_reauth", "refresh_failed"]);
const storeIdSchema = z.number().int().positive().max(2_147_483_647);

export interface EbayCategoryIdentity {
  vendorId: number;
  storeConnectionId: number;
}

/** eBay's category tree, read with the vendor's own eBay connection. */
export interface EbayCategoryTaxonomy {
  /** eBay's own suggestions for the query, as current categories of the tree. */
  search(identity: EbayCategoryIdentity, query: string): Promise<EbayCategoryOption[]>;
  /** The requested categories that exist in the current tree. Unknown ids are absent. */
  describe(identity: EbayCategoryIdentity, categoryIds: readonly string[]): Promise<Map<string, EbayCategoryOption>>;
  /** Top-level categories for a null parent, else the parent's direct children; null for an unknown parent. */
  browse(identity: EbayCategoryIdentity, parentId: string | null): Promise<EbayCategoryBrowseResult | null>;
}

export interface SaveEbayCategoryRulesProfileInput {
  expectedRevisionId: number | null;
  profile: EbayCategoryRulesProfile;
  idempotencyKey: string;
  requestHash: string;
  now: Date;
}

export interface EbayCategoryRulesTransaction extends SelectedCatalogReader {
  loadState(): Promise<EbayCategoryRulesState>;
  loadStoreListingConfig(): Promise<DropshipStoreListingConfig | null>;
  /** True when this key already saved this exact request; throws when the key saved a different one. */
  findReplay(idempotencyKey: string, requestHash: string): Promise<boolean>;
  saveProfile(input: SaveEbayCategoryRulesProfileInput): Promise<void>;
}

export interface EbayCategoryRulesRepository {
  execute<T>(
    input: { memberId: string; storeConnectionId: number; mode: "read" | "write"; idempotencyKey?: string },
    operation: (tx: EbayCategoryRulesTransaction) => Promise<T>,
  ): Promise<T>;
}

export interface DropshipEbayCategoryRulesServiceDependencies {
  repository: EbayCategoryRulesRepository;
  taxonomy: EbayCategoryTaxonomy;
  clock: DropshipClock;
  logger: DropshipLogger;
}

type AuthorizedOperation<T> = (tx: EbayCategoryRulesTransaction, context: DropshipListingStoreContext) => Promise<T>;

export class DropshipEbayCategoryRulesService {
  constructor(private readonly deps: DropshipEbayCategoryRulesServiceDependencies) {}

  async getForMember(memberId: string, storeId: unknown): Promise<EbayCategoryRulesState> {
    return this.read(memberId, storeId, (tx) => tx.loadState());
  }

  /** Scope choices for a rule: the store's selected catalog grouped by category, product line or product. */
  async targetsForMember(memberId: string, storeId: unknown, input: unknown) {
    return this.read(memberId, storeId, (tx) => selectedCatalogTargets(tx, this.deps.clock.now(), input));
  }

  async searchForMember(memberId: string, storeId: unknown, query: unknown): Promise<{ categories: EbayCategoryOption[] }> {
    const parsedQuery = ebayCategorySearchQuerySchema.parse(query);
    const identity = await this.ebayIdentity(memberId, storeId);
    const categories = await this.callTaxonomy(identity, "search", () => this.deps.taxonomy.search(identity, parsedQuery));
    return { categories };
  }

  async browseForMember(memberId: string, storeId: unknown, parentId: unknown): Promise<EbayCategoryBrowseResult> {
    const parsedParent = parentId === undefined || parentId === null || parentId === "" ? null : ebayCategoryIdSchema.parse(parentId);
    const identity = await this.ebayIdentity(memberId, storeId);
    const result = await this.callTaxonomy(identity, "browse", () => this.deps.taxonomy.browse(identity, parsedParent));
    if (!result) throw categoryNotFound(identity.storeConnectionId, parsedParent);
    return result;
  }

  async describeForMember(memberId: string, storeId: unknown, categoryId: unknown): Promise<{ category: EbayCategoryOption }> {
    const parsedId = ebayCategoryIdSchema.parse(categoryId);
    const identity = await this.ebayIdentity(memberId, storeId);
    const found = await this.callTaxonomy(identity, "describe", () => this.deps.taxonomy.describe(identity, [parsedId]));
    const category = found.get(parsedId);
    if (!category) throw categoryNotFound(identity.storeConnectionId, parsedId);
    return { category };
  }

  /** What saving the draft would change across the store's selected listings. Nothing is written. */
  async reviewForMember(memberId: string, storeId: unknown, input: unknown): Promise<EbayCategoryRulesReview> {
    const parsed = reviewEbayCategoryRulesInputSchema.parse(input);
    const identity = await this.ebayIdentity(memberId, storeId);
    const proposed = await this.compileDraft(identity, parsed.draft);
    return this.read(memberId, identity.storeConnectionId, async (tx) => {
      const current = await tx.loadState();
      if (current.revisionId !== parsed.expectedRevisionId) throw versionConflict(identity.storeConnectionId);
      const candidates = await loadSelectedCandidates(tx, this.deps.clock.now(), "category_review");
      return summarizeEbayCategoryRulesReview({
        expectedRevisionId: parsed.expectedRevisionId,
        candidates,
        before: prepareEbayCategoryRules(current.revisionId, current.profile),
        after: prepareEbayCategoryRules(current.revisionId, proposed),
      });
    });
  }

  async saveForMember(memberId: string, storeId: unknown, input: unknown): Promise<{ state: EbayCategoryRulesState; idempotentReplay: boolean }> {
    const parsed = saveEbayCategoryRulesInputSchema.parse(input);
    const storeConnectionId = storeIdSchema.parse(storeId);
    const requestHash = hashEbayCategoryRulesRequest(storeConnectionId, parsed);
    // A lost-response retry replays from the database without asking eBay again.
    const replayed = await this.read(memberId, storeConnectionId, async (tx) =>
      (await tx.findReplay(parsed.idempotencyKey, requestHash)) ? tx.loadState() : null);
    if (replayed) {
      this.logSaved(memberId, storeConnectionId, replayed, true);
      return { state: replayed, idempotentReplay: true };
    }
    const identity = await this.ebayIdentity(memberId, storeConnectionId);
    const profile = await this.compileDraft(identity, parsed.draft);
    const result = await this.deps.repository.execute(
      { memberId, storeConnectionId, mode: "write", idempotencyKey: parsed.idempotencyKey },
      async (tx) => {
        await this.authorize(tx, storeConnectionId);
        // A concurrent retry of the same request may have committed while eBay was being asked.
        if (await tx.findReplay(parsed.idempotencyKey, requestHash)) {
          return { state: await tx.loadState(), idempotentReplay: true };
        }
        const current = await tx.loadState();
        if (current.revisionId !== parsed.expectedRevisionId) throw versionConflict(storeConnectionId);
        await tx.saveProfile({
          expectedRevisionId: parsed.expectedRevisionId,
          profile,
          idempotencyKey: parsed.idempotencyKey,
          requestHash,
          now: this.deps.clock.now(),
        });
        return { state: await tx.loadState(), idempotentReplay: false };
      },
    );
    this.logSaved(memberId, storeConnectionId, result.state, result.idempotentReplay);
    return result;
  }

  /**
   * Replace every category number with eBay's own name and path. Unknown and
   * non-leaf categories are refused; nothing from the client is stored as a name.
   */
  private async compileDraft(identity: EbayCategoryIdentity, draft: EbayCategoryRulesDraft): Promise<EbayCategoryRulesProfile> {
    const categoryIds = [...new Set([draft.defaultCategoryId, ...draft.rules.map((rule) => rule.categoryId)]
      .filter((categoryId): categoryId is string => categoryId !== null))];
    const found = categoryIds.length === 0
      ? new Map<string, EbayCategoryOption>()
      : await this.callTaxonomy(identity, "verify", () => this.deps.taxonomy.describe(identity, categoryIds));
    const verified = (categoryId: string, ruleId: string | null): EbayCategory => {
      const option = found.get(categoryId);
      if (!option) {
        throw new DropshipError("DROPSHIP_EBAY_CATEGORY_RULE_INVALID",
          "That eBay category is not in eBay's current category list. Search again and pick a current category.",
          { storeConnectionId: identity.storeConnectionId, categoryId, ruleId, reason: "not_found" });
      }
      if (!option.leaf) {
        throw new DropshipError("DROPSHIP_EBAY_CATEGORY_RULE_INVALID",
          "Pick a more specific eBay category. eBay accepts listings only in the last level of a category path.",
          { storeConnectionId: identity.storeConnectionId, categoryId, ruleId, reason: "not_leaf" });
      }
      return { categoryId: option.categoryId, categoryName: option.categoryName, path: [...option.path] };
    };
    const profile = ebayCategoryRulesProfileSchema.safeParse({
      version: 1,
      defaultCategory: draft.defaultCategoryId === null ? null : verified(draft.defaultCategoryId, null),
      rules: draft.rules.map((rule) => ({ id: rule.id, name: rule.name, scope: rule.scope, category: verified(rule.categoryId, rule.id) })),
    });
    if (!profile.success) {
      throw new DropshipError("DROPSHIP_EBAY_CATEGORY_RULE_INVALID",
        "eBay returned a category these rules cannot store. Pick a different category.",
        { storeConnectionId: identity.storeConnectionId, reason: "invalid_category" });
    }
    return profile.data;
  }

  /** Authorize and require a live eBay connection, which every eBay read uses. */
  private async ebayIdentity(memberId: string, storeId: unknown): Promise<EbayCategoryIdentity> {
    return this.read(memberId, storeId, async (tx, context) => {
      if (context.storeStatus === "needs_reauth") throw permissionRequired(context.storeConnectionId);
      return { vendorId: tx.vendorId, storeConnectionId: context.storeConnectionId };
    });
  }

  private async read<T>(memberId: string, storeId: unknown, operation: AuthorizedOperation<T>): Promise<T> {
    if (typeof memberId !== "string" || !memberId.trim()) {
      throw new DropshipError("DROPSHIP_AUTH_REQUIRED", "Sign in to manage eBay categories.");
    }
    const storeConnectionId = storeIdSchema.parse(storeId);
    return this.deps.repository.execute({ memberId, storeConnectionId, mode: "read" },
      async (tx) => operation(tx, await this.authorize(tx, storeConnectionId)));
  }

  private async authorize(tx: EbayCategoryRulesTransaction, storeConnectionId: number): Promise<DropshipListingStoreContext> {
    const context = await tx.catalog.loadStoreContext({ vendorId: tx.vendorId, storeConnectionId });
    if (!context) {
      throw new DropshipError("DROPSHIP_STORE_CONNECTION_REQUIRED", "Store connection was not found.", { storeConnectionId });
    }
    if (context.platform !== "ebay") {
      throw new DropshipError("DROPSHIP_EBAY_STORE_REQUIRED", "eBay categories apply only to an eBay store.",
        { storeConnectionId, platform: context.platform });
    }
    if (!RULE_MANAGING_VENDOR_STATUSES.has(context.vendorStatus) || context.entitlementStatus !== "active") {
      throw new DropshipError("DROPSHIP_EBAY_CATEGORY_RULES_NOT_ALLOWED",
        "An active .ops entitlement is required to manage eBay categories.", { storeConnectionId });
    }
    if (!RULE_MANAGING_STORE_STATUSES.has(context.storeStatus)) {
      throw new DropshipError("DROPSHIP_EBAY_STORE_CONNECTION_BLOCKED",
        "Reconnect the eBay store before changing its eBay categories.", { storeConnectionId, status: context.storeStatus });
    }
    const marketplaceId = readMarketplaceId(await tx.loadStoreListingConfig()) ?? DROPSHIP_DEFAULT_EBAY_MARKETPLACE_ID;
    if (marketplaceId !== SUPPORTED_EBAY_CATEGORY_MARKETPLACE_ID) {
      throw new DropshipError("DROPSHIP_EBAY_CATEGORY_MARKETPLACE_UNSUPPORTED",
        "eBay categories are available for eBay US stores only.", { storeConnectionId, marketplaceId });
    }
    return context;
  }

  private async callTaxonomy<T>(identity: EbayCategoryIdentity, operation: string, read: () => Promise<T>): Promise<T> {
    try {
      return await read();
    } catch (error) {
      const errorCode = error instanceof DropshipError ? error.code : undefined;
      const event = {
        code: "DROPSHIP_EBAY_CATEGORIES_READ_FAILED",
        message: "eBay categories could not be read with the store's eBay connection.",
        context: { ...identity, operation, errorCode, errorName: error instanceof Error ? error.name : "UnknownError" },
      };
      // An expired connection is an expected, vendor-fixable state, not an anomaly.
      if (errorCode === EBAY_CATEGORIES_PERMISSION_REQUIRED) this.deps.logger.info(event);
      else this.deps.logger.warn(event);
      throw error;
    }
  }

  private logSaved(memberId: string, storeConnectionId: number, state: EbayCategoryRulesState, idempotentReplay: boolean): void {
    this.deps.logger.info({
      code: idempotentReplay ? "DROPSHIP_EBAY_CATEGORY_RULES_REPLAYED" : "DROPSHIP_EBAY_CATEGORY_RULES_SAVED",
      message: idempotentReplay
        ? "eBay category rules save replayed by idempotency key."
        : "eBay category rules saved; no marketplace update requested.",
      context: {
        actorId: memberId,
        storeConnectionId,
        revisionId: state.revisionId,
        ruleCount: state.profile?.rules.length ?? 0,
        defaultCategoryId: state.profile?.defaultCategory?.categoryId ?? null,
        idempotentReplay,
      },
    });
  }
}

export function hashEbayCategoryRulesRequest(storeConnectionId: number, input: SaveEbayCategoryRulesInput): string {
  return createHash("sha256").update(JSON.stringify({
    kind: "ebay_category_rules_v1",
    storeConnectionId,
    expectedRevisionId: input.expectedRevisionId,
    draft: input.draft,
  })).digest("hex");
}

export function versionConflict(storeConnectionId: number): DropshipError {
  return new DropshipError("DROPSHIP_EBAY_CATEGORY_RULES_VERSION_CONFLICT",
    "The eBay category rules changed since you opened them. Reload and review the current rules before saving.",
    { storeConnectionId });
}

export function permissionRequired(storeConnectionId: number): DropshipError {
  return new DropshipError(EBAY_CATEGORIES_PERMISSION_REQUIRED,
    "Your eBay connection needs a refresh before eBay categories can be searched or saved. Reconnect the store to continue.",
    { storeConnectionId, retryable: false });
}

function categoryNotFound(storeConnectionId: number, categoryId: string | null): DropshipError {
  return new DropshipError("DROPSHIP_EBAY_CATEGORY_NOT_FOUND",
    "That eBay category is not in eBay's current category list.", { storeConnectionId, categoryId });
}

function readMarketplaceId(config: DropshipStoreListingConfig | null): string | null {
  const value = config?.marketplaceConfig?.marketplaceId;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
