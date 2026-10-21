import { z } from "zod";
import {
  CHANNEL_SYNC_BATCH_LIMIT,
  channelSyncBatchSchema,
  channelSyncItemSchema,
  type ChannelSyncBatch,
  type ChannelSyncItem,
} from "../../../../shared/types/channel-sync-batch";

export const syncDestinationSchema = z
  .object({
    channelId: z.number().int().positive().max(2_147_483_647),
    provider: z.string().min(1).max(80),
    connectionId: z.number().int().positive().max(2_147_483_647),
    accountId: z.string().min(1).max(240),
    environment: z.string().min(1).max(80),
    marketplaceId: z.string().min(1).max(100).nullable(),
  })
  .strict();
export type SyncDestination = z.infer<typeof syncDestinationSchema>;
export const syncBatchMemberSchema = channelSyncItemSchema.pick({
  productId: true,
  name: true,
  sku: true,
  commandKey: true,
});
export type SyncBatchMember = z.infer<typeof syncBatchMemberSchema>;
export const syncAdmissionRefusalSchema = z
  .object({
    code: z.string().min(1).max(100),
    message: z.string().min(1).max(1000),
  })
  .strict();
export type SyncAdmissionRefusal = z.infer<typeof syncAdmissionRefusalSchema>;
export class ChannelSyncAdmissionRefused extends Error {
  constructor(readonly refusal: SyncAdmissionRefusal) {
    super(refusal.message);
  }
}
export const savedSyncBatchSchema = z
  .object({
    id: z.string().uuid(),
    destination: syncDestinationSchema,
    actor: z.string().min(1).max(200),
    createdAt: z.string().datetime(),
    admissionCompletedAt: z.string().datetime().nullable(),
    admissionError: z.string().max(1000).nullable(),
    admissionRefusal: syncAdmissionRefusalSchema.nullable().default(null),
    members: z.array(syncBatchMemberSchema).max(CHANNEL_SYNC_BATCH_LIMIT),
  })
  .strict()
  .superRefine((batch, context) => {
    if (
      new Set(batch.members.map((member) => member.productId)).size !==
        batch.members.length ||
      new Set(batch.members.map((member) => member.commandKey)).size !==
        batch.members.length
    )
      context.addIssue({
        code: "custom",
        message: "Batch products and command keys must be unique.",
      });
  });
export type SavedSyncBatch = z.infer<typeof savedSyncBatchSchema>;
export type SyncCommandStatus = Pick<
  ChannelSyncItem,
  | "commandKey"
  | "operationId"
  | "state"
  | "code"
  | "message"
  | "updatedAt"
  | "nextAttemptAt"
>;

export class ChannelSyncBatchError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 409,
  ) {
    super(message);
    this.name = "ChannelSyncBatchError";
  }
}

/** Progress observes exact saved commands. It never substitutes a product's
 * latest job, infers provider success, or owns provider execution/retries. */
export function projectSyncBatch(
  batch: SavedSyncBatch,
  statuses: readonly SyncCommandStatus[],
  checkedAt: Date,
): ChannelSyncBatch {
  const byCommand = new Map(
    statuses.map((status) => [status.commandKey, status]),
  );
  const members = new Set(batch.members.map((member) => member.commandKey));
  if (
    byCommand.size !== statuses.length ||
    statuses.some((status) => !members.has(status.commandKey))
  )
    throw new ChannelSyncBatchError(
      "SYNC_BATCH_STATUS_INVALID",
      "Sync status did not match this saved request.",
      502,
    );
  const items = batch.members.map((member) => {
    const status = byCommand.get(member.commandKey);
    return channelSyncItemSchema.parse({
      ...member,
      operationId: null,
      state: batch.admissionRefusal
        ? "needs_attention"
        : batch.admissionCompletedAt
          ? "unavailable"
          : "pending",
      code:
        batch.admissionRefusal?.code ??
        (batch.admissionCompletedAt ? "SYNC_COMMAND_RECEIPT_MISSING" : null),
      message:
        batch.admissionRefusal?.message ??
        (batch.admissionCompletedAt
          ? "The saved update receipt could not be found. Review this listing before requesting another sync."
          : batch.admissionError),
      updatedAt: batch.createdAt,
      nextAttemptAt: null,
      ...status,
    });
  });
  const count = (state: ChannelSyncItem["state"]) =>
    items.filter((item) => item.state === state).length;
  const completed = count("completed");
  const needsAttention = count("needs_attention");
  const unavailable = count("unavailable");
  const finished = completed + needsAttention;
  const state =
    unavailable > 0
      ? "unavailable"
      : finished < items.length
        ? "working"
        : needsAttention > 0
          ? "needs_attention"
          : "completed";
  return channelSyncBatchSchema.parse({
    id: batch.id,
    channelId: batch.destination.channelId,
    createdAt: batch.createdAt,
    checkedAt: checkedAt.toISOString(),
    lastActivityAt: items.reduce(
      (latest, item) => (item.updatedAt > latest ? item.updatedAt : latest),
      batch.createdAt,
    ),
    state,
    counts: {
      total: items.length,
      finished,
      completed,
      needsAttention,
      pending: count("pending"),
      queued: count("queued"),
      running: count("running"),
      retrying: count("retrying"),
      verifying: count("verifying"),
      unavailable,
    },
    items,
  });
}
