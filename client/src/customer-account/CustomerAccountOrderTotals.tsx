import { createPortal } from "react-dom";
import { useMemo } from "react";
import {
  CustomerOrderCurrentItems,
  readOrderItemDescriptions,
} from "./CustomerOrderCurrentItems";
import type { OrderEditOrder } from "@shared/order-edits/order-edit.contract";
import type { CustomerAccountOrderSummary } from "@shared/customer-account/customer-account-orders";
import { OrderEditSummary } from "@/components/order-edits/OrderEditFinancials";
import { formatOrderEditMoney } from "@/lib/order-edits";
import type { CustomerAccountTransport } from "./customer-account.transport";
import { useCustomerOrderDetails } from "./use-customer-order-details";

function DirectOrderDetails({
  api,
  row,
  root,
  ready,
}: {
  api: CustomerAccountTransport;
  row: HTMLElement;
  root: HTMLElement;
  /** The transport has adopted a verified customer session, not just display facts. */
  ready: boolean;
}) {
  const descriptions = useMemo(() => readOrderItemDescriptions(root), [root]);
  const query = useCustomerOrderDetails(
    api,
    {
      externalOrderId: row.dataset.externalOrderId ?? "",
      orderReference: row.dataset.orderReference ?? "",
    },
    ready,
  );
  const itemsTarget = root.querySelector<HTMLElement>("[data-csz-order-items]");
  const items = query.data && itemsTarget
    ? createPortal(
        <CustomerOrderCurrentItems details={query.data} descriptions={descriptions} />,
        itemsTarget,
        `${row.dataset.externalOrderId}:items`,
      )
    : null;
  if (query.data)
    return (
      <>
        {items}
        <div className="csz-account-ui">
          {query.isError && (
            <div role="alert">
              <p>We couldn’t refresh your order details. Please try again.</p>
              <button
                type="button"
                className="csz-action"
                disabled={query.isFetching}
                onClick={() => void query.refetch()}
              >
                Try again
              </button>
            </div>
          )}
          <OrderEditSummary
            financials={query.data.financials}
            totals={[{ label: "Order total", totalCents: query.data.totalCents }]}
          />
        </div>
      </>
    );
  if (query.isError)
    return (
      <div role="alert">
        <p>Order details could not be loaded.</p>
        <button
          type="button"
          className="csz-action"
          disabled={query.isFetching}
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
  ready,
  onRetry,
}: {
  root: HTMLElement;
  states: ReadonlyMap<HTMLElement, CustomerOrderTotalsState>;
  api: CustomerAccountTransport;
  ready: boolean;
  onRetry?(row: HTMLElement): void;
}) {
  return (
    <>
      {[...states].flatMap(([row, state]) => {
        const order = state.status === "verified" ? state.order : null;
        const pending = state.status === "loading";
        // History has one loading/error boundary. A total is never displayed as
        // being calculated, nor replaced with an unverified fallback amount.
        const targets = [
          ...row.querySelectorAll<HTMLElement>("[data-csz-order-total]"),
        ];
        const portals = targets.map((target, index) =>
          createPortal(
            <span>
              {order ? (
                `${formatOrderEditMoney(order.totalCents, order.currency)} ${order.currency}`
              ) : pending ? (
                <span role="status" aria-label="Loading order total">
                  —
                </span>
              ) : (
                <button
                  type="button"
                  className="csz-account-link"
                  onClick={() => onRetry?.(row)}
                >
                  Retry total
                </button>
              )}
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
            // Cached totals are not authentication. Conversely, a missing
            // summary must not block an independently authenticated item read.
            portals.push(
              createPortal(
                order || ready || pending ? (
                  <DirectOrderDetails api={api} row={row} root={root} ready={ready} />
                ) : (
                  <p role="status" aria-busy={pending}>
                    {pending
                      ? "Loading order details…"
                      : "Order details could not be loaded."}
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
