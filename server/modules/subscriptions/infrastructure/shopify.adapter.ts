// shopify.adapter.ts — Infrastructure adapter for Shopify subscription GraphQL operations
import {
  shopifyGraphQL,
  type ShopifyGraphQLRequestOptions,
} from "../../shopify/admin-gql-client";

export { shopifyGraphQL, type ShopifyGraphQLRequestOptions };

const SUBSCRIPTION_GQL_OPTIONS: ShopifyGraphQLRequestOptions = {
  timeoutMs: 15_000,
};

/**
 * Raised when Shopify definitively rejects a subscription command before applying
 * a remote state transition or billing attempt (e.g. validation `userErrors`).
 */
export class SubscriptionProviderRejectedError extends Error {
  readonly definitive = true as const;

  constructor(message: string) {
    super(message);
    this.name = "SubscriptionProviderRejectedError";
  }
}

/**
 * Classifies whether a remote Shopify failure proves no side effect was committed,
 * as opposed to transport/timeout/5xx/rate-limit errors whose outcome is uncertain.
 */
export function isDefinitiveSubscriptionProviderRejection(err: unknown): boolean {
  if (err instanceof SubscriptionProviderRejectedError) return true;
  if (
    typeof err === "object" &&
    err !== null &&
    (err as { definitive?: unknown }).definitive === true
  ) {
    return true;
  }
  if (!(err instanceof Error)) return false;
  if (/^Shopify GraphQL error (400|401|403|404|422):/.test(err.message)) {
    return true;
  }
  if (
    err.message.includes("Missing SHOPIFY_SHOP_DOMAIN or SHOPIFY_ADMIN_ACCESS_TOKEN") ||
    err.message.includes("Invalid Shopify API version")
  ) {
    return true;
  }
  return false;
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

  const data = await shopifyGraphQL<any>(query, { id: contractGid }, SUBSCRIPTION_GQL_OPTIONS);
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
  const data = await shopifyGraphQL<any>(query, { id: customerGid }, SUBSCRIPTION_GQL_OPTIONS);
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

  const draftResult = await shopifyGraphQL<any>(
    draftMutation,
    { contractId: contractGid },
    SUBSCRIPTION_GQL_OPTIONS,
  );
  const draft = draftResult.subscriptionDraftCreate;
  if (draft?.userErrors?.length > 0 || !draft?.draft?.id) {
    throw new SubscriptionProviderRejectedError(
      `Failed to create draft: ${draft?.userErrors?.map((e: any) => e.message).join(", ") || "missing draft id"}`,
    );
  }

  const updateMutation = `
    mutation subscriptionDraftUpdate($draftId: ID!, $input: SubscriptionDraftInput!) {
      subscriptionDraftUpdate(draftId: $draftId, input: $input) {
        draft { id status }
        userErrors { field message }
      }
    }
  `;

  const updateResult = await shopifyGraphQL<any>(
    updateMutation,
    { draftId: draft.draft.id, input: { status: "CANCELLED" } },
    SUBSCRIPTION_GQL_OPTIONS,
  );
  const updated = updateResult.subscriptionDraftUpdate;
  if (updated?.userErrors?.length > 0) {
    throw new SubscriptionProviderRejectedError(
      `Failed to update draft: ${updated.userErrors.map((e: any) => e.message).join(", ")}`,
    );
  }

  const commitMutation = `
    mutation subscriptionDraftCommit($draftId: ID!) {
      subscriptionDraftCommit(draftId: $draftId) {
        contract { id status }
        userErrors { field message }
      }
    }
  `;

  const commitResult = await shopifyGraphQL<any>(
    commitMutation,
    { draftId: draft.draft.id },
    SUBSCRIPTION_GQL_OPTIONS,
  );
  const committed = commitResult.subscriptionDraftCommit;
  if (committed?.userErrors?.length > 0 || !committed?.contract?.id) {
    throw new SubscriptionProviderRejectedError(
      `Failed to commit draft: ${committed?.userErrors?.map((e: any) => e.message).join(", ") || "missing committed contract"}`,
    );
  }
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

  const data = await shopifyGraphQL<any>(
    mutation,
    {
      subscriptionContractId: contractGid,
      subscriptionBillingAttemptInput: { idempotencyKey, originTime },
    },
    SUBSCRIPTION_GQL_OPTIONS,
  );

  const result = data.subscriptionBillingAttemptCreate;
  if (result?.userErrors?.length > 0) {
    throw new SubscriptionProviderRejectedError(
      `Billing attempt failed: ${result.userErrors.map((e: any) => e.message).join(", ")}`,
    );
  }

  return result?.subscriptionBillingAttempt;
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
