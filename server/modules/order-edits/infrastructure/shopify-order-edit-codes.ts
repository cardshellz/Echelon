import { createHash } from "node:crypto";
import Decimal from "decimal.js";
import { z } from "zod";
import { canonicalJson } from "@shared/utils/canonical-json";
import {
  orderEditCodeRuleSchema,
  orderEditCombinesWithSchema,
  orderEditDiscountClassSchema,
  type OrderEditCodeRule,
} from "@shared/order-edits/order-edit-codes";
import {
  assertOrderEditCodeCombinations,
  type OrderEditCombinationDiscount,
} from "../domain/order-edit-code-combinations";
import {
  shippingCalculationLines,
  shippingItemTotals,
} from "../domain/order-edit-shipping";
import { cents } from "./shopify-order-edit-money";
import {
  OrderEditProviderError,
  type OrderEditSnapshot,
} from "../application/order-edit-provider";
import type { OrderEditCodePricingLine } from "../domain/order-edit-code-pricing";

const money = z.object({ amount: z.string(), currencyCode: z.literal("USD") });
const bag = z.object({ shopMoney: money, presentmentMoney: money });
const integer = z.number().int().nonnegative().safe();
const page = z.object({ hasNextPage: z.boolean() });
const combines = `combinesWith { productDiscounts orderDiscounts shippingDiscounts }`;
export const ORDER_EDIT_CODE_LOOKUP = `query EchelonEditCode($code: String!, $search: String!) {
  codeDiscountNodeByCode(code: $code) { id codeDiscount { __typename ... on DiscountCodeBasic {
    title status startsAt endsAt usageLimit appliesOncePerCustomer asyncUsageCount discountClasses
    codes(first: 2, query: $search) { nodes { code } pageInfo { hasNextPage } }
    codesCount { count precision }
    ${combines} context { __typename ... on DiscountCustomers { customers { id } } }
    customerGets { items { __typename ... on AllDiscountItems { allItems } }
      value { __typename ... on DiscountPercentage { percentage } ... on DiscountAmount { amount { amount currencyCode } appliesOnEachItem } } }
    minimumRequirement { __typename ... on DiscountMinimumSubtotal { greaterThanOrEqualToSubtotal { amount currencyCode } }
      ... on DiscountMinimumQuantity { greaterThanOrEqualToQuantity } }
  } } }
}`;
const lookupSchema = z.object({
  codeDiscountNodeByCode: z
    .object({
      id: z.string(),
      codeDiscount: z.object({
        __typename: z.literal("DiscountCodeBasic"),
        title: z.string(),
        status: z.enum(["ACTIVE", "EXPIRED", "SCHEDULED"]),
        startsAt: z.string().datetime(),
        endsAt: z.string().datetime().nullable(),
        usageLimit: integer.positive().nullable(),
        appliesOncePerCustomer: z.boolean(),
        asyncUsageCount: integer,
        discountClasses: z.array(orderEditDiscountClassSchema),
        codes: z.object({
          nodes: z.array(z.object({ code: z.string() })),
          pageInfo: page,
        }),
        codesCount: z.object({
          count: integer,
          precision: z.enum(["EXACT", "AT_LEAST"]),
        }),
        combinesWith: orderEditCombinesWithSchema,
        // Eligibility belongs to Shopify's calculation with the actual buyer.
        // Customer segments and customer-specific coupons are not points rewards.
        context: z.object({
          __typename: z.string().min(1),
          customers: z.array(z.object({ id: z.string() })).optional(),
        }),
        customerGets: z.object({
          items: z.object({
            __typename: z.literal("AllDiscountItems"),
            allItems: z.literal(true),
          }),
          value: z.discriminatedUnion("__typename", [
            z.object({
              __typename: z.literal("DiscountPercentage"),
              percentage: z.number().finite().positive().max(1),
            }),
            z.object({
              __typename: z.literal("DiscountAmount"),
              amount: money,
              appliesOnEachItem: z.literal(false),
            }),
          ]),
        }),
        minimumRequirement: z
          .union([
            z.object({
              __typename: z.literal("DiscountMinimumSubtotal"),
              greaterThanOrEqualToSubtotal: money,
            }),
            z.object({
              __typename: z.literal("DiscountMinimumQuantity"),
              greaterThanOrEqualToQuantity: z.string().regex(/^\d+$/),
            }),
          ])
          .nullable(),
      }),
    })
    .nullable(),
});
const AUTOMATIC_RULES = `query EchelonEditCombinationRules {
  shopifyFunctions(first: 100) { nodes { id handle } pageInfo { hasNextPage } }
  discountNodes(first: 100, query: "method:automatic") { nodes { id discount { __typename
    ... on DiscountAutomaticApp { title status discountClasses ${combines} appDiscountType { functionId } }
    ... on DiscountAutomaticBasic { title status discountClasses ${combines} }
    ... on DiscountAutomaticFreeShipping { title status discountClasses ${combines} }
  } } pageInfo { hasNextPage } }
}`;
type Request = (
  query: string,
  variables: Record<string, unknown>,
) => Promise<unknown>;
function fail(code: string, message: string): never {
  throw new OrderEditProviderError(code, message);
}
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success)
    fail(
      "ORDER_EDIT_CODE_RULES_UNAVAILABLE",
      "The complete eligibility and combination rules for this code could not be verified. No code was applied.",
    );
  return result.data;
}
export function readOrderEditCodeRule(
  raw: unknown,
  code: string,
): OrderEditCodeRule {
  const node = parse(lookupSchema, raw).codeDiscountNodeByCode;
  if (!node)
    fail(
      "ORDER_EDIT_CODE_NOT_FOUND",
      "This discount code was not found. Check the code and try again.",
    );
  const discount = node.codeDiscount;
  const normalized = code.trim().toUpperCase();
  if (
    !discount.codes.nodes.some(
      (entry) => entry.code.toUpperCase() === normalized,
    )
  )
    fail(
      "ORDER_EDIT_CODE_IDENTITY_MISMATCH",
      "Shopify did not return this exact code.",
    );
  if (
    discount.discountClasses.length !== 1 ||
    discount.discountClasses[0] !== "ORDER"
  )
    fail(
      "ORDER_EDIT_CODE_SCOPE_UNSUPPORTED",
      "This type of discount cannot be added to an existing order. No code was applied.",
    );
  const value =
    discount.customerGets.value.__typename === "DiscountPercentage"
      ? {
          type: "percentage" as const,
          percentage: new Decimal(discount.customerGets.value.percentage)
            .times(100)
            .toFixed(),
        }
      : {
          type: "fixed" as const,
          amountCents: cents(discount.customerGets.value.amount.amount),
        };
  if (value.type === "fixed" && value.amountCents <= 0)
    fail("ORDER_EDIT_CODE_NO_SAVING", "This code has no available discount.");
  const terms = {
    discountId: node.id,
    code: normalized,
    classes: discount.discountClasses,
    combinesWith: discount.combinesWith,
    value,
    context: discount.context,
    minimumRequirement: discount.minimumRequirement,
    startsAt: discount.startsAt,
    endsAt: discount.endsAt,
    usageLimit: discount.usageLimit,
    appliesOncePerCustomer: discount.appliesOncePerCustomer,
  };
  return orderEditCodeRuleSchema.parse({
    discountId: node.id,
    code: normalized,
    classes: discount.discountClasses,
    combinesWith: discount.combinesWith,
    value,
    fingerprint: createHash("sha256")
      .update(canonicalJson(terms))
      .digest("hex"),
    redemption: "shopify_coupon",
    usageLimit: discount.usageLimit,
    appliesOncePerCustomer: discount.appliesOncePerCustomer,
  });
}

export class ShopifyOrderEditCodes {
  constructor(private readonly request: Request) {}

  async rules(
    snapshot: OrderEditSnapshot,
    codes: string[],
  ): Promise<OrderEditCodeRule[]> {
    if (!snapshot.customerId)
      fail(
        "ORDER_EDIT_CODE_CUSTOMER_MISSING",
        "We could not verify the customer for this order.",
      );
    if (
      (snapshot.discountRules ?? []).some(
        (rule) =>
          rule.type === "DiscountCodeApplication" &&
          rule.targetType === "LINE_ITEM",
      )
    )
      fail(
        "ORDER_EDIT_CODE_EXISTING_NATIVE_UNSUPPORTED",
        "Adding another code to this order requires our help. Your existing code has not changed.",
      );
    const results = await Promise.all(
      codes.map(async (code) =>
        readOrderEditCodeRule(
          await this.request(ORDER_EDIT_CODE_LOOKUP, {
            code,
            search: `"${code.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`,
          }),
          code,
        ),
      ),
    );
    return results;
  }

  async assertCombinations(
    snapshot: OrderEditSnapshot,
    rules: OrderEditCodeRule[],
    productDiscount: boolean,
    shippingLabels: string[],
  ) {
    const existing = await this.existingCombinations(
      snapshot,
      productDiscount,
      shippingLabels,
    );
    // Recheck every pair against the complete revised cart, including a newly earned shipping benefit.
    assertOrderEditCodeCombinations({
      existing,
      proposed: rules.map((rule) => ({
        id: rule.discountId,
        label: rule.code,
        classes: rule.classes,
        combinesWith: rule.combinesWith,
      })),
    });
  }

  private async existingCombinations(
    snapshot: OrderEditSnapshot,
    productDiscount: boolean,
    shippingLabels: string[],
  ): Promise<OrderEditCombinationDiscount[]> {
    const schema = z.object({
      shopifyFunctions: z.object({
        nodes: z.array(z.object({ id: z.string(), handle: z.string() })),
        pageInfo: page,
      }),
      discountNodes: z.object({
        nodes: z.array(
          z.object({
            id: z.string(),
            discount: z.object({
              __typename: z.string(),
              title: z.string().optional(),
              status: z.string().optional(),
              discountClasses: z.array(orderEditDiscountClassSchema).optional(),
              combinesWith: orderEditCombinesWithSchema.optional(),
              appDiscountType: z.object({ functionId: z.string() }).optional(),
            }),
          }),
        ),
        pageInfo: page,
      }),
    });
    const raw = parse(schema, await this.request(AUTOMATIC_RULES, {}));
    if (
      raw.discountNodes.pageInfo.hasNextPage ||
      raw.shopifyFunctions.pageInfo.hasNextPage
    )
      fail(
        "ORDER_EDIT_CODE_RULES_INCOMPLETE",
        "The order's discount combination rules could not be fully loaded.",
      );
    const used = new Map<string, OrderEditCombinationDiscount>();
    const rules = [
      ...(snapshot.discountRules ?? []).filter(
        (rule) => rule.targetType !== "SHIPPING_LINE",
      ),
    ];
    if (
      productDiscount &&
      !rules.some((rule) =>
        ["Member discount", "Echelon member pricing"].includes(rule.label),
      )
    )
      rules.push({
        index: rules.length,
        type: "AutomaticDiscountApplication",
        targetType: "LINE_ITEM",
        allocationMethod: "ACROSS",
        targetSelection: "ENTITLED",
        label: "Member discount",
        value: { type: "fixed", amountCents: 0 },
      });
    for (const label of shippingLabels)
      rules.push({
        index: rules.length,
        type: "AutomaticDiscountApplication",
        targetType: "SHIPPING_LINE",
        allocationMethod: "ACROSS",
        targetSelection: "ALL",
        label,
        value: { type: "fixed", amountCents: 0 },
      });
    for (const rule of rules) {
      if (rule.targetType === "LINE_ITEM" && !productDiscount) continue;
      if (
        rule.type === "ManualDiscountApplication" &&
        rule.label === snapshot.codePricing?.description
      )
        continue;
      const memberPrice =
        rule.targetType === "LINE_ITEM" &&
        ["Member discount", "Echelon member pricing"].includes(rule.label);
      const memberShipping =
        rule.targetType === "SHIPPING_LINE" &&
        rule.label === "Member free shipping";
      if (
        !memberPrice &&
        !memberShipping &&
        rule.type === "ManualDiscountApplication"
      )
        fail(
          "ORDER_EDIT_CODE_EXISTING_RULES_UNAVAILABLE",
          "We could not verify how this code combines with an existing order adjustment. Please contact us for help.",
        );
      if (rule.type === "DiscountCodeApplication")
        fail(
          "ORDER_EDIT_CODE_EXISTING_RULES_UNAVAILABLE",
          "Adding a code to this order requires our help verifying the existing code.",
        );
      const handle = memberPrice
        ? "cardshellz-pricing-discount"
        : memberShipping
          ? "cardshellz-shipping-discount"
          : null;
      const functions = raw.shopifyFunctions.nodes.filter(
        (fn) => fn.handle === handle,
      );
      const matches = raw.discountNodes.nodes.filter(
        (node) =>
          node.discount.status === "ACTIVE" &&
          (handle
            ? functions.length === 1 &&
              node.discount.appDiscountType?.functionId === functions[0].id
            : node.discount.title === rule.label),
      );
      if (
        matches.length !== 1 ||
        !matches[0].discount.combinesWith ||
        !matches[0].discount.discountClasses?.length
      )
        fail(
          "ORDER_EDIT_CODE_EXISTING_RULES_UNAVAILABLE",
          "The existing discount's combination settings could not be verified. No code was applied.",
        );
      used.set(matches[0].id, {
        id: matches[0].id,
        label: rule.label,
        classes: matches[0].discount.discountClasses!,
        combinesWith: matches[0].discount.combinesWith!,
      });
    }
    return [...used.values()];
  }

  /** Calculation only: never creates a draft order or consumes a code. Shopify remains eligibility authority. */
  async verifyNativeCalculation(
    snapshot: OrderEditSnapshot,
    lines: OrderEditCodePricingLine[],
    rules: OrderEditCodeRule[],
    expected?: { code: string; amountCents: number }[],
  ): Promise<Array<{ code: string; amountCents: number }>> {
    if (!rules.length) return [];
    const nativeCoupons = rules.every(
      (rule) => rule.redemption === "shopify_coupon",
    );
    const result = parse(
      z.object({
        draftOrderCalculate: z.object({
          userErrors: z.array(z.object({ message: z.string() })),
          calculatedDraftOrder: z
            .object({
              subtotalPriceSet: bag,
              lineItemsSubtotalPrice: bag,
              lineItems: z.array(
                z.object({
                  variant: z.object({ id: z.string() }).nullable(),
                  quantity: integer.positive(),
                  discountedTotalSet: bag,
                }),
              ),
              platformDiscounts: z.array(
                z.object({
                  code: z.string().nullable(),
                  discountClasses: z.array(z.string()),
                  totalAmountPriceSet: bag,
                }),
              ),
            })
            .nullable(),
        }),
      }),
      await this.request(CALCULATE, {
        input: {
          purchasingEntity: { customerId: snapshot.customerId },
          presentmentCurrencyCode: "USD",
          acceptAutomaticDiscounts: nativeCoupons,
          discountCodes: rules.map((rule) => rule.code),
          // Use actual variants and buyer identity. Sending member prices as
          // custom prices would hide that discount from Shopify's combination
          // decision and could make an incompatible coupon appear eligible.
          ...(nativeCoupons
            ? {
                lineItems: lines.map((line) => ({
                  variantId: line.variantId,
                  quantity: line.quantity,
                })),
              }
            : {
                // Finish/recover operations quoted before this separation with
                // their original calculation contract. Never use this branch
                // for a newly entered Shopify coupon.
                customAttributes: [
                  { key: "csz_suppress_member_pricing", value: "true" },
                ],
                lineItems: shippingCalculationLines(
                  lines.map((line) => ({
                    variantId: line.variantId,
                    quantity: line.quantity,
                    netCents: line.productNetCents,
                  })),
                ),
              }),
        },
      }),
    );
    const calculation = result.draftOrderCalculate.calculatedDraftOrder;
    if (result.draftOrderCalculate.userErrors.length || !calculation)
      fail(
        "ORDER_EDIT_CODE_INELIGIBLE",
        "This code is not eligible for these items or this customer. Your order has not changed.",
      );
    const amounts = new Map<string, number>();
    for (const discount of calculation.platformDiscounts) {
      // Automatic product discounts are already in each native line's net.
      if (
        discount.code === null &&
        discount.discountClasses.length === 1 &&
        discount.discountClasses[0] === "PRODUCT"
      )
        continue;
      if (
        !discount.code ||
        discount.discountClasses.length !== 1 ||
        discount.discountClasses[0] !== "ORDER"
      )
        fail(
          "ORDER_EDIT_CODE_NATIVE_MISMATCH",
          "Shopify returned an unexpected discount. No code was applied.",
        );
      const shop = cents(discount.totalAmountPriceSet.shopMoney.amount);
      if (
        shop !== cents(discount.totalAmountPriceSet.presentmentMoney.amount) ||
        amounts.has(discount.code.toUpperCase())
      )
        fail(
          "ORDER_EDIT_CODE_NATIVE_MISMATCH",
          "Shopify's code amounts could not be verified.",
        );
      amounts.set(discount.code.toUpperCase(), shop);
    }
    if (
      amounts.size !== rules.length ||
      rules.some((rule) => !amounts.has(rule.code.toUpperCase()))
    )
      fail(
        "ORDER_EDIT_CODE_INELIGIBLE",
        "Shopify did not apply this code to your order. It may not qualify or combine with your existing discounts. Your order has not changed.",
      );
    if (
      expected?.some(
        (application) =>
          amounts.get(application.code.toUpperCase()) !==
          application.amountCents,
      )
    )
      fail(
        "ORDER_EDIT_CODE_NATIVE_MISMATCH",
        "Shopify did not approve the complete code savings. No code was applied.",
      );
    // Shopify's discountedTotalSet excludes the platform ORDER discount.
    // Prove the product-price base separately from the post-code subtotal.
    const native = shippingItemTotals(
      calculation.lineItems.map((line) => {
        if (!line.variant)
          fail(
            "ORDER_EDIT_CODE_NATIVE_MISMATCH",
            "Shopify did not identify every eligible product.",
          );
        const netCents = cents(line.discountedTotalSet.shopMoney.amount);
        if (netCents !== cents(line.discountedTotalSet.presentmentMoney.amount))
          fail(
            "ORDER_EDIT_CODE_NATIVE_MISMATCH",
            "Currency conversion is not supported for code adjustments.",
          );
        return {
          variantId: line.variant.id,
          quantity: line.quantity,
          netCents,
        };
      }),
    );
    const quantities = shippingItemTotals(
      lines.map((line) => ({
        variantId: line.variantId,
        quantity: line.quantity,
        netCents: line.productNetCents,
      })),
    );
    if (
      native.size !== quantities.size ||
      [...quantities].some(
        ([id, value]) =>
          native.get(id)?.quantity !== value.quantity ||
          native.get(id)?.netCents !== value.netCents,
      )
    )
      fail(
        "ORDER_EDIT_CODE_NATIVE_MISMATCH",
        "Shopify changed the products while checking the code.",
      );
    const nativeTotal = [...native.values()].reduce(
      (sum, line) => sum + line.netCents,
      BigInt(0),
    );
    const expectedTotal =
      nativeTotal -
      [...amounts.values()].reduce(
        (sum, amount) => sum + BigInt(amount),
        BigInt(0),
      );
    const before = calculation.lineItemsSubtotalPrice;
    const after = calculation.subtotalPriceSet;
    if (
      BigInt(cents(before.shopMoney.amount)) !== nativeTotal ||
      cents(before.shopMoney.amount) !==
        cents(before.presentmentMoney.amount) ||
      BigInt(cents(after.shopMoney.amount)) !== expectedTotal ||
      cents(after.shopMoney.amount) !== cents(after.presentmentMoney.amount)
    )
      fail(
        "ORDER_EDIT_CODE_NATIVE_MISMATCH",
        "The code savings do not reconcile to Shopify's item total.",
      );
    return rules.map((rule) => ({
      code: rule.code,
      amountCents: amounts.get(rule.code.toUpperCase())!,
    }));
  }
}
const CALCULATE = `mutation EchelonEditCodeCalculate($input: DraftOrderInput!) {
  draftOrderCalculate(input: $input) { userErrors { message } calculatedDraftOrder {
    subtotalPriceSet { shopMoney { amount currencyCode } presentmentMoney { amount currencyCode } }
    lineItemsSubtotalPrice { shopMoney { amount currencyCode } presentmentMoney { amount currencyCode } }
    lineItems { variant { id } quantity discountedTotalSet { shopMoney { amount currencyCode } presentmentMoney { amount currencyCode } } }
    platformDiscounts { code discountClasses totalAmountPriceSet { shopMoney { amount currencyCode } presentmentMoney { amount currencyCode } } }
  } }
}`;
