import { useLayoutEffect } from "react";
import { createPortal } from "react-dom";
import type { CustomerOrderTotalsState } from "./CustomerAccountOrderTotals";
import {
  returnProgressLabel,
  refundActivityLabel,
} from "./customer-order-progress-presentation";
import { knownCustomerOrderFulfillment } from "@shared/customer-account/order-fulfillment";

/** Owner-projected delivery, physical return and money remain independent.
 * Native financial and warehouse facts stay visible when enrichment is absent. */
export function CustomerAccountOrderStatus({
  states,
}: {
  states: ReadonlyMap<HTMLElement, CustomerOrderTotalsState>;
}) {
  useLayoutEffect(() => {
    for (const [row, state] of states) {
      const fallback = row.querySelector<HTMLElement>(
        "[data-csz-order-fulfillment-native]",
      );
      if (fallback)
        fallback.hidden =
          state.status === "verified" &&
          (("progress" in state.order ? state.order.progress : undefined)
            ?.delivery != null ||
            knownCustomerOrderFulfillment(state.order.fulfillment) !==
              undefined);
      const financial = row.querySelector<HTMLElement>(
        "[data-csz-order-financial-native]",
      );
      if (financial) financial.hidden = state.status === "verified";
      const returned = row.querySelector<HTMLElement>(
        "[data-csz-order-return-track]",
      );
      if (returned)
        returned.hidden =
          state.status !== "verified" ||
          returnProgressLabel(
            "progress" in state.order ? state.order.progress : undefined,
          ) === null;
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
      for (const row of states.keys()) {
        const returned = row.querySelector<HTMLElement>(
          "[data-csz-order-return-track]",
        );
        if (returned) returned.hidden = true;
      }
    };
  }, [states]);
  return (
    <>
      {[...states].flatMap(([row, state]) => {
        const fulfillment =
          state.status === "verified"
            ? knownCustomerOrderFulfillment(state.order.fulfillment)
            : undefined;
        const target = row.querySelector<HTMLElement>(
          "[data-csz-order-fulfillment]",
        );
        const financial = row.querySelector<HTMLElement>(
          "[data-csz-order-financial-status]",
        );
        const returned = row.querySelector<HTMLElement>(
          "[data-csz-order-return-status]",
        );
        const returnLabel =
          state.status === "verified"
            ? returnProgressLabel(
                "progress" in state.order ? state.order.progress : undefined,
              )
            : null;
        return state.status !== "verified"
          ? []
          : [
              ...(target &&
              (fulfillment ||
                ("progress" in state.order ? state.order.progress : undefined)
                  ?.delivery)
                ? [
                    createPortal(
                      <span>
                        {("progress" in state.order
                          ? state.order.progress
                          : undefined
                        )?.delivery?.label ?? fulfillment!.label}
                      </span>,
                      target,
                      `${row.dataset.externalOrderId}:fulfillment`,
                    ),
                  ]
                : []),
              ...(returned && returnLabel
                ? [
                    createPortal(
                      <span>{returnLabel}</span>,
                      returned,
                      `${row.dataset.externalOrderId}:return-status`,
                    ),
                  ]
                : []),
              ...(financial
                ? [
                    createPortal(
                      <span>
                        {state.order.financialStatus}
                        {refundActivityLabel(
                          state.order.financialStatus,
                          "progress" in state.order
                            ? state.order.progress
                            : undefined,
                        ) && (
                          <small className="csz-refund-activity">
                            {refundActivityLabel(
                              state.order.financialStatus,
                              "progress" in state.order
                                ? state.order.progress
                                : undefined,
                            )}
                          </small>
                        )}
                      </span>,
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
