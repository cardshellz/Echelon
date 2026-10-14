import React from "react";
import { ChevronDown } from "lucide-react";
import type {
  OrderEditFinancials,
  OrderEditSettlement,
} from "@shared/order-edits/order-edit-financials";
import type { OrderEditShippingRepricing } from "@shared/order-edits/order-edit-shipping";
import { formatOrderEditMoney } from "@/lib/order-edits";

type FinancialColumn = { label: string; financials: OrderEditFinancials };
const money = (amount: number) => formatOrderEditMoney(amount, "USD");

export function OrderEditSummary({
  totals,
  difference,
  financials,
}: {
  totals: Array<{ label: string; totalCents: number }>;
  difference?: { label: string; amountCents: number };
  financials?: OrderEditFinancials | null;
}) {
  return (
    <section aria-label="Order summary" className="oe-summary">
      <h3>Your order total</h3>
      {financials && (
        <dl className="oe-money-list oe-summary-items">
          <dt>Items after discounts</dt>
          <dd>{money(financials.itemsNetCents)}</dd>
          <dt>Shipping</dt>
          <dd>{money(financials.shippingCents)}</dd>
          <dt>{financials.taxesIncluded ? "Tax (included)" : "Tax"}</dt>
          <dd>{money(financials.taxCents)}</dd>
        </dl>
      )}
      <dl className="oe-money-list oe-summary-totals">
        {totals.map((total, index) => (
          <React.Fragment key={total.label}>
            <dt className={index === totals.length - 1 ? "oe-total-label" : ""}>
              {total.label}
            </dt>
            <dd className={index === totals.length - 1 ? "oe-total-value" : ""}>
              {money(total.totalCents)}
            </dd>
          </React.Fragment>
        ))}
      </dl>
      {difference && (
        <div className="oe-payment-difference">
          <span>{difference.label}</span>{" "}
          <strong>{money(difference.amountCents)}</strong>
        </div>
      )}
    </section>
  );
}

function FinancialDetails({
  label,
  note,
  children,
}: {
  label: string;
  note?: string;
  children: React.ReactNode;
}) {
  return (
    <details className="oe-details group">
      <summary>
        <span>{label}</span>
        {note && <small>{note}</small>}
        <ChevronDown className="group-open:rotate-180" aria-hidden="true" />
      </summary>
      <div className="oe-details-body">{children}</div>
    </details>
  );
}

export function OrderEditCalculationDetails({
  columns,
  shipping,
}: {
  columns: FinancialColumn[];
  shipping?: OrderEditShippingRepricing | null;
}) {
  if (columns.length === 0 && !shipping) return null;
  return (
    <FinancialDetails label="How your total is calculated">
      {columns.length > 0 && <OrderEditTotals columns={columns} embedded />}
      {shipping && (
        <section className="oe-shipping-rate" aria-label="Recalculated shipping">
          <h3>{shipping.title}</h3>
          <dl className="oe-money-list">
            <dt>Current checkout rate</dt><dd>{money(shipping.grossCents)}</dd>
            {shipping.discountCents > 0 && <>
              <dt className="oe-saving">{shipping.discountLabels.join(", ") || "Shipping savings"}</dt>
              <dd className="oe-saving">−{money(shipping.discountCents)}</dd>
            </>}
            <dt className="oe-net">Shipping charged</dt><dd className="oe-net">{money(shipping.netCents)}</dd>
          </dl>
          <p className="oe-shipping-note">Included in the shipping amount above.</p>
        </section>
      )}
    </FinancialDetails>
  );
}

export function OrderEditPaymentDetails({
  settlement,
  pendingChanges = false,
}: {
  settlement: OrderEditSettlement;
  pendingChanges?: boolean;
}) {
  return (
    <FinancialDetails
      label="Payment history"
      note={`${money(settlement.netPaidCents)} paid`}
    >
      <OrderEditPayments
        settlement={settlement}
        pendingChanges={pendingChanges}
        embedded
      />
    </FinancialDetails>
  );
}

export function OrderEditTotals({
  columns,
  embedded = false,
}: {
  columns: FinancialColumn[];
  embedded?: boolean;
}) {
  return (
    <section
      aria-label="Order financial breakdown"
      className={`oe-calculations ${embedded ? "" : "oe-panel"}`}
    >
      {columns.map(({ label, financials: values }) => {
        // Legacy quotes expose an exact aggregate only. Never invent per-code
        // amounts, or show an absent allocation as a zero-dollar discount.
        const discounts =
          values.itemDiscounts?.map((discount) => ({
            key: discount.key,
            label: discount.label,
            amountCents: discount.amountCents,
            detail:
              discount.value.type === "percentage"
                ? `${discount.value.percentage}% off eligible items`
                : discount.value.type === "fixed"
                  ? `${money(discount.value.amountCents)} fixed discount`
                  : undefined,
          })) ??
          (values.itemsDiscountCents > 0
            ? [
                {
                  key: "aggregate",
                  label:
                    values.itemDiscountLabels.join(", ") || "Product savings",
                  amountCents: values.itemsDiscountCents,
                  detail: undefined,
                },
              ]
            : []);
        return (
          <section
            key={label}
            className="oe-calculation-card"
            aria-label={label}
          >
            <h3>{label}</h3>
            <dl className="oe-money-list">
              {values.itemsDiscountCents > 0 && (
                <>
                  <dt>Items at regular prices</dt>
                  <dd>{money(values.itemsGrossCents)}</dd>
                  {discounts.map((discount) => (
                    <React.Fragment key={discount.key}>
                      <dt className="oe-saving">
                        <span>{discount.label}</span>
                        {discount.detail && <small>{discount.detail}</small>}
                      </dt>
                      <dd className="oe-saving">
                        −{money(discount.amountCents)}
                      </dd>
                    </React.Fragment>
                  ))}
                </>
              )}
              <dt className="oe-net">
                {values.itemsDiscountCents > 0
                  ? "Items after discounts"
                  : "Items"}
              </dt>
              <dd className="oe-net">{money(values.itemsNetCents)}</dd>
              {values.shippingDiscountCents > 0 && (
                <>
                  <dt>Shipping rate</dt>
                  <dd>{money(values.shippingGrossCents)}</dd>
                  <dt className="oe-saving">
                    {values.shippingDiscountLabels.join(", ") ||
                      "Shipping savings"}
                  </dt>
                  <dd className="oe-saving">
                    −{money(values.shippingDiscountCents)}
                  </dd>
                </>
              )}
              <dt>Shipping</dt>
              <dd>{money(values.shippingCents)}</dd>
              <dt>{values.taxesIncluded ? "Tax (included)" : "Tax"}</dt>
              <dd>{money(values.taxCents)}</dd>
              <dt className="oe-total-label">Order total</dt>
              <dd className="oe-total-value">{money(values.totalCents)}</dd>
            </dl>
          </section>
        );
      })}
    </section>
  );
}

export function OrderEditPayments({
  settlement,
  pendingChanges = false,
  embedded = false,
}: {
  settlement: OrderEditSettlement;
  pendingChanges?: boolean;
  embedded?: boolean;
}) {
  const kindLabels: Record<
    OrderEditSettlement["activity"][number]["kind"],
    string
  > = {
    payment: "Payment received",
    refund: "Refund",
    authorization: "Authorization",
    void: "Payment void",
    adjustment: "Adjustment",
  };
  const statuses: Record<
    OrderEditSettlement["activity"][number]["status"],
    string
  > = {
    SUCCESS: "Complete",
    PENDING: "Pending",
    AWAITING_RESPONSE: "Awaiting confirmation",
    UNKNOWN: "Needs verification",
    FAILURE: "Failed",
    ERROR: "Failed",
  };
  return (
    <section
      aria-label="Payments and refunds"
      className={`oe-payments ${embedded ? "" : "oe-panel"}`}
    >
      {pendingChanges && (
        <p className="oe-payment-note">
          These payments are on your current order. Your changes have not been
          applied yet.
        </p>
      )}
      <dl className="oe-money-list">
        <dt>Payments received</dt>
        <dd>{money(settlement.receivedCents)}</dd>
        {settlement.refundedCents > 0 && (
          <>
            <dt>Refunds issued</dt>
            <dd>{money(settlement.refundedCents)}</dd>
            <dt>Paid toward this order</dt>
            <dd>{money(settlement.netPaidCents)}</dd>
          </>
        )}
        {settlement.outstandingCents !== 0 && (
          <>
            <dt className="oe-net">
              {settlement.outstandingCents < 0
                ? "Amount to refund"
                : "Amount still due"}
            </dt>
            <dd className="oe-net">
              {money(Math.abs(settlement.outstandingCents))}
            </dd>
          </>
        )}
      </dl>
      {settlement.outstandingCents === 0 && (
        <p className="oe-paid-status">Current order paid in full</p>
      )}
      {settlement.activity.length > 0 ? (
        <ul className="oe-payment-history" aria-label="Payment activity">
          {settlement.activity.map((entry) => (
            <li key={entry.id}>
              <div>
                <span className="oe-payment-kind">
                  {entry.kind === "payment" && entry.status !== "SUCCESS"
                    ? "Payment"
                    : kindLabels[entry.kind]}
                </span>
                {entry.processedAt && (
                  <time dateTime={entry.processedAt}>
                    {new Date(entry.processedAt).toLocaleString()}
                  </time>
                )}
              </div>
              <div className="oe-payment-event-amount">
                <strong>{money(entry.amountCents)}</strong>
                <span data-status={entry.status}>{statuses[entry.status]}</span>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="oe-payment-note">No payment activity recorded yet.</p>
      )}
    </section>
  );
}
