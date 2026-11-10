/** Shopify's REST numeric ID and GraphQL GID address the same resource.
 * Reject other GID types instead of inferring an ID from a numeric suffix. */
export function shopifyListingIdentityAliases(
  kind: "Product" | "ProductVariant",
  value: string | null,
): readonly [string, string] | null {
  if (!value) return null;
  const match = new RegExp(`^(?:gid://shopify/${kind}/)?([1-9][0-9]*)$`).exec(value);
  // JavaScript's `$` also matches before a final newline. Only an exact ID is
  // evidence that the REST and GraphQL forms name the same member.
  if (!match || match[0] !== value) return null;
  const numericId = match[1];
  return [numericId, `gid://shopify/${kind}/${numericId}`];
}
