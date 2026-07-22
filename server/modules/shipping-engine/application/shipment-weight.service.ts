import type { ShipmentLineInput } from "../domain/shipment";

export interface ChannelShipmentLineInput {
  sku: string | null;
  productVariantId?: number | null;
  quantity: number;
  channelWeightGrams: number | null;
  unitPriceCents?: number | null;
  shippingGroupCode?: string | null;
  shipsInOwnContainer?: boolean;
}

/**
 * Echelon catalog weight is canonical. Channel weight is a non-blocking
 * transition fallback until catalog coverage is complete.
 */
export function resolveShipmentLineWeights(
  lines: readonly ChannelShipmentLineInput[],
  catalogWeightBySku: ReadonlyMap<string, number | null>,
): ShipmentLineInput[] {
  return lines.map((line) => {
    const sku = line.sku?.trim() || null;
    const catalogWeight = sku ? catalogWeightBySku.get(sku) : undefined;
    const productFacts = {
      ...(line.productVariantId !== undefined ? { productVariantId: line.productVariantId } : {}),
      ...(line.unitPriceCents !== undefined ? { unitPriceCents: line.unitPriceCents } : {}),
      ...(line.shippingGroupCode !== undefined ? { shippingGroupCode: line.shippingGroupCode } : {}),
      ...(line.shipsInOwnContainer !== undefined ? { shipsInOwnContainer: line.shipsInOwnContainer } : {}),
    };
    if (isPositiveWeight(catalogWeight)) {
      return {
        sku,
        quantity: line.quantity,
        unitWeightGrams: catalogWeight,
        weightSource: "echelon_catalog",
        ...productFacts,
      };
    }
    if (isPositiveWeight(line.channelWeightGrams)) {
      return {
        sku,
        quantity: line.quantity,
        unitWeightGrams: line.channelWeightGrams,
        weightSource: "channel_fallback",
        ...productFacts,
      };
    }
    return {
      sku,
      quantity: line.quantity,
      unitWeightGrams: null,
      weightSource: "missing",
      ...productFacts,
    };
  });
}

function isPositiveWeight(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}
