import { z } from "zod";
import {
  orderEditCodePricingSchema,
  type OrderEditCodePricing,
} from "@shared/order-edits/order-edit-codes";
import { priceOrderEditDiscounts } from "./order-edit-discount-engine";
import { priceOrderEditCodes } from "./order-edit-code-pricing";
import { sumOrderEditCents } from "./order-edit-financials";
import { OrderEditError } from "./order-edit-error";

const protectedIdsSchema = z
  .array(z.string().min(1))
  .max(250)
  .refine((ids) => new Set(ids).size === ids.length);

/**
 * Shopify cannot add a manual discount to an automatically discounted original
 * line. Keep those product prices intact and represent the already-approved
 * ORDER discount on editable lines. This changes allocation, never entitlement,
 * combination rules, the approved saving, or product/member prices.
 *
 * When new lines cannot carry the full saving, explicitly replace discounted
 * originals with the same real variants. The adapter must verify replaceable
 * item metadata, native tax, and recovery before allowing submission.
 * The adapter must also prove that this allocation leaves shipping and every
 * tax amount unchanged before preparing or committing the edit.
 */
export function allocateOrderEditNativeCodePricing(
  input: OrderEditCodePricing,
  protectedLineIds: readonly string[],
): OrderEditCodePricing {
  const pricing = orderEditCodePricingSchema.parse(input);
  const protectedIds = new Set(protectedIdsSchema.parse(protectedLineIds));
  if (
    pricing.lines.some(
      (line) => line.preserveAutomaticDiscount && !protectedIds.has(line.id),
    )
  )
    throw new OrderEditError(
      "ORDER_EDIT_CODE_ALLOCATION_IDENTITY_INVALID",
      "An existing automatic discount could not be verified. Your order has not changed.",
    );
  const native = pricing.lines.filter((line) => line.nativeDiscountCents);
  if (
    !native.length &&
    !pricing.lines.some((line) => protectedIds.has(line.id))
  )
    return pricing;
  if (
    pricing.rules.some(
      (rule) => rule.classes.length !== 1 || rule.classes[0] !== "ORDER",
    )
  )
    throw new OrderEditError(
      "ORDER_EDIT_CODE_ALLOCATION_SCOPE_INVALID",
      "The discount's item eligibility could not be verified. No code was used.",
    );
  const editable = pricing.lines.filter(
    (line) => !protectedIds.has(line.id) && !line.nativeDiscountCents,
  );
  const saving = sumOrderEditCents(
    pricing.applications.map((entry) => entry.amountCents),
  );
  const replaceAutomatic =
    saving > sumOrderEditCents(editable.map((line) => line.productNetCents));
  if (replaceAutomatic && !native.length)
    return orderEditCodePricingSchema.parse({
      ...pricing,
      lines: pricing.lines.map((line) => ({
        ...line,
        ...(protectedIds.has(line.id)
          ? line.netCents < line.productNetCents
            ? { replacesAutomaticDiscount: true }
            : { preserveAutomaticDiscount: true }
          : {}),
      })),
    });
  const eligible = replaceAutomatic
    ? pricing.lines.filter((line) => !line.nativeDiscountCents)
    : editable;
  // Native checkout allocations cannot be moved to another item or folded into
  // the new reward. Shopify also refuses a second manual discount on those rows.
  if (saving > sumOrderEditCents(eligible.map((line) => line.productNetCents)))
    throw new OrderEditError(
      "ORDER_EDIT_CODE_NATIVE_ALLOCATION_UNSUPPORTED",
      "This reward needs more eligible merchandise in your changes. Your original discount and saved reward have not changed.",
    );

  // Reuse the exact-cent allocator. A single budget represents all accepted
  // order discounts; each code's verified terms and amount remain in pricing.
  const allocated = priceOrderEditDiscounts({
    rules: [
      {
        key: "native-order-adjustment",
        label: "Order discounts",
        value: { type: "fixed", amountCents: saving },
      },
    ],
    lines: eligible.map((line) => ({
      id: line.id,
      subtotalCents: line.productNetCents,
    })),
  });
  const amounts = new Map(
    allocated.allocations.map((entry) => [entry.lineId, entry.amountCents]),
  );
  return orderEditCodePricingSchema.parse({
    ...pricing,
    lines: pricing.lines.map((line) => ({
      ...line,
      netCents:
        line.productNetCents -
        (line.nativeDiscountCents ?? 0) -
        (amounts.get(line.id) ?? 0),
      ...(protectedIds.has(line.id)
        ? (amounts.get(line.id) ?? 0) > 0
          ? { replacesAutomaticDiscount: true }
          : { preserveAutomaticDiscount: true }
        : {}),
    })),
  });
}

/** Rebuild the reference allocation from logical items, before native penny splits. */
export function referenceOrderEditCodePricing(
  input: OrderEditCodePricing,
): OrderEditCodePricing {
  const pricing = orderEditCodePricingSchema.parse(input);
  const bySource = new Map<
    string,
    {
      id: string;
      variantId: string;
      quantity: number;
      grossCents: number;
      productNetCents: number;
      nativeDiscountCents?: number;
    }
  >();
  for (const line of pricing.lines) {
    const previous = bySource.get(line.sourceId);
    const grossCents = sumOrderEditCents([
      Number(BigInt(line.quantity) * BigInt(line.retailCents)),
    ]);
    if (
      previous &&
      (previous.variantId !== line.variantId ||
        BigInt(previous.grossCents) !==
          BigInt(line.retailCents) * BigInt(previous.quantity))
    )
      throw new OrderEditError(
        "ORDER_EDIT_CODE_ALLOCATION_IDENTITY_INVALID",
        "The discount's product identities could not be verified.",
      );
    bySource.set(line.sourceId, {
      id: line.sourceId,
      variantId: line.variantId,
      quantity: sumOrderEditCents([previous?.quantity ?? 0, line.quantity]),
      grossCents: sumOrderEditCents([previous?.grossCents ?? 0, grossCents]),
      productNetCents: sumOrderEditCents([
        previous?.productNetCents ?? 0,
        line.productNetCents,
      ]),
      ...(line.nativeDiscountCents || previous?.nativeDiscountCents
        ? {
            nativeDiscountCents: sumOrderEditCents([
              previous?.nativeDiscountCents ?? 0,
              line.nativeDiscountCents ?? 0,
            ]),
          }
        : {}),
    });
  }
  return priceOrderEditCodes(
    [...bySource.values()],
    pricing.rules,
    pricing.newCodes,
    pricing.applications,
    pricing.retainedNativeDiscounts,
  );
}
