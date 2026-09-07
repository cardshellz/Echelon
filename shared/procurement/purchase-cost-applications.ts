import { z } from "zod";
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

export const purchaseCostApplicationSchema = z.object({
  id,
  status: z.enum(["applied", "retry_required", "review_required"]),
  latestRecordedApplication: z.boolean(),
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

export const purchaseCostApplicationHistorySchema = z.object({
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
  })),
});

export type PurchaseCostApplicationHistory = z.infer<typeof purchaseCostApplicationHistorySchema>;
