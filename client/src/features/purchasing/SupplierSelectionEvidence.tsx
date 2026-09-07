import type { SupplierSelectionEvidence as Evidence } from "@shared/procurement/supplier-sourcing";
import { rfqMoneyAsInput } from "@/lib/rfq-quote-form";

export function SupplierSelectionEvidence({ evidence, actualVendorProductId }: { evidence?: Evidence | null; actualVendorProductId?: number }) {
  if (!evidence) return null;
  const actual = actualVendorProductId ?? evidence.selectedVendorProductId;
  return <details className="mt-3 rounded border bg-muted/20 p-3 text-xs"><summary className="cursor-pointer font-medium">Supplier selection and price evidence</summary>
    <p className="mt-2 text-muted-foreground">Preferred supplier, then priority, receive configuration, lead time and stable supplier identity. Currency prices are shown separately; no FX or cheapest-price comparison was performed.</p>
    {actual !== evidence.selectedVendorProductId && <p className="mt-2">The RFQ supplier overrides the original proposal. The original ranking is preserved below.</p>}
    <div className="mt-2 space-y-2">{evidence.options.map((option) => <div key={option.vendorProductId} className="rounded border bg-background p-2"><p className="font-medium">{option.vendorName}{option.vendorProductId === actual ? " - selected" : ""}{option.preferred ? " - preferred" : ""}</p><p>Priority {option.priority} - {option.leadTimeDays} days - {option.proposedPieces.toLocaleString()} proposed pieces - policy revision {option.revision}</p>
      {option.estimatedUnitCostMills !== null && <p>{rfqMoneyAsInput(option.estimatedUnitCostMills,4)} {option.currency ?? "currency unknown"} per piece</p>}
      {!option.eligible && <p className="text-destructive">Rejected: {option.rejectionReasons.join(", ").replaceAll("_"," ")}</p>}
      {option.pricingReviewReasons.length > 0 && <p className="text-amber-700">Price review: {option.pricingReviewReasons.join(", ").replaceAll("_"," ")}</p>}
      {option.tier && <p>Quote {option.tier.priceList.quoteReference}: tier {option.tier.minimumQuantity.toLocaleString()}+ {option.tier.priceList.purchaseUom ?? "pieces"}, evaluated at {option.tier.evaluatedQuantity.toLocaleString()}; {rfqMoneyAsInput(option.tier.unitCostMills,4)} {option.tier.priceList.currency} per quoted unit. Valid {option.tier.priceList.validFrom} through {option.tier.priceList.validUntil}.</p>}
    </div>)}</div>{evidence.options.length === 0 && <p>No supplier mappings were present in the captured analysis.</p>}
  </details>;
}
