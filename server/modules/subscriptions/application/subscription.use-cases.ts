import { db } from "../../../db";
import * as storage from "../infrastructure/subscription.repository";
import * as shopifyAdapter from "../infrastructure/shopify.adapter";
import * as domain from "../domain/subscription.domain";
import type { ContractWebhookPayload, BillingWebhookPayload } from "../subscription.types";
import { AuditLogger } from "../../../infrastructure/auditLogger";
import { memberSubscriptions } from "@shared/schema";
import { eq, and, ne } from "drizzle-orm";

const DUNNING_MAX_RETRIES = parseInt(process.env.SUBSCRIPTION_DUNNING_MAX_RETRIES || "4");

// ─── Webhook Use Cases ───────────────────────────────────────────────

export async function processContractCreatedUseCase(payload: ContractWebhookPayload): Promise<void> {
  const contractId = payload.id;
  const contractGid = payload.admin_graphql_api_id;
  const shopifyCustomerId = payload.customer_id;

  console.log(`[Subscription UseCase] Processing Contract Create: ${contractId}`);

  const existing = await storage.findSubscriptionByContractId(contractId);
  if (existing) {
    console.log(`[Subscription UseCase] Contract ${contractId} already processed.`);
    return;
  }

  const sellingPlanInfo = await shopifyAdapter.fetchContractSellingPlanLines(contractGid);
  
  let resolvedPlanId: number | null = null;
  if (sellingPlanInfo?.sellingPlanGid) {
    const planByGid = await storage.getPlanBySellingPlanGid(sellingPlanInfo.sellingPlanGid);
    resolvedPlanId = planByGid?.id || null;
  }

  const activePlans = await storage.getActivePlans();
  const targetPlan = domain.resolveTargetPlan(activePlans, { planId: resolvedPlanId, productId: sellingPlanInfo?.productId || undefined }, payload.billing_policy);

  if (!targetPlan) {
    console.error(`[Subscription UseCase] Cannot resolve target plan for contract ${contractId}`);
    await storage.insertEvent({
      shopify_subscription_contract_id: contractId,
      event_type: "error",
      event_source: "webhook",
      payload,
      notes: "Could not determine plan from selling plan logic",
    });
    return;
  }

  const customerGid = payload.admin_graphql_api_customer_id;
  const customer = await shopifyAdapter.getShopifyCustomer(customerGid);
  if (!customer) {
    console.error(`[Subscription UseCase] Cannot fetch customer ${shopifyCustomerId}`);
    return;
  }

  const now = new Date();
  const periodEnd = domain.calculateNextBillingDate(now, payload.billing_policy?.interval, payload.billing_policy?.interval_count);

  try {
    await db.transaction(async (tx) => {
      const memberId = await storage.upsertMember({
        email: customer.email,
        shopify_customer_id: shopifyCustomerId,
        first_name: customer.firstName,
        last_name: customer.lastName,
        tier: targetPlan.tier,
      });

      const subscriptionId = await storage.createSubscription({
        member_id: memberId,
        plan_id: targetPlan.id,
        shopify_subscription_contract_id: contractId,
        shopify_subscription_contract_gid: contractGid,
        shopify_customer_id: shopifyCustomerId,
        next_billing_date: periodEnd,
        current_period_start: now,
        current_period_end: periodEnd,
      });

      await storage.upsertCurrentMembership(memberId, targetPlan.id, targetPlan.name);

      await storage.insertEvent({
        member_subscription_id: subscriptionId,
        shopify_subscription_contract_id: contractId,
        event_type: "created",
        event_source: "webhook",
        payload,
        notes: `Plan: ${targetPlan.name}, Tier: ${targetPlan.tier}`,
      });

      console.log(`[Subscription UseCase] Transacted Subscription ${subscriptionId} for Member ${memberId}`);
    });

    const newTags = domain.determineCustomerTags(targetPlan.tier);
    shopifyAdapter.addCustomerTags(customerGid, newTags).catch(err => 
      console.warn(`[Subscription UseCase] Failed tag application: ${err.message}`)
    );

  } catch (e) {
    throw e;
  }
}

export async function processContractUpdatedUseCase(payload: ContractWebhookPayload): Promise<void> {
  const contractId = payload.id;
  const subscription = await storage.findSubscriptionByContractId(contractId);

  if (!subscription) {
    console.warn(`[Subscription UseCase] Contract ${contractId} not found in DB for update`);
    return;
  }

  if (payload.revision_id && subscription.revision_id) {
    if (parseInt(payload.revision_id) <= parseInt(subscription.revision_id)) {
      console.log(`[Subscription UseCase] Skipping stale update for contract ${contractId}`);
      return;
    }
  }

  const status = payload.status?.toLowerCase();
  console.log(`[Subscription UseCase] Contract ${contractId} updated: status=${status}`);

  if (status === "cancelled") {
    await cancelSubscriptionUseCase(subscription.id, "Cancelled via Shopify Webhook");
  } else if (status === "paused") {
    await pauseSubscriptionUseCase(subscription.id, true);
  } else if (status === "active") {
    const contractGid = payload.admin_graphql_api_id;
    const sellingPlanInfo = await shopifyAdapter.fetchContractSellingPlanLines(contractGid);
    let resolvedPlanId: number | null = null;
    if (sellingPlanInfo?.sellingPlanGid) {
      const planByGid = await storage.getPlanBySellingPlanGid(sellingPlanInfo.sellingPlanGid);
      resolvedPlanId = planByGid?.id || null;
    }
    const activePlans = await storage.getActivePlans();
    const newTargetPlan = domain.resolveTargetPlan(activePlans, { planId: resolvedPlanId, productId: sellingPlanInfo?.productId || undefined }, payload.billing_policy);

    if (newTargetPlan && newTargetPlan.id !== subscription.plan_id) {
      await changePlanUseCase(subscription.id, newTargetPlan.id);
    } else if (subscription.status === "paused") {
      await pauseSubscriptionUseCase(subscription.id, false);
    }
  }

  if (payload.revision_id) {
    await db.update(memberSubscriptions)
      .set({ revisionId: payload.revision_id })
      .where(eq(memberSubscriptions.id, String(subscription.id)));
  }
}

export async function processBillingSuccessUseCase(payload: BillingWebhookPayload): Promise<void> {
  const contractId = payload.subscription_contract_id;
  const subscription = await storage.findSubscriptionByContractId(contractId);
  if (!subscription) return;

  const plan = await storage.getPlanById(subscription.plan_id);
  if (!plan) return;

  const now = new Date();
  const periodEnd = domain.calculateNextBillingDate(now, plan.billing_interval || undefined, plan.billing_interval_count);

  try {
    await db.transaction(async (tx) => {
      await storage.updateSubscriptionBillingDate(subscription.id, periodEnd, now, periodEnd);
      
      await storage.insertBillingLog({
        member_subscription_id: subscription.id,
        shopify_billing_attempt_id: payload.id || payload.admin_graphql_api_id,
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
      });
    });
    console.log(`[Subscription UseCase] Billing success for contract ${contractId}`);
  } catch (e) {
    throw e;
  }
}

export async function processBillingFailureUseCase(payload: BillingWebhookPayload): Promise<void> {
  const contractId = payload.subscription_contract_id;
  const subscription = await storage.findSubscriptionByContractId(contractId);
  if (!subscription) return;

  const plan = await storage.getPlanById(subscription.plan_id);
  let failedAttempts = 0;
  
  try {
    await db.transaction(async (tx) => {
      failedAttempts = await storage.incrementFailedBilling(subscription.id);
      
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
        notes: `Attempt ${failedAttempts}/${DUNNING_MAX_RETRIES}: ${payload.error_message}`,
      });

      if (!domain.isDunningExhausted(failedAttempts, DUNNING_MAX_RETRIES)) {
        const retryDate = domain.calculateDunningRetryDate(new Date());
        await tx.update(memberSubscriptions)
          .set({ nextBillingDate: retryDate })
          .where(eq(memberSubscriptions.id, String(subscription.id)));
      }
    });

    if (domain.isDunningExhausted(failedAttempts, DUNNING_MAX_RETRIES)) {
      await cancelSubscriptionUseCase(subscription.id, `Auto-cancelled after ${failedAttempts} failed billing attempts`);
    }
  } catch (e) {
    throw e;
  }
}


// ─── Admin Use Cases ──────────────────────────────────────────────────

export async function changePlanUseCase(subscriptionId: number, newPlanId: number): Promise<void> {
  const subscription = await storage.getSubscriptionDetail(subscriptionId);
  if (!subscription) throw new Error(`Subscription ${subscriptionId} not found`);

  const newPlan = await storage.getPlanById(newPlanId);
  if (!newPlan) throw new Error(`Plan ${newPlanId} not found`);

  try {
    await db.transaction(async (tx) => {
      await storage.updateSubscriptionPlan(subscriptionId, newPlanId);
      await storage.upsertCurrentMembership(subscription.member_id, newPlanId, newPlan.name);
      await storage.updateMemberTier(subscription.member_id, newPlan.tier);

      await storage.insertEvent({
        member_subscription_id: subscriptionId,
        shopify_subscription_contract_id: subscription.shopify_subscription_contract_id,
        event_type: "plan_changed",
        event_source: "admin",
        notes: `Changed from plan ${subscription.plan_id} to ${newPlanId} (${newPlan.name})`,
      });
    });

    AuditLogger.log({
      actor: "system_admin",
      action: "change_subscription_plan",
      target: `subscription_${subscriptionId}`,
      changes: {
        before: { plan_id: subscription.plan_id },
        after: { plan_id: newPlanId, plan_name: newPlan.name }
      }
    });

    if (subscription.member_shopify_id) {
      const customerGid = `gid://shopify/Customer/${subscription.member_shopify_id}`;
      shopifyAdapter.removeCustomerTags(customerGid, ["shellz-club-standard", "shellz-club-gold", "shellz-club-dropship"])
        .then(() => shopifyAdapter.addCustomerTags(customerGid, domain.determineCustomerTags(newPlan.tier)))
        .catch(err => console.warn(`[Subscription UseCase] Failed tag update: ${err.message}`));
    }
  } catch(e) {
    throw e;
  }
}

export async function cancelSubscriptionUseCase(subscriptionId: number, reason: string): Promise<void> {
  const subscription = await storage.getSubscriptionDetail(subscriptionId);
  if (!subscription) throw new Error(`Subscription ${subscriptionId} not found`);

  try {
    await db.transaction(async (tx) => {
      await storage.updateSubscriptionStatus(subscriptionId, "cancelled", "cancelled", {
        cancelled_at: new Date(),
        cancellation_reason: reason,
      });

      const otherActive = await tx.select({ id: memberSubscriptions.id })
        .from(memberSubscriptions)
        .where(
          and(
            eq(memberSubscriptions.memberId, String(subscription.member_id)),
            eq(memberSubscriptions.status, 'active'),
            ne(memberSubscriptions.id, String(subscriptionId))
          )
        ).limit(1);

      if (otherActive.length === 0) {
        await storage.clearCurrentMembership(subscription.member_id);
        await storage.updateMemberTier(subscription.member_id, "none");
      }

      await storage.insertEvent({
        member_subscription_id: subscriptionId,
        shopify_subscription_contract_id: subscription.shopify_subscription_contract_id,
        event_type: "cancelled",
        event_source: "admin",
        notes: reason,
      });
    });

    AuditLogger.log({
      actor: "system_admin",
      action: "cancel_subscription",
      target: `subscription_${subscriptionId}`,
      changes: {
        before: { status: subscription.status },
        after: { status: "cancelled", reason }
      }
    });

    // Async externals
    if (subscription.member_shopify_id) {
      const customerGid = `gid://shopify/Customer/${subscription.member_shopify_id}`;
      shopifyAdapter.removeCustomerTags(customerGid, ["shellz-club", "shellz-club-standard", "shellz-club-gold", "shellz-club-dropship"])
        .catch(err => console.warn(`[Subscription UseCase] Failed tag removal: ${err.message}`));
    }

    if (subscription.shopify_subscription_contract_gid) {
      shopifyAdapter.cancelShopifyContract(subscription.shopify_subscription_contract_gid)
        .catch(err => console.warn(`[Subscription UseCase] Failed contract cancellation: ${err.message}`));
    }
  } catch (e) {
    throw e;
  }
}

export async function pauseSubscriptionUseCase(subscriptionId: number, paused: boolean): Promise<void> {
  const subscription = await storage.getSubscriptionDetail(subscriptionId);
  if (!subscription) throw new Error(`Subscription ${subscriptionId} not found`);

  const newStatus = paused ? "paused" : "active";
  const billingStatus = paused ? "paused" : "current";

  try {
    await db.transaction(async (tx) => {
      await storage.updateSubscriptionStatus(subscriptionId, newStatus, billingStatus);

      await storage.insertEvent({
        member_subscription_id: subscriptionId,
        shopify_subscription_contract_id: subscription.shopify_subscription_contract_id,
        event_type: paused ? "paused" : "reactivated",
        event_source: "admin",
      });
    });

    AuditLogger.log({
      actor: "system_admin",
      action: paused ? "pause_subscription" : "unpause_subscription",
      target: `subscription_${subscriptionId}`,
      context: { billing_status: billingStatus }
    });
  } catch (e) {
    throw e;
  }
}

export async function retryBillingUseCase(subscriptionId: number): Promise<{ success: boolean; error?: string }> {
  const subscription = await storage.getSubscriptionDetail(subscriptionId);
  if (!subscription) throw new Error(`Subscription ${subscriptionId} not found`);

  if (!subscription.shopify_subscription_contract_gid) {
    return { success: false, error: "No Shopify contract linked" };
  }

  const now = new Date();
  const idempotencyKey = `billing-${subscription.shopify_subscription_contract_id}-retry-${now.toISOString()}`;

  try {
    await db.transaction(async (tx) => {
      await storage.setBillingInProgress(subscriptionId, true);

      await storage.insertEvent({
        member_subscription_id: subscriptionId,
        shopify_subscription_contract_id: subscription.shopify_subscription_contract_id,
        event_type: "billing_retry",
        event_source: "admin",
        notes: `Manual retry initiated`,
      });
    });
  } catch (e) {
    return { success: false, error: "DB Error locking billing" };
  }

  try {
    await shopifyAdapter.createBillingAttempt(
      subscription.shopify_subscription_contract_gid,
      idempotencyKey,
      (subscription.next_billing_date || now).toISOString()
    );
    return { success: true };
  } catch (err: any) {
    await storage.setBillingInProgress(subscriptionId, false);
    return { success: false, error: err.message };
  }
}

export async function registerSubscriptionWebhooksUseCase(baseUrl: string): Promise<string[]> {
  const topics = [
    { topic: "SUBSCRIPTION_CONTRACTS_CREATE", path: "/api/webhooks/subscription-contracts/create" },
    { topic: "SUBSCRIPTION_CONTRACTS_UPDATE", path: "/api/webhooks/subscription-contracts/update" },
    { topic: "SUBSCRIPTION_BILLING_ATTEMPTS_SUCCESS", path: "/api/webhooks/subscription-billing/success" },
    { topic: "SUBSCRIPTION_BILLING_ATTEMPTS_FAILURE", path: "/api/webhooks/subscription-billing/failure" },
  ];

  const registered: string[] = [];

  for (const { topic, path } of topics) {
    try {
      const result = await shopifyAdapter.registerWebhookSubscriptionGraphql(topic, `${baseUrl}${path}`);
      if (result.userErrors?.length > 0) {
        console.warn(`[Subscription UseCase] Webhook ${topic} error: ${result.userErrors.map((e: any) => e.message).join(", ")}`);
      } else {
        registered.push(topic);
        console.log(`[Subscription UseCase] Registered webhook: ${topic}`);
      }
    } catch (err: any) {
      console.error(`[Subscription UseCase] Failed to register webhook ${topic}: ${err.message}`);
    }
  }

  return registered;
}
