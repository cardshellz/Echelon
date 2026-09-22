import { z } from "zod";

// oms.oms_orders.external_order_number is varchar(50). Input has a separate
// bound so surrounding spaces do not reduce the supported reference length.
export const MAX_CUSTOMER_RETURN_ORDER_REFERENCE_LENGTH = 50;
export const MAX_CUSTOMER_RETURN_ORDER_REFERENCE_INPUT_LENGTH = 256;

const containsControlCharacter = /[\u0000-\u001f\u007f-\u009f]/;

export const customerReturnOrderReferenceSchema = z.string()
  .max(MAX_CUSTOMER_RETURN_ORDER_REFERENCE_INPUT_LENGTH)
  .transform((value) => {
    const trimmed = value.trim();
    // Only the conventional leading display marker is optional. Never coerce
    // references to numbers or remove store prefixes, suffixes or inner spaces.
    return trimmed.startsWith("#") ? trimmed.slice(1).trimStart() : trimmed;
  })
  .pipe(z.string()
    .min(1)
    .max(MAX_CUSTOMER_RETURN_ORDER_REFERENCE_LENGTH)
    .refine((value) => !value.startsWith("#") && !containsControlCharacter.test(value)));

export class CustomerReturnOrderReferenceError extends Error {
  readonly code = "CUSTOMER_RETURN_ORDER_REFERENCE_INVALID";

  constructor() {
    super("Enter a valid order reference.");
    this.name = "CustomerReturnOrderReferenceError";
  }
}

export function normalizeCustomerReturnOrderReference(input: unknown): string {
  const result = customerReturnOrderReferenceSchema.safeParse(input);
  if (!result.success) throw new CustomerReturnOrderReferenceError();
  return result.data;
}

/** Exact lookup values only; callers must never turn these into LIKE patterns. */
export function buildCustomerReturnOrderNumberAliases(input: unknown): readonly string[] {
  const normalized = normalizeCustomerReturnOrderReference(input);
  // Normalization already validated the input's type. Preserve its literal
  // trimmed form for a stored name such as '# 0012', without broad matching.
  const original = (input as string).trim();
  return Object.freeze([...new Set([normalized, `#${normalized}`, original])]);
}
