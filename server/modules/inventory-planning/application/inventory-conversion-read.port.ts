import type { AllowedInventoryConversion } from "@shared/types/inventory-conversions";

export type AllowedConversion = AllowedInventoryConversion;
export type AllowedConversionOperation = AllowedConversion["operationType"];

/** Published internal interface for conversion facts. Consumers must not read planning tables. */
export interface InventoryConversionReader {
  getAllowedConversions(productId: number): Promise<ReadonlyArray<AllowedConversion>>;
}
