import type {
  OrderEditFinancials,
  OrderEditPricingDisplayVersion,
} from "@shared/order-edits/order-edit-financials";
import type { OrderEditOrder } from "@shared/order-edits/order-edit.contract";

/** Existing account/staff bundles validate strict DTOs. Management metadata
 * is opt-in so a shared-backend rollout cannot break an older open tab. */
export function orderEditOrderManagementPresentation(order: OrderEditOrder, version: "v1" | undefined): OrderEditOrder {
  if (version === "v1") return order;
  const { fulfillment: _fulfillment, activeOperationKind: _kind, cancellation: _cancellation, ...legacy } = order;
  return legacy;
}

type FinancialResponse = {
  financials?:
    | OrderEditFinancials
    | {
        before: OrderEditFinancials | null;
        quoted: OrderEditFinancials | null;
        current: OrderEditFinancials | null;
      };
};

function presentedFinancials(
  financials: OrderEditFinancials,
  version: OrderEditPricingDisplayVersion | undefined,
): OrderEditFinancials {
  const { taxLines: _taxLines, ...v1 } = financials;
  if (version === "v1") return v1;
  const { orderDiscounts: _discounts, ...legacy } = v1;
  return {
    ...legacy,
    lines: legacy.lines.map(({ productNetCents: _subtotal, ...line }) => line),
  };
}

/** Old tabs use strict schemas. Project only the API response, never financial evidence. */
export function orderEditResponsePresentation<T extends FinancialResponse>(
  response: T,
  version: OrderEditPricingDisplayVersion | undefined,
): T {
  if (version === "v2" || !response.financials) return response;
  const financials = response.financials;
  return {
    ...response,
    financials:
      "itemsNetCents" in financials
        ? presentedFinancials(financials, version)
        : {
            before: financials.before && presentedFinancials(financials.before, version),
            quoted: financials.quoted && presentedFinancials(financials.quoted, version),
            current: financials.current && presentedFinancials(financials.current, version),
          },
  };
}
