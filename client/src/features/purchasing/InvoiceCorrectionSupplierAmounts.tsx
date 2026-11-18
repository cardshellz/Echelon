import React from "react";
import type { InvoiceCostReviewForm } from "@/lib/invoice-cost-review-form";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

/** Optional existing supplier evidence, entered in the same edit and approved
 * with the document and its measured cost effects. Blank amounts stay unknown. */
export function InvoiceCorrectionSupplierAmounts({ id, currency, enabled, form, onEnable, onField }: {
  id: number; currency: string; enabled: boolean; form: InvoiceCostReviewForm;
  onEnable: (enabled: boolean) => void; onField: (name: keyof InvoiceCostReviewForm, value: string) => void;
}) {
  const prefix = `invoice-correction-cost-${id}`;
  return <div className="space-y-3 rounded border p-3 text-sm">
    <div className="flex items-start gap-2"><Checkbox id={`${prefix}-enabled`} checked={enabled} onCheckedChange={value => onEnable(value === true)} />
      <Label htmlFor={`${prefix}-enabled`}>Include product and packaging amounts in this correction</Label></div>
    {enabled ? <div className="grid gap-3 sm:grid-cols-2">
      <div className="sm:col-span-2"><Label htmlFor={`${prefix}-packaging`}>Is packaging included in the product amount?</Label>
        <Select value={form.packagingTreatment} onValueChange={value => { onField("packagingTreatment", value); if (value === "combined") onField("packaging", "0"); }}>
          <SelectTrigger id={`${prefix}-packaging`}><SelectValue placeholder="Check the supplier invoice" /></SelectTrigger>
          <SelectContent><SelectItem value="included_in_product">Yes, included</SelectItem><SelectItem value="separate">No, billed separately</SelectItem><SelectItem value="combined">One goods total; the split is not shown</SelectItem></SelectContent>
        </Select></div>
      <div><Label htmlFor={`${prefix}-product`}>{form.packagingTreatment === "combined" ? "Goods total" : "Product total"} ({currency})</Label><Input id={`${prefix}-product`} inputMode="decimal" value={form.product} onChange={event => onField("product", event.target.value)} /></div>
      {form.packagingTreatment !== "combined" && <div><Label htmlFor={`${prefix}-packaging-total`}>Packaging total ({currency})</Label><Input id={`${prefix}-packaging-total`} inputMode="decimal" value={form.packaging} onChange={event => onField("packaging", event.target.value)} /></div>}
      <div className="sm:col-span-2"><Label htmlFor={`${prefix}-other`}>Other invoice amounts / credits ({currency})</Label><Input id={`${prefix}-other`} inputMode="decimal" value={form.adjustment} onChange={event => onField("adjustment", event.target.value)} /></div>
      <p className="text-xs text-muted-foreground sm:col-span-2">Use totals for this whole invoice line. Enter 0 for amounts not charged. The amounts must equal the invoice line amount; unsupported adjustments stay for review.</p>
    </div> : <p className="text-xs text-muted-foreground">For a quantity correction, valid saved supplier amounts are kept. If the billed amount or unit price changes, confirm the supplier amounts here to update inventory costs in the same approval.</p>}
  </div>;
}
