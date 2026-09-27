import {
  customerReturnCarrierPolicySchema,
  isReturnCarrierServiceAllowed,
  returnCarrierRuleAllowsWeight,
  type CustomerReturnCarrierPolicy,
} from "@shared/returns/customer-return-carrier-policy";
import {
  returnRateResultSchema,
  type ReturnRateCandidate,
  type ReturnRateResult,
} from "../../shipping-engine/application/return-rate-provider.port";

export class CustomerReturnRateSelectionError extends Error {
  constructor(
    readonly code: "RETURN_RATE_INPUT_INVALID" | "RETURN_RATE_NONE_ELIGIBLE",
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
    reason: "not_allowed" | "weight_limit";
  }[];
}

/** No provider calls, mutations, clock or display-name identity matching.
 * The provider has already rated the exact return manifest. Compare only
 * complete USD totals from services admitted by the current administrator policy.
 */
export function selectCustomerReturnRate(input: {
  policy: CustomerReturnCarrierPolicy;
  weightGrams: number;
  result: ReturnRateResult;
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
  if (
    !policy.success ||
    !result.success ||
    !Number.isSafeInteger(input.weightGrams) ||
    input.weightGrams <= 0
  ) {
    throw new CustomerReturnRateSelectionError("RETURN_RATE_INPUT_INVALID");
  }
  const eligibleRates: ReturnRateCandidate[] = [];
  const excludedRates: CustomerReturnRateSelection["excludedRates"] = [];
  for (const candidate of result.data.rates) {
    if (
      isReturnCarrierServiceAllowed(
        policy.data,
        candidate.carrierId,
        candidate.serviceCode,
        input.weightGrams,
      )
    ) {
      eligibleRates.push(candidate);
    } else {
      const rule = policy.data.carrierRules.find(
        (row) =>
          row.carrierId === candidate.carrierId &&
          row.serviceCodes.includes(candidate.serviceCode),
      );
      excludedRates.push({
        carrierId: candidate.carrierId,
        serviceCode: candidate.serviceCode,
        reason:
          rule && !returnCarrierRuleAllowsWeight(rule, input.weightGrams)
            ? "weight_limit"
            : "not_allowed",
      });
    }
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
