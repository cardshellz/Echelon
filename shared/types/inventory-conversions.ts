import { z } from "zod";

const identifier = z.number().int().positive().max(2_147_483_647);

/** Read-only facts from the active model. Execution must reauthorize them. */
export const allowedInventoryConversionSchema = z.object({
  sourceVariantId: identifier,
  destinationVariantId: identifier,
  operationType: z.enum(["break_pack", "assemble_pack", "directed_conversion"]),
  inputQty: identifier,
  outputQty: identifier,
});

export type AllowedInventoryConversion = z.infer<typeof allowedInventoryConversionSchema>;
