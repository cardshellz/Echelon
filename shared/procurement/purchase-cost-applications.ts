import { z } from "zod";
import { isHistoricalCostIssue } from "./cost-posting-status";
import { reconciliationDestinationSchema, reconciliationPostingSchema } from "./cost-reconciliation";
import { costComponentSchema, costIssueSchema, costSourceRevisionSchema } from "./cost-source-contracts";

const id = z.number().int().positive().safe();
const integer = z.number().int().safe();
const date = z.string().datetime({ offset: true });

export const costBalanceSnapshotSchema = z.object({
  productMills: integer,
  packagingMills: integer,
  landedMills: integer,
});
export const appliedCostBalanceSnapshotSchema = costBalanceSnapshotSchema.extend({
  totalMills: integer,
  component: costComponentSchema,
  allocatedMills: integer,
  quantity: integer.positive(),
  remainderMills: integer,
});

/** Current resolution is separate from the immutable result of every attempt. */
export const purchaseCostResolutionPostingSchema = reconciliationPostingSchema.innerType().extend({
  applicationId: id, sourceRevisionId: id, actorName: z.string(), reason: z.string(), recordedAt: date,
}).refine((posting) => reconciliationPostingSchema.safeParse({
  id: posting.id, approvalId: posting.approvalId, destination: posting.destination,
  beforeMills: posting.beforeMills, afterMills: posting.afterMills, deltaMills: posting.deltaMills,
}).success, { message: "Historical posting does not reconcile to its exact before/after difference" });
export const purchaseCostCurrentResolutionSchema = z.object({
  sourceRevisionId: id,
  sourceFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  applicationId: id,
  currency: z.literal("USD"),
  destination: reconciliationDestinationSchema,
  postedMills: integer.nonnegative(),
  postings: z.array(purchaseCostResolutionPostingSchema).min(1).max(2),
});

export const purchaseCostApplicationSchema = z.object({
  id,
  status: z.enum(["applied", "retry_required", "review_required"]),
  latestRecordedApplication: z.boolean(),
  resolvedByCurrentPosting: z.boolean().optional(),
  recordedBy: z.string(),
  recordedAt: date,
  evidenceState: z.enum(["verified_record", "review_required"]),
  issues: z.array(costIssueSchema),
  outcome: z.object({
    lotsUpdated: integer.nonnegative(),
    cogsRowsUpdated: integer.nonnegative(),
    totalCogsDeltaCents: integer,
  }).nullable(),
  // These are immutable application snapshots, not current balances or proof
  // that receipts/transformations created later have already been processed.
  lotChanges: z.array(z.object({
    lotId: id,
    lotNumber: z.string().nullable(),
    variantId: id.nullable(),
    locationId: id.nullable(),
    currentOnHandUnits: integer.nullable(),
    lineage: z.enum(["original_receipt", "transformed", "unknown"]),
    receivingLineId: id.nullable(),
    originalPurchaseOrderLineId: id.nullable(),
    contributions: z.array(z.object({
      id,
      sourceLotId: id,
      sourceQty: integer.positive(),
      outputQty: integer.positive(),
      outputStartQty: integer.nonnegative(),
      operationKind: z.enum(["transfer", "conversion", "assembly", "build"]),
      operationKey: z.string(),
    })),
    before: costBalanceSnapshotSchema.nullable(),
    after: appliedCostBalanceSnapshotSchema.nullable(),
    issues: z.array(costIssueSchema),
  })),
  reportingEvent: z.object({
    id,
    contractVersion: integer.positive(),
    recordedAt: date,
    evidenceState: z.enum(["verified_record", "review_required"]),
    externalDelivery: z.literal("not_verified"),
  }).nullable(),
});

const purchaseCostApplicationHistoryCoreSchema = z.object({
  coverage: z.literal("recorded_application_snapshots"),
  revisions: z.array(z.object({
    id,
    purchaseOrderLineId: id,
    shipmentLineId: id.nullable(),
    component: costComponentSchema,
    revision: integer.positive(),
    latestRecordedSourceRevision: z.boolean(),
    fingerprint: z.string(),
    recordedBy: z.string(),
    recordedAt: date,
    source: costSourceRevisionSchema.nullable(),
    issues: z.array(costIssueSchema),
    applications: z.array(purchaseCostApplicationSchema),
    currentResolution: purchaseCostCurrentResolutionSchema.nullable().optional(),
  })),
});

type CostHistory = z.infer<typeof purchaseCostApplicationHistoryCoreSchema>;

/** Structural proof travels with the response. Current approval still comes
 * from the canonical repository; an old failed record cannot validate a banner. */
export function isPurchaseCostResolutionVerified(history: CostHistory, revision: CostHistory["revisions"][number]): boolean {
  const resolution = revision.currentResolution;
  const source = revision.source;
  const latest = revision.applications.reduce<CostHistory["revisions"][number]["applications"][number] | null>(
    (current, application) => !current || application.id > current.id ? application : current, null);
  const historicalIssuesOnly = (application: NonNullable<typeof latest>) => application.status === "review_required"
    && application.issues.length > 0 && application.issues.every(isHistoricalCostIssue);
  if (!resolution || !source
    || source.issue !== null || source.currency !== "USD" || source.totalMills === null
    || !["estimated", "confirmed"].includes(source.evidence) || !revision.latestRecordedSourceRevision
    || resolution.sourceRevisionId !== revision.id || resolution.sourceFingerprint !== revision.fingerprint
    || source.fingerprint !== revision.fingerprint || !latest || !latest.latestRecordedApplication
    || resolution.applicationId !== latest.id || !historicalIssuesOnly(latest)
    || resolution.postedMills > source.totalMills
    || new Set(resolution.postings.map((posting) => posting.id)).size !== resolution.postings.length
    || new Set(resolution.postings.map((posting) => posting.destination)).size !== resolution.postings.length
    || resolution.postings.reduce((sum, posting) => sum + BigInt(posting.afterMills), BigInt(0)) !== BigInt(resolution.postedMills)
    || resolution.postings.some((posting) => posting.destination !== resolution.destination && posting.afterMills !== 0)) return false;
  const sourceScope = source.scope;
  return resolution.postings.every((posting) => {
    const backingRevisions = history.revisions.filter((row) => row.id === posting.sourceRevisionId);
    if (backingRevisions.length !== 1) return false;
    const backing = backingRevisions[0], backingSource = backing.source;
    const applications = backing.applications.filter((application) => application.id === posting.applicationId);
    if (!backingSource || backingSource.scope.kind !== source.scope.kind || backingSource.component !== source.component
      || backingSource.issue !== null || backingSource.currency !== "USD" || applications.length !== 1
      || backing.purchaseOrderLineId !== revision.purchaseOrderLineId || backing.shipmentLineId !== revision.shipmentLineId
      || backingSource.scope.purchaseOrderId !== sourceScope.purchaseOrderId
      || (sourceScope.kind === "shipment_line" && (backingSource.scope.kind !== "shipment_line"
        || backingSource.scope.inboundShipmentId !== sourceScope.inboundShipmentId
        || backingSource.scope.inboundShipmentLineId !== sourceScope.inboundShipmentLineId))) return false;
    const application = applications[0];
    return historicalIssuesOnly(application) && application.reportingEvent?.evidenceState === "verified_record";
  });
}

export const purchaseCostApplicationHistorySchema = purchaseCostApplicationHistoryCoreSchema.superRefine((history, context) => {
  history.revisions.forEach((revision, index) => {
    const verifiedResolution = isPurchaseCostResolutionVerified(history, revision);
    revision.applications.forEach((application, applicationIndex) => {
      if (application.resolvedByCurrentPosting && (!verifiedResolution || application.status !== "review_required"
        || application.issues.length === 0 || !application.issues.every(isHistoricalCostIssue))) {
        context.addIssue({ code: z.ZodIssueCode.custom,
          path: ["revisions", index, "applications", applicationIndex, "resolvedByCurrentPosting"],
          message: "This original application is not covered by a verified current posting" });
      }
    });
    if (revision.currentResolution && !verifiedResolution) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["revisions", index, "currentResolution"],
        message: "Current cost resolution does not reconcile to this source and its verified posting history" });
    }
  });
});
export type PurchaseCostApplicationHistory = z.infer<typeof purchaseCostApplicationHistorySchema>;
