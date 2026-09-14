import {
  commerceOriginSchema,
  type CommerceOrigin,
} from "../../../shared/archon-commerce-contract";
function record(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}
/** Only connector configuration and provider-owned order fields are evidence.
 * Never infer TikTok Shop from tags, UTMs, referrers, or campaign names. */
export function classifyCommerceOrigin(
  provider: string,
  shippingConfig: unknown,
  rawPayload: unknown,
): CommerceOrigin {
  const raw = record(rawPayload),
    nested = record(raw.order),
    drop = record(raw.dropship),
    config = record(record(shippingConfig).dropship);
  if (Object.keys(drop).length || config.omsChannel === true)
    return commerceOriginSchema.parse({
      version: 1,
      connector: "dropship",
      salesChannel: "dropship",
      sourceName: null,
      evidence: "dropship_acceptance",
    });
  const p = provider.toLowerCase();
  if (p === "shopify") {
    const supplied = raw.source_name ?? nested.source_name;
    const source =
      typeof supplied === "string" && supplied.trim().length <= 160
        ? supplied.trim().toLowerCase()
        : null;
    const mapping: Record<string, string> = {
      web: "shopify_online",
      tiktok: "tiktok_shop",
      pos: "shopify_pos",
    };
    return commerceOriginSchema.parse({
      version: 1,
      connector: "shopify",
      salesChannel: source
        ? (mapping[source] ?? "shopify_other")
        : "shopify_unknown",
      sourceName: source || null,
      evidence: source ? "provider_source" : "unknown",
    });
  }
  if (p === "ebay" || p === "amazon")
    return commerceOriginSchema.parse({
      version: 1,
      connector: p,
      salesChannel: p,
      sourceName: null,
      evidence: "connector",
    });
  return commerceOriginSchema.parse({
    version: 1,
    connector: "unknown",
    salesChannel: "unknown",
    sourceName: null,
    evidence: "unknown",
  });
}
