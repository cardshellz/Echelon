/** Shared cartonization core for every physical-order channel. */
import {
  pack3D,
  RotationType,
  type Item3D,
  type PackedItem3D,
} from "binpackingjs/3d";

/**
 * Cartonizer v3 — pure domain functions, no I/O.
 *
 * Turns order/cart items into candidate parcel packings against the
 * shipping.box_catalog. Design: docs/SHIPPING-ENGINE-DESIGN.md.
 *
 * Pipeline per request:
 *   1. SIOC items ship as their own parcels (their packaging IS the parcel).
 *   2. Remaining items partition by shipping group (groups never co-pack,
 *      except via the rider pass below).
 *   3. Each partition packs physical units into non-overlapping 3D placements.
 *   4. Optional rider pass: a parcel made entirely of rider-eligible items may be
 *      absorbed into a SIOC parcel's declared void space, but ONLY when that
 *      eliminates the donor parcel outright (kill-a-label-or-do-nothing).
 *
 * Contract: NEVER throws for data problems. Items that cannot be packed
 * (missing dims, nothing fits) degrade to fallback parcels with warnings —
 * a checkout rate request must always get an answer.
 */

export interface CartonizeItem {
  productVariantId: number;
  sku: string | null;
  quantity: number;
  weightGrams: number | null;
  lengthMm: number | null;
  widthMm: number | null;
  heightMm: number | null;
  shippingGroupCode: string | null;
  shipsInOwnContainer: boolean;
  riderEligible: boolean;
  riderVoidCm3: number | null;
  riderVoidMaxWeightGrams: number | null;
  riderVoidMaxItems: number | null;
}

export interface CartonizeBox {
  id: number;
  code: string;
  kind: "box" | "mailer" | "envelope";
  lengthMm: number;
  widthMm: number;
  heightMm: number;
  tareWeightGrams: number;
  maxWeightGrams: number | null;
  costCents: number;
  fillFactorBps: number;
  isActive: boolean;
}

export interface CartonizeOptions {
  /** Enable the rider/void consolidation pass. Default false until void dimensions are modeled. */
  allowRiders?: boolean;
  /** Dimensional-weight divisor in cm³ per kg. Default 5000 (carrier-agnostic). */
  dimDivisorCm3PerKg?: number;
}

export interface CartonParcelItem {
  productVariantId: number;
  sku: string | null;
  quantity: number;
  isRider: boolean;
}

export interface CartonPlacement {
  productVariantId: number;
  sku: string | null;
  unitSequence: number;
  orientation: CartonOrientation;
  xMm: number;
  yMm: number;
  zMm: number;
  lengthMm: number;
  widthMm: number;
  heightMm: number;
}

/** Original item axes mapped to the carton's length, width, and height axes. */
export type CartonOrientation = "LWH" | "WLH" | "WHL" | "HWL" | "HLW" | "LHW";

export interface CartonParcel {
  boxId: number | null;
  boxCode: string | null;
  siocProductVariantId: number | null;
  items: CartonParcelItem[];
  placements: CartonPlacement[];
  estWeightGrams: number;
  billableWeightGrams: number;
  lengthMm: number;
  widthMm: number;
  heightMm: number;
  shippingGroupCode: string | null;
  reason: string;
}

export interface CartonizeCandidate {
  strategy: "fewest-parcels" | "tightest-boxes" | "fallback";
  parcels: CartonParcel[];
  warnings: string[];
}

export interface CartonizeResult {
  candidates: CartonizeCandidate[];
  engine: { name: string; version: string };
}

export const CARTONIZE_ENGINE = { name: "cardshellz-cartonizer", version: "3.1.0" } as const;
export const MAX_MANUAL_CARTON_WEIGHT_GRAMS = 22_679;

const DEFAULT_DIM_DIVISOR_CM3_PER_KG = 5000;

type CompleteCartonizeItem = CartonizeItem & {
  weightGrams: number;
  lengthMm: number;
  widthMm: number;
  heightMm: number;
};

interface PackableItem {
  item: CompleteCartonizeItem;
  unitVolumeMm3: number;
  unitWeightGrams: number;
  sortedDims: [number, number, number];
}

interface PhysicalUnit {
  key: string;
  packable: PackableItem;
  unitSequence: number;
}

interface PackedPhysicalUnits {
  placements: CartonPlacement[];
}

interface OpenParcel {
  box: CartonizeBox;
  items: Map<number, CartonParcelItem>;
  units: PhysicalUnit[];
  placements: CartonPlacement[];
  usedVolumeMm3: number;
  contentWeightGrams: number;
  shippingGroupCode: string | null;
}

export function isCartonizeCandidateVerified(
  candidate: CartonizeCandidate | null | undefined,
): candidate is CartonizeCandidate {
  if (!candidate || candidate.strategy === "fallback" || candidate.parcels.length === 0) {
    return false;
  }

  return candidate.parcels.every((parcel) => {
    if (
      parcel.reason.startsWith("fallback")
      || !isPositiveFinite(parcel.lengthMm)
      || !isPositiveFinite(parcel.widthMm)
      || !isPositiveFinite(parcel.heightMm)
      || !isPositiveFinite(parcel.estWeightGrams)
    ) {
      return false;
    }

    const unplacedQuantityByVariant = new Map<number, number>();
    for (const line of parcel.items) {
      if (!Number.isSafeInteger(line.quantity) || line.quantity <= 0) return false;
      unplacedQuantityByVariant.set(
        line.productVariantId,
        (unplacedQuantityByVariant.get(line.productVariantId) ?? 0) + line.quantity,
      );
    }
    if (unplacedQuantityByVariant.size === 0) return false;

    const placementKeys = new Set<string>();
    for (const placement of parcel.placements) {
      if (!Number.isSafeInteger(placement.unitSequence) || placement.unitSequence <= 0) {
        return false;
      }
      const placementKey = `${placement.productVariantId}:${placement.unitSequence}`;
      if (placementKeys.has(placementKey)) return false;
      placementKeys.add(placementKey);
      const remaining = unplacedQuantityByVariant.get(placement.productVariantId) ?? 0;
      if (remaining <= 0) return false;
      unplacedQuantityByVariant.set(placement.productVariantId, remaining - 1);
    }

    return [...unplacedQuantityByVariant.values()].every((quantity) => quantity === 0)
      && placementsFitInCarton(
        parcel.placements,
        parcel.lengthMm,
        parcel.widthMm,
        parcel.heightMm,
      );
  });
}

function isPositiveFinite(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function placementsFitInCarton(
  placements: readonly CartonPlacement[],
  lengthMm: number,
  widthMm: number,
  heightMm: number,
): boolean {
  for (const placement of placements) {
    if (
      !Number.isFinite(placement.xMm)
      || !Number.isFinite(placement.yMm)
      || !Number.isFinite(placement.zMm)
      || !isPositiveFinite(placement.lengthMm)
      || !isPositiveFinite(placement.widthMm)
      || !isPositiveFinite(placement.heightMm)
      || placement.xMm < 0
      || placement.yMm < 0
      || placement.zMm < 0
      || placement.xMm + placement.lengthMm > lengthMm
      || placement.yMm + placement.widthMm > widthMm
      || placement.zMm + placement.heightMm > heightMm
    ) {
      return false;
    }
  }

  for (let leftIndex = 0; leftIndex < placements.length; leftIndex += 1) {
    const left = placements[leftIndex];
    for (let rightIndex = leftIndex + 1; rightIndex < placements.length; rightIndex += 1) {
      const right = placements[rightIndex];
      const separated = (
        left.xMm + left.lengthMm <= right.xMm
        || right.xMm + right.lengthMm <= left.xMm
        || left.yMm + left.widthMm <= right.yMm
        || right.yMm + right.widthMm <= left.yMm
        || left.zMm + left.heightMm <= right.zMm
        || right.zMm + right.heightMm <= left.zMm
      );
      if (!separated) return false;
    }
  }
  return true;
}

function sortedDims(l: number, w: number, h: number): [number, number, number] {
  const d = [l, w, h].sort((a, b) => a - b);
  return [d[0], d[1], d[2]];
}

function itemFitsBox(dims: [number, number, number], box: CartonizeBox): boolean {
  const b = sortedDims(box.lengthMm, box.widthMm, box.heightMm);
  return dims[0] <= b[0] && dims[1] <= b[1] && dims[2] <= b[2];
}

function boxUsableVolumeMm3(box: CartonizeBox): number {
  return box.lengthMm * box.widthMm * box.heightMm * (box.fillFactorBps / 10000);
}

function boxVolumeMm3(box: CartonizeBox): number {
  return box.lengthMm * box.widthMm * box.heightMm;
}

function effectiveMaxPackedWeightGrams(box: CartonizeBox): number {
  return Math.min(box.maxWeightGrams ?? MAX_MANUAL_CARTON_WEIGHT_GRAMS, MAX_MANUAL_CARTON_WEIGHT_GRAMS);
}

function makePhysicalUnits(
  packable: PackableItem,
  quantity: number,
  startingSequence = 1,
): PhysicalUnit[] {
  return Array.from({ length: quantity }, (_, index) => {
    const unitSequence = startingSequence + index;
    return {
      key: `${packable.item.productVariantId}:${unitSequence}`,
      packable,
      unitSequence,
    };
  });
}

function packPhysicalUnits(
  box: CartonizeBox,
  units: readonly PhysicalUnit[],
): PackedPhysicalUnits | null {
  const usedVolumeMm3 = units.reduce((sum, unit) => sum + unit.packable.unitVolumeMm3, 0);
  if (usedVolumeMm3 > boxUsableVolumeMm3(box)) return null;

  const maxContentWeightGrams = effectiveMaxPackedWeightGrams(box) - box.tareWeightGrams;
  const contentWeightGrams = units.reduce((sum, unit) => sum + unit.packable.unitWeightGrams, 0);
  if (maxContentWeightGrams <= 0 || contentWeightGrams > maxContentWeightGrams) return null;

  const unitsByKey = new Map(units.map((unit) => [unit.key, unit]));
  const libraryItems: Item3D[] = units.map((unit) => ({
    name: unit.key,
    width: unit.packable.item.lengthMm,
    height: unit.packable.item.widthMm,
    depth: unit.packable.item.heightMm,
    weight: unit.packable.unitWeightGrams,
  }));
  const result = pack3D({
    bins: [{
      name: String(box.id),
      width: box.lengthMm,
      height: box.widthMm,
      depth: box.heightMm,
      maxWeight: maxContentWeightGrams,
    }],
    items: libraryItems,
  });
  const packedItems = result.packedBins[0]?.items ?? [];
  if (result.unfitItems.length > 0 || packedItems.length !== units.length) return null;

  const placements = packedItems.map((packedItem) => mapCartonPlacement(packedItem, unitsByKey));
  return placementsFitInCarton(
    placements,
    box.lengthMm,
    box.widthMm,
    box.heightMm,
  ) ? { placements } : null;
}

function mapCartonPlacement(
  packedItem: PackedItem3D,
  unitsByKey: ReadonlyMap<string, PhysicalUnit>,
): CartonPlacement {
  const unit = unitsByKey.get(packedItem.name);
  if (!unit) {
    throw new Error(`Cartonizer placement ${packedItem.name} does not match an input unit.`);
  }
  return {
    productVariantId: unit.packable.item.productVariantId,
    sku: unit.packable.item.sku,
    unitSequence: unit.unitSequence,
    orientation: mapCartonOrientation(packedItem.rotationType),
    xMm: packedItem.position[0],
    yMm: packedItem.position[1],
    zMm: packedItem.position[2],
    lengthMm: packedItem.dimension[0],
    widthMm: packedItem.dimension[1],
    heightMm: packedItem.dimension[2],
  };
}

function mapCartonOrientation(rotationType: RotationType): CartonOrientation {
  switch (rotationType) {
    case RotationType.WHD: return "LWH";
    case RotationType.HWD: return "WLH";
    case RotationType.HDW: return "WHL";
    case RotationType.DHW: return "HWL";
    case RotationType.DWH: return "HLW";
    case RotationType.WDH: return "LHW";
  }
}

function billableWeightGrams(
  lengthMm: number, widthMm: number, heightMm: number,
  actualGrams: number, dimDivisorCm3PerKg: number,
): number {
  const volumeCm3 = (lengthMm * widthMm * heightMm) / 1000;
  const dimWeightGrams = Math.ceil((volumeCm3 / dimDivisorCm3PerKg) * 1000);
  return Math.max(actualGrams, dimWeightGrams);
}

function hasCompleteDims(item: CartonizeItem): item is CompleteCartonizeItem {
  return (
    item.weightGrams != null && item.weightGrams > 0
    && item.lengthMm != null && item.lengthMm > 0
    && item.widthMm != null && item.widthMm > 0
    && item.heightMm != null && item.heightMm > 0
  );
}

function siocParcel(item: CartonizeItem, dimDivisor: number): CartonParcel {
  const weight = item.weightGrams ?? 0;
  const l = item.lengthMm ?? 0, w = item.widthMm ?? 0, h = item.heightMm ?? 0;
  return {
    boxId: null,
    boxCode: null,
    siocProductVariantId: item.productVariantId,
    items: [{ productVariantId: item.productVariantId, sku: item.sku, quantity: 1, isRider: false }],
    placements: l > 0 && w > 0 && h > 0 ? [{
      productVariantId: item.productVariantId,
      sku: item.sku,
      unitSequence: 1,
      orientation: "LWH",
      xMm: 0,
      yMm: 0,
      zMm: 0,
      lengthMm: l,
      widthMm: w,
      heightMm: h,
    }] : [],
    estWeightGrams: weight,
    billableWeightGrams: l > 0 && w > 0 && h > 0 && weight > 0
      ? billableWeightGrams(l, w, h, weight, dimDivisor)
      : weight,
    lengthMm: l,
    widthMm: w,
    heightMm: h,
    shippingGroupCode: item.shippingGroupCode,
    reason: `ships in own container (${item.sku ?? item.productVariantId})`,
  };
}

function fallbackParcel(item: CartonizeItem, quantity: number, largestBox: CartonizeBox | null, dimDivisor: number): CartonParcel {
  const weight = (item.weightGrams ?? 0) * quantity;
  if (largestBox) {
    return {
      boxId: largestBox.id,
      boxCode: largestBox.code,
      siocProductVariantId: null,
      items: [{ productVariantId: item.productVariantId, sku: item.sku, quantity, isRider: false }],
      placements: [],
      estWeightGrams: weight + largestBox.tareWeightGrams,
      billableWeightGrams: billableWeightGrams(
        largestBox.lengthMm, largestBox.widthMm, largestBox.heightMm,
        weight + largestBox.tareWeightGrams, dimDivisor,
      ),
      lengthMm: largestBox.lengthMm,
      widthMm: largestBox.widthMm,
      heightMm: largestBox.heightMm,
      shippingGroupCode: item.shippingGroupCode,
      reason: `fallback: could not verify fit for ${item.sku ?? item.productVariantId}; assigned largest box`,
    };
  }
  return {
    boxId: null,
    boxCode: null,
    siocProductVariantId: item.productVariantId,
    items: [{ productVariantId: item.productVariantId, sku: item.sku, quantity, isRider: false }],
    placements: [],
    estWeightGrams: weight,
    billableWeightGrams: weight,
    lengthMm: item.lengthMm ?? 0,
    widthMm: item.widthMm ?? 0,
    heightMm: item.heightMm ?? 0,
    shippingGroupCode: item.shippingGroupCode,
    reason: `fallback: no active boxes available for ${item.sku ?? item.productVariantId}`,
  };
}

function additionalUnitsThatFit(
  parcel: OpenParcel,
  packable: PackableItem,
  maxQuantity: number,
): { units: PhysicalUnit[]; packing: PackedPhysicalUnits } | null {
  if (maxQuantity <= 0 || !itemFitsBox(packable.sortedDims, parcel.box)) return null;

  const existingQuantity = parcel.items.get(packable.item.productVariantId)?.quantity ?? 0;
  let low = 1;
  let high = maxQuantity;
  let best: { units: PhysicalUnit[]; packing: PackedPhysicalUnits } | null = null;
  while (low <= high) {
    const quantity = Math.floor((low + high) / 2);
    const units = makePhysicalUnits(packable, quantity, existingQuantity + 1);
    const packing = packPhysicalUnits(parcel.box, [...parcel.units, ...units]);
    if (packing) {
      best = { units, packing };
      low = quantity + 1;
    } else {
      high = quantity - 1;
    }
  }
  return best;
}

function addUnits(
  parcel: OpenParcel,
  packable: PackableItem,
  units: readonly PhysicalUnit[],
  packing: PackedPhysicalUnits,
): void {
  const quantity = units.length;
  const existing = parcel.items.get(packable.item.productVariantId);
  if (existing) {
    existing.quantity += quantity;
  } else {
    parcel.items.set(packable.item.productVariantId, {
      productVariantId: packable.item.productVariantId,
      sku: packable.item.sku,
      quantity,
      isRider: false,
    });
  }
  parcel.units.push(...units);
  parcel.placements = packing.placements;
  parcel.usedVolumeMm3 += packable.unitVolumeMm3 * quantity;
  parcel.contentWeightGrams += packable.unitWeightGrams * quantity;
}

function createOpenParcel(box: CartonizeBox, shippingGroupCode: string | null): OpenParcel {
  return {
    box,
    items: new Map(),
    units: [],
    placements: [],
    usedVolumeMm3: 0,
    contentWeightGrams: 0,
    shippingGroupCode,
  };
}

/**
 * After packing, try to move each parcel into the smallest box that still
 * holds its contents — greedy packing tends to leave the last box oversized.
 */
function downsize(parcel: OpenParcel, boxesByVolumeAsc: CartonizeBox[]): void {
  for (const box of boxesByVolumeAsc) {
    if (boxVolumeMm3(box) >= boxVolumeMm3(parcel.box)) break;
    const packing = packPhysicalUnits(box, parcel.units);
    if (packing) {
      parcel.box = box;
      parcel.placements = packing.placements;
      return;
    }
  }
}

function finalizeParcel(parcel: OpenParcel, dimDivisor: number, reason: string): CartonParcel {
  const est = parcel.contentWeightGrams + parcel.box.tareWeightGrams;
  return {
    boxId: parcel.box.id,
    boxCode: parcel.box.code,
    siocProductVariantId: null,
    items: [...parcel.items.values()],
    placements: parcel.placements.map((placement) => ({ ...placement })),
    estWeightGrams: est,
    billableWeightGrams: billableWeightGrams(
      parcel.box.lengthMm, parcel.box.widthMm, parcel.box.heightMm, est, dimDivisor,
    ),
    lengthMm: parcel.box.lengthMm,
    widthMm: parcel.box.widthMm,
    heightMm: parcel.box.heightMm,
    shippingGroupCode: parcel.shippingGroupCode,
    reason,
  };
}

function packPartition(
  groupCode: string | null,
  packables: PackableItem[],
  boxesByVolumeAsc: CartonizeBox[],
  strategy: "fewest-parcels" | "tightest-boxes",
  dimDivisor: number,
  warnings: string[],
): CartonParcel[] {
  const parcels: CartonParcel[] = [];
  const open: OpenParcel[] = [];
  const largestFirst = [...boxesByVolumeAsc].reverse();
  const byVolumeDesc = [...packables].sort((a, b) => b.unitVolumeMm3 - a.unitVolumeMm3);
  const allUnits = byVolumeDesc.flatMap((packable) =>
    makePhysicalUnits(packable, packable.item.quantity));

  // Single-box shortcut: the smallest box that can place every physical unit
  // without overlap under the configured clearance and weight limits.
  let singleBox: { box: CartonizeBox; packing: PackedPhysicalUnits } | null = null;
  for (const box of boxesByVolumeAsc) {
    const packing = packPhysicalUnits(box, allUnits);
    if (packing) {
      singleBox = { box, packing };
      break;
    }
  }

  if (singleBox) {
    const parcel = createOpenParcel(singleBox.box, groupCode);
    parcel.units = allUnits;
    parcel.placements = singleBox.packing.placements;
    for (const packable of byVolumeDesc) {
      parcel.items.set(packable.item.productVariantId, {
        productVariantId: packable.item.productVariantId,
        sku: packable.item.sku,
        quantity: packable.item.quantity,
        isRider: false,
      });
      parcel.usedVolumeMm3 += packable.unitVolumeMm3 * packable.item.quantity;
      parcel.contentWeightGrams += packable.unitWeightGrams * packable.item.quantity;
    }
    parcels.push(finalizeParcel(
      parcel,
      dimDivisor,
      `all ${groupCode ?? "ungrouped"} items fit one ${singleBox.box.code}`,
    ));
    return parcels;
  }

  for (const packable of byVolumeDesc) {
    let remaining = packable.item.quantity;

    // Fill existing open parcels first (both strategies).
    for (const parcel of open) {
      if (remaining <= 0) break;
      const addition = additionalUnitsThatFit(parcel, packable, remaining);
      if (addition) {
        addUnits(parcel, packable, addition.units, addition.packing);
        remaining -= addition.units.length;
      }
    }

    while (remaining > 0) {
      // fewest-parcels opens the biggest box (fewer labels); tightest-boxes
      // opens the smallest box the item fits (less air), then both downsize.
      const searchOrder = strategy === "fewest-parcels" ? largestFirst : boxesByVolumeAsc;
      let selected: {
        parcel: OpenParcel;
        addition: { units: PhysicalUnit[]; packing: PackedPhysicalUnits };
      } | null = null;
      for (const box of searchOrder) {
        const parcel = createOpenParcel(box, groupCode);
        const addition = additionalUnitsThatFit(parcel, packable, remaining);
        if (addition) {
          selected = { parcel, addition };
          break;
        }
      }
      if (!selected) {
        warnings.push(`no box fits ${packable.item.sku ?? packable.item.productVariantId}; used fallback parcel`);
        parcels.push(fallbackParcel(packable.item, remaining, largestFirst[0] ?? null, dimDivisor));
        remaining = 0;
        break;
      }
      addUnits(
        selected.parcel,
        packable,
        selected.addition.units,
        selected.addition.packing,
      );
      remaining -= selected.addition.units.length;
      open.push(selected.parcel);
    }
  }

  for (const parcel of open) {
    downsize(parcel, boxesByVolumeAsc);
    parcels.push(finalizeParcel(
      parcel, dimDivisor,
      `${groupCode ?? "ungrouped"} items packed ${strategy}`,
    ));
  }
  return parcels;
}

interface RiderDonor {
  parcelIndex: number;
  volumeCm3: number;
  weightGrams: number;
  itemCount: number;
}

/**
 * Rider/void pass. Hosts: SIOC parcels whose variant declares void capacity.
 * Donors: boxed parcels where EVERY item is rider-eligible. A donor is
 * absorbed only whole — partial fills save no label and confuse the packer.
 */
function absorbRiders(
  parcels: CartonParcel[],
  itemsByVariant: Map<number, CartonizeItem>,
  warnings: string[],
): CartonParcel[] {
  const hosts = parcels
    .map((parcel, i) => ({ parcel, i }))
    .filter(({ parcel }) => {
      if (parcel.siocProductVariantId == null) return false;
      const attrs = itemsByVariant.get(parcel.siocProductVariantId);
      return attrs != null && attrs.riderVoidCm3 != null && attrs.riderVoidCm3 > 0;
    })
    .map(({ parcel, i }) => {
      const attrs = itemsByVariant.get(parcel.siocProductVariantId as number) as CartonizeItem;
      return {
        parcelIndex: i,
        voidCm3: attrs.riderVoidCm3 as number,
        maxWeightGrams: attrs.riderVoidMaxWeightGrams ?? Number.MAX_SAFE_INTEGER,
        maxItems: attrs.riderVoidMaxItems ?? Number.MAX_SAFE_INTEGER,
      };
    });
  if (hosts.length === 0) return parcels;

  const donors: RiderDonor[] = [];
  parcels.forEach((parcel, i) => {
    if (parcel.siocProductVariantId != null || parcel.items.length === 0) return;
    let volumeCm3 = 0, weightGrams = 0, itemCount = 0;
    for (const line of parcel.items) {
      const attrs = itemsByVariant.get(line.productVariantId);
      if (!attrs || !attrs.riderEligible || !hasCompleteDims(attrs)) return;
      volumeCm3 += (attrs.lengthMm * attrs.widthMm * attrs.heightMm * line.quantity) / 1000;
      weightGrams += attrs.weightGrams * line.quantity;
      itemCount += line.quantity;
    }
    donors.push({ parcelIndex: i, volumeCm3, weightGrams, itemCount });
  });
  if (donors.length === 0) return parcels;

  const absorbed = new Set<number>();
  for (const donor of donors) {
    const host = hosts.find((h) =>
      donor.volumeCm3 <= h.voidCm3
      && donor.weightGrams <= h.maxWeightGrams
      && donor.itemCount <= h.maxItems,
    );
    if (!host) continue;
    const hostParcel = parcels[host.parcelIndex];
    const donorParcel = parcels[donor.parcelIndex];
    hostParcel.items.push(...donorParcel.items.map((line) => ({ ...line, isRider: true })));
    hostParcel.estWeightGrams += donor.weightGrams;
    hostParcel.billableWeightGrams = Math.max(hostParcel.billableWeightGrams, hostParcel.estWeightGrams);
    hostParcel.reason += `; absorbed ${donor.itemCount} rider item(s), eliminated a parcel`;
    host.voidCm3 -= donor.volumeCm3;
    host.maxWeightGrams -= donor.weightGrams;
    host.maxItems -= donor.itemCount;
    absorbed.add(donor.parcelIndex);
    warnings.push(`rider consolidation eliminated parcel of ${donorParcel.items.map((l) => l.sku ?? l.productVariantId).join(", ")}`);
  }
  return parcels.filter((_, i) => !absorbed.has(i));
}

function candidateKey(parcels: CartonParcel[]): string {
  return parcels
    .map((p) => `${p.boxId ?? `sioc:${p.siocProductVariantId}`}|${p.items.map((l) => `${l.productVariantId}x${l.quantity}`).sort().join(",")}`)
    .sort()
    .join(";");
}

export function cartonize(
  items: readonly CartonizeItem[],
  boxes: readonly CartonizeBox[],
  options: CartonizeOptions = {},
): CartonizeResult {
  const dimDivisor = options.dimDivisorCm3PerKg ?? DEFAULT_DIM_DIVISOR_CM3_PER_KG;
  const allowRiders = options.allowRiders ?? false;

  const activeBoxes = boxes.filter((b) => b.isActive);
  const boxesByVolumeAsc = [...activeBoxes].sort((a, b) => boxVolumeMm3(a) - boxVolumeMm3(b));
  const largestBox = boxesByVolumeAsc[boxesByVolumeAsc.length - 1] ?? null;
  const itemsByVariant = new Map(items.map((i) => [i.productVariantId, i]));

  const validItemsByVariant = new Map<number, CartonizeItem>();
  for (const item of items) {
    if (item.quantity <= 0) continue;
    const existing = validItemsByVariant.get(item.productVariantId);
    validItemsByVariant.set(item.productVariantId, existing
      ? { ...existing, quantity: existing.quantity + item.quantity }
      : { ...item });
  }
  const validItems = [...validItemsByVariant.values()];

  const siocParcels: CartonParcel[] = [];
  const problems: string[] = [];
  const fallbacks: CartonParcel[] = [];
  const partitions = new Map<string, PackableItem[]>();

  for (const item of validItems) {
    if (item.shipsInOwnContainer) {
      if (!hasCompleteDims(item)) {
        problems.push(`SIOC item ${item.sku ?? item.productVariantId} missing dims/weight; parcel uses zeros`);
      } else if (item.weightGrams > MAX_MANUAL_CARTON_WEIGHT_GRAMS) {
        problems.push(`SIOC item ${item.sku ?? item.productVariantId} exceeds the 50 lb manual-handling threshold`);
      }
      for (let u = 0; u < item.quantity; u++) siocParcels.push(siocParcel(item, dimDivisor));
      continue;
    }
    if (!hasCompleteDims(item)) {
      problems.push(`item ${item.sku ?? item.productVariantId} missing dims/weight; used fallback parcel`);
      fallbacks.push(fallbackParcel(item, item.quantity, largestBox, dimDivisor));
      continue;
    }
    const key = item.shippingGroupCode ?? "";
    const list = partitions.get(key) ?? [];
    list.push({
      item,
      unitVolumeMm3: item.lengthMm * item.widthMm * item.heightMm,
      unitWeightGrams: item.weightGrams,
      sortedDims: sortedDims(item.lengthMm, item.widthMm, item.heightMm),
    });
    partitions.set(key, list);
  }

  const strategies: Array<"fewest-parcels" | "tightest-boxes"> = ["fewest-parcels", "tightest-boxes"];
  const candidates: CartonizeCandidate[] = [];
  const seen = new Set<string>();

  for (const strategy of strategies) {
    const warnings = [...problems];
    let parcels: CartonParcel[] = [...siocParcels.map((p) => ({
      ...p,
      items: p.items.map((line) => ({ ...line })),
      placements: p.placements.map((placement) => ({ ...placement })),
    }))];

    if (partitions.size > 0 && boxesByVolumeAsc.length === 0) {
      warnings.push("no active boxes in catalog; all boxed items degraded to fallback parcels");
      for (const list of partitions.values()) {
        for (const p of list) parcels.push(fallbackParcel(p.item, p.item.quantity, null, dimDivisor));
      }
    } else {
      for (const [key, list] of partitions) {
        parcels.push(...packPartition(key === "" ? null : key, list, boxesByVolumeAsc, strategy, dimDivisor, warnings));
      }
    }

    parcels.push(...fallbacks.map((p) => ({
      ...p,
      items: p.items.map((line) => ({ ...line })),
      placements: p.placements.map((placement) => ({ ...placement })),
    })));

    if (allowRiders) {
      parcels = absorbRiders(parcels, itemsByVariant, warnings);
    }

    const key = candidateKey(parcels);
    if (!seen.has(key)) {
      seen.add(key);
      candidates.push({ strategy, parcels, warnings });
    }
  }

  if (candidates.length === 0) {
    candidates.push({ strategy: "fallback", parcels: [], warnings: ["no items to cartonize"] });
  }

  return { candidates, engine: { ...CARTONIZE_ENGINE } };
}
