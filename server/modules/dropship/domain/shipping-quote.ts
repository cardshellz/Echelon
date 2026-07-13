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
  sku: string | null;
  weightGrams: number;
  lengthMm: number;
  widthMm: number;
  heightMm: number;
  shippingGroupCode: string | null;
  shipAlone: boolean;
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
  boxId: number;
  boxCode: string;
  weightGrams: number;
  lengthMm: number;
  widthMm: number;
  heightMm: number;
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
  const activeBoxes = input.boxes.filter((box) => box.isActive);
  if (activeBoxes.length === 0) {
    throw new DropshipError(
      "DROPSHIP_BOX_CATALOG_REQUIRED",
      "At least one active dropship box or mailer is required to quote shipping.",
    );
  }

  const profilesByVariantId = new Map(
    input.packageProfiles.map((profile) => [profile.productVariantId, profile]),
  );
  const batches: DropshipPackingBatch[] = [];
  const compatibleBatches = new Map<string, DropshipPackingBatch>();

  for (const item of input.items) {
    const profile = profilesByVariantId.get(item.productVariantId);
    if (!profile) {
      throw new DropshipError(
        "DROPSHIP_CATALOG_PACKAGE_DATA_REQUIRED",
        "Complete catalog variant weight and dimensions are required before quoting shipping.",
        { productVariantId: item.productVariantId },
      );
    }

    if (profile.shipAlone) {
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
    const eligibleBoxes = resolveEligibleDropshipBoxes(batch, activeBoxes);
    const packing = cartonize(
      batch.lines.map(({ profile, quantity }) =>
        mapDropshipProfileToCartonizeItem(profile, quantity)),
      eligibleBoxes.map(mapDropshipBoxToCartonizeBox),
      { allowRiders: false },
    );
    const candidate = packing.candidates[0];
    if (!isCartonizeCandidateVerified(candidate) || candidate.parcels.some((parcel) =>
      parcel.boxId === null)) {
      throw new DropshipError(
        "DROPSHIP_CARTONIZATION_BLOCKED",
        "No active dropship box can physically pack every ordered unit.",
        {
          items: batch.lines.map(({ profile, quantity }) => ({
            productVariantId: profile.productVariantId,
            quantity,
          })),
          warnings: candidate?.warnings ?? [],
        },
      );
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
    weightGrams: profile.weightGrams,
    lengthMm: profile.lengthMm,
    widthMm: profile.widthMm,
    heightMm: profile.heightMm,
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
