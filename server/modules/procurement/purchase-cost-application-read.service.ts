import { isHistoricalCostIssue } from "@shared/procurement/cost-posting-status";
import { createHash } from "node:crypto";
import { z } from "zod";
import { reconciliationPostingSchema } from "@shared/procurement/cost-reconciliation";
import { unresolvedCostQuantitySchema } from "@shared/procurement/cost-source-contracts";
import { canonicalJson } from "@shared/utils/canonical-json";
import { costComponentSchema, costIssueSchema, costSourceRevisionSchema, type CostIssue } from "@shared/procurement/cost-source-contracts";
import { appliedCostBalanceSnapshotSchema, costBalanceSnapshotSchema, purchaseCostApplicationHistorySchema, isPurchaseCostResolutionVerified, purchaseCostCurrentResolutionSchema, purchaseCostResolutionPostingSchema, type PurchaseCostApplicationHistory } from "@shared/procurement/purchase-cost-applications";

const id = z.number().int().positive().safe();
const integer = z.number().int().safe();
const date = z.string().datetime({ offset: true });
const state = z.enum(["applied", "retry_required", "review_required"]);

export const purchaseCostApplicationReadSchema = z.object({
  revisions: z.array(z.object({
    id, purchaseOrderLineId: id, shipmentLineId: id.nullable(), shipmentId: id.nullable(),
    component: costComponentSchema, revision: integer.positive(), fingerprint: z.string(),
    contract: z.unknown(), sourceEvidence: z.unknown().optional(), recordedBy: z.string(), recordedAt: date,
  })),
  applications: z.array(z.object({
    id, sourceRevisionId: id, status: state, result: z.unknown(), recordedBy: z.string(), recordedAt: date,
  })),
  lotChanges: z.array(z.object({
    applicationId: id, lotId: id, before: z.unknown(), after: z.unknown(),
    lotNumber: z.string().nullable(), variantId: id.nullable(), locationId: id.nullable(), currentOnHandUnits: integer.nullable(),
    receivingLineId: id.nullable(), originalPurchaseOrderLineId: id.nullable(),
  })),
  contributions: z.array(z.object({
    id, sourceLotId: id, outputLotId: id, sourceQty: integer.positive(), outputQty: integer.positive(),
    outputStartQty: integer.nonnegative(), operationKind: z.enum(["transfer", "conversion", "assembly", "build"]), operationKey: z.string(),
  })),
  currentResolutions: z.array(purchaseCostCurrentResolutionSchema).optional(),
  reconciliationPostings: z.array(purchaseCostResolutionPostingSchema).optional(),
  reportingEvents: z.array(z.object({
    id, applicationId: id, contractVersion: integer.positive(), recordedAt: date,
    historicalCostAdjustments: z.unknown().optional(), unresolvedQuantities: z.unknown().optional(),
    sourceRevisionId: z.unknown(), sourceFingerprint: z.unknown(), component: z.unknown(), currency: z.unknown(), cogsDeltaCents: z.unknown(), payloadContractVersion: z.unknown(), changeCount: integer.nonnegative().nullable(),
  })),
});
export type PurchaseCostApplicationRead = z.infer<typeof purchaseCostApplicationReadSchema>;

const recordedResultSchema = z.object({
  status: state,
  lotsUpdated: integer.nonnegative(), cogsRowsUpdated: integer.nonnegative(), totalCogsDeltaCents: integer,
  issues: z.array(costIssueSchema),
});

function groupById<T>(rows: readonly T[], key: (row: T) => number): Map<number, T[]> {
  const groups = new Map<number, T[]>();
  for (const row of rows) {
    const id = key(row);
    const entries = groups.get(id) ?? [];
    entries.push(row); groups.set(id, entries);
  }
  return groups;
}
function issue(code: string, message: string): CostIssue { return { code, message }; }

function projectChange(
  row: PurchaseCostApplicationRead["lotChanges"][number],
  edges: PurchaseCostApplicationRead["contributions"],
  component: z.infer<typeof costComponentSchema>,
): PurchaseCostApplicationHistory["revisions"][number]["applications"][number]["lotChanges"][number] {
  const issues: CostIssue[] = [];
  const before = costBalanceSnapshotSchema.safeParse(row.before);
  const after = appliedCostBalanceSnapshotSchema.safeParse(row.after);
  if (!before.success || !after.success) issues.push(issue("COST_SNAPSHOT_INVALID", `Lot ${row.lotId} has an invalid recorded component snapshot.`));
  if (after.success) {
    const value = after.data;
    const componentKey = { product: "productMills", packaging: "packagingMills", landed: "landedMills" } as const;
    if (value.component !== component
      || BigInt(value.productMills) + BigInt(value.packagingMills) + BigInt(value.landedMills) !== BigInt(value.totalMills)
      || BigInt(value[componentKey[component]]) * BigInt(value.quantity) + BigInt(value.remainderMills) !== BigInt(value.allocatedMills)) {
      issues.push(issue("COST_SNAPSHOT_CONFLICT", `Lot ${row.lotId} component totals or captured allocation do not reconcile.`));
    }
  }
  if (row.receivingLineId !== null && edges.length > 0) issues.push(issue("COST_ORIGIN_CONFLICT", `Lot ${row.lotId} has both receipt-origin and transformation evidence.`));
  if (row.receivingLineId === null && edges.length === 0) issues.push(issue("COST_LOT_LINEAGE_UNKNOWN", `Lot ${row.lotId} has no immutable receipt origin or incoming contribution.`));
  if (edges.some((edge) => edge.outputStartQty >= edge.outputQty)) issues.push(issue("COST_CONTRIBUTION_INTERVAL_INVALID", `Lot ${row.lotId} has an invalid output interval.`));
  return {
    lotId: row.lotId, lotNumber: row.lotNumber, variantId: row.variantId, locationId: row.locationId,
    currentOnHandUnits: row.currentOnHandUnits, receivingLineId: row.receivingLineId,
    originalPurchaseOrderLineId: row.originalPurchaseOrderLineId,
    lineage: row.receivingLineId !== null && edges.length === 0 ? "original_receipt" : edges.length > 0 && row.receivingLineId === null ? "transformed" : "unknown",
    contributions: edges,
    before: before.success ? before.data : null,
    after: after.success ? after.data : null,
    issues,
  };
}

/** Read immutable snapshots without turning an old successful application into
 * an assertion that every receipt or descendant currently exists in its scope. */
export function projectPurchaseCostApplications(input: PurchaseCostApplicationRead, purchaseOrderId: number): PurchaseCostApplicationHistory {
  const data = purchaseCostApplicationReadSchema.parse(input);
  const applicationsByRevision = groupById(data.applications, (row) => row.sourceRevisionId);
  const changesByApplication = groupById(data.lotChanges, (row) => row.applicationId);
  const edgesByOutput = groupById(data.contributions, (row) => row.outputLotId);
  const eventsByApplication = groupById(data.reportingEvents, (row) => row.applicationId);
  const postingsByApplication = groupById(data.reconciliationPostings ?? [], (row) => row.applicationId);
  const latestRevision = new Map<string, number>();
  const revisionKey = (row: PurchaseCostApplicationRead["revisions"][number]) => `${row.purchaseOrderLineId}:${row.shipmentLineId ?? 0}:${row.component}`;
  for (const row of data.revisions) latestRevision.set(revisionKey(row), Math.max(latestRevision.get(revisionKey(row)) ?? 0, row.revision));
  const revisions = data.revisions.map((row) => {
    const issues: CostIssue[] = [];
    const parsed = costSourceRevisionSchema.safeParse(row.contract);
    let source = parsed.success ? parsed.data : null;
    if (source) {
      const { fingerprint, revision, ...economicInput } = source;
      const expectedFingerprint = createHash("sha256").update(canonicalJson({ input: economicInput, sourceEvidence: row.sourceEvidence ?? null })).digest("hex");
      // Earlier nullable-payload rows fingerprinted only the economic contract.
      // Never accept that legacy format when a raw source snapshot is present:
      // otherwise the snapshot could change without invalidating its evidence.
      const legacyFingerprint = row.sourceEvidence == null ? createHash("sha256").update(canonicalJson(economicInput)).digest("hex") : null;
      const fingerprintMatches = fingerprint === expectedFingerprint || fingerprint === legacyFingerprint;
      const scope = source.scope;
      if (source.component !== row.component || revision !== row.revision || fingerprint !== row.fingerprint || !fingerprintMatches
        || scope.purchaseOrderId !== purchaseOrderId || scope.purchaseOrderLineId !== row.purchaseOrderLineId
        || (scope.kind === "shipment_line" ? scope.inboundShipmentLineId !== row.shipmentLineId || scope.inboundShipmentId !== row.shipmentId : row.shipmentLineId !== null)) {
        issues.push(issue("COST_REVISION_SOURCE_CONFLICT", `Revision ${row.id} does not reconcile to its immutable fingerprint or purchase/shipment scope.`));
        source = null;
      }
    } else issues.push(issue("COST_REVISION_INVALID", `Revision ${row.id} has invalid or unsupported source evidence.`));
    if (source?.issue) issues.push(source.issue);
    const revisionApplications = (applicationsByRevision.get(row.id) ?? []);
    const latestApplicationId = Math.max(0, ...revisionApplications.map((application) => application.id));
    const applications = revisionApplications.map((application) => {
      const problems: CostIssue[] = [];
      const result = recordedResultSchema.safeParse(application.result);
      if (!result.success || result.data.status !== application.status) problems.push(issue("COST_APPLICATION_RESULT_INVALID", `Application ${application.id} has an invalid or conflicting recorded result.`));
      if (result.success) problems.push(...result.data.issues);
      if (!source) problems.push(issue("COST_APPLICATION_SOURCE_UNVERIFIED", "The source revision must be reviewed before this application can be verified."));
      if (source && application.status === "applied" && (source.currency === null || source.totalMills === null || source.basePieces === null
        || (source.evidence !== "estimated" && source.evidence !== "confirmed"))) {
        problems.push(issue("COST_APPLICATION_SOURCE_UNRESOLVED", "An applied record cannot establish cost authority while its source amount, currency or evidence remains unresolved."));
      }
      const changes = (changesByApplication.get(application.id) ?? []).map((change) =>
        projectChange(change, edgesByOutput.get(change.lotId) ?? [], row.component));
      const snapshotIssues = changes.flatMap((change) => change.issues);
      if (snapshotIssues.length) problems.push(...snapshotIssues);
      const retainedQuantityReview = result.success && application.status === "review_required" && result.data.status === application.status
        && result.data.issues.length > 0 && result.data.issues.every((problem) => problem.code === "COST_UNRESOLVED_QUANTITY_RETAINED" && problem.unresolvedQuantity?.component === row.component);
      const historicalLineageReview = result.success && application.status === "review_required" && result.data.status === application.status
        && result.data.issues.length > 0 && result.data.issues.every((problem) => problem.code === "COST_HISTORICAL_LINEAGE_MISSING" && !problem.unresolvedQuantity)
        && changes.length === 0 && result.data.cogsRowsUpdated === 0 && result.data.totalCogsDeltaCents === 0;
      if (result.success && (result.data.lotsUpdated !== changes.length || (application.status !== "applied" && !retainedQuantityReview && changes.length > 0))) {
        problems.push(issue("COST_APPLICATION_LOTS_CONFLICT", "The recorded changed-lot count does not reconcile to the immutable application rows."));
      }
      const events = eventsByApplication.get(application.id) ?? [];
      const event = events[0];
      const postings = postingsByApplication.get(application.id) ?? [];
      const eventPostings = reconciliationPostingSchema.array().safeParse(event?.historicalCostAdjustments ?? []);
      const postingsMatch = eventPostings.success && canonicalJson(eventPostings.data) === canonicalJson(postings.map((posting) => ({
        id: posting.id, approvalId: posting.approvalId, destination: posting.destination,
        beforeMills: posting.beforeMills, afterMills: posting.afterMills, deltaMills: posting.deltaMills,
      }))) && postings.every((posting) => posting.sourceRevisionId === row.id)
        && (postings.length === 0 || (row.component === "landed" && source?.currency === "USD"));
      const unresolved = unresolvedCostQuantitySchema.array().safeParse(event?.unresolvedQuantities ?? []);
      const unresolvedMatch = unresolved.success && canonicalJson(unresolved.data) === canonicalJson(retainedQuantityReview && result.success
        ? result.data.issues.map((problem) => problem.unresolvedQuantity) : []);
      const eventOutcomeAllowed = application.status === "applied" || retainedQuantityReview || (historicalLineageReview && postings.length > 0);
      const validEvent = event !== undefined && events.length === 1 && eventOutcomeAllowed && result.success && source !== null
        && result.data.status === application.status
        && event.contractVersion === 1 && event.payloadContractVersion === 1 && event.changeCount === changes.length && event.sourceRevisionId === row.id && event.sourceFingerprint === row.fingerprint
        && event.component === row.component && event.currency === source.currency && event.cogsDeltaCents === result.data.totalCogsDeltaCents
        && postingsMatch && unresolvedMatch;
      if ((application.status === "applied" || retainedQuantityReview || postings.length > 0 || events.length > 0) && !validEvent) problems.push(issue("COST_REPORTING_EVENT_UNVERIFIED", "The internal reporting event is missing, unsupported or inconsistent with this application."));
      return {
        id: application.id, status: application.status, latestRecordedApplication: application.id === latestApplicationId,
        recordedBy: application.recordedBy, recordedAt: application.recordedAt,
        evidenceState: problems.length === 0 ? "verified_record" as const : "review_required" as const,
        issues: problems,
        outcome: result.success ? { lotsUpdated: result.data.lotsUpdated, cogsRowsUpdated: result.data.cogsRowsUpdated, totalCogsDeltaCents: result.data.totalCogsDeltaCents } : null,
        lotChanges: changes,
        reportingEvent: event ? { id: event.id, contractVersion: event.contractVersion, recordedAt: event.recordedAt,
          evidenceState: validEvent ? "verified_record" as const : "review_required" as const, externalDelivery: "not_verified" as const } : null,
      };
    });
    const candidateResolutions = (data.currentResolutions ?? []).filter((resolution) => resolution.sourceRevisionId === row.id);
    const candidate = candidateResolutions.length === 1 ? candidateResolutions[0] : null;
    const latestApplication = applications.find((application) => application.id === latestApplicationId);
    // An approval resolves the current source, never rewrites an older source or
    // claims that an earlier failed attempt performed the later posting.
    const currentResolution = candidate && source?.component === "landed" && source.scope.kind === "shipment_line"
      && source.currency === "USD" && source.issue === null && ["estimated", "confirmed"].includes(source.evidence)
      && source.totalMills !== null && candidate.postedMills <= source.totalMills
      && row.revision === latestRevision.get(revisionKey(row)) && candidate.sourceFingerprint === row.fingerprint
      && candidate.applicationId === latestApplicationId && latestApplication?.status === "review_required"
      && latestApplication.issues.length > 0 && latestApplication.issues.every(isHistoricalCostIssue)
      && new Set(candidate.postings.map((posting) => posting.id)).size === candidate.postings.length
      && new Set(candidate.postings.map((posting) => posting.destination)).size === candidate.postings.length
      && candidate.postings.every((posting) => (data.reconciliationPostings ?? []).some((record) => canonicalJson(record) === canonicalJson(posting)))
      && candidate.postings.reduce((total, posting) => total + BigInt(posting.afterMills), BigInt(0)) === BigInt(candidate.postedMills)
      && candidate.postings.every((posting) => posting.destination === candidate.destination || posting.afterMills === 0)
      ? candidate : null;
    return {
      id: row.id, purchaseOrderLineId: row.purchaseOrderLineId, shipmentLineId: row.shipmentLineId, component: row.component,
      revision: row.revision, fingerprint: row.fingerprint, latestRecordedSourceRevision: row.revision === latestRevision.get(revisionKey(row)),
      recordedBy: row.recordedBy, recordedAt: row.recordedAt, source, issues, applications, currentResolution,
    };
  });
  const history = { coverage: "recorded_application_snapshots" as const, revisions };
  return purchaseCostApplicationHistorySchema.parse({ ...history, revisions: revisions.map((revision) => {
    const currentResolution = isPurchaseCostResolutionVerified(history, revision) ? revision.currentResolution : null;
    return { ...revision, currentResolution, applications: revision.applications.map((application) => ({ ...application,
      resolvedByCurrentPosting: currentResolution !== null && application.status === "review_required"
        && application.issues.length > 0 && application.issues.every(isHistoricalCostIssue),
    })) };
  }) });
}
