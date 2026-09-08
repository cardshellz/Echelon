import { z } from "zod";

const bigintId = z.string().regex(/^[1-9][0-9]{0,18}$/).refine(value =>
  /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value) <= BigInt("9223372036854775807"));
const quantity = z.string().regex(/^(0|[1-9][0-9]{0,18})$/).refine(value =>
  /^(0|[1-9][0-9]{0,18})$/.test(value) && BigInt(value) <= BigInt("9223372036854775807"));
const id = z.number().int().positive().max(2_147_483_647);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const text = (max: number) => z.string().trim().min(1).max(max);

export const inventoryCutoverVerificationRequestSchema = z.object({ activationRunId: bigintId }).strict();
export const inventoryCutoverVerificationSchema = z.object({
  contractVersion: z.literal("inventory_cutover_verification_v1"),
  activationRunId: bigintId,
  authorityRevision: bigintId,
  capturedAt: z.string().datetime(),
  verificationHash: hash,
  ready: z.boolean(),
  configurationFreezeOpen: z.boolean(),
  completedAt: z.string().datetime().nullable(),
  expectedPublicationRows: z.number().int().nonnegative().max(100_000),
  verifiedPublicationRows: z.number().int().nonnegative().max(100_000),
  publicationRows: z.array(z.object({
    publicationTargetId: id, productVariantId: id,
    desiredRevision: bigintId, desiredQuantity: quantity,
    observedQuantity: quantity.nullable(), state: text(30),
  }).strict()).max(100_000),
  blockers: z.array(z.object({ code: text(100), subject: text(200), message: text(2000) }).strict()),
  providerWriteAttempted: z.literal(false),
  operationalWriteAttempted: z.literal(false),
}).strict().superRefine((value, ctx) => {
  if (value.ready !== (value.completedAt === null && value.configurationFreezeOpen && value.blockers.length === 0)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["ready"], message: "Readiness must agree with complete verification evidence." });
  }
  if (value.verifiedPublicationRows > value.expectedPublicationRows
    || value.publicationRows.length > value.expectedPublicationRows
    || (value.completedAt === null && value.verifiedPublicationRows > value.publicationRows.length)
    || ((value.ready || value.completedAt !== null) && value.verifiedPublicationRows !== value.expectedPublicationRows)
    || (value.ready && (value.publicationRows.length !== value.expectedPublicationRows
      || value.publicationRows.some(row => row.state !== "verified" || row.observedQuantity !== row.desiredQuantity)))
    || (value.completedAt !== null && (value.configurationFreezeOpen || value.blockers.length > 0))) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Completion and publication counts must be internally consistent." });
  }
  const keys = value.publicationRows.map(row => `${row.publicationTargetId}:${row.productVariantId}`);
  if (new Set(keys).size !== keys.length) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["publicationRows"], message: "Publication pairs must be unique." });
});

export const finishInventoryCutoverRequestSchema = z.object({
  activationRunId: bigintId,
  expectedVerificationHash: hash,
  idempotencyKey: text(120),
  reason: text(1000),
}).strict();

export const finishInventoryCutoverResultSchema = z.object({
  activationRunId: bigintId,
  runtimeAuthority: z.literal("canonical"),
  authorityRevision: bigintId,
  verificationHash: hash,
  verifiedPublicationRows: z.number().int().nonnegative().max(100_000),
  completedAt: z.string().datetime(),
  configurationFreezeReleased: z.literal(true),
  alreadyApplied: z.boolean(),
}).strict();

export type InventoryCutoverVerification = z.infer<typeof inventoryCutoverVerificationSchema>;
export type FinishInventoryCutoverRequest = z.infer<typeof finishInventoryCutoverRequestSchema>;
export type FinishInventoryCutoverResult = z.infer<typeof finishInventoryCutoverResultSchema>;
