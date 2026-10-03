import { z } from "zod";
import { quoteDropshipShippingInputSchema } from "./dropship-use-case-dtos";

export const quoteDropshipShippingForMemberInputSchema = quoteDropshipShippingInputSchema.omit({
  vendorId: true,
});

export type QuoteDropshipShippingForMemberInput = z.infer<typeof quoteDropshipShippingForMemberInputSchema>;

const positiveIdSchema = z.number().int().positive();

export const replayDropshipShippingQuoteInputSchema = z.object({
  vendorId: positiveIdSchema,
  storeConnectionId: positiveIdSchema,
  quoteSnapshotId: positiveIdSchema,
}).strict();

export type ReplayDropshipShippingQuoteInput = z.infer<typeof replayDropshipShippingQuoteInputSchema>;
