import { matchesFinancialHeaders } from "./sales-financials";
import { z } from "zod";
import { shopifyDiscountEvidenceSchema } from "./shopify-discount-evidence";
export const commerceOriginSchema = z
  .object({
    version: z.literal(1),
    connector: z.enum(["shopify", "ebay", "dropship", "amazon", "unknown"]),
    salesChannel: z.enum([
      "shopify_online",
      "tiktok_shop",
      "shopify_pos",
      "shopify_other",
      "shopify_unknown",
      "ebay",
      "dropship",
      "amazon",
      "unknown",
    ]),
    sourceName: z.string().max(160).nullable(),
    evidence: z.enum([
      "provider_source",
      "connector",
      "dropship_acceptance",
      "unknown",
    ]),
  })
  .strict()
  .superRefine((v, ctx) => {
    const allowed: Record<string, string[]> = {
      shopify: [
        "shopify_online",
        "tiktok_shop",
        "shopify_pos",
        "shopify_other",
        "shopify_unknown",
      ],
      ebay: ["ebay"],
      dropship: ["dropship"],
      amazon: ["amazon"],
      unknown: ["unknown"],
    };
    if (!allowed[v.connector].includes(v.salesChannel))
      ctx.addIssue({
        code: "custom",
        message: "Sales channel conflicts with connector",
      });
  });
export type CommerceOrigin = z.infer<typeof commerceOriginSchema>;
export const salesChannelLabels: Record<string, string> = {
  shopify_online: "Shopify online store",
  tiktok_shop: "TikTok Shop",
  shopify_pos: "Shopify POS",
  shopify_other: "Other Shopify channel",
  shopify_unknown: "Shopify — channel unidentified",
  ebay: "eBay",
  dropship: "Dropship",
  amazon: "Amazon",
  unknown: "Unidentified",
};
export function salesChannelLabel(key: string): string {
  return salesChannelLabels[key] ?? key;
}
const cents = z.number().int().nonnegative().max(2147483647);
const optionalText = z.string().max(500).nullable().optional();
export const commerceSnapshotSchema = z
  .object({
    event: z.literal("order.snapshot"),
    revision: z.string().regex(/^[1-9][0-9]{0,17}$/),
    order: z
      .object({
        echelon_order_id: z.number().int().positive().safe(),
        commerce_origin: commerceOriginSchema,
        external_order_id: z.string().trim().min(1).max(200),
        order_number: optionalText,
        channel_id: z.number().int().positive(),
        channel_name: z.string().max(160),
        ordered_at: z.string().datetime(),
        total_cents: cents,
        subtotal_cents: cents,
        shipping_cents: cents,
        tax_cents: cents,
        discount_cents: cents,
        discount_evidence: shopifyDiscountEvidenceSchema.optional(),
        refund_cents: cents,
        currency: z.string().regex(/^[A-Z]{3}$/),
        financial_status: z.string().min(1).max(30),
        fulfillment_status: z.string().max(30),
        customer_email: z.string().email().max(254).nullable().optional(),
        customer_name: optionalText,
        line_items: z.array(z.unknown()).max(10000),
        discount_codes: z
          .array(
            z.object({
              code: z.string().min(1).max(160),
              amount: z.string().optional(),
              type: z.string().optional(),
            }),
          )
          .max(100)
          .nullable()
          .optional(),
        tags: z.string().max(20000).nullable().optional(),
        tracking_number: optionalText,
        tracking_carrier: optionalText,
      })
      .passthrough()
      .superRefine((order, ctx) => {
        const f = order.discount_evidence?.financials;
        if (f && !matchesFinancialHeaders(f, order))
          ctx.addIssue({
            code: "custom",
            message: "Financial evidence disagrees with order headers",
          });
      }),
  })
  .strict();
export type CommerceSnapshot = z.infer<typeof commerceSnapshotSchema>;
