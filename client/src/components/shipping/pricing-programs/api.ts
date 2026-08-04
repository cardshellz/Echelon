/**
 * API contract + fetch helpers for the Pricing Programs admin surface
 * (/api/shipping/admin/rate-tables and /api/shipping/admin/rate-books).
 *
 * Query keys follow the repo convention of URL strings so a single
 * prefix-predicate invalidation refreshes every shipping-admin query.
 */

import type { QueryClient } from "@tanstack/react-query";
import type { ShippingDestinationScopeSummary } from "@shared/types/shipping-channel-routing";
import {
  emitDraftRows,
  groupDisplayName,
  groupsFromLayout,
  type DraftLayout,
  type DraftRow,
  type PricingBasis,
  type RateGroup,
  type RateGroupAvailability,
} from "../rate-table-model";

// ---------------------------------------------------------------------------
// Contract types
// ---------------------------------------------------------------------------

export interface RateBookAssignment {
  id: number;
  pricingChannel: string;
  ratePurpose: string;
  originWarehouseId: number | null;
  originWarehouseName: string | null;
  isActive: boolean;
}

export interface RateBookSummary {
  id: number;
  code: string;
  name: string;
  status: string;
  zoneSetId: number | null;
  metadata: unknown;
  assignments: RateBookAssignment[];
}

export interface RateCoverageDestination {
  destinationCountry: string;
  destinationRegion: string | null;
  postalPrefix: string | null;
}

export interface RateBookDestinationGroup {
  id: number;
  rateBookId: number;
  name: string;
  status: "active" | "retired";
  sortOrder: number;
  lockVersion: number;
  sourceDestinationScopeId: number | null;
  sourceDestinationScopeLockVersion: number | null;
  destinations: RateCoverageDestination[];
}

export interface RateTableCoverage {
  id: number;
  rateTableId: number;
  destinationGroupId: number;
  originWarehouseId: number | null;
  availability: RateGroupAvailability;
  destinationGroupLockVersion: number;
  destinationGroupName: string;
  name: string;
  sortOrder: number;
  rateRowCount: number;
  destinations: RateCoverageDestination[];
}

export interface ServiceLevelOption {
  id: number;
  code: string;
  displayName: string;
  description: string | null;
  fulfillmentMode: "parcel" | "freight";
  promiseMinBusinessDays: number | null;
  promiseMaxBusinessDays: number | null;
  sortOrder?: number;
  isActive: boolean;
}

export interface RateTableSummary {
  id: number;
  rateBookId: number;
  serviceLevelId: number;
  pricingBasis: PricingBasis;
  currency: string;
  status: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  createdAt: string;
  metadata: unknown;
  rateBook: RateBookSummary | null;
  serviceLevel: ServiceLevelOption | null;
  coverages?: RateTableCoverage[];
  rowCount: number;
  regionCount?: number;
  /** @deprecated Use regionCount. Retained while older API consumers migrate. */
  stateCount: number;
  zipOverrideCount: number;
  productRuleCount: number;
  minMeasure: number | null;
  maxMeasure: number | null;
}

export interface RateTableAnalysis {
  canActivate: boolean;
  errors: string[];
  warnings: string[];
  coverage: {
    rowCount: number;
    regionCount?: number;
    /** @deprecated Use regionCount. Retained while older API consumers migrate. */
    stateCount: number;
    zipOverrideCount: number;
    missingRegions: string[];
    minMeasure: number | null;
    maxMeasure: number | null;
  };
}

export interface RateTableDetailRow extends DraftRow {
  id: number;
  originWarehouseName: string | null;
}

export interface RateTableDetail {
  rateTable: {
    id: number;
    rateBookId: number | null;
    serviceLevelId: number;
    pricingBasis: PricingBasis;
    currency: string;
    status: string;
    effectiveFrom: string;
    effectiveTo: string | null;
    metadata: unknown;
  };
  serviceLevel: ServiceLevelOption | null;
  rateBook: RateBookSummary | null;
  rows: RateTableDetailRow[];
  coverages?: RateTableCoverage[];
  analysis: RateTableAnalysis;
}

export interface RateTablesResponse {
  rateBooks: RateBookSummary[];
  serviceLevels: ServiceLevelOption[];
  destinationGroups?: RateBookDestinationGroup[];
  destinationScopes?: ShippingDestinationScopeSummary[];
  rateTables: RateTableSummary[];
}

export interface WarehouseOption {
  id: number;
  name: string;
  code: string;
}

export interface CsvParseResponse {
  dialect: "pounds" | "grams" | "pallets" | null;
  pricingBasis: PricingBasis | null;
  rows: DraftRow[];
  errors: Array<{ line: number; message: string }>;
  bandErrors: string[];
  geographyErrors: string[];
}

export interface SaveDraftResponse {
  rateTable: { id: number; status: string };
  draftLayout: DraftLayout | null;
  coverages: RateTableCoverage[];
  rowCount: number;
  warnings: string[];
  analysis: RateTableAnalysis;
}

export interface ManualRateQuoteResponse {
  outcome: "quoted" | "blocked" | "no_rate" | "rate_book_mismatch";
  testedAt: string;
  rateOwner: "echelon";
  destination: {
    country: string;
    region: string;
    postalCode: string;
  };
  testedShipment:
    | {
        basis: "weight";
        billableWeightGrams: number;
        lines: [];
      }
    | {
        basis: "catalog_lines";
        billableWeightGrams: number;
        lines: Array<{
          sku: string;
          productVariantId: number;
          quantity: number;
          unitWeightGrams: number;
        }>;
      };
  rateBook: { id: number; code: string } | null;
  zone: string | null;
  quotes: Array<{
    serviceLevelId: number;
    serviceLevelCode: string;
    displayName: string;
    description: string | null;
    fulfillmentMode: "parcel" | "freight";
    pricingBasis: PricingBasis;
    totalCents: number;
    currency: string;
    promiseMinBusinessDays: number | null;
    promiseMaxBusinessDays: number | null;
    ratedMeasure: number;
    maxShipmentWeightGrams: number | null;
    chargeModel: "fixed_band" | "base_plus_per_started_pound";
    perStartedPoundCents: number | null;
    billablePounds: number | null;
    rateTableId: number;
    productPolicyApplied: boolean;
    calculationTrace: Array<{
      kind: "restriction" | "base_charge" | "threshold" | "adjustment" | "default";
      ruleId: number | null;
      label: string;
      amountCents: number;
      skus: string[];
    }>;
  }>;
  serviceLevelExclusions: Array<{
    serviceLevelId: number;
    serviceLevelCode: string;
    displayName: string;
    code: "BLOCKED" | "INVALID_INPUT" | "INVALID_POLICY" | "NO_RATE";
    message: string;
    ruleId: number | null;
  }>;
  warnings: string[];
}

export type ProductPolicyRuleKind = "restriction" | "base_charge" | "adjustment" | "threshold";
export type ProductPolicyRuleAction =
  | "block"
  | "free"
  | "fixed"
  | "fixed_band"
  | "base_plus_per_started_pound"
  | "base_plus_per_additional_unit"
  | "surcharge"
  | "free_threshold";
export type ProductPolicyMeasurementScope = "order" | "matched_items" | "each_item" | "carton";

export interface ProductPolicyDestinationScope {
  country: string;
  regions: string[];
  postalPrefixes: Array<{ region: string; prefixes: string[] }>;
}

export interface ProductPolicyRule {
  id: number;
  sourceProductSetId: number | null;
  productSetName: string | null;
  name: string;
  kind: ProductPolicyRuleKind;
  action: ProductPolicyRuleAction;
  measurementScope: ProductPolicyMeasurementScope;
  destinationScope: ProductPolicyDestinationScope;
  rateCents: number | null;
  perStartedPoundCents: number | null;
  perAdditionalUnitCents: number | null;
  thresholdCents: number | null;
  memberVariantIds: number[];
  bands: Array<{ minMeasure: number; maxMeasure: number | null; rateCents: number }>;
  isActive: boolean;
}

export interface ProductPolicyVariantOption {
  id: number;
  sku: string | null;
  name: string;
  productName: string;
  isActive: boolean;
}

export interface ProductPolicyRulesResponse {
  rateTable: { id: number; status: string };
  rules: ProductPolicyRule[];
  validationErrors: string[];
}

export interface ProductPolicySelectorsResponse {
  shippingGroups: Array<{ code: string; name: string }>;
  productLines: Array<{ code: string; name: string }>;
  categories: Array<{ id: number; name: string }>;
  productSets: Array<{
    id: number;
    name: string;
    selectorKind: string;
    selectorRef: string | null;
    memberCount: number;
  }>;
  variants: ProductPolicyVariantOption[];
}

export interface ProductPolicyRuleMembersResponse {
  members: ProductPolicyVariantOption[];
}

export const RATE_TABLES_KEY = "/api/shipping/admin/rate-tables";

export function rateTableDetailKey(id: number): string {
  return `/api/shipping/admin/rate-tables/${id}`;
}

export function productPolicyRulesKey(id: number): string {
  return `/api/shipping/admin/rate-tables/${id}/product-rules`;
}

// ---------------------------------------------------------------------------
// Fetch helpers (page-local idiom: typed errors carrying the API error code)
// ---------------------------------------------------------------------------

export class ShippingApiError extends Error {
  constructor(
    message: string,
    readonly code: string | null,
    readonly details: string[],
    readonly status: number,
  ) {
    super(message);
  }
}

function errorFromBody(body: unknown, status: number): ShippingApiError {
  if (body && typeof body === "object" && "error" in body) {
    const error = (body as { error?: unknown }).error;
    if (typeof error === "string") return new ShippingApiError(error, null, [], status);
    if (error && typeof error === "object") {
      const typed = error as { code?: unknown; message?: unknown; details?: unknown };
      return new ShippingApiError(
        typeof typed.message === "string" ? typed.message : `Request failed (${status})`,
        typeof typed.code === "string" ? typed.code : null,
        Array.isArray(typed.details)
          ? typed.details.filter((item): item is string => typeof item === "string")
          : [],
        status,
      );
    }
  }
  return new ShippingApiError(`Request failed (${status})`, null, [], status);
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { credentials: "include", ...init });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw errorFromBody(body, response.status);
  }
  if (response.status === 204) return undefined as T;
  return response.json();
}

export function getJson<T>(url: string): Promise<T> {
  return request<T>(url);
}

export function postJson<T>(url: string, body: unknown): Promise<T> {
  return request<T>(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export function postIdempotentJson<T>(
  url: string,
  body: unknown,
  idempotencyKey: string,
): Promise<T> {
  return request<T>(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey,
    },
    body: JSON.stringify(body),
  });
}

export function putJson<T>(url: string, body: unknown): Promise<T> {
  return request<T>(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export function deleteJson(url: string): Promise<void> {
  return request<void>(url, { method: "DELETE" });
}

export function invalidateShippingAdmin(queryClient: QueryClient): void {
  queryClient.invalidateQueries({
    predicate: (query) =>
      typeof query.queryKey[0] === "string"
      && query.queryKey[0].startsWith("/api/shipping/admin"),
  });
}

// ---------------------------------------------------------------------------
// Draft save payload
// ---------------------------------------------------------------------------

export interface SaveDraftInput {
  draftId: number | null;
  rateBookCode: string;
  serviceLevelCode: string;
  pricingBasis: PricingBasis;
  rows: DraftRow[];
  draftLayout: DraftLayout;
  allowIncomplete: boolean;
}

export function saveDraft(input: SaveDraftInput): Promise<SaveDraftResponse> {
  const payload = {
    pricingMode: "state_zip" as const,
    rateBookCode: input.rateBookCode,
    serviceLevelCode: input.serviceLevelCode,
    pricingBasis: input.pricingBasis,
    currency: "USD",
    rows: input.rows,
    allowIncomplete: input.allowIncomplete,
    draftLayout: input.draftLayout,
  };
  return input.draftId === null
    ? postJson<SaveDraftResponse>("/api/shipping/admin/rate-tables/drafts", payload)
    : putJson<SaveDraftResponse>(`/api/shipping/admin/rate-tables/${input.draftId}`, payload);
}

export function discardRateTableDraft(draftId: number): Promise<void> {
  if (!Number.isInteger(draftId) || draftId <= 0) {
    return Promise.reject(new Error("A valid draft ID is required."));
  }
  return deleteJson(`/api/shipping/admin/rate-tables/${draftId}`);
}

// ---------------------------------------------------------------------------
// Business labels (spec §14: operators never see machine keys)
// ---------------------------------------------------------------------------

const CHANNEL_LABEL: Record<string, string> = {
  shopify: "Shopify",
  internal: "Internal website",
  dropship: "Dropship",
  ebay: "eBay",
};

const PURPOSE_LABEL: Record<string, string> = {
  customer_checkout: "Customer checkout",
  vendor_fulfillment_charge: "Vendor fulfillment charge",
};

export interface PricingFlowChoice {
  value: string;
  label: string;
  pricingChannel: string;
  ratePurpose: string;
}

/**
 * Operator-facing business flows backed by runtime shipping quotes. The raw
 * channel/purpose pair remains the persisted contract, but operators should
 * not have to assemble valid pairs themselves.
 */
export const PRICING_FLOW_CHOICES: readonly PricingFlowChoice[] = [
  {
    value: "shopify:customer_checkout",
    label: "Shopify checkout",
    pricingChannel: "shopify",
    ratePurpose: "customer_checkout",
  },
  {
    value: "internal:customer_checkout",
    label: "Internal website checkout",
    pricingChannel: "internal",
    ratePurpose: "customer_checkout",
  },
  {
    value: "dropship:vendor_fulfillment_charge",
    label: "Dropship vendor fulfillment",
    pricingChannel: "dropship",
    ratePurpose: "vendor_fulfillment_charge",
  },
] as const;

export function channelLabel(channel: string): string {
  return CHANNEL_LABEL[channel] ?? titleCase(channel);
}

export function purposeLabel(purpose: string): string {
  return PURPOSE_LABEL[purpose] ?? titleCase(purpose);
}

export function pricingFlowKey(
  assignment: Pick<RateBookAssignment, "pricingChannel" | "ratePurpose">,
): string {
  return `${assignment.pricingChannel}:${assignment.ratePurpose}`;
}

export function pricingFlowLabel(
  assignment: Pick<RateBookAssignment, "pricingChannel" | "ratePurpose">,
): string {
  return PRICING_FLOW_CHOICES.find((choice) => choice.value === pricingFlowKey(assignment))?.label
    ?? `${channelLabel(assignment.pricingChannel)} ${purposeLabel(assignment.ratePurpose).toLowerCase()}`;
}

export function assignmentLabel(assignment: RateBookAssignment): string {
  const base = pricingFlowLabel(assignment);
  return assignment.originWarehouseName === null
    ? base
    : `${base} · ${assignment.originWarehouseName}`;
}

function titleCase(value: string): string {
  return value
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((token) => token[0].toUpperCase() + token.slice(1))
    .join(" ");
}

// ---------------------------------------------------------------------------
// Program-centric grouping of the flat list response
// ---------------------------------------------------------------------------

export interface ProgramOptionState {
  serviceLevel: ServiceLevelOption;
  /** Currently live revision, if any. */
  active: RateTableSummary | null;
  /** Latest working draft, if any (older strays appear only in history). */
  draft: RateTableSummary | null;
  /** Every revision for this program + option, newest first. */
  history: RateTableSummary[];
}

export interface ProductRuleRevisionStatus {
  liveCount: number | null;
  draftCount: number | null;
}

export function productRuleRevisionStatus(
  option: {
    active: Pick<RateTableSummary, "productRuleCount"> | null;
    draft: Pick<RateTableSummary, "productRuleCount"> | null;
  },
): ProductRuleRevisionStatus {
  return {
    liveCount: option.active?.productRuleCount ?? null,
    draftCount: option.draft?.productRuleCount ?? null,
  };
}

export interface CopyRateProgramResponse {
  sourceRateBook: { id: number; name: string };
  targetRateBook: { id: number; name: string };
  createdDrafts: Array<{
    id: number;
    sourceRateTableId: number;
    serviceLevelId: number;
    serviceLevelCode: string;
    serviceLevelName: string;
    rowCount: number;
    coverageCount: number;
  }>;
  assignmentsCopied: false;
  liveRatesChanged: false;
}

export interface ProgramOverview {
  book: RateBookSummary;
  options: ProgramOptionState[];
  destinationGroups: ProgramDestinationGroup[];
  liveRevisionOnlyGroups: ProgramDestinationGroup[];
  activeAssignments: RateBookAssignment[];
  liveOptionCount: number;
  draftCount: number;
  /** Coverage of the broadest live option (client cannot union regions). */
  maxLiveRegionCount: number;
  totalZipOverrides: number;
  lastTouched: string | null;
}

export interface ProgramDestinationGroup {
  key: string;
  id: number | null;
  rateBookId: number;
  name: string;
  sortOrder: number;
  lockVersion: number | null;
  sourceDestinationScopeId: number | null;
  sourceDestinationScopeLockVersion: number | null;
  destinations: RateCoverageDestination[];
  hasCurrentDefinition: boolean;
  appearsInLiveRevision: boolean;
  appearsInDraftRevision: boolean;
}

export type CoverageCellAction =
  | { kind: "continue_draft"; tableId: number }
  | { kind: "create_revision"; tableId: number }
  | { kind: "start_rates" }
  | { kind: "none" };

export function resolveCoverageCellAction(input: {
  activeTableId: number | null;
  draftTableId: number | null;
}): CoverageCellAction {
  if (input.draftTableId !== null) {
    return { kind: "continue_draft", tableId: input.draftTableId };
  }
  if (input.activeTableId !== null) {
    return { kind: "create_revision", tableId: input.activeTableId };
  }
  return { kind: "start_rates" };
}

export function rateTableRegionCount(
  coverage: Pick<RateTableSummary, "regionCount" | "stateCount">
    | Pick<RateTableAnalysis["coverage"], "regionCount" | "stateCount">,
): number {
  return coverage.regionCount ?? coverage.stateCount;
}

export function rateCopySourceOptions(
  programs: readonly ProgramOverview[],
  targetRateBookId: number,
): ProgramOverview[] {
  return programs
    .filter((program) =>
      program.book.id !== targetRateBookId
      && program.book.status === "active"
      && program.liveOptionCount > 0)
    .sort((left, right) => left.book.name.localeCompare(right.book.name));
}

export function rateProgramCopyConflicts(
  target: ProgramOverview,
): string[] {
  return target.options
    .filter((option) => option.active !== null || option.draft !== null)
    .map((option) => option.serviceLevel.displayName);
}
export function buildProgramOverviews(data: RateTablesResponse): ProgramOverview[] {
  const tablesByBook = new Map<number, RateTableSummary[]>();
  for (const table of data.rateTables) {
    const list = tablesByBook.get(table.rateBookId) ?? [];
    list.push(table);
    tablesByBook.set(table.rateBookId, list);
  }

  const orderedLevels = [...data.serviceLevels].sort(
    (a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.id - b.id,
  );

  return data.rateBooks.map((book) => {
    const tables = tablesByBook.get(book.id) ?? [];
    const persistedGroups = (data.destinationGroups ?? []).filter(
      (group) => group.rateBookId === book.id && group.status === "active",
    );
    const options = orderedLevels.map((level) => {
      const forLevel = tables
        .filter((table) => table.serviceLevelId === level.id)
        .sort((a, b) => b.id - a.id);
      return {
        serviceLevel: level,
        active: forLevel.find((table) => table.status === "active") ?? null,
        draft: forLevel.find((table) => table.status === "draft") ?? null,
        history: forLevel,
      };
    });
    const actives = options.flatMap((option) => option.active ? [option.active] : []);
    const currentTables = options.flatMap((option) => [
      ...(option.active ? [option.active] : []),
      ...(option.draft ? [option.draft] : []),
    ]);
    const lastTouched = tables.reduce<string | null>((latest, table) => {
      const candidate = table.createdAt > table.effectiveFrom ? table.createdAt : table.effectiveFrom;
      return latest === null || candidate > latest ? candidate : latest;
    }, null);
    const reconciledDestinationGroups = mergeProgramDestinationGroups(
      book.id,
      persistedGroups,
      currentTables,
    );
    const currentDestinationGroups = reconciledDestinationGroups.filter(
      (group) => group.hasCurrentDefinition,
    );
    const hasCurrentDestinationLayout = currentDestinationGroups.length > 0;
    const destinationGroups = hasCurrentDestinationLayout
      ? currentDestinationGroups
      : reconciledDestinationGroups;
    const liveRevisionOnlyGroups = hasCurrentDestinationLayout
      ? reconciledDestinationGroups.filter(
          (group) =>
            !group.hasCurrentDefinition && group.appearsInLiveRevision,
        )
      : [];
    return {
      book,
      options,
      destinationGroups,
      liveRevisionOnlyGroups,
      activeAssignments: book.assignments.filter((assignment) => assignment.isActive),
      liveOptionCount: actives.length,
      draftCount: options.filter((option) => option.draft !== null).length,
      maxLiveRegionCount: actives.reduce(
        (max, table) => Math.max(max, rateTableRegionCount(table)),
        0,
      ),
      totalZipOverrides: actives.reduce((sum, table) => sum + table.zipOverrideCount, 0),
      lastTouched,
    };
  });
}

export function effectiveRateTableCoverages(
  table: RateTableSummary,
): Array<RateTableCoverage | DerivedRateTableCoverage> {
  if ((table.coverages?.length ?? 0) > 0) return table.coverages ?? [];
  const groups = groupsFromLayout(table.metadata);
  if (groups === null) return [];
  return groups.map((group, index) => ({
    id: null,
    rateTableId: table.id,
    destinationGroupId: group.destinationGroupId,
    originWarehouseId: group.originWarehouseId,
    availability: group.availability,
    destinationGroupLockVersion: group.destinationGroupLockVersion,
    destinationGroupName: groupDisplayName(group, index),
    name: groupDisplayName(group, index),
    sortOrder: index,
    rateRowCount: emitDraftRows([group], table.pricingBasis).length,
    destinations: [
      ...group.regions.map((region) => ({
        destinationCountry: "US",
        destinationRegion: region,
        postalPrefix: null,
      })),
      ...group.zipEntries.flatMap((entry) =>
        entry.prefixes.map((prefix) => ({
          destinationCountry: "US",
          destinationRegion: entry.state,
          postalPrefix: prefix,
        }))),
    ],
  }));
}

export type EffectiveRateTableCoverage = ReturnType<
  typeof effectiveRateTableCoverages
>[number];

export function coverageGroupKey(
  group: Pick<
    ProgramDestinationGroup,
    "id" | "name" | "destinations"
  >,
): string {
  if (group.id !== null) return `id:${group.id}`;
  return `derived:${group.name.trim().toLocaleLowerCase()}|${destinationSignature(group.destinations)}`;
}

export interface DestinationGroupTarget {
  id: number | null;
  key: string;
}

/**
 * Resolves the exact editor row for a destination selected in the program
 * matrix. Persisted IDs are authoritative; the derived key preserves support
 * for legacy rate tables that predate reusable destination-group records.
 */
export function findEditorRateGroup(
  groups: readonly RateGroup[],
  target: DestinationGroupTarget | null,
): RateGroup | null {
  if (target === null) return groups[0] ?? null;

  if (target.id !== null) {
    const matchingScopes = groups.filter(
      (group) => group.destinationGroupId === target.id,
    );
    const defaultScope = matchingScopes.find(
      (group) => group.originWarehouseId === null,
    );
    if (defaultScope !== undefined) return defaultScope;
    if (matchingScopes[0] !== undefined) return matchingScopes[0];
  }

  return groups.find((group, index) =>
    coverageGroupKey({
      id: group.destinationGroupId,
      name: groupDisplayName(group, index),
      destinations: rateGroupDestinations(group),
    }) === target.key) ?? null;
}

function rateGroupDestinations(
  group: RateGroup,
): RateCoverageDestination[] {
  return [
    ...group.regions.map((region) => ({
      destinationCountry: "US",
      destinationRegion: region,
      postalPrefix: null,
    })),
    ...group.zipEntries.flatMap((entry) =>
      entry.prefixes.map((prefix) => ({
        destinationCountry: "US",
        destinationRegion: entry.state,
        postalPrefix: prefix,
      }))),
  ];
}

interface DerivedRateTableCoverage
extends Omit<
  RateTableCoverage,
  "id" | "destinationGroupId" | "destinationGroupLockVersion"
> {
  id: null;
  destinationGroupId: number | null;
  destinationGroupLockVersion: number | null;
}

function mergeProgramDestinationGroups(
  rateBookId: number,
  persisted: readonly RateBookDestinationGroup[],
  tables: readonly RateTableSummary[],
): ProgramDestinationGroup[] {
  const merged = new Map<string, ProgramDestinationGroup>();
  const persistedKeyByName = new Map<string, string | null>();
  for (const group of persisted) {
    const item: ProgramDestinationGroup = {
      key: `id:${group.id}`,
      id: group.id,
      rateBookId,
      name: group.name,
      sortOrder: group.sortOrder,
      lockVersion: group.lockVersion,
      sourceDestinationScopeId: group.sourceDestinationScopeId,
      sourceDestinationScopeLockVersion:
        group.sourceDestinationScopeLockVersion,
      destinations: group.destinations,
      hasCurrentDefinition: true,
      appearsInLiveRevision: false,
      appearsInDraftRevision: false,
    };
    merged.set(item.key, item);
    const normalizedName = normalizeDestinationGroupName(group.name);
    persistedKeyByName.set(
      normalizedName,
      persistedKeyByName.has(normalizedName) ? null : item.key,
    );
  }
  for (const table of tables) {
    for (const coverage of effectiveRateTableCoverages(table)) {
      const coverageKey = coverageGroupKey({
        id: coverage.destinationGroupId,
        name: coverage.destinationGroupName,
        destinations: coverage.destinations,
      });
      const currentNameKey = coverage.destinationGroupId === null
        ? persistedKeyByName.get(
            normalizeDestinationGroupName(coverage.destinationGroupName),
          )
        : undefined;
      const matchedKey = currentNameKey ?? coverageKey;
      const existing = merged.get(matchedKey);
      if (existing !== undefined) {
        merged.set(matchedKey, withRevisionPresence(existing, table.status));
        continue;
      }
      const item: ProgramDestinationGroup = {
        key: coverageKey,
        id: coverage.destinationGroupId,
        rateBookId,
        name: coverage.destinationGroupName,
        sortOrder: coverage.sortOrder,
        lockVersion: coverage.destinationGroupLockVersion,
        sourceDestinationScopeId: null,
        sourceDestinationScopeLockVersion: null,
        destinations: coverage.destinations,
        hasCurrentDefinition: false,
        appearsInLiveRevision: table.status === "active",
        appearsInDraftRevision: table.status === "draft",
      };
      if (!merged.has(item.key)) merged.set(item.key, item);
    }
  }
  return [...merged.values()].sort(
    (left, right) =>
      left.sortOrder - right.sortOrder
      || left.name.localeCompare(right.name)
      || left.key.localeCompare(right.key),
  );
}

/**
 * Resolve the coverage scopes shown in one program-matrix row. Persisted IDs
 * remain authoritative. Legacy revisions predate those IDs, so an exact,
 * unambiguous current group name is their compatibility identity.
 */
export function rateTableCoveragesForGroup(
  table: RateTableSummary | null,
  group: ProgramDestinationGroup,
): EffectiveRateTableCoverage[] {
  if (table === null) return [];
  return effectiveRateTableCoverages(table).filter((coverage) => {
    if (
      group.id !== null
      && coverage.destinationGroupId !== null
    ) {
      return group.id === coverage.destinationGroupId;
    }
    if (
      group.hasCurrentDefinition
      && group.id !== null
      && coverage.destinationGroupId === null
    ) {
      return normalizeDestinationGroupName(group.name)
        === normalizeDestinationGroupName(coverage.destinationGroupName);
    }
    if (group.id !== null || coverage.destinationGroupId !== null) return false;
    return coverageGroupKey({
      id: coverage.destinationGroupId,
      name: coverage.destinationGroupName,
      destinations: coverage.destinations,
    }) === group.key;
  });
}

export function countStaleRateTableCoverages(
  coverages: readonly EffectiveRateTableCoverage[],
  group: ProgramDestinationGroup,
): number {
  if (!group.hasCurrentDefinition || group.id === null) return 0;
  const currentDestinationSignature = destinationSignature(group.destinations);
  return coverages.filter((coverage) => {
    if (coverage.destinationGroupId !== null) {
      return coverage.destinationGroupLockVersion !== group.lockVersion;
    }
    return destinationSignature(coverage.destinations)
      !== currentDestinationSignature;
  }).length;
}

function withRevisionPresence(
  group: ProgramDestinationGroup,
  status: string,
): ProgramDestinationGroup {
  return {
    ...group,
    appearsInLiveRevision:
      group.appearsInLiveRevision || status === "active",
    appearsInDraftRevision:
      group.appearsInDraftRevision || status === "draft",
  };
}

function normalizeDestinationGroupName(name: string): string {
  return name.trim().toLocaleLowerCase();
}

function destinationSignature(
  destinations: readonly RateCoverageDestination[],
): string {
  return [...destinations]
    .map((destination) => [
      destination.destinationCountry,
      destination.destinationRegion ?? "",
      destination.postalPrefix ?? "",
    ].join("|"))
    .sort()
    .join(",");
}

export function formatDate(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}
