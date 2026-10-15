import { z } from "zod";
import {
  orderEditTaxLineSchema,
  type OrderEditTaxLine,
} from "@shared/order-edits/order-edit-taxes";
import { OrderEditProviderError } from "../application/order-edit-provider";
import { cents } from "./shopify-order-edit-money";

const money = z.object({
  amount: z.string().min(1),
  currencyCode: z.literal("USD"),
});
export const shopifyOrderEditTaxLineSchema = orderEditTaxLineSchema
  .omit({ amountCents: true })
  .extend({ priceSet: z.object({ shopMoney: money, presentmentMoney: money }) });

export function readShopifyOrderEditTaxLines(
  lines: z.infer<typeof shopifyOrderEditTaxLineSchema>[] | undefined,
): OrderEditTaxLine[] | undefined {
  return lines?.map(({ title, ratePercentage, priceSet }) => {
    const amountCents = cents(priceSet.shopMoney.amount);
    if (amountCents !== cents(priceSet.presentmentMoney.amount))
      throw new OrderEditProviderError(
        "ORDER_EDIT_TAX_CURRENCY_MISMATCH",
        "The tax amounts do not match in shop and presentment currency.",
      );
    return { title, ratePercentage, amountCents };
  });
}
