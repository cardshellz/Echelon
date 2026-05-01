import { z } from "zod";
import { quoteDropshipShippingInputSchema } from "./dropship-use-case-dtos";

export const quoteDropshipShippingForMemberInputSchema = quoteDropshipShippingInputSchema.omit({
  vendorId: true,
});

export type QuoteDropshipShippingForMemberInput = z.infer<typeof quoteDropshipShippingForMemberInputSchema>;
