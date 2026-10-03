import Decimal from "decimal.js";
import { z } from "zod";
import { returnCarrierWeightLimitGrams, MAX_RETURN_CARRIER_RULES } from "@shared/returns/customer-return-carrier-policy";
import {
  customerReturnServiceAllowsParcel, returnParcelCarrierFamily,
  RETURN_PARCEL_CARRIER_FAMILIES,
  type CustomerReturnShippingPolicy,
} from "@shared/returns/customer-return-shipping-guardrails";
import { MILLIMETERS_PER_INCH } from "@shared/shipping/dimensions";
import {
  returnRateInputSchema, returnRateResultSchema,
  type ReturnRateInput, type ReturnRateCandidate,
} from "../../shipping-engine/application/return-rate-provider.port";

const Exact = Decimal.clone({ precision: 40 });
export const customerReturnCostReferenceSchema = z.object({
  input: returnRateInputSchema,
  result: returnRateResultSchema,
}).strict();
// Each account can contribute at most one reference for each supported family.
export const customerReturnCostReferencesSchema = z.array(customerReturnCostReferenceSchema)
  .max(MAX_RETURN_CARRIER_RULES * RETURN_PARCEL_CARRIER_FAMILIES.length);
export type CustomerReturnCostReference = z.infer<typeof customerReturnCostReferenceSchema>;

export function returnShipmentDimensionsMm(shipment: ReturnRateInput["shipment"]) {
  const dimensions = shipment.parcel.dimensionsInches;
  return { lengthMm: new Exact(dimensions.length).times(MILLIMETERS_PER_INCH).toNumber(),
    widthMm: new Exact(dimensions.width).times(MILLIMETERS_PER_INCH).toNumber(),
    heightMm: new Exact(dimensions.height).times(MILLIMETERS_PER_INCH).toNumber() };
}

/** Quote-only manifests. Preserve the exact customer-to-warehouse route and
 * account, replacing only the parcel with its policy's normal comparison box
 * and maximum permitted product weight. No sampled ZIP price is a universal cap.
 */
export function buildCustomerReturnCostReferenceInputs(
  policy: CustomerReturnShippingPolicy, shipment: ReturnRateInput["shipment"],
): ReturnRateInput[] {
  const guardrails = policy.parcelGuardrails;
  if (!guardrails?.costProtection) return [];
  const accounts = policy.selectionMode === "fixed_service"
    ? [{ carrierId: policy.carrierId!, serviceCodes: [policy.serviceCode!], maxWeightLb: null }]
    : policy.carrierRules;
  const groups = new Map<string, ReturnRateInput>();
  for (const account of accounts) {
    for (const service of account.serviceCodes) {
      const family = returnParcelCarrierFamily(service);
      if (!family || !customerReturnServiceAllowsParcel(policy, service, shipment.parcel.weightGrams, returnShipmentDimensionsMm(shipment))) continue;
      const limits = guardrails[family];
      const accountLimit = returnCarrierWeightLimitGrams(account.maxWeightLb);
      if (accountLimit !== null && shipment.parcel.weightGrams > accountLimit) continue;
      const weightGrams = Math.min(returnCarrierWeightLimitGrams(limits.maxWeightLb)!, accountLimit ?? Number.MAX_SAFE_INTEGER);
      const dimensions = limits.costReferenceDimensions;
      const key = JSON.stringify({ family, weightGrams, dimensions });
      const group = groups.get(key);
      if (group) {
        if (!group.carrierIds.includes(account.carrierId)) group.carrierIds.push(account.carrierId);
      } else groups.set(key, returnRateInputSchema.parse({
        shipment: { ...shipment, parcel: { weightGrams,
          dimensionsInches: { length: new Exact(dimensions.lengthMm).div(MILLIMETERS_PER_INCH).toNumber(),
            width: new Exact(dimensions.widthMm).div(MILLIMETERS_PER_INCH).toNumber(),
            height: new Exact(dimensions.heightMm).div(MILLIMETERS_PER_INCH).toNumber() } } },
        carrierIds: [account.carrierId],
      }));
    }
  }
  return [...groups.entries()].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([, group]) => ({ ...group, carrierIds: [...group.carrierIds].sort() }));
}

/** A protected return uses the cheapest eligible normal-box reference ceiling.
 * Missing, substituted, duplicate or incomplete reference evidence fails closed.
 * This limits quoted purchases; later carrier measurement adjustments are not a price lock.
 */
export function customerReturnQuotedCostCeiling(
  policy: CustomerReturnShippingPolicy, shipment: ReturnRateInput["shipment"],
  actualRates: readonly ReturnRateCandidate[], rawReferences: readonly CustomerReturnCostReference[],
): number | null {
  const parsed = customerReturnCostReferencesSchema.safeParse(rawReferences);
  if (!parsed.success) return null;
  const expected = buildCustomerReturnCostReferenceInputs(policy, shipment);
  if (!expected.length || expected.length !== parsed.data.length) return null;
  const references = parsed.data;
  const matchedInputs = new Set<string>();
  for (const reference of references) {
    const identity = JSON.stringify(returnRateInputSchema.parse(reference.input));
    if (matchedInputs.has(identity) || !expected.some(input => JSON.stringify(input) === identity)) return null;
    matchedInputs.add(identity);
  }
  const ceilings: number[] = [];
  for (const actual of actualRates) {
    const family = returnParcelCarrierFamily(actual.serviceCode);
    if (!family) return null;
    const account = policy.carrierRules.find(rule => rule.carrierId === actual.carrierId);
    const expectedWeight = Math.min(returnCarrierWeightLimitGrams(policy.parcelGuardrails![family].maxWeightLb)!,
      returnCarrierWeightLimitGrams(account?.maxWeightLb ?? null) ?? Number.MAX_SAFE_INTEGER);
    const match = references.flatMap(reference => reference.input.carrierIds.includes(actual.carrierId)
      && reference.input.shipment.parcel.weightGrams === expectedWeight
      ? reference.result.rates.filter(rate => rate.carrierId === actual.carrierId && rate.serviceCode === actual.serviceCode)
      : []);
    if (match.length !== 1) return null;
    ceilings.push(match[0].amountCents);
  }
  return ceilings.length ? Math.min(...ceilings) : null;
}
