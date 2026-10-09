import type { OrderEditFinancials } from "@shared/order-edits/order-edit-financials";
import type { OrderEditShippingRepricing } from "@shared/order-edits/order-edit-shipping";
import type { OrderEditPreview } from "@shared/order-edits/order-edit-preview";
import type { OrderEditPlan, OrderEditSnapshot } from "./order-edit-provider";

import type { OrderEditPreviewVariant } from "../domain/order-edit-preview-pricing";
export type { OrderEditPreviewVariant } from "../domain/order-edit-preview-pricing";
export interface OrderEditPreviewContext {
  snapshot: OrderEditSnapshot;
  variants: OrderEditPreviewVariant[];
}
export interface OrderEditPreviewCalculation {
  financials: OrderEditFinancials;
  shippingRepricing: OrderEditShippingRepricing;
  lines: OrderEditPreview["lines"];
}
/** Only reads and calculation-only API calls. No holds, edit sessions, stock reservations or financial commands. */
export interface OrderEditPreviewProvider {
  preparePreview(snapshot: OrderEditSnapshot): Promise<OrderEditPreviewContext>;
  preview(
    context: OrderEditPreviewContext,
    plan: OrderEditPlan,
  ): Promise<OrderEditPreviewCalculation>;
}
