import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJson } from "@shared/utils/canonical-json";
import { costComponentSchema, costIssueSchema, costSourceRevisionSchema, type CostIssue } from "@shared/procurement/cost-source-contracts";
import { appliedCostBalanceSnapshotSchema, costBalanceSnapshotSchema, purchaseCostApplicationHistorySchema, type PurchaseCostApplicationHistory } from "@shared/procurement/purchase-cost-applications";

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
  reportingEvents: z.array(z.object({
    id, applicationId: id, contractVersion: integer.positive(), recordedAt: date,
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
      if (result.success && (result.data.lotsUpdated !== changes.length || (application.status !== "applied" && changes.length > 0))) {
        problems.push(issue("COST_APPLICATION_LOTS_CONFLICT", "The recorded changed-lot count does not reconcile to the immutable application rows."));
      }
      const events = eventsByApplication.get(application.id) ?? [];
      const event = events[0];
      const validEvent = event !== undefined && events.length === 1 && application.status === "applied" && result.success && source !== null
        && event.contractVersion === 1 && event.payloadContractVersion === 1 && event.changeCount === changes.length && event.sourceRevisionId === row.id && event.sourceFingerprint === row.fingerprint
        && event.component === row.component && event.currency === source.currency && event.cogsDeltaCents === result.data.totalCogsDeltaCents;
      if ((application.status === "applied" || events.length > 0) && !validEvent) problems.push(issue("COST_REPORTING_EVENT_UNVERIFIED", "The internal reporting event is missing, unsupported or inconsistent with this application."));
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
    return {
      id: row.id, purchaseOrderLineId: row.purchaseOrderLineId, shipmentLineId: row.shipmentLineId, component: row.component,
      revision: row.revision, fingerprint: row.fingerprint, latestRecordedSourceRevision: row.revision === latestRevision.get(revisionKey(row)),
      recordedBy: row.recordedBy, recordedAt: row.recordedAt, source, issues, applications,
    };
  });
  return purchaseCostApplicationHistorySchema.parse({ coverage: "recorded_application_snapshots", revisions });
}
