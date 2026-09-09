import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Calculator } from "lucide-react";
import { MAX_LISTING_SHIPPING_ESTIMATE_QUANTITY, type ListingShippingEstimateResult } from "@shared/dropship/listing-shipping-estimate";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { postJson, queryErrorMessage } from "@/lib/dropship-ops-surface";
import { formatListingPreviewIssue } from "@/lib/dropship-listing-preview";
import { buildListingShippingEstimateRequest, readListingShippingEstimateResponse,
  type ListingShippingScenarioFields } from "@/lib/dropship-listing-shipping-estimate";

export function DropshipListingShippingEstimate({ storeConnectionId, productVariantId, variantName }: {
  storeConnectionId: number; productVariantId: number; variantName: string;
}) {
  const fieldId = useId();
  const [fields, setFields] = useState<ListingShippingScenarioFields>({ quantity: "1", country: "US", region: "", postalCode: "" });
  const [result, setResult] = useState<ListingShippingEstimateResult | null>(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);
  const requestVersion = useRef(0);
  useEffect(() => () => { requestVersion.current += 1; }, []);

  function update(field: keyof ListingShippingScenarioFields, value: string): void {
    setFields((current) => ({ ...current, [field]: value }));
    // A number from a previous destination/quantity must never look current.
    setResult(null);
    setError("");
  }
  async function estimate(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (inFlight.current) return;
    inFlight.current = true;
    const version = ++requestVersion.current;
    setPending(true);
    setResult(null);
    setError("");
    try {
      const request = buildListingShippingEstimateRequest(storeConnectionId, productVariantId, fields);
      const response = await postJson<unknown>("/api/dropship/listings/shipping-estimate", request);
      const next = readListingShippingEstimateResponse(response, request);
      if (version === requestVersion.current) setResult(next);
    } catch (caught) {
      if (version === requestVersion.current) setError(queryErrorMessage(caught, "Shipping could not be estimated. Please try again."));
    } finally {
      inFlight.current = false;
      if (version === requestVersion.current) setPending(false);
    }
  }
  return <section className="rounded-lg border border-zinc-200 p-4" aria-label="Estimate Card Shellz shipping">
    <h4 className="font-semibold">Estimate Card Shellz shipping</h4>
    <p className="mt-1 text-xs text-zinc-500">Our charge to fulfill this purchase—not the shipping you charge your buyer.</p>
    <form onSubmit={(event) => void estimate(event)} className="mt-4 space-y-3">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="space-y-1"><Label htmlFor={`${fieldId}-quantity`}>Quantity to buy</Label>
          <Input id={`${fieldId}-quantity`} type="number" min={1} max={MAX_LISTING_SHIPPING_ESTIMATE_QUANTITY} step={1} required
            disabled={pending} value={fields.quantity} onChange={(event) => update("quantity", event.target.value)} /></div>
        <div className="space-y-1"><Label htmlFor={`${fieldId}-country`}>Country code</Label>
          <Input id={`${fieldId}-country`} maxLength={2} required placeholder="US" autoComplete="country" disabled={pending}
            value={fields.country} onChange={(event) => update("country", event.target.value.toUpperCase())} /></div>
        <div className="space-y-1"><Label htmlFor={`${fieldId}-region`}>State / region</Label>
          <Input id={`${fieldId}-region`} maxLength={2} minLength={2} pattern="[A-Za-z]{2}" required placeholder="PA" autoComplete="address-level1" disabled={pending}
            value={fields.region} onChange={(event) => update("region", event.target.value.toUpperCase())} /></div>
        <div className="space-y-1"><Label htmlFor={`${fieldId}-postal`}>Postal code</Label>
          <Input id={`${fieldId}-postal`} maxLength={20} required autoComplete="postal-code" disabled={pending}
            value={fields.postalCode} onChange={(event) => update("postalCode", event.target.value)} /></div>
      </div>
      <p className="text-xs text-zinc-500">Quantity 1 means one {variantName}. The estimate is for this entire purchase quantity.</p>
      <Button type="submit" variant="outline" size="sm" className="gap-2" disabled={pending}><Calculator aria-hidden="true" className="h-4 w-4" />
        {pending ? "Estimating shipping…" : "Estimate shipping"}</Button>
    </form>
    {error && <p role="alert" className="mt-3 rounded border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">{error}</p>}
    {result && <ListingShippingEstimateResult result={result} />}
    <p className="mt-3 text-xs text-zinc-500">Estimate only. Nothing is reserved, debited, or published. The order shipping charge is calculated for the actual destination and items during order processing.</p>
  </section>;
}

export function ListingShippingEstimateResult({ result }: { result: ListingShippingEstimateResult }) {
  if (result.status === "unavailable") return <div role="status" className="mt-3 rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
    <p className="font-medium">Shipping estimate unavailable</p><p className="mt-1">{result.message}</p>
    <EstimateWarnings warnings={result.warnings} />
  </div>;
  const money = (cents: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: result.currency }).format(cents / 100);
  return <div role="status" className="mt-4 rounded-md bg-zinc-50 p-3">
    <div className="flex flex-wrap items-center justify-between gap-2"><div><p className="text-sm font-medium">Estimated shipping total</p>
      <p className="mt-1 text-xs text-zinc-500">{result.quantity} sellable pack(s) to {[result.destination.region, result.destination.postalCode, result.destination.country].filter(Boolean).join(", ")}</p>
    </div><p className="text-xl font-semibold">{money(result.totalShippingCents)}</p></div>
    <EstimateWarnings warnings={result.warnings} />
  </div>;
}
function EstimateWarnings({ warnings }: { warnings: readonly string[] }) {
  return warnings.length ? <ul className="mt-2 list-disc space-y-1 pl-4 text-xs text-amber-900">{[...new Set(warnings)].map((warning) =>
    <li key={warning}>{formatListingPreviewIssue(warning)}</li>)}</ul> : null;
}
