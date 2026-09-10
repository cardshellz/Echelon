import { z } from "zod";

/** Captured by the recommendation engine; old snapshots may not contain it. */
export const purchaseOrderRoundingSchema = z.object({
  incrementPieces: z.number().int().positive().safe(),
  source: z.enum(["supplier_quote", "vendor_pack", "base_piece"]),
}).superRefine((value, context) => {
  if ((value.source === "base_piece") !== (value.incrementPieces === 1)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["incrementPieces"], message: "The rounding source must match the captured piece increment." });
  }
});

export type PurchaseOrderRounding = z.infer<typeof purchaseOrderRoundingSchema>;
