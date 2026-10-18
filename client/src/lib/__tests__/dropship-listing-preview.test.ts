import { describe, expect, it } from "vitest";
import {
  LISTING_PREVIEW_POLICY_FIELDS,
  LISTING_PREVIEW_WORDS,
  formatListingPreviewIssue,
  listingPreviewDescriptionLinkName,
  listingPreviewModeWords,
  listingPreviewPolicyLines,
  listingPreviewPolicyLinkName,
  listingPreviewSettingsLink,
  listingPreviewSettingsLinkName,
  pageListingPreviews,
  safeListingImageUrl,
  stepThreePolicyName,
} from "../dropship-listing-preview";
import { fulfillmentIssueReason, type PolicySetupFacts } from "../dropship-listing-settings-words";
import type { DropshipListingPreviewRow } from "../dropship-ops-surface";
import { LISTING_SHIPPING_ESTIMATE_WARNING } from "@shared/dropship/listing-shipping-estimate";

/** A snake_case token, a policy number, an eBay category number or a code shown to the vendor (plan §0, C10). */
const RAW_CODE = /[a-z]+_[a-z_]+|policy_\d|Policy \d|#\d|[a-z]+:[a-z_]+/;

/**
 * Every code step 3 and the queue result can show (plan 12.3; map mS3 c.1-c.3,
 * re-checked against the server: vendor-selection.ts, listing-tiers.ts, the
 * config-driven provider, listing-preview-service.ts, SH/pricing-rules.ts,
 * SH/listing-price.ts, listing-price-cost.ts, listing-content-resolver.ts,
 * listing-config-service.ts defaults, ebay-product-identifiers.ts,
 * listing-photo-reasons.ts, ebay-fulfillment-policy-compatibility.ts,
 * ebay-return-payment-policy-blockers.ts, dropship-product-cost.ts,
 * listing-presentation.ts).
 */
const EVERY_CODE = [
  "selection:not_exposed_by_admin", "selection:excluded_by_vendor_rule", "selection:missing_vendor_include_rule", "selection:disabled_by_vendor_override",
  "listing_tier:autopay_off", "listing_tier:reserve_below_tier", "listing_tier:balance_below_tier",
  "listing_config_required", "listing_config_platform_mismatch", "listing_config_inactive", "listing_config_manual_only", "marketplace_quantity_unavailable",
  "catalog_package_data_required", "active_box_required", "active_rate_table_required",
  "pricing_basis_unavailable", "pricing_result_out_of_range", "pricing_rule_priority_conflict", "pricing_rules_not_configured", "pricing_rule_outside_limit",
  "vendor_retail_price_required", "pricing:below_floor:policy_12", "pricing:above_ceiling:policy_12", "price_below_product_cost",
  "listing_content_catalog_too_large", "listing_content_template_conflict", "listing_content_catalog_review_required",
  "listing_content_description_required", "listing_content_description_too_large",
  "missing_config:marketplaceId", "missing_config:merchantLocationKey", "missing_config:businessPolicies.paymentPolicyId",
  "missing_config:businessPolicies.returnPolicyId", "missing_config:businessPolicies.fulfillmentPolicyId", "missing_config:someOtherKey",
  "missing_product_field:sku", "missing_product_field:title", "missing_product_field:description", "missing_product_field:imageUrls",
  "missing_product_field:ebayBrowseCategoryId",
  "listing_title_required", "variant_sku_required", "listing_description_missing", "ebay_browse_category_required", "ebay_mpn_placeholder",
  "catalog_photo_public_address_missing", "catalog_photo_unavailable",
  "ebay_fulfillment_policy:marketplace_missing", "ebay_fulfillment_policy:marketplace_mismatch", "ebay_fulfillment_policy:destination_coverage_incomplete",
  "ebay_fulfillment_policy:handling_time_missing", "ebay_fulfillment_policy:handling_time_unit_unsupported", "ebay_fulfillment_policy:handling_time_too_short",
  "ebay_fulfillment_policy:local_pickup_unsupported", "ebay_fulfillment_policy:freight_shipping_unsupported", "ebay_fulfillment_policy:pickup_drop_off_unsupported",
  "ebay_fulfillment_policy:international_direct_shipping_unsupported", "ebay_fulfillment_policy:shipping_option_type_unsupported",
  "ebay_fulfillment_policy:shipping_service_unsupported:USPSPriorityMail", "ebay_fulfillment_policy:domestic_shipping_service_required",
  "ebay_fulfillment_policy:verification_unavailable",
  "ebay_return_policy:not_found", "ebay_payment_policy:not_found", "ebay_return_policy:verification_unavailable", "ebay_payment_policy:verification_unavailable",
  "catalog_variant_not_found",
  "vendor_unavailable", "plan_unavailable", "entitlement_inactive", "variant_unmapped", "variant_ambiguous", "variant_identity_mismatch",
  "override_ambiguous", "override_invalid", "retail_unavailable", "pricing_configuration_invalid", "source_read_failed",
  "product_cost_source_unavailable", "sellable_pack_size_invalid",
  "publication_preview_unavailable", "catalog_media_unavailable", "images_unavailable",
  "unsafe_image_url", "not_in_publication_payload", "image_unavailable_or_unsafe", "authenticated_catalog_image_only",
] as const;

describe("every step 3 issue code has vendor words (plan 12.3)", () => {
  it("words each code in the list without the code, an id or a number, as a sentence, never the unknown-code fallback", () => {
    expect(new Set(EVERY_CODE).size).toBe(EVERY_CODE.length);
    for (const code of EVERY_CODE) {
      const words = formatListingPreviewIssue(code);
      expect(words, code).not.toBe(LISTING_PREVIEW_WORDS.unknownIssue);
      expect(words, code).not.toContain(code);
      expect(words, code).not.toMatch(RAW_CODE);
      expect(words, code).toMatch(/\.$/);
      expect(words, code).not.toMatch(/step 2, Listing settings|Inventory location|priorit|template|groups/i);
    }
  });

  it.each([
    ["selection:not_exposed_by_admin", "Card Shellz doesn't offer this size right now."],
    ["selection:excluded_by_vendor_rule", "You left this size out in step 1."],
    ["selection:missing_vendor_include_rule", "This size isn't chosen in step 1."],
    ["selection:disabled_by_vendor_override", "You turned this size off in step 1."],
    ["listing_config_required", "Your store's listing setup isn't finished. Open Listing settings."],
    ["listing_config_platform_mismatch", "This store's listing setup is for another marketplace. Contact support."],
    ["listing_config_inactive", "This store's listing setup is turned off. Contact support."],
    ["listing_config_manual_only", "This store lists by hand only. Contact support."],
    ["marketplace_quantity_unavailable", "Card Shellz couldn't work out how many to list. Preview again later."],
    ["catalog_package_data_required", "Card Shellz hasn't added this size's package size yet. Contact support."],
    ["active_box_required", "Card Shellz has no shipping box for this size yet. Contact support."],
    ["active_rate_table_required", "Card Shellz shipping rates aren't set up yet. Contact support."],
    ["vendor_retail_price_required", "This size has no price. Give it an exact price in Listing settings."],
    ["pricing:below_floor:policy_12", "Outside a Card Shellz price limit."],
    ["pricing:above_ceiling:policy_7", "Outside a Card Shellz price limit."],
    ["pricing_rules_not_configured", "No price is set. Set a store price in Listing settings."],
    ["pricing_rule_priority_conflict", "Two of your older price rules apply to this size. Give it a price in Listing settings."],
    ["pricing_basis_unavailable", "Card Shellz doesn't have the cost or retail price this price starts from."],
    ["pricing_result_out_of_range", "This price works out too high or too low. Change it in Listing settings."],
    ["listing_content_template_conflict", "Two of your older description rules apply to this size. Set its description in Listing settings."],
    ["listing_content_catalog_review_required", "Card Shellz changed this product. Check your own text in Listing settings."],
    ["listing_content_description_too_large", "The description is too long. Shorten your own text in Listing settings."],
    ["missing_config:merchantLocationKey", "Your ship-from location isn't set. Update it in Listing settings."],
    ["missing_config:businessPolicies.fulfillmentPolicyId", "No shipping policy. Choose one in Listing settings."],
    ["missing_config:businessPolicies.returnPolicyId", "No return policy. Choose one in Listing settings."],
    ["missing_config:businessPolicies.paymentPolicyId", "No payment policy. Choose one in Listing settings."],
    ["missing_config:marketplaceId", "Your eBay setup is missing a setting. Open Listing settings."],
    ["missing_product_field:sku", "This size has no SKU. Contact support."],
    ["missing_product_field:title", "This product has no title. Contact support."],
    ["missing_product_field:description", "This product has no description. Contact support."],
    ["missing_product_field:ebayBrowseCategoryId", "Card Shellz is missing product details. Contact support."],
    ["listing_title_required", "This listing needs a title. Contact support."],
    ["variant_sku_required", "This size needs a SKU. Contact support."],
    ["listing_description_missing", "This listing has no description. Add your own in Listing settings."],
    ["ebay_browse_category_required", "No eBay category. Pick one in Listing settings."],
    ["catalog_variant_not_found", "This size is no longer in the Card Shellz catalog."],
    ["sellable_pack_size_invalid", "Card Shellz's pack size for this product needs fixing. Contact support."],
    ["publication_preview_unavailable", "The preview couldn't be built. Preview again."],
    ["catalog_media_unavailable", "Card Shellz photos couldn't be loaded. Preview again."],
    ["images_unavailable", "Photos couldn't be loaded. Preview again."],
    ["unsafe_image_url", "This photo can't be sent to eBay."],
    ["not_in_publication_payload", "This photo isn't sent with the listing."],
    ["image_unavailable_or_unsafe", "This photo couldn't be loaded."],
    ["authenticated_catalog_image_only", "This photo is private to Card Shellz, so it isn't sent."],
    ["variant_ambiguous", "Your Card Shellz price list needs a support check. Contact support."],
    ["override_invalid", "Your Card Shellz price list needs a support check. Contact support."],
    ["pricing_configuration_invalid", "Your Card Shellz price list needs a support check. Contact support."],
  ])("words %s as the plan proposes", (code, words) => {
    expect(formatListingPreviewIssue(code)).toBe(words);
  });

  it("keeps the words the older rows already had", () => {
    expect(formatListingPreviewIssue("listing_content_description_required")).toBe("Add a description or contact support to complete the catalog copy.");
    expect(formatListingPreviewIssue("listing_content_catalog_too_large")).toBe("The catalog description exceeds the supported size. Contact support.");
    // Interim (PR 12 PROPOSAL): the older sentence, now with the fix its neighbours name, since pricing rules can't be edited.
    expect(formatListingPreviewIssue("pricing_rule_outside_limit"))
      .toBe("Your pricing rules give this size a price outside a Card Shellz price limit, so it can't be listed at that price. Give it an exact price in Listing settings.");
    expect(formatListingPreviewIssue("missing_product_field:imageUrls")).toBe("This product has no photo that can be sent to the marketplace. Contact support.");
    // The shipping estimate's one warning is a sentence already and passes through as it is.
    expect(formatListingPreviewIssue(LISTING_SHIPPING_ESTIMATE_WARNING)).toBe(LISTING_SHIPPING_ESTIMATE_WARNING);
  });

  it("never shows an unknown code: the Title-Case fallback is gone (REC:910)", () => {
    for (const code of ["unrecognized_issue", "some:new_thing:policy_3", "WHATEVER", ""]) {
      const words = formatListingPreviewIssue(code);
      expect(words).toBe("Card Shellz can't list this yet. Contact support.");
      expect(words).not.toMatch(/unrecognized|Unrecognized Issue|Some: New Thing|WHATEVER/);
    }
    expect(LISTING_PREVIEW_WORDS.unknownIssue).toBe("Card Shellz can't list this yet. Contact support.");
  });
});

describe("eBay shipping policy issues on step 3", () => {
  it("says a policy that could not be checked is not known to be wrong, unlike step 2's default", () => {
    const words = formatListingPreviewIssue("ebay_fulfillment_policy:verification_unavailable");
    expect(words).toBe("Your shipping policy couldn't be checked with eBay. Preview again later.");
    expect(words).not.toMatch(/can't be used|can't use/);
  });
  it("calls Card Shellz's own coverage gap unchecked, not the vendor's problem", () => {
    expect(formatListingPreviewIssue("ebay_fulfillment_policy:destination_coverage_incomplete"))
      .toBe("Card Shellz can't check your shipping policy yet. Contact support.");
  });
  it.each([
    "marketplace_missing", "marketplace_mismatch", "handling_time_missing", "handling_time_unit_unsupported", "handling_time_too_short",
    "local_pickup_unsupported", "freight_shipping_unsupported", "pickup_drop_off_unsupported", "international_direct_shipping_unsupported",
    "shipping_option_type_unsupported", "shipping_service_unsupported:USPSPriorityMail", "domestic_shipping_service_required",
  ])("gives the step 2 reason for %s, read without Card Shellz shipping", (code) => {
    const words = formatListingPreviewIssue(`ebay_fulfillment_policy:${code}`);
    expect(words).toBe(`Your shipping policy can't be used: ${fulfillmentIssueReason({ code }, null)}.`);
    expect(words).not.toMatch(RAW_CODE);
    expect(words).not.toContain("USPSPriorityMail");
  });
  it("reads a too-short handling time without the days step 3 cannot know", () => {
    expect(formatListingPreviewIssue("ebay_fulfillment_policy:handling_time_too_short"))
      .toBe("Your shipping policy can't be used: handling time is too short for Card Shellz.");
  });
  it("names Listing settings, not a step number, for a return or payment policy gone from eBay", () => {
    expect(formatListingPreviewIssue("ebay_return_policy:not_found"))
      .toBe("Your return policy is no longer on eBay. Choose a return policy in Listing settings.");
    expect(formatListingPreviewIssue("ebay_payment_policy:not_found"))
      .toBe("Your payment policy is no longer on eBay. Choose a payment policy in Listing settings.");
    for (const kind of ["return", "payment"]) {
      const label = formatListingPreviewIssue(`ebay_${kind}_policy:verification_unavailable`);
      expect(label).toBe(`Your ${kind} policy couldn't be checked with eBay. Refresh the preview; contact support if this continues.`);
      expect(label).not.toMatch(/no longer|choose/i);
    }
  });
});

describe("product-cost preview issues", () => {
  it.each([
    ["vendor_unavailable", "Your Shellz Club account is unavailable. Contact support."],
    ["plan_unavailable", "Your .ops price list is unavailable. Contact support."],
    ["entitlement_inactive", "Your Shellz Club .ops access is inactive. Contact support."],
    ["variant_unmapped", "This product is not linked to your .ops price list. Contact support."],
    ["variant_identity_mismatch", "The product identity does not match your .ops price list. Contact support."],
    ["override_ambiguous", "The .ops product price has conflicting entries. Contact support."],
    ["retail_unavailable", "The catalog retail price is unavailable. Contact support."],
    ["source_read_failed", "The .ops product cost could not be loaded. Refresh the preview; contact support if this continues."],
    ["product_cost_source_unavailable", "The .ops product cost could not be loaded. Refresh the preview; contact support if this continues."],
  ])("gives an actionable pricing explanation for %s", (code, label) => {
    expect(formatListingPreviewIssue(code)).toBe(label);
    expect(formatListingPreviewIssue(code)).not.toMatch(/reauth|eBay|channel discount/i);
  });
  it("tells the vendor a price under the .ops cost loses money, and leaves the choice to them", () => {
    expect(formatListingPreviewIssue("price_below_product_cost"))
      .toBe("Priced below your .ops product cost: you lose money on every sale at this price. Raise the price, or list anyway and take the loss.");
  });
  it("tells the vendor what eBay will show when the catalog has no MPN", () => {
    expect(formatListingPreviewIssue("ebay_mpn_placeholder"))
      .toBe('The catalog has no manufacturer part number (MPN) for this product, so eBay will show "Does Not Apply". Contact support if the product has one.');
  });
});

describe("listing photo preview issues", () => {
  it("says an uploaded photo is left out and that the vendor cannot fix it", () => {
    expect(formatListingPreviewIssue("catalog_photo_public_address_missing"))
      .toBe("An uploaded catalog photo can't be sent to the marketplace yet, so this listing goes out without it. Card Shellz has to finish setting up photo hosting. Contact support.");
    expect(formatListingPreviewIssue("catalog_photo_unavailable"))
      .toBe("An uploaded catalog photo is missing, too large, or not a JPEG, PNG, WebP or GIF file, so this listing goes out without it. Contact support.");
  });
});

describe("listing tier preview issues", () => {
  it("says why the listing's tier is not active and what to change, never on sale or off sale", () => {
    expect(formatListingPreviewIssue("listing_tier:autopay_off"))
      .toBe("This listing's tier is not active: autopay is off, so your wallet has no reserve. Turn on autopay in Wallet.");
    expect(formatListingPreviewIssue("listing_tier:reserve_below_tier"))
      .toBe("This listing's tier is not active: your reserve is below the tier's amount. Raise your reserve in Wallet.");
    expect(formatListingPreviewIssue("listing_tier:balance_below_tier"))
      .toBe("This listing's tier is not active: your balance has not reached the tier's amount yet. Add money in Wallet.");
    for (const code of ["listing_tier:autopay_off", "listing_tier:reserve_below_tier", "listing_tier:balance_below_tier"]) {
      expect(formatListingPreviewIssue(code)).not.toMatch(/on sale|off sale|minimum|settling/i);
    }
  });
});

describe("the link that replaces step 3's editors (REC:921)", () => {
  it("opens the product's drawer in Listing settings on that size for a price, and on the product alone for its own things", () => {
    expect(listingPreviewSettingsLink({ productId: 7, productVariantId: 42 })).toBe("/catalog/setup?product=7&size=42");
    expect(listingPreviewSettingsLink({ productId: 7, productVariantId: 42 }, "price")).toBe("/catalog/setup?product=7&size=42");
    // The description and the policies are the product's: no size, so the drawer doesn't land on a price box (mS3 a.4).
    expect(listingPreviewSettingsLink({ productId: 7, productVariantId: 42 }, "product")).toBe("/catalog/setup?product=7");
    expect(listingPreviewSettingsLink({ productId: 0, productVariantId: 42 }, "product")).toBeNull();
    expect(LISTING_PREVIEW_WORDS.changeInListingSettings).toBe("Change in Listing settings ›");
  });
  it("gives no link for a size no longer in the catalog (the server's productId 0)", () => {
    expect(listingPreviewSettingsLink({ productId: 0, productVariantId: 42 })).toBeNull();
    expect(listingPreviewSettingsLink({ productId: -1, productVariantId: 42 })).toBeNull();
    expect(listingPreviewSettingsLink({ productId: Number.NaN, productVariantId: 42 })).toBeNull();
  });
  it("opens on the product alone when the size id is not a positive whole number", () => {
    expect(listingPreviewSettingsLink({ productId: 7, productVariantId: 0 })).toBe("/catalog/setup?product=7");
  });
  it("names each link for a screen reader by its size, its listing or its row, never by an id", () => {
    expect(listingPreviewSettingsLinkName("ARM-50")).toBe("Change in Listing settings: ARM-50");
    expect(listingPreviewSettingsLinkName("Mailers")).toBe("Change in Listing settings: Mailers");
    expect(listingPreviewSettingsLinkName("ARM-50")).not.toMatch(RAW_CODE);
    // The sheet's two links tell apart, and each name starts with the link's visible words (plan 3.4).
    expect(listingPreviewDescriptionLinkName("Mailers")).toBe("Change in Listing settings: description of Mailers");
    expect(listingPreviewDescriptionLinkName("Mailers")).not.toBe(listingPreviewSettingsLinkName("Mailers"));
    for (const name of [listingPreviewSettingsLinkName("ARM-50"), listingPreviewDescriptionLinkName("Mailers")]) {
      expect(name.startsWith("Change in Listing settings")).toBe(true);
    }
    expect(listingPreviewPolicyLinkName("Return policy")).toBe("Return policy: Set in Listing settings");
    expect(listingPreviewPolicyLinkName("Return policy")).toContain(LISTING_PREVIEW_WORDS.setInListingSettings);
    expect(listingPreviewPolicyLinkName("Return policy")).not.toMatch(RAW_CODE);
  });
  it("names no step 3 editor and no id in its words", () => {
    for (const words of Object.values(LISTING_PREVIEW_WORDS)) {
      expect(words).not.toMatch(RAW_CODE);
      expect(words).not.toMatch(/Edit price|Listing override|step 3/);
    }
    expect(LISTING_PREVIEW_WORDS.intro).not.toMatch(/Edit the listing price here/);
  });
});

describe("the listing mode on step 3", () => {
  it("reads in the store's own words, never as a Title-Cased code", () => {
    expect(listingPreviewModeWords("draft_first")).toBe("Drafts only");
    expect(listingPreviewModeWords("live")).toBe("Live");
    expect(listingPreviewModeWords("manual_only")).toBe("Manual only");
    for (const value of [null, undefined, "", "ebay", "DRAFT_FIRST"]) expect(listingPreviewModeWords(value), String(value)).toBe("Not set");
  });
});

describe("policy names on step 3 (D14)", () => {
  const selection = { fulfillmentPolicyId: "ground", returnPolicyId: "returns", paymentPolicyId: null, overriddenFields: ["returnPolicyId" as const] };
  function setup(patch: Partial<PolicySetupFacts> = {}): PolicySetupFacts {
    return {
      selection: { merchantLocationKey: null, fulfillmentPolicyId: "ground", returnPolicyId: "returns", paymentPolicyId: null },
      storedNames: { fulfillmentPolicyName: "Ground (stored)", returnPolicyName: "30-day returns", paymentPolicyName: null },
      options: {
        merchantLocations: [],
        fulfillmentPolicies: [{ id: "ground", name: "Ground (live)", compatible: true, compatibilityIssues: [] }],
        returnPolicies: [],
        paymentPolicies: [],
      },
      checks: { ebay: "checked", fulfillment: { status: "checked" } },
      ...patch,
    };
  }

  it("names a policy from eBay's live list when step 2 read it this visit", () => {
    expect(stepThreePolicyName("fulfillmentPolicyId", "ground", setup())).toBe("Ground (live)");
  });
  it("falls back to the name stored for the store default when eBay was not read, and only for the saved id", () => {
    const stored = setup({ checks: { ebay: "not_checked", fulfillment: { status: "not_checked" } } });
    expect(stepThreePolicyName("fulfillmentPolicyId", "ground", stored)).toBe("Ground (stored)");
    expect(stepThreePolicyName("returnPolicyId", "returns", stored)).toBe("30-day returns");
    // A product's or category's own policy has no name source on this page (gap G2): null, never the id.
    expect(stepThreePolicyName("returnPolicyId", "other-returns", stored)).toBeNull();
    expect(stepThreePolicyName("returnPolicyId", "other-returns", setup())).toBeNull();
  });
  it("gives no name on a direct load of step 3, when the setup cache is empty, and none for no policy", () => {
    expect(stepThreePolicyName("fulfillmentPolicyId", "ground", undefined)).toBeNull();
    expect(stepThreePolicyName("paymentPolicyId", null, setup())).toBeNull();
    expect(stepThreePolicyName("paymentPolicyId", "", setup())).toBeNull();
  });
  it("builds the three policy rows with step 2's names, a name or a link, and a source that is never 'Listing override'", () => {
    expect(LISTING_PREVIEW_POLICY_FIELDS.map((row) => row.label)).toEqual(["Shipping policy", "Return policy", "Payment policy"]);
    const path = "/catalog/setup?product=7";
    const returnLink = { href: path, words: "Set in Listing settings ›", name: "Return policy: Set in Listing settings" };
    // The product sets a return policy of its own: no name source on this page, so the row is the link, with
    // no source under it (the link's words already say where it is set).
    const ownReturn = { ...selection, returnPolicyId: "other-returns" };
    expect(listingPreviewPolicyLines(ownReturn, setup(), path)).toEqual([
      { field: "fulfillmentPolicyId", label: "Shipping policy", kind: "named", name: "Ground (live)", source: "Store default" },
      { field: "returnPolicyId", label: "Return policy", kind: "unnamed", link: returnLink, source: null },
      { field: "paymentPolicyId", label: "Payment policy", kind: "not_set", words: "Not set · Needed to list" },
    ]);
    // The store default's id keeps its stored name even when eBay's live list no longer has it.
    expect(listingPreviewPolicyLines(selection, setup(), path)[1])
      .toEqual({ field: "returnPolicyId", label: "Return policy", kind: "named", name: "30-day returns", source: "Set in Listing settings" });
    // A direct load (no setup read): every set policy links; a store default's source stays under its link.
    const direct = listingPreviewPolicyLines(selection, undefined, path);
    expect(direct[0]).toEqual({ field: "fulfillmentPolicyId", label: "Shipping policy", kind: "unnamed",
      link: { href: path, words: "Set in Listing settings ›", name: "Shipping policy: Set in Listing settings" }, source: "Store default" });
    expect(direct[1]).toEqual({ field: "returnPolicyId", label: "Return policy", kind: "unnamed", link: returnLink, source: null });
    // A size with nothing to open (the server's productId 0): no link, the source alone.
    const gone = listingPreviewPolicyLines(ownReturn, undefined, null);
    expect(gone[0]).toEqual({ field: "fulfillmentPolicyId", label: "Shipping policy", kind: "unnamed", link: null, source: "Store default" });
    expect(gone[1]).toEqual({ field: "returnPolicyId", label: "Return policy", kind: "unnamed", link: null, source: "Set in Listing settings" });
    for (const line of [...direct, ...gone, ...listingPreviewPolicyLines(ownReturn, setup(), path)]) {
      expect(JSON.stringify(line)).not.toMatch(/"ground"|"returns"|other-returns|Policy |Listing override/);
    }
  });
});

describe("listing preview rendering bounds", () => {
  const rows = Array.from({ length: 10000 }, (_, index) => ({ productVariantId: index + 1, title: `Product ${index + 1}`, sku: `SKU-${index + 1}` } as DropshipListingPreviewRow));
  it("mounts one bounded page without mutating or sorting the source", () => {
    expect(pageListingPreviews(rows, "", 2)).toMatchObject({ page: 2, pages: 200, total: 10000, start: 51, end: 100 });
    expect(pageListingPreviews(rows, "", 2).rows).toHaveLength(50);
    expect(rows[0].productVariantId).toBe(1);
  });
  it("clamps pages after filtering and handles no results/invalid page numbers", () => {
    expect(pageListingPreviews(rows, " sku-10000 ", 200)).toMatchObject({ page: 1, pages: 1, total: 1 });
    expect(pageListingPreviews(rows, "no match", 200)).toMatchObject({ page: 1, start: 0, end: 0, total: 0 });
    expect(pageListingPreviews(rows, "", NaN).page).toBe(1);
  });
});

describe("preview media URL boundary", () => {
  it.each(["https://images.example.test/photo.jpg", "http://images.example.test/photo.jpg", "/api/dropship/listings/stores/1/variants/2/assets/3/file"])("accepts intended image route %s", (url) => {
    expect(safeListingImageUrl(url)).toBe(url);
  });
  it.each(["javascript:alert(1)", "data:image/svg+xml,<svg/>", "//images.example.test/a", "/api/product-assets/3/file", "/api/dropship/settings", "https://user:secret@example.test/a", " https://example.test/a", "https://example.test/\na", "https:\\example.test/a", "", null])("rejects unsafe/unauthorized URL %s", (url) => {
    expect(safeListingImageUrl(url)).toBeNull();
  });
});
