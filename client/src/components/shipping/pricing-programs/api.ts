/**
 * API contract + fetch helpers for the Pricing Programs admin surface
 * (/api/shipping/admin/rate-tables and /api/shipping/admin/rate-books).
 *
 * Query keys follow the repo convention of URL strings so a single
 * prefix-predicate invalidation refreshes every shipping-admin query.
 */

import type { QueryClient } from "@tanstack/react-query";
import type { DraftLayout, DraftRow, PricingBasis } from "../rate-table-model";

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
  rowCount: number;
  stateCount: number;
  zipOverrideCount: number;
  minMeasure: number | null;
  maxMeasure: number | null;
}

export interface RateTableAnalysis {
  canActivate: boolean;
  errors: string[];
  warnings: string[];
  coverage: {
    rowCount: number;
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
  analysis: RateTableAnalysis;
}

export interface RateTablesResponse {
  rateBooks: RateBookSummary[];
  serviceLevels: ServiceLevelOption[];
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
  rowCount: number;
  warnings: string[];
  analysis: RateTableAnalysis;
}

export interface ManualRateQuoteResponse {
  outcome: "quoted" | "no_rate" | "rate_book_mismatch";
  testedAt: string;
  rateOwner: "echelon";
  destination: {
    country: string;
    region: string;
    postalCode: string;
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
  }>;
  warnings: string[];
}

export const RATE_TABLES_KEY = "/api/shipping/admin/rate-tables";

export function rateTableDetailKey(id: number): string {
  return `/api/shipping/admin/rate-tables/${id}`;
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

export interface ProgramOverview {
  book: RateBookSummary;
  options: ProgramOptionState[];
  activeAssignments: RateBookAssignment[];
  liveOptionCount: number;
  draftCount: number;
  /** Coverage of the broadest live option (client cannot union states). */
  maxLiveStateCount: number;
  totalZipOverrides: number;
  lastTouched: string | null;
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
    const lastTouched = tables.reduce<string | null>((latest, table) => {
      const candidate = table.createdAt > table.effectiveFrom ? table.createdAt : table.effectiveFrom;
      return latest === null || candidate > latest ? candidate : latest;
    }, null);
    return {
      book,
      options,
      activeAssignments: book.assignments.filter((assignment) => assignment.isActive),
      liveOptionCount: actives.length,
      draftCount: options.filter((option) => option.draft !== null).length,
      maxLiveStateCount: actives.reduce((max, table) => Math.max(max, table.stateCount), 0),
      totalZipOverrides: actives.reduce((sum, table) => sum + table.zipOverrideCount, 0),
      lastTouched,
    };
  });
}

export function formatDate(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}
