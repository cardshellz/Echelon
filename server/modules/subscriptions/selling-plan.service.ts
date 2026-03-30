// selling-plan.service.ts — Shopify Selling Plans API wrapper (GraphQL)
import { getShopifyConfig } from "../integrations/shopify";
import * as storage from "./subscription.storage";
import type { SellingPlanConfig, SellingPlanGroupResult, ShopifyGraphQLResponse } from "./subscription.types";

const SHOPIFY_API_VERSION = "2024-10";

async function shopifyGraphQL<T = any>(query: string, variables?: Record<string, any>): Promise<T> {
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

export { shopifyGraphQL };

// The plan configs we want to create on Shopify
// Prices match the task spec: $4.99/mo, $49.99/yr, $19.99/mo, $199.99/yr
const PLAN_CONFIGS: SellingPlanConfig[] = [
  {
    name: "Shellz Club Standard — Monthly",
    options: ["Standard Monthly"],
    billingInterval: "MONTH",
    billingIntervalCount: 1,
    priceCents: 499,
    tier: "standard",
    includesDropship: false,
    planId: 0, // resolved at runtime from DB
  },
  {
    name: "Shellz Club Standard — Annual",
    options: ["Standard Annual"],
    billingInterval: "YEAR",
    billingIntervalCount: 1,
    priceCents: 4999,
    tier: "standard",
    includesDropship: false,
    planId: 0,
  },
  {
    name: "Shellz Club Gold — Monthly",
    options: ["Gold Monthly"],
    billingInterval: "MONTH",
    billingIntervalCount: 1,
    priceCents: 1999,
    tier: "gold",
    includesDropship: true,
    planId: 0,
  },
  {
    name: "Shellz Club Gold — Annual",
    options: ["Gold Annual"],
    billingInterval: "YEAR",
    billingIntervalCount: 1,
    priceCents: 19999,
    tier: "gold",
    includesDropship: true,
    planId: 0,
  },
];

/**
 * Create the Selling Plan Group on Shopify and store mapping in DB.
 * Admin endpoint: POST /api/membership/setup-selling-plans
 */
export async function createSellingPlanGroup(membershipProductGid: string): Promise<SellingPlanGroupResult> {
  // First, ensure plan rows exist in DB for each config
  const existingPlans = await storage.getAllPlans();
  const resolvedConfigs = await resolveOrCreatePlans(existingPlans);

  const sellingPlansToCreate = resolvedConfigs.map(cfg => ({
    name: cfg.name,
    options: cfg.options,
    category: "SUBSCRIPTION",
    billingPolicy: {
      recurring: {
        interval: cfg.billingInterval,
        intervalCount: cfg.billingIntervalCount,
      },
    },
    deliveryPolicy: {
      recurring: {
        interval: cfg.billingInterval,
        intervalCount: cfg.billingIntervalCount,
      },
    },
    pricingPolicies: [
      {
        fixed: {
          adjustmentType: "PRICE",
          adjustmentValue: {
            fixedValue: (cfg.priceCents / 100).toFixed(2),
          },
        },
      },
    ],
  }));

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
        userErrors {
          field
          message
        }
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

  const group = result.sellingPlanGroup;
  const sellingPlans = group.sellingPlans.edges.map((e: any) => ({
    gid: e.node.id,
    name: e.node.name,
  }));

  // Map selling plans to our plan IDs and store in DB
  for (const sp of sellingPlans) {
    const matchingConfig = resolvedConfigs.find(c => c.name === sp.name);
    if (matchingConfig) {
      const numericId = parseInt(sp.gid.split("/").pop() || "0");

      await storage.updatePlanSellingPlan(matchingConfig.planId, sp.gid, numericId);
      await storage.upsertSellingPlanMap({
        shopify_selling_plan_gid: sp.gid,
        shopify_selling_plan_group_gid: group.id,
        plan_id: matchingConfig.planId,
        plan_name: matchingConfig.name,
        billing_interval: matchingConfig.billingInterval === "MONTH" ? "month" : "year",
        price_cents: matchingConfig.priceCents,
      });
    }
  }

  console.log(`[SellingPlans] Created group ${group.id} with ${sellingPlans.length} plans`);

  return {
    sellingPlanGroupGid: group.id,
    sellingPlans,
  };
}

/**
 * Match PLAN_CONFIGS to existing DB plans or create new rows.
 */
async function resolveOrCreatePlans(existingPlans: any[]): Promise<SellingPlanConfig[]> {
  const { pool } = await import("../../db");
  const resolved: SellingPlanConfig[] = [];

  for (const cfg of PLAN_CONFIGS) {
    // Try to match by name pattern
    let match = existingPlans.find(p => {
      const name = (p.name || "").toLowerCase();
      if (cfg.tier === "standard" && cfg.billingInterval === "MONTH") {
        return name.includes("standard") && (name.includes("month") || name.includes("monthly"));
      }
      if (cfg.tier === "standard" && cfg.billingInterval === "YEAR") {
        return name.includes("standard") && (name.includes("annual") || name.includes("year"));
      }
      if (cfg.tier === "gold" && cfg.billingInterval === "MONTH") {
        return name.includes("gold") && (name.includes("month") || name.includes("monthly"));
      }
      if (cfg.tier === "gold" && cfg.billingInterval === "YEAR") {
        return name.includes("gold") && (name.includes("annual") || name.includes("year"));
      }
      return false;
    });

    if (match) {
      // Update existing plan with subscription details
      await storage.updatePlanDetails(match.id, {
        billing_interval: cfg.billingInterval === "MONTH" ? "month" : "year",
        billing_interval_count: cfg.billingIntervalCount,
        price_cents: cfg.priceCents,
        tier: cfg.tier,
        includes_dropship: cfg.includesDropship,
      });
      resolved.push({ ...cfg, planId: match.id });
    } else {
      // Create new plan row
      const result = await pool.query(
        `INSERT INTO membership.plans (name, tier, billing_interval, billing_interval_count, price_cents, includes_dropship, is_active)
         VALUES ($1, $2, $3, $4, $5, $6, true) RETURNING id`,
        [cfg.name, cfg.tier, cfg.billingInterval === "MONTH" ? "month" : "year", cfg.billingIntervalCount, cfg.priceCents, cfg.includesDropship]
      );
      resolved.push({ ...cfg, planId: result.rows[0].id });
    }
  }

  return resolved;
}

/**
 * List existing selling plan groups from Shopify
 */
export async function listSellingPlanGroups(): Promise<any[]> {
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
                      adjustmentValue {
                        ... on MoneyV2 {
                          amount
                          currencyCode
                        }
                      }
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
 * Look up a subscription contract's line items to determine which selling plan was used.
 */
export async function getContractSellingPlan(contractGid: string): Promise<{ sellingPlanGid: string; planId: number | null } | null> {
  const query = `
    query getContract($id: ID!) {
      subscriptionContract(id: $id) {
        id
        status
        lines(first: 5) {
          edges {
            node {
              sellingPlanId
              sellingPlanName
            }
          }
        }
        customer {
          id
          email
          firstName
          lastName
        }
        billingPolicy {
          interval
          intervalCount
        }
        nextBillingDate
      }
    }
  `;

  const data = await shopifyGraphQL<any>(query, { id: contractGid });
  const contract = data.subscriptionContract;
  if (!contract) return null;

  // Get selling plan ID from contract lines
  const line = contract.lines?.edges?.[0]?.node;
  const sellingPlanGid = line?.sellingPlanId;
  if (!sellingPlanGid) return null;

  // Look up in selling_plan_map
  const plan = await storage.getPlanBySellingPlanGid(sellingPlanGid);

  return {
    sellingPlanGid,
    planId: plan?.id || null,
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
 * Add/remove tags on a Shopify customer
 */
export async function tagCustomer(customerGid: string, tags: string[]): Promise<void> {
  const mutation = `
    mutation tagsAdd($id: ID!, $tags: [String!]!) {
      tagsAdd(id: $id, tags: $tags) {
        userErrors { field message }
      }
    }
  `;
  await shopifyGraphQL(mutation, { id: customerGid, tags });
}

export async function removeCustomerTags(customerGid: string, tags: string[]): Promise<void> {
  const mutation = `
    mutation tagsRemove($id: ID!, $tags: [String!]!) {
      tagsRemove(id: $id, tags: $tags) {
        userErrors { field message }
      }
    }
  `;
  await shopifyGraphQL(mutation, { id: customerGid, tags });
}

/**
 * Register subscription webhooks with Shopify
 */
export async function registerSubscriptionWebhooks(baseUrl: string): Promise<string[]> {
  const topics = [
    { topic: "SUBSCRIPTION_CONTRACTS_CREATE", path: "/api/webhooks/subscription-contracts/create" },
    { topic: "SUBSCRIPTION_CONTRACTS_UPDATE", path: "/api/webhooks/subscription-contracts/update" },
    { topic: "SUBSCRIPTION_BILLING_ATTEMPTS_SUCCESS", path: "/api/webhooks/subscription-billing/success" },
    { topic: "SUBSCRIPTION_BILLING_ATTEMPTS_FAILURE", path: "/api/webhooks/subscription-billing/failure" },
  ];

  const registered: string[] = [];

  for (const { topic, path } of topics) {
    const mutation = `
      mutation webhookSubscriptionCreate($topic: WebhookSubscriptionTopic!, $webhookSubscription: WebhookSubscriptionInput!) {
        webhookSubscriptionCreate(topic: $topic, webhookSubscription: $webhookSubscription) {
          webhookSubscription { id }
          userErrors { field message }
        }
      }
    `;

    try {
      const data = await shopifyGraphQL<any>(mutation, {
        topic,
        webhookSubscription: {
          callbackUrl: `${baseUrl}${path}`,
          format: "JSON",
        },
      });

      const result = data.webhookSubscriptionCreate;
      if (result.userErrors?.length > 0) {
        console.warn(`[SellingPlans] Webhook ${topic} error: ${result.userErrors.map((e: any) => e.message).join(", ")}`);
      } else {
        registered.push(topic);
        console.log(`[SellingPlans] Registered webhook: ${topic}`);
      }
    } catch (err: any) {
      console.error(`[SellingPlans] Failed to register webhook ${topic}: ${err.message}`);
    }
  }

  return registered;
}
