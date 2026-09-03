export interface DropshipEbayFulfillmentServiceCapability {
  carrier: string;
  ebayServiceCode: string;
  serviceName: string;
  shipStationCarrierCode: string;
  shipStationServiceCode: string;
}

export interface DropshipEbayFulfillmentCapability {
  marketplaceId: string;
  requiredHandlingTimeBusinessDays: number;
  destinationCountry: "US";
  destinationRegions: string[];
  destinationCoverageComplete: boolean;
  supportedServices: DropshipEbayFulfillmentServiceCapability[];
  evidenceHash: string;
  source: {
    omsChannelId: number;
    originWarehouseId: number;
    rateBookId: number;
    rateBookCode: string;
    rateTableId: number;
    serviceLevelId: number;
    fulfillmentRoutingRevision: number;
  };
}

export interface DropshipEbayFulfillmentPolicy {
  id: string;
  name: string;
  marketplaceId: string | null;
  handlingTime: {
    value: number | null;
    unit: string | null;
  } | null;
  shippingOptions: Array<{
    optionType: string;
    shippingServiceCodes: string[];
  }>;
  localPickup: boolean;
  freightShipping: boolean;
  pickupDropOff: boolean;
}

export interface DropshipEbayFulfillmentPolicyIssue {
  code: string;
  message: string;
}

export interface DropshipEbayFulfillmentPolicyCompatibility {
  compatible: boolean;
  issues: DropshipEbayFulfillmentPolicyIssue[];
}

/**
 * Compares seller-owned eBay fulfillment promises with Card Shellz's current
 * operational capabilities. Shipping charges are intentionally absent: the
 * vendor owns listing price and buyer-facing shipping charges, while this
 * invariant covers only promises Card Shellz must physically perform.
 */
export function evaluateDropshipEbayFulfillmentPolicyCompatibility(input: {
  capability: DropshipEbayFulfillmentCapability;
  policy: DropshipEbayFulfillmentPolicy;
}): DropshipEbayFulfillmentPolicyCompatibility {
  const issues: DropshipEbayFulfillmentPolicyIssue[] = [];
  const { capability, policy } = input;

  if (!policy.marketplaceId) {
    issues.push(issue(
      "marketplace_missing",
      "Policy marketplace could not be verified.",
    ));
  } else if (policy.marketplaceId !== capability.marketplaceId) {
    issues.push(issue(
      "marketplace_mismatch",
      `Policy is for ${policy.marketplaceId}, not ${capability.marketplaceId}.`,
    ));
  }

  if (!capability.destinationCoverageComplete) {
    issues.push(issue(
      "destination_coverage_incomplete",
      "Card Shellz destination coverage is incomplete, so this policy cannot be verified safely.",
    ));
  }

  const handlingTime = policy.handlingTime;
  if (!handlingTime || handlingTime.value === null || handlingTime.unit === null) {
    issues.push(issue(
      "handling_time_missing",
      "Policy must specify handling time in business days.",
    ));
  } else if (handlingTime.unit !== "DAY") {
    issues.push(issue(
      "handling_time_unit_unsupported",
      `Policy handling-time unit ${handlingTime.unit} is not supported.`,
    ));
  } else if (
    !Number.isInteger(handlingTime.value)
    || handlingTime.value < capability.requiredHandlingTimeBusinessDays
  ) {
    issues.push(issue(
      "handling_time_too_short",
      `Policy must allow at least ${capability.requiredHandlingTimeBusinessDays} business day${capability.requiredHandlingTimeBusinessDays === 1 ? "" : "s"} of handling time.`,
    ));
  }

  if (policy.localPickup) {
    issues.push(issue(
      "local_pickup_unsupported",
      "Local pickup is not a Card Shellz fulfillment capability.",
    ));
  }
  if (policy.freightShipping) {
    issues.push(issue(
      "freight_shipping_unsupported",
      "Freight shipping is not a Card Shellz dropship fulfillment capability.",
    ));
  }
  if (policy.pickupDropOff) {
    issues.push(issue(
      "pickup_drop_off_unsupported",
      "Pickup/drop-off fulfillment is not a Card Shellz dropship capability.",
    ));
  }

  const supportedServiceCodes = new Set(
    capability.supportedServices.map((service) => service.ebayServiceCode),
  );
  let domesticServiceCount = 0;
  for (const shippingOption of policy.shippingOptions) {
    if (shippingOption.optionType === "INTERNATIONAL") {
      issues.push(issue(
        "international_direct_shipping_unsupported",
        "Direct international shipping is outside Card Shellz's current destination coverage.",
      ));
      continue;
    }
    if (shippingOption.optionType !== "DOMESTIC") {
      issues.push(issue(
        "shipping_option_type_unsupported",
        `Shipping option type ${shippingOption.optionType} is not supported.`,
      ));
      continue;
    }
    domesticServiceCount += shippingOption.shippingServiceCodes.length;
    for (const serviceCode of shippingOption.shippingServiceCodes) {
      if (!supportedServiceCodes.has(serviceCode)) {
        issues.push(issue(
          `shipping_service_unsupported:${serviceCode}`,
          `Shipping service ${serviceCode} is not allowed by Card Shellz's fulfillment routing.`,
        ));
      }
    }
  }
  if (domesticServiceCount === 0) {
    issues.push(issue(
      "domestic_shipping_service_required",
      "Policy must include at least one supported domestic shipping service.",
    ));
  }

  return {
    compatible: issues.length === 0,
    issues: deduplicateIssues(issues),
  };
}

function issue(code: string, message: string): DropshipEbayFulfillmentPolicyIssue {
  return { code, message };
}

function deduplicateIssues(
  issues: readonly DropshipEbayFulfillmentPolicyIssue[],
): DropshipEbayFulfillmentPolicyIssue[] {
  const unique = new Map<string, DropshipEbayFulfillmentPolicyIssue>();
  for (const current of issues) {
    unique.set(current.code, current);
  }
  return [...unique.values()];
}
