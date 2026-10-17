import type { z } from "zod";

/**
 * The request key prefixes only a listing rules conversion writes (PR 11,
 * plan D12), and the one refusal every vendor key schema that can reach a
 * table the conversion writes shares. A leaf (zod types only), so the
 * content, eBay rules, pricing rules and listing-settings contracts import
 * it without an import cycle through listing-rules-conversion.ts.
 */

/** The system job's key (plan D12): `rules-conversion:<storeConnectionId>`, one per store, ever. */
export const RULES_CONVERSION_SYSTEM_KEY_PREFIX = "rules-conversion:";
/** Every revision key a conversion writes (plan D12): `lc:<sha256(conversion key)>:<kind>:<id>`. */
export const LISTING_CONVERSION_CHILD_KEY_PREFIX = "lc:";
/**
 * Key prefixes a vendor never sends (the client's keys are `<intent>:<uuid>`,
 * such as `ls-convert:…` or `listing-content:…`). Both are computable from
 * public facts: the system key from the store id, each child key from its
 * parent. The system's record shares the vendor's
 * `UNIQUE (vendor_id, idempotency_key)`, so a vendor key
 * `rules-conversion:<his other store>` would take the job's one key for that
 * store. A child key sent to the content, eBay rules or PR 9 product and
 * category saves would sit in a revision table the conversion later writes
 * under the same unique key, so that store's clean conversion would refuse
 * forever. Refused (400) by every vendor key schema that reaches those
 * tables; a row stored before the refusal is the 409 key conflict
 * (REQUEST_KEY_CONSTRAINTS).
 */
export const RESERVED_CONVERSION_KEY_PREFIXES = [RULES_CONVERSION_SYSTEM_KEY_PREFIX, LISTING_CONVERSION_CHILD_KEY_PREFIX] as const;

/** The refusal's issue message (the route answers it in its own 400 shape). */
export const RESERVED_CONVERSION_KEY_MESSAGE = "This key is kept for the system's own conversions.";

/** True for a key only the system job or a conversion's own revisions may use. Case-sensitive, as the unique keys are. */
export function isReservedConversionKey(key: string): boolean {
  return RESERVED_CONVERSION_KEY_PREFIXES.some((prefix) => key.startsWith(prefix));
}

/** A vendor's request key schema that also refuses the reserved prefixes (a `custom` issue on the key). */
export function refusingReservedConversionKeys<T extends z.ZodType<string, z.ZodTypeDef, string>>(schema: T): z.ZodEffects<T, string, string> {
  return schema.refine((key) => !isReservedConversionKey(key), RESERVED_CONVERSION_KEY_MESSAGE);
}
