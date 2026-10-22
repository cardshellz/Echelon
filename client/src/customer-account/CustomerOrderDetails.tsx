import { useState } from "react";
import { ChevronDown } from "lucide-react";
import type { CustomerAccountTransport } from "./customer-account.transport";
import { OrderEditSummary } from "@/components/order-edits/OrderEditFinancials";
import { formatOrderEditMoney } from "@/lib/order-edits";
import { useCustomerOrderDetails } from "./use-customer-order-details";

/** Display the existing financial presentation; this component never prices an
 * order, prepares an edit, or changes the customer's browser location. */
export function CustomerOrderDetails({
  api,
  externalOrderId,
  orderReference,
}: {
  api: CustomerAccountTransport;
  externalOrderId: string;
  orderReference: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const query = useCustomerOrderDetails(
    api,
    { externalOrderId, orderReference },
    expanded,
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
        {expanded &&
          (details ? (
            <>
              <h3>Items in your order</h3>
              <ul className="csz-panel-items">
                {details.lines
                  .filter((line) => line.quantity > 0)
                  .map((line) => (
                    <li key={line.lineItemId}>
                      <strong>{line.title}</strong>
                      {line.variantTitle && <span>{line.variantTitle}</span>}
                      {line.sku && <small>SKU {line.sku}</small>}
                      <div>
                        <span>Qty {line.quantity}</span>
                        <span>
                          {formatOrderEditMoney(
                            line.totalCents,
                            details.currency,
                          )}
                        </span>
                      </div>
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
                onClick={() => void query.refetch()}
              >
                Try again
              </button>
            </div>
          ) : (
            <p role="status">Loading order details…</p>
          ))}
      </section>
    </div>
  );
}
