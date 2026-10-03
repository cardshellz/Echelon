import {
  customerReturnCarrierPolicySchema,
  isReturnCarrierServiceAllowed,
  returnCarrierRuleAllowsWeight,
} from "@shared/returns/customer-return-carrier-policy";
import { customerReturnPackingIssue, customerReturnPackingLimits, customerReturnShippingGuardrailsSchema,
  type CustomerReturnShippingPolicy } from "@shared/returns/customer-return-shipping-guardrails";
import { customerReturnQuotedCostCeiling, returnShipmentDimensionsMm, type CustomerReturnCostReference } from "./customer-return-cost-guard";
import {
  returnRateResultSchema,
  type ReturnRateCandidate,
  type ReturnRateResult,
  returnRateShipmentSchema, type ReturnRateInput,
} from "../../shipping-engine/application/return-rate-provider.port";

export class CustomerReturnRateSelectionError extends Error {
  constructor(
    readonly code: "RETURN_RATE_INPUT_INVALID" | "RETURN_RATE_NONE_ELIGIBLE" | "RETURN_RATE_COST_LIMIT" | "RETURN_RATE_COST_UNVERIFIED",
  ) {
    super(
      code === "RETURN_RATE_NONE_ELIGIBLE"
        ? "No allowed return service has an available rate for this box. Review the carrier rules before continuing."
        : "The available return rates could not be verified. Refresh them before continuing.",
    );
    this.name = "CustomerReturnRateSelectionError";
  }
}

export interface CustomerReturnRateSelection {
  selected: ReturnRateCandidate;
  eligibleRates: ReturnRateCandidate[];
  excludedRates: {
    carrierId: string;
    serviceCode: string;
    reason: "not_allowed" | "weight_limit" | "size_limit" | "cost_limit";
  }[];
}

/** No provider calls, mutations, clock or display-name identity matching.
 * The provider has already rated the exact return manifest. Compare only
 * complete USD totals from services admitted by the current administrator policy.
 */
export function selectCustomerReturnRate(input: {
  policy: CustomerReturnShippingPolicy;
  weightGrams: number;
  result: ReturnRateResult;
  shipment?: ReturnRateInput["shipment"];
  costReferences?: readonly CustomerReturnCostReference[];
}): CustomerReturnRateSelection {
  if (!input || !input.policy)
    throw new CustomerReturnRateSelectionError("RETURN_RATE_INPUT_INVALID");
  // Settings contain unrelated warehouse/contact fields; extract this boundary's contract.
  const policy = customerReturnCarrierPolicySchema.safeParse({
    selectionMode: input.policy.selectionMode,
    carrierId: input.policy.carrierId,
    serviceCode: input.policy.serviceCode,
    carrierRules: input.policy.carrierRules,
  });
  const result = returnRateResultSchema.safeParse(input.result);
  const guardrails = input.policy.parcelGuardrails == null ? null : customerReturnShippingGuardrailsSchema.safeParse(input.policy.parcelGuardrails);
  const shipment = input.shipment === undefined ? null : returnRateShipmentSchema.safeParse(input.shipment);
  if (
    !policy.success ||
    !result.success ||
    !Number.isSafeInteger(input.weightGrams) ||
    input.weightGrams <= 0
    || (guardrails !== null && (!guardrails.success || !shipment?.success || shipment.data.parcel.weightGrams !== input.weightGrams))
  ) {
    throw new CustomerReturnRateSelectionError("RETURN_RATE_INPUT_INVALID");
  }
  const shippingPolicy = { ...policy.data, parcelGuardrails: guardrails?.success ? guardrails.data : null };
  const packingLimits = customerReturnPackingLimits(shippingPolicy);
  const dimensions = shipment?.success ? returnShipmentDimensionsMm(shipment.data) : null;
  const eligibleRates: ReturnRateCandidate[] = [];
  const excludedRates: CustomerReturnRateSelection["excludedRates"] = [];
  for (const candidate of result.data.rates) {
    const rule = policy.data.carrierRules.find(row => row.carrierId === candidate.carrierId
      && row.serviceCodes.includes(candidate.serviceCode));
    const serviceAllowed = policy.data.selectionMode === "fixed_service"
      ? policy.data.carrierId === candidate.carrierId && policy.data.serviceCode === candidate.serviceCode
      : rule !== undefined;
    const packingIssue = packingLimits === null ? null : customerReturnPackingIssue(
      packingLimits.filter(limit => limit.serviceCode === candidate.serviceCode), input.weightGrams, dimensions!);
    if (
      isReturnCarrierServiceAllowed(
        policy.data,
        candidate.carrierId,
        candidate.serviceCode,
        input.weightGrams,
      ) && packingIssue === null
    ) {
      eligibleRates.push(candidate);
    } else {
      excludedRates.push({
        carrierId: candidate.carrierId,
        serviceCode: candidate.serviceCode,
        reason:
          !serviceAllowed || packingIssue === "unsupported" ? "not_allowed"
            : packingIssue === "weight" || (rule && !returnCarrierRuleAllowsWeight(rule, input.weightGrams))
            ? "weight_limit"
            : "size_limit",
      });
    }
  }
  if (eligibleRates.length && shippingPolicy.parcelGuardrails?.costProtection) {
    if (!shipment?.success) throw new CustomerReturnRateSelectionError("RETURN_RATE_INPUT_INVALID");
    const ceiling = customerReturnQuotedCostCeiling(shippingPolicy, shipment.data, eligibleRates, input.costReferences ?? []);
    if (ceiling === null) throw new CustomerReturnRateSelectionError("RETURN_RATE_COST_UNVERIFIED");
    for (let index = eligibleRates.length - 1; index >= 0; index--) {
      const candidate = eligibleRates[index];
      if (candidate.amountCents > ceiling) {
        excludedRates.push({ carrierId: candidate.carrierId, serviceCode: candidate.serviceCode, reason: "cost_limit" });
        eligibleRates.splice(index, 1);
      }
    }
    if (!eligibleRates.length) throw new CustomerReturnRateSelectionError("RETURN_RATE_COST_LIMIT");
  }
  eligibleRates.sort(
    (left, right) =>
      left.amountCents - right.amountCents ||
      lexical(left.carrierId, right.carrierId) ||
      lexical(left.serviceCode, right.serviceCode),
  );
  if (eligibleRates.length === 0)
    throw new CustomerReturnRateSelectionError("RETURN_RATE_NONE_ELIGIBLE");
  return { selected: eligibleRates[0], eligibleRates, excludedRates };
}

function lexical(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
