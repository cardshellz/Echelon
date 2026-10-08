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

export const VARIANT_FIELDS = `id displayName title sku price requiresComponents availableForSale inventoryPolicy sellableOnlineQuantity
  inventoryItem { requiresShipping tracked }
  product { status isGiftCard requiresSellingPlan }
  membershipVariant: metafield(namespace: "cardshellz", key: "is_membership_variant") { value }
  planPrices: metafield(namespace: "cardshellz", key: "plan_prices") { value }`;
export const SEARCH_QUERY = `query EchelonEditVariants($query: String!) {
  shop { currencyCode }
  productVariants(first: 25, query: $query) { nodes { ${VARIANT_FIELDS} } }
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
