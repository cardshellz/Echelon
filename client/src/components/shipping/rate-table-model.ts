/**
 * Pure model for the pricing-program rate editor.
 *
 * Destination groups are a UI abstraction: each group applies one band
 * schedule to many states (plus optional ZIP-prefix overrides) and expands
 * into individual state/ZIP/band rows on save. Rates are integer cents and
 * measures integer grams / whole pallets at the API boundary; operators only
 * ever see dollars, pounds, and pallet counts.
 */

export const GRAMS_PER_POUND = 453.59237;

export type PricingBasis = "shipment_weight" | "pallet_count";

export const US_POSTAL_REGIONS = [
  ["AL", "Alabama"], ["AK", "Alaska"], ["AZ", "Arizona"], ["AR", "Arkansas"],
  ["CA", "California"], ["CO", "Colorado"], ["CT", "Connecticut"], ["DE", "Delaware"],
  ["FL", "Florida"], ["GA", "Georgia"], ["HI", "Hawaii"], ["ID", "Idaho"],
  ["IL", "Illinois"], ["IN", "Indiana"], ["IA", "Iowa"], ["KS", "Kansas"],
  ["KY", "Kentucky"], ["LA", "Louisiana"], ["ME", "Maine"], ["MD", "Maryland"],
  ["MA", "Massachusetts"], ["MI", "Michigan"], ["MN", "Minnesota"], ["MS", "Mississippi"],
  ["MO", "Missouri"], ["MT", "Montana"], ["NE", "Nebraska"], ["NV", "Nevada"],
  ["NH", "New Hampshire"], ["NJ", "New Jersey"], ["NM", "New Mexico"], ["NY", "New York"],
  ["NC", "North Carolina"], ["ND", "North Dakota"], ["OH", "Ohio"], ["OK", "Oklahoma"],
  ["OR", "Oregon"], ["PA", "Pennsylvania"], ["RI", "Rhode Island"], ["SC", "South Carolina"],
  ["SD", "South Dakota"], ["TN", "Tennessee"], ["TX", "Texas"], ["UT", "Utah"],
  ["VT", "Vermont"], ["VA", "Virginia"], ["WA", "Washington"], ["WV", "West Virginia"],
  ["WI", "Wisconsin"], ["WY", "Wyoming"], ["DC", "District of Columbia"],
  ["AS", "American Samoa"], ["GU", "Guam"], ["MP", "Northern Mariana Islands"],
  ["PR", "Puerto Rico"], ["VI", "U.S. Virgin Islands"],
] as const;

export const REGION_NAME = new Map<string, string>(
  US_POSTAL_REGIONS.map(([code, name]) => [code, name]),
);

const NON_CONTIGUOUS = new Set(["AK", "HI", "AS", "GU", "MP", "PR", "VI"]);
const TERRITORIES = new Set(["AS", "GU", "MP", "PR", "VI"]);

export const ALL_REGION_CODES = US_POSTAL_REGIONS.map(([code]) => code);
export const CONTIGUOUS_US = ALL_REGION_CODES.filter((code) => !NON_CONTIGUOUS.has(code));
export const ALL_US_STATES = ALL_REGION_CODES.filter((code) => !TERRITORIES.has(code));

export interface DestinationGroupTemplate {
  id: string;
  name: string;
  regions: readonly string[];
}

/** Broad coverage shortcuts that may intentionally overlap regional templates. */
export const DESTINATION_COVERAGE_TEMPLATES: readonly DestinationGroupTemplate[] = [
  { id: "contiguous-us", name: "Contiguous US", regions: CONTIGUOUS_US },
  { id: "all-us-states", name: "All US states", regions: ALL_US_STATES },
  { id: "states-and-territories", name: "States + territories", regions: ALL_REGION_CODES },
];

/**
 * Editable shipping regions. Together these form one exhaustive,
 * non-overlapping partition of every supported US state and territory.
 */
export const DESTINATION_REGION_TEMPLATES: readonly DestinationGroupTemplate[] = [
  {
    id: "northeast",
    name: "Northeast",
    regions: ["CT", "ME", "MA", "NH", "RI", "VT", "NJ", "NY", "PA"],
  },
  {
    id: "mid-atlantic",
    name: "Mid-Atlantic",
    regions: ["DE", "DC", "MD", "VA", "WV"],
  },
  {
    id: "southeast",
    name: "Southeast",
    regions: ["AL", "FL", "GA", "KY", "MS", "NC", "SC", "TN"],
  },
  {
    id: "south-central",
    name: "South Central",
    regions: ["AR", "LA", "OK", "TX"],
  },
  {
    id: "midwest",
    name: "Midwest",
    regions: ["IL", "IN", "IA", "KS", "MI", "MN", "MO", "NE", "ND", "OH", "SD", "WI"],
  },
  {
    id: "mountain-west",
    name: "Mountain West",
    regions: ["AZ", "CO", "ID", "MT", "NV", "NM", "UT", "WY"],
  },
  {
    id: "west-coast",
    name: "West Coast",
    regions: ["CA", "OR", "WA"],
  },
  {
    id: "alaska-hawaii",
    name: "Alaska and Hawaii",
    regions: ["AK", "HI"],
  },
  {
    id: "us-territories",
    name: "US Territories",
    regions: ["AS", "GU", "MP", "PR", "VI"],
  },
];

export const DESTINATION_GROUP_TEMPLATES: readonly DestinationGroupTemplate[] = [
  ...DESTINATION_COVERAGE_TEMPLATES,
  ...DESTINATION_REGION_TEMPLATES,
];

export function destinationGroupTemplateById(
  id: string,
): DestinationGroupTemplate | null {
  return DESTINATION_GROUP_TEMPLATES.find((template) => template.id === id) ?? null;
}

export function findDestinationGroupTemplate(
  regions: readonly string[],
): DestinationGroupTemplate | null {
  const selected = new Set(regions);
  return DESTINATION_GROUP_TEMPLATES.find((template) => (
    selected.size === template.regions.length
    && template.regions.every((region) => selected.has(region))
  )) ?? null;
}

// ---------------------------------------------------------------------------
// Editor state
// ---------------------------------------------------------------------------

export interface BuilderBand {
  id: string;
  /** Raw operator input: pounds for parcel, whole pallets for freight. */
  maxMeasure: string;
  rateUsd: string;
  /** Freight only: optional total-shipment weight ceiling in pounds. */
  maxShipmentWeightLb: string;
}

export interface ZipEntry {
  id: string;
  state: string;
  prefixes: string[];
}

export interface RateGroup {
  id: string;
  /** Operator-facing label, e.g. "Contiguous US" or "Alaska and Hawaii". */
  name: string;
  originWarehouseId: number | null;
  regions: string[];
  zipEntries: ZipEntry[];
  bands: BuilderBand[];
}

export interface DraftRow {
  originWarehouseId: number | null;
  destinationCountry: string;
  destinationRegion: string;
  postalPrefix: string | null;
  minMeasure: number;
  maxMeasure: number;
  maxShipmentWeightGrams: number | null;
  rateCents: number;
}

export function newId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function defaultBands(pricingBasis: PricingBasis): BuilderBand[] {
  return pricingBasis === "pallet_count"
    ? [
        { id: newId(), maxMeasure: "1", rateUsd: "", maxShipmentWeightLb: "" },
        { id: newId(), maxMeasure: "2", rateUsd: "", maxShipmentWeightLb: "" },
        { id: newId(), maxMeasure: "4", rateUsd: "", maxShipmentWeightLb: "" },
      ]
    : [
        { id: newId(), maxMeasure: "1", rateUsd: "", maxShipmentWeightLb: "" },
        { id: newId(), maxMeasure: "5", rateUsd: "", maxShipmentWeightLb: "" },
        { id: newId(), maxMeasure: "20", rateUsd: "", maxShipmentWeightLb: "" },
        { id: newId(), maxMeasure: "50", rateUsd: "", maxShipmentWeightLb: "" },
      ];
}

export function newGroup(
  pricingBasis: PricingBasis,
  regions: string[] = [...CONTIGUOUS_US],
  name = "",
): RateGroup {
  return {
    id: newId(),
    name,
    originWarehouseId: null,
    regions,
    zipEntries: [],
    bands: defaultBands(pricingBasis),
  };
}

/**
 * Display name for a group: the operator's label, else a description derived
 * from its destination membership so unnamed groups stay tellable-apart.
 */
export function groupDisplayName(group: RateGroup, index: number): string {
  if (group.name.trim() !== "") return group.name.trim();
  const regions = new Set(group.regions);
  const sameSet = (expected: readonly string[]) =>
    regions.size === expected.length && expected.every((code) => regions.has(code));
  if (sameSet(ALL_REGION_CODES)) return "All US states and territories";
  if (sameSet(CONTIGUOUS_US)) return "Contiguous US";
  if (sameSet(ALL_US_STATES)) return "All US states";
  if (regions.size === 2 && regions.has("AK") && regions.has("HI")) return "Alaska and Hawaii";
  if (regions.size === 1) {
    const only = group.regions[0];
    return REGION_NAME.get(only) ?? only;
  }
  if (regions.size === 0 && group.zipEntries.length > 0) {
    const states = [...new Set(group.zipEntries.map((entry) => entry.state))];
    return `${states.join(", ")} ZIP overrides`;
  }
  if (regions.size > 0) return `${regions.size} states`;
  return `Rate group ${index + 1}`;
}

// ---------------------------------------------------------------------------
// Unit formatting / parsing (operators see lb, pallets, dollars)
// ---------------------------------------------------------------------------

export function poundsFromGrams(grams: number): string {
  const pounds = grams / GRAMS_PER_POUND;
  const candidates = [
    Math.round(pounds),
    Math.round(pounds * 16) / 16,
    Math.round(pounds * 10) / 10,
    Math.round(pounds * 100) / 100,
    Math.round(pounds * 1000) / 1000,
  ];
  const recovered = candidates.find((candidate) => (
    Math.abs(Math.round(candidate * GRAMS_PER_POUND) - grams) <= 1
  ));
  return String(recovered ?? Number(pounds.toFixed(3)));
}

export function usdFromCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export function describeMeasureRange(
  pricingBasis: PricingBasis,
  minMeasure: number | null,
  maxMeasure: number | null,
): string {
  if (minMeasure === null || maxMeasure === null) return "—";
  if (pricingBasis === "pallet_count") {
    return minMeasure === maxMeasure
      ? `${minMeasure} pallet${minMeasure === 1 ? "" : "s"}`
      : `${minMeasure}–${maxMeasure} pallets`;
  }
  return `${poundsFromGrams(minMeasure)}–${poundsFromGrams(maxMeasure)} lb`;
}

export function describeBandLowerBound(
  pricingBasis: PricingBasis,
  bands: readonly BuilderBand[],
  bandIndex: number,
): string {
  if (bandIndex === 0) return pricingBasis === "pallet_count" ? "1 pallet" : "0 lb";
  const previous = bands[bandIndex - 1].maxMeasure.trim();
  if (previous === "") return "—";
  if (pricingBasis === "pallet_count") {
    return `Over ${previous} ${Number(previous) === 1 ? "pallet" : "pallets"}`;
  }
  return `Over ${previous} lb`;
}

// ---------------------------------------------------------------------------
// Validation + row expansion
// ---------------------------------------------------------------------------

export interface GroupIssue {
  groupId: string;
  message: string;
}

export interface RateGroupValidation {
  /** Fully expanded rows; empty when any structural error exists. */
  rows: DraftRow[];
  /** Deduplicated flat messages (legacy shape used by save gating). */
  errors: string[];
  /** The same errors keyed by group for review-step remediation links. */
  issues: GroupIssue[];
}

export function validateRateGroups(
  groups: RateGroup[],
  pricingBasis: PricingBasis,
): RateGroupValidation {
  const rows: DraftRow[] = [];
  const errors: string[] = [];
  const issues: GroupIssue[] = [];
  const statewideOwner = new Map<string, number>();
  const zipOwner = new Map<string, number>();
  const groupLabel = (index: number) => groupDisplayName(groups[index], index);

  groups.forEach((group, groupIndex) => {
    const fail = (message: string) => {
      errors.push(message);
      issues.push({ groupId: group.id, message });
    };
    if (group.regions.length === 0 && group.zipEntries.length === 0) {
      fail(`${groupLabel(groupIndex)} has no destinations.`);
    }
    for (const region of group.regions) {
      const key = `${group.originWarehouseId ?? "any"}|${region}`;
      if (statewideOwner.has(key)) {
        fail(`${region} is assigned statewide in more than one destination group for this warehouse scope.`);
      }
      statewideOwner.set(key, groupIndex);
    }
    for (const entry of group.zipEntries) {
      for (const prefix of entry.prefixes) {
        const key = `${group.originWarehouseId ?? "any"}|${entry.state}|${prefix}`;
        if (zipOwner.has(key)) {
          fail(`${entry.state} ZIP ${prefix} is assigned in more than one destination group for this warehouse scope.`);
        }
        zipOwner.set(key, groupIndex);
      }
    }

    const parsedBands = group.bands.map((band, bandIndex) => {
      const maximum = Number(band.maxMeasure);
      const rate = Number(band.rateUsd);
      const previousMaximum = bandIndex === 0 ? null : Number(group.bands[bandIndex - 1].maxMeasure);
      if (!Number.isFinite(maximum) || maximum <= 0 || band.maxMeasure.trim() === "") {
        fail(`${groupLabel(groupIndex)} has a band without a valid upper limit.`);
      }
      if (pricingBasis === "pallet_count" && !Number.isInteger(maximum)) {
        fail(`${groupLabel(groupIndex)} pallet limits must be whole numbers.`);
      }
      if (
        previousMaximum !== null
        && Number.isFinite(previousMaximum)
        && maximum <= previousMaximum
      ) {
        fail(`${groupLabel(groupIndex)} band upper limits must increase from row to row.`);
      }
      if (!Number.isFinite(rate) || rate < 0 || band.rateUsd.trim() === "") {
        fail(`${groupLabel(groupIndex)} has a band without a charge.`);
      }
      const maxShipmentWeightLb = band.maxShipmentWeightLb.trim() === ""
        ? null
        : Number(band.maxShipmentWeightLb);
      if (
        maxShipmentWeightLb !== null
        && (!Number.isFinite(maxShipmentWeightLb) || maxShipmentWeightLb <= 0)
      ) {
        fail(`${groupLabel(groupIndex)} has an invalid total-weight ceiling.`);
      }
      return {
        minMeasure: pricingBasis === "pallet_count"
          ? bandIndex === 0 ? 1 : Math.round(previousMaximum!) + 1
          : bandIndex === 0
            ? 0
            : Math.round(previousMaximum! * GRAMS_PER_POUND) + 1,
        maxMeasure: pricingBasis === "pallet_count"
          ? Math.round(maximum)
          : Math.round(maximum * GRAMS_PER_POUND),
        maxShipmentWeightGrams: maxShipmentWeightLb === null
          ? null
          : Math.round(maxShipmentWeightLb * GRAMS_PER_POUND),
        rateCents: Math.round(rate * 100),
      };
    });

    for (const destination of groupDestinations(group)) {
      for (const band of parsedBands) {
        rows.push({
          originWarehouseId: group.originWarehouseId,
          destinationCountry: "US",
          destinationRegion: destination.region,
          postalPrefix: destination.prefix,
          ...band,
        });
      }
    }
  });

  for (const zipKey of zipOwner.keys()) {
    const [warehouseScope, state] = zipKey.split("|");
    if (!statewideOwner.has(`${warehouseScope}|${state}`)) {
      const message = `${state} ZIP overrides require a statewide fallback rate in the same warehouse scope.`;
      errors.push(message);
      const ownerIndex = zipOwner.get(zipKey);
      if (ownerIndex !== undefined && groups[ownerIndex]) {
        issues.push({ groupId: groups[ownerIndex].id, message });
      }
    }
  }

  const deduplicatedErrors = [...new Set(errors)];
  return {
    rows: deduplicatedErrors.length > 0 ? [] : rows,
    errors: deduplicatedErrors,
    issues: dedupeIssues(issues),
  };
}

/**
 * Lenient expansion for incomplete-draft saves: bands with a parseable upper
 * limit and charge become rows; unfinished bands are skipped. A band with an
 * unparseable upper limit un-anchors everything after it in that group, since
 * later lower bounds derive from it.
 */
export function emitDraftRows(
  groups: RateGroup[],
  pricingBasis: PricingBasis,
): DraftRow[] {
  const rows: DraftRow[] = [];
  for (const group of groups) {
    const emittable: Array<{
      minMeasure: number;
      maxMeasure: number;
      maxShipmentWeightGrams: number | null;
      rateCents: number;
    }> = [];
    let previousMaximum: number | null = null;
    for (const [bandIndex, band] of group.bands.entries()) {
      const maximum = Number(band.maxMeasure);
      const validMaximum = band.maxMeasure.trim() !== ""
        && Number.isFinite(maximum)
        && maximum > 0
        && (pricingBasis !== "pallet_count" || Number.isInteger(maximum))
        && (previousMaximum === null || maximum > previousMaximum)
        && (bandIndex === 0 || previousMaximum !== null);
      if (!validMaximum) {
        // Later bands have no anchor for their computed lower bound.
        if (band.maxMeasure.trim() !== "" || bandIndex < group.bands.length - 1) break;
        continue;
      }
      const rate = Number(band.rateUsd);
      const validRate = band.rateUsd.trim() !== "" && Number.isFinite(rate) && rate >= 0;
      const ceilingLb = band.maxShipmentWeightLb.trim() === ""
        ? null
        : Number(band.maxShipmentWeightLb);
      const validCeiling = ceilingLb === null || (Number.isFinite(ceilingLb) && ceilingLb > 0);
      if (validRate && validCeiling) {
        emittable.push({
          minMeasure: pricingBasis === "pallet_count"
            ? previousMaximum === null ? 1 : Math.round(previousMaximum) + 1
            : previousMaximum === null
              ? 0
              : Math.round(previousMaximum * GRAMS_PER_POUND) + 1,
          maxMeasure: pricingBasis === "pallet_count"
            ? Math.round(maximum)
            : Math.round(maximum * GRAMS_PER_POUND),
          maxShipmentWeightGrams: ceilingLb === null || pricingBasis !== "pallet_count"
            ? null
            : Math.round(ceilingLb * GRAMS_PER_POUND),
          rateCents: Math.round(rate * 100),
        });
      }
      previousMaximum = maximum;
    }
    for (const destination of groupDestinations(group)) {
      for (const band of emittable) {
        rows.push({
          originWarehouseId: group.originWarehouseId,
          destinationCountry: "US",
          destinationRegion: destination.region,
          postalPrefix: destination.prefix,
          ...band,
        });
      }
    }
  }
  return rows;
}

function groupDestinations(group: RateGroup): Array<{ region: string; prefix: string | null }> {
  return [
    ...group.regions.map((region) => ({ region, prefix: null as string | null })),
    ...group.zipEntries.flatMap((entry) =>
      entry.prefixes.map((prefix) => ({ region: entry.state, prefix }))),
  ];
}

function dedupeIssues(issues: GroupIssue[]): GroupIssue[] {
  const seen = new Set<string>();
  return issues.filter((issue) => {
    const key = `${issue.groupId}|${issue.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ---------------------------------------------------------------------------
// Row → group reconstruction (legacy drafts and revision cloning)
// ---------------------------------------------------------------------------

export function groupsFromRows(
  rows: DraftRow[],
  pricingBasis: PricingBasis,
): RateGroup[] {
  const byGeography = new Map<string, DraftRow[]>();
  for (const row of rows) {
    const key = `${row.originWarehouseId ?? "any"}|${row.destinationRegion}|${row.postalPrefix ?? ""}`;
    byGeography.set(key, [...(byGeography.get(key) ?? []), row]);
  }

  const bySchedule = new Map<string, {
    originWarehouseId: number | null;
    bands: BuilderBand[];
    regions: string[];
    zipEntries: ZipEntry[];
  }>();
  for (const [geography, geographyRows] of byGeography) {
    const sorted = [...geographyRows].sort((a, b) => a.minMeasure - b.minMeasure);
    const schedule = sorted.map((row) => ({
      maxMeasure: row.maxMeasure,
      maxShipmentWeightGrams: row.maxShipmentWeightGrams,
      rateCents: row.rateCents,
    }));
    const [warehouseScope, state, prefix] = geography.split("|");
    const originWarehouseId = warehouseScope === "any" ? null : Number(warehouseScope);
    const signature = JSON.stringify({ originWarehouseId, schedule });
    const current = bySchedule.get(signature) ?? {
      originWarehouseId,
      bands: sorted.map((row) => ({
        id: newId(),
        maxMeasure: pricingBasis === "pallet_count"
          ? String(row.maxMeasure)
          : String(Number((row.maxMeasure / GRAMS_PER_POUND).toFixed(3))),
        rateUsd: (row.rateCents / 100).toFixed(2),
        maxShipmentWeightLb: row.maxShipmentWeightGrams === null
          ? ""
          : String(Number((row.maxShipmentWeightGrams / GRAMS_PER_POUND).toFixed(1))),
      })),
      regions: [],
      zipEntries: [],
    };
    if (!prefix) {
      current.regions.push(state);
    } else {
      const existing = current.zipEntries.find((entry) => entry.state === state);
      if (existing) existing.prefixes.push(prefix);
      else current.zipEntries.push({ id: newId(), state, prefixes: [prefix] });
    }
    bySchedule.set(signature, current);
  }

  return [...bySchedule.values()].map((group) => ({
    id: newId(),
    name: "",
    ...group,
  }));
}

// ---------------------------------------------------------------------------
// Draft layout persistence (exact editor state round-trip via table metadata)
// ---------------------------------------------------------------------------

export interface DraftLayout {
  version: 1;
  groups: Array<{
    name: string;
    originWarehouseId: number | null;
    regions: string[];
    zipEntries: Array<{ state: string; prefixes: string[] }>;
    bands: Array<{ maxMeasure: string; rateUsd: string; maxShipmentWeightLb: string }>;
  }>;
}

export function layoutFromGroups(groups: RateGroup[]): DraftLayout {
  return {
    version: 1,
    groups: groups.map((group) => ({
      name: group.name.trim().slice(0, 120),
      originWarehouseId: group.originWarehouseId,
      regions: [...group.regions],
      zipEntries: group.zipEntries.map((entry) => ({
        state: entry.state,
        prefixes: [...entry.prefixes],
      })),
      bands: group.bands.map((band) => ({
        maxMeasure: band.maxMeasure.slice(0, 20),
        rateUsd: band.rateUsd.slice(0, 20),
        maxShipmentWeightLb: band.maxShipmentWeightLb.slice(0, 20),
      })),
    })),
  };
}

/** Rehydrate editor groups from persisted metadata; null when absent/foreign. */
export function groupsFromLayout(metadata: unknown): RateGroup[] | null {
  if (!metadata || typeof metadata !== "object") return null;
  const layout = (metadata as { draftLayout?: unknown }).draftLayout;
  if (!layout || typeof layout !== "object") return null;
  const typed = layout as Partial<DraftLayout>;
  if (typed.version !== 1 || !Array.isArray(typed.groups)) return null;
  try {
    return typed.groups.map((group) => ({
      id: newId(),
      name: typeof group.name === "string" ? group.name : "",
      originWarehouseId: typeof group.originWarehouseId === "number" ? group.originWarehouseId : null,
      regions: Array.isArray(group.regions)
        ? group.regions.filter((region): region is string => typeof region === "string")
        : [],
      zipEntries: Array.isArray(group.zipEntries)
        ? group.zipEntries.map((entry) => ({
            id: newId(),
            state: String(entry.state ?? ""),
            prefixes: Array.isArray(entry.prefixes) ? entry.prefixes.map(String) : [],
          }))
        : [],
      bands: Array.isArray(group.bands) && group.bands.length > 0
        ? group.bands.map((band) => ({
            id: newId(),
            maxMeasure: String(band.maxMeasure ?? ""),
            rateUsd: String(band.rateUsd ?? ""),
            maxShipmentWeightLb: String(band.maxShipmentWeightLb ?? ""),
          }))
        : [{ id: newId(), maxMeasure: "", rateUsd: "", maxShipmentWeightLb: "" }],
    }));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// CSV (business-unit dialects; parsing itself stays on the server)
// ---------------------------------------------------------------------------

export const PARCEL_CSV_HEADER = "state,zip_prefix,min_lb,max_lb,rate_usd";
export const FREIGHT_CSV_HEADER = "state,zip_prefix,min_pallets,max_pallets,max_total_lb,rate_usd";

export const PARCEL_CSV_TEMPLATE = [
  PARCEL_CSV_HEADER,
  "PA,,0,1,8.99",
  "PA,,1.001,5,11.99",
  "PA,160,0,1,7.99",
].join("\n");

export const FREIGHT_CSV_TEMPLATE = [
  FREIGHT_CSV_HEADER,
  "PA,,1,1,2500,189.00",
  "PA,,2,4,,299.00",
].join("\n");

/**
 * Serialize rows in the same business units the import accepts. Warehouse
 * scope has no CSV column (imports are all-warehouse; scope is set per group
 * in the editor), so scoped rows carry a trailing origin_warehouse column
 * that the importer deliberately ignores — the preview calls this out.
 */
export function serializeRowsToCsv(
  rows: readonly DraftRow[],
  pricingBasis: PricingBasis,
  warehouseNames: ReadonlyMap<number, string> = new Map(),
): string {
  const hasWarehouseRows = rows.some((row) => row.originWarehouseId !== null);
  const header = pricingBasis === "pallet_count" ? FREIGHT_CSV_HEADER : PARCEL_CSV_HEADER;
  const lines: string[] = [hasWarehouseRows ? `${header},origin_warehouse` : header];
  const sorted = [...rows].sort((a, b) =>
    a.destinationRegion.localeCompare(b.destinationRegion)
    || (a.postalPrefix ?? "").localeCompare(b.postalPrefix ?? "")
    || (a.originWarehouseId ?? 0) - (b.originWarehouseId ?? 0)
    || a.minMeasure - b.minMeasure);
  for (const row of sorted) {
    const cells = pricingBasis === "pallet_count"
      ? [
          row.destinationRegion,
          row.postalPrefix ?? "",
          String(row.minMeasure),
          String(row.maxMeasure),
          row.maxShipmentWeightGrams === null ? "" : poundsFromGrams(row.maxShipmentWeightGrams),
          (row.rateCents / 100).toFixed(2),
        ]
      : [
          row.destinationRegion,
          row.postalPrefix ?? "",
          poundsFromGrams(row.minMeasure),
          poundsFromGrams(row.maxMeasure),
          (row.rateCents / 100).toFixed(2),
        ];
    if (hasWarehouseRows) {
      cells.push(row.originWarehouseId === null
        ? ""
        : warehouseNames.get(row.originWarehouseId) ?? String(row.originWarehouseId));
    }
    lines.push(cells.join(","));
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Revision diff (current draft/table vs the live revision)
// ---------------------------------------------------------------------------

export interface RateRowChange {
  scopeLabel: string;
  bandLabel: string;
  fromCents: number;
  toCents: number;
}

export interface RateTableDiff {
  addedBands: number;
  removedBands: number;
  /** Total bands whose price changed (examples below are capped). */
  changedCount: number;
  changedRates: RateRowChange[];
  addedScopes: string[];
  removedScopes: string[];
  identical: boolean;
}

const DIFF_EXAMPLE_LIMIT = 25;

export function diffRateRows(
  nextRows: readonly DraftRow[],
  activeRows: readonly DraftRow[],
  pricingBasis: PricingBasis,
): RateTableDiff {
  const bandKey = (row: DraftRow) => [
    row.originWarehouseId ?? "any",
    row.destinationRegion,
    row.postalPrefix ?? "",
    row.minMeasure,
    row.maxMeasure,
    row.maxShipmentWeightGrams ?? "",
  ].join("|");
  const scopeKey = (row: DraftRow) =>
    `${row.originWarehouseId ?? "any"}|${row.destinationRegion}|${row.postalPrefix ?? ""}`;

  const nextByBand = new Map(nextRows.map((row) => [bandKey(row), row]));
  const activeByBand = new Map(activeRows.map((row) => [bandKey(row), row]));

  let addedBands = 0;
  let removedBands = 0;
  let changedCount = 0;
  const changedRates: RateRowChange[] = [];
  for (const [key, row] of nextByBand) {
    const previous = activeByBand.get(key);
    if (!previous) {
      addedBands += 1;
    } else if (previous.rateCents !== row.rateCents) {
      changedCount += 1;
      if (changedRates.length < DIFF_EXAMPLE_LIMIT) {
        changedRates.push({
          scopeLabel: describeScope(row),
          bandLabel: describeMeasureRange(pricingBasis, row.minMeasure, row.maxMeasure),
          fromCents: previous.rateCents,
          toCents: row.rateCents,
        });
      }
    }
  }
  for (const key of activeByBand.keys()) {
    if (!nextByBand.has(key)) removedBands += 1;
  }

  const nextScopes = new Set(nextRows.map(scopeKey));
  const activeScopes = new Set(activeRows.map(scopeKey));
  const addedScopes = [...nextScopes].filter((scope) => !activeScopes.has(scope))
    .map(describeScopeKey).sort();
  const removedScopes = [...activeScopes].filter((scope) => !nextScopes.has(scope))
    .map(describeScopeKey).sort();

  return {
    addedBands,
    removedBands,
    changedCount,
    changedRates,
    addedScopes,
    removedScopes,
    identical: addedBands === 0 && removedBands === 0 && changedCount === 0,
  };
}

function describeScope(row: DraftRow): string {
  const geography = row.postalPrefix === null
    ? `${row.destinationRegion} statewide`
    : `${row.destinationRegion} ZIP ${row.postalPrefix}*`;
  return row.originWarehouseId === null ? geography : `${geography} (warehouse-specific)`;
}

function describeScopeKey(scope: string): string {
  const [warehouse, state, prefix] = scope.split("|");
  const geography = prefix === "" ? `${state} statewide` : `${state} ZIP ${prefix}*`;
  return warehouse === "any" ? geography : `${geography} (warehouse-specific)`;
}

// ---------------------------------------------------------------------------
// File download helper (CSV export + templates)
// ---------------------------------------------------------------------------

export function downloadTextFile(filename: string, contents: string): void {
  const blob = new Blob([contents], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
