import { z } from "zod";

const positiveInteger = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const itemSchema = z.object({ sourceItemId: positiveInteger, quantity: positiveInteger }).strict();
const previousSchema = itemSchema.extend({
  physicalItemId: positiveInteger,
  labelStatus: z.enum(["active", "voided", "superseded", "unknown"]),
  carrierPossession: z.boolean(),
}).strict();
const inputSchema = z.object({
  contents: z.array(itemSchema).min(1).max(500),
  previous: z.array(previousSchema).min(1).max(500),
}).strict();

export type LabelReplacementDecision =
  | { readonly outcome: "transfer"; readonly physicalItemIds: readonly number[] }
  | { readonly outcome: "waiting" | "review"; readonly reason: string };

/** Replacement changes package ownership, never the customer's purchased quantity.
 * Partial repartition requires a separate explicit allocation plan. */
export function decideEbayLabelReplacement(input: z.input<typeof inputSchema>): LabelReplacementDecision {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) return { outcome: "review", reason: "invalid_replacement_evidence" };
  const { contents, previous } = parsed.data;
  if (new Set(contents.map(item => item.sourceItemId)).size !== contents.length
    || new Set(previous.map(item => item.sourceItemId)).size !== previous.length
    || new Set(previous.map(item => item.physicalItemId)).size !== previous.length) {
    return { outcome: "review", reason: "ambiguous_replacement_allocation" };
  }
  if (previous.some(item => item.carrierPossession)) {
    return { outcome: "review", reason: "replaced_label_has_carrier_possession" };
  }
  if (previous.some(item => !contents.some(target => target.sourceItemId === item.sourceItemId
    && target.quantity === item.quantity))) {
    return { outcome: "review", reason: "replacement_quantity_changed" };
  }
  if (previous.some(item => item.labelStatus !== "voided")) {
    return { outcome: "waiting", reason: "awaiting_replaced_label_void" };
  }
  return { outcome: "transfer", physicalItemIds: Object.freeze(previous.map(item => item.physicalItemId).sort((a, b) => a - b)) };
}
