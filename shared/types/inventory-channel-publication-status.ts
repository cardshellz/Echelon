import { z } from "zod";

const id = z.number().int().positive().max(2_147_483_647);
const integer = z.string().regex(/^(0|[1-9][0-9]*)$/).max(19);
const timestamp = z.string().datetime({ offset: true });

export const channelPublicationStatusRequestSchema = z.object({
  publicationTargetId: id,
  productId: id,
}).strict();

/** Persisted delivery evidence, not a fresh provider query or an ATP calculation. */
export const channelPublicationStatusSchema = z.object({
  publicationTargetId: id,
  productId: id,
  capturedAt: timestamp,
  runtimeAuthority: z.enum(["legacy", "canonical"]),
  targetRevision: integer,
  rows: z.array(z.object({
    productVariantId: id,
    activeInventoryItemId: z.string().min(1).max(240).nullable(),
    desired: z.object({
      outboxId: integer,
      revision: integer,
      quantity: integer,
      targetRevision: integer.nullable(),
      state: z.enum(["desired", "queued", "leased", "acknowledged", "verified", "drifted", "retryable", "dead_letter", "superseded", "cancelled"]),
      createdAt: timestamp,
    }).strict().nullable(),
    acknowledged: z.object({
      outboxId: integer,
      quantity: integer,
      acknowledgedAt: timestamp,
    }).strict().nullable(),
    observed: z.object({
      quantity: integer,
      observedAt: timestamp,
      outboxId: integer.nullable(),
      matchesDesired: z.boolean().nullable(),
      targetRevision: integer,
    }).strict().nullable(),
  }).strict()).max(1_000),
}).strict();

export type ChannelPublicationStatusRequest = z.infer<typeof channelPublicationStatusRequestSchema>;
export type ChannelPublicationStatus = z.infer<typeof channelPublicationStatusSchema>;
