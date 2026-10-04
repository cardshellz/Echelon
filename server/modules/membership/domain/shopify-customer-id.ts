/**
 * Shopify customer id normalization for member lookup.
 *
 * The membership app (cardshellz/shellz-club-app) owns member identity. Its
 * lookup, getMemberByShopifyId in server/infrastructure/repos/memberRepo.ts,
 * normalizes the id with normalizeShopifyCustomerIdValue and then matches both
 * Shopify formats. Echelon must find exactly the member that app would find,
 * so this mirrors that rule. Change it only together with the membership app.
 * Pure.
 */

export const SHOPIFY_CUSTOMER_GID_PREFIX = "gid://shopify/Customer/";

/**
 * Longer than any real Shopify customer id (numeric ids are ~14 digits, the GID
 * form adds 23 characters). A longer value is bad data, not an identity; this
 * guard is Echelon's addition to the membership app's rule.
 */
export const SHOPIFY_CUSTOMER_ID_MAX_LENGTH = 255;

const GID_PREFIX_PATTERN = /^gid:\/\/shopify\/Customer\//i;
const QUOTED_PATTERN = /^'(.+)'$/;
const TRAILING_DECIMAL_ZERO_PATTERN = /^\d+\.0+$/;
const NUMERIC_PATTERN = /^\d+$/;

/**
 * Returns the bare Shopify customer id, or null when nothing usable remains.
 * Like the membership app, scientific notation ("2.33362E+13") is left as is:
 * expanding it could produce a plausible but wrong id.
 */
export function normalizeShopifyCustomerId(value: unknown): string | null {
  // The membership app reads String(input || ""): any falsy value (0, false,
  // "") is no id at all, not the text "0" or "false".
  if (!value) return null;
  let normalized = String(value).trim();
  if (!normalized) return null;

  normalized = normalized.replace(GID_PREFIX_PATTERN, "").trim();
  // Spreadsheet export artifacts: "3,978,054,467,743", "'3978054467743'", "3978054467743.0".
  normalized = normalized.replace(/,/g, "");
  normalized = normalized.replace(QUOTED_PATTERN, "$1");
  if (TRAILING_DECIMAL_ZERO_PATTERN.test(normalized)) {
    normalized = normalized.replace(/\.0+$/, "");
  }
  // Last, as in the membership app: "' 123 '" becomes "123".
  normalized = normalized.trim();

  if (!normalized || normalized.length > SHOPIFY_CUSTOMER_ID_MAX_LENGTH) return null;
  return normalized;
}

/**
 * The stored forms a normalized id may appear in. Members can carry either the
 * numeric id or the GID, so a numeric id matches both.
 */
export function shopifyCustomerIdCandidates(normalizedId: string): readonly string[] {
  return NUMERIC_PATTERN.test(normalizedId)
    ? [normalizedId, `${SHOPIFY_CUSTOMER_GID_PREFIX}${normalizedId}`]
    : [normalizedId];
}
