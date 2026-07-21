/**
 * Fail-closed rollout policy for Shopify checkout rates.
 *
 * Registration and delivery-zone assignment are store-level Shopify changes,
 * so a preview theme cannot isolate the callback from normal checkouts. This
 * policy keeps rate exposure under Echelon's control during registration and
 * staged verification.
 */

export type CheckoutRateRolloutMode = "off" | "test" | "live";

export interface CheckoutRateRolloutPolicy {
  mode: CheckoutRateRolloutMode;
  testSkus: ReadonlySet<string>;
  invalidConfiguredMode: boolean;
}

export type CheckoutRateRolloutDecision =
  | {
      shouldQuote: true;
      mode: "test" | "live";
      reasonCode: "TEST_CART_ALLOWED" | "LIVE_ENABLED";
      message: string;
    }
  | {
      shouldQuote: false;
      mode: CheckoutRateRolloutMode;
      reasonCode:
        | "INVALID_MODE_FAIL_CLOSED"
        | "ROLLOUT_DISABLED"
        | "TEST_ALLOWLIST_EMPTY"
        | "TEST_CART_SKU_MISSING"
        | "TEST_CART_SKU_NOT_ALLOWED";
      message: string;
      deniedSkus?: readonly string[];
    };

export interface CheckoutRateRolloutPolicyInput {
  mode?: string | null;
  testSkus?: string | null;
}

/**
 * Parse external configuration without throwing. Missing or invalid modes are
 * intentionally disabled so a configuration typo cannot expose live rates.
 */
export function parseCheckoutRateRolloutPolicy(
  input: CheckoutRateRolloutPolicyInput,
): CheckoutRateRolloutPolicy {
  const configuredMode = input.mode?.trim().toLowerCase() ?? "";
  const validMode = configuredMode === "off"
    || configuredMode === "test"
    || configuredMode === "live";
  const mode: CheckoutRateRolloutMode = configuredMode === "test"
    ? "test"
    : configuredMode === "live"
      ? "live"
      : "off";

  return {
    mode,
    testSkus: new Set(
      (input.testSkus ?? "")
        .split(",")
        .map((sku) => sku.trim())
        .filter((sku) => sku.length > 0),
    ),
    invalidConfiguredMode: configuredMode.length > 0 && !validMode,
  };
}

/**
 * Decide whether one US checkout request may reach the quote pipeline.
 * Test mode requires every line to have an exact allowlisted SKU. Requiring
 * the full cart to match prevents a mixed customer cart from receiving a
 * partially tested Echelon rate.
 */
export function resolveCheckoutRateRollout(
  policy: CheckoutRateRolloutPolicy,
  itemSkus: readonly (string | null)[],
): CheckoutRateRolloutDecision {
  if (policy.invalidConfiguredMode) {
    return {
      shouldQuote: false,
      mode: "off",
      reasonCode: "INVALID_MODE_FAIL_CLOSED",
      message: "Shopify checkout rate mode is invalid; Echelon rates are disabled.",
    };
  }

  if (policy.mode === "off") {
    return {
      shouldQuote: false,
      mode: policy.mode,
      reasonCode: "ROLLOUT_DISABLED",
      message: "Shopify checkout rates are disabled by rollout policy.",
    };
  }

  if (policy.mode === "live") {
    return {
      shouldQuote: true,
      mode: policy.mode,
      reasonCode: "LIVE_ENABLED",
      message: "Shopify checkout rates are enabled for live US traffic.",
    };
  }

  if (policy.testSkus.size === 0) {
    return {
      shouldQuote: false,
      mode: policy.mode,
      reasonCode: "TEST_ALLOWLIST_EMPTY",
      message: "Shopify checkout rate test mode has no configured SKU allowlist.",
    };
  }

  if (itemSkus.some((sku) => sku === null || sku.trim() === "")) {
    return {
      shouldQuote: false,
      mode: policy.mode,
      reasonCode: "TEST_CART_SKU_MISSING",
      message: "Shopify checkout rate test mode requires a SKU on every cart line.",
    };
  }

  const deniedSkus = Array.from(new Set(
    itemSkus
      .filter((sku): sku is string => sku !== null)
      .map((sku) => sku.trim())
      .filter((sku) => !policy.testSkus.has(sku)),
  )).sort();

  if (deniedSkus.length > 0) {
    return {
      shouldQuote: false,
      mode: policy.mode,
      reasonCode: "TEST_CART_SKU_NOT_ALLOWED",
      message: "Shopify checkout cart contains a SKU outside the test allowlist.",
      deniedSkus,
    };
  }

  return {
    shouldQuote: true,
    mode: policy.mode,
    reasonCode: "TEST_CART_ALLOWED",
    message: "Every Shopify checkout cart line is included in the test SKU allowlist.",
  };
}
