import { sql } from "drizzle-orm";
import { z } from "zod";
import { channelVariantOverrides } from "@shared/schema";
import type { db } from "../../db";

type TransactionClient = Parameters<Parameters<typeof db.transaction>[0]>[0];

const notListedSchema = z.object({
  channelId: z.number().int().positive().safe(),
  productVariantId: z.number().int().positive().safe(),
  at: z.date(),
});

/**
 * Channels owns per-channel listing overrides. Catalog calls this inside its
 * Shopify mapping repair transaction to record that a SKU is not listed on a
 * store whose variant was deleted, so the override commits with the repair.
 *
 * Only `is_listed` changes; an existing row keeps its name, SKU, barcode and
 * weight overrides. No override lock is taken: per
 * infrastructure/channel-variant-override-lock.ts that lock serializes SKU
 * override writes with stock-link confirmation, and this never sets a SKU.
 */
export async function markChannelVariantNotListed(
  tx: TransactionClient,
  input: z.input<typeof notListedSchema>,
): Promise<void> {
  const value = notListedSchema.parse(input);
  await tx.insert(channelVariantOverrides)
    .values({ channelId: value.channelId, productVariantId: value.productVariantId, isListed: 0, updatedAt: value.at })
    .onConflictDoUpdate({
      target: [channelVariantOverrides.channelId, channelVariantOverrides.productVariantId],
      set: { isListed: 0, updatedAt: sql`excluded.updated_at` },
    });
}
