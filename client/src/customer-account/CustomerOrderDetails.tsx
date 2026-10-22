import { useMemo, useState } from "react";
import { ChevronDown } from "lucide-react";
import type { CustomerAccountTransport } from "./customer-account.transport";
import { OrderEditSummary } from "@/components/order-edits/OrderEditFinancials";
import { formatOrderEditMoney } from "@/lib/order-edits";
import { useCustomerOrderDetails } from "./use-customer-order-details";
import { orderEditItemSubtotal } from "@/lib/order-edit-display";
import { readCustomerOrderNativeDetails } from "./customer-order-native-details";

/** Display the existing financial presentation; this component never prices an
 * order, prepares an edit, or changes the customer's browser location. */
export function CustomerOrderDetails({
  api,
  externalOrderId,
  orderReference,
  row,
  ready,
}: {
  api: CustomerAccountTransport;
  externalOrderId: string;
  orderReference: string;
  row: HTMLElement;
  ready: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const native = useMemo(() => readCustomerOrderNativeDetails(row), [row]);
  const query = useCustomerOrderDetails(
    api,
    { externalOrderId, orderReference },
    expanded && ready,
  );
  const details = query.data;
  const id = `csz-order-details-${externalOrderId}`;
  return (
    <div className="csz-panel-details">
      <button
        type="button"
        className="csz-panel-option"
        aria-expanded={expanded}
        aria-controls={id}
        onClick={() => setExpanded((value) => !value)}
      >
        <span>View order details</span>
        <ChevronDown
          aria-hidden="true"
          size={16}
          className={expanded ? "csz-expanded" : undefined}
        />
      </button>
      <section
        id={id}
        hidden={!expanded}
        aria-label={`Details for order ${orderReference}`}
      >
        {expanded && details && query.isError && (
          <div className="csz-panel-error" role="alert">
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
        {expanded &&
          (details ? (
            <>
              <h3>Items in your order</h3>
              <ul className="csz-panel-items">
                {details.lines.map((line) => (
                  <li key={line.lineItemId}>
                    <strong>{line.title}</strong>
                    {line.variantTitle && <span>{line.variantTitle}</span>}
                    {line.sku && <small>SKU {line.sku}</small>}
                    <div>
                      <span>
                        {line.quantity > 0
                          ? `Qty ${line.quantity}`
                          : native.originalQuantities.has(line.lineItemId)
                            ? `Originally ${native.originalQuantities.get(line.lineItemId)}`
                            : "Removed from order"}
                      </span>
                      {line.quantity > 0 && (
                        <span>
                          {formatOrderEditMoney(
                            orderEditItemSubtotal(
                              details.financials,
                              line.lineItemId,
                              line.totalCents,
                            ),
                            details.currency,
                          )}
                        </span>
                      )}
                    </div>
                    {line.quantity === 0 &&
                      native.originalQuantities.has(line.lineItemId) && (
                        <small>Removed from current order</small>
                      )}
                  </li>
                ))}
              </ul>
              <OrderEditSummary
                financials={details.financials}
                totals={[
                  {
                    label: "Current order total",
                    totalCents: details.totalCents,
                  },
                ]}
              />
            </>
          ) : query.isError ? (
            <div className="csz-panel-error" role="alert">
              <p>We couldn’t load your order details. Please try again.</p>
              <button
                type="button"
                className="csz-action"
                disabled={query.isFetching}
                onClick={() => void query.refetch()}
              >
                Try again
              </button>
            </div>
          ) : (
            <p role="status">Loading order details…</p>
          ))}
        {expanded &&
          native.addresses.map((address) =>
            address.kind === "billing" ? (
              <details className="csz-panel-address" key={address.kind}>
                <summary>Billing address</summary>
                <address>
                  {address.lines.map((line, index) => (
                    <span key={index}>{line}</span>
                  ))}
                </address>
              </details>
            ) : (
              <div className="csz-panel-address" key={address.kind}>
                <h3>Shipping address</h3>
                <address>
                  {address.lines.map((line, index) => (
                    <span key={index}>{line}</span>
                  ))}
                </address>
              </div>
            ),
          )}
      </section>
    </div>
  );
}
