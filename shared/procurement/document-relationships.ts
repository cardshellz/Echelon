import { z } from "zod";

export const relationshipIdSchema = z.number().int().positive().max(2_147_483_647);
export const relationshipRootSchema = z.object({
  kind: z.enum(["purchase", "shipment", "receipt"]), id: relationshipIdSchema,
}).strict();
const quantity = z.number().int().safe().nonnegative();
const money = z.number().int().safe();
const nullableId = relationshipIdSchema.nullable();
export const relationshipSnapshotSchema = z.object({
  root: relationshipRootSchema,
  purchases: z.array(z.object({ id: relationshipIdSchema, number: z.string().min(1) })),
  purchaseLines: z.array(z.object({
    id: relationshipIdSchema, purchaseId: relationshipIdSchema, lineNumber: quantity,
    sku: z.string().nullable(), product: z.string().nullable(), orderedPieces: quantity,
    // Optional for older snapshots. Missing counters are unknown, never zero.
    receivedPieces: quantity.nullish(), cancelledPieces: quantity.nullish(),
  })),
  shipments: z.array(z.object({ id: relationshipIdSchema, number: z.string().min(1), status: z.string() })),
  shipmentLines: z.array(z.object({
    id: relationshipIdSchema, shipmentId: relationshipIdSchema, purchaseId: nullableId, purchaseLineId: nullableId,
    sku: z.string().nullable(), product: z.string().nullable(), shippedPieces: quantity,
  })),
  receipts: z.array(z.object({
    id: relationshipIdSchema, number: z.string().min(1), status: z.string(), purchaseId: nullableId, shipmentId: nullableId,
  })),
  receiptLines: z.array(z.object({
    id: relationshipIdSchema, receiptId: relationshipIdSchema, purchaseLineId: nullableId, shipmentLineId: nullableId,
    sku: z.string().nullable(), receivedUnits: quantity, reversedUnits: quantity, piecesPerUnit: quantity.positive().nullable(),
  })),
  allocations: z.array(z.object({
    costId: relationshipIdSchema, shipmentLineId: relationshipIdSchema, currency: z.string().regex(/^[A-Z]{3}$/).nullable(), cents: money.nullable(),
  })),
  charges: z.array(z.object({
    id: relationshipIdSchema, shipmentId: relationshipIdSchema, currency: z.string().regex(/^[A-Z]{3}$/).nullable(), cents: money.nullable(),
  })),
  costIssues: z.array(z.string()),
});
export type RelationshipRoot = z.infer<typeof relationshipRootSchema>;
export type RelationshipSnapshot = z.infer<typeof relationshipSnapshotSchema>;
export type RelationshipLine = RelationshipSnapshot["shipmentLines"][number];
export type RelationshipReceiptLine = RelationshipSnapshot["receiptLines"][number];
export type RelationshipPurchaseLine = RelationshipSnapshot["purchaseLines"][number];
export type RelationshipOwnership = {
  purchaseId: number | null; purchaseLine: RelationshipPurchaseLine | null;
  issue: "conflicting_po" | "missing_po" | "missing_po_line" | null;
};

/** A saved PO-line link can supply a missing header link, but never override a
 * contradictory one. SKU equality is deliberately not a relationship. */
export function resolveRelationshipOwner(line: Pick<RelationshipLine, "purchaseId" | "purchaseLineId">,
  purchaseLines: ReadonlyMap<number, RelationshipPurchaseLine>): RelationshipOwnership {
  const purchaseLine = line.purchaseLineId === null ? null : purchaseLines.get(line.purchaseLineId) ?? null;
  if (purchaseLine && line.purchaseId !== null && line.purchaseId !== purchaseLine.purchaseId) {
    return { purchaseId: null, purchaseLine, issue: "conflicting_po" };
  }
  const purchaseId = purchaseLine?.purchaseId ?? line.purchaseId;
  return { purchaseId, purchaseLine, issue: purchaseId === null ? "missing_po" : purchaseLine === null ? "missing_po_line" : null };
}

export function exactRelationshipSum(values: readonly number[]): number {
  const total = values.reduce((sum, value) => sum + BigInt(money.parse(value)), BigInt(0));
  if (total > BigInt(Number.MAX_SAFE_INTEGER) || total < BigInt(Number.MIN_SAFE_INTEGER)) throw new RangeError("Relationship total exceeds supported precision");
  return Number(total);
}
export interface RelationshipAmount { currency: string; cents: number }
export interface RelationshipAmounts { amounts: RelationshipAmount[]; incomplete: boolean }
export function sumRelationshipAmounts(rows: readonly { currency: string | null; cents: number | null }[]): RelationshipAmounts {
  const byCurrency = new Map<string, number[]>();
  for (const row of rows) {
    if (row.currency === null || row.cents === null) continue;
    const values = byCurrency.get(row.currency);
    if (values) values.push(row.cents); else byCurrency.set(row.currency, [row.cents]);
  }
  return {
    amounts: [...byCurrency].sort(([a], [b]) => a.localeCompare(b)).map(([currency, values]) => ({ currency, cents: exactRelationshipSum(values) })),
    incomplete: rows.some(row => row.currency === null || row.cents === null),
  };
}
export function receivedRelationshipPieces(line: RelationshipReceiptLine): number | null {
  if (line.piecesPerUnit === null || line.reversedUnits > line.receivedUnits) return null;
  const pieces = BigInt(line.receivedUnits - line.reversedUnits) * BigInt(line.piecesPerUnit);
  if (pieces > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError("Receipt quantity exceeds supported precision");
  return Number(pieces);
}
export interface RelationshipGroup {
  key: string; purchaseId: number | null; number: string | null;
  lines: Array<{ line: RelationshipLine; owner: RelationshipOwnership; receipts: RelationshipReceiptLine[]; costs: RelationshipAmounts }>;
  shippedPieces: number; costs: RelationshipAmounts;
}
export interface RelationshipShipment {
  shipment: RelationshipSnapshot["shipments"][number]; groups: RelationshipGroup[];
  charges: RelationshipAmounts; allocated: RelationshipAmounts; allocationIncomplete: boolean;
}

/** One projection for PO, shipment, receipt and lifecycle displays. Financial
 * allocations are supplied by the existing credit/allocation owner; no UI
 * prorating, inferred receipt linkage or inventory writes occur here. */
export function projectDocumentRelationships(snapshot: RelationshipSnapshot): RelationshipShipment[] {
  const data = relationshipSnapshotSchema.parse(snapshot);
  const poLines = new Map(data.purchaseLines.map(line => [line.id, line]));
  const purchases = new Map(data.purchases.map(po => [po.id, po.number]));
  function index<T>(values: readonly T[], key: (value: T) => number | null): Map<number, T[]> {
    const result = new Map<number, T[]>();
    for (const value of values) {
      const id = key(value); if (id === null) continue;
      const existing = result.get(id); if (existing) existing.push(value); else result.set(id, [value]);
    }
    return result;
  }
  const linesByShipment = index(data.shipmentLines, line => line.shipmentId);
  const receiptsByLine = index(data.receiptLines, line => line.shipmentLineId);
  const allocationsByLine = index(data.allocations, row => row.shipmentLineId);
  const chargesByShipment = index(data.charges, row => row.shipmentId);
  return data.shipments.map(shipment => {
    const groups = new Map<string, RelationshipGroup>();
    const lines = linesByShipment.get(shipment.id) ?? [];
    const allocations = lines.flatMap(line => allocationsByLine.get(line.id) ?? []);
    for (const line of lines) {
      const owner = resolveRelationshipOwner(line, poLines);
      const key = owner.purchaseId === null ? owner.issue ?? "missing_po" : `po:${owner.purchaseId}`;
      let group = groups.get(key);
      if (!group) {
        group = { key, purchaseId: owner.purchaseId, number: owner.purchaseId === null ? null : purchases.get(owner.purchaseId) ?? null, lines: [], shippedPieces: 0, costs: { amounts: [], incomplete: false } };
        groups.set(key, group);
      }
      group.lines.push({ line, owner, receipts: receiptsByLine.get(line.id) ?? [],
        costs: sumRelationshipAmounts(allocationsByLine.get(line.id) ?? []) });
    }
    for (const group of groups.values()) {
      group.shippedPieces = exactRelationshipSum(group.lines.map(row => row.line.shippedPieces));
      group.costs = sumRelationshipAmounts(group.lines.flatMap(row => allocationsByLine.get(row.line.id) ?? []));
    }
    const charges = sumRelationshipAmounts(chargesByShipment.get(shipment.id) ?? []);
    const allocated = sumRelationshipAmounts(allocations);
    const chargedByCurrency = new Map(charges.amounts.map(row => [row.currency, row.cents]));
    const allocatedByCurrency = new Map(allocated.amounts.map(row => [row.currency, row.cents]));
    const allocationIncomplete = charges.incomplete || allocated.incomplete
      || [...new Set([...chargedByCurrency.keys(), ...allocatedByCurrency.keys()])]
        .some(currency => (chargedByCurrency.get(currency) ?? 0) !== (allocatedByCurrency.get(currency) ?? 0));
    return { shipment, groups: [...groups.values()].sort((a, b) => (a.purchaseId ?? Number.MAX_SAFE_INTEGER) - (b.purchaseId ?? Number.MAX_SAFE_INTEGER)), charges, allocated, allocationIncomplete };
  });
}
