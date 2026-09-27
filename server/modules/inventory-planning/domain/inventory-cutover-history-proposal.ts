import { z } from "zod";
import { isTerminalWmsDemandStatus } from "@shared/enums/order-status";
import { openingSourceSchema, requiredOpeningItems, type OpeningSource } from "@shared/types/inventory-cutover-opening";
import { reconstructionEvidenceHash, reconstructionHash } from "./inventory-cutover-reconstruction";

const id = z.number().int().positive().max(2_147_483_647);
const bigId = z.string().regex(/^[1-9][0-9]{0,18}$/)
  .refine(value => BigInt(value) <= BigInt("9223372036854775807"));
const quantity = z.number().int().nonnegative().max(2_147_483_647);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const nullableText = z.string().nullable();
const line = z.object({
  id: bigId, requiresShipping: z.boolean().nullable(),
  authorizedQty: quantity, fulfillmentStatus: nullableText
}).strict();
const order = z.object({
  id: bigId, channelId: id, externalOrderId: z.string(), status: z.string(),
  rowHash: hash, linesHash: hash, lines: z.array(line).max(10_000)
}).strict();

export const historicalReceiptFactsSchema = z.object({
  id: bigId, rowHash: hash, attemptsHash: hash, itemsHash: hash,
  status: z.string(), sourceChannelId: id.nullable(), sourceOrderId: z.string(),
  linkedOrderId: bigId.nullable(), leaseExpiresAt: z.string().datetime().nullable(),
  leaseTokenPresent: z.boolean(), createdAt: z.string().datetime(),
  matchedOrders: z.array(order).max(10),
}).strict();
const owner = z.object({
  id, orderId: id, orderStatus: nullableText,
  quantity, pickedQuantity: quantity, fulfilledQuantity: quantity, rowHash: hash, orderHash: hash
}).strict();
const physical = z.object({
  id: bigId, provider: z.string(), providerShipmentId: z.string(), status: z.string(),
  sourceItemId: id, orderItemId: id.nullable(), variantId: id.nullable(), quantity,
  adjustmentQuantity: z.number().int(), rowHash: hash
}).strict();
export const historicalShipmentFactsSchema = z.object({
  id, rowHash: hash, status: z.string(), orderId: id.nullable(), orderStatus: nullableText,
  orderHash: hash.nullable(), purpose: nullableText, externalFulfillmentId: nullableText,
  requiresReview: z.boolean(), held: z.boolean(), physicalLinksHash: hash, labelsHash: hash,
  physicalStatuses: z.array(z.string()), openPickCorrections: quantity,
  sources: z.array(z.object({
    id, rowHash: hash, purpose: nullableText, quantity,
    orderItemId: id.nullable(), variantId: id.nullable(), replacementForOrderItemId: id.nullable(),
    correctionForSourceItemId: id.nullable(), owner: owner.nullable(),
    correctedPhysicalItems: z.array(physical).max(1_000),
  }).strict()).max(10_000),
}).strict();
export const cutoverHistoryFactsSchema = z.object({
  contractVersion: z.literal("inventory_cutover_history_facts_v1"),
  sourceEvidenceHash: hash, capturedAt: z.string().datetime(),
  receipts: z.array(historicalReceiptFactsSchema).max(100_000),
  shipments: z.array(historicalShipmentFactsSchema).max(100_000),
}).strict();
export type CutoverHistoryFacts = z.infer<typeof cutoverHistoryFactsSchema>;
export type HistoricalReceiptFacts = z.infer<typeof historicalReceiptFactsSchema>;
export type HistoricalShipmentFacts = z.infer<typeof historicalShipmentFactsSchema>;
export type HistoricalTreatment = "settled_order_notification" | "fulfilled_digital_notification"
  | "unresolved_channel_quarantine" | "closed_shipment_intention" | "terminal_order_posting_debt"
  | "duplicate_correction_intention";
export interface HistoricalWorkProposal {
  contractVersion: "inventory_cutover_history_proposal_v1";
  executable: false;
  productionReady: false;
  sourceEvidenceHash: string;
  factsHash: string;
  proposalHash: string;
  groups: Partial<Record<HistoricalTreatment, number>>;
  decisions: Array<{
    kind: "receipt" | "shipment"; id: string; treatment: HistoricalTreatment;
    factsHash: string; reviewEvidenceHash: string | null; sourceItemIds: number[]
  }>;
  blockers: Array<{ code: string; subject: string }>;
  uncertainties: string[];
  preservedCurrentOrderItemIds: number[];
  requiredControls: readonly string[];
}

/** A review proposal, NOT a disposition or evidence of delivery. No caller can
 * use this result as a ready activation manifest. A separate admitted owner
 * command must persist immutable decisions and prevent old work from replaying. */
export function proposeHistoricalWork(rawSource: OpeningSource, rawFacts: CutoverHistoryFacts): HistoricalWorkProposal {
  const source = openingSourceSchema.parse(rawSource), facts = cutoverHistoryFactsSchema.parse(rawFacts);
  if (source.evidenceHash !== reconstructionEvidenceHash(source.evidence)
    || source.evidenceHash !== facts.sourceEvidenceHash || source.capturedAt !== facts.capturedAt) {
    throw new Error("HISTORY_PROPOSAL_SNAPSHOT_MISMATCH");
  }
  const decisions: HistoricalWorkProposal["decisions"] = [], blockers: HistoricalWorkProposal["blockers"] = [];
  const uncertainties: string[] = [];
  const block = (code: string, subject: string) => blockers.push({ code, subject });
  const current = requiredOpeningItems(source.evidence);
  const currentOrders = new Set(current.map(item => item.orderId));
  const reviews = source.evidence.shipmentReviewEvidence;
  const reviewMap = new Map(reviews.map(row => [`${row.kind}:${row.id}`, row]));
  if (reviewMap.size !== reviews.length) throw new Error("HISTORY_PROPOSAL_DUPLICATE_REVIEW");
  if (new Set(facts.receipts.map(row => row.id)).size !== facts.receipts.length
    || new Set(facts.shipments.map(row => row.id)).size !== facts.shipments.length
    || new Set(facts.shipments.flatMap(row => row.sources.map(item => item.id))).size
    !== facts.shipments.reduce((sum, row) => sum + row.sources.length, 0)) {
    throw new Error("HISTORY_PROPOSAL_DUPLICATE_FACTS");
  }
  if (source.runtimeAuthority !== "legacy" || source.evidence.canonicalClaimCount !== "0") {
    block("HISTORY_PROPOSAL_AUTHORITY_CHANGED", "authority");
  }
  const record = (kind: "receipt" | "shipment", fact: HistoricalReceiptFacts | HistoricalShipmentFacts,
    treatment: HistoricalTreatment, reviewEvidenceHash: string | null, sourceItemIds: number[] = []) => {
    decisions.push({
      kind, id: String(fact.id), treatment, factsHash: reconstructionHash(fact), reviewEvidenceHash,
      sourceItemIds: [...sourceItemIds].sort((a, b) => a - b)
    });
  };
  for (const receipt of facts.receipts) {
    const subject = `receipt:${receipt.id}`, review = reviewMap.get(`channel_fulfillment_receipt:${receipt.id}`);
    if (!review || review.status !== receipt.status) throw new Error("HISTORY_PROPOSAL_RECEIPT_COVERAGE_CHANGED");
    if (!["review", "processing"].includes(receipt.status)) { block("HISTORY_RECEIPT_NOT_HELD", subject); continue; }
    if (Date.parse(receipt.createdAt) > Date.parse(facts.capturedAt)) { block("HISTORY_RECEIPT_FUTURE", subject); continue; }
    if (receipt.status === "processing" && (!receipt.leaseTokenPresent || !receipt.leaseExpiresAt)
      || receipt.status === "review" && (receipt.leaseTokenPresent || receipt.leaseExpiresAt !== null)
      || receipt.leaseExpiresAt !== null && Date.parse(receipt.leaseExpiresAt) > Date.parse(facts.capturedAt)) {
      block("HISTORY_RECEIPT_LEASE_UNSAFE", subject); continue;
    }
    if (receipt.sourceChannelId === null) {
      // No unscoped external-order-ID lookup is accepted as channel proof.
      if (receipt.linkedOrderId !== null || receipt.matchedOrders.length !== 0 || receipt.status !== "review") {
        block("HISTORY_RECEIPT_UNSCOPED_OWNER", subject); continue;
      }
      record("receipt", receipt, "unresolved_channel_quarantine", review.evidenceHash);
      uncertainties.push(`${subject}: original channel is unknown; quarantine requires explicit acceptance, never an inferred catalog/order link.`);
      continue;
    }
    const [matched] = receipt.matchedOrders;
    if (receipt.matchedOrders.length !== 1 || matched.channelId !== receipt.sourceChannelId
      || matched.externalOrderId !== receipt.sourceOrderId
      || receipt.linkedOrderId !== null && receipt.linkedOrderId !== matched.id
      || matched.lines.length === 0 || new Set(matched.lines.map(row => row.id)).size !== matched.lines.length) {
      block("HISTORY_RECEIPT_OWNER_CONFLICT", subject); continue;
    }
    if (matched.lines.some(line => line.requiresShipping !== false && line.authorizedQty > 0 && line.fulfillmentStatus !== "fulfilled")) {
      block("HISTORY_RECEIPT_CURRENT_DEMAND", subject); continue;
    }
    if (matched.lines.every(line => line.requiresShipping === false && line.fulfillmentStatus === "fulfilled")) {
      record("receipt", receipt, "fulfilled_digital_notification", review.evidenceHash);
    } else if (matched.status === "shipped") record("receipt", receipt, "settled_order_notification", review.evidenceHash);
    else block("HISTORY_RECEIPT_OWNER_NOT_TERMINAL", subject);
  }
  const sourceMap = new Map(source.evidence.sourceItems.map(row => [row.id, row]));
  if (sourceMap.size !== source.evidence.sourceItems.length) throw new Error("HISTORY_PROPOSAL_DUPLICATE_SOURCE");
  const sourceIdsByShipment = new Map<number, number[]>();
  for (const item of source.evidence.sourceItems) {
    const ids = sourceIdsByShipment.get(item.shipmentId) ?? [];
    ids.push(item.id);
    sourceIdsByShipment.set(item.shipmentId, ids);
  }
  for (const shipment of facts.shipments) {
    const subject = `shipment:${shipment.id}`, review = reviewMap.get(`outbound_shipment_review:${shipment.id}`);
    if (review && (!shipment.requiresReview || review.status !== shipment.status)) throw new Error("HISTORY_PROPOSAL_SHIPMENT_COVERAGE_CHANGED");
    if (!shipment.orderId || !shipment.orderHash || !isTerminalWmsDemandStatus(shipment.orderStatus)
      || currentOrders.has(shipment.orderId) || shipment.openPickCorrections > 0) {
      block("HISTORY_SHIPMENT_CURRENT_OR_UNKNOWN_OWNER", subject); continue;
    }
    // A recorded void is a closed package lifecycle, not proof of stock being
    // returned. Its original package/items remain untouched in the proposal.
    if (shipment.physicalStatuses.some(status => !["shipped", "voided"].includes(status))) {
      block("HISTORY_SHIPMENT_PHYSICAL_WORK_OPEN", subject); continue;
    }
    let valid = true;
    for (const item of shipment.sources) {
      const captured = sourceMap.get(item.id);
      if (!captured || captured.shipmentId !== shipment.id || captured.headerOrderId !== shipment.orderId
        || captured.shipmentStatus !== shipment.status || captured.shipmentHeld !== shipment.held
        || captured.orderItemId !== item.orderItemId || captured.purpose !== item.purpose
        || captured.quantity !== item.quantity || captured.productVariantId !== item.variantId
        || captured.replacementForOrderItemId !== item.replacementForOrderItemId
        || captured.correctionForShipmentItemId !== item.correctionForSourceItemId) {
        throw new Error("HISTORY_PROPOSAL_SOURCE_COVERAGE_CHANGED");
      }
      if (!item.owner || item.owner.orderId !== shipment.orderId || !isTerminalWmsDemandStatus(item.owner.orderStatus)
        || currentOrders.has(item.owner.orderId) || item.quantity <= 0) valid = false;
      if (item.purpose === "customer_fulfillment"
        && (item.owner?.id !== item.orderItemId || item.correctionForSourceItemId !== null || item.replacementForOrderItemId !== null)) valid = false;
      if (item.purpose === "replacement" && (item.owner?.id !== item.replacementForOrderItemId
        || item.orderItemId !== null || item.correctionForSourceItemId !== null)) valid = false;
      if (!["customer_fulfillment", "omission_correction", "replacement"].includes(item.purpose ?? "")) valid = false;
    }
    const allCaptured = [...(sourceIdsByShipment.get(shipment.id) ?? [])].sort((a, b) => a - b);
    const capturedIds = shipment.sources.map(item => item.id).sort((a, b) => a - b);
    if (reconstructionHash(allCaptured) !== reconstructionHash(capturedIds)) throw new Error("HISTORY_PROPOSAL_INCOMPLETE_SHIPMENT");
    if (!valid) { block("HISTORY_SHIPMENT_SOURCE_OWNER_CONFLICT", subject); continue; }
    if (["cancelled", "voided"].includes(shipment.status)
      && shipment.sources.every(item => item.purpose === "customer_fulfillment" || item.purpose === "replacement")) {
      record("shipment", shipment, "closed_shipment_intention", review?.evidenceHash ?? null, capturedIds);
    } else if (shipment.sources.length > 0 && shipment.status === "queued" && shipment.purpose === "customer_fulfillment"
      && shipment.sources.every(item => item.purpose === "customer_fulfillment" && item.owner?.quantity === item.owner?.fulfilledQuantity)) {
      record("shipment", shipment, "terminal_order_posting_debt", review?.evidenceHash ?? null, capturedIds);
    } else if (shipment.sources.length > 0 && shipment.status === "queued" && shipment.purpose === "replacement"
      && shipment.sources.every(item => isDuplicateCorrectionIntention(shipment, item))) {
      record("shipment", shipment, "duplicate_correction_intention", review?.evidenceHash ?? null, capturedIds);
    } else block("HISTORY_SHIPMENT_TREATMENT_UNPROVEN", subject);
  }
  // Fixed code-unit ordering keeps fingerprints independent of host ICU data.
  const compare = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;
  decisions.sort((a, b) => compare(`${a.kind}:${a.id}`, `${b.kind}:${b.id}`));
  blockers.sort((a, b) => compare(`${a.subject}:${a.code}`, `${b.subject}:${b.code}`));
  const content = {
    contractVersion: "inventory_cutover_history_proposal_v1" as const, executable: false as const,
    productionReady: false as const, sourceEvidenceHash: source.evidenceHash, factsHash: reconstructionHash(facts),
    groups: decisions.reduce<HistoricalWorkProposal["groups"]>((groups, row) => {
      groups[row.treatment] = (groups[row.treatment] ?? 0) + 1; return groups;
    }, {}), decisions, blockers, uncertainties: uncertainties.sort(),
    preservedCurrentOrderItemIds: current.map(item => item.id).sort((a, b) => a - b),
    requiredControls: ["Explicit approval of exact fingerprinted membership and unresolved-history treatment",
      "Fresh admitted transaction with live-lease, owner, source, package and definition rechecks",
      "Immutable before/after disposition audit and idempotent replay receipt",
      "Stop retired receipt and source processing before accepting an opening; no blanket review-filter waiver",
      "Do not alter inventory, cost, order fulfillment, package contents, labels or channel identities",
      "Unknown delivery/custody remains unknown; retain original evidence permanently"]
  };
  return { ...content, proposalHash: reconstructionHash(content) };
}

function isDuplicateCorrectionIntention(shipment: HistoricalShipmentFacts, item: HistoricalShipmentFacts["sources"][number]): boolean {
  if (item.purpose !== "omission_correction" || item.orderItemId !== null || item.replacementForOrderItemId !== null
    || !item.correctionForSourceItemId || item.correctedPhysicalItems.length !== 1 || !item.owner) return false;
  const physical = item.correctedPhysicalItems[0];
  return physical.provider === "shipstation" && shipment.externalFulfillmentId === `shipstation_shipment:${physical.providerShipmentId}`
    && physical.sourceItemId === item.correctionForSourceItemId && physical.orderItemId === item.owner.id
    && physical.variantId === item.variantId && physical.quantity === item.quantity && physical.adjustmentQuantity === 0
    && physical.status === "shipped" && item.owner.quantity === item.owner.fulfilledQuantity;
}
