import { ChevronDown } from "lucide-react";
import { CompactPoLineTable } from "@/features/po-edit/CompactPoLineTable";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { exactMoneyAsInput } from "@/lib/exact-money-input";
import type { PoQuantityAmendmentContext } from "@shared/procurement/po-quantity-amendment";

type Line = PoQuantityAmendmentContext["lines"][number];
export type PoAmendmentLineDraft = { quantity: string; basis: "per_piece" | "extended_total" | "per_purchase_uom"; price: string; packaging: string; discount: string; tax: string; charge: string; touched: boolean };

type Props = {
  disabled: boolean; lines: readonly Line[]; drafts: Readonly<Record<number, PoAmendmentLineDraft>>; currency: string;
  onChange: (id: number, patch: Partial<PoAmendmentLineDraft>) => void;
  totalLabel: (line: Line, draft: PoAmendmentLineDraft, currency: string) => string;
};

/** Product and receiving identities stay fixed on approved documents. Only the
 * amendment owner validates and saves the raw economic drafts from this table. */
export function PoAmendmentLineTable({ disabled, lines, drafts, currency, onChange, totalLabel }: Props) {
  return <CompactPoLineTable aria-label="Edit PO lines" className="min-w-[820px]">
    <TableHeader><TableRow className="bg-slate-50">
      <TableHead className="w-[30%]">Product / line</TableHead><TableHead className="w-28">Pieces</TableHead>
      <TableHead className="w-40">Product price ({currency})</TableHead><TableHead className="w-32">Packaging ({currency})</TableHead>
      <TableHead className="w-36 text-right">Line total</TableHead><TableHead className="w-24">Details</TableHead>
    </TableRow></TableHeader>
    <TableBody>{lines.map(line => {
      const draft = drafts[line.id];
      const product = line.lineType === "product";
      const priceLabel = draft.basis === "extended_total" ? "Product total" : draft.basis === "per_purchase_uom" && line.pricing?.basis === "per_purchase_uom" ? `Price per ${line.pricing.purchaseUom}` : "Product price per piece";
      const basisLabel = draft.basis === "extended_total" ? "Product total" : draft.basis === "per_purchase_uom" && line.pricing?.basis === "per_purchase_uom" ? `Per ${line.pricing.purchaseUom}` : "Per piece";
      const inconsistent = line.componentTotalCents !== undefined && line.componentTotalCents !== line.lineTotalCents;
      return <TableRow key={line.id} className={inconsistent ? "bg-amber-50/40" : ""}>
        <TableCell className="py-2 align-top">
          <p className="line-clamp-2 text-sm font-medium" title={line.name}>Line {line.lineNumber} · {line.name}</p>
          {product && <p className="text-xs text-muted-foreground">Received {line.receivedQty.toLocaleString()} · Invoiced {line.invoicedQty.toLocaleString()}</p>}
          {line.blockedReason && <p className="mt-1 text-xs text-muted-foreground">{line.blockedReason}</p>}
          {inconsistent && <p className="mt-1 text-xs text-amber-800 dark:text-amber-300">The saved line total does not equal its product, packaging, discount and tax amounts. Check the supplier document.</p>}
        </TableCell>
        {line.blockedReason ? <><TableCell>{line.orderQty.toLocaleString()}</TableCell><TableCell colSpan={3} className="text-right font-mono">{exactMoneyAsInput(line.lineTotalCents, 2)} {currency}</TableCell><TableCell /></> : product ? <>
          <TableCell className="py-2 align-top"><Label className="sr-only" htmlFor={`correct-quantity-${line.id}`}>Quantity (pieces)</Label><Input id={`correct-quantity-${line.id}`} className="h-8 font-mono" inputMode="numeric" value={draft.quantity} onChange={event => onChange(line.id, { quantity: event.target.value })} /></TableCell>
          <TableCell className="py-2 align-top">
            <Label className="sr-only" htmlFor={`correct-price-${line.id}`}>{priceLabel} ({currency})</Label>
            <div className="flex items-center gap-1"><Input id={`correct-price-${line.id}`} className="h-8 font-mono" inputMode="decimal" value={draft.price} onChange={event => onChange(line.id, { price: event.target.value })} />
              <Popover><PopoverTrigger asChild><Button type="button" size="icon" variant="outline" className="h-8 w-7 shrink-0" aria-label={`Pricing options for line ${line.lineNumber}`}><ChevronDown className="h-3 w-3" /></Button></PopoverTrigger>
                <PopoverContent className="w-64 space-y-2" align="start"><Label htmlFor={`price-basis-${line.id}`}>Price entered as</Label>
                  <Select disabled={disabled} value={draft.basis} onValueChange={basis => {
                    if (basis !== "per_piece" && basis !== "extended_total" && basis !== "per_purchase_uom") return;
                    onChange(line.id, { basis, price: basis === "extended_total" ? exactMoneyAsInput(line.totalProductCostCents, 2) : basis === "per_purchase_uom" && line.pricing?.basis === "per_purchase_uom" ? exactMoneyAsInput(line.pricing.quotedCostMillsPerUom, 4) : exactMoneyAsInput(line.unitCostMills, 4) });
                  }}><SelectTrigger id={`price-basis-${line.id}`}><SelectValue /></SelectTrigger><SelectContent><SelectItem value="per_piece">Price per piece</SelectItem><SelectItem value="extended_total">Product total</SelectItem>{line.pricing?.basis === "per_purchase_uom" && <SelectItem value="per_purchase_uom">Price per {line.pricing.purchaseUom}</SelectItem>}</SelectContent></Select>
                  <p className="text-xs text-muted-foreground">Product price excludes the separate packaging amount.</p>
                </PopoverContent>
              </Popover>
            </div><p className="mt-1 text-xs text-muted-foreground">{basisLabel}</p>
          </TableCell>
          <TableCell className="py-2 align-top"><Label className="sr-only" htmlFor={`packaging-${line.id}`}>Packaging total ({currency})</Label><Input id={`packaging-${line.id}`} className="h-8 font-mono" inputMode="decimal" value={draft.packaging} onChange={event => onChange(line.id, { packaging: event.target.value })} /></TableCell>
          <TableCell className="py-2 text-right align-top font-mono text-sm">{totalLabel(line, draft, currency)}</TableCell>
          <TableCell className="py-2 align-top"><Popover><PopoverTrigger asChild><Button type="button" variant="outline" size="sm" className="h-8 text-xs" aria-label={`Tax and discount for line ${line.lineNumber}`}>Tax / discount</Button></PopoverTrigger><PopoverContent className="w-64 space-y-3" align="end">
            <div><Label htmlFor={`discount-${line.id}`}>Discount ({currency})</Label><Input disabled={disabled} id={`discount-${line.id}`} inputMode="decimal" value={draft.discount} onChange={event => onChange(line.id, { discount: event.target.value })} /></div>
            <div><Label htmlFor={`tax-${line.id}`}>Tax ({currency})</Label><Input disabled={disabled} id={`tax-${line.id}`} inputMode="decimal" value={draft.tax} onChange={event => onChange(line.id, { tax: event.target.value })} /></div>
          </PopoverContent></Popover>{(draft.discount !== "0.00" || draft.tax !== "0.00") && <p className="mt-1 text-[11px] text-muted-foreground">Discount {draft.discount} · Tax {draft.tax}</p>}</TableCell>
        </> : <><TableCell>{line.orderQty.toLocaleString()}</TableCell><TableCell colSpan={2}><Label htmlFor={`charge-${line.id}`}>Charge / credit total ({currency})</Label><Input id={`charge-${line.id}`} className="h-8 font-mono" inputMode="decimal" value={draft.charge} onChange={event => onChange(line.id, { charge: event.target.value })} /><p className="text-xs text-muted-foreground">Use a negative amount for a credit or discount.</p></TableCell><TableCell className="text-right font-mono">{totalLabel(line, draft, currency)}</TableCell><TableCell /></>}
      </TableRow>;
    })}</TableBody>
  </CompactPoLineTable>;
}
