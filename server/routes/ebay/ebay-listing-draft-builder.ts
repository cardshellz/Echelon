import type {
  BuiltInventoryItem,
  BuiltItemGroup,
  BuiltOffer,
} from "../../modules/channels/adapters/ebay/ebay-listing-builder";
import type {
  EbayInventoryItem,
  EbayInventoryItemGroup,
  EbayOffer,
} from "../../modules/channels/adapters/ebay/ebay-types";

export function buildEbayRouteListingDraft(input: {
  productId: number;
  product: any;
  variants: any[];
  effectiveImageUrls: string[];
  aspects: Record<string, string[]>;
  isMultiVariant: boolean;
  variationAspectName: string;
  variantPrices: Map<number, number>;
  atpByVariantId: Map<number, number>;
  marketplaceId: string;
  ebayBrowseCategoryId: string;
  effectivePolicies: {
    fulfillmentPolicyId: string | null;
    returnPolicyId: string | null;
    paymentPolicyId: string | null;
  };
  storeCategoryNames: string[];
  merchantLocationKey: string;
}): {
  inventoryItems: BuiltInventoryItem[];
  offers: BuiltOffer[];
  itemGroup: BuiltItemGroup | null;
} {
  const inventoryItems: BuiltInventoryItem[] = [];
  const offers: BuiltOffer[] = [];

  for (const variant of input.variants) {
    const sku = String(variant.sku ?? "").trim();
    if (!sku) continue;

    const availableQty = Math.max(0, input.atpByVariantId.get(variant.id) ?? 0);
    const priceCents = input.variantPrices.get(variant.id) ?? variant.price_cents ?? 0;
    const priceInDollars = centsToDecimalString(priceCents);
    const variantAspects: Record<string, string[]> = { ...input.aspects };
    if (input.isMultiVariant) {
      const variationValue = variant.option1_value || variant.name || sku;
      variantAspects[input.variationAspectName] = [variationValue];
    }

    inventoryItems.push({
      sku,
      payload: {
        condition: "NEW",
        product: {
          title: truncateEbayTitle(input.product.name),
          description: input.product.description || `<p>${input.product.name}</p>`,
          imageUrls: input.effectiveImageUrls,
          aspects: variantAspects,
        },
        availability: {
          shipToLocationAvailability: { quantity: availableQty },
        },
      } satisfies Omit<EbayInventoryItem, "sku">,
    });

    const variantPolicies = {
      fulfillmentPolicyId: variant.ebay_fulfillment_policy_override || input.effectivePolicies.fulfillmentPolicyId,
      returnPolicyId: variant.ebay_return_policy_override || input.effectivePolicies.returnPolicyId,
      paymentPolicyId: variant.ebay_payment_policy_override || input.effectivePolicies.paymentPolicyId,
    };

    offers.push({
      sku,
      variantId: variant.id,
      payload: {
        sku,
        marketplaceId: input.marketplaceId,
        format: "FIXED_PRICE",
        categoryId: input.ebayBrowseCategoryId,
        listingPolicies: variantPolicies,
        merchantLocationKey: input.merchantLocationKey,
        pricingSummary: {
          price: { value: priceInDollars, currency: "USD" },
        },
        availableQuantity: availableQty,
        ...(input.storeCategoryNames.length > 0 ? { storeCategoryNames: input.storeCategoryNames } : {}),
      } as EbayOffer,
    });
  }

  const groupKey = input.product.sku || `PROD-${input.productId}`;
  const itemGroup: BuiltItemGroup | null =
    input.isMultiVariant && inventoryItems.length > 1
      ? {
          groupKey,
          payload: {
            title: truncateEbayTitle(input.product.name),
            description: input.product.description || `<p>${input.product.name}</p>`,
            imageUrls: input.effectiveImageUrls,
            aspects: input.aspects,
            variantSKUs: inventoryItems.map((item) => item.sku),
            variesBy: {
              aspectsImageVariesBy: [],
              specifications: [
                {
                  name: input.variationAspectName,
                  values: input.variants
                    .filter((variant) => inventoryItems.some((item) => item.sku === variant.sku))
                    .map((variant) => variant.option1_value || variant.name || variant.sku),
                },
              ],
            },
          } as Omit<EbayInventoryItemGroup, "inventoryItemGroupKey">,
        }
      : null;

  return { inventoryItems, offers, itemGroup };
}

function truncateEbayTitle(title: string): string {
  return title.length > 80 ? `${title.substring(0, 77)}...` : title;
}

function centsToDecimalString(cents: number): string {
  const normalized = Math.trunc(cents);
  const whole = Math.floor(Math.abs(normalized) / 100);
  const fractional = String(Math.abs(normalized) % 100).padStart(2, "0");
  return `${normalized < 0 ? "-" : ""}${whole}.${fractional}`;
}
