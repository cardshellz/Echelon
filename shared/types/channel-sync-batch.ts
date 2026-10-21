import { z } from "zod";

const id = z.number().int().positive().max(2_147_483_647);
// Bound one saved operator run; channel adapters may hand off smaller chunks.
export const CHANNEL_SYNC_BATCH_LIMIT = 10_000;
export const channelSyncStateSchema = z.enum([
  "pending",
  "queued",
  "running",
  "retrying",
  "verifying",
  "completed",
  "needs_attention",
  "unavailable",
]);
export type ChannelSyncState = z.infer<typeof channelSyncStateSchema>;
export const channelSyncItemSchema = z
  .object({
    productId: id,
    name: z.string().min(1).max(500),
    sku: z.string().max(250).nullable(),
    commandKey: z.string().uuid(),
    operationId: z.string().min(1).max(200).nullable(),
    state: channelSyncStateSchema,
    code: z.string().max(100).nullable(),
    message: z.string().max(1000).nullable(),
    updatedAt: z.string().datetime(),
    nextAttemptAt: z.string().datetime().nullable(),
  })
  .strict();
export type ChannelSyncItem = z.infer<typeof channelSyncItemSchema>;
const count = z.number().int().nonnegative().max(CHANNEL_SYNC_BATCH_LIMIT);
export const channelSyncBatchSchema = z
  .object({
    id: z.string().uuid(),
    channelId: id,
    createdAt: z.string().datetime(),
    checkedAt: z.string().datetime(),
    lastActivityAt: z.string().datetime(),
    state: z.enum(["working", "completed", "needs_attention", "unavailable"]),
    counts: z
      .object({
        total: count,
        finished: count,
        completed: count,
        needsAttention: count,
        pending: count,
        queued: count,
        running: count,
        retrying: count,
        verifying: count,
        unavailable: count,
      })
      .strict(),
    items: z.array(channelSyncItemSchema).max(CHANNEL_SYNC_BATCH_LIMIT),
  })
  .strict()
  .superRefine((batch, context) => {
    const counts = batch.counts;
    const actual = (state: ChannelSyncState) =>
      batch.items.filter((item) => item.state === state).length;
    const states = {
      completed: "completed",
      needsAttention: "needs_attention",
      pending: "pending",
      queued: "queued",
      running: "running",
      retrying: "retrying",
      verifying: "verifying",
      unavailable: "unavailable",
    } as const;
    const expectedState = counts.unavailable
      ? "unavailable"
      : counts.finished < counts.total
        ? "working"
        : counts.needsAttention
          ? "needs_attention"
          : "completed";
    if (
      counts.total !== batch.items.length ||
      counts.finished !== counts.completed + counts.needsAttention ||
      Object.entries(states).some(
        ([key, state]) => counts[key as keyof typeof states] !== actual(state),
      ) ||
      new Set(batch.items.map((item) => item.commandKey)).size !==
        batch.items.length ||
      new Set(batch.items.map((item) => item.productId)).size !==
        batch.items.length ||
      batch.state !== expectedState
    )
      context.addIssue({
        code: "custom",
        message: "Sync counts must match the exact saved products and states.",
      });
  });
export type ChannelSyncBatch = z.infer<typeof channelSyncBatchSchema>;
export const channelSyncBatchesSchema = z
  .object({
    batches: z.array(channelSyncBatchSchema).max(10),
  })
  .strict();
export const startChannelSyncBatchSchema = z
  .object({
    commandKey: z.string().uuid(),
  })
  .strict();
