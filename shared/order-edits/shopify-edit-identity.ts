// Shopify returns numeric identities for original calculated lines and UUIDs for added lines.
// Only this transient resource accepts UUIDs; order, variant, and persisted line IDs remain numeric.
export const SHOPIFY_CALCULATED_LINE_ID_PATTERN =
  /^gid:\/\/shopify\/CalculatedLineItem\/(?:[1-9][0-9]*|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
