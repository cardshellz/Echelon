import type { ShipmentLineInput } from "../domain/shipment";

export interface ChannelShipmentLineInput {
  sku: string | null;
  quantity: number;
  channelWeightGrams: number | null;
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
    if (isPositiveWeight(catalogWeight)) {
      return {
        sku,
        quantity: line.quantity,
        unitWeightGrams: catalogWeight,
        weightSource: "echelon_catalog",
      };
    }
    if (isPositiveWeight(line.channelWeightGrams)) {
      return {
        sku,
        quantity: line.quantity,
        unitWeightGrams: line.channelWeightGrams,
        weightSource: "channel_fallback",
      };
    }
    return {
      sku,
      quantity: line.quantity,
      unitWeightGrams: null,
      weightSource: "missing",
    };
  });
}

function isPositiveWeight(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}
