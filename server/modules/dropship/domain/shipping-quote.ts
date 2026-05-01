import { DropshipError } from "./errors";

export const DROPSHIP_DEFAULT_SHIPPING_CURRENCY = "USD";
export const DROPSHIP_DEFAULT_SHIPPING_MARKUP_BPS = 0;

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

export interface DropshipPackageProfile {
  productVariantId: number;
  weightGrams: number;
  lengthMm: number;
  widthMm: number;
  heightMm: number;
  shipAlone: boolean;
  defaultCarrier: string | null;
  defaultService: string | null;
  defaultBoxId: number | null;
  maxUnitsPerPackage: number | null;
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
  productVariantId: number;
  quantity: number;
  boxId: number;
  boxCode: string;
  weightGrams: number;
  lengthMm: number;
  widthMm: number;
  heightMm: number;
  requestedCarrier: string | null;
  requestedService: string | null;
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
}): DropshipCartonizedPackage[] {
  const activeBoxes = input.boxes
    .filter((box) => box.isActive)
    .sort(compareBoxesForSelection);
  if (activeBoxes.length === 0) {
    throw new DropshipError(
      "DROPSHIP_BOX_CATALOG_REQUIRED",
      "At least one active dropship box or mailer is required to quote shipping.",
    );
  }

  const profilesByVariantId = new Map(
    input.packageProfiles.map((profile) => [profile.productVariantId, profile]),
  );
  const packages: DropshipCartonizedPackage[] = [];

  for (const item of input.items) {
    const profile = profilesByVariantId.get(item.productVariantId);
    if (!profile) {
      throw new DropshipError(
        "DROPSHIP_PACKAGE_PROFILE_REQUIRED",
        "Dropship package profile is required before quoting shipping.",
        { productVariantId: item.productVariantId },
      );
    }

    let remaining = item.quantity;
    while (remaining > 0) {
      const targetUnits = profile.shipAlone
        ? 1
        : Math.min(profile.maxUnitsPerPackage ?? remaining, remaining);
      const carton = findCartonForUnits({
        profile,
        activeBoxes,
        targetUnits,
      });

      packages.push({
        packageSequence: packages.length + 1,
        productVariantId: item.productVariantId,
        quantity: carton.quantity,
        boxId: carton.box.id,
        boxCode: carton.box.code,
        weightGrams: carton.weightGrams,
        lengthMm: carton.box.lengthMm,
        widthMm: carton.box.widthMm,
        heightMm: carton.box.heightMm,
        requestedCarrier: profile.defaultCarrier,
        requestedService: profile.defaultService,
      });
      remaining -= carton.quantity;
    }
  }

  return packages;
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

function findCartonForUnits(input: {
  profile: DropshipPackageProfile;
  activeBoxes: readonly DropshipBoxCatalogEntry[];
  targetUnits: number;
}): { box: DropshipBoxCatalogEntry; quantity: number; weightGrams: number } {
  let quantity = input.targetUnits;
  while (quantity > 0) {
    const weightGrams = input.profile.weightGrams * quantity;
    const box = selectBoxForPackage({
      profile: input.profile,
      activeBoxes: input.activeBoxes,
      packageWeightGrams: weightGrams,
    });
    if (box) {
      return {
        box,
        quantity,
        weightGrams: weightGrams + box.tareWeightGrams,
      };
    }
    quantity -= 1;
  }

  throw new DropshipError(
    "DROPSHIP_CARTONIZATION_BLOCKED",
    "No active dropship box can fit the SKU package profile.",
    { productVariantId: input.profile.productVariantId },
  );
}

function selectBoxForPackage(input: {
  profile: DropshipPackageProfile;
  activeBoxes: readonly DropshipBoxCatalogEntry[];
  packageWeightGrams: number;
}): DropshipBoxCatalogEntry | null {
  const requestedBox = input.profile.defaultBoxId
    ? input.activeBoxes.find((box) => box.id === input.profile.defaultBoxId)
    : null;

  if (input.profile.defaultBoxId && !requestedBox) {
    throw new DropshipError(
      "DROPSHIP_PACKAGE_PROFILE_BOX_REQUIRED",
      "Configured dropship package profile default box is not active.",
      {
        productVariantId: input.profile.productVariantId,
        defaultBoxId: input.profile.defaultBoxId,
      },
    );
  }

  if (requestedBox) {
    return boxFitsPackage(requestedBox, input.profile, input.packageWeightGrams)
      ? requestedBox
      : null;
  }

  return input.activeBoxes.find((box) => boxFitsPackage(
    box,
    input.profile,
    input.packageWeightGrams,
  )) ?? null;
}

function boxFitsPackage(
  box: DropshipBoxCatalogEntry,
  profile: DropshipPackageProfile,
  packageWeightGrams: number,
): boolean {
  const sortedBoxDims = [box.lengthMm, box.widthMm, box.heightMm].sort(sortAscending);
  const sortedProfileDims = [profile.lengthMm, profile.widthMm, profile.heightMm].sort(sortAscending);
  const dimensionsFit = sortedProfileDims.every((dimension, index) => dimension <= sortedBoxDims[index]);
  const packageWeightWithTare = packageWeightGrams + box.tareWeightGrams;
  const weightFits = box.maxWeightGrams === null || packageWeightWithTare <= box.maxWeightGrams;
  return dimensionsFit && weightFits;
}

function compareBoxesForSelection(
  left: DropshipBoxCatalogEntry,
  right: DropshipBoxCatalogEntry,
): number {
  const leftVolume = left.lengthMm * left.widthMm * left.heightMm;
  const rightVolume = right.lengthMm * right.widthMm * right.heightMm;
  return leftVolume - rightVolume
    || left.tareWeightGrams - right.tareWeightGrams
    || left.id - right.id;
}

function sortAscending(left: number, right: number): number {
  return left - right;
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
