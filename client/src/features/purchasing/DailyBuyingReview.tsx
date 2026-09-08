import { useMemo } from "react";
import { useLocation } from "wouter";
import { z } from "zod";
import {
  ArrowRight,
  ClipboardList,
  FileText,
  PackageX,
  ShoppingCart,
} from "lucide-react";
import { INFINITE_DAYS_OF_SUPPLY } from "./reorderEngine";
import { Button } from "@/components/ui/button";
import { isImmutableRecommendationPurchaseOrder } from "@/features/po-edit/purchase-order-editability";

const count = z.number().int().nonnegative().safe();
const product = z.object({
  productId: count.positive(),
  sku: z.string(),
  productName: z.string(),
});
const reviewSchema = z.object({
  stockouts: count,
  orderNow: count,
  draftPoCount: count,
  stockoutItems: z.array(product),
  orderNowItems: z.array(
    product.extend({ daysOfSupply: z.number().finite().nullable() }),
  ),
  draftPos: z.array(
    z.object({
      id: count.positive(),
      poNumber: z.string(),
      vendorName: z.string(),
      lineCount: count,
      source: z.string(),
    }),
  ),
});

/** The overview presents owner-provided priorities; it does not create buying decisions. */
export function DailyBuyingReview({
  data,
  useNewPoEditor,
}: {
  data: unknown;
  useNewPoEditor: boolean;
}) {
  const [, navigate] = useLocation();
  const result = useMemo(() => reviewSchema.safeParse(data), [data]);
  if (!result.success)
    return (
      <section
        aria-labelledby="daily-buying-review-title"
        className="rounded-lg border bg-card p-5"
      >
        <h2 id="daily-buying-review-title" className="text-lg font-semibold">
          Daily buying review
        </h2>
        <p role="alert" className="mt-2 text-sm">
          Buying priorities could not be verified. Open the Reorder Engine to
          review its current recommendations.
        </p>
        <Button className="mt-3" onClick={() => navigate("/reorder-analysis")}>
          Review recommendations
        </Button>
      </section>
    );
  const review = result.data;
  const priorityItems = [
    ...review.stockoutItems.map((item) => ({
      ...item,
      label: "Out of stock",
      urgent: true,
    })),
    ...review.orderNowItems.map((item) => ({
      ...item,
      label:
        item.daysOfSupply === null
          ? "Cover unknown"
          : item.daysOfSupply >= INFINITE_DAYS_OF_SUPPLY
            ? "No recent demand"
            : `${item.daysOfSupply.toLocaleString("en-US", { maximumFractionDigits: 1 })} days cover`,
      urgent: false,
    })),
  ].slice(0, 3);
  return (
    <section
      aria-labelledby="daily-buying-review-title"
      data-testid="daily-buying-review"
      className="space-y-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2
            id="daily-buying-review-title"
            className="text-lg font-semibold tracking-tight"
          >
            Daily buying review
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Review demand, request final quotes and decide what to purchase.
          </p>
        </div>
        <Button onClick={() => navigate("/reorder-analysis")}>
          Review recommendations
          <ArrowRight className="ml-2 h-4 w-4" />
        </Button>
      </div>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
        <div className="overflow-hidden rounded-lg border bg-card">
          <div className="grid grid-cols-2 divide-x border-b">
            <button
              type="button"
              className="flex items-center gap-3 p-4 text-left hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
              onClick={() => navigate("/reorder-analysis?status=stockout")}
            >
              <PackageX
                className="h-5 w-5 shrink-0 text-red-600 dark:text-red-400"
                aria-hidden="true"
              />
              <div>
                <p className="text-2xl font-semibold tabular-nums">
                  {review.stockouts.toLocaleString()}
                </p>
                <p className="text-xs text-muted-foreground">Out of stock</p>
              </div>
            </button>
            <button
              type="button"
              className="flex items-center gap-3 p-4 text-left hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
              onClick={() => navigate("/reorder-analysis?status=order_now")}
            >
              <ShoppingCart
                className="h-5 w-5 shrink-0 text-amber-600 dark:text-amber-400"
                aria-hidden="true"
              />
              <div>
                <p className="text-2xl font-semibold tabular-nums">
                  {review.orderNow.toLocaleString()}
                </p>
                <p className="text-xs text-muted-foreground">
                  Below reorder point
                </p>
              </div>
            </button>
          </div>
          <div className="space-y-2 p-4">
            <p className="text-xs font-medium text-muted-foreground">
              Priority products
            </p>
            {priorityItems.length > 0 ? (
              priorityItems.map((item) => (
                <div
                  key={item.productId}
                  className="flex min-w-0 items-center justify-between gap-3 text-sm"
                >
                  <p
                    className="min-w-0 truncate"
                    title={`${item.sku} · ${item.productName}`}
                  >
                    <span className="font-medium">{item.sku}</span>
                    <span className="ml-2 text-muted-foreground">
                      {item.productName}
                    </span>
                  </p>
                  <span
                    className={`shrink-0 text-xs ${item.urgent ? "text-red-700 dark:text-red-400" : "text-amber-700 dark:text-amber-400"}`}
                  >
                    {item.label}
                  </span>
                </div>
              ))
            ) : (
              <p className="text-sm text-muted-foreground">
                No stockouts or immediate reorder items in this analysis.
              </p>
            )}
          </div>
        </div>
        <div className="overflow-hidden rounded-lg border bg-card">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
            <div className="flex items-center gap-2">
              <ClipboardList className="h-4 w-4 text-primary" />
              <h3 className="text-sm font-semibold">Draft purchase orders</h3>
              <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-semibold text-primary">
                {review.draftPoCount}
              </span>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => navigate("/procurement/rfqs")}
            >
              <FileText className="mr-1.5 h-3.5 w-3.5" />
              RFQs &amp; quotes
            </Button>
          </div>
          <div className="divide-y px-4">
            {review.draftPos.slice(0, 3).map((po) => (
              <div
                key={po.id}
                className="flex items-center justify-between gap-3 py-3"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold">
                    {po.vendorName}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">
                    {po.poNumber} · {po.lineCount}{" "}
                    {po.lineCount === 1 ? "line" : "lines"}
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  aria-label={`Review ${po.poNumber}`}
                  onClick={() =>
                    navigate(
                      useNewPoEditor &&
                        !isImmutableRecommendationPurchaseOrder(po)
                        ? `/purchase-orders/${po.id}/edit`
                        : `/purchase-orders/${po.id}?tab=lifecycle`,
                    )
                  }
                >
                  Review
                </Button>
              </div>
            ))}
            {review.draftPos.length === 0 && (
              <p className="py-4 text-sm text-muted-foreground">
                No draft POs awaiting review. Open RFQs to check your pending
                quotes.
              </p>
            )}
          </div>
          <div className="border-t px-4 py-2">
            <Button
              variant="link"
              className="h-auto p-0 text-xs"
              onClick={() => navigate("/purchase-orders?status=draft")}
            >
              View all draft purchase orders
              <ArrowRight className="ml-1.5 h-3 w-3" />
            </Button>
          </div>
        </div>
      </div>
    </section>
  );
}
