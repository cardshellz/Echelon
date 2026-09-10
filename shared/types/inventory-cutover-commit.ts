import { z } from "zod";
import { cutoverOpeningProvenanceSchema, openingReservationRebaseSchema } from "./inventory-cutover-reconstruction";

const id = z.number().int().positive().max(2_147_483_647);
const bigintId = z.string().regex(/^[1-9][0-9]*$/).max(19)
  .refine((value) => /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value) <= BigInt("9223372036854775807"));
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const text = (maximum: number) => z.string().trim().min(1).max(maximum);

export const inventoryCutoverDefinitionSelectionSchema = z.object({
  kind: z.enum(["model", "location_policy", "safety_policy", "channel_policy", "source_binding", "variant_mapping"]),
  key: text(200),
  definitionId: id,
  definitionHash: hash,
}).strict();

export const inventoryCutoverManifestSchema = z.object({
  contractVersion: z.literal("inventory_cutover_selection_manifest_v1"),
  productIds: z.array(id).max(10_000),
  publicationTargetIds: z.array(id).max(10_000),
  selections: z.array(inventoryCutoverDefinitionSelectionSchema).max(100_000),
}).strict().superRefine((manifest, context) => {
  for (const field of ["productIds", "publicationTargetIds"] as const) {
    if (manifest[field].some((value, index, values) => index > 0 && value <= values[index - 1])) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: [field], message: "Manifest identities must be unique and sorted." });
    }
  }
  const keys = manifest.selections.map((selection) => `${selection.kind}:${selection.key}`);
  if (new Set(keys).size !== keys.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["selections"], message: "A head can select only one definition." });
  }
});

export const previewInventoryCutoverRequestSchema = z.object({ activationRunId: bigintId }).strict();

export const inventoryCutoverReviewSchema = z.object({
  contractVersion: z.literal("inventory_cutover_review_v1"),
  activationRunId: bigintId,
  authorityRevision: bigintId,
  capturedAt: z.string().datetime(),
  reviewHash: hash,
  selectionManifestHash: hash,
  reconstructionHash: hash,
  freshClaimImpactHash: hash,
  ready: z.boolean(),
  manifest: inventoryCutoverManifestSchema,
  summary: z.object({
    orders: z.number().int().nonnegative(),
    lines: z.number().int().nonnegative(),
    retainedIndependentBuildHolds: z.number().int().nonnegative(),
    openingBalance: cutoverOpeningProvenanceSchema.optional(),
    openingReservationRebases: z.array(openingReservationRebaseSchema).min(1).max(50_000).optional(),
    // Optional for responses captured before the promise-handoff extension.
    legacyPromiseReplanning: z.object({ positions: z.number().int().nonnegative(),
      orderLines: z.number().int().nonnegative() }).strict().refine((summary) =>
      summary.orderLines >= summary.positions && (summary.positions > 0 || summary.orderLines === 0),
    "Every promise position must have at least one retained demand line").optional(),
  }).strict(),
  publicationRows: z.array(z.object({
    publicationTargetId: id,
    productVariantId: id,
    desiredQuantity: z.string().regex(/^(0|[1-9][0-9]*)$/),
  }).strict()).max(100_000),
  blockers: z.array(z.object({ code: text(100), subject: text(200), message: text(2000) }).strict()),
  operationalWriteAttempted: z.literal(false),
  providerWriteAttempted: z.literal(false),
}).strict().superRefine((review, context) => {
  if (review.ready !== (review.blockers.length === 0)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["ready"], message: "Readiness must match complete blocking evidence." });
  }
  const keys = review.publicationRows.map((row) => `${row.publicationTargetId}:${row.productVariantId}`);
  if (new Set(keys).size !== keys.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["publicationRows"], message: "A publication target/SKU must appear exactly once." });
  }
});

export const commitInventoryCutoverRequestSchema = z.object({
  activationRunId: bigintId,
  expectedAuthorityRevision: bigintId,
  expectedReviewHash: hash,
  idempotencyKey: text(120),
  reason: text(1000),
}).strict();

export const inventoryCutoverCommitResultSchema = z.object({
  activationRunId: bigintId,
  runtimeAuthority: z.literal("canonical"),
  authorityRevision: bigintId,
  reviewHash: hash,
  selectionManifestHash: hash,
  reconstructionHash: hash,
  fullPublicationRows: z.number().int().nonnegative(),
  publicationVerification: z.literal("pending"),
  alreadyApplied: z.boolean(),
}).strict();

export type InventoryCutoverDefinitionSelection = z.infer<typeof inventoryCutoverDefinitionSelectionSchema>;
export type InventoryCutoverManifest = z.infer<typeof inventoryCutoverManifestSchema>;
export type CommitInventoryCutoverRequest = z.infer<typeof commitInventoryCutoverRequestSchema>;
export type InventoryCutoverCommitResult = z.infer<typeof inventoryCutoverCommitResultSchema>;
export type InventoryCutoverReview = z.infer<typeof inventoryCutoverReviewSchema>;
