// subscription.service.ts — Core subscription lifecycle business logic
import * as storage from "./subscription.storage";
import { shopifyGraphQL, getContractSellingPlan, getShopifyCustomer, tagCustomer, removeCustomerTags } from "./selling-plan.service";
import type { ContractWebhookPayload, BillingWebhookPayload } from "./subscription.types";

const DUNNING_MAX_RETRIES = parseInt(process.env.SUBSCRIPTION_DUNNING_MAX_RETRIES || "4");

// ─── Webhook Handlers ────────────────────────────────────────────────

/**
 * Handle subscription_contracts/create webhook.
 * Customer just subscribed via checkout.
 */
export async function handleContractCreated(payload: ContractWebhookPayload): Promise<void> {
  const contractId = payload.id;
  const contractGid = payload.admin_graphql_api_id;
  const shopifyCustomerId = payload.customer_id;

  console.log(`[Subscription] Contract created: ${contractId} for customer ${shopifyCustomerId}`);

  // Check idempotency — skip if already processed
  const existing = await storage.findSubscriptionByContractId(contractId);
  if (existing) {
    console.log(`[Subscription] Contract ${contractId} already processed, skipping`);
    return;
  }

  // Look up the selling plan on this contract to determine tier
  const sellingPlanInfo = await getContractSellingPlan(contractGid);
  let planId: number | null = sellingPlanInfo?.planId || null;
  let plan: any = null;

  if (!planId && sellingPlanInfo?.productId) {
    const numericProductId = sellingPlanInfo.productId.split("/").pop() || "";
    // Second try: Determine plan from product ID if selling plan was missing/unlinked
    const plans = await storage.getActivePlans();
    plan = plans.find(p => p.shopify_product_id === numericProductId);
    planId = plan?.id || null;
  }

  if (planId && !plan) {
    plan = await storage.getPlanById(planId);
  }

  if (!plan) {
    // Ultimate fallback: try to determine plan from billing policy interval
    const plans = await storage.getActivePlans();
    const interval = payload.billing_policy?.interval?.toLowerCase();
    const normalizedInterval = interval === "year" ? "yearly" : interval === "month" ? "monthly" : interval;
    
    plan = plans.find(p =>
      p.billing_interval === normalizedInterval && p.tier === "standard"
    ) || plans[0];
    planId = plan?.id;
  }

  if (!planId || !plan) {
    console.error(`[Subscription] Cannot determine plan for contract ${contractId}`);
    await storage.insertEvent({
      shopify_subscription_contract_id: contractId,
      event_type: "error",
      event_source: "webhook",
      payload,
      notes: "Could not determine plan from selling plan",
    });
    return;
  }

  // Get customer info from Shopify
  const customerGid = payload.admin_graphql_api_customer_id;
  const customer = await getShopifyCustomer(customerGid);
  if (!customer) {
    console.error(`[Subscription] Cannot fetch customer ${shopifyCustomerId}`);
    return;
  }

  // Upsert member
  const memberId = await storage.upsertMember({
    email: customer.email,
    shopify_customer_id: shopifyCustomerId,
    first_name: customer.firstName,
    last_name: customer.lastName,
    tier: plan.tier,
  });

  // Calculate billing period
  const now = new Date();
  const periodEnd = new Date(now);
  const interval = payload.billing_policy?.interval?.toLowerCase();
  if (interval === "year") {
    periodEnd.setFullYear(periodEnd.getFullYear() + 1);
  } else {
    periodEnd.setMonth(periodEnd.getMonth() + (payload.billing_policy?.interval_count || 1));
  }

  // Create subscription record
  const subscriptionId = await storage.createSubscription({
    member_id: memberId,
    plan_id: planId,
    shopify_subscription_contract_id: contractId,
    shopify_subscription_contract_gid: contractGid,
    shopify_customer_id: shopifyCustomerId,
    next_billing_date: periodEnd,
    current_period_start: now,
    current_period_end: periodEnd,
  });

  // Update current membership
  await storage.upsertCurrentMembership(memberId, planId, plan.name);

  // Tag customer on Shopify
  const tags = ["shellz-club"];
  if (plan.tier === "gold") {
    tags.push("shellz-club-gold", "shellz-club-dropship");
  } else {
    tags.push("shellz-club-standard");
  }
  try {
    await tagCustomer(customerGid, tags);
  } catch (err: any) {
    console.warn(`[Subscription] Failed to tag customer: ${err.message}`);
  }

  // Log event
  await storage.insertEvent({
    member_subscription_id: subscriptionId,
    shopify_subscription_contract_id: contractId,
    event_type: "created",
    event_source: "webhook",
    payload,
    notes: `Plan: ${plan.name}, Tier: ${plan.tier}`,
  });

  console.log(`[Subscription] Created subscription ${subscriptionId} for member ${memberId}, plan ${plan.name}`);
}

/**
 * Handle subscription_contracts/update webhook.
 * Plan changed, paused, or cancelled.
 */
export async function handleContractUpdated(payload: ContractWebhookPayload): Promise<void> {
  const contractId = payload.id;
  const subscription = await storage.findSubscriptionByContractId(contractId);

  if (!subscription) {
    console.warn(`[Subscription] Contract ${contractId} not found in DB for update`);
    return;
  }

  // Idempotency check via revision_id
  if (payload.revision_id && subscription.revision_id) {
    if (parseInt(payload.revision_id) <= parseInt(subscription.revision_id)) {
      console.log(`[Subscription] Skipping stale update for contract ${contractId}`);
      return;
    }
  }

  const status = payload.status?.toLowerCase();
  console.log(`[Subscription] Contract ${contractId} updated: status=${status}`);

  if (status === "cancelled") {
    await handleCancellation(subscription, payload);
  } else if (status === "paused") {
    await storage.updateSubscriptionStatus(subscription.id, "paused", "paused");
    await storage.insertEvent({
      member_subscription_id: subscription.id,
      shopify_subscription_contract_id: contractId,
      event_type: "paused",
      event_source: "webhook",
      payload,
    });
  } else if (status === "active") {
    // Could be a reactivation or plan change
    // Check if selling plan changed
    const contractGid = payload.admin_graphql_api_id;
    const sellingPlanInfo = await getContractSellingPlan(contractGid);

    if (sellingPlanInfo?.planId && sellingPlanInfo.planId !== subscription.plan_id) {
      await handlePlanChange(subscription, sellingPlanInfo.planId, payload);
    } else if (subscription.status === "paused") {
      // Reactivation
      await storage.updateSubscriptionStatus(subscription.id, "active", "current");
      await storage.insertEvent({
        member_subscription_id: subscription.id,
        shopify_subscription_contract_id: contractId,
        event_type: "reactivated",
        event_source: "webhook",
        payload,
      });
    }
  }

  // Update revision_id
  if (payload.revision_id) {
    const { pool } = await import("../../db");
    await pool.query(
      `UPDATE membership.member_subscriptions SET revision_id = $1 WHERE id = $2`,
      [payload.revision_id, subscription.id]
    );
  }
}

/**
 * Handle billing success webhook.
 */
export async function handleBillingSuccess(payload: BillingWebhookPayload): Promise<void> {
  const contractId = payload.subscription_contract_id;
  const subscription = await storage.findSubscriptionByContractId(contractId);

  if (!subscription) {
    console.warn(`[Subscription] Contract ${contractId} not found for billing success`);
    return;
  }

  const plan = await storage.getPlanById(subscription.plan_id);
  if (!plan) return;

  // Calculate new billing period
  const now = new Date();
  const periodEnd = new Date(now);
  if (plan.billing_interval === "year") {
    periodEnd.setFullYear(periodEnd.getFullYear() + 1);
  } else {
    periodEnd.setMonth(periodEnd.getMonth() + (plan.billing_interval_count || 1));
  }

  // Update subscription billing dates
  await storage.updateSubscriptionBillingDate(subscription.id, periodEnd, now, periodEnd);

  // Log billing
  const billingAttemptId = payload.id || payload.admin_graphql_api_id;
  await storage.insertBillingLog({
    member_subscription_id: subscription.id,
    shopify_billing_attempt_id: billingAttemptId,
    shopify_order_id: payload.order_id || undefined,
    amount_cents: plan.price_cents || 0,
    status: "success",
    idempotency_key: `billing-${contractId}-${now.toISOString().split("T")[0]}`,
    billing_period_start: now,
    billing_period_end: periodEnd,
  });

  await storage.insertEvent({
    member_subscription_id: subscription.id,
    shopify_subscription_contract_id: contractId,
    event_type: "renewed",
    event_source: "webhook",
    payload,
    notes: `Amount: $${((plan.price_cents || 0) / 100).toFixed(2)}`,
  });

  console.log(`[Subscription] Billing success for contract ${contractId}, next billing: ${periodEnd.toISOString()}`);
}

/**
 * Handle billing failure webhook.
 */
export async function handleBillingFailure(payload: BillingWebhookPayload): Promise<void> {
  const contractId = payload.subscription_contract_id;
  const subscription = await storage.findSubscriptionByContractId(contractId);

  if (!subscription) {
    console.warn(`[Subscription] Contract ${contractId} not found for billing failure`);
    return;
  }

  const plan = await storage.getPlanById(subscription.plan_id);
  const failedAttempts = await storage.incrementFailedBilling(subscription.id);

  // Log failure
  await storage.insertBillingLog({
    member_subscription_id: subscription.id,
    shopify_billing_attempt_id: payload.id || payload.admin_graphql_api_id,
    amount_cents: plan?.price_cents || 0,
    status: "failed",
    error_code: payload.error_code || undefined,
    error_message: payload.error_message || undefined,
    idempotency_key: `billing-fail-${contractId}-${Date.now()}`,
  });

  await storage.insertEvent({
    member_subscription_id: subscription.id,
    shopify_subscription_contract_id: contractId,
    event_type: "failed",
    event_source: "webhook",
    payload,
    notes: `Attempt ${failedAttempts}/${DUNNING_MAX_RETRIES}: ${payload.error_message || "Unknown error"}`,
  });

  // If max retries exceeded, cancel
  if (failedAttempts >= DUNNING_MAX_RETRIES) {
    console.log(`[Subscription] Max retries reached for contract ${contractId}, cancelling`);
    await cancelSubscription(subscription.id, `Auto-cancelled after ${failedAttempts} failed billing attempts`);
  } else {
    console.log(`[Subscription] Billing failed for contract ${contractId}, attempt ${failedAttempts}/${DUNNING_MAX_RETRIES}`);
    // Schedule retry: set next_billing_date to 3 days from now
    const retryDate = new Date();
    retryDate.setDate(retryDate.getDate() + 3);
    const { pool } = await import("../../db");
    await pool.query(
      `UPDATE membership.member_subscriptions SET next_billing_date = $1 WHERE id = $2`,
      [retryDate, subscription.id]
    );
  }
}

// ─── Admin Actions ───────────────────────────────────────────────────

/**
 * Cancel a subscription (admin action or auto-cancel after dunning).
 */
export async function cancelSubscription(subscriptionId: number, reason: string): Promise<void> {
  const subscription = await storage.getSubscriptionDetail(subscriptionId);
  if (!subscription) throw new Error(`Subscription ${subscriptionId} not found`);

  // Update DB
  await storage.updateSubscriptionStatus(subscriptionId, "cancelled", "cancelled", {
    cancelled_at: new Date(),
    cancellation_reason: reason,
  });

  // Clear current membership if no other active subs
  const { pool } = await import("../../db");
  const otherActive = await pool.query(
    `SELECT id FROM membership.member_subscriptions WHERE member_id = $1 AND status = 'active' AND id != $2 LIMIT 1`,
    [subscription.member_id, subscriptionId]
  );

  if (otherActive.rows.length === 0) {
    await storage.clearCurrentMembership(subscription.member_id);
    await storage.updateMemberTier(subscription.member_id, "none");
  }

  // Remove customer tags from Shopify
  if (subscription.member_shopify_id) {
    const customerGid = `gid://shopify/Customer/${subscription.member_shopify_id}`;
    try {
      await removeCustomerTags(customerGid, [
        "shellz-club", "shellz-club-standard", "shellz-club-gold", "shellz-club-dropship",
      ]);
    } catch (err: any) {
      console.warn(`[Subscription] Failed to remove tags: ${err.message}`);
    }
  }

  // Cancel on Shopify if we have a contract GID
  if (subscription.shopify_subscription_contract_gid) {
    try {
      await cancelShopifyContract(subscription.shopify_subscription_contract_gid);
    } catch (err: any) {
      console.warn(`[Subscription] Failed to cancel Shopify contract: ${err.message}`);
    }
  }

  await storage.insertEvent({
    member_subscription_id: subscriptionId,
    shopify_subscription_contract_id: subscription.shopify_subscription_contract_id,
    event_type: "cancelled",
    event_source: "admin",
    notes: reason,
  });

  console.log(`[Subscription] Cancelled subscription ${subscriptionId}: ${reason}`);
}

/**
 * Change plan for a subscription.
 */
export async function changePlan(subscriptionId: number, newPlanId: number): Promise<void> {
  const subscription = await storage.getSubscriptionDetail(subscriptionId);
  if (!subscription) throw new Error(`Subscription ${subscriptionId} not found`);

  const newPlan = await storage.getPlanById(newPlanId);
  if (!newPlan) throw new Error(`Plan ${newPlanId} not found`);

  await storage.updateSubscriptionPlan(subscriptionId, newPlanId);
  await storage.upsertCurrentMembership(subscription.member_id, newPlanId, newPlan.name);
  await storage.updateMemberTier(subscription.member_id, newPlan.tier);

  // Update tags
  if (subscription.member_shopify_id) {
    const customerGid = `gid://shopify/Customer/${subscription.member_shopify_id}`;
    try {
      await removeCustomerTags(customerGid, [
        "shellz-club-standard", "shellz-club-gold", "shellz-club-dropship",
      ]);
      const newTags = newPlan.tier === "gold"
        ? ["shellz-club-gold", "shellz-club-dropship"]
        : ["shellz-club-standard"];
      await tagCustomer(customerGid, newTags);
    } catch (err: any) {
      console.warn(`[Subscription] Failed to update tags: ${err.message}`);
    }
  }

  await storage.insertEvent({
    member_subscription_id: subscriptionId,
    shopify_subscription_contract_id: subscription.shopify_subscription_contract_id,
    event_type: "plan_changed",
    event_source: "admin",
    notes: `Changed from plan ${subscription.plan_id} to ${newPlanId} (${newPlan.name})`,
  });
}

/**
 * Retry billing for a subscription.
 */
export async function retryBilling(subscriptionId: number): Promise<{ success: boolean; error?: string }> {
  const subscription = await storage.getSubscriptionDetail(subscriptionId);
  if (!subscription) throw new Error(`Subscription ${subscriptionId} not found`);

  if (!subscription.shopify_subscription_contract_gid) {
    return { success: false, error: "No Shopify contract linked" };
  }

  const plan = await storage.getPlanById(subscription.plan_id);
  const now = new Date();
  const idempotencyKey = `billing-${subscription.shopify_subscription_contract_id}-retry-${now.toISOString()}`;

  try {
    await storage.setBillingInProgress(subscriptionId, true);

    const result = await createBillingAttempt(
      subscription.shopify_subscription_contract_gid,
      idempotencyKey,
      subscription.next_billing_date || now
    );

    await storage.insertEvent({
      member_subscription_id: subscriptionId,
      shopify_subscription_contract_id: subscription.shopify_subscription_contract_id,
      event_type: "billing_retry",
      event_source: "admin",
      notes: `Manual retry initiated`,
    });

    return { success: true };
  } catch (err: any) {
    await storage.setBillingInProgress(subscriptionId, false);
    return { success: false, error: err.message };
  }
}

/**
 * Pause/unpause a subscription.
 */
export async function pauseSubscription(subscriptionId: number, paused: boolean): Promise<void> {
  const subscription = await storage.getSubscriptionDetail(subscriptionId);
  if (!subscription) throw new Error(`Subscription ${subscriptionId} not found`);

  const newStatus = paused ? "paused" : "active";
  const billingStatus = paused ? "paused" : "current";
  await storage.updateSubscriptionStatus(subscriptionId, newStatus, billingStatus);

  await storage.insertEvent({
    member_subscription_id: subscriptionId,
    shopify_subscription_contract_id: subscription.shopify_subscription_contract_id,
    event_type: paused ? "paused" : "reactivated",
    event_source: "admin",
  });
}

// ─── Internal Helpers ────────────────────────────────────────────────

async function handleCancellation(subscription: any, payload: ContractWebhookPayload): Promise<void> {
  await storage.updateSubscriptionStatus(subscription.id, "cancelled", "cancelled", {
    cancelled_at: new Date(),
    cancellation_reason: "Cancelled via Shopify",
  });

  // Clear membership
  const { pool } = await import("../../db");
  const otherActive = await pool.query(
    `SELECT id FROM membership.member_subscriptions WHERE member_id = $1 AND status = 'active' AND id != $2 LIMIT 1`,
    [subscription.member_id, subscription.id]
  );

  if (otherActive.rows.length === 0) {
    await storage.clearCurrentMembership(subscription.member_id);
    await storage.updateMemberTier(subscription.member_id, "none");
  }

  // Remove tags
  const customerGid = payload.admin_graphql_api_customer_id;
  if (customerGid) {
    try {
      await removeCustomerTags(customerGid, [
        "shellz-club", "shellz-club-standard", "shellz-club-gold", "shellz-club-dropship",
      ]);
    } catch (err: any) {
      console.warn(`[Subscription] Failed to remove tags: ${err.message}`);
    }
  }

  await storage.insertEvent({
    member_subscription_id: subscription.id,
    shopify_subscription_contract_id: payload.id,
    event_type: "cancelled",
    event_source: "webhook",
    payload,
  });

  console.log(`[Subscription] Contract ${payload.id} cancelled`);
}

async function handlePlanChange(subscription: any, newPlanId: number, payload: ContractWebhookPayload): Promise<void> {
  const newPlan = await storage.getPlanById(newPlanId);
  if (!newPlan) return;

  await storage.updateSubscriptionPlan(subscription.id, newPlanId);
  await storage.upsertCurrentMembership(subscription.member_id, newPlanId, newPlan.name);
  await storage.updateMemberTier(subscription.member_id, newPlan.tier);

  // Update tags
  const customerGid = payload.admin_graphql_api_customer_id;
  if (customerGid) {
    try {
      await removeCustomerTags(customerGid, ["shellz-club-standard", "shellz-club-gold", "shellz-club-dropship"]);
      const tags = newPlan.tier === "gold"
        ? ["shellz-club-gold", "shellz-club-dropship"]
        : ["shellz-club-standard"];
      await tagCustomer(customerGid, tags);
    } catch (err: any) {
      console.warn(`[Subscription] Failed to update tags: ${err.message}`);
    }
  }

  await storage.insertEvent({
    member_subscription_id: subscription.id,
    shopify_subscription_contract_id: payload.id,
    event_type: "plan_changed",
    event_source: "webhook",
    payload,
    notes: `Changed to ${newPlan.name}`,
  });
}

async function cancelShopifyContract(contractGid: string): Promise<void> {
  // Create draft, cancel, commit
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

  // Update draft status to cancelled
  const updateMutation = `
    mutation subscriptionDraftUpdate($draftId: ID!, $input: SubscriptionDraftInput!) {
      subscriptionDraftUpdate(draftId: $draftId, input: $input) {
        draft { id status }
        userErrors { field message }
      }
    }
  `;

  await shopifyGraphQL(updateMutation, {
    draftId: draft.draft.id,
    input: { status: "CANCELLED" },
  });

  // Commit the draft
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
 * Create a billing attempt on Shopify.
 */
export async function createBillingAttempt(
  contractGid: string,
  idempotencyKey: string,
  originTime: Date
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
        subscriptionBillingAttempt {
          id
          ready
          originTime
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const data = await shopifyGraphQL<any>(mutation, {
    subscriptionContractId: contractGid,
    subscriptionBillingAttemptInput: {
      idempotencyKey,
      originTime: originTime.toISOString(),
    },
  });

  const result = data.subscriptionBillingAttemptCreate;
  if (result.userErrors?.length > 0) {
    throw new Error(`Billing attempt failed: ${result.userErrors.map((e: any) => e.message).join(", ")}`);
  }

  return result.subscriptionBillingAttempt;
}
