import { z } from "zod";

const id = z.string().regex(/^[1-9][0-9]{0,18}$/).refine(value => BigInt(value) <= BigInt("9223372036854775807"));
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const ebayPublicationRecoveryPreviewSchema = z.object({
  previewHash: hash,
  canResume: z.boolean(),
  blockReason: z.enum(["active_request", "broader_scope", "no_pending_attempts"]).nullable(),
  attempts: z.array(z.object({
    attemptId: id,
    state: z.enum(["running", "uncertain"]),
    skus: z.array(z.string().min(1).max(240)).min(1).max(251),
    startedAt: z.string().datetime(),
    requests: z.array(z.object({
      requestId: id, method: z.string().min(1).max(10), path: z.string().min(1).max(1024),
      httpStatus: z.number().int().min(100).max(599).nullable(), responseRecorded: z.boolean(),
      errorCodes: z.array(z.string().max(100)).max(25),
      outcome: z.enum(["completed", "rejected", "uncertain"]).nullable(),
    }).strict()).max(2000),
  }).strict()).max(100),
}).strict();
export type EbayPublicationRecoveryPreview = z.infer<typeof ebayPublicationRecoveryPreviewSchema>;

export const ebayPublicationRecoveryConfirmationSchema = z.object({
  previewHash: hash,
  idempotencyKey: z.string().trim().min(1).max(200),
  acknowledgeUnknownOutcome: z.literal(true),
}).strict();
export const ebayPublicationRecoveryResultSchema = z.object({
  attemptIds: z.array(id).min(1).max(100),
  replayed: z.boolean(),
  providerWriteAttempted: z.literal(false),
}).strict();
export type EbayPublicationRecoveryResult = z.infer<typeof ebayPublicationRecoveryResultSchema>;
