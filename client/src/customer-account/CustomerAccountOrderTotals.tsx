import { createPortal } from "react-dom";
import type { OrderEditOrder } from "@shared/order-edits/order-edit.contract";
import type { CustomerAccountOrderSummary } from "@shared/customer-account/customer-account-orders";
import { OrderEditSummary } from "@/components/order-edits/OrderEditFinancials";
import { formatOrderEditMoney } from "@/lib/order-edits";
import type { CustomerAccountTransport } from "./customer-account.transport";
import { useCustomerOrderDetails } from "./use-customer-order-details";

function DirectOrderFinancials({
  api,
  row,
}: {
  api: CustomerAccountTransport;
  row: HTMLElement;
}) {
  const query = useCustomerOrderDetails(
    api,
    {
      externalOrderId: row.dataset.externalOrderId ?? "",
      orderReference: row.dataset.orderReference ?? "",
    },
    true,
  );
  if (query.data)
    return (
      <div className="csz-account-ui">
        <OrderEditSummary
          financials={query.data.financials}
          totals={[{ label: "Order total", totalCents: query.data.totalCents }]}
        />
      </div>
    );
  if (query.isError)
    return (
      <div role="alert">
        <p>Order details could not be loaded.</p>
        <button
          type="button"
          className="csz-action"
          onClick={() => void query.refetch()}
        >
          Try again
        </button>
      </div>
    );
  return <p role="status">Loading order details…</p>;
}

export type CustomerOrderTotalsState =
  | { status: "loading" | "failed" }
  | { status: "verified"; order: OrderEditOrder | CustomerAccountOrderSummary };

/** Presentation only: current money comes from the existing owned order read. */
export function CustomerAccountOrderTotals({
  root,
  states,
  api,
}: {
  root: HTMLElement;
  states: ReadonlyMap<HTMLElement, CustomerOrderTotalsState>;
  api: CustomerAccountTransport;
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
                  <DirectOrderFinancials api={api} row={row} />
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
