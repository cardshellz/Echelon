import type { OrderEditCatalogSelectionFlow } from "@shared/order-edits/order-edit-catalog";

// Selection notices describe the current purchase path; they never determine
// stock, membership eligibility, prices or permission to commit a paid edit.
const selectionNotices: Record<
  Exclude<OrderEditCatalogSelectionFlow, "order_edit">,
  string
> = {
  membership: "Memberships must be purchased separately. You can continue editing the other items in this order.",
  subscription: "Subscription selected. This editor does not yet support choosing its subscription plan.",
  gift_card: "Gift card selected. Adding gift cards to an existing order is not enabled in this editor yet.",
  bundle: "Bundle selected. This editor does not yet support adding its components.",
  non_shipping: "Product selected. Adding items that do not require shipping is not enabled in this editor yet.",
  inventory_review: "Product selected. This item needs inventory validation before it can be added by this editor.",
};

export function orderEditCatalogSelectionNotice(
  flow: OrderEditCatalogSelectionFlow,
): string | null {
  return flow === "order_edit" ? null : selectionNotices[flow];
}
