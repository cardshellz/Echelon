/**
 * Cartonizer v2 — pure domain functions, no I/O.
 *
 * Turns order/cart items into candidate parcel packings against the
 * shipping.box_catalog. Design: docs/SHIPPING-ENGINE-DESIGN.md.
 *
 * Pipeline per request:
 *   1. SIOC items ship as their own parcels (their packaging IS the parcel).
 *   2. Remaining items partition by shipping group (groups never co-pack,
 *      except via the rider pass below).
 *   3. Each partition packs multi-SKU into boxes (two strategies → candidates).
 *   4. Rider pass: a parcel made entirely of rider-eligible items may be
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
  /** Enable the rider/void consolidation pass. Default true. */
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

export interface CartonParcel {
  boxId: number | null;
  boxCode: string | null;
  siocProductVariantId: number | null;
  items: CartonParcelItem[];
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

export const CARTONIZE_ENGINE = { name: "cardshellz-cartonizer", version: "2.0.0" } as const;

const DEFAULT_DIM_DIVISOR_CM3_PER_KG = 5000;

interface PackableItem {
  item: CartonizeItem;
  unitVolumeMm3: number;
  unitWeightGrams: number;
  sortedDims: [number, number, number];
}

interface OpenParcel {
  box: CartonizeBox;
  items: Map<number, CartonParcelItem>;
  usedVolumeMm3: number;
  contentWeightGrams: number;
  maxSortedItemDims: [number, number, number];
  shippingGroupCode: string | null;
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

function billableWeightGrams(
  lengthMm: number, widthMm: number, heightMm: number,
  actualGrams: number, dimDivisorCm3PerKg: number,
): number {
  const volumeCm3 = (lengthMm * widthMm * heightMm) / 1000;
  const dimWeightGrams = Math.ceil((volumeCm3 / dimDivisorCm3PerKg) * 1000);
  return Math.max(actualGrams, dimWeightGrams);
}

function hasCompleteDims(item: CartonizeItem): item is CartonizeItem & {
  weightGrams: number; lengthMm: number; widthMm: number; heightMm: number;
} {
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
    estWeightGrams: weight,
    billableWeightGrams: weight,
    lengthMm: item.lengthMm ?? 0,
    widthMm: item.widthMm ?? 0,
    heightMm: item.heightMm ?? 0,
    shippingGroupCode: item.shippingGroupCode,
    reason: `fallback: no active boxes available for ${item.sku ?? item.productVariantId}`,
  };
}

/** Max additional units of a packable item an open parcel can accept. */
function unitsThatFit(parcel: OpenParcel, p: PackableItem): number {
  if (!itemFitsBox(p.sortedDims, parcel.box)) return 0;
  const volumeHeadroom = boxUsableVolumeMm3(parcel.box) - parcel.usedVolumeMm3;
  const byVolume = p.unitVolumeMm3 > 0 ? Math.floor(volumeHeadroom / p.unitVolumeMm3) : 0;
  const max = parcel.box.maxWeightGrams;
  const byWeight = max == null
    ? Number.MAX_SAFE_INTEGER
    : p.unitWeightGrams > 0
      ? Math.floor((max - parcel.box.tareWeightGrams - parcel.contentWeightGrams) / p.unitWeightGrams)
      : Number.MAX_SAFE_INTEGER;
  return Math.max(0, Math.min(byVolume, byWeight));
}

function addUnits(parcel: OpenParcel, p: PackableItem, quantity: number): void {
  const existing = parcel.items.get(p.item.productVariantId);
  if (existing) {
    existing.quantity += quantity;
  } else {
    parcel.items.set(p.item.productVariantId, {
      productVariantId: p.item.productVariantId,
      sku: p.item.sku,
      quantity,
      isRider: false,
    });
  }
  parcel.usedVolumeMm3 += p.unitVolumeMm3 * quantity;
  parcel.contentWeightGrams += p.unitWeightGrams * quantity;
  for (let i = 0; i < 3; i++) {
    parcel.maxSortedItemDims[i] = Math.max(parcel.maxSortedItemDims[i], p.sortedDims[i]);
  }
}

/**
 * After packing, try to move each parcel into the smallest box that still
 * holds its contents — greedy packing tends to leave the last box oversized.
 */
function downsize(parcel: OpenParcel, boxesByVolumeAsc: CartonizeBox[]): void {
  for (const box of boxesByVolumeAsc) {
    if (boxVolumeMm3(box) >= boxVolumeMm3(parcel.box)) break;
    const fitsDims = itemFitsBox(parcel.maxSortedItemDims, box);
    const fitsVolume = parcel.usedVolumeMm3 <= boxUsableVolumeMm3(box);
    const fitsWeight = box.maxWeightGrams == null
      || parcel.contentWeightGrams + box.tareWeightGrams <= box.maxWeightGrams;
    if (fitsDims && fitsVolume && fitsWeight) {
      parcel.box = box;
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

  const totalVolume = packables.reduce((s, p) => s + p.unitVolumeMm3 * p.item.quantity, 0);
  const totalWeight = packables.reduce((s, p) => s + p.unitWeightGrams * p.item.quantity, 0);

  // Single-box shortcut: the smallest box that takes the entire partition.
  const singleBox = boxesByVolumeAsc.find((box) =>
    totalVolume <= boxUsableVolumeMm3(box)
    && (box.maxWeightGrams == null || totalWeight + box.tareWeightGrams <= box.maxWeightGrams)
    && packables.every((p) => itemFitsBox(p.sortedDims, box)),
  );

  const byVolumeDesc = [...packables].sort((a, b) => b.unitVolumeMm3 - a.unitVolumeMm3);

  if (singleBox) {
    const parcel: OpenParcel = {
      box: singleBox,
      items: new Map(),
      usedVolumeMm3: 0,
      contentWeightGrams: 0,
      maxSortedItemDims: [0, 0, 0],
      shippingGroupCode: groupCode,
    };
    for (const p of byVolumeDesc) addUnits(parcel, p, p.item.quantity);
    parcels.push(finalizeParcel(parcel, dimDivisor, `all ${groupCode ?? "ungrouped"} items fit one ${singleBox.code}`));
    return parcels;
  }

  for (const p of byVolumeDesc) {
    let remaining = p.item.quantity;

    // Fill existing open parcels first (both strategies).
    for (const parcel of open) {
      if (remaining <= 0) break;
      const take = Math.min(remaining, unitsThatFit(parcel, p));
      if (take > 0) {
        addUnits(parcel, p, take);
        remaining -= take;
      }
    }

    while (remaining > 0) {
      // fewest-parcels opens the biggest box (fewer labels); tightest-boxes
      // opens the smallest box the item fits (less air), then both downsize.
      const searchOrder = strategy === "fewest-parcels" ? largestFirst : boxesByVolumeAsc;
      const box = searchOrder.find((b) => itemFitsBox(p.sortedDims, b) && unitsThatFit(
        { box: b, items: new Map(), usedVolumeMm3: 0, contentWeightGrams: 0, maxSortedItemDims: [0, 0, 0], shippingGroupCode: groupCode }, p,
      ) > 0);
      if (!box) {
        warnings.push(`no box fits ${p.item.sku ?? p.item.productVariantId}; used fallback parcel`);
        parcels.push(fallbackParcel(p.item, remaining, largestFirst[0] ?? null, dimDivisor));
        remaining = 0;
        break;
      }
      const parcel: OpenParcel = {
        box,
        items: new Map(),
        usedVolumeMm3: 0,
        contentWeightGrams: 0,
        maxSortedItemDims: [0, 0, 0],
        shippingGroupCode: groupCode,
      };
      const take = Math.min(remaining, unitsThatFit(parcel, p));
      addUnits(parcel, p, take);
      remaining -= take;
      open.push(parcel);
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
  const allowRiders = options.allowRiders ?? true;

  const activeBoxes = boxes.filter((b) => b.isActive);
  const boxesByVolumeAsc = [...activeBoxes].sort((a, b) => boxVolumeMm3(a) - boxVolumeMm3(b));
  const largestBox = boxesByVolumeAsc[boxesByVolumeAsc.length - 1] ?? null;
  const itemsByVariant = new Map(items.map((i) => [i.productVariantId, i]));

  const validItems = items.filter((i) => i.quantity > 0);

  const siocParcels: CartonParcel[] = [];
  const problems: string[] = [];
  const fallbacks: CartonParcel[] = [];
  const partitions = new Map<string, PackableItem[]>();

  for (const item of validItems) {
    if (item.shipsInOwnContainer) {
      if (!hasCompleteDims(item)) {
        problems.push(`SIOC item ${item.sku ?? item.productVariantId} missing dims/weight; parcel uses zeros`);
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
    let parcels: CartonParcel[] = [...siocParcels.map((p) => ({ ...p, items: p.items.map((l) => ({ ...l })) }))];

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

    parcels.push(...fallbacks.map((p) => ({ ...p, items: p.items.map((l) => ({ ...l })) })));

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
