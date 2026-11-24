import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJson } from "@shared/utils/canonical-json";

const id = z.number().int().positive().safe();
const quantity = z.number().int().positive().max(2_147_483_647);
const text = z.string().trim().min(1).max(200);
const line = z.object({ sourceItemId: id, quantity }).strict();
const label = z.object({
  labelId: id,
  providerOrderId: text,
  trackingNumber: text,
  status: z.enum(["active", "voided", "superseded", "unknown"]),
  outbound: z.boolean(),
  contentsVerified: z.boolean(),
  voidVerified: z.boolean(),
  carrierPossession: z.boolean(),
  contents: z.array(line).max(500),
}).strict();
const previous = line.extend({ physicalItemId: id, physicalShipmentId: id, labelId: id }).strict();
const relationship = z.object({
  providerOrderId: text,
  mergedProviderOrderIds: z.array(text).max(100),
  parentProviderOrderId: text.nullable(),
  evidenceHash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
const correction = z.object({
  kind: z.literal("confirmed_package_contents_correction"),
  actorId: text,
  reason: z.string().trim().min(1).max(500),
  // This is a correction of an earlier contents allocation, not a claim that
  // its carrier events never happened or that its label was voided.
  previousLabelIds: z.array(id).min(1).max(100),
}).strict();

export const packageReconciliationInputSchema = z.object({
  sources: z.array(line).min(1).max(500),
  labels: z.array(label).min(1).max(100),
  previous: z.array(previous).max(500),
  relationships: z.array(relationship).max(100).default([]),
  correction: correction.nullable().default(null),
}).strict();
export type PackageReconciliationInput = z.input<typeof packageReconciliationInputSchema>;
export type PackageReconciliationLabel = z.output<typeof label>;
export type PackageReconciliationPrevious = z.output<typeof previous>;
export type PackageReconciliationPlan = Readonly<{
  outcome: "ready" | "unchanged";
  evidenceHash: string;
  physicalItemIdsToRetire: readonly number[];
  labelIdsToMaterialize: readonly number[];
  correctedPreviousLabelIds: readonly number[];
  sourceQuantities: readonly Readonly<{
    sourceItemId: number;
    sourceQuantity: number;
    preservedQuantity: number;
    retiredQuantity: number;
    materializedQuantity: number;
    additionalQuantity: number;
    finalQuantity: number;
  }>[];
}> | Readonly<{
  outcome: "review" | "waiting";
  reason: string;
}>;

function unique<T>(values: readonly T[], key: (value: T) => number | string): boolean {
  return new Set(values.map(key)).size === values.length;
}
function total(lines: readonly z.output<typeof line>[], sourceId: number): number {
  const value = lines.filter(item => item.sourceItemId === sourceId).reduce((sum, item) => sum + BigInt(item.quantity), BigInt(0));
  if (value > BigInt(2_147_483_647)) throw new RangeError("Package quantity exceeds the PostgreSQL integer bound");
  return Number(value);
}
function canonicalLines(lines: readonly z.output<typeof line>[]): string {
  return canonicalJson(lines.map(({ sourceItemId, quantity: value }) => ({ sourceItemId, quantity: value }))
    .sort((a, b) => a.sourceItemId - b.sourceItemId));
}

/**
 * Reconcile the complete current package set against paid source capacity.
 * Retiring an allocation and consuming previously unused capacity are separate
 * quantities. This is essential when a split includes both a relabel and a new
 * portion, or a merged parcel adds a previously unmaterialized order.
 *
 * The repository proves snapshot completeness and authenticates provider and
 * operator evidence. This pure planner never posts inventory, edits a carrier
 * event, cancels a channel fulfillment, or fabricates a prior transfer.
 */
export function planPackageReconciliation(rawInput: PackageReconciliationInput): PackageReconciliationPlan {
  const parsed = packageReconciliationInputSchema.safeParse(rawInput);
  if (!parsed.success) return { outcome: "review", reason: "invalid_package_reconciliation_evidence" };
  const input = parsed.data;
  if (!unique(input.sources, item => item.sourceItemId) || !unique(input.labels, item => item.labelId)
    || !unique(input.previous, item => item.physicalItemId)
    || !unique(input.relationships, item => item.providerOrderId)
    || input.labels.some(item => !unique(item.contents, value => value.sourceItemId))) {
    return { outcome: "review", reason: "duplicate_package_reconciliation_identity" };
  }
  const sourceIds = new Set(input.sources.map(item => item.sourceItemId));
  const labelById = new Map(input.labels.map(item => [item.labelId, item]));
  if (input.previous.some(item => !sourceIds.has(item.sourceItemId) || !labelById.has(item.labelId))
    || input.labels.some(item => item.contents.some(value => !sourceIds.has(value.sourceItemId)))) {
    return { outcome: "review", reason: "incomplete_package_source_scope" };
  }
  const previousByPackage = new Map<number, typeof input.previous>();
  for (const item of input.previous) {
    const members = previousByPackage.get(item.physicalShipmentId) ?? [];
    if (members.some(member => member.labelId !== item.labelId)) return { outcome: "review", reason: "conflicting_package_label_identity" };
    members.push(item);
    previousByPackage.set(item.physicalShipmentId, members);
  }
  const corrected = new Set(input.correction?.previousLabelIds ?? []);
  if (input.correction && corrected.size !== input.correction.previousLabelIds.length) {
    return { outcome: "review", reason: "duplicate_package_correction_identity" };
  }
  const current = input.labels.filter(item => item.status === "active" && !corrected.has(item.labelId));
  if (current.length === 0 || current.some(item => !item.outbound || !item.contentsVerified || item.contents.length === 0)) {
    return { outcome: "review", reason: "current_package_contents_unproven" };
  }
  for (const labelId of corrected) {
    const old = labelById.get(labelId);
    if (!old || !input.previous.some(item => item.labelId === labelId)
      || !current.some(target => input.relationships.some(proof => proof.providerOrderId === target.providerOrderId
        && proof.mergedProviderOrderIds.includes(old.providerOrderId)))) {
      return { outcome: "review", reason: "package_contents_correction_merge_unproven" };
    }
  }
  const retire: typeof input.previous = [];
  const preserved: typeof input.previous = [];
  for (const members of previousByPackage.values()) {
    const old = labelById.get(members[0].labelId)!;
    if (corrected.has(old.labelId)) {
      retire.push(...members);
    } else if (old.status === "voided") {
      if (!old.outbound || !old.voidVerified) return { outcome: "review", reason: "predecessor_void_evidence_unproven" };
      if (old.carrierPossession) return { outcome: "review", reason: "replaced_label_has_carrier_possession" };
      retire.push(...members);
    } else {
      if (old.status !== "active" || !current.some(item => item.labelId === old.labelId)
        || canonicalLines(members) !== canonicalLines(old.contents)) {
        return { outcome: "review", reason: "preserved_package_contents_conflict" };
      }
      preserved.push(...members);
    }
  }
  const preservedLabelIds = new Set(preserved.map(item => item.labelId));
  const targets = current.filter(item => !preservedLabelIds.has(item.labelId));
  const newLines = targets.flatMap(item => item.contents);
  const sourceQuantities: Extract<PackageReconciliationPlan, { outcome: "ready" | "unchanged" }>["sourceQuantities"][number][] = [];
  try {
    for (const source of [...input.sources].sort((a, b) => a.sourceItemId - b.sourceItemId)) {
      const preservedQuantity = total(preserved, source.sourceItemId);
      const retiredQuantity = total(retire, source.sourceItemId);
      const materializedQuantity = total(newLines, source.sourceItemId);
      if (preservedQuantity + retiredQuantity > source.quantity) return { outcome: "review", reason: "previous_allocations_exceed_source" };
      if (preservedQuantity + materializedQuantity > source.quantity) return { outcome: "review", reason: "current_allocations_exceed_source" };
      if (materializedQuantity < retiredQuantity) return { outcome: "waiting", reason: "replacement_repack_incomplete" };
      sourceQuantities.push({ sourceItemId: source.sourceItemId, sourceQuantity: source.quantity, preservedQuantity,
        retiredQuantity, materializedQuantity, additionalQuantity: materializedQuantity - retiredQuantity,
        finalQuantity: preservedQuantity + materializedQuantity });
    }
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    return { outcome: "review", reason: "invalid_package_quantities" };
  }
  const normalized = { ...input, sources: [...input.sources].sort((a, b) => a.sourceItemId - b.sourceItemId),
    labels: [...input.labels].sort((a, b) => a.labelId - b.labelId).map(item => ({ ...item, contents: [...item.contents].sort((a, b) => a.sourceItemId - b.sourceItemId) })),
    previous: [...input.previous].sort((a, b) => a.physicalItemId - b.physicalItemId),
    relationships: [...input.relationships].sort((a, b) => a.providerOrderId.localeCompare(b.providerOrderId)).map(item => ({ ...item, mergedProviderOrderIds: [...item.mergedProviderOrderIds].sort() })),
    correction: input.correction ? { ...input.correction, previousLabelIds: [...corrected].sort((a, b) => a - b) } : null };
  return {
    outcome: retire.length === 0 && targets.length === 0 ? "unchanged" : "ready",
    evidenceHash: createHash("sha256").update(canonicalJson(normalized)).digest("hex"),
    physicalItemIdsToRetire: retire.map(item => item.physicalItemId).sort((a, b) => a - b),
    labelIdsToMaterialize: targets.map(item => item.labelId).sort((a, b) => a - b),
    correctedPreviousLabelIds: [...corrected].sort((a, b) => a - b), sourceQuantities,
  };
}
