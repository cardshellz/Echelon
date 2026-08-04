import { createHash } from "node:crypto";

import { MarketplaceListingReplacementError } from "./errors";

export type CanonicalJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly CanonicalJsonValue[]
  | { readonly [key: string]: CanonicalJsonValue };

/**
 * Produces stable JSON for the deliberately restricted command vocabulary.
 * Floating point values, undefined, Dates, BigInts, and class instances are
 * rejected so equivalent requests cannot acquire environment-dependent hashes.
 */
export function canonicalJson(value: CanonicalJsonValue): string {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return JSON.stringify(value);
  }

  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new MarketplaceListingReplacementError(
        "MARKETPLACE_LISTING_CANONICAL_NUMBER_INVALID",
        "Canonical listing replacement values must use safe integers.",
        { value },
      );
    }
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }

  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new MarketplaceListingReplacementError(
        "MARKETPLACE_LISTING_CANONICAL_OBJECT_INVALID",
        "Canonical listing replacement values must be plain objects.",
      );
    }

    // Array.isArray does not narrow a readonly-array union for indexed access.
    // The runtime branch above has already excluded every array value.
    const objectValue = value as { readonly [key: string]: CanonicalJsonValue };
    const entries = Object.keys(objectValue)
      .sort(compareCanonicalText)
      .map(
        (key) => `${JSON.stringify(key)}:${canonicalJson(objectValue[key]!)}`,
      );
    return `{${entries.join(",")}}`;
  }

  throw new MarketplaceListingReplacementError(
    "MARKETPLACE_LISTING_CANONICAL_VALUE_INVALID",
    "Listing replacement request contains a non-JSON canonical value.",
    { valueType: typeof value },
  );
}

export function sha256Canonical(value: CanonicalJsonValue): string {
  return createHash("sha256")
    .update(canonicalJson(value), "utf8")
    .digest("hex");
}

export function compareCanonicalText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
