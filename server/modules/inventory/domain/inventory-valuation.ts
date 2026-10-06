import { lotCostNeedsReview, moneyToSafeNumber, normalizeLotCosts, roundedMillsToCents, type LotCostRecord } from "./lot-cost";

export interface ValuationLot extends LotCostRecord {
  id: number;
  productVariantId: number;
  quantity: number;
  inboundShipmentId: number | null;
}
export interface ValuationIdentity {
  variantId: number; productId: number; sku: string | null; productName: string; baseSku: string | null;
}

export function valueInventory(lots: readonly ValuationLot[], identities: readonly ValuationIdentity[]) {
  const identityByVariant = new Map(identities.map((identity) => [identity.variantId, identity]));
  const groups = new Map<number, { identity: ValuationIdentity; quantity: bigint; mills: bigint; zero: bigint; provisional: bigint;
    unknown: bigint; activeLots: number; hasLandedPending: boolean }>();
  let landedPendingMills = BigInt(0);
  let landedPendingLots = 0;
  for (const lot of lots) {
    if (!Number.isSafeInteger(lot.quantity) || lot.quantity <= 0) throw new Error(`Invalid valuation quantity for lot ${lot.id}`);
    const identity = identityByVariant.get(lot.productVariantId);
    if (!identity) throw new Error(`Catalog identity missing for valued lot ${lot.id}`);
    const costs = normalizeLotCosts(lot);
    const quantity = BigInt(lot.quantity);
    const provisional = lotCostNeedsReview(lot);
    const unknown = lot.cost_source === "unresolved"
      || (Number(lot.cost_precision_version ?? 0) === 0 && costs.totalMills === BigInt(0));
    const pending = Number(lot.cost_provisional) === 1 && lot.inboundShipmentId !== null;
    const group = groups.get(identity.variantId) ?? { identity, quantity: BigInt(0), mills: BigInt(0),
      zero: BigInt(0), provisional: BigInt(0), unknown: BigInt(0), activeLots: 0, hasLandedPending: false };
    group.quantity += quantity;
    group.mills += costs.totalMills * quantity;
    if (costs.totalMills === BigInt(0)) group.zero += quantity;
    if (provisional) group.provisional += quantity;
    if (unknown) group.unknown += quantity;
    group.activeLots += 1;
    group.hasLandedPending ||= pending;
    if (pending) { landedPendingLots += 1; landedPendingMills += costs.totalMills * quantity; }
    groups.set(identity.variantId, group);
  }
  const sorted = [...groups.values()].sort((a,b) => a.identity.variantId-b.identity.variantId);
  const totalMills = sorted.reduce((sum, group) => sum+group.mills, BigInt(0));
  const totalCents = roundedMillsToCents(totalMills);
  // Round the grand total once. Allocate display cents by largest remainder,
  // with stable variant-id ties; both product and SKU projections use this plan.
  const centsByVariant = new Map(sorted.map((group) => [group.identity.variantId,group.mills/BigInt(100)]));
  let remaining = totalCents-[...centsByVariant.values()].reduce((sum,cents) => sum+cents,BigInt(0));
  const remainderOrder = [...sorted].sort((a,b) => {
    const difference = b.mills%BigInt(100)-a.mills%BigInt(100);
    return difference === BigInt(0) ? a.identity.variantId-b.identity.variantId : difference > BigInt(0) ? 1 : -1;
  });
  for (const group of remainderOrder) if (remaining > BigInt(0)) {
    centsByVariant.set(group.identity.variantId,centsByVariant.get(group.identity.variantId)!+BigInt(1)); remaining-=BigInt(1);
  }
  const safe = moneyToSafeNumber;
  const byVariant = sorted.map((group) => ({ productVariantId: group.identity.variantId, sku: group.identity.sku,
    qty: safe(group.quantity,"qty"), avgCostCents: safe((group.mills+group.quantity*BigInt(50))/(group.quantity*BigInt(100)),"avgCostCents"),
    valueCents: safe(centsByVariant.get(group.identity.variantId)!,"valueCents"), zeroCostQty: safe(group.zero,"zeroCostQty"),
    provisionalQty: safe(group.provisional,"provisionalQty"), unknownCostQty: safe(group.unknown,"unknownCostQty"), valueMills: group.mills.toString() }));
  const products = new Map<number, { identity: ValuationIdentity; qty: bigint; mills: bigint; cents: bigint; zero: bigint; activeLots: number; pending: boolean }>();
  for (const group of sorted) {
    const product = products.get(group.identity.productId) ?? { identity: group.identity, qty: BigInt(0), mills: BigInt(0),
      cents: BigInt(0), zero: BigInt(0), activeLots: 0, pending: false };
    product.qty+=group.quantity; product.mills+=group.mills; product.cents+=centsByVariant.get(group.identity.variantId)!;
    product.zero+=group.zero; product.activeLots+=group.activeLots; product.pending||=group.hasLandedPending;
    products.set(group.identity.productId,product);
  }
  const byProduct = [...products.values()].sort((a,b) => a.mills === b.mills ? a.identity.productId-b.identity.productId : a.mills>b.mills ? -1 : 1)
    .map((product) => ({ productId: product.identity.productId, productName: product.identity.productName, baseSku: product.identity.baseSku ?? "",
      totalQty: safe(product.qty,"totalQty"), avgCostPerPiece: safe((product.mills+product.qty*BigInt(50))/(product.qty*BigInt(100)),"avgCostPerPiece"),
      totalValueCents: safe(product.cents,"totalValueCents"), activeLots: product.activeLots, zeroCostQty: safe(product.zero,"zeroCostQty"),
      hasLandedPending: product.pending, valueMills: product.mills.toString(), quantityUnit: "variant" as const }));
  const total = { qty: byVariant.reduce((sum,group) => sum+group.qty,0), valueCents: safe(totalCents,"valueCents"),
    zeroCostQty: byVariant.reduce((sum,group) => sum+group.zeroCostQty,0), provisionalQty: byVariant.reduce((sum,group) => sum+group.provisionalQty,0) };
  for (const [field,value] of Object.entries(total)) if (!Number.isSafeInteger(value)) throw new Error(`Valuation ${field} exceeds response precision`);
  return { total, byVariant, byProduct, totalValueMills: totalMills.toString(), quantityUnit: "variant" as const,
    unknownCostQty: byVariant.reduce((sum,group) => sum+group.unknownCostQty,0), landedPendingLots,
    landedPendingValueCents: safe(roundedMillsToCents(landedPendingMills),"landedPendingValueCents") };
}
