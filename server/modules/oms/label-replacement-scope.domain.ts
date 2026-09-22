import { z } from "zod";

// Bound one admission, not the lifetime of an order. An oversized cohort must
// be reviewed rather than partially read and accidentally treated as unique.
export const MAX_LABEL_REPLACEMENT_ITEMS = 500;
export const MAX_LABEL_REPLACEMENT_CANDIDATES = 100;

const identity = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const providerOrderId = z.string().min(1).max(100).refine(value => value === value.trim()).nullable();
const previousItem = z.object({
  physicalItemId: identity,
  physicalShipmentId: identity,
  sourceItemId: identity,
  providerOrderId,
  labelStatus: z.enum(["active", "voided", "superseded", "unknown"]),
}).strict();
const scopeSchema = z.object({
  providerOrderId,
  sourceItemIds: z.array(identity).min(1).max(MAX_LABEL_REPLACEMENT_ITEMS),
  previous: z.array(previousItem).max(MAX_LABEL_REPLACEMENT_ITEMS),
}).strict();

export type LabelReplacementScopeInput = z.input<typeof scopeSchema>;
export type LabelReplacementScope =
  | { readonly outcome: "scoped"; readonly physicalItemIds: readonly number[] }
  | { readonly outcome: "review"; readonly reason: "invalid_replacement_scope" };

/** Select package candidates, NOT transfer authority. The caller must still
 * prove the complete old package, explicit void, exact quantities, no carrier
 * possession, and completion of any channel correction before transferring.
 *
 * A source line can legitimately occur in several provider packages. Prefer
 * the exact provider-order lineage for that line; never the shared WMS header
 * or order key (ShipStation splits can retain that same key). Where a provider
 * recreates/combines orders, keep all candidates so the quantity/uniqueness
 * decision fails closed if the remaining evidence cannot distinguish them.
 */
export function scopeLabelReplacementPredecessors(input: LabelReplacementScopeInput): LabelReplacementScope {
  const parsed = scopeSchema.safeParse(input);
  if (!parsed.success) return { outcome: "review", reason: "invalid_replacement_scope" };
  const { previous, sourceItemIds, providerOrderId: replacementOrderId } = parsed.data;
  if (new Set(sourceItemIds).size !== sourceItemIds.length
    || new Set(previous.map(item => item.physicalItemId)).size !== previous.length) {
    return { outcome: "review", reason: "invalid_replacement_scope" };
  }

  const bySource = new Map<number, typeof previous>();
  const packageIdentities = new Map<number, { providerOrderId: string | null; labelStatus: string }>();
  for (const item of previous) {
    const existing = packageIdentities.get(item.physicalShipmentId);
    if (existing && (existing.providerOrderId !== item.providerOrderId || existing.labelStatus !== item.labelStatus)) {
      return { outcome: "review", reason: "invalid_replacement_scope" };
    }
    packageIdentities.set(item.physicalShipmentId, item);
    const items = bySource.get(item.sourceItemId) ?? [];
    items.push(item);
    bySource.set(item.sourceItemId, items);
  }

  const packages = new Set<number>();
  for (const sourceId of sourceItemIds) {
    const candidates = bySource.get(sourceId) ?? [];
    const exactLineage = replacementOrderId === null ? []
      : candidates.filter(item => item.providerOrderId === replacementOrderId);
    const related = exactLineage.length > 0 ? exactLineage : candidates;
    // Prefer voided predecessors only WITHIN this lineage. Otherwise a voided
    // sibling can steal the units of the matching, not-yet-voided package.
    const voided = related.filter(item => item.labelStatus === "voided");
    for (const item of voided.length > 0 ? voided : related) packages.add(item.physicalShipmentId);
  }
  return {
    outcome: "scoped",
    physicalItemIds: Object.freeze(previous.filter(item => packages.has(item.physicalShipmentId))
      .map(item => item.physicalItemId).sort((left, right) => left - right)),
  };
}
