import { useEffect } from "react";
import { createPortal } from "react-dom";
import type { CustomerOrderTotalsState } from "./CustomerAccountOrderTotals";

/** Fulfillment presentation comes from the warehouse owner, never from edit
 * eligibility or a reason string. Native Shopify status remains the fallback. */
export function CustomerAccountOrderStatus({
  states,
}: {
  states: ReadonlyMap<HTMLElement, CustomerOrderTotalsState>;
}) {
  useEffect(() => {
    for (const [row, state] of states) {
      const fallback = row.querySelector<HTMLElement>(
        "[data-csz-order-fulfillment-native]",
      );
      if (fallback)
        fallback.hidden =
          state.status === "verified" && state.order.fulfillment !== undefined;
      const financial = row.querySelector<HTMLElement>(
        "[data-csz-order-financial-native]",
      );
      if (financial) financial.hidden = state.status === "verified";
    }
    return () => {
      for (const row of states.keys())
        row
          .querySelectorAll<HTMLElement>(
            "[data-csz-order-fulfillment-native], [data-csz-order-financial-native]",
          )
          .forEach((fallback) => {
            fallback.hidden = false;
          });
    };
  }, [states]);
  return (
    <>
      {[...states].flatMap(([row, state]) => {
        const target = row.querySelector<HTMLElement>(
          "[data-csz-order-fulfillment]",
        );
        const financial = row.querySelector<HTMLElement>(
          "[data-csz-order-financial-status]",
        );
        return state.status !== "verified"
          ? []
          : [
              ...(target && state.order.fulfillment
                ? [
                    createPortal(
                      <span>{state.order.fulfillment.label}</span>,
                      target,
                      `${row.dataset.externalOrderId}:fulfillment`,
                    ),
                  ]
                : []),
              ...(financial
                ? [
                    createPortal(
                      <span>{state.order.financialStatus}</span>,
                      financial,
                      `${row.dataset.externalOrderId}:financial-status`,
                    ),
                  ]
                : []),
            ];
      })}
    </>
  );
}
