import { createHash } from "crypto";
import {
  evaluateDropshipCatalogExposure,
  type DropshipCatalogExposureDecision,
  type DropshipCatalogExposureRule,
  type DropshipCatalogVariantCandidate,
} from "../domain/catalog-exposure";
import { DropshipError } from "../domain/errors";
import {
  assertDropshipVendorSelectionRuleTarget,
  evaluateDropshipVendorCatalogSelection,
  type DropshipVendorCatalogSelectionDecision,
  type DropshipVendorSelectionRule,
  type DropshipVendorVariantOverride,
} from "../domain/vendor-selection";
import type { DropshipClock, DropshipLogEvent, DropshipLogger } from "./dropship-ports";
import {
  listDropshipVendorSelectionRulesInputSchema,
  previewDropshipVendorCatalogInputSchema,
  replaceDropshipVendorSelectionRulesInputSchema,
  type ListDropshipVendorSelectionRulesInput,
  type PreviewDropshipVendorCatalogInput,
  type ReplaceDropshipVendorSelectionRule,
  type ReplaceDropshipVendorSelectionRulesInput,
} from "./dropship-selection-dtos";

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

export interface DropshipSelectionAtpRepository {
  findVendorByMemberId(memberId: string): Promise<DropshipVendorProfile | null>;
  listCatalogExposureRules(): Promise<DropshipCatalogExposureRule[]>;
  listSelectionRules(input: ListDropshipVendorSelectionRulesInput): Promise<DropshipVendorSelectionRuleRecord[]>;
  replaceSelectionRules(
    input: ReplaceDropshipVendorSelectionRulesRepositoryInput,
  ): Promise<ReplaceDropshipVendorSelectionRulesRepositoryResult>;
  listVendorCatalogCandidates(input: PreviewDropshipVendorCatalogInput): Promise<DropshipVendorCatalogCandidate[]>;
  listVariantOverrides(input: {
    vendorId: number;
    productVariantIds: readonly number[];
  }): Promise<DropshipVendorVariantOverrideRecord[]>;
}

export interface DropshipAtpProvider {
  getBaseAtpByProductIds(productIds: readonly number[]): Promise<Map<number, number>>;
}

export interface DropshipSelectionAtpServiceDependencies {
  clock: DropshipClock;
  logger: DropshipLogger;
  repository: DropshipSelectionAtpRepository;
  atp: DropshipAtpProvider;
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
    facets: DropshipVendorCatalogFacets;
  }> {
    const parsed = previewDropshipVendorCatalogInputSchema.parse(input);
    const facetInput: PreviewDropshipVendorCatalogInput = {
      ...parsed,
      category: undefined,
      productLineId: undefined,
      productLineIds: undefined,
      productId: undefined,
      selectedOnly: false,
      page: 1,
    };
    const [adminRules, selectionRules, candidates, facetCandidates] = await Promise.all([
      this.deps.repository.listCatalogExposureRules(),
      this.deps.repository.listSelectionRules({ vendorId: parsed.vendorId, includeInactive: false }),
      this.deps.repository.listVendorCatalogCandidates(parsed),
      this.deps.repository.listVendorCatalogCandidates(facetInput),
    ]);
    const now = this.deps.clock.now();
    const facets = buildCatalogFacets(facetCandidates);

    const productIds = uniqueNumbers(candidates.map((candidate) => candidate.productId));
    const productVariantIds = uniqueNumbers(candidates.map((candidate) => candidate.productVariantId));
    const [baseAtpByProductId, overrideRows] = await Promise.all([
      this.deps.atp.getBaseAtpByProductIds(productIds),
      this.deps.repository.listVariantOverrides({
        vendorId: parsed.vendorId,
        productVariantIds,
      }),
    ]);

    const overridesByVariantId = new Map(
      overrideRows.map((override) => [override.productVariantId, override]),
    );
    const evaluatedRows = candidates.map((candidate) => {
      const adminExposureDecision = evaluateDropshipCatalogExposure(candidate, adminRules, now);
      const productAtpBase = baseAtpByProductId.get(candidate.productId) ?? 0;
      const unitsPerVariant = Math.max(1, candidate.unitsPerVariant);
      const rawAtpUnits = Math.floor(Math.max(0, productAtpBase) / unitsPerVariant);
      const selectionDecision = evaluateDropshipVendorCatalogSelection({
        candidate,
        adminExposureDecision,
        rules: selectionRules,
        rawAtpUnits,
        override: overridesByVariantId.get(candidate.productVariantId) ?? null,
      });

      return {
        ...candidate,
        adminExposureDecision,
        selectionDecision,
      };
    });
    const filteredRows = parsed.selectedOnly
      ? evaluatedRows.filter((row) => row.selectionDecision.selected)
      : evaluatedRows;
    const start = (parsed.page - 1) * parsed.limit;

    return {
      rows: filteredRows.slice(start, start + parsed.limit),
      total: filteredRows.length,
      page: parsed.page,
      limit: parsed.limit,
      facets,
    };
  }
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

export function makeDropshipSelectionAtpLogger(): DropshipLogger {
  return {
    info: (event) => logDropshipSelectionAtpEvent("info", event),
    warn: (event) => logDropshipSelectionAtpEvent("warn", event),
    error: (event) => logDropshipSelectionAtpEvent("error", event),
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

function logDropshipSelectionAtpEvent(
  level: "info" | "warn" | "error",
  event: DropshipLogEvent,
): void {
  const payload = JSON.stringify({
    code: event.code,
    message: event.message,
    context: event.context ?? {},
  });
  if (level === "error") {
    console.error(payload);
    return;
  }
  if (level === "warn") {
    console.warn(payload);
    return;
  }
  console.info(payload);
}
