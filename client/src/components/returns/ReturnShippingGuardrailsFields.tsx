import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RETURN_PARCEL_CARRIER_FAMILIES } from "@shared/returns/customer-return-shipping-guardrails";
import type { ReturnParcelLimitDraft, ReturnShippingGuardrailsDraft } from "@/lib/customer-return-guardrails-draft";

export function ReturnShippingGuardrailsFields({ draft, onChange }: {
  draft: ReturnShippingGuardrailsDraft; onChange: (value: ReturnShippingGuardrailsDraft) => void;
}) {
  function field(family: typeof RETURN_PARCEL_CARRIER_FAMILIES[number], key: keyof ReturnParcelLimitDraft, label: string) {
    const id = `return-guard-${family}-${key}`;
    return <div key={key} className="min-w-0 space-y-1">
      <Label htmlFor={id} className="text-xs">{label}</Label>
      <Input id={id} inputMode="decimal" maxLength={16} value={draft[family][key]}
        aria-label={`${family.toUpperCase()} ${label}`}
        onChange={event => onChange({ ...draft, [family]: { ...draft[family], [key]: event.target.value } })} />
    </div>;
  }
  return <section aria-labelledby="return-guardrails-title" className="space-y-3 rounded-lg border p-4">
    <div>
      <h3 id="return-guardrails-title" className="font-medium">Prepaid return guardrails</h3>
      <p className="mt-1 text-sm text-muted-foreground">Domestic U.S. returns only, including Alaska and Hawaii. International returns do not receive free labels.</p>
      <p className="mt-1 text-xs text-muted-foreground">Limits apply to each box. Weight comes from its products. Size is the longest side + 2 × each other side; there is no separate volume limit. Account weight limits can be stricter.</p>
    </div>
    {RETURN_PARCEL_CARRIER_FAMILIES.map(family => <fieldset key={family} className="space-y-3 border-t pt-3">
      <legend className="px-1 text-sm font-semibold">{family === "fedex" ? "FedEx" : family.toUpperCase()}</legend>
      <div className="grid gap-3 sm:grid-cols-3">
        {field(family, "maxWeightLb", "Maximum product weight (lb)")}
        {field(family, "maxLengthInches", "Longest side limit (in)")}
        {field(family, "maxLengthPlusGirthInches", "Length + girth limit (in)")}
      </div>
      {draft.costProtection && <div className="space-y-2">
        <p className="text-xs font-medium">Normal box for price comparison (inches)</p>
        <div className="grid grid-cols-3 gap-3">
          {field(family, "referenceLengthInches", "Reference length (in)")}
          {field(family, "referenceWidthInches", "Reference width (in)")}
          {field(family, "referenceHeightInches", "Reference height (in)")}
        </div>
      </div>}
    </fieldset>)}
    <label className="flex min-h-11 items-center gap-3 border-t pt-3 text-sm">
      <input type="checkbox" className="h-5 w-5" checked={draft.costProtection}
        onChange={event => onChange({ ...draft, costProtection: event.target.checked })} />
      Protect against excessive quoted label costs
    </label>
    <p className="text-xs text-muted-foreground">Quote the normal box at the maximum permitted weight on the same customer-to-warehouse route. The cheapest eligible reference rate is the per-box spending ceiling. Actual dimensions are always sent for rating. Missing reference rates or higher prices stop purchases for staff review. Carrier invoice adjustments remain possible.</p>
  </section>;
}
