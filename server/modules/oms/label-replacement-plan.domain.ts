import { z } from "zod";
import { MAX_LABEL_REPLACEMENT_CANDIDATES, MAX_LABEL_REPLACEMENT_ITEMS,
  scopeLabelReplacementPredecessors } from "./label-replacement-scope.domain";

const id = z.number().int().positive().safe();
const quantity = z.number().int().positive().max(2_147_483_647);
const providerOrderId = z.string().trim().min(1).max(100).nullable();
const content = z.object({ sourceItemId: id, quantity }).strict();
const predecessor = content.extend({ physicalItemId: id, physicalShipmentId: id, providerOrderId,
  labelStatus: z.enum(["active", "voided", "superseded", "unknown"]), carrierPossession: z.boolean() }).strict();
const candidate = z.object({ labelId: id, providerOrderId,
  contents: z.array(content).min(1).max(MAX_LABEL_REPLACEMENT_ITEMS) }).strict();
const inputSchema = z.object({ labelId: id,
  previous: z.array(predecessor).min(1).max(MAX_LABEL_REPLACEMENT_ITEMS),
  candidates: z.array(candidate).min(1).max(MAX_LABEL_REPLACEMENT_CANDIDATES),
}).strict();
export type LabelReplacementPlanInput = z.input<typeof inputSchema>;
export type LabelReplacementPlan =
  | { readonly outcome: "transfer"; readonly physicalItemIds: readonly number[]; readonly labelIds: readonly number[] }
  | { readonly outcome: "waiting" | "review"; readonly reason: string };

/** An entire connected repack commits together: old A(2) -> new B(1), C(1).
 * Lineage isolates ordinary relabels. A merge may expand only into voided
 * allocations of the same canonical source. Units are never borrowed from an
 * active sibling. Incomplete batches wait; over-allocation is not guessed away.
 * Repository admission separately proves complete label histories, channel
 * cancellations, unchanged snapshots under locks, and full package coverage. */
export function planLabelReplacement(input: LabelReplacementPlanInput): LabelReplacementPlan {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) return { outcome: "review", reason: "invalid_replacement_evidence" };
  const { labelId, previous, candidates } = parsed.data;
  if (new Set(previous.map(item => item.physicalItemId)).size !== previous.length
    || new Set(candidates.map(item => item.labelId)).size !== candidates.length
    || candidates.some(label => new Set(label.contents.map(item => item.sourceItemId)).size !== label.contents.length)) {
    return { outcome: "review", reason: "ambiguous_replacement_allocation" };
  }
  const scopes = new Map<number, readonly number[]>();
  for (const label of candidates) {
    const scope = scopeLabelReplacementPredecessors({ providerOrderId: label.providerOrderId,
      sourceItemIds: label.contents.map(item => item.sourceItemId),
      previous: previous.map(({ quantity: _quantity, carrierPossession: _possession, ...item }) => item) });
    if (scope.outcome !== "scoped") return scope;
    scopes.set(label.labelId, scope.physicalItemIds);
  }
  if (!scopes.has(labelId)) return { outcome: "review", reason: "replacement_label_missing" };
  const selectedLabels = new Set([labelId]);
  const selectedItems = new Set(scopes.get(labelId));
  const totals = (items: readonly z.infer<typeof content>[]) => {
    const result = new Map<number, bigint>();
    for (const item of items) result.set(item.sourceItemId, (result.get(item.sourceItemId) ?? BigInt(0)) + BigInt(item.quantity));
    return result;
  };
  let changed = true;
  while (changed) {
    const size = selectedLabels.size + selectedItems.size;
    const packages = new Set(previous.filter(item => selectedItems.has(item.physicalItemId)).map(item => item.physicalShipmentId));
    for (const item of previous) if (packages.has(item.physicalShipmentId)) selectedItems.add(item.physicalItemId);
    for (const label of candidates) {
      if (scopes.get(label.labelId)!.some(itemId => selectedItems.has(itemId))) selectedLabels.add(label.labelId);
      if (selectedLabels.has(label.labelId)) for (const itemId of scopes.get(label.labelId)!) selectedItems.add(itemId);
    }
    const oldTotals = totals(previous.filter(item => selectedItems.has(item.physicalItemId)));
    const newTotals = totals(candidates.filter(label => selectedLabels.has(label.labelId)).flatMap(label => label.contents));
    // A larger replacement may merge old packages. Requiring all matching
    // voided portions avoids choosing an arbitrary predecessor by row order.
    for (const [sourceId, amount] of newTotals) {
      if (oldTotals.has(sourceId) && amount > oldTotals.get(sourceId)!) {
        for (const item of previous) if (item.sourceItemId === sourceId && item.labelStatus === "voided") selectedItems.add(item.physicalItemId);
      }
    }
    changed = size !== selectedLabels.size + selectedItems.size;
  }
  const prior = previous.filter(item => selectedItems.has(item.physicalItemId));
  if (prior.length === 0) return { outcome: "review", reason: "replacement_predecessor_missing" };
  if (prior.some(item => item.carrierPossession)) return { outcome: "review", reason: "replaced_label_has_carrier_possession" };
  const oldTotals = totals(prior);
  const newTotals = totals(candidates.filter(label => selectedLabels.has(label.labelId)).flatMap(label => label.contents));
  if (prior.some(item => item.labelStatus !== "voided")) {
    if ([...oldTotals].some(([sourceId, amount]) => (newTotals.get(sourceId) ?? BigInt(0)) < amount)
      && new Set(prior.map(item => item.physicalShipmentId)).size > 1) return { outcome: "review", reason: "ambiguous_replacement_allocation" };
    return { outcome: "waiting", reason: "awaiting_replaced_label_void" };
  }
  if ([...oldTotals].some(([sourceId, amount]) => (newTotals.get(sourceId) ?? BigInt(0)) > amount)) {
    return { outcome: "review", reason: "multiple_active_replacement_candidates" };
  }
  if ([...oldTotals].some(([sourceId, amount]) => (newTotals.get(sourceId) ?? BigInt(0)) < amount)) {
    return { outcome: "waiting", reason: "replacement_repack_incomplete" };
  }
  return { outcome: "transfer", physicalItemIds: Object.freeze([...selectedItems].sort((a, b) => a - b)),
    labelIds: Object.freeze([...selectedLabels].sort((a, b) => a - b)) };
}
