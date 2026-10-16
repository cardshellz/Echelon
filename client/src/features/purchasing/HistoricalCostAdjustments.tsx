import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { reconciliationDestinations, reconciliationReportSchema } from "@shared/procurement/cost-reconciliation";
import { formatShipmentExceptionAmount } from "@shared/procurement/shipment-cost-exception";
import { apiRequest } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

export function HistoricalCostAdjustments() {
  const report = useQuery({
    queryKey: ["/api/cogs/historical-adjustments"],
    queryFn: async () => {
      const response = await apiRequest("GET", "/api/cogs/historical-adjustments");
      return reconciliationReportSchema.parse(await response.json());
    },
  });
  const money = (value: number) => formatShipmentExceptionAmount(value, "USD");
  return (
    <Card>
      <CardHeader>
        <CardTitle>Historical shipment cost adjustments</CardTitle>
        <CardDescription>
          Approved costs for stock with incomplete movement history. These postings are separate from costs assigned to
          individual orders.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {report.isPending && <p role="status">Loading posted adjustments…</p>}
        {report.isError && (
          <div role="alert">
            Posted adjustments could not be loaded.{" "}
            <Button variant="outline" onClick={() => void report.refetch()}>
              Retry
            </Button>
          </div>
        )}
        {report.data && (
          <>
            <div className="grid sm:grid-cols-2 gap-3">
              {(["historical_cogs", "inventory_variance"] as const).map((destination) => (
                <div key={destination}>
                  <p className="text-sm text-muted-foreground">{reconciliationDestinations[destination]}</p>
                  <strong>{money(report.data.balances[destination])}</strong>
                </div>
              ))}
            </div>
            <details>
              <summary className="cursor-pointer text-sm">
                Posted activity ({report.data.entries.length}
                {report.data.truncated ? " most recent" : ""})
              </summary>
              {report.data.entries.length === 0 ? (
                <p className="py-2 text-sm">No historical cost adjustments posted.</p>
              ) : (
                <ul className="divide-y">
                  {report.data.entries.map((posting) => (
                    <li key={posting.id} className="py-3 space-y-1 text-sm">
                      <div className="flex justify-between flex-wrap gap-2">
                        <Link href={`/purchase-orders/${posting.purchaseOrderId}`} className="underline">
                          {posting.poNumber}
                        </Link>
                        <span>
                          {reconciliationDestinations[posting.destination]}: {money(posting.beforeMills)} →{" "}
                          {money(posting.afterMills)}
                        </span>
                      </div>
                      <p>
                        {posting.sku} · Approved by {posting.actorName} ·{" "}
                        {new Date(posting.recordedAt).toLocaleString()}
                      </p>
                      <p>{posting.reason}</p>
                    </li>
                  ))}
                </ul>
              )}
            </details>
          </>
        )}
      </CardContent>
    </Card>
  );
}
