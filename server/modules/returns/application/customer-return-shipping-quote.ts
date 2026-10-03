import { customerReturnServiceAllowsParcel } from "@shared/returns/customer-return-shipping-guardrails";
import { returnCarrierRuleAllowsWeight } from "@shared/returns/customer-return-carrier-policy";
import type { CustomerReturnLabelSettings } from "@shared/returns/customer-return-label.contract";
import {
  returnRateResultSchema, type ReturnRateProvider, type ReturnRateInput, ReturnRateProviderError,
  type ReturnRateResult, type ReturnRateCandidate,
} from "../../shipping-engine/application/return-rate-provider.port";
import { buildCustomerReturnCostReferenceInputs, returnShipmentDimensionsMm,
  type CustomerReturnCostReference } from "../domain/customer-return-cost-guard";
import { CustomerReturnRateSelectionError, selectCustomerReturnRate } from "../domain/customer-return-rate-selection";
import { CustomerReturnIntakeError } from "./customer-return-intake.ports";

/** Quotes only. Review/intake and durable purchase use the same eligibility and
 * cost decision. No RMA, receiving claim, provider shipment or label is created.
 */
export async function quoteCustomerReturnShipment(
  rates: ReturnRateProvider, settings: CustomerReturnLabelSettings, shipment: ReturnRateInput["shipment"],
): Promise<CustomerReturnShippingQuoteEvidence> {
  const evidence: CustomerReturnShippingQuoteEvidence = { result: null, costReferences: [], selected: null, errorCode: null };
  try {
    if (shipment.shipFrom.countryCode !== "US" || shipment.shipTo.countryCode !== "US") {
      throw new CustomerReturnRateSelectionError("RETURN_RATE_NONE_ELIGIBLE");
    }
    const dimensions = returnShipmentDimensionsMm(shipment);
    const carrierIds = settings.selectionMode === "fixed_service"
      ? customerReturnServiceAllowsParcel(settings, settings.serviceCode!, shipment.parcel.weightGrams, dimensions)
        ? [settings.carrierId!] : []
      : settings.carrierRules.filter(rule => returnCarrierRuleAllowsWeight(rule, shipment.parcel.weightGrams)
        && rule.serviceCodes.some(service => customerReturnServiceAllowsParcel(settings, service, shipment.parcel.weightGrams, dimensions)))
        .map(rule => rule.carrierId);
    if (!carrierIds.length) throw new CustomerReturnRateSelectionError("RETURN_RATE_NONE_ELIGIBLE");
    const referenceInputs = buildCustomerReturnCostReferenceInputs(settings, shipment);
    // These are independent, read-only quotes. Bound provider concurrency while
    // retaining stable evidence order and reducing age before the purchase TTL check.
    const inputs = [{ shipment, carrierIds }, ...referenceInputs];
    const results = await quoteInputs(rates, inputs);
    const actual = results[0];
    if (actual.status === "fulfilled") evidence.result = actual.value;
    for (let index = 1; index < results.length; index++) {
      const result = results[index];
      if (result.status === "fulfilled") evidence.costReferences.push({ input: inputs[index], result: result.value });
    }
    const failure = results.find(result => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
    evidence.selected = selectCustomerReturnRate({ policy: settings, weightGrams: shipment.parcel.weightGrams,
      result: evidence.result!, shipment, costReferences: evidence.costReferences }).selected;
  } catch (error) {
    evidence.errorCode = error instanceof ReturnRateProviderError || error instanceof CustomerReturnRateSelectionError
      ? error.code : "RETURN_RATE_UNAVAILABLE";
  }
  return evidence;
}

export interface CustomerReturnShippingQuoteEvidence {
  result: ReturnRateResult | null;
  costReferences: CustomerReturnCostReference[];
  selected: ReturnRateCandidate | null;
  errorCode: string | null;
}

// One actual manifest plus the three normal carrier-family references in the
// usual policy. Account-specific weight limits can produce additional batches.
const MAX_CONCURRENT_RETURN_RATE_REQUESTS = 4;
async function quoteInputs(rates: ReturnRateProvider, inputs: ReturnRateInput[]): Promise<PromiseSettledResult<ReturnRateResult>[]> {
  const results: PromiseSettledResult<ReturnRateResult>[] = [];
  for (let start = 0; start < inputs.length; start += MAX_CONCURRENT_RETURN_RATE_REQUESTS) {
    results.push(...await Promise.allSettled(inputs.slice(start, start + MAX_CONCURRENT_RETURN_RATE_REQUESTS)
      .map(async input => returnRateResultSchema.parse(await rates.quote(input)))));
  }
  return results;
}

export function customerReturnShippingQuoteError(code: string, canRepack = false): CustomerReturnIntakeError {
  return new CustomerReturnIntakeError(code,
    code === "RETURN_RATE_COST_LIMIT"
      ? canRepack
        ? "Prepaid shipping could not be approved for this box. Use a smaller box, split the items, or contact us for help. No label was purchased."
        : "Your return is saved, but prepaid shipping for this box needs our team's help. No new label was purchased."
      : code === "RETURN_RATE_NONE_ELIGIBLE"
        ? canRepack
          ? "No allowed prepaid service is available for this box. Review its size and contents or contact us for help."
          : "Your return is saved, but no allowed prepaid service is available for this box. Contact us for help."
        : "The prepaid shipping price could not be verified. No label was purchased; try again or contact us for help.",
    code === "RETURN_RATE_COST_LIMIT" || code === "RETURN_RATE_NONE_ELIGIBLE" ? 409 : 503);
}
