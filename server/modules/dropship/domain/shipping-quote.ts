import { DropshipError } from "./errors";
import {
  cartonize,
  isCartonizeCandidateVerified,
  type CartonizeBox,
  type CartonizeItem,
  type CartonPlacement,
} from "../../cartonization/domain/cartonize";

export const DROPSHIP_DEFAULT_SHIPPING_CURRENCY = "USD";
export const DROPSHIP_DEFAULT_SHIPPING_MARKUP_BPS = 0;

/**
 * Warning code emitted when a quote completes with degraded packaging:
 * a variant is missing dims, no active box fits, or no boxes are configured.
 * The quote still prices (weight-based) and order acceptance continues; ops
 * surfaces list these so a human can pack the box and fix the data.
 */
export const DROPSHIP_PACKAGING_DATA_INCOMPLETE = "PACKAGING_DATA_INCOMPLETE" as const;

export interface DropshipPackagingWarning {
  code: typeof DROPSHIP_PACKAGING_DATA_INCOMPLETE;
  reason: "missing_dims" | "no_boxes_configured" | "no_box_fits";
  productVariantIds: number[];
  message: string;
}

export interface DropshipShippingDestination {
  country: string;
  region?: string;
  postalCode: string;
}

export interface NormalizedDropshipShippingDestination {
  country: string;
  region: string | null;
  postalCode: string;
}

export interface DropshipShippingQuoteItem {
  productVariantId: number;
  quantity: number;
}

export interface NormalizedDropshipShippingQuoteItem extends DropshipShippingQuoteItem {}

/**
 * Physical facts come from catalog.product_variants (canonical). Channel
 * defaults (carrier/service/box) come from dropship.dropship_package_profiles.
 * Dims may be null — that degrades packaging to weight-only, it does not
 * block quoting. Weight may NOT be null: the current rate engine cannot
 * price without it, so a missing weight remains a hard data error.
 */
export interface DropshipPackageProfile {
  productVariantId: number;
  sku: string | null;
  weightGrams: number | null;
  lengthMm: number | null;
  widthMm: number | null;
  heightMm: number | null;
  shippingGroupCode: string | null;
  shipsInOwnContainer: boolean;
  maxUnitsPerPackage: number | null;
  defaultCarrier: string | null;
  defaultService: string | null;
  defaultBoxId: number | null;
}

export interface DropshipBoxCatalogEntry {
  id: number;
  code: string;
  name: string;
  lengthMm: number;
  widthMm: number;
  heightMm: number;
  tareWeightGrams: number;
  maxWeightGrams: number | null;
  isActive: boolean;
}

export interface DropshipCartonizedPackage {
  packageSequence: number;
  items: DropshipCartonizedPackageItem[];
  placements: CartonPlacement[];
  productVariantId: number | null;
  quantity: number;
  /** Null on weight-only degraded packages (no box selected). */
  boxId: number | null;
  boxCode: string | null;
  weightGrams: number;
  /** Null on weight-only degraded packages (dims unknown). */
  lengthMm: number | null;
  widthMm: number | null;
  heightMm: number | null;
  requestedCarrier: string | null;
  requestedService: string | null;
}

export interface DropshipCartonizedPackageItem {
  productVariantId: number;
  quantity: number;
}

interface DropshipPackingBatchLine {
  profile: DropshipPackageProfile;
  quantity: number;
}

interface DropshipPackingBatch {
  lines: DropshipPackingBatchLine[];
  requestedCarrier: string | null;
  requestedService: string | null;
  defaultBoxId: number | null;
}

export interface DropshipCartonizeResult {
  packages: DropshipCartonizedPackage[];
  warnings: DropshipPackagingWarning[];
}

export interface DropshipPercentageFeePolicy {
  bps: number;
  fixedCents?: number;
  minCents?: number | null;
  maxCents?: number | null;
}

export function normalizeDropshipShippingDestination(
  destination: DropshipShippingDestination,
): NormalizedDropshipShippingDestination {
  const country = destination.country.trim().toUpperCase();
  const postalCode = destination.postalCode.trim().toUpperCase();
  const region = destination.region?.trim().toUpperCase() || null;

  if (!/^[A-Z]{2}$/.test(country)) {
    throw new DropshipError(
      "DROPSHIP_SHIPPING_INVALID_DESTINATION",
      "Shipping destination country must be a two-letter country code.",
      { country: destination.country },
    );
  }

  if (!postalCode) {
    throw new DropshipError(
      "DROPSHIP_SHIPPING_INVALID_DESTINATION",
      "Shipping destination postal code is required.",
    );
  }

  return { country, region, postalCode };
}

export function normalizeDropshipQuoteItems(
  items: readonly DropshipShippingQuoteItem[],
): NormalizedDropshipShippingQuoteItem[] {
  const quantityByVariantId = new Map<number, number>();
  for (const item of items) {
    quantityByVariantId.set(
      item.productVariantId,
      (quantityByVariantId.get(item.productVariantId) ?? 0) + item.quantity,
    );
  }

  return [...quantityByVariantId.entries()]
    .sort(([leftVariantId], [rightVariantId]) => leftVariantId - rightVariantId)
    .map(([productVariantId, quantity]) => ({ productVariantId, quantity }));
}

export function cartonizeDropshipItems(input: {
  items: readonly NormalizedDropshipShippingQuoteItem[];
  packageProfiles: readonly DropshipPackageProfile[];
  boxes: readonly DropshipBoxCatalogEntry[];
}): DropshipCartonizeResult {
  const activeBoxes = input.boxes.filter((box) => box.isActive);
  const warnings: DropshipPackagingWarning[] = [];

  const profilesByVariantId = new Map(
    input.packageProfiles.map((profile) => [profile.productVariantId, profile]),
  );
  const batches: DropshipPackingBatch[] = [];
  const compatibleBatches = new Map<string, DropshipPackingBatch>();

  for (const item of input.items) {
    const profile = profilesByVariantId.get(item.productVariantId);
    // Missing weight is the one hard stop: the rate engine prices from
    // weight, so a variant without weight is a data bug, not a packaging gap.
    // A missing profile row means the variant row itself was not found, or
    // its weight is null/non-positive — both are catalog data errors.
    if (!profile || !hasPositiveValue(profile.weightGrams)) {
      throw new DropshipError(
        "DROPSHIP_CATALOG_PACKAGE_DATA_REQUIRED",
        "Catalog variant weight is required before quoting shipping.",
        { productVariantId: item.productVariantId },
      );
    }

    if (profile.shipsInOwnContainer) {
      for (let unit = 0; unit < item.quantity; unit += 1) {
        batches.push({
          lines: [{ profile, quantity: 1 }],
          requestedCarrier: profile.defaultCarrier,
          requestedService: profile.defaultService,
          defaultBoxId: profile.defaultBoxId,
        });
      }
      continue;
    }

    const compatibilityKey = JSON.stringify([
      profile.defaultCarrier,
      profile.defaultService,
      profile.defaultBoxId,
    ]);
    let batch = compatibleBatches.get(compatibilityKey);
    if (!batch) {
      batch = {
        lines: [],
        requestedCarrier: profile.defaultCarrier,
        requestedService: profile.defaultService,
        defaultBoxId: profile.defaultBoxId,
      };
      compatibleBatches.set(compatibilityKey, batch);
      batches.push(batch);
    }
    batch.lines.push({ profile, quantity: item.quantity });
  }

  const packages: DropshipCartonizedPackage[] = [];
  for (const batch of batches) {
    const linesWithDims = batch.lines.filter(({ profile }) => hasCompleteDims(profile));
    const linesMissingDims = batch.lines.filter(({ profile }) => !hasCompleteDims(profile));

    // Variants without complete dims cannot be physically placed. They ride
    // as weight-only packages with a warning instead of blocking the quote.
    if (linesMissingDims.length > 0) {
      warnings.push({
        code: DROPSHIP_PACKAGING_DATA_INCOMPLETE,
        reason: "missing_dims",
        productVariantIds: sortedVariantIds(linesMissingDims),
        message: "One or more variants are missing catalog dimensions; quoted as weight-only packages.",
      });
      packages.push(buildWeightOnlyPackage(packages.length + 1, linesMissingDims, batch));
    }

    if (linesWithDims.length === 0) {
      continue;
    }

    if (activeBoxes.length === 0) {
      warnings.push({
        code: DROPSHIP_PACKAGING_DATA_INCOMPLETE,
        reason: "no_boxes_configured",
        productVariantIds: sortedVariantIds(linesWithDims),
        message: "No active dropship boxes are configured; quoted as weight-only packages.",
      });
      packages.push(buildWeightOnlyPackage(packages.length + 1, linesWithDims, batch));
      continue;
    }

    const dimmedBatch: DropshipPackingBatch = { ...batch, lines: linesWithDims };
    const eligibleBoxes = resolveEligibleDropshipBoxes(dimmedBatch, activeBoxes);
    const packing = cartonize(
      dimmedBatch.lines.map(({ profile, quantity }) =>
        mapDropshipProfileToCartonizeItem(profile, quantity)),
      eligibleBoxes.map(mapDropshipBoxToCartonizeBox),
      { allowRiders: false },
    );
    const candidate = packing.candidates[0];
    if (!isCartonizeCandidateVerified(candidate) || candidate.parcels.some((parcel) =>
      parcel.boxId === null)) {
      warnings.push({
        code: DROPSHIP_PACKAGING_DATA_INCOMPLETE,
        reason: "no_box_fits",
        productVariantIds: sortedVariantIds(dimmedBatch.lines),
        message: "No active dropship box can physically pack every ordered unit; quoted as weight-only packages.",
      });
      packages.push(buildWeightOnlyPackage(packages.length + 1, dimmedBatch.lines, batch));
      continue;
    }

    for (const parcel of candidate.parcels) {
      const cartonItems = parcel.items.map((line) => ({
        productVariantId: line.productVariantId,
        quantity: line.quantity,
      }));
      packages.push({
        packageSequence: packages.length + 1,
        items: cartonItems,
        placements: parcel.placements.map((placement) => ({ ...placement })),
        productVariantId: cartonItems.length === 1 ? cartonItems[0].productVariantId : null,
        quantity: cartonItems.reduce((sum, line) => sum + line.quantity, 0),
        boxId: parcel.boxId as number,
        boxCode: parcel.boxCode as string,
        weightGrams: parcel.estWeightGrams,
        lengthMm: parcel.lengthMm,
        widthMm: parcel.widthMm,
        heightMm: parcel.heightMm,
        requestedCarrier: batch.requestedCarrier,
        requestedService: batch.requestedService,
      });
    }
  }

  // Deterministic ordering: resequence after all appends so packageSequence
  // is stable regardless of degradation path.
  packages.forEach((carton, index) => {
    carton.packageSequence = index + 1;
  });

  return { packages, warnings };
}

export function calculateBasisPointsFeeCents(
  basisCents: number,
  policy: DropshipPercentageFeePolicy,
): number {
  assertNonNegativeSafeInteger("basisCents", basisCents);
  assertNonNegativeSafeInteger("bps", policy.bps);
  const fixedCents = policy.fixedCents ?? 0;
  assertNonNegativeSafeInteger("fixedCents", fixedCents);

  let feeCents = Number((BigInt(basisCents) * BigInt(policy.bps)) / BigInt(10000)) + fixedCents;
  if (policy.minCents !== null && policy.minCents !== undefined) {
    assertNonNegativeSafeInteger("minCents", policy.minCents);
    feeCents = Math.max(feeCents, policy.minCents);
  }
  if (policy.maxCents !== null && policy.maxCents !== undefined) {
    assertNonNegativeSafeInteger("maxCents", policy.maxCents);
    feeCents = Math.min(feeCents, policy.maxCents);
  }
  return feeCents;
}

function hasPositiveValue(value: number | null): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function hasCompleteDims(profile: DropshipPackageProfile): boolean {
  return hasPositiveValue(profile.lengthMm)
    && hasPositiveValue(profile.widthMm)
    && hasPositiveValue(profile.heightMm);
}

function sortedVariantIds(lines: readonly DropshipPackingBatchLine[]): number[] {
  return [...new Set(lines.map((line) => line.profile.productVariantId))].sort((a, b) => a - b);
}

/**
 * Weight-only degraded package: no box, no dims, weight = Σ(item weights).
 * The rate engine prices from weight, so these remain priceable; the
 * packaging gap surfaces as a PACKAGING_DATA_INCOMPLETE warning instead of
 * an exception.
 */
function buildWeightOnlyPackage(
  packageSequence: number,
  lines: readonly DropshipPackingBatchLine[],
  batch: DropshipPackingBatch,
): DropshipCartonizedPackage {
  const items = lines.map(({ profile, quantity }) => ({
    productVariantId: profile.productVariantId,
    quantity,
  }));
  const weightGrams = lines.reduce(
    (sum, { profile, quantity }) => sum + (profile.weightGrams as number) * quantity,
    0,
  );
  return {
    packageSequence,
    items,
    placements: [],
    productVariantId: items.length === 1 ? items[0].productVariantId : null,
    quantity: items.reduce((sum, line) => sum + line.quantity, 0),
    boxId: null,
    boxCode: null,
    weightGrams,
    lengthMm: null,
    widthMm: null,
    heightMm: null,
    requestedCarrier: batch.requestedCarrier,
    requestedService: batch.requestedService,
  };
}

function resolveEligibleDropshipBoxes(
  batch: DropshipPackingBatch,
  activeBoxes: readonly DropshipBoxCatalogEntry[],
): DropshipBoxCatalogEntry[] {
  if (batch.defaultBoxId === null) return [...activeBoxes];
  const requestedBox = activeBoxes.find((box) => box.id === batch.defaultBoxId);
  if (!requestedBox) {
    throw new DropshipError(
      "DROPSHIP_PACKAGE_PROFILE_BOX_REQUIRED",
      "Configured dropship package profile default box is not active.",
      {
        productVariantIds: batch.lines.map((line) => line.profile.productVariantId),
        defaultBoxId: batch.defaultBoxId,
      },
    );
  }
  return [requestedBox];
}

function mapDropshipProfileToCartonizeItem(
  profile: DropshipPackageProfile,
  quantity: number,
): CartonizeItem {
  return {
    productVariantId: profile.productVariantId,
    sku: profile.sku,
    quantity,
    weightGrams: profile.weightGrams as number,
    lengthMm: profile.lengthMm as number,
    widthMm: profile.widthMm as number,
    heightMm: profile.heightMm as number,
    shippingGroupCode: profile.shippingGroupCode,
    shipsInOwnContainer: false,
    riderEligible: false,
    riderVoidCm3: null,
    riderVoidMaxWeightGrams: null,
    riderVoidMaxItems: null,
  };
}

function mapDropshipBoxToCartonizeBox(
  box: DropshipBoxCatalogEntry,
): CartonizeBox {
  return {
    id: box.id,
    code: box.code,
    kind: "box",
    lengthMm: box.lengthMm,
    widthMm: box.widthMm,
    heightMm: box.heightMm,
    tareWeightGrams: box.tareWeightGrams,
    maxWeightGrams: box.maxWeightGrams,
    costCents: 0,
    fillFactorBps: 10_000,
    isActive: box.isActive,
  };
}

function assertNonNegativeSafeInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new DropshipError(
      "DROPSHIP_SHIPPING_INVALID_MONEY_INPUT",
      "Shipping money calculations require non-negative safe integer cents.",
      { field: name, value },
    );
  }
}
