import { ORDER_EDIT_CATALOG_AVAILABILITY_SAMPLE_SIZE } from "@shared/order-edits/order-edit-catalog";

const MONEY = `presentmentMoney { amount currencyCode } shopMoney { amount currencyCode }`;
const TRANSACTION = `id kind status gateway manualPaymentGateway processedAt parentTransaction { id } amountSet { ${MONEY} }`;
const DISCOUNT_VALUE = `value { __typename ... on PricingPercentageValue { percentage } ... on MoneyV2 { amount currencyCode } }`;
const CALCULATED_ALLOCATION = `calculatedDiscountAllocations { allocatedAmountSet { ${MONEY} } discountApplication { __typename id allocationMethod appliedTo targetType targetSelection description ${DISCOUNT_VALUE} ... on CalculatedDiscountCodeApplication { code } } }`;
export const REFUND_FIELDS = `id note totalRefundedSet { ${MONEY} } transactions(first: 250) { nodes { ${TRANSACTION} } pageInfo { hasNextPage } }`;
export const ORDER_QUERY = `query EchelonEditOrder($id: ID!) {
  shop { currencyCode primaryDomain { host } transformEnabled: metafield(namespace: "cardshellz", key: "transform_global_enabled") { value } }
  order(id: $id) {
    id name updatedAt merchantEditable merchantEditableErrors cancelledAt closed fullyPaid
    currencyCode presentmentCurrencyCode capturable taxesIncluded
    currentTotalPriceSet { ${MONEY} } totalOutstandingSet { ${MONEY} }
    currentSubtotalPriceSet { ${MONEY} } currentTotalTaxSet { ${MONEY} }
    netPaymentSet { ${MONEY} } totalCapturableSet { ${MONEY} } currentShippingPriceSet { ${MONEY} }
    paymentCollectionDetails { additionalPaymentCollectionUrl }
    paymentTerms { id } purchasingEntity { __typename } disputes { id }
    customAttributes { key value }
    shippingAddress { address1 address2 city provinceCode zip countryCodeV2 }
    customer { id tags membershipPlan: metafield(namespace: "cardshellz", key: "membership_plan") { value } }
    discountApplications(first: 250) { nodes { __typename index targetType allocationMethod targetSelection ${DISCOUNT_VALUE}
      ... on AutomaticDiscountApplication { title }
      ... on ManualDiscountApplication { title }
      ... on DiscountCodeApplication { code }
    } pageInfo { hasNextPage } }
    lineItems(first: 250) { nodes {
      id title variantTitle sku currentQuantity unfulfilledQuantity originalUnitPriceSet { ${MONEY} }
      unfulfilledDiscountedTotalSet { ${MONEY} }
      discountedUnitPriceSet { ${MONEY} } merchantEditable requiresShipping isGiftCard
      priceAfterAllDiscountsBeforeTaxesSet { ${MONEY} }
      sellingPlan { name } lineItemGroup { id } variant { id }
      discountAllocations { allocatedAmountSet { ${MONEY} } discountApplication { index } }
    } pageInfo { hasNextPage } }
    shippingLines(first: 250) { nodes { id title code source isRemoved originalPriceSet { ${MONEY} } currentDiscountedPriceSet { ${MONEY} } } pageInfo { hasNextPage } }
    transactions(first: 250) { ${TRANSACTION} }
    transactionsCount { count precision }
    refunds { ${REFUND_FIELDS} }
  }
}`;

export function variantFields(
  productFields = "status isGiftCard requiresSellingPlan",
): string {
  return `id displayName title sku price requiresComponents availableForSale inventoryPolicy sellableOnlineQuantity
  inventoryItem { requiresShipping tracked }
  product { ${productFields} }
  membershipVariant: metafield(namespace: "cardshellz", key: "is_membership_variant") { value }
  planPrices: metafield(namespace: "cardshellz", key: "plan_prices") { value }`;
}
export const VARIANT_FIELDS = variantFields();
const CATALOG_VARIANT_FIELDS = variantFields(
  "id title status isGiftCard requiresSellingPlan",
);
const CATALOG_PRODUCT_FIELDS = `id title productType status isGiftCard requiresSellingPlan onlineStoreUrl featuredImage { url }`;
const CATALOG_PAGE_FIELDS = `pageInfo { hasNextPage endCursor }`;
const CATALOG_AVAILABILITY_FIELDS = `id requiresComponents availableForSale inventoryPolicy sellableOnlineQuantity
  inventoryItem { requiresShipping tracked }
  membershipVariant: metafield(namespace: "cardshellz", key: "is_membership_variant") { value }`;
// Keep the legacy flat response within its 50-option contract while retaining exact SKU discovery.
export const LEGACY_SKU_RESULTS = 25;
export const LEGACY_PRODUCT_RESULTS = 5;
export const LEGACY_OPTIONS_PER_PRODUCT = 5;
export const CATALOG_CATEGORIES_QUERY = `query EchelonEditCategories($first: Int!, $after: String) {
  shop { currencyCode }
  productTypes(first: $first, after: $after) { edges { node } ${CATALOG_PAGE_FIELDS} }
}`;
export const CATALOG_PRODUCTS_QUERY = `query EchelonEditProducts($first: Int!, $after: String, $query: String!) {
  shop { currencyCode }
  products(first: $first, after: $after, query: $query, sortKey: TITLE) {
    nodes { ${CATALOG_PRODUCT_FIELDS}
      variants(first: ${ORDER_EDIT_CATALOG_AVAILABILITY_SAMPLE_SIZE}) { nodes { ${CATALOG_AVAILABILITY_FIELDS} } ${CATALOG_PAGE_FIELDS} }
    } ${CATALOG_PAGE_FIELDS}
  }
}`;
export const CATALOG_VARIANTS_QUERY = `query EchelonEditProductOptions($id: ID!, $first: Int!, $after: String) {
  shop { currencyCode }
  product(id: $id) { ${CATALOG_PRODUCT_FIELDS}
    variants(first: $first, after: $after) { nodes { ${CATALOG_VARIANT_FIELDS} } ${CATALOG_PAGE_FIELDS} }
  }
}`;
export const CATALOG_AVAILABILITY_QUERY = `query EchelonEditProductAvailability($id: ID!, $first: Int!, $after: String) {
  shop { currencyCode }
  product(id: $id) { ${CATALOG_PRODUCT_FIELDS}
    variants(first: $first, after: $after) { nodes { ${CATALOG_AVAILABILITY_FIELDS} } ${CATALOG_PAGE_FIELDS} }
  }
}`;
// Compatibility endpoint only; the picker uses both paginated catalog endpoints.
export const SEARCH_QUERY = `query EchelonEditVariants($query: String!, $skuQuery: String!) {
  shop { currencyCode }
  productVariants(first: ${LEGACY_SKU_RESULTS}, query: $skuQuery) {
    nodes { ${variantFields("id title status isGiftCard requiresSellingPlan onlineStoreUrl")} }
  }
  products(first: ${LEGACY_PRODUCT_RESULTS}, query: $query, sortKey: TITLE) { nodes { ${CATALOG_PRODUCT_FIELDS}
    variants(first: ${LEGACY_OPTIONS_PER_PRODUCT}) { nodes { ${CATALOG_VARIANT_FIELDS} } }
  } }
}`;
export const VARIANTS_QUERY = `query EchelonEditVariantPrices($ids: [ID!]!) {
  nodes(ids: $ids) { ... on ProductVariant { ${VARIANT_FIELDS} } }
}`;
export const PRICING_PROVENANCE_QUERY = `query EchelonEditPricingProvenance {
  currentAppInstallation { app { id } }
  shopifyFunctions(first: 100) { nodes { id handle } pageInfo { hasNextPage } }
  discountNodes(first: 100, query: "method:automatic") { nodes { id discount { __typename
    ... on DiscountAutomaticApp { title status discountClasses appDiscountType { functionId app { id } } }
    ... on DiscountAutomaticBasic { title status }
    ... on DiscountAutomaticBxgy { title status }
    ... on DiscountAutomaticFreeShipping { title status }
  } } pageInfo { hasNextPage } }
}`;
export const CALCULATED_FIELDS = `id originalOrder { id } totalPriceSet { ${MONEY} } totalOutstandingSet { ${MONEY} }
  subtotalPriceSet { ${MONEY} } taxLines { priceSet { ${MONEY} } }
  shippingLines { id title price { ${MONEY} } stagedStatus }
  lineItems(first: 250) { nodes { id title variantTitle quantity editableQuantityBeforeChanges editableSubtotalSet { ${MONEY} } variant { id }
    originalUnitPriceSet { ${MONEY} } discountedUnitPriceSet { ${MONEY} }
    ${CALCULATED_ALLOCATION}
  } pageInfo { hasNextPage } }
  addedLineItems(first: 250) { nodes { id title variantTitle quantity editableQuantityBeforeChanges editableSubtotalSet { ${MONEY} } variant { id }
    originalUnitPriceSet { ${MONEY} } discountedUnitPriceSet { ${MONEY} }
    ${CALCULATED_ALLOCATION}
  } pageInfo { hasNextPage } }`;
export const BEGIN_MUTATION = `mutation EchelonEditBegin($id: ID!) {
  orderEditBegin(id: $id) { calculatedOrder { ${CALCULATED_FIELDS} } orderEditSession { id } userErrors { field message } }
}`;
export const QUANTITY_MUTATION = `mutation EchelonEditQuantity($id: ID!, $lineItemId: ID!, $quantity: Int!) {
  orderEditSetQuantity(id: $id, lineItemId: $lineItemId, quantity: $quantity, restock: false) {
    calculatedOrder { ${CALCULATED_FIELDS} } userErrors { field message }
  }
}`;
export const ADD_MUTATION = `mutation EchelonEditAdd($id: ID!, $variantId: ID!, $quantity: Int!) {
  orderEditAddVariant(id: $id, variantId: $variantId, quantity: $quantity, allowDuplicates: true) {
    calculatedLineItem { id } calculatedOrder { ${CALCULATED_FIELDS} } userErrors { field message }
  }
}`;
export const DISCOUNT_MUTATION = `mutation EchelonEditMemberPrice($id: ID!, $lineItemId: ID!, $discount: OrderEditAppliedDiscountInput!) {
  orderEditAddLineItemDiscount(id: $id, lineItemId: $lineItemId, discount: $discount) {
    calculatedOrder { ${CALCULATED_FIELDS} } userErrors { field message }
  }
}`;
export const COMMIT_MUTATION = `mutation EchelonEditCommit($id: ID!, $staffNote: String!) {
  orderEditCommit(id: $id, notifyCustomer: false, staffNote: $staffNote) { order { id } userErrors { field message } }
}`;
export const REMOVE_SHIPPING_MUTATION = `mutation EchelonEditRemoveShipping($id: ID!, $shippingLineId: ID!) {
  orderEditRemoveShippingLine(id: $id, shippingLineId: $shippingLineId) {
    calculatedOrder { ${CALCULATED_FIELDS} } userErrors { field message }
  }
}`;
export const ADD_SHIPPING_MUTATION = `mutation EchelonEditAddShipping($id: ID!, $shippingLine: OrderEditAddShippingLineInput!) {
  orderEditAddShippingLine(id: $id, shippingLine: $shippingLine) {
    calculatedOrder { ${CALCULATED_FIELDS} } userErrors { field message }
  }
}`;
export const REFUND_CAPACITY_QUERY = `query EchelonEditRefundCapacity($id: ID!) {
  order(id: $id) { id suggestedRefund(suggestFullRefund: true, refundMethodAllocation: ORIGINAL_PAYMENT_METHODS) {
    maximumRefundableSet { ${MONEY} }
    suggestedTransactions { kind gateway parentTransaction { id }
      maximumRefundableSet { ${MONEY} }
    }
  } }
}`;
export const REFUND_MUTATION = `mutation EchelonEditRefund($input: RefundInput!, $idempotencyKey: String!) {
  refundCreate(input: $input) @idempotent(key: $idempotencyKey) {
    refund { ${REFUND_FIELDS} } userErrors { field message }
  }
}`;
