import { createPortal } from "react-dom";
import type { OrderEditOrder } from "@shared/order-edits/order-edit.contract";
import { OrderEditSummary } from "@/components/order-edits/OrderEditFinancials";
import { formatOrderEditMoney } from "@/lib/order-edits";

export type CustomerOrderTotalsState =
  | { status: "loading" | "failed" }
  | { status: "verified"; order: OrderEditOrder };

/** Presentation only: current money comes from the existing owned order read. */
export function CustomerAccountOrderTotals({
  root,
  states,
}: {
  root: HTMLElement;
  states: ReadonlyMap<HTMLElement, CustomerOrderTotalsState>;
}) {
  return (
    <>
      {[...states].flatMap(([row, state]) => {
        const order = state.status === "verified" ? state.order : null;
        const pending = state.status === "loading";
        const unavailable = pending ? "Checking total…" : "Total unavailable";
        const targets = [
          ...row.querySelectorAll<HTMLElement>("[data-csz-order-total]"),
        ];
        const portals = targets.map((target, index) =>
          createPortal(
            <span aria-busy={pending}>
              {order
                ? `${formatOrderEditMoney(order.totalCents, order.currency)} ${order.currency}`
                : unavailable}
            </span>,
            target,
            `${row.dataset.externalOrderId}:total:${index}`,
          ),
        );
        if (row.hasAttribute("data-csz-order-detail")) {
          const target = root.querySelector<HTMLElement>(
            "[data-csz-order-financials]",
          );
          if (target) {
            portals.push(
              createPortal(
                order ? (
                  <div className="csz-account-ui">
                    <OrderEditSummary
                      financials={order.financials}
                      totals={[
                        { label: "Order total", totalCents: order.totalCents },
                      ]}
                    />
                  </div>
                ) : (
                  <p role="status" aria-busy={pending}>
                    {unavailable}
                  </p>
                ),
                target,
                `${row.dataset.externalOrderId}:financials`,
              ),
            );
          }
        }
        return portals;
      })}
    </>
  );
}
