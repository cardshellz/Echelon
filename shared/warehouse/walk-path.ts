export interface WalkPathLocationInput {
  id?: number | string | null;
  sku?: string | null;
  code?: string | null;
  zone?: string | null;
  aisle?: string | null;
  bay?: string | null;
  level?: string | null;
  bin?: string | null;
  isUnassigned?: boolean;
}

export interface NormalizedWalkPathKey {
  unassignedRank: 0 | 1;
  zone: string;
  aisle: string;
  bay: string;
  level: string;
  bin: string;
  code: string;
  sku: string;
  id: string;
}

const NATURAL_COLLATOR = new Intl.Collator("en", {
  numeric: true,
  sensitivity: "base",
});

const UNASSIGNED_CODES = new Set([
  "",
  "-",
  "U",
  "UNASSIGNED",
  "NONE",
  "N/A",
  "UNKNOWN",
  "CONFIRM",
  "CONFIRMATION_ONLY",
]);

const KNOWN_ZONE_PREFIXES = new Set([
  "FWD",
  "BULK",
  "RCV",
  "PACK",
  "SHIP",
  "PICK",
  "RES",
  "RESERVE",
  "STAGE",
  "STAGING",
]);

function cleanPart(value: string | null | undefined): string {
  if (value == null) return "";
  return String(value).trim().toUpperCase();
}

function normalizeNumericSegment(part: string): string {
  if (!part) return "";
  // Strip leading zeros on pure integer segments so "01" and "1" compare identically.
  if (/^\d+$/.test(part)) {
    return String(Number(part));
  }
  return part;
}

export function buildWalkPathKey(input: WalkPathLocationInput): NormalizedWalkPathKey {
  const rawCode = cleanPart(input.code);
  const rawZone = cleanPart(input.zone);
  const explicitAisle = cleanPart(input.aisle);
  const explicitBay = cleanPart(input.bay);
  const explicitLevel = cleanPart(input.level);
  const explicitBin = cleanPart(input.bin);
  const hasExplicitSubfields = Boolean(
    explicitAisle || explicitBay || explicitLevel || explicitBin,
  );

  const codeIsUnassigned = UNASSIGNED_CODES.has(rawCode);
  if (input.isUnassigned || (codeIsUnassigned && !hasExplicitSubfields)) {
    return {
      unassignedRank: 1,
      zone: "",
      aisle: "",
      bay: "",
      level: "",
      bin: "",
      code: rawCode,
      sku: cleanPart(input.sku),
      id: input.id == null ? "" : String(input.id),
    };
  }

  const effectiveZone =
    rawZone && !UNASSIGNED_CODES.has(rawZone) ? rawZone : "";

  if (hasExplicitSubfields) {
    return {
      unassignedRank: 0,
      zone: normalizeNumericSegment(effectiveZone),
      aisle: normalizeNumericSegment(explicitAisle),
      bay: normalizeNumericSegment(explicitBay),
      level: normalizeNumericSegment(explicitLevel),
      bin: normalizeNumericSegment(explicitBin),
      code: rawCode,
      sku: cleanPart(input.sku),
      id: input.id == null ? "" : String(input.id),
    };
  }

  // Parse structured bin code into Zone -> Aisle -> Bay -> Level -> Bin
  const segments = rawCode.split(/[-_\s/]+/).filter(Boolean);
  let zone = effectiveZone;
  let rest = segments;

  if (rest.length >= 2) {
    const first = rest[0];
    if (zone && first === zone) {
      rest = rest.slice(1);
    } else if (!zone && (rest.length >= 5 || KNOWN_ZONE_PREFIXES.has(first))) {
      zone = first;
      rest = rest.slice(1);
    }
  }

  const [aisle = "", bay = "", level = "", ...binRest] = rest;
  const bin = binRest.join("-");

  return {
    unassignedRank: 0,
    zone: normalizeNumericSegment(zone),
    aisle: normalizeNumericSegment(aisle),
    bay: normalizeNumericSegment(bay),
    level: normalizeNumericSegment(level),
    bin: normalizeNumericSegment(bin),
    code: rawCode,
    sku: cleanPart(input.sku),
    id: input.id == null ? "" : String(input.id),
  };
}

function compareSegment(a: string, b: string): number {
  if (a === b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  return NATURAL_COLLATOR.compare(a, b);
}

export function compareWalkPath(
  a: WalkPathLocationInput,
  b: WalkPathLocationInput,
): number {
  const ka = buildWalkPathKey(a);
  const kb = buildWalkPathKey(b);

  if (ka.unassignedRank !== kb.unassignedRank) {
    return ka.unassignedRank - kb.unassignedRank;
  }

  // Within assigned bins, an empty zone sorts consistently after named zones only when one has a zone and the other does not;
  // when both have zones (or neither does), compare naturally.
  const zoneCmp =
    ka.zone && kb.zone
      ? NATURAL_COLLATOR.compare(ka.zone, kb.zone)
      : ka.zone
        ? -1
        : kb.zone
          ? 1
          : 0;
  if (zoneCmp !== 0) return zoneCmp;

  for (const field of ["aisle", "bay", "level", "bin"] as const) {
    const cmp = compareSegment(ka[field], kb[field]);
    if (cmp !== 0) return cmp;
  }

  const codeCmp = NATURAL_COLLATOR.compare(ka.code, kb.code);
  if (codeCmp !== 0) return codeCmp;

  const skuCmp = NATURAL_COLLATOR.compare(ka.sku, kb.sku);
  if (skuCmp !== 0) return skuCmp;

  return NATURAL_COLLATOR.compare(ka.id, kb.id);
}

export function sortByWalkPath<T>(
  items: readonly T[],
  selector: (item: T) => WalkPathLocationInput,
): T[] {
  return [...items].sort((a, b) => compareWalkPath(selector(a), selector(b)));
}
