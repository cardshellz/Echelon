import type { PlanRecord, ContractWebhookPayload } from "../subscription.types";

/**
 * Calculates the next billing period end date based on interval and count.
 */
export function calculateNextBillingDate(
  startDate: Date,
  interval?: string,
  intervalCount: number = 1
): Date {
  const periodEnd = new Date(startDate);
  const normalizedInterval = interval?.toLowerCase();

  if (normalizedInterval === "year" || normalizedInterval === "yearly") {
    periodEnd.setFullYear(periodEnd.getFullYear() + intervalCount);
  } else if (normalizedInterval === "month" || normalizedInterval === "monthly") {
    periodEnd.setMonth(periodEnd.getMonth() + intervalCount);
  } else if (normalizedInterval === "week" || normalizedInterval === "weekly") {
    periodEnd.setDate(periodEnd.getDate() + 7 * intervalCount);
  } else if (normalizedInterval === "day" || normalizedInterval === "daily") {
    periodEnd.setDate(periodEnd.getDate() + intervalCount);
  } else {
    // Default fallback to 1 month
    periodEnd.setMonth(periodEnd.getMonth() + 1);
  }

  return periodEnd;
}

/**
 * Calculates the date for the next dunning retry attempt.
 * Standard rule: add 3 days.
 */
export function calculateDunningRetryDate(now: Date = new Date()): Date {
  const retryDate = new Date(now);
  retryDate.setDate(retryDate.getDate() + 3);
  return retryDate;
}

/**
 * Given a set of active plans and an incoming webhook, attempts to resolve the precise Plan
 * to assign to a user. This encompasses the fallback logic rules originally baked into the service layer.
 */
export function resolveTargetPlan(
  activePlans: PlanRecord[],
  sellingPlanInfo?: { planId: number | null; productId?: string },
  billingPolicy?: ContractWebhookPayload["billing_policy"]
): PlanRecord | null {
  // 1. Precise Match from Selling Plan directly
  if (sellingPlanInfo?.planId) {
    const plan = activePlans.find(p => p.id === sellingPlanInfo.planId);
    if (plan) return plan;
  }

  // 2. Fallback: Determine from linked Shopify Product ID string
  if (sellingPlanInfo?.productId) {
    const numericProductId = sellingPlanInfo.productId.split("/").pop() || "";
    const plan = activePlans.find(p => p.shopify_product_id === numericProductId);
    if (plan) return plan;
  }

  // 3. Ultimate Fallback: Determine from billing policy interval
  if (billingPolicy?.interval) {
    const interval = billingPolicy.interval.toLowerCase();
    const normalizedInterval = interval === "year" ? "yearly" : interval === "month" ? "monthly" : interval;
    
    // Find a standard tier plan that matches the billing interval
    const plan = activePlans.find(p => p.billing_interval === normalizedInterval);
    if (plan) return plan;
  }

  // 4. Dead Last Fallback: First available plan
  if (activePlans.length > 0) {
    return activePlans[0];
  }

  return null;
}


/**
 * Calculates if a subscription's dunning limit is crossed.
 */
export function isDunningExhausted(failedAttempts: number, maxRetries: number): boolean {
  return failedAttempts >= maxRetries;
}

/**
 * Maps database Plan records into sanitized Selling Plan configurations.
 */
export function mapPlansToSellingPlanConfigs(existingPlans: PlanRecord[]): any[] {
  return existingPlans
    .filter((p: any) => p.is_active && p.billing_interval !== "lifetime" && p.billing_interval != null)
    .map((p: any) => ({
      name: `${p.name}`,
      options: [p.name],
      billingInterval: p.billing_interval === "month" || p.billing_interval === "monthly" ? "MONTH" : "YEAR",
      billingIntervalCount: p.billing_interval_count || 1,
      priceCents: Math.max(0, p.price_cents || 0),
      planId: p.id,
    }));
}

/**
 * Builds the exact Shopify GraphQL payload required to create selling plans.
 */
export function buildShopifySellingPlanCreatePayload(resolvedConfigs: any[]): any[] {
  return resolvedConfigs.map(cfg => ({
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
}
