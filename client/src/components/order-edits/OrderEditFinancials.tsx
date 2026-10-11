import React from "react";
import { ChevronDown } from "lucide-react";
import type {
  OrderEditFinancials,
  OrderEditSettlement,
} from "@shared/order-edits/order-edit-financials";
import { formatOrderEditMoney } from "@/lib/order-edits";
import type { OrderEditShippingRepricing } from "@shared/order-edits/order-edit-shipping";

type FinancialColumn = { label: string; financials: OrderEditFinancials };

export function OrderEditSummary({
  totals,
  difference,
}: {
  totals: Array<{ label: string; totalCents: number }>;
  difference?: { label: string; amountCents: number };
}) {
  return (
    <section aria-label="Order summary" className="rounded-md bg-muted/40 p-4">
      <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-3 text-sm">
        {totals.map((total, index) => (
          <React.Fragment key={total.label}>
            <dt
              className={index === totals.length - 1 ? "font-medium" : "text-muted-foreground"}
            >
              {total.label}
            </dt>
            <dd
              className={`text-right tabular-nums ${index === totals.length - 1 ? "font-semibold" : "text-muted-foreground"}`}
            >
              {formatOrderEditMoney(total.totalCents, "USD")}
            </dd>
          </React.Fragment>
        ))}
      </dl>
      {difference && (
        <p className="mt-4 flex flex-wrap justify-between gap-2 border-t pt-4 text-sm font-semibold">
          <span>{difference.label}</span>{" "}
          <span className="tabular-nums">
            {formatOrderEditMoney(difference.amountCents, "USD")}
          </span>
        </p>
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
    <details className="group rounded-md border">
      <summary className="flex cursor-pointer list-none items-center gap-3 rounded-md p-4 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
        <span className="min-w-0 flex-1 font-medium">{label}</span>
        {note && <span className="text-xs text-muted-foreground">{note}</span>}
        <ChevronDown
          className="h-4 w-4 shrink-0 group-open:rotate-180"
          aria-hidden="true"
        />
      </summary>
      <div className="space-y-4 border-t p-3 sm:p-4">{children}</div>
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
    <FinancialDetails label="Discounts, shipping and tax">
      {columns.length > 0 && <OrderEditTotals columns={columns} embedded />}
      {shipping && (
        <section
          aria-label="Recalculated shipping"
          className="border-t pt-4 text-sm"
        >
          <h3 className="font-medium">
            Recalculated shipping · {shipping.title}
          </h3>
          <dl className="mt-3 grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-2">
            <dt>Current checkout rate</dt>
            <dd className="text-right tabular-nums">
              {formatOrderEditMoney(shipping.grossCents, "USD")}
            </dd>
            {shipping.discountCents > 0 && (
              <>
                <dt>{shipping.discountLabels.join(", ") || "Shipping benefit"}</dt>
                <dd className="text-right tabular-nums">
                  −{formatOrderEditMoney(shipping.discountCents, "USD")}
                </dd>
              </>
            )}
            <dt className="font-medium">Shipping charged</dt>
            <dd className="text-right font-medium tabular-nums">
              {formatOrderEditMoney(shipping.netCents, "USD")}
            </dd>
          </dl>
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
      label="Payments and refunds"
      note={`${formatOrderEditMoney(settlement.netPaidCents, "USD")} net paid`}
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
  const money = (amount: number) => formatOrderEditMoney(amount, "USD");
  const itemLabels = [
    ...new Set(
      columns.flatMap((column) => column.financials.itemDiscountLabels),
    ),
  ].join(", ");
  const shippingLabels = [
    ...new Set(
      columns.flatMap((column) => column.financials.shippingDiscountLabels),
    ),
  ].join(", ");
  // Older saved quotes do not have proven per-code amounts. Keep their complete
  // aggregate rather than presenting missing evidence as a zero-dollar discount.
  const detailed = columns.every(
    (column) => column.financials.itemDiscounts !== undefined,
  );
  const discounts = new Map(
    columns
      .flatMap((column) => column.financials.itemDiscounts ?? [])
      .map((discount) => [discount.key, discount]),
  );
  const discountRows =
    detailed && discounts.size > 0
      ? [...discounts.values()].map((discount) => ({
          label: discount.label,
          detail:
            discount.value.type === "percentage"
              ? `${discount.value.percentage}% off eligible items`
              : discount.value.type === "fixed"
                ? `${money(discount.value.amountCents)} fixed credit`
                : undefined,
          amounts: columns.map(
            (column) =>
              column.financials.itemDiscounts!.find(
                (entry) => entry.key === discount.key,
              )?.amountCents ?? 0,
          ),
          discount: true,
        }))
      : [
          {
            label: "Item discounts",
            detail: itemLabels,
            amounts: columns.map(
              (column) => column.financials.itemsDiscountCents,
            ),
            discount: true,
          },
        ];
  const rows: Array<{
    label: string;
    detail?: string;
    amounts: number[];
    discount?: boolean;
    strong?: boolean;
  }> = [
    {
      label: "Items before discounts",
      amounts: columns.map((column) => column.financials.itemsGrossCents),
    },
    ...discountRows,
    {
      label: "Items after discounts",
      amounts: columns.map((column) => column.financials.itemsNetCents),
    },
    {
      label: "Shipping before discounts",
      amounts: columns.map((column) => column.financials.shippingGrossCents),
    },
    {
      label: "Shipping discounts",
      detail: shippingLabels,
      amounts: columns.map((column) => column.financials.shippingDiscountCents),
      discount: true,
    },
    {
      label: "Shipping after discounts",
      amounts: columns.map((column) => column.financials.shippingCents),
    },
    {
      label: columns.every((column) => column.financials.taxesIncluded)
        ? "Tax included in prices"
        : "Tax",
      amounts: columns.map((column) => column.financials.taxCents),
    },
    {
      label: "Order total",
      amounts: columns.map((column) => column.financials.totalCents),
      strong: true,
    },
  ];
  return (
    <section
      aria-label="Order financial breakdown"
      className={embedded ? "" : "rounded-md border p-3 sm:p-4"}
    >
      <h3 className="mb-3 text-sm font-semibold">Order financial breakdown</h3>
      <table className="w-full table-fixed text-xs sm:text-sm">
        <thead>
          <tr>
            <th scope="col" className="w-[45%] pb-2 text-left font-medium">
              Breakdown
            </th>
            {columns.map((column) => (
              <th
                key={column.label}
                scope="col"
                className="pb-2 pl-3 text-right align-bottom font-medium leading-tight"
              >
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={row.label}
              className={row.strong ? "border-t font-semibold" : ""}
            >
              <th
                scope="row"
                className={`py-2 pr-3 text-left align-top ${row.strong ? "font-semibold" : "font-normal"}`}
              >
                {row.label}
                {row.detail && (
                  <span className="mt-1 block break-words text-xs font-normal text-muted-foreground">
                    {row.detail}
                  </span>
                )}
              </th>
              {row.amounts.map((amount, index) => (
                <td
                  key={columns[index].label}
                  className="py-2 pl-3 text-right align-top tabular-nums"
                >
                  {row.discount && amount > 0 ? "−" : ""}
                  {money(amount)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
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
  const money = (amount: number) => formatOrderEditMoney(amount, "USD");
  const kindLabels: Record<
    OrderEditSettlement["activity"][number]["kind"],
    string
  > = {
    payment: "Payment",
    refund: "Refund",
    authorization: "Authorization",
    void: "Void",
    adjustment: "Adjustment",
  };
  const statuses: Record<string, string> = {
    SUCCESS: "Succeeded",
    PENDING: "Pending",
    AWAITING_RESPONSE: "Awaiting confirmation",
    UNKNOWN: "Needs verification",
    FAILURE: "Failed",
    ERROR: "Failed",
  };
  return (
    <section
      aria-label="Payments and refunds"
      className={embedded ? "" : "rounded-md border p-3 sm:p-4"}
    >
      <h3 className="mb-3 text-sm font-semibold">Payments and refunds</h3>
      {pendingChanges && (
        <p className="mb-3 text-xs text-muted-foreground">
          Recorded on the current order. The quoted changes have not been
          applied.
        </p>
      )}
      <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-2 text-sm">
        <dt>Payments received</dt>
        <dd className="text-right tabular-nums">
          {money(settlement.receivedCents)}
        </dd>
        <dt>Refunds issued</dt>
        <dd className="text-right tabular-nums">
          {money(settlement.refundedCents)}
        </dd>
        <dt>Net paid</dt>
        <dd className="text-right tabular-nums">
          {money(settlement.netPaidCents)}
        </dd>
        <dt className="font-semibold">
          {settlement.outstandingCents < 0
            ? "Amount to refund"
            : "Amount still due"}
        </dt>
        <dd className="text-right font-semibold tabular-nums">
          {money(Math.abs(settlement.outstandingCents))}
        </dd>
      </dl>
      {settlement.activity.length > 0 && (
        <div className="mt-4 border-t pt-3">
          <h4 className="mb-2 text-xs font-medium">Payment history</h4>
          <ul className="divide-y">
            {settlement.activity.map((entry) => (
              <li key={entry.id} className="flex gap-3 py-2 text-sm">
                <div className="min-w-0 flex-1">
                  <p>
                    {kindLabels[entry.kind]} ·{" "}
                    {statuses[entry.status] ?? entry.status}
                  </p>
                  {entry.processedAt && (
                    <time
                      dateTime={entry.processedAt}
                      className="text-xs text-muted-foreground"
                    >
                      {new Date(entry.processedAt).toLocaleString()}
                    </time>
                  )}
                </div>
                <span className="tabular-nums">{money(entry.amountCents)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
