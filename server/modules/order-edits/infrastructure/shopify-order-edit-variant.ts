import { z } from "zod";

const text = z.string().min(1);
const metafield = z.object({ value: z.string() }).nullable();
export const shopifyOrderEditVariantSchema = z.object({
  id: text,
  displayName: text,
  title: text,
  sku: z.string().nullable(),
  price: text,
  requiresComponents: z.boolean(),
  availableForSale: z.boolean(),
  inventoryPolicy: z.enum(["DENY", "CONTINUE"]),
  sellableOnlineQuantity: z.number().int().safe(),
  inventoryItem: z.object({
    requiresShipping: z.boolean(),
    tracked: z.boolean(),
  }),
  product: z.object({
    status: text,
    isGiftCard: z.boolean(),
    requiresSellingPlan: z.boolean(),
  }),
  membershipVariant: metafield,
  planPrices: metafield,
});
