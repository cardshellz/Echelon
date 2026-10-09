import Decimal from "decimal.js";
import { z } from "zod";
import { orderEditPlanInputSchema } from "@shared/order-edits/order-edit.contract";
import { priceOrderEditDiscounts } from "./order-edit-discount-engine";
import { resolveOrderEditLinePlan } from "./order-edit-line-plan";
import { sumOrderEditCents } from "./order-edit-financials";
import { OrderEditError } from "./order-edit-error";

const cents = z.number().int().safe().nonnegative();
const lineId = z.string().regex(/^gid:\/\/shopify\/LineItem\/[1-9]\d*$/);
const variantId = z
  .string()
  .regex(/^gid:\/\/shopify\/ProductVariant\/[1-9]\d*$/);
const variantsSchema = z
  .array(
    z
      .object({
        variantId,
        title: z.string().min(1),
        variantTitle: z.string().nullable(),
        retailCents: cents,
        memberCents: cents,
        availableQuantity: z.number().int().safe(),
        available: z.boolean(),
      })
      .strict()
      .refine((v) => v.memberCents <= v.retailCents),
  )
  .max(250);
// Pricing receives only validated domain evidence, without credentials, order commands or persistence.
export const orderEditPreviewPricingContextSchema = z
  .object({
    snapshot: z
      .object({
        memberPricingEnabled: z.boolean(),
        memberPlan: z.string().min(1).nullable(),
        lines: z
          .array(
            z
              .object({
                id: lineId,
                variantId,
                title: z.string().min(1),
                variantTitle: z.string().nullable(),
                quantity: cents,
                originalUnitPriceCents: cents,
                unsupported: z.boolean(),
              })
              .strict(),
          )
          .max(250),
        previewProductDiscounts: z
          .array(
            z
              .object({
                lineId,
                amountCents: cents,
                automaticCents: cents,
              })
              .strict()
              .refine((line) => line.automaticCents <= line.amountCents),
          )
          .max(250),
        discountRules: z
          .array(
            z
              .object({
                type: z.string().min(1),
                targetType: z.string().min(1),
                allocationMethod: z.string().min(1),
                targetSelection: z.string().min(1),
                label: z.string().min(1),
                value: z.discriminatedUnion("type", [
                  z
                    .object({
                      type: z.literal("percentage"),
                      percentage: z.number().finite().min(0).max(100),
                    })
                    .strict(),
                  z
                    .object({ type: z.literal("fixed"), amountCents: cents })
                    .strict(),
                ]),
              })
              .strict(),
          )
          .max(250),
      })
      .strict(),
    variants: variantsSchema,
  })
  .strict();
export type OrderEditPreviewPricingContext = z.infer<
  typeof orderEditPreviewPricingContextSchema
>;
export type OrderEditPreviewVariant = z.infer<typeof variantsSchema>[number];
function fail(message: string): never {
  throw new OrderEditError("ORDER_EDIT_PREVIEW_PRICING_UNAVAILABLE", message);
}
function scaled(amount: number, original: number, next: number): number {
  const numerator = BigInt(amount) * BigInt(next);
  if (original <= 0 || numerator % BigInt(original) !== BigInt(0))
    fail(
      "The item's original discount cannot be prorated to exact cents. Review will verify it with Shopify.",
    );
  const value = numerator / BigInt(original);
  if (value > BigInt(Number.MAX_SAFE_INTEGER))
    fail("The preview exceeds the supported money range.");
  return Number(value);
}
/** Uses the same protected-line resolver and coupon/reward engine as the authoritative edit. */
export function priceOrderEditPreviewItems(
  context: OrderEditPreviewPricingContext,
  plan: z.infer<typeof orderEditPlanInputSchema>,
) {
  const { snapshot, variants } =
    orderEditPreviewPricingContextSchema.parse(context);
  const parsed = orderEditPlanInputSchema.parse(plan);
  const evidence = new Map(
    snapshot.previewProductDiscounts.map((line) => [line.lineId, line]),
  );
  const byVariant = new Map(variants.map((v) => [v.variantId, v]));
  if (
    evidence.size !== snapshot.previewProductDiscounts.length ||
    byVariant.size !== variants.length
  )
    fail("Duplicate product identities appeared in preview pricing.");
  const originals = snapshot.lines.filter((line) => line.quantity > 0);
  if (
    new Set(originals.map((line) => line.id)).size !== originals.length ||
    evidence.size !== originals.length ||
    originals.some((line) => line.unsupported || !evidence.has(line.id))
  )
    fail(
      "The preview requires unique supported physical items and exact product discount evidence.",
    );
  const itemRules = (snapshot.discountRules ?? []).filter(
    (rule) => rule.targetType === "LINE_ITEM",
  );
  if (
    itemRules.some((rule) =>
      rule.type === "DiscountCodeApplication"
        ? rule.targetSelection !== "ALL" || rule.allocationMethod !== "ACROSS"
        : ![
            "AutomaticDiscountApplication",
            "ManualDiscountApplication",
          ].includes(rule.type) ||
          (rule.type === "ManualDiscountApplication" &&
            (rule.allocationMethod !== "EACH" ||
              rule.targetSelection !== "EXPLICIT")),
    )
  )
    fail(
      "This discount's scope requires verification by Shopify before totals can be shown.",
    );
  const staged = resolveOrderEditLinePlan({
    originals: originals.map(({ id, variantId, quantity }) => ({
      id,
      variantId,
      quantity,
    })),
    changes: parsed.changes,
    additions: parsed.additions,
    protectedLineIds: originals
      .filter((line) => evidence.get(line.id)!.automaticCents > 0)
      .map((line) => line.id),
  });
  const demand = new Map<string, number>();
  const addDemand = (id: string, quantity: number) =>
    demand.set(id, sumOrderEditCents([demand.get(id) ?? 0, quantity]));
  for (const change of parsed.changes) {
    const line = originals.find((line) => line.id === change.lineItemId);
    if (!line) fail("The changed item does not belong to this order.");
    if (change.quantity > line.quantity)
      addDemand(line.variantId, change.quantity - line.quantity);
  }
  for (const line of parsed.additions) addDemand(line.variantId, line.quantity);
  for (const [id, quantity] of demand) {
    const variant = byVariant.get(id);
    if (!variant || !variant.available || variant.availableQuantity < quantity)
      fail("The extra quantity is not available for a background preview.");
  }
  const lines = originals.flatMap((line) => {
    const quantity =
      staged.changes.find((change) => change.lineItemId === line.id)
        ?.quantity ?? line.quantity;
    if (!quantity) return [];
    const grossCents = scaled(line.originalUnitPriceCents, 1, quantity);
    const productCents = scaled(
      evidence.get(line.id)!.amountCents,
      line.quantity,
      quantity,
    );
    if (productCents > grossCents)
      fail("The product discount exceeds the item's price.");
    return [
      {
        id: line.id,
        title: line.title,
        variantTitle: line.variantTitle,
        variantId: line.variantId,
        quantity,
        grossCents,
        productNetCents: grossCents - productCents,
      },
    ];
  });
  for (const addition of staged.additions) {
    const variant = byVariant.get(addition.variantId);
    if (!variant) fail("Current pricing is missing for an added product.");
    if (addition.quantityIncreaseOfLineId) {
      const original = originals.find(
        (line) => line.id === addition.quantityIncreaseOfLineId,
      )!;
      if (
        !snapshot.memberPricingEnabled ||
        !snapshot.memberPlan ||
        variant.memberCents >= variant.retailCents ||
        scaled(
          variant.retailCents - variant.memberCents,
          1,
          original.quantity,
        ) !== evidence.get(original.id)!.automaticCents
      )
        fail(
          "The current member price does not reproduce the original item's member discount.",
        );
    }
    lines.push({
      id: `preview:add:${variant.variantId}`,
      title: variant.title,
      variantTitle: variant.variantTitle,
      variantId: variant.variantId,
      quantity: addition.quantity,
      grossCents: scaled(variant.retailCents, 1, addition.quantity),
      productNetCents: scaled(variant.memberCents, 1, addition.quantity),
    });
  }
  if (!lines.length) fail("An order must retain at least one physical item.");
  const priced = priceOrderEditDiscounts({
    rules: itemRules
      .filter((rule) => rule.type === "DiscountCodeApplication")
      .map((rule) => ({
        key: `code:${rule.label}`,
        label: rule.label,
        value:
          rule.value.type === "percentage"
            ? {
                type: "percentage" as const,
                percentage: new Decimal(rule.value.percentage).toFixed(),
              }
            : rule.value,
      })),
    lines: lines.map((line) => ({
      id: line.id,
      subtotalCents: line.productNetCents,
    })),
  });
  if (priced.unusedFixedCredits.length)
    fail(
      "Unused reward credit requires settlement review before this edit can be applied.",
    );
  const productCents = sumOrderEditCents(
    lines.map((line) => line.grossCents - line.productNetCents),
  );
  return {
    lines: lines.map((line) => ({
      ...line,
      netCents:
        line.productNetCents -
        sumOrderEditCents(
          priced.allocations
            .filter((a) => a.lineId === line.id)
            .map((a) => a.amountCents),
        ),
    })),
    discounts: [
      ...priced.discounts,
      ...(productCents
        ? [
            {
              key: "product",
              label: "Product discounts",
              amountCents: productCents,
              value: { type: "allocated" as const },
            },
          ]
        : []),
    ].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)),
    itemsNetCents: priced.subtotalAfterOrderDiscountsCents,
  };
}
