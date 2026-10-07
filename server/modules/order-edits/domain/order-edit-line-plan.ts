import { z } from "zod";
import { OrderEditError } from "./order-edit-error";

const identity = z.string().min(1).max(500);
const quantity = z.number().int().safe().nonnegative();
const MAX_EDIT_LINES = 250;
const inputSchema = z
  .object({
    originals: z
      .array(z.object({ id: identity, variantId: identity, quantity }).strict())
      .max(MAX_EDIT_LINES),
    changes: z
      .array(z.object({ lineItemId: identity, quantity }).strict())
      .max(MAX_EDIT_LINES),
    additions: z
      .array(
        z
          .object({ variantId: identity, quantity: quantity.positive() })
          .strict(),
      )
      .max(MAX_EDIT_LINES),
    protectedLineIds: z.array(identity).max(MAX_EDIT_LINES),
  })
  .strict();

export interface OrderEditStagedAddition {
  variantId: string;
  quantity: number;
  /** Extra units requested for an original line that Shopify cannot increase. */
  quantityIncreaseOfLineId?: string;
}

/** Preserve the commercial request while resolving Shopify's protected-line constraint. */
export function resolveOrderEditLinePlan(input: z.input<typeof inputSchema>): {
  changes: Array<{ lineItemId: string; quantity: number }>;
  additions: OrderEditStagedAddition[];
} {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success)
    throw new OrderEditError(
      "EDIT_PLAN_INVALID",
      "Invalid quantities in the staged edit plan.",
    );
  const value = parsed.data;
  const originals = new Map(value.originals.map((line) => [line.id, line]));
  const additions = new Map<string, OrderEditStagedAddition>(
    value.additions.map((line) => [line.variantId, { ...line }]),
  );
  const protectedIds = new Set(value.protectedLineIds);
  if (
    originals.size !== value.originals.length ||
    additions.size !== value.additions.length ||
    new Set(value.changes.map((line) => line.lineItemId)).size !==
      value.changes.length ||
    protectedIds.size !== value.protectedLineIds.length ||
    [...protectedIds].some((id) => !originals.has(id))
  ) {
    throw new OrderEditError(
      "EDIT_PLAN_INVALID",
      "Duplicate or unknown identities in the staged edit plan.",
    );
  }
  const changes = value.changes.map((change) => {
    const original = originals.get(change.lineItemId);
    if (!original)
      throw new OrderEditError(
        "EDIT_PLAN_INVALID",
        "The staged edit changes an unknown original line.",
      );
    if (!protectedIds.has(original.id) || change.quantity <= original.quantity)
      return { ...change };
    const addition = additions.get(original.variantId);
    if (
      addition?.quantityIncreaseOfLineId &&
      addition.quantityIncreaseOfLineId !== original.id
    ) {
      throw new OrderEditError(
        "AMBIGUOUS_IDENTITY",
        "Multiple protected lines for the same variant require staff review.",
      );
    }
    const extra =
      BigInt(change.quantity) -
      BigInt(original.quantity) +
      BigInt(addition?.quantity ?? 0);
    if (extra > BigInt(Number.MAX_SAFE_INTEGER))
      throw new OrderEditError(
        "EDIT_PLAN_INVALID",
        "The additional quantity exceeds the supported range.",
      );
    additions.set(original.variantId, {
      variantId: original.variantId,
      quantity: Number(extra),
      quantityIncreaseOfLineId: original.id,
    });
    return { lineItemId: original.id, quantity: original.quantity };
  });
  if (value.originals.length + additions.size > MAX_EDIT_LINES) {
    throw new OrderEditError(
      "EDIT_PLAN_INVALID",
      "The staged edit exceeds the supported line limit.",
    );
  }
  return { changes, additions: [...additions.values()] };
}
