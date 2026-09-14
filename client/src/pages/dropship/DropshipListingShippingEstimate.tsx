import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Calculator } from "lucide-react";
import { MAX_LISTING_SHIPPING_ESTIMATE_QUANTITY, type ListingShippingEstimateCalculation,
  type ListingShippingEstimateResult } from "@shared/dropship/listing-shipping-estimate";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { US_POSTAL_REGIONS } from "@/components/shipping/rate-table-model";
import { postJson, queryErrorMessage } from "@/lib/dropship-ops-surface";
import { formatListingPreviewIssue } from "@/lib/dropship-listing-preview";
import { buildListingShippingEstimateRequest, readListingShippingEstimateResponse,
  type ListingShippingScenarioFields } from "@/lib/dropship-listing-shipping-estimate";

const US_COUNTRY_CODE = "US";
const GRAMS_PER_POUND = 453.59237;

export function DropshipListingShippingEstimate({ storeConnectionId, productVariantId, variantName }: {
  storeConnectionId: number; productVariantId: number; variantName: string;
}) {
  const fieldId = useId();
  const [fields, setFields] = useState<ListingShippingScenarioFields>({ quantity: "1", country: US_COUNTRY_CODE, region: "", postalCode: "" });
  const [result, setResult] = useState<ListingShippingEstimateResult | null>(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);
  const requestVersion = useRef(0);
  useEffect(() => () => { requestVersion.current += 1; }, []);
  // US destinations pick a state from the same region list the rate tables are
  // keyed by; a typed code can only miss a table row. Other countries keep a
  // two-letter region code input because no region list exists for them here.
  const usDestination = fields.country === US_COUNTRY_CODE;

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
        <div className="space-y-1"><Label htmlFor={`${fieldId}-region`}>{usDestination ? "State" : "Region code"}</Label>
          {usDestination
            ? <Select value={fields.region} onValueChange={(value) => update("region", value)} disabled={pending}>
                <SelectTrigger id={`${fieldId}-region`} aria-label="State"><SelectValue placeholder="Select a state" /></SelectTrigger>
                <SelectContent>{US_POSTAL_REGIONS.map(([code, name]) =>
                  <SelectItem key={code} value={code}>{name} ({code})</SelectItem>)}</SelectContent>
              </Select>
            : <Input id={`${fieldId}-region`} maxLength={2} minLength={2} pattern="[A-Za-z]{2}" required placeholder="ON" autoComplete="address-level1" disabled={pending}
                value={fields.region} onChange={(event) => update("region", event.target.value.toUpperCase())} />}</div>
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
    {result.calculation && <ListingShippingEstimateCalculationDetails calculation={result.calculation} currency={result.currency} />}
  </div>;
}
function EstimateWarnings({ warnings }: { warnings: readonly string[] }) {
  return warnings.length ? <ul className="mt-2 list-disc space-y-1 pl-4 text-xs text-amber-900">{[...new Set(warnings)].map((warning) =>
    <li key={warning}>{formatListingPreviewIssue(warning)}</li>)}</ul> : null;
}

/**
 * Staff-only evidence: present only when the server attached it, which it does
 * solely for a session holding the Dropship operations permission. Vendors
 * never receive this block, so nothing here is ever rendered for them.
 */
export function ListingShippingEstimateCalculationDetails({ calculation, currency }: {
  calculation: ListingShippingEstimateCalculation; currency: string;
}) {
  const money = (cents: number) => new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);
  const weight = (grams: number | null) => grams === null ? "missing" : `${formatNumber(grams)} g (${(grams / GRAMS_PER_POUND).toFixed(2)} lb)`;
  const dims = (length: number | null, width: number | null, height: number | null) =>
    length === null || width === null || height === null ? "no dimensions" : `${length} × ${width} × ${height} mm`;
  const rate = calculation.rate;
  const sourceLabel = calculation.pricingSource === "shared" ? "Shared shipping engine" : "Legacy dropship rate table";
  return <details open data-testid="listing-shipping-calculation" className="mt-3 rounded border border-zinc-200 bg-white p-3 text-xs text-zinc-700">
    <summary className="cursor-pointer text-sm font-medium text-zinc-900">Calculation details (Card Shellz staff view)</summary>
    <dl className="mt-2 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1">
      <dt className="font-medium">Pricing source</dt><dd>{sourceLabel} (cutover {calculation.cutoverMode}, {calculation.cutoverReasonCode})</dd>
      <dt className="font-medium">Origin warehouse</dt><dd>#{calculation.originWarehouseId}</dd>
    </dl>
    <h5 className="mt-3 font-medium text-zinc-900">Items submitted</h5>
    <table className="mt-1 w-full text-left"><thead><tr className="text-zinc-500"><th className="pr-3 font-normal">SKU</th><th className="pr-3 font-normal">Variant</th><th className="pr-3 font-normal">Qty</th><th className="pr-3 font-normal">Unit weight</th><th className="font-normal">Line weight</th></tr></thead>
      <tbody>{calculation.items.map((item) => <tr key={item.productVariantId}>
        <td className="pr-3">{item.sku ?? "unknown"}</td><td className="pr-3">#{item.productVariantId}</td><td className="pr-3">{item.quantity}</td>
        <td className="pr-3">{weight(item.unitWeightGrams)}</td><td>{weight(item.lineWeightGrams)}</td></tr>)}</tbody></table>
    <h5 className="mt-3 font-medium text-zinc-900">Cartons rated</h5>
    {calculation.packages.length === 0 ? <p className="mt-1">No cartons were produced.</p>
      : <table className="mt-1 w-full text-left"><thead><tr className="text-zinc-500"><th className="pr-3 font-normal">#</th><th className="pr-3 font-normal">Box</th><th className="pr-3 font-normal">Weight</th><th className="pr-3 font-normal">Dimensions</th><th className="font-normal">Contents</th></tr></thead>
        <tbody>{calculation.packages.map((carton) => <tr key={carton.packageSequence}>
          <td className="pr-3">{carton.packageSequence}</td><td className="pr-3">{carton.boxCode ?? "weight only"}</td><td className="pr-3">{weight(carton.weightGrams)}</td>
          <td className="pr-3">{dims(carton.lengthMm, carton.widthMm, carton.heightMm)}</td>
          <td>{carton.items.map((line) => `#${line.productVariantId} × ${line.quantity}`).join(", ")}</td></tr>)}</tbody></table>}
    <h5 className="mt-3 font-medium text-zinc-900">Rate selection</h5>
    {rate.source === "shared_engine"
      ? <dl className="mt-1 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1">
          <dt className="font-medium">Pricing program</dt><dd>{rate.rateBookCode} (rate book #{rate.rateBookId})</dd>
          <dt className="font-medium">Rate table row</dt><dd>table #{rate.rateTableId}, row {rate.rateRowId === null ? "unknown" : `#${rate.rateRowId}`}</dd>
          <dt className="font-medium">Service level</dt><dd>{rate.serviceLevelName} ({rate.serviceLevelCode})</dd>
          <dt className="font-medium">Zone</dt><dd>{rate.zone ?? "not resolved"}</dd>
          <dt className="font-medium">Rated weight</dt><dd>{weight(rate.ratedWeightGrams)}</dd>
          <dt className="font-medium">Charge model</dt><dd>{rate.chargeModel}{rate.rowMaxShipmentWeightGrams !== null ? `, row ceiling ${weight(rate.rowMaxShipmentWeightGrams)}` : ""}</dd>
          {rate.perStartedPoundCents !== null && <><dt className="font-medium">Per started pound</dt><dd>{money(rate.perStartedPoundCents)} × {rate.billablePounds ?? 0} lb</dd></>}
          <dt className="font-medium">Product policies</dt><dd>{rate.productPolicyApplied ? "applied" : "none applied"}</dd>
        </dl>
      : <dl className="mt-1 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1">
          <dt className="font-medium">Zone</dt><dd>{rate.zone} (zone rule #{rate.zoneRuleId})</dd>
          <dt className="font-medium">Package rates</dt><dd>{rate.packages.map((match) =>
            `#${match.packageSequence}: table #${match.rateTableId} ${match.carrier} ${match.service} ${money(match.rateCents)}`).join("; ")}</dd>
        </dl>}
    {rate.source === "shared_engine" && rate.policySteps.length > 0 && <ul className="mt-1 list-disc space-y-1 pl-4">
      {rate.policySteps.map((step, index) => <li key={`${index}-${step.label}`}>{step.kind}{step.ruleId !== null ? ` (rule #${step.ruleId})` : ""}: {step.label} {money(step.amountCents)}{step.skus.length ? ` [${step.skus.join(", ")}]` : ""}</li>)}
    </ul>}
    <h5 className="mt-3 font-medium text-zinc-900">Charges</h5>
    <dl className="mt-1 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1">
      <dt className="font-medium">Base rate</dt><dd>{money(calculation.charges.baseCents)}</dd>
      <dt className="font-medium">Markup</dt><dd>{money(calculation.charges.markupCents)}</dd>
      <dt className="font-medium">Insurance</dt><dd>{money(calculation.charges.insuranceCents)}</dd>
      <dt className="font-medium">Dunnage</dt><dd>{money(calculation.charges.dunnageCents)}</dd>
      <dt className="font-medium">Total</dt><dd className="font-semibold">{money(calculation.charges.totalCents)}</dd>
    </dl>
    {calculation.warnings.length > 0 && <><h5 className="mt-3 font-medium text-zinc-900">Engine warnings</h5>
      <ul className="mt-1 list-disc space-y-1 pl-4">{calculation.warnings.map((warning, index) => <li key={`${index}-${warning}`}>{warning}</li>)}</ul></>}
  </details>;
}
function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}
