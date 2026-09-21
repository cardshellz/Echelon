import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { channelProductIdentities } from "@shared/schema";
import type { db } from "../../db";

type TransactionClient = Parameters<Parameters<typeof db.transaction>[0]>[0];

const identityKeySchema = z.object({
  channelId: z.number().int().positive().safe(),
  productId: z.number().int().positive().safe(),
  externalProductId: z.string().trim().min(1),
});

/**
 * Channels owns binding persistence. Catalog verifies ownership and calls this
 * inside its mapping transaction so catalog metadata, binding, and audit commit
 * together. The unique channel/external-product key rejects competing owners.
 */
export async function upsertChannelProductIdentity(
  tx: TransactionClient,
  input: z.input<typeof identityKeySchema>,
): Promise<void> {
  const identity = identityKeySchema.parse(input);
  await tx.insert(channelProductIdentities).values(identity).onConflictDoUpdate({
    target: [channelProductIdentities.channelId, channelProductIdentities.productId],
    set: { externalProductId: identity.externalProductId },
  });
}

const removalSchema = z.object({
  channelId: z.number().int().positive().safe(),
  productIds: z.array(z.number().int().positive().safe()),
});

/** Remove only the verified products in this channel, within the caller's repair transaction. */
export async function removeChannelProductIdentities(
  tx: TransactionClient,
  input: { channelId: number; productIds: readonly number[] },
): Promise<void> {
  const { channelId, productIds } = removalSchema.parse(input);
  if (productIds.length === 0) return;
  await tx.delete(channelProductIdentities).where(and(
    eq(channelProductIdentities.channelId, channelId),
    inArray(channelProductIdentities.productId, productIds),
  ));
}
