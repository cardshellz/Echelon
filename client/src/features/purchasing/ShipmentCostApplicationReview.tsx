import { SupplierCreditLink } from "@/features/purchasing/SupplierCreditLink";
import { isShipmentCostLinePosted } from "@shared/procurement/shipment-cost-workflow";
import { shipmentCostReviewGuidance } from "@shared/procurement/po-shipment-costs";
import { useShipmentCostReview } from "./use-shipment-cost-review";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ShipmentCostExceptionReview } from "./ShipmentCostExceptionReview";
import { PurchaseSupplierCostReview } from "./PurchaseSupplierCostReview";
import { useProcurementNavigation } from "@/hooks/use-procurement-navigation";

export function ShipmentCostApplicationReview({ shipmentId }: { shipmentId: number }) {
  const navigation = useProcurementNavigation();
  const review = useShipmentCostReview(shipmentId);
  const lines = review.data?.lines ?? [];
  const completed = lines.filter(isShipmentCostLinePosted);
  const visible = lines.filter(line => !isShipmentCostLinePosted(line) || line.exceptionReview);
  return <Card role="region" aria-label="Inventory cost results">
    <CardHeader className="pb-3"><CardTitle className="text-base">Inventory and sold-order costs</CardTitle></CardHeader>
    <CardContent className="space-y-3 text-sm">
      <p className="text-muted-foreground">Saved results from the last cost update. If the charge split needs updating above, these results still use the previous split.</p>
      {review.isPending && <p role="status">Loading saved cost results…</p>}
      {review.isError && <div role="alert" className="space-y-2">
        <p>Saved cost results could not be loaded. Reload them before deciding whether another update is needed.</p>
        <Button variant="outline" onClick={() => void review.refetch()}>Reload cost results</Button>
      </div>}
      {review.isSuccess && <>
        {completed.length > 0 && <p className="text-green-700 dark:text-green-400">
          Costs posted on {completed.length} of {lines.length} shipment lines.
          {completed.length === lines.length && " No shipment cost approval is outstanding."}
        </p>}
        {lines.length === 0 && <p>Add shipment lines before reviewing inventory costs.</p>}
        {review.data.supplierCosts && <PurchaseSupplierCostReview status={review.data.supplierCosts} navigation={navigation} />}
        {visible.map(line => {
          const issues = [...(line.sourceIssue ? [line.sourceIssue] : []), ...(line.application?.issues ?? [])];
          const unique = [...new Map(issues.map(issue => [`${issue.code}:${issue.message}`, issue])).values()];
          const guidance = shipmentCostReviewGuidance(unique.length ? unique : [{
            code: "COST_UPDATE_NOT_RECORDED", message: "No inventory cost update has been recorded for this line.",
          }]);
          return <div key={line.lineId} className="border-t pt-3 space-y-2">
            <div className="flex flex-wrap items-center gap-2"><strong className="font-mono break-all">{line.sku ?? `Line ${line.lineId}`}</strong>
              {!line.exceptionReview && <Badge variant="outline">{unique.length ? "Needs attention" : "Not updated yet"}</Badge>}</div>
            {line.exceptionReview ? <ShipmentCostExceptionReview lineId={line.lineId} review={line.exceptionReview} /> : <>
            {guidance.explanation ? <p>{guidance.explanation}</p> : unique.map(issue => <p key={`${issue.code}:${issue.message}`}>{issue.message}</p>)}
            {!line.application && unique.length === 0 && <p>No inventory cost update has been recorded for this line.</p>}
            <p><strong>Next step:</strong> {guidance.nextStep}</p>{unique.some(issue => issue.code === "SIGNED_LANDED_CREDIT_REVIEW" || issue.code.startsWith("SUPPLIER_CREDIT")) && <SupplierCreditLink inboundShipmentId={shipmentId} />}
            </>}
            {line.application && <p className="text-xs text-muted-foreground">Last saved update: {new Date(line.application.recordedAt).toLocaleString()}. {line.application.lotsUpdated} stock lots and {line.application.cogsRowsUpdated} sold-order cost records updated.</p>}
          </div>;
        })}
      </>}
    </CardContent>
  </Card>;
}
