import { z } from "zod";
import Decimal from "decimal.js";
import { canonicalJson } from "@shared/utils/canonical-json";
import {
  orderEditShippingRepricingSchema,
  type OrderEditShippingRepricing,
} from "@shared/order-edits/order-edit-shipping";
import {
  OrderEditProviderError,
  type OrderEditSnapshot,
} from "../application/order-edit-provider";
import type {
  OrderEditShippingCalculator,
  OrderEditShippingItem,
} from "../application/order-edit-shipping";
import {
  shippingCalculationLines,
  shippingItemTotals,
} from "../domain/order-edit-shipping";

const money = z.object({
  amount: z.string().min(1),
  currencyCode: z.literal("USD"),
});
const bag = z.object({ shopMoney: money, presentmentMoney: money });
const rateSchema = z.object({
  handle: z.string().min(1),
  title: z.string().min(1),
  code: z.string(),
  source: z.string(),
  price: money,
});
const optionsSchema = z.object({
  draftOrderAvailableDeliveryOptions: z.object({
    availableShippingRates: z.array(rateSchema),
  }),
});
const calculationSchema = z.object({
  draftOrderCalculate: z.object({
    userErrors: z.array(
      z.object({ message: z.string(), field: z.array(z.string()).nullable() }),
    ),
    calculatedDraftOrder: z
      .object({
        currencyCode: z.literal("USD"),
        presentmentCurrencyCode: z.literal("USD"),
        acceptAutomaticDiscounts: z.literal(true),
        taxesIncluded: z.boolean(),
        shippingLine: z
          .object({
            title: z.string(),
            originalPriceSet: bag,
            currentDiscountedPriceSet: bag,
          })
          .nullable(),
        platformDiscounts: z.array(
          z.object({
            title: z.string(),
            code: z.string().nullable(),
            discountClasses: z.array(z.enum(["PRODUCT", "ORDER", "SHIPPING"])),
            totalAmountPriceSet: bag,
          }),
        ),
        lineItems: z.array(
          z.object({
            quantity: z.number().int().positive(),
            variant: z.object({ id: z.string() }).nullable(),
            discountedTotalSet: bag,
          }),
        ),
      })
      .nullable(),
  }),
});

const SHIPPING_OPTIONS_QUERY = `query EchelonEditShippingOptions($input: DraftOrderAvailableDeliveryOptionsInput!) {
  draftOrderAvailableDeliveryOptions(input: $input) { availableShippingRates { handle title code source price { amount currencyCode } } }
}`;
const SHIPPING_CALCULATION = `mutation EchelonEditShippingCalculate($input: DraftOrderInput!) {
  draftOrderCalculate(input: $input) { userErrors { field message } calculatedDraftOrder {
    currencyCode presentmentCurrencyCode acceptAutomaticDiscounts taxesIncluded
    lineItems { quantity variant { id } discountedTotalSet { presentmentMoney { amount currencyCode } shopMoney { amount currencyCode } } }
    platformDiscounts { title code discountClasses totalAmountPriceSet { presentmentMoney { amount currencyCode } shopMoney { amount currencyCode } } }
    shippingLine { title originalPriceSet { presentmentMoney { amount currencyCode } shopMoney { amount currencyCode } }
      currentDiscountedPriceSet { presentmentMoney { amount currencyCode } shopMoney { amount currencyCode } }
    }
  } }
}`;

function fail(code: string, message: string): never {
  throw new OrderEditProviderError(code, message);
}
function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success)
    fail(
      "SHIPPING_RESPONSE_INVALID",
      "Shopify did not return a complete USD shipping calculation.",
    );
  return result.data;
}
function cents(input: z.infer<typeof money>): number {
  if (!/^\d+(?:\.\d+)?$/.test(input.amount))
    fail(
      "SHIPPING_MONEY_INVALID",
      "Shopify returned an invalid shipping amount.",
    );
  const value = new Decimal(input.amount).times(100);
  if (
    !value.isInteger() ||
    value.isNegative() ||
    value.gt(Number.MAX_SAFE_INTEGER)
  )
    fail(
      "SHIPPING_MONEY_INVALID",
      "Shipping must be exact nonnegative USD cents.",
    );
  return value.toNumber();
}
function amount(input: z.infer<typeof bag>): number {
  const value = cents(input.shopMoney);
  if (value !== cents(input.presentmentMoney))
    fail(
      "SHIPPING_CURRENCY_MISMATCH",
      "Shipping currency conversion is not supported by this editor.",
    );
  return value;
}

/** Native checkout calculation invokes the installed shipping Function and current carrier/profile rates. */
export class ShopifyOrderEditShippingCalculator
  implements OrderEditShippingCalculator
{
  constructor(
    private readonly request: (
      snapshot: OrderEditSnapshot,
      query: string,
      variables: Record<string, unknown>,
    ) => Promise<unknown>,
  ) {}

  async calculate(
    snapshot: OrderEditSnapshot,
    items: OrderEditShippingItem[],
  ): Promise<OrderEditShippingRepricing> {
    const context = snapshot.shippingContext;
    if (
      !context ||
      context.lines.length !== 1 ||
      !snapshot.financials ||
      !snapshot.customerId
    )
      fail(
        "SHIPPING_CONTEXT_UNAVAILABLE",
        "A complete shipping address, customer, and one original delivery service are required to reprice this order.",
      );
    const original = context.lines[0];
    const destination = context.address;
    if (
      destination.countryCodeV2 !== "US" ||
      !destination.address1?.trim() ||
      !destination.city?.trim() ||
      !destination.zip?.trim() ||
      !destination.provinceCode?.trim()
    )
      fail(
        "SHIPPING_ADDRESS_INVALID",
        "A complete domestic delivery address is required to reprice shipping.",
      );
    const shippingAddress = {
      address1: destination.address1,
      address2: destination.address2,
      city: destination.city,
      provinceCode: destination.provinceCode,
      zip: destination.zip,
      countryCode: destination.countryCodeV2,
    };
    const lineItems = shippingCalculationLines(items);
    const purchasingEntity = { customerId: snapshot.customerId };
    const shippingCodes = (snapshot.discountRules ?? [])
      .filter(
        (rule) =>
          rule.type === "DiscountCodeApplication" &&
          rule.targetType === "SHIPPING_LINE",
      )
      .map((rule) => rule.label);
    const input = {
      lineItems,
      shippingAddress,
      purchasingEntity,
      discountCodes: shippingCodes,
    };
    // Products already include verified coupons/rewards/member pricing. Rate selection does not apply them again.
    const rates = parse(
      optionsSchema,
      await this.request(snapshot, SHIPPING_OPTIONS_QUERY, {
        input: { ...input, acceptAutomaticDiscounts: false },
      }),
    ).draftOrderAvailableDeliveryOptions.availableShippingRates;
    const matching = rates.filter((rate) =>
      original.code && original.source
        ? rate.code === original.code && rate.source === original.source
        : rate.title === original.title,
    );
    if (matching.length !== 1)
      fail(
        "SHIPPING_SERVICE_UNAVAILABLE",
        "The original delivery service cannot be matched uniquely to current checkout rates. Staff must review the shipping choice.",
      );
    const selected = matching[0];
    const result = parse(
      calculationSchema,
      await this.request(snapshot, SHIPPING_CALCULATION, {
        input: {
          ...input,
          acceptAutomaticDiscounts: true,
          // The member-pricing Function explicitly honors this attribute; shipping benefits continue to run.
          customAttributes: [
            { key: "csz_suppress_member_pricing", value: "true" },
          ],
          shippingLine: { shippingRateHandle: selected.handle },
          presentmentCurrencyCode: "USD",
          useCustomerDefaultAddress: false,
        },
      }),
    ).draftOrderCalculate;
    if (result.userErrors.length || !result.calculatedDraftOrder)
      fail(
        "SHIPPING_CALCULATION_REJECTED",
        "Shopify could not calculate shipping for the revised items.",
      );
    const calculated = result.calculatedDraftOrder;
    if (calculated.taxesIncluded !== snapshot.financials.taxesIncluded)
      fail(
        "SHIPPING_TAX_CONTEXT_CHANGED",
        "The shipping calculation does not use this order's tax treatment.",
      );
    const actualItems = calculated.lineItems.map((line) => {
      if (!line.variant)
        fail(
          "SHIPPING_ITEMS_CHANGED",
          "The shipping calculation changed a product identity.",
        );
      return {
        variantId: line.variant.id,
        quantity: line.quantity,
        netCents: amount(line.discountedTotalSet),
      };
    });
    const totals = (lines: OrderEditShippingItem[]) =>
      [...shippingItemTotals(lines)]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([id, value]) => [
          id,
          String(value.quantity),
          String(value.netCents),
        ]);
    if (canonicalJson(totals(actualItems)) !== canonicalJson(totals(items)))
      fail(
        "SHIPPING_ITEMS_CHANGED",
        "The shipping calculation did not preserve the verified quantities and discounted item totals.",
      );
    const shipping = calculated.shippingLine;
    if (
      !shipping ||
      shipping.title !== selected.title ||
      amount(shipping.originalPriceSet) !== cents(selected.price)
    )
      fail(
        "SHIPPING_RATE_CHANGED",
        "The selected shipping rate changed during calculation. Review the order again.",
      );
    const grossCents = amount(shipping.originalPriceSet);
    const netCents = amount(shipping.currentDiscountedPriceSet);
    // Calculation-only drafts expose Function benefits in platformDiscounts, not ShippingLine.discountAllocations.
    const discounts = calculated.platformDiscounts.filter(
      (discount) => amount(discount.totalAmountPriceSet) > 0,
    );
    if (
      discounts.some(
        (discount) =>
          discount.discountClasses.length !== 1 ||
          discount.discountClasses[0] !== "SHIPPING",
      )
    )
      fail(
        "SHIPPING_ITEMS_CHANGED",
        "The shipping calculation applied an additional product or order discount.",
      );
    const allocated = discounts.reduce(
      (total, discount) => total + BigInt(amount(discount.totalAmountPriceSet)),
      BigInt(0),
    );
    if (BigInt(grossCents) - BigInt(netCents) !== allocated)
      fail(
        "SHIPPING_DISCOUNT_UNVERIFIED",
        "Shipping discounts do not reconcile to the checkout charge.",
      );
    return parse(orderEditShippingRepricingSchema, {
      title: selected.title,
      code: selected.code,
      source: selected.source,
      grossCents,
      netCents,
      discountCents: grossCents - netCents,
      discountLabels: [
        ...new Set(
          discounts.map((discount) => discount.code ?? discount.title),
        ),
      ],
    });
  }
}
