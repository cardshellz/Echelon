import { z } from "zod";
import {
  orderEditCombinesWithSchema,
  orderEditDiscountClassSchema,
} from "@shared/order-edits/order-edit-codes";
import { OrderEditError } from "./order-edit-error";

const discountSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    classes: z.array(orderEditDiscountClassSchema).min(1).max(3),
    combinesWith: orderEditCombinesWithSchema,
  })
  .strict();
const inputSchema = z
  .object({
    existing: z.array(discountSchema).max(250),
    proposed: z.array(discountSchema).min(1).max(5),
  })
  .strict();
export type OrderEditCombinationDiscount = z.infer<typeof discountSchema>;
const permission = {
  PRODUCT: "productDiscounts",
  ORDER: "orderDiscounts",
  SHIPPING: "shippingDiscounts",
} as const;

/** Admission only. Native eligibility/allocation verification and redemption are separate gates. */
export function assertOrderEditCodeCombinations(
  raw: z.infer<typeof inputSchema>,
): void {
  const parsed = inputSchema.safeParse(raw);
  if (!parsed.success)
    throw new OrderEditError(
      "ORDER_EDIT_CODE_RULES_UNAVAILABLE",
      "We could not verify whether this code can be combined with your order's discounts. No code was applied.",
    );
  const { existing, proposed } = parsed.data;
  const ids = [...existing, ...proposed].map((discount) => discount.id);
  if (new Set(ids).size !== ids.length)
    throw new OrderEditError(
      "ORDER_EDIT_CODE_ALREADY_APPLIED",
      "This discount is already on your order or in your changes.",
    );
  for (let index = 0; index < proposed.length; index++) {
    const candidate = proposed[index];
    for (const other of [...existing, ...proposed.slice(0, index)]) {
      const permitted =
        other.classes.every(
          (kind) => candidate.combinesWith[permission[kind]],
        ) &&
        candidate.classes.every((kind) => other.combinesWith[permission[kind]]);
      // Shopify never stacks two shipping discounts, even when both class flags are true.
      const duplicateShipping =
        candidate.classes.includes("SHIPPING") &&
        other.classes.includes("SHIPPING");
      const productOverlap =
        candidate.classes.includes("PRODUCT") &&
        other.classes.includes("PRODUCT");
      if (!permitted || duplicateShipping || productOverlap)
        throw new OrderEditError(
          "ORDER_EDIT_CODE_COMBINATION_NOT_ALLOWED",
          `${candidate.label} can't be combined with ${other.label}. Your existing discounts have not changed.`,
        );
    }
  }
}
