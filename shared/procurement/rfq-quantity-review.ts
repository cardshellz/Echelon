import { z } from "zod";

const pieces = z.number().int().positive().max(2_147_483_647);
const ruleInputs = z.object({
  vendorProductId: pieces,
  minimumOrderPieces: pieces.nullable(),
  piecesPerPurchaseUom: pieces.nullable(),
  packSize: pieces.nullable(),
});

export const rfqOrderRulesSchema = ruleInputs.extend({
  orderMultiplePieces: pieces,
  orderMultipleSource: z.enum(["purchase_uom", "vendor_pack", "base_piece"]),
}).strict();

export const rfqQuantityReviewIssueSchema = z.enum([
  "recommendation_rules_unavailable",
  "supplier_rules_changed",
  "current_rules_invalid",
  "below_current_moq",
  "outside_current_order_multiple",
]);
export const rfqQuantityReviewSchema = z.object({
  recommendationRules: rfqOrderRulesSchema.nullable(),
  currentRules: rfqOrderRulesSchema.nullable(),
  evaluatedPieces: pieces,
  issues: z.array(rfqQuantityReviewIssueSchema).max(5),
  requiresReason: z.boolean(),
  canConvert: z.boolean(),
}).strict().superRefine((review, context) => {
  if (review.canConvert !== (review.currentRules !== null) || review.requiresReason !== review.issues.some((issue) => issue !== "current_rules_invalid")) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Quantity review state must match its recorded rule evidence" });
  }
});

export type RfqOrderRules = z.infer<typeof rfqOrderRulesSchema>;
export type RfqQuantityReview = z.infer<typeof rfqQuantityReviewSchema>;
export type RfqQuantityReviewIssue = z.infer<typeof rfqQuantityReviewIssueSchema>;

function resolveRules(input: unknown): RfqOrderRules | null {
  const parsed = ruleInputs.safeParse(input);
  if (!parsed.success) return null;
  const rules = parsed.data;
  // This is the recommendation engine's existing precedence: an explicit
  // purchase-unit factor above one, then the operational pack, then one piece.
  const purchaseUnit = rules.piecesPerPurchaseUom !== null && rules.piecesPerPurchaseUom > 1;
  const vendorPack = rules.packSize !== null && rules.packSize > 1;
  return {
    ...rules,
    orderMultiplePieces: purchaseUnit ? rules.piecesPerPurchaseUom! : vendorPack ? rules.packSize! : 1,
    orderMultipleSource: purchaseUnit ? "purchase_uom" : vendorPack ? "vendor_pack" : "base_piece",
  };
}

/** A supplier quote remains the quantity authority. This review never rounds or
 * pads it; changed or missing rules require the existing operator reason. */
export function reviewRfqQuantity(input: { recommendationRules: unknown; currentRules: unknown; quotedPieces: number }): RfqQuantityReview {
  pieces.parse(input.quotedPieces);
  const recommendationRules = resolveRules(input.recommendationRules);
  const currentRules = resolveRules(input.currentRules);
  const issues: RfqQuantityReviewIssue[] = [];
  if (recommendationRules === null) issues.push("recommendation_rules_unavailable");
  if (currentRules === null) issues.push("current_rules_invalid");
  if (currentRules !== null) {
    if (recommendationRules !== null && (
      recommendationRules.vendorProductId !== currentRules.vendorProductId
      || recommendationRules.minimumOrderPieces !== currentRules.minimumOrderPieces
      || recommendationRules.orderMultiplePieces !== currentRules.orderMultiplePieces
      || recommendationRules.orderMultipleSource !== currentRules.orderMultipleSource
    )) issues.push("supplier_rules_changed");
    if (currentRules.minimumOrderPieces !== null && input.quotedPieces < currentRules.minimumOrderPieces) issues.push("below_current_moq");
    if (input.quotedPieces % currentRules.orderMultiplePieces !== 0) issues.push("outside_current_order_multiple");
  }
  return rfqQuantityReviewSchema.parse({
    recommendationRules, currentRules, evaluatedPieces: input.quotedPieces, issues,
    requiresReason: issues.some((issue) => issue !== "current_rules_invalid"), canConvert: currentRules !== null,
  });
}

export function rfqQuantityReviewMessage(issue: RfqQuantityReviewIssue, review: RfqQuantityReview): string {
  switch (issue) {
    case "recommendation_rules_unavailable": return "The recommendation did not preserve supplier order rules. Review the current MOQ and order multiple.";
    case "supplier_rules_changed": return "Supplier mapping or order rules differ from the recommendation.";
    case "current_rules_invalid": return "Current supplier order rules are missing or invalid. Correct the supplier catalog before conversion.";
    case "below_current_moq": return `${review.evaluatedPieces.toLocaleString("en-US")} pieces are below the current MOQ of ${review.currentRules!.minimumOrderPieces!.toLocaleString("en-US")} pieces.`;
    case "outside_current_order_multiple": return `${review.evaluatedPieces.toLocaleString("en-US")} pieces are not a multiple of the current ${review.currentRules!.orderMultiplePieces.toLocaleString("en-US")}-piece order increment.`;
  }
}
