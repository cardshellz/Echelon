import type { InvoiceCostReviewForm } from "@/lib/invoice-cost-review-form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type Rows = NonNullable<InvoiceCostReviewForm["adjustments"]>;
export function InvoiceCostAdjustmentEditor({ rows = [], currency, onChange }: { rows?: Rows; currency: string; onChange: (rows: Rows) => void }) {
  const update = (key: string, patch: Partial<Rows[number]>) => onChange(rows.map(row => row.key === key ? { ...row, ...patch } : row));
  return (
    <div className="space-y-2">
      {rows.map(row => {
        const id = `invoice-adjustment-${row.key}`;
        return (
          <div key={row.key} className="rounded border p-2 grid gap-2 sm:grid-cols-2">
            <div>
              <Label htmlFor={`${id}-reference`}>Adjustment reference</Label>
              <Input id={`${id}-reference`} value={row.label} maxLength={200}
                onChange={event => update(row.key, { label: event.target.value })} />
            </div>
            <div>
              <Label htmlFor={`${id}-amount`}>Amount ({currency})</Label>
              <Input id={`${id}-amount`} inputMode="decimal" value={row.amount}
                onChange={event => update(row.key, { amount: event.target.value })} />
            </div>
            <div>
              <Label htmlFor={`${id}-type`}>Type</Label>
              <select id={`${id}-type`} className="w-full rounded border p-2" value={row.category}
                onChange={event => update(row.key, { category: event.target.value as Rows[number]["category"] })}>
                <option value="discount">Discount</option>
                <option value="supplier_freight">Freight billed by supplier</option>
                <option value="other">Other billed adjustment</option>
              </select>
            </div>
            <div>
              <Label htmlFor={`${id}-destination`}>Apply to</Label>
              <select id={`${id}-destination`} className="w-full rounded border p-2" value={row.destination}
                onChange={event => update(row.key, { destination: event.target.value as Rows[number]["destination"] })}>
                <option value="product">Product cost</option>
                <option value="packaging">Packaging cost</option>
                <option value="excluded">Keep outside inventory cost</option>
              </select>
            </div>
            <Button type="button" size="sm" variant="ghost" onClick={() => onChange(rows.filter(item => item.key !== row.key))}>
              Remove adjustment
            </Button>
          </div>
        );
      })}
      <Button type="button" size="sm" variant="outline" disabled={rows.length >= 30}
        onClick={() => onChange([...rows, { key: crypto.randomUUID(), label: "", category: "discount", destination: "product", amount: "" }])}>
        Classify a billed adjustment
      </Button>
      <p className="text-xs text-muted-foreground">
        Include supplier freight here only when it is part of this line's billed amount and is not also recorded as a shipment charge.
      </p>
    </div>
  );
}
