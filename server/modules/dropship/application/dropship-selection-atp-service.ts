import { createHash } from "crypto";
import {
  evaluateDropshipCatalogExposure,
  type DropshipCatalogExposureDecision,
  type DropshipCatalogExposureRule,
  type DropshipCatalogVariantCandidate,
} from "../domain/catalog-exposure";
import { DropshipError } from "../domain/errors";
import {
  listingTierForVariantUomType,
  type DropshipListingTierEligibility,
  type DropshipListingTierStatus,
} from "../domain/listing-tiers";
import {
  assertDropshipVendorSelectionRuleTarget,
  evaluateDropshipVendorCatalogSelection,
  type DropshipVendorCatalogSelectionDecision,
  type DropshipVendorSelectionRule,
  type DropshipVendorVariantOverride,
} from "../domain/vendor-selection";
import type { DropshipClock, DropshipLogger } from "./dropship-ports";
import {
  listDropshipVendorCatalogCategoriesInputSchema,
  listDropshipVendorCatalogIdsInputSchema,
  listDropshipVendorSelectionRulesInputSchema,
  previewDropshipVendorCatalogInputSchema,
  readDropshipVendorSelectionSummaryInputSchema,
  replaceDropshipVendorSelectionRulesInputSchema,
  resolveCatalogSelectionFilter,
  type DropshipVendorCatalogCandidateFilter,
  type ListDropshipVendorSelectionRulesInput,
  type PreviewDropshipVendorCatalogInput,
  type ReplaceDropshipVendorSelectionRule,
  type ReplaceDropshipVendorSelectionRulesInput,
} from "./dropship-selection-dtos";
import { CATALOG_READ_WORDS } from "../domain/catalog-read-words";
import { isReservedSelectionIdempotencyKey } from "../domain/selection-release";
import {
  DROPSHIP_CATALOG_READ_ERROR_CODES,
  DROPSHIP_CATALOG_SELECTION_CAP,
  type DropshipCatalogCategoriesAnswer,
  type DropshipCatalogIdsAnswer,
  type DropshipCatalogReadSummary,
  type DropshipCatalogSelectionFilter,
  type DropshipCatalogSelectionSummary,
} from "../../../../shared/dropship/vendor-catalog-reads";

export interface DropshipVendorProfile {
  vendorId: number;
  memberId: string;
  status: string;
  entitlementStatus: string;
}

export interface DropshipVendorSelectionRuleRecord extends DropshipVendorSelectionRule {
  id: number;
  revisionId: number | null;
  vendorId: number;
  priority: number;
  isActive: boolean;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface DropshipVendorVariantOverrideRecord extends DropshipVendorVariantOverride {
  id: number;
  vendorId: number;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface DropshipVendorCatalogCandidate extends DropshipCatalogVariantCandidate {
  /** `catalog.products.category_id` (nullable): what the categories read and the `categoryId` filter key on. */
  categoryId: number | null;
  /** The current name of that category (`catalog.product_categories.name`), or null without one. */
  categoryName: string | null;
  productSku: string | null;
  productName: string;
  productVariantId: number;
  variantSku: string | null;
  variantName: string;
  unitsPerVariant: number;
  productLineNames: string[];
}

export interface DropshipVendorCatalogPreviewRow extends DropshipVendorCatalogCandidate {
  adminExposureDecision: DropshipCatalogExposureDecision;
  selectionDecision: DropshipVendorCatalogSelectionDecision;
  /** The listing tier this SKU sells in and whether it is on sale for the vendor. */
  listingTier: DropshipListingTierStatus;
}

export interface DropshipVendorCatalogCategoryFacet {
  category: string;
  label: string;
  rowCount: number;
}

export interface DropshipVendorCatalogProductLineFacet {
  productLineIds: number[];
  label: string;
  rowCount: number;
}

export interface DropshipVendorCatalogProductFacet {
  productId: number;
  label: string;
  sku: string | null;
  rowCount: number;
}

export interface DropshipVendorCatalogFacets {
  categories: DropshipVendorCatalogCategoryFacet[];
  productLines: DropshipVendorCatalogProductLineFacet[];
  products: DropshipVendorCatalogProductFacet[];
}

export interface ReplaceDropshipVendorSelectionRulesRepositoryInput {
  vendorId: number;
  idempotencyKey: string;
  requestHash: string;
  actor: ReplaceDropshipVendorSelectionRulesInput["actor"];
  rules: NormalizedDropshipVendorSelectionRule[];
  now: Date;
}

export interface ReplaceDropshipVendorSelectionRulesRepositoryResult {
  revisionId: number;
  idempotentReplay: boolean;
  rules: DropshipVendorSelectionRuleRecord[];
}

/** The selection summary's numbers, read in one snapshot (§4.8). */
export interface DropshipVendorSelectionCountRecord {
  selectionRevisionId: number | null;
  selectedTotal: number;
  /** How many selected sizes are live on the named store; null when no store was named. */
  storeLive: number | null;
}

export interface DropshipSelectionAtpRepository {
  findVendorByMemberId(memberId: string): Promise<DropshipVendorProfile | null>;
  listCatalogExposureRules(): Promise<DropshipCatalogExposureRule[]>;
  listSelectionRules(input: ListDropshipVendorSelectionRulesInput): Promise<DropshipVendorSelectionRuleRecord[]>;
  replaceSelectionRules(
    input: ReplaceDropshipVendorSelectionRulesRepositoryInput,
  ): Promise<ReplaceDropshipVendorSelectionRulesRepositoryResult>;
  listVendorCatalogCandidates(input: DropshipVendorCatalogCandidateFilter): Promise<DropshipVendorCatalogCandidate[]>;
  /** Refuses a store that is not the vendor's (DROPSHIP_STORE_CONNECTION_REQUIRED). */
  readSelectionCounts(input: {
    vendorId: number;
    storeConnectionId: number | null;
    now: Date;
  }): Promise<DropshipVendorSelectionCountRecord>;
  listVariantOverrides(input: {
    vendorId: number;
    productVariantIds: readonly number[];
  }): Promise<DropshipVendorVariantOverrideRecord[]>;
}

export interface DropshipAtpProvider {
  getVariantAtp(
    targets: readonly { productId: number; productVariantId: number }[],
    scope?: { storeConnectionId?: number },
  ): Promise<DropshipAtpSnapshot>;
}

export interface DropshipAtpSnapshot {
  authority: "legacy" | "canonical";
  quantities: ReadonlyMap<number, number>;
}

export interface DropshipSelectionAtpServiceDependencies {
  clock: DropshipClock;
  logger: DropshipLogger;
  repository: DropshipSelectionAtpRepository;
  atp: DropshipAtpProvider;
  /** Which of the vendor's listing tiers are on sale, for the catalog rows. */
  listingTiers: { resolveForVendor(vendorId: number): Promise<{ eligibility: DropshipListingTierEligibility }> };
}

export interface NormalizedDropshipVendorSelectionRule extends ReplaceDropshipVendorSelectionRule {
  productLineId: number | null;
  productId: number | null;
  productVariantId: number | null;
  category: string | null;
  metadata: Record<string, unknown>;
}

export class DropshipSelectionAtpService {
  constructor(private readonly deps: DropshipSelectionAtpServiceDependencies) {}

  async requireVendorForMember(memberId: string): Promise<DropshipVendorProfile> {
    const vendor = await this.deps.repository.findVendorByMemberId(memberId);
    if (!vendor) {
      throw new DropshipError(
        "DROPSHIP_VENDOR_PROFILE_REQUIRED",
        "Dropship vendor profile is required before catalog access.",
      );
    }

    if (["closed", "lapsed", "suspended"].includes(vendor.status)) {
      throw new DropshipError(
        "DROPSHIP_VENDOR_CATALOG_ACCESS_BLOCKED",
        "Dropship vendor status does not allow catalog access.",
        { status: vendor.status },
      );
    }

    return vendor;
  }

  async listSelectionRules(input: unknown): Promise<{ rules: DropshipVendorSelectionRuleRecord[] }> {
    const parsed = listDropshipVendorSelectionRulesInputSchema.parse(input);
    const rules = await this.deps.repository.listSelectionRules(parsed);
    return { rules };
  }

  async replaceSelectionRules(input: unknown): Promise<ReplaceDropshipVendorSelectionRulesRepositoryResult> {
    const parsed = replaceDropshipVendorSelectionRulesInputSchema.parse(input);
    // B's release writes its backfill revisions under this prefix (CHK10, Risk 17).
    if (isReservedSelectionIdempotencyKey(parsed.idempotencyKey)) {
      throw new DropshipError("DROPSHIP_IDEMPOTENCY_KEY_RESERVED", CATALOG_READ_WORDS.keyReserved, {
        vendorId: parsed.vendorId,
        retryable: false,
      });
    }
    const normalizedRules = parsed.rules.map(normalizeVendorSelectionRule);
    for (const rule of normalizedRules) {
      assertDropshipVendorSelectionRuleTarget(rule);
    }

    const requestHash = hashVendorSelectionRules(normalizedRules);
    const result = await this.deps.repository.replaceSelectionRules({
      vendorId: parsed.vendorId,
      idempotencyKey: parsed.idempotencyKey,
      requestHash,
      actor: parsed.actor,
      rules: normalizedRules,
      now: this.deps.clock.now(),
    });

    this.deps.logger.info({
      code: result.idempotentReplay
        ? "DROPSHIP_VENDOR_SELECTION_REPLAYED"
        : "DROPSHIP_VENDOR_SELECTION_REPLACED",
      message: result.idempotentReplay
        ? "Dropship vendor selection ruleset replayed by idempotency key."
        : "Dropship vendor selection ruleset replaced.",
      context: {
        vendorId: parsed.vendorId,
        revisionId: result.revisionId,
        ruleCount: result.rules.length,
      },
    });

    return result;
  }

  async previewCatalog(input: unknown): Promise<{
    rows: DropshipVendorCatalogPreviewRow[];
    total: number;
    page: number;
    limit: number;
    /** Null when the page asked for no facets (`includeFacets=false`): it reads the categories GET instead. */
    facets: DropshipVendorCatalogFacets | null;
    summary: DropshipCatalogReadSummary;
  }> {
    const parsed = previewDropshipVendorCatalogInputSchema.parse(input);
    const facetFilter: DropshipVendorCatalogCandidateFilter = { vendorId: parsed.vendorId, search: parsed.search };
    const [decided, facetCandidates] = await Promise.all([
      this.decideCatalogRows(parsed),
      // The facets apply search only (today's behaviour); one scan fewer when the page reads no facets (TESTS9).
      parsed.includeFacets ? this.deps.repository.listVendorCatalogCandidates(facetFilter) : Promise.resolve(null),
    ]);
    const facets = facetCandidates === null
      ? null
      : buildCatalogFacets(facetCandidates.filter((candidate) => {
        return evaluateDropshipCatalogExposure(candidate, decided.adminRules, decided.now).exposed;
      }));

    const filteredRows = filterBySelection(decided.exposedRows, resolveCatalogSelectionFilter(parsed));
    const start = (parsed.page - 1) * parsed.limit;
    const pageRows = filteredRows.slice(start, start + parsed.limit);

    // Exposure and selection never read stock: only marketplaceQuantity depends
    // on rawAtpUnits (domain/vendor-selection.ts). So the filter, total and page
    // are decided first, and stock is read for the returned page alone. Reading
    // it for every candidate ran one Channel Allocation preview per product on
    // each request, past Heroku's 30-second router limit on a full catalog.
    const [atp, listingTiers] = await Promise.all([
      this.deps.atp.getVariantAtp(pageRows.map(({ candidate }) => ({
        productId: candidate.productId,
        productVariantId: candidate.productVariantId,
      }))),
      this.deps.listingTiers.resolveForVendor(parsed.vendorId),
    ]);
    const rows = pageRows.map(({ candidate, adminExposureDecision, override }) => ({
      ...candidate,
      adminExposureDecision,
      selectionDecision: evaluateDropshipVendorCatalogSelection({
        candidate,
        adminExposureDecision,
        rules: decided.selectionRules,
        rawAtpUnits: atp.quantities.get(candidate.productVariantId) ?? 0,
        override,
        applyMarketplaceQuantityCap: atp.authority === "legacy",
      }),
      listingTier: listingTiers.eligibility[listingTierForVariantUomType(candidate.variantUomType)],
    }));

    return {
      rows,
      total: filteredRows.length,
      page: parsed.page,
      limit: parsed.limit,
      facets,
      summary: summarizeCatalogRows(decided.exposedRows),
    };
  }

  /**
   * The changeable sizes of the filter as ids (§4.8, TESTS22): exposed and not
   * turned off by the vendor's override, ascending, no stock read. The list
   * the purpose needs (not selected to add, selected to remove) is refused
   * above the cap; the other list is null above it, so an over-cap vendor can
   * always remove up to 10,000 at a time.
   */
  async listCatalogIds(input: unknown): Promise<DropshipCatalogIdsAnswer> {
    const parsed = listDropshipVendorCatalogIdsInputSchema.parse(input);
    const decided = await this.decideCatalogRows(parsed);
    const changeable = filterBySelection(decided.exposedRows, resolveCatalogSelectionFilter(parsed))
      .filter((row) => row.override?.enabledOverride !== false);
    const selectedIds = changeable.filter((row) => row.selected).map((row) => row.candidate.productVariantId);
    const notSelectedIds = changeable.filter((row) => !row.selected).map((row) => row.candidate.productVariantId);
    const needed = parsed.purpose === "add" ? notSelectedIds.length : selectedIds.length;
    if (needed > DROPSHIP_CATALOG_SELECTION_CAP) {
      throw new DropshipError(DROPSHIP_CATALOG_READ_ERROR_CODES.idsTooMany, CATALOG_READ_WORDS.idsTooMany, {
        total: changeable.length,
        needed,
        limit: DROPSHIP_CATALOG_SELECTION_CAP,
        retryable: false,
      });
    }
    const capped = (ids: number[]) => (ids.length > DROPSHIP_CATALOG_SELECTION_CAP ? null : sortAscending(ids));
    return {
      selectedIds: capped(selectedIds),
      notSelectedIds: capped(notSelectedIds),
      total: changeable.length,
    };
  }

  /**
   * Every exposed size counted by category id, ignoring search and every
   * filter (D26): a category's numbers are the whole category. Sizes whose
   * product has no category id are counted apart, even when the product has a
   * category name (the name filter stays one release; categories key by id).
   */
  async listCatalogCategories(input: unknown): Promise<DropshipCatalogCategoriesAnswer> {
    const parsed = listDropshipVendorCatalogCategoriesInputSchema.parse(input);
    const decided = await this.decideCatalogRows({ vendorId: parsed.vendorId });
    const byId = new Map<number, { categoryId: number; name: string; rowCount: number; selectedCount: number }>();
    let uncategorizedCount = 0;
    for (const { candidate, selected } of decided.exposedRows) {
      if (candidate.categoryId === null) {
        uncategorizedCount += 1;
        continue;
      }
      const entry = byId.get(candidate.categoryId) ?? {
        categoryId: candidate.categoryId,
        name: candidate.categoryName ?? candidate.category?.trim() ?? "",
        rowCount: 0,
        selectedCount: 0,
      };
      entry.rowCount += 1;
      if (selected) entry.selectedCount += 1;
      byId.set(candidate.categoryId, entry);
    }
    const categories = [...byId.values()].sort((left, right) => (
      left.name.localeCompare(right.name) || left.categoryId - right.categoryId
    ));
    return { categories, uncategorizedCount };
  }

  /**
   * The vendor's selection count and head revision, and for a named store how
   * many of the selected sizes are live there (§4.8): "Publish {notLive} new"
   * and "Publish all {selectedTotal}" read these, and a publish run's
   * `expectedSelectionRevisionId` is this revision.
   */
  async readSelectionSummary(input: unknown): Promise<DropshipCatalogSelectionSummary> {
    const parsed = readDropshipVendorSelectionSummaryInputSchema.parse(input);
    const counts = await this.deps.repository.readSelectionCounts({
      vendorId: parsed.vendorId,
      storeConnectionId: parsed.storeConnectionId,
      now: this.deps.clock.now(),
    });
    return {
      selectionRevisionId: counts.selectionRevisionId,
      selectedTotal: counts.selectedTotal,
      cap: DROPSHIP_CATALOG_SELECTION_CAP,
      overCap: counts.selectedTotal > DROPSHIP_CATALOG_SELECTION_CAP,
      store: parsed.storeConnectionId === null || counts.storeLive === null
        ? null
        : {
          storeConnectionId: parsed.storeConnectionId,
          live: counts.storeLive,
          notLive: counts.selectedTotal - counts.storeLive,
        },
    };
  }

  /**
   * One scan of the filter's candidates with exposure and selection decided
   * for each, without stock (the shared start of every catalog read).
   */
  private async decideCatalogRows(filter: DropshipVendorCatalogCandidateFilter): Promise<{
    now: Date;
    adminRules: DropshipCatalogExposureRule[];
    selectionRules: DropshipVendorSelectionRuleRecord[];
    exposedRows: DecidedCatalogRow[];
  }> {
    const candidateFilter: DropshipVendorCatalogCandidateFilter = {
      vendorId: filter.vendorId,
      search: filter.search,
      category: filter.category,
      categoryId: filter.categoryId,
      productLineId: filter.productLineId,
      productLineIds: filter.productLineIds,
      productId: filter.productId,
    };
    const [adminRules, selectionRules, candidates] = await Promise.all([
      this.deps.repository.listCatalogExposureRules(),
      this.deps.repository.listSelectionRules({ vendorId: filter.vendorId, includeInactive: false }),
      this.deps.repository.listVendorCatalogCandidates(candidateFilter),
    ]);
    const now = this.deps.clock.now();
    const overrideRows = await this.deps.repository.listVariantOverrides({
      vendorId: filter.vendorId,
      productVariantIds: uniqueNumbers(candidates.map((candidate) => candidate.productVariantId)),
    });
    const overridesByVariantId = new Map(overrideRows.map((override) => [override.productVariantId, override]));
    const exposedRows: DecidedCatalogRow[] = [];
    for (const candidate of candidates) {
      const adminExposureDecision = evaluateDropshipCatalogExposure(candidate, adminRules, now);
      if (!adminExposureDecision.exposed) continue;
      const override = overridesByVariantId.get(candidate.productVariantId) ?? null;
      const selected = evaluateDropshipVendorCatalogSelection({
        candidate,
        adminExposureDecision,
        rules: selectionRules,
        rawAtpUnits: 0,
        override,
      }).selected;
      exposedRows.push({ candidate, adminExposureDecision, override, selected });
    }
    return { now, adminRules, selectionRules, exposedRows };
  }
}

interface DecidedCatalogRow {
  candidate: DropshipVendorCatalogCandidate;
  adminExposureDecision: DropshipCatalogExposureDecision;
  override: DropshipVendorVariantOverrideRecord | null;
  selected: boolean;
}

/**
 * `not_selected` is every exposed row that is not selected for any reason,
 * a size turned off by the vendor's override included (TESTS2).
 */
function filterBySelection(rows: readonly DecidedCatalogRow[], selection: DropshipCatalogSelectionFilter): DecidedCatalogRow[] {
  if (selection === "selected") return rows.filter((row) => row.selected);
  if (selection === "not_selected") return rows.filter((row) => !row.selected);
  return [...rows];
}

/** The filter's counts apart from the selection filter: what matches, and how much of it is selected. */
function summarizeCatalogRows(rows: readonly DecidedCatalogRow[]): DropshipCatalogReadSummary {
  return { matching: rows.length, matchingSelected: rows.filter((row) => row.selected).length };
}

function sortAscending(values: readonly number[]): number[] {
  return [...values].sort((left, right) => left - right);
}

type CatalogFacetCandidate = Pick<
  DropshipVendorCatalogCandidate,
  "category" | "productId" | "productLineIds" | "productLineNames" | "productName" | "productSku"
>;

function buildCatalogFacets(rows: readonly CatalogFacetCandidate[]): DropshipVendorCatalogFacets {
  const categories = new Map<string, DropshipVendorCatalogCategoryFacet>();
  const productLines = new Map<string, DropshipVendorCatalogProductLineFacet>();
  const products = new Map<number, DropshipVendorCatalogProductFacet>();

  for (const row of rows) {
    const category = row.category?.trim();
    if (category) {
      const key = category.toLowerCase();
      const facet = categories.get(key) ?? { category, label: category, rowCount: 0 };
      facet.rowCount += 1;
      categories.set(key, facet);
    }

    const countedProductLineKeys = new Set<string>();
    row.productLineIds.forEach((productLineId, index) => {
      if (!Number.isInteger(productLineId) || productLineId <= 0) {
        return;
      }
      const label = row.productLineNames[index]?.trim() || `Product line ${productLineId}`;
      const key = label.toLowerCase();
      const facet = productLines.get(key) ?? { productLineIds: [], label, rowCount: 0 };
      if (!facet.productLineIds.includes(productLineId)) {
        facet.productLineIds.push(productLineId);
        facet.productLineIds.sort((left, right) => left - right);
      }
      if (!countedProductLineKeys.has(key)) {
        facet.rowCount += 1;
        countedProductLineKeys.add(key);
      }
      productLines.set(key, facet);
    });

    const product = products.get(row.productId) ?? {
      productId: row.productId,
      label: row.productName || row.productSku || `Product ${row.productId}`,
      sku: row.productSku,
      rowCount: 0,
    };
    product.rowCount += 1;
    products.set(row.productId, product);
  }

  return {
    categories: sortFacetsByLabel(Array.from(categories.values())),
    productLines: sortFacetsByLabel(Array.from(productLines.values())),
    products: sortFacetsByLabel(Array.from(products.values())),
  };
}

function sortFacetsByLabel<T extends { label: string }>(facets: T[]): T[] {
  return facets.sort((left, right) => left.label.localeCompare(right.label));
}

export function hashVendorSelectionRules(
  rules: readonly NormalizedDropshipVendorSelectionRule[],
): string {
  const canonicalRules = [...rules]
    .map((rule) => ({
      scopeType: rule.scopeType,
      action: rule.action,
      productLineId: rule.productLineId,
      productId: rule.productId,
      productVariantId: rule.productVariantId,
      category: rule.category,
      autoConnectNewSkus: rule.autoConnectNewSkus,
      autoListNewSkus: rule.autoListNewSkus,
      priority: rule.priority,
      metadata: sortJsonValue(rule.metadata),
    }))
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));

  return createHash("sha256").update(JSON.stringify(canonicalRules)).digest("hex");
}

export function normalizeVendorSelectionRule(
  rule: ReplaceDropshipVendorSelectionRule,
): NormalizedDropshipVendorSelectionRule {
  return {
    ...rule,
    productLineId: rule.productLineId ?? null,
    productId: rule.productId ?? null,
    productVariantId: rule.productVariantId ?? null,
    category: rule.category?.trim() || null,
    metadata: rule.metadata ?? {},
  };
}

export const systemDropshipSelectionAtpClock: DropshipClock = {
  now: () => new Date(),
};

function uniqueNumbers(values: readonly number[]): number[] {
  return [...new Set(values)];
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJsonValue);
  }

  if (value && typeof value === "object") {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((sorted, key) => {
        sorted[key] = sortJsonValue((value as Record<string, unknown>)[key]);
        return sorted;
      }, {});
  }

  return value;
}
