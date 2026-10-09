import { OrderEditError } from "../domain/order-edit-error";
import {
  orderEditPreviewPricingContextSchema,
  type OrderEditPreviewPricingContext,
} from "../domain/order-edit-preview-pricing";
import { orderEditSnapshotSchema } from "./order-edit-provider.schema";
import type { OrderEditPreviewContext } from "./order-edit-preview-provider";

/** Validate provider evidence, then give the pure pricing engine only the facts it needs. */
export function toOrderEditPreviewPricingInput(
  context: OrderEditPreviewContext,
): OrderEditPreviewPricingContext {
  const snapshot = orderEditSnapshotSchema.parse(context.snapshot);
  if (!snapshot.financials || !snapshot.previewProductDiscounts)
    throw new OrderEditError(
      "ORDER_EDIT_PREVIEW_PRICING_UNAVAILABLE",
      "Complete financial and product discount evidence is required for a background preview.",
    );
  return orderEditPreviewPricingContextSchema.parse({
    snapshot: {
      memberPricingEnabled: snapshot.memberPricingEnabled,
      memberPlan: snapshot.memberPlan,
      lines: snapshot.lines
        .filter((line) => line.quantity > 0)
        .map((line) => ({
          id: line.id,
          variantId: line.variantId,
          title: line.title,
          variantTitle: line.variantTitle,
          quantity: line.quantity,
          originalUnitPriceCents: line.originalUnitPriceCents,
          unsupported: line.unsupported,
        })),
      previewProductDiscounts: snapshot.previewProductDiscounts,
      discountRules: (snapshot.discountRules ?? []).map((rule) => ({
        type: rule.type,
        targetType: rule.targetType,
        allocationMethod: rule.allocationMethod,
        targetSelection: rule.targetSelection,
        label: rule.label,
        value: rule.value,
      })),
    },
    variants: context.variants,
  });
}
