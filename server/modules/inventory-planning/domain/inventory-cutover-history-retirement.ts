import { historyReviewSchema, type HistoryReview, type RetireHistoryRequest } from "@shared/types/inventory-cutover-history";
import type { OpeningSource } from "@shared/types/inventory-cutover-opening";
import type { CutoverReconstructionEvidence } from "@shared/types/inventory-cutover-reconstruction";
import { proposeHistoricalWork, type CutoverHistoryFacts } from "./inventory-cutover-history-proposal";
import { reconstructionHash } from "./inventory-cutover-reconstruction";

export class CutoverHistoryError extends Error {
  constructor(readonly code: string, message: string, readonly status = 409,
    readonly context: Readonly<Record<string, unknown>> = {}) {
    super(message);
    this.name = "CutoverHistoryError";
  }
}

/** Review identity excludes capture time, but includes every reviewed business fact. */
export function reviewHistoricalWork(source: OpeningSource, facts: CutoverHistoryFacts): HistoryReview {
  const proposal = proposeHistoricalWork(source, facts);
  const blockers = [...proposal.blockers];
  if (source.latestVerification !== null) {
    // A failed cutover keeps its immutable opening. New history can make that
    // opening stale before a retry; its existence must not permanently prevent
    // reviewed cleanup. Only an unfrozen legacy owner may replace that stale
    // basis. Reconstruction still rejects its old evidence hash, and retirement
    // changes the hash again, so a fresh opening is required before activation.
    const staleUnfrozenOpening = source.runtimeAuthority === "legacy"
      && source.configurationRunId === null
      && source.latestVerification.authorityRevision === source.authorityRevision
      && source.latestVerification.sourceEvidenceHash !== source.evidenceHash;
    if (!staleUnfrozenOpening) blockers.push({ code: "HISTORY_OPENING_ALREADY_SAVED", subject: "opening" });
  }
  if (proposal.decisions.length === 0) blockers.push({ code: "HISTORY_NO_WORK", subject: "history" });
  const content = {
    contractVersion: "inventory_cutover_history_review_v1" as const,
    authorityRevision: source.authorityRevision, configurationRunId: source.configurationRunId,
    sourceEvidenceHash: source.evidenceHash, decisions: proposal.decisions, blockers,
    unresolvedReceiptIds: proposal.decisions.filter(row => row.treatment === "unresolved_channel_quarantine").map(row => row.id),
    preservedCurrentOrderItemIds: proposal.preservedCurrentOrderItemIds,
    readyForRetirement: blockers.length === 0, activatesInventory: false as const,
  };
  return historyReviewSchema.parse({ ...content, reviewHash: reconstructionHash(content) });
}

export function assertHistoryRetirementApproved(review: HistoryReview, request: RetireHistoryRequest): void {
  if (!review.readyForRetirement || review.blockers.length > 0) throw new CutoverHistoryError(
    "HISTORY_RETIREMENT_BLOCKED", "Current work or incomplete evidence blocks historical retirement.", 409, { blockers: review.blockers });
  if (review.reviewHash !== request.expectedReviewHash || review.authorityRevision !== request.expectedAuthorityRevision
    || review.configurationRunId !== request.expectedConfigurationRunId) throw new CutoverHistoryError(
    "HISTORY_REVIEW_CHANGED", "Evidence changed after review. Refresh the complete review before applying.");
  if (review.unresolvedReceiptIds.length > 0 && !request.acceptUnresolvedOrigin) throw new CutoverHistoryError(
    "HISTORY_UNKNOWN_ORIGIN_NOT_ACCEPTED", "The exact unresolved-origin cohort requires explicit quarantine acceptance.");
}

/** Pure processing projection. Full original evidence remains in the census/hash.
 * The repository only supplies this capability after validating durable immutable
 * audit rows. Physical packages, costs, orders and quantities are NEVER filtered. */
export function activeCutoverHistory(evidence: CutoverReconstructionEvidence): CutoverReconstructionEvidence {
  const retired = evidence.retiredHistory ?? [];
  if (new Set(retired.map(row => `${row.kind}:${row.id}`)).size !== retired.length) {
    throw new CutoverHistoryError("HISTORY_RETIREMENT_DUPLICATE", "Duplicate retired-work identities in the census.", 500);
  }
  const receipts = new Set(retired.filter(row => row.kind === "receipt").map(row => row.id));
  const shipments = new Set(retired.filter(row => row.kind === "shipment").map(row => Number(row.id)));
  const sources = new Set(retired.flatMap(row => row.sourceItemIds));
  const reviewByKey = new Map(evidence.shipmentReviewEvidence.map(row => [`${row.kind}:${row.id}`, row]));
  if (reviewByKey.size !== evidence.shipmentReviewEvidence.length) throw new CutoverHistoryError(
    "HISTORY_DUPLICATE_REVIEW", "Duplicate review identities cannot authorize history retirement.");
  const sourceHashes = historySourceHashes(evidence);
  const emptySourcesHash = reconstructionHash([]);
  for (const row of retired) {
    const kind = row.kind === "receipt" ? "channel_fulfillment_receipt" : "outbound_shipment_review";
    const currentReview = reviewByKey.get(`${kind}:${row.id}`);
    if ((currentReview?.evidenceHash ?? null) !== row.reviewEvidenceHash) throw new CutoverHistoryError(
      "HISTORY_RETIRED_EVIDENCE_CHANGED", "Retired work changed after its audit. Review the new evidence before cutover.");
    const currentSources = row.kind === "receipt" ? undefined : sourceHashes.get(Number(row.id));
    if ((currentSources?.hash ?? emptySourcesHash) !== row.sourceItemsHash
      || (currentSources?.count ?? 0) !== row.sourceItemIds.length) throw new CutoverHistoryError(
      "HISTORY_RETIREMENT_MEMBERSHIP_CHANGED", "Retired shipment membership differs from the retained source census.");
  }
  for (const row of evidence.sourceItems) {
    if (sources.has(row.id) !== shipments.has(row.shipmentId)) throw new CutoverHistoryError(
      "HISTORY_RETIREMENT_MEMBERSHIP_CHANGED", "Retired shipment membership differs from the retained source census.", 500);
  }
  return { ...evidence,
    sourceItems: evidence.sourceItems.filter(row => !sources.has(row.id)),
    shipmentReviewEvidence: evidence.shipmentReviewEvidence.filter(row => !(row.kind === "channel_fulfillment_receipt" && receipts.has(row.id))
      && !(row.kind === "outbound_shipment_review" && shipments.has(Number(row.id)))),
  };
}

/** Index once: bulk review must not rescan the complete source census for each
 * retired header. Row order is not business evidence. */
export function historySourceHashes(evidence: Pick<CutoverReconstructionEvidence,"sourceItems">) {
  const groups = new Map<number,CutoverReconstructionEvidence["sourceItems"]>();
  for (const row of evidence.sourceItems) {
    const rows = groups.get(row.shipmentId) ?? [];
    rows.push(row); groups.set(row.shipmentId,rows);
  }
  return new Map([...groups].map(([id,rows]) => [id,{ count: rows.length,
    hash: reconstructionHash(rows.sort((a,b) => a.id-b.id)) }]));
}
