export type AllowedConversionOperation = "break_pack" | "assemble_pack" | "directed_conversion";

export interface AllowedConversion {
  sourceVariantId: number;
  destinationVariantId: number;
  operationType: AllowedConversionOperation;
  inputQty: number;
  outputQty: number;
}

/** Published internal interface for conversion facts. Consumers must not read planning tables. */
export interface InventoryConversionReader {
  getAllowedConversions(productId: number): Promise<ReadonlyArray<AllowedConversion>>;
}
