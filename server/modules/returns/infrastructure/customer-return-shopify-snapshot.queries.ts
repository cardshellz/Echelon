// Fixed, read-only operations for Admin GraphQL 2026-07. No caller supplies query text.
// Collections use independent cursors: nesting first-page queries would hide truncation.
const PAGE_INFO = "pageInfo { hasNextPage endCursor }";
export const SHOPIFY_RETURN_SNAPSHOT_QUERIES = Object.freeze({
  account: `query ReturnSnapshotAccount {
    shop { id myshopifyDomain }
    currentAppInstallation { accessScopes { handle } }
  }`,
  order: `query ReturnSnapshotOrder($id: ID!) { order(id: $id) {
    id name createdAt processedAt updatedAt cancelledAt shippingAddress { countryCodeV2 }
    fulfillmentsCount { count precision }
    fulfillments(first: 201) { id status updatedAt deliveredAt inTransitAt displayStatus totalQuantity
      trackingInfo(first: 201) { number company } }
    refunds(first: 201) { id updatedAt return { id } }
  } }`,
  lines: `query ReturnSnapshotPurchasedLines($id: ID!, $after: String) { order(id: $id) {
    id updatedAt lineItems(first: 100, after: $after) { nodes {
      id title variantTitle sku quantity currentQuantity refundableQuantity requiresShipping
    } ${PAGE_INFO} }
  } }`,
  fulfillmentLines: `query ReturnSnapshotFulfillmentLines($id: ID!, $after: String) { fulfillment(id: $id) {
    id updatedAt order { id } fulfillmentLineItems(first: 100, after: $after) {
      nodes { id quantity lineItem { id } } ${PAGE_INFO}
    }
  } }`,
  events: `query ReturnSnapshotFulfillmentEvents($id: ID!, $after: String) { fulfillment(id: $id) {
    id updatedAt order { id } events(first: 100, after: $after) {
      nodes { id status happenedAt } ${PAGE_INFO}
    }
  } }`,
  returns: `query ReturnSnapshotReturns($id: ID!, $after: String) { order(id: $id) {
    id updatedAt returns(first: 100, after: $after) {
      nodes { id status totalQuantity order { id } } ${PAGE_INFO}
    }
  } }`,
  returnLines: `query ReturnSnapshotNativeReturnLines($id: ID!, $after: String) { return(id: $id) {
    id status totalQuantity order { id } returnLineItems(first: 100, after: $after) {
      nodes { __typename ... on ReturnLineItem {
        id quantity processedQuantity refundedQuantity fulfillmentLineItem { id lineItem { id } }
      } } ${PAGE_INFO}
    }
  } }`,
  refundLines: `query ReturnSnapshotRefundLines($id: ID!, $after: String) { refund(id: $id) {
    id updatedAt order { id } return { id } refundLineItems(first: 100, after: $after) {
      nodes { id quantity restockType lineItem { id } } ${PAGE_INFO}
    }
  } }`,
  returnables: `query ReturnSnapshotReturnables($id: ID!, $after: String) {
    returnableFulfillments(orderId: $id, first: 100, after: $after) {
      nodes { id fulfillment { id order { id } } } ${PAGE_INFO}
    }
  }`,
  returnableLines: `query ReturnSnapshotReturnableLines($id: ID!, $after: String) {
    returnableFulfillment(id: $id) {
      id fulfillment { id order { id } } returnableFulfillmentLineItems(first: 100, after: $after) {
        nodes { quantity fulfillmentLineItem { id lineItem { id } } } ${PAGE_INFO}
      }
    }
  }`,
});
