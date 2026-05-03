// shopify.adapter.ts — Pure infrastructure adapter for Shopify GraphQL endpoints
import { getShopifyConfig } from "../../integrations/shopify";
import type { ShopifyGraphQLResponse } from "../subscription.types";

const SHOPIFY_API_VERSION = "2024-10";

export async function shopifyGraphQL<T = any>(query: string, variables?: Record<string, any>): Promise<T> {
  const config = getShopifyConfig();
  const url = `https://${config.domain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": config.accessToken,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Shopify GraphQL error ${response.status}: ${text}`);
  }

  const json = await response.json() as ShopifyGraphQLResponse<T>;

  if (json.errors && json.errors.length > 0) {
    throw new Error(`Shopify GraphQL errors: ${json.errors.map(e => e.message).join(", ")}`);
  }

  return json.data as T;
}

/**
 * Look up a subscription contract's line items.
 */
export async function fetchContractSellingPlanLines(contractGid: string): Promise<{ sellingPlanGid: string | null; productId: string | null } | null> {
  const query = `
    query getContract($id: ID!) {
      subscriptionContract(id: $id) {
        id
        status
        lines(first: 5) {
          edges {
            node {
              productId
              sellingPlanId
              sellingPlanName
            }
          }
        }
      }
    }
  `;

  const data = await shopifyGraphQL<any>(query, { id: contractGid });
  const contract = data.subscriptionContract;
  if (!contract) return null;

  const line = contract.lines?.edges?.[0]?.node;
  return {
    sellingPlanGid: line?.sellingPlanId || null,
    productId: line?.productId || null,
  };
}

/**
 * Get customer info from Shopify
 */
export async function getShopifyCustomer(customerGid: string): Promise<{ email: string; firstName: string; lastName: string } | null> {
  const query = `
    query getCustomer($id: ID!) {
      customer(id: $id) {
        email
        firstName
        lastName
      }
    }
  `;
  const data = await shopifyGraphQL<any>(query, { id: customerGid });
  return data.customer || null;
}


/**
 * Cancels a subscription contract via Draft mutations
 */
export async function cancelShopifyContract(contractGid: string): Promise<void> {
  const draftMutation = `
    mutation subscriptionContractUpdate($contractId: ID!) {
      subscriptionDraftCreate(contractId: $contractId) {
        draft { id }
        userErrors { field message }
      }
    }
  `;

  const draftResult = await shopifyGraphQL<any>(draftMutation, { contractId: contractGid });
  const draft = draftResult.subscriptionDraftCreate;
  if (draft.userErrors?.length > 0 || !draft.draft?.id) {
    throw new Error(`Failed to create draft: ${draft.userErrors?.map((e: any) => e.message).join(", ")}`);
  }

  const updateMutation = `
    mutation subscriptionDraftUpdate($draftId: ID!, $input: SubscriptionDraftInput!) {
      subscriptionDraftUpdate(draftId: $draftId, input: $input) {
        draft { id status }
        userErrors { field message }
      }
    }
  `;

  await shopifyGraphQL(updateMutation, { draftId: draft.draft.id, input: { status: "CANCELLED" } });

  const commitMutation = `
    mutation subscriptionDraftCommit($draftId: ID!) {
      subscriptionDraftCommit(draftId: $draftId) {
        contract { id status }
        userErrors { field message }
      }
    }
  `;

  await shopifyGraphQL(commitMutation, { draftId: draft.draft.id });
}

/**
 * Creates a billing attempt for a subscription contract
 */
export async function createBillingAttempt(
  contractGid: string,
  idempotencyKey: string,
  originTime: string
): Promise<any> {
  const mutation = `
    mutation subscriptionBillingAttemptCreate(
      $subscriptionContractId: ID!,
      $subscriptionBillingAttemptInput: SubscriptionBillingAttemptInput!
    ) {
      subscriptionBillingAttemptCreate(
        subscriptionContractId: $subscriptionContractId,
        subscriptionBillingAttemptInput: $subscriptionBillingAttemptInput
      ) {
        subscriptionBillingAttempt { id ready originTime }
        userErrors { field message }
      }
    }
  `;

  const data = await shopifyGraphQL<any>(mutation, {
    subscriptionContractId: contractGid,
    subscriptionBillingAttemptInput: { idempotencyKey, originTime },
  });

  const result = data.subscriptionBillingAttemptCreate;
  if (result.userErrors?.length > 0) {
    throw new Error(`Billing attempt failed: ${result.userErrors.map((e: any) => e.message).join(", ")}`);
  }

  return result.subscriptionBillingAttempt;
}

/**
 * Creates Selling Plan Group
 */
export async function createSellingPlanGroupGraphql(
  membershipProductGid: string,
  sellingPlansToCreate: any[]
): Promise<any> {
  const mutation = `
    mutation sellingPlanGroupCreate($input: SellingPlanGroupInput!, $resources: SellingPlanGroupResourceInput!) {
      sellingPlanGroupCreate(input: $input, resources: $resources) {
        sellingPlanGroup {
          id
          sellingPlans(first: 10) {
            edges {
              node {
                id
                name
              }
            }
          }
        }
        userErrors { field message }
      }
    }
  `;

  const variables = {
    input: {
      name: "Shellz Club Membership",
      merchantCode: "shellz-club",
      options: ["Membership Tier"],
      position: 1,
      sellingPlansToCreate,
    },
    resources: {
      productIds: [membershipProductGid],
    },
  };

  const data = await shopifyGraphQL<any>(mutation, variables);
  const result = data.sellingPlanGroupCreate;

  if (result.userErrors?.length > 0) {
    throw new Error(`Selling plan creation errors: ${result.userErrors.map((e: any) => e.message).join(", ")}`);
  }

  return result.sellingPlanGroup;
}

/**
 * Lists Selling Plan Groups
 */
export async function fetchSellingPlanGroupsGraphql(): Promise<any[]> {
  const query = `
    query {
      sellingPlanGroups(first: 10) {
        edges {
          node {
            id
            name
            merchantCode
            sellingPlans(first: 20) {
              edges {
                node {
                  id
                  name
                  category
                  billingPolicy {
                    ... on SellingPlanRecurringBillingPolicy {
                      interval
                      intervalCount
                    }
                  }
                  pricingPolicies {
                    ... on SellingPlanFixedPricingPolicy {
                      adjustmentType
                      adjustmentValue { ... on MoneyV2 { amount currencyCode } }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  `;
  const data = await shopifyGraphQL<any>(query);
  return data.sellingPlanGroups.edges.map((e: any) => e.node);
}

/**
 * Register webhooks on Shopify
 */
export async function registerWebhookSubscriptionGraphql(topic: string, callbackUrl: string): Promise<any> {
  const mutation = `
    mutation webhookSubscriptionCreate($topic: WebhookSubscriptionTopic!, $webhookSubscription: WebhookSubscriptionInput!) {
      webhookSubscriptionCreate(topic: $topic, webhookSubscription: $webhookSubscription) {
        webhookSubscription { id }
        userErrors { field message }
      }
    }
  `;
  const data = await shopifyGraphQL<any>(mutation, {
    topic,
    webhookSubscription: { callbackUrl, format: "JSON" },
  });
  return data.webhookSubscriptionCreate;
}
