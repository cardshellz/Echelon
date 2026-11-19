import { useLayoutEffect } from "react";
import { createPortal } from "react-dom";
import type { CustomerOrderTotalsState } from "./CustomerAccountOrderTotals";
import {
  returnProgressLabel,
  customerPaymentPresentation,
  orderDeliveryLabel,
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
      const order = state.status === "verified" ? state.order : null;
      const progress = order && "progress" in order ? order.progress : undefined;
      const cancelled = order && "cancelled" in order ? order.cancelled : row.dataset.cancelled === "true";
      // A loading projection must not unhide delivery for a cancelled native
      // order. Use the same presentation rule before and after hydration.
      const delivery = orderDeliveryLabel(
        cancelled, order?.fulfillment, progress,
        "Status unavailable", row.dataset.fulfillment,
      );
      const deliveryTrack = row.querySelector<HTMLElement>("[data-csz-order-delivery-track]");
      if (deliveryTrack) deliveryTrack.hidden = delivery === null;
      const orderTrack = row.querySelector<HTMLElement>("[data-csz-order-order-track]");
      if (orderTrack) orderTrack.hidden = !cancelled;
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
        const delivery = row.querySelector<HTMLElement>("[data-csz-order-delivery-track]");
        if (delivery) delivery.hidden = row.dataset.cancelled === "true" && !["fulfilled", "partial"].includes(row.dataset.fulfillment ?? "");
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
        const progress = state.status === "verified" && "progress" in state.order ? state.order.progress : undefined;
        const payment = state.status === "verified" ? customerPaymentPresentation(state.order.financialStatus, progress) : null;
        const deliveryLabel = state.status === "verified"
          ? orderDeliveryLabel("cancelled" in state.order ? state.order.cancelled : row.dataset.cancelled === "true", fulfillment, progress, "Status unavailable", row.dataset.fulfillment) : null;
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
              deliveryLabel && (fulfillment ||
                ("progress" in state.order ? state.order.progress : undefined)
                  ?.delivery)
                ? [
                    createPortal(
                      <span>
                        {deliveryLabel}
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
                        {payment?.label}
                        {payment?.detail && (
                          <small className="csz-refund-activity">
                            {payment.detail}
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
