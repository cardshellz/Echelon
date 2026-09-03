export type KnownCarrierCode = "USPS" | "FEDEX" | "UPS" | "DHL";

function normalizedCarrierText(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  const normalized = String(raw).trim();
  return normalized.length > 0 ? normalized : null;
}

/**
 * Resolves vendor-specific carrier aliases only when the carrier family is
 * known. Unknown values remain distinguishable and therefore cannot become
 * compatible merely because both would otherwise map to a generic bucket.
 */
export function knownCarrierCode(raw: unknown): KnownCarrierCode | null {
  const normalized = normalizedCarrierText(raw)?.toUpperCase();
  if (!normalized) return null;
  if (
    normalized === "USPS"
    || normalized === "STAMPS_COM"
    || normalized === "US POSTAL SERVICE"
  ) return "USPS";
  if (normalized === "FEDEX" || normalized === "FEDERAL EXPRESS") return "FEDEX";
  if (
    normalized === "UPS"
    || normalized === "UPS_WALLETED"
    || normalized === "UNITED PARCEL SERVICE"
  ) return "UPS";
  if (normalized.startsWith("DHL")) return "DHL";
  return null;
}

/**
 * Produces an equality key for package identity checks. Known aliases share a
 * canonical family; unknown values use their own case-insensitive raw key.
 */
export function carrierIdentity(raw: unknown): string | null {
  const normalized = normalizedCarrierText(raw);
  if (!normalized) return null;
  return knownCarrierCode(normalized) ?? `RAW:${normalized.toUpperCase()}`;
}

/**
 * Canonicalizes known carriers for durable commands while preserving an
 * unknown provider value verbatim for provider compatibility and auditability.
 */
export function canonicalCarrierValue(raw: unknown): string | null {
  const normalized = normalizedCarrierText(raw);
  if (!normalized) return null;
  return knownCarrierCode(normalized) ?? normalized;
}
