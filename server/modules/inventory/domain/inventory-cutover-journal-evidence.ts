import { createHash, type Hash } from "node:crypto";
import { z } from "zod";
import { canonicalJson } from "@shared/utils/canonical-json";
import type { CutoverJournalIssueCode, CutoverReconstructionEvidence } from "@shared/types/inventory-cutover-reconstruction";

export const MAX_CUTOVER_JOURNAL_ROWS = 100_000;
const MAX_CUTOVER_JOURNAL_GROUPS = 50_000;
const MAX_ISSUE_EXAMPLES = 10;
const id = z.number().int().positive().max(2_147_483_647);
const nullableId = id.nullable();
const quantity = z.number().int().min(-2_147_483_648).max(2_147_483_647).nullable();
const digest = z.string().regex(/^[0-9a-f]{64}$/);
export const cutoverJournalRowSchema = z.object({
  id, orderId: nullableId, orderItemId: nullableId, productVariantId: nullableId,
  fromLocationId: nullableId, toLocationId: nullableId,
  transactionType: z.enum(["reserve", "unreserve", "pick", "unpick", "ship", "reserve_move"]),
  variantQtyDelta: quantity, reservedQtyDelta: quantity, sourceState: z.string().nullable(),
  shipmentId: nullableId, shipmentItemId: nullableId,
  directShipmentId: nullableId, directShipmentOrderId: nullableId, directShipmentStatus: z.string().nullable(),
  itemId: nullableId, itemOrderId: nullableId, itemOrderWarehouseId: nullableId,
  sourceId: nullableId, sourceShipmentId: nullableId, sourceOrderItemId: nullableId,
  sourceItemId: nullableId, sourceItemOrderId: nullableId,
  sourceHeaderId: nullableId, sourceHeaderOrderId: nullableId, sourceOrderWarehouseId: nullableId,
  sourceVariantId: nullableId, sourceLocationId: nullableId, sourceQty: quantity,
  sourcePurpose: z.string().nullable(), sourceReplacementItemId: nullableId, sourceCorrectionItemId: nullableId,
  sourceStatus: z.string().nullable(), sourceRequiresReview: z.boolean().nullable(),
  fromWarehouseId: nullableId, toWarehouseId: nullableId,
  journalHash: digest, linkHash: digest,
}).strict();
export type CutoverJournalRow = z.infer<typeof cutoverJournalRowSchema>;
type Journal = CutoverReconstructionEvidence["journals"][number];
type Issue = NonNullable<Journal["issues"]>[number];
type Group = { journal: Journal; digest: Hash; issues: Map<CutoverJournalIssueCode, Issue> };

export class CutoverJournalEvidenceError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "CutoverJournalEvidenceError"; }
}

/** NULL completion is a FK proof, never a search by SKU, bin text or order number. */
function resolveOwner(row: CutoverJournalRow, issues: Set<CutoverJournalIssueCode>): {
  orderId: number | null; orderItemId: number | null; completed: boolean;
} {
  const original = { orderId: row.orderId, orderItemId: row.orderItemId, completed: false };
  const positionWarehouse = row.toLocationId !== null ? row.toWarehouseId : row.fromWarehouseId;
  const ambiguousPosition = row.fromLocationId !== null && row.toLocationId !== null && row.fromLocationId !== row.toLocationId;
  // A reserve transfer is aggregate stock movement, not a recorded owner move.
  if (row.transactionType === "reserve_move") return original;
  if (row.shipmentId !== null) {
    if (row.directShipmentId !== row.shipmentId || row.directShipmentOrderId === null) {
      issues.add("OWNER_FOREIGN_KEY_MISSING"); return original;
    }
    const itemOrder = row.orderItemId !== null ? row.itemOrderId : row.sourceItemOrderId;
    if ((row.orderId !== null && row.directShipmentOrderId !== row.orderId)
      || (itemOrder !== null && row.directShipmentOrderId !== itemOrder)) {
      issues.add("OWNER_FOREIGN_KEY_CONFLICT"); return original;
    }
    if ((row.orderId === null || row.orderItemId === null)
      && !(["planned", "queued", "labeled", "shipped"] as Array<string | null>).includes(row.directShipmentStatus)) {
      issues.add("SOURCE_LIFECYCLE_UNSAFE"); return original;
    }
  }
  // A second recorded FK is evidence too. A present item ID must never win over
  // a conflicting shipment source merely because it was checked first.
  if (row.orderItemId !== null && row.shipmentItemId !== null) {
    if (row.sourceId !== row.shipmentItemId || row.sourceHeaderId !== row.sourceShipmentId
      || row.sourceItemId !== row.sourceOrderItemId || row.sourceHeaderOrderId === null) {
      issues.add("OWNER_FOREIGN_KEY_MISSING"); return original;
    }
    // Legacy replacement dispatch deliberately records the replacement's target
    // order item on the journal while the source uses replacement_for_order_item_id.
    // That is unsupported customer-custody evidence, not proof of a corrupt FK.
    // Keep every such row blocked and never complete its NULL owner fields.
    if (row.sourcePurpose !== "customer_fulfillment" || row.sourceReplacementItemId !== null
      || row.sourceCorrectionItemId !== null) {
      issues.add("SOURCE_PURPOSE_UNSUPPORTED"); return original;
    }
    if (row.sourceOrderItemId !== row.orderItemId || row.sourceItemOrderId !== row.sourceHeaderOrderId
      || (row.orderId !== null && row.sourceHeaderOrderId !== row.orderId)
      || (row.shipmentId !== null && row.sourceShipmentId !== row.shipmentId)
      || row.sourceVariantId !== row.productVariantId) {
      issues.add("OWNER_FOREIGN_KEY_CONFLICT"); return original;
    }
  }
  if (row.orderItemId !== null) {
    if (row.itemId !== row.orderItemId || row.itemOrderId === null) {
      issues.add("OWNER_FOREIGN_KEY_MISSING"); return original;
    }
    if (row.orderId !== null && row.orderId !== row.itemOrderId) {
      issues.add("OWNER_FOREIGN_KEY_CONFLICT"); return original;
    }
    if (row.orderId === null) {
      if (ambiguousPosition || positionWarehouse === null || row.itemOrderWarehouseId !== positionWarehouse) {
        issues.add("LOCATION_IDENTITY_UNRESOLVED"); return original;
      }
      return { orderId: row.itemOrderId, orderItemId: row.orderItemId, completed: true };
    }
    return original;
  }
  if (row.shipmentItemId === null) return original;
  if (row.sourceId !== row.shipmentItemId || row.sourceOrderItemId === null
    || row.sourceItemId !== row.sourceOrderItemId || row.sourceItemOrderId === null
    || row.sourceShipmentId === null || row.sourceHeaderId !== row.sourceShipmentId || row.sourceHeaderOrderId === null) {
    issues.add("OWNER_FOREIGN_KEY_MISSING"); return original;
  }
  if (row.sourceHeaderOrderId !== row.sourceItemOrderId
    || (row.orderId !== null && row.orderId !== row.sourceItemOrderId)
    || (row.shipmentId !== null && row.shipmentId !== row.sourceShipmentId)
    || row.productVariantId === null || row.productVariantId !== row.sourceVariantId) {
    issues.add("OWNER_FOREIGN_KEY_CONFLICT"); return original;
  }
  if (!["pick", "unpick", "ship"].includes(row.transactionType)
    || row.sourcePurpose !== "customer_fulfillment" || row.sourceReplacementItemId !== null
    || row.sourceCorrectionItemId !== null || row.sourceQty === null || row.sourceQty <= 0) {
    issues.add("SOURCE_PURPOSE_UNSUPPORTED"); return original;
  }
  if (!(["planned", "queued", "labeled", "shipped"] as Array<string | null>).includes(row.sourceStatus)
    || row.sourceRequiresReview !== false) {
    issues.add("SOURCE_LIFECYCLE_UNSAFE"); return original;
  }
  if (ambiguousPosition || row.fromLocationId === null || row.sourceLocationId !== row.fromLocationId
    || positionWarehouse === null || row.sourceOrderWarehouseId !== positionWarehouse) {
    issues.add("LOCATION_IDENTITY_UNRESOLVED"); return original;
  }
  return { orderId: row.sourceItemOrderId, orderItemId: row.sourceOrderItemId, completed: true };
}

function custodyIssues(row: CutoverJournalRow): Set<CutoverJournalIssueCode> {
  const issues = new Set<CutoverJournalIssueCode>();
  if (["reserve", "unreserve", "pick"].includes(row.transactionType) && row.reservedQtyDelta === null) issues.add("RESERVATION_DELTA_MISSING");
  if (["pick", "unpick", "ship"].includes(row.transactionType) && row.variantQtyDelta === null) issues.add("PHYSICAL_DELTA_MISSING");
  if (row.transactionType === "ship" && row.sourceState !== "picked") issues.add("SHIPMENT_BUCKET_SPLIT_UNRECORDED");
  if (row.transactionType === "reserve_move") issues.add("RESERVATION_TRANSFER_OWNER_UNRECORDED");
  return issues;
}

/**
 * One complete statement snapshot in; signed owner/position groups out.
 * Raw and linked-row digests survive grouping. Completing an ID neither creates
 * a missing quantity nor certifies original FIFO cost or shipment posting.
 */
export function aggregateCutoverJournalEvidence(raw: unknown): Journal[] {
  if (!Array.isArray(raw) || raw.length > MAX_CUTOVER_JOURNAL_ROWS) {
    throw new CutoverJournalEvidenceError("CUTOVER_JOURNAL_ROW_LIMIT_EXCEEDED", "Complete journal evidence exceeds its bounded census.");
  }
  // Sort lightweight references, then validate one row at a time. The pg result
  // already owns the raw objects; do not retain another fully parsed census.
  const rows = raw.map((value) => ({ id: z.object({ id }).parse(value).id, value })).sort((a, b) => a.id - b.id);
  const seen = new Set<number>();
  const groups = new Map<string, Group>();
  for (const entry of rows) {
    const row = cutoverJournalRowSchema.parse(entry.value);
    if (seen.has(row.id)) throw new CutoverJournalEvidenceError("CUTOVER_JOURNAL_DUPLICATE_ID", "A journal identity appeared more than once in the census.");
    seen.add(row.id);
    const issues = custodyIssues(row);
    const owner = resolveOwner(row, issues);
    const locations = row.transactionType === "reserve_move"
      ? [...new Set([row.fromLocationId, row.toLocationId])] : [row.toLocationId ?? row.fromLocationId];
    for (const location of locations) {
      const key = `${owner.orderId}:${owner.orderItemId}:${row.productVariantId}:${location}`;
      let group = groups.get(key);
      if (!group) {
        if (groups.size === MAX_CUTOVER_JOURNAL_GROUPS) throw new CutoverJournalEvidenceError("CUTOVER_JOURNAL_GROUP_LIMIT_EXCEEDED", "Complete journal ownership exceeds its bounded census.");
        group = { journal: { orderId: owner.orderId, orderItemId: owner.orderItemId, productVariantId: row.productVariantId,
          warehouseLocationId: location, reservedQty: "0", pickedQty: "0", shippedQty: "0", unknownCount: "0",
          journalCount: "0", journalHash: "", identityCompletedCount: "0", issues: [] }, digest: createHash("sha256"), issues: new Map() };
        groups.set(key, group);
      }
      const journal = group.journal;
      const physical = BigInt(row.variantQtyDelta ?? 0);
      const picked = ["pick", "unpick"].includes(row.transactionType) ? -physical
        : row.transactionType === "ship" && row.sourceState === "picked" ? physical : BigInt(0);
      journal.reservedQty = (BigInt(journal.reservedQty) + BigInt(row.reservedQtyDelta ?? 0)).toString();
      journal.pickedQty = (BigInt(journal.pickedQty) + picked).toString();
      journal.shippedQty = (BigInt(journal.shippedQty) + (row.transactionType === "ship" ? -physical : BigInt(0))).toString();
      journal.journalCount = (BigInt(journal.journalCount) + BigInt(1)).toString();
      journal.identityCompletedCount = (BigInt(journal.identityCompletedCount!) + BigInt(owner.completed ? 1 : 0)).toString();
      if (issues.size > 0) journal.unknownCount = (BigInt(journal.unknownCount) + BigInt(1)).toString();
      for (const code of issues) {
        const issue = group.issues.get(code) ?? { code, transactionCount: "0", transactionIds: [] };
        issue.transactionCount = (BigInt(issue.transactionCount) + BigInt(1)).toString();
        if (issue.transactionIds.length < MAX_ISSUE_EXAMPLES) issue.transactionIds.push(row.id);
        group.issues.set(code, issue);
      }
      group.digest.update(canonicalJson({ ...row, resolvedOrderId: owner.orderId, resolvedOrderItemId: owner.orderItemId })).update("\n");
    }
  }
  return [...groups.values()].map((group) => ({ ...group.journal, journalHash: group.digest.digest("hex"),
    issues: [...group.issues.values()].sort((a, b) => a.code < b.code ? -1 : a.code > b.code ? 1 : 0) }))
    .sort((a, b) => (a.orderId ?? 0) - (b.orderId ?? 0) || (a.orderItemId ?? 0) - (b.orderItemId ?? 0)
      || (a.productVariantId ?? 0) - (b.productVariantId ?? 0) || (a.warehouseLocationId ?? 0) - (b.warehouseLocationId ?? 0));
}
