import { db } from "../../../db";
import { readIntegerCents } from "@shared/money-read";
import * as storage from "../infrastructure/subscription.repository";
import * as shopifyAdapter from "../infrastructure/shopify.adapter";
import * as domain from "../domain/subscription.domain";
import type { ContractWebhookPayload, BillingWebhookPayload, PlanRecord } from "../subscription.types";
import { AuditLogger } from "../../../infrastructure/auditLogger";

const DUNNING_MAX_RETRIES = parseInt(process.env.SUBSCRIPTION_DUNNING_MAX_RETRIES || "4", 10);

export class SubscriptionCommandError extends Error {
  constructor(
    public readonly code:
      | "NOT_FOUND"
      | "ALREADY_CANCELLED"
      | "INVALID_STATE"
      | "INVALID_INPUT",
    message: string,
    public readonly status: 400 | 404 | 409,
  ) {
    super(message);
    this.name = "SubscriptionCommandError";
  }
}

export type CancelSubscriptionProviderStatus =
  | "not_linked"
  | "confirmed"
  | "provider_failed";

export interface CancelSubscriptionResult {
  success: true;
  providerStatus: CancelSubscriptionProviderStatus;
  warning?: string;
}

export interface RetryBillingResult {
  success: boolean;
  status?: "pending";
  idempotencyKey?: string;
  attemptId?: string | null;
  uncertain?: boolean;
  code?:
    | "NO_CONTRACT_LINKED"
    | "SUBSCRIPTION_CANCELLED"
    | "BILLING_ALREADY_IN_PROGRESS"
    | "PROVIDER_REJECTED"
    | "BILLING_OUTCOME_UNCERTAIN";
  error?: string;
}

export function buildRetryBillingIdempotencyKey(subscription: {
  id: number | string;
  shopify_subscription_contract_id?: number | string | null;
  next_billing_date?: Date | string | null;
  current_period_end?: Date | string | null;
  failed_billing_attempts?: number | null;
}): string {
  const contractRef =
    subscription.shopify_subscription_contract_id != null
      ? String(subscription.shopify_subscription_contract_id)
      : `sub-${subscription.id}`;
  const rawAnchor = subscription.next_billing_date ?? subscription.current_period_end;
  const parsedAnchor = rawAnchor ? new Date(rawAnchor) : null;
  const cycleAnchor =
    parsedAnchor && !Number.isNaN(parsedAnchor.getTime())
      ? parsedAnchor.toISOString().slice(0, 10)
      : "unscheduled";
  const attemptOrdinal = Math.max(0, Number(subscription.failed_billing_attempts ?? 0));
  return `billing-${contractRef}-retry-${cycleAnchor}-a${attemptOrdinal}`;
}

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
  const targetPlan = domain.resolveTargetPlan(
    activePlans,
    { planId: resolvedPlanId, productId: sellingPlanInfo?.productId || undefined },
    payload.billing_policy,
  );

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
  const periodEnd = domain.calculateNextBillingDate(
    now,
    payload.billing_policy?.interval,
    payload.billing_policy?.interval_count,
  );

  await db.transaction(async (tx) => {
    const memberId = await storage.upsertMember(
      {
        email: customer.email,
        shopify_customer_id: shopifyCustomerId,
        first_name: customer.firstName,
        last_name: customer.lastName,
      },
      tx,
    );

    const subscriptionId = await storage.createSubscription(
      {
        member_id: memberId,
        plan_id: targetPlan.id,
        shopify_subscription_contract_id: contractId,
        shopify_subscription_contract_gid: contractGid,
        shopify_customer_id: shopifyCustomerId,
        next_billing_date: periodEnd,
        current_period_start: now,
        current_period_end: periodEnd,
      },
      tx,
    );

    await storage.upsertCurrentMembership(memberId, targetPlan.id, targetPlan.name, tx);

    await storage.insertEvent(
      {
        member_subscription_id: subscriptionId,
        shopify_subscription_contract_id: contractId,
        event_type: "created",
        event_source: "webhook",
        payload,
        notes: `Plan: ${targetPlan.name}`,
      },
      tx,
    );

    console.log(`[Subscription UseCase] Transacted Subscription ${subscriptionId} for Member ${memberId}`);
  });
}

export async function processContractUpdatedUseCase(payload: ContractWebhookPayload): Promise<void> {
  const contractId = payload.id;
  const subscription = await storage.findSubscriptionByContractId(contractId);

  if (!subscription) {
    console.warn(`[Subscription UseCase] Contract ${contractId} not found in DB for update`);
    return;
  }

  if (payload.revision_id && subscription.revision_id) {
    if (parseInt(payload.revision_id, 10) <= parseInt(subscription.revision_id, 10)) {
      console.log(`[Subscription UseCase] Skipping stale update for contract ${contractId}`);
      return;
    }
  }

  const status = payload.status?.toLowerCase();
  console.log(`[Subscription UseCase] Contract ${contractId} updated: status=${status}`);

  if (status === "cancelled") {
    if (subscription.status !== "cancelled") {
      await cancelSubscriptionUseCase(subscription.id, "Cancelled via Shopify Webhook", {
        actor: "shopify_webhook",
        source: "webhook",
        skipRemoteCancel: true,
      });
    }
  } else if (status === "paused") {
    await pauseSubscriptionUseCase(subscription.id, true, "shopify_webhook");
  } else if (status === "active") {
    const contractGid = payload.admin_graphql_api_id;
    const sellingPlanInfo = await shopifyAdapter.fetchContractSellingPlanLines(contractGid);
    let resolvedPlanId: number | null = null;
    if (sellingPlanInfo?.sellingPlanGid) {
      const planByGid = await storage.getPlanBySellingPlanGid(sellingPlanInfo.sellingPlanGid);
      resolvedPlanId = planByGid?.id || null;
    }
    const activePlans = await storage.getActivePlans();
    const newTargetPlan = domain.resolveTargetPlan(
      activePlans,
      { planId: resolvedPlanId, productId: sellingPlanInfo?.productId || undefined },
      payload.billing_policy,
    );

    if (newTargetPlan && newTargetPlan.id !== subscription.plan_id) {
      await changePlanUseCase(subscription.id, newTargetPlan.id, "shopify_webhook");
    } else if (subscription.status === "paused") {
      await pauseSubscriptionUseCase(subscription.id, false, "shopify_webhook");
    }
  }

  if (payload.revision_id) {
    await storage.updateSubscriptionRevision(subscription.id, payload.revision_id);
  }
}

export async function processBillingSuccessUseCase(payload: BillingWebhookPayload): Promise<void> {
  const contractId = payload.subscription_contract_id;
  const subscription = await storage.findSubscriptionByContractId(contractId);
  if (!subscription) return;

  const plan = await storage.getPlanById(subscription.plan_id);
  if (!plan) return;

  const now = new Date();
  const periodEnd = domain.calculateNextBillingDate(
    now,
    plan.billing_interval || undefined,
    plan.billing_interval_count,
  );

  await db.transaction(async (tx) => {
    await storage.updateSubscriptionBillingDate(subscription.id, periodEnd, now, periodEnd, tx);

    await storage.insertBillingLog(
      {
        member_subscription_id: subscription.id,
        shopify_billing_attempt_id: payload.id || payload.admin_graphql_api_id,
        shopify_order_id: payload.order_id ?? null,
        amount_cents: plan.price_cents || 0,
        status: "success",
        idempotency_key: `billing-${contractId}-${now.toISOString().split("T")[0]}`,
        billing_period_start: now,
        billing_period_end: periodEnd,
      },
      tx,
    );

    await storage.insertEvent(
      {
        member_subscription_id: subscription.id,
        shopify_subscription_contract_id: contractId,
        event_type: "renewed",
        event_source: "webhook",
        payload,
      },
      tx,
    );
  });
  console.log(`[Subscription UseCase] Billing success for contract ${contractId}`);
}

export async function processBillingFailureUseCase(payload: BillingWebhookPayload): Promise<void> {
  const contractId = payload.subscription_contract_id;
  const subscription = await storage.findSubscriptionByContractId(contractId);
  if (!subscription) return;

  const plan = await storage.getPlanById(subscription.plan_id);
  let failedAttempts = 0;

  await db.transaction(async (tx) => {
    failedAttempts = await storage.incrementFailedBilling(subscription.id, tx);

    await storage.insertBillingLog(
      {
        member_subscription_id: subscription.id,
        shopify_billing_attempt_id: payload.id || payload.admin_graphql_api_id,
        shopify_order_id: null,
        amount_cents: plan?.price_cents || 0,
        status: "failed",
        error_code: payload.error_code || undefined,
        error_message: payload.error_message || undefined,
        idempotency_key: `billing-fail-${contractId}-${Date.now()}`,
      },
      tx,
    );

    await storage.insertEvent(
      {
        member_subscription_id: subscription.id,
        shopify_subscription_contract_id: contractId,
        event_type: "failed",
        event_source: "webhook",
        notes: `Attempt ${failedAttempts}/${DUNNING_MAX_RETRIES}: ${payload.error_message}`,
      },
      tx,
    );

    if (!domain.isDunningExhausted(failedAttempts, DUNNING_MAX_RETRIES)) {
      const retryDate = domain.calculateDunningRetryDate(new Date());
      await storage.setNextBillingDate(subscription.id, retryDate, tx);
    }
  });

  if (domain.isDunningExhausted(failedAttempts, DUNNING_MAX_RETRIES)) {
    await cancelSubscriptionUseCase(
      subscription.id,
      `Auto-cancelled after ${failedAttempts} failed billing attempts`,
      "dunning_system",
    );
  }
}

// ─── Admin Use Cases ──────────────────────────────────────────────────

export async function changePlanUseCase(
  subscriptionId: number,
  newPlanId: number,
  actor = "system_admin",
): Promise<void> {
  const subscription = await storage.getSubscriptionDetail(subscriptionId);
  if (!subscription) {
    throw new SubscriptionCommandError(
      "NOT_FOUND",
      `Subscription ${subscriptionId} not found`,
      404,
    );
  }

  const newPlan = await storage.getPlanById(newPlanId);
  if (!newPlan) {
    throw new SubscriptionCommandError("NOT_FOUND", `Plan ${newPlanId} not found`, 404);
  }

  await db.transaction(async (tx) => {
    await storage.updateSubscriptionPlan(subscriptionId, newPlanId, tx);
    await storage.upsertCurrentMembership(subscription.member_id, newPlanId, newPlan.name, tx);

    await storage.insertEvent(
      {
        member_subscription_id: subscriptionId,
        shopify_subscription_contract_id: subscription.shopify_subscription_contract_id,
        event_type: "plan_changed",
        event_source: actor === "shopify_webhook" ? "webhook" : "admin",
        payload: { actor, previousPlanId: subscription.plan_id, newPlanId },
        notes: `Changed from plan ${subscription.plan_id} to ${newPlanId} (${newPlan.name})`,
      },
      tx,
    );
  });

  AuditLogger.log({
    actor,
    action: "change_subscription_plan",
    target: `subscription_${subscriptionId}`,
    changes: {
      before: { plan_id: subscription.plan_id },
      after: { plan_id: newPlanId, plan_name: newPlan.name },
    },
  });
}

export async function cancelSubscriptionUseCase(
  subscriptionId: number,
  reason: string,
  actorOrOptions:
    | string
    | { actor?: string; source?: "admin" | "webhook"; skipRemoteCancel?: boolean } = "system_admin",
): Promise<CancelSubscriptionResult> {
  const actor =
    typeof actorOrOptions === "string"
      ? actorOrOptions
      : actorOrOptions.actor || "system_admin";
  const source =
    typeof actorOrOptions === "string"
      ? "admin"
      : actorOrOptions.source || "admin";
  const skipRemoteCancel =
    typeof actorOrOptions === "object" && actorOrOptions.skipRemoteCancel === true;

  const subscription = await storage.getSubscriptionDetail(subscriptionId);
  if (!subscription) {
    throw new SubscriptionCommandError(
      "NOT_FOUND",
      `Subscription ${subscriptionId} not found`,
      404,
    );
  }

  if (subscription.status === "cancelled") {
    throw new SubscriptionCommandError(
      "ALREADY_CANCELLED",
      "Subscription is already cancelled",
      409,
    );
  }

  await db.transaction(async (tx) => {
    await storage.updateSubscriptionStatus(
      subscriptionId,
      "cancelled",
      "cancelled",
      {
        cancelled_at: new Date(),
        cancellation_reason: reason,
      },
      tx,
    );

    const otherActive = await storage.hasOtherActiveSubscription(
      subscription.member_id,
      subscriptionId,
      tx,
    );
    if (!otherActive) {
      await storage.clearCurrentMembership(subscription.member_id, tx);
    }

    await storage.insertEvent(
      {
        member_subscription_id: subscriptionId,
        shopify_subscription_contract_id: subscription.shopify_subscription_contract_id,
        event_type: "cancelled",
        event_source: source,
        payload: { actor },
        notes: reason,
      },
      tx,
    );
  });

  let providerStatus: CancelSubscriptionProviderStatus = "not_linked";
  let warning: string | undefined;

  if (subscription.shopify_subscription_contract_gid && !skipRemoteCancel) {
    try {
      await shopifyAdapter.cancelShopifyContract(subscription.shopify_subscription_contract_gid);
      providerStatus = "confirmed";
    } catch (err: any) {
      providerStatus = "provider_failed";
      const errMessage = err instanceof Error ? err.message : String(err);
      const uncertain = !shopifyAdapter.isDefinitiveSubscriptionProviderRejection(err);
      warning = `Local subscription cancelled, but remote Shopify contract cancellation could not be confirmed: ${errMessage}`;
      console.warn(`[Subscription UseCase] ${warning}`);
      await storage.insertEvent({
        member_subscription_id: subscriptionId,
        shopify_subscription_contract_id: subscription.shopify_subscription_contract_id,
        event_type: "provider_cancel_failed",
        event_source: source,
        payload: {
          actor,
          contractGid: subscription.shopify_subscription_contract_gid,
          uncertain,
          error: errMessage,
        },
        notes: warning,
      });
    }
  } else if (subscription.shopify_subscription_contract_gid && skipRemoteCancel) {
    providerStatus = "confirmed";
  }

  AuditLogger.log({
    actor,
    action: "cancel_subscription",
    target: `subscription_${subscriptionId}`,
    changes: {
      before: { status: subscription.status },
      after: { status: "cancelled", reason, providerStatus },
    },
  });

  return {
    success: true,
    providerStatus,
    ...(warning ? { warning } : {}),
  };
}

export async function pauseSubscriptionUseCase(
  subscriptionId: number,
  paused: boolean,
  actor = "system_admin",
): Promise<void> {
  const subscription = await storage.getSubscriptionDetail(subscriptionId);
  if (!subscription) {
    throw new SubscriptionCommandError(
      "NOT_FOUND",
      `Subscription ${subscriptionId} not found`,
      404,
    );
  }

  if (subscription.status === "cancelled") {
    throw new SubscriptionCommandError(
      "INVALID_STATE",
      "Cancelled subscriptions cannot be paused or reactivated",
      409,
    );
  }

  const newStatus = paused ? "paused" : "active";
  const billingStatus = paused ? "paused" : "current";

  await db.transaction(async (tx) => {
    await storage.updateSubscriptionStatus(subscriptionId, newStatus, billingStatus, undefined, tx);

    if (paused) {
      const otherActive = await storage.hasOtherActiveSubscription(
        subscription.member_id,
        subscriptionId,
        tx,
      );
      if (!otherActive) {
        await storage.clearCurrentMembership(subscription.member_id, tx);
      }
    } else {
      await storage.upsertCurrentMembership(
        subscription.member_id,
        subscription.plan_id,
        subscription.plan_name || "",
        tx,
      );
    }

    await storage.insertEvent(
      {
        member_subscription_id: subscriptionId,
        shopify_subscription_contract_id: subscription.shopify_subscription_contract_id,
        event_type: paused ? "paused" : "reactivated",
        event_source: actor === "shopify_webhook" ? "webhook" : "admin",
        payload: { actor },
      },
      tx,
    );
  });

  AuditLogger.log({
    actor,
    action: paused ? "pause_subscription" : "unpause_subscription",
    target: `subscription_${subscriptionId}`,
    context: { billing_status: billingStatus },
  });
}

export async function updatePlanDetailsUseCase(
  planId: number,
  updates: Partial<{
    name: string;
    tier: string;
    billing_interval: string;
    billing_interval_count: number;
    price_cents: number;
    includes_dropship: boolean;
    is_active: boolean;
    priority_modifier: number;
  }>,
  actor = "system_admin",
): Promise<PlanRecord> {
  const existing = await storage.getPlanById(planId);
  if (!existing) {
    throw new SubscriptionCommandError("NOT_FOUND", `Plan ${planId} not found`, 404);
  }

  await db.transaction(async (tx) => {
    await storage.updatePlanDetails(planId, updates, tx);
    await storage.insertEvent(
      {
        event_type: "plan_updated",
        event_source: "admin",
        payload: { actor, planId, updates },
        notes: `Updated plan ${existing.name}`,
      },
      tx,
    );
  });

  const updated = (await storage.getPlanById(planId)) ?? existing;

  AuditLogger.log({
    actor,
    action: "update_subscription_plan",
    target: `plan_${planId}`,
    changes: {
      before: existing,
      after: updated,
    },
  });

  return updated;
}

export async function updatePlanModifiersUseCase(
  planModifiers: Array<{ id: number | string; priorityModifier: number }>,
  actor = "system_admin",
): Promise<void> {
  if (!Array.isArray(planModifiers) || planModifiers.length === 0) return;

  await db.transaction(async (tx) => {
    for (const pm of planModifiers) {
      await storage.updatePlanPriorityModifier(pm.id, pm.priorityModifier, tx);
    }
  });

  AuditLogger.log({
    actor,
    action: "update_plan_priority_modifiers",
    target: "membership_plans",
    changes: { before: null, after: { planModifiers } },
  });
}

export async function retryBillingUseCase(
  subscriptionId: number,
  actor = "system_admin",
): Promise<RetryBillingResult> {
  const subscription = await storage.getSubscriptionDetail(subscriptionId);
  if (!subscription) {
    throw new SubscriptionCommandError(
      "NOT_FOUND",
      `Subscription ${subscriptionId} not found`,
      404,
    );
  }

  if (subscription.status === "cancelled") {
    return {
      success: false,
      code: "SUBSCRIPTION_CANCELLED",
      error: "Cancelled subscriptions cannot be billed",
    };
  }

  if (!subscription.shopify_subscription_contract_gid) {
    return {
      success: false,
      code: "NO_CONTRACT_LINKED",
      error: "No Shopify contract linked",
    };
  }

  const claimed = await storage.claimBillingInProgress(subscriptionId);
  if (!claimed) {
    return {
      success: false,
      code: "BILLING_ALREADY_IN_PROGRESS",
      error: "A billing attempt is already in progress or awaiting reconciliation.",
    };
  }

  const idempotencyKey = buildRetryBillingIdempotencyKey(subscription);
  const now = new Date();
  const originDate = subscription.next_billing_date
    ? new Date(subscription.next_billing_date)
    : now;
  const originTime = Number.isNaN(originDate.getTime())
    ? now.toISOString()
    : originDate.toISOString();
  const amountCents =
    subscription.price_cents == null
      ? 0
      : readIntegerCents(subscription.price_cents, "subscription.price_cents");

  try {
    const attempt = await shopifyAdapter.createBillingAttempt(
      subscription.shopify_subscription_contract_gid,
      idempotencyKey,
      originTime,
    );

    await db.transaction(async (tx) => {
      await storage.insertBillingLog(
        {
          member_subscription_id: subscriptionId,
          shopify_billing_attempt_id: attempt?.id ?? idempotencyKey,
          shopify_order_id: null,
          amount_cents: amountCents,
          status: "pending",
          idempotency_key: idempotencyKey,
        },
        tx,
      );

      await storage.insertEvent(
        {
          member_subscription_id: subscriptionId,
          shopify_subscription_contract_id: subscription.shopify_subscription_contract_id,
          event_type: "billing_retry",
          event_source: "admin",
          payload: { actor, idempotencyKey, attemptId: attempt?.id ?? null },
          notes: "Manual retry dispatched",
        },
        tx,
      );
    });

    AuditLogger.log({
      actor,
      action: "retry_subscription_billing",
      target: `subscription_${subscriptionId}`,
      context: { idempotencyKey, attemptId: attempt?.id ?? null },
    });

    return {
      success: true,
      status: "pending",
      idempotencyKey,
      attemptId: attempt?.id ?? null,
    };
  } catch (err: any) {
    const errMessage = err instanceof Error ? err.message : String(err);

    if (shopifyAdapter.isDefinitiveSubscriptionProviderRejection(err)) {
      await db.transaction(async (tx) => {
        await storage.setBillingInProgress(subscriptionId, false, tx);
        await storage.insertBillingLog(
          {
            member_subscription_id: subscriptionId,
            shopify_billing_attempt_id: idempotencyKey,
            shopify_order_id: null,
            amount_cents: amountCents,
            status: "failed",
            error_code: "PROVIDER_REJECTED",
            error_message: errMessage,
            idempotency_key: idempotencyKey,
          },
          tx,
        );
        await storage.insertEvent(
          {
            member_subscription_id: subscriptionId,
            shopify_subscription_contract_id: subscription.shopify_subscription_contract_id,
            event_type: "billing_retry_rejected",
            event_source: "admin",
            payload: { actor, idempotencyKey },
            notes: errMessage,
          },
          tx,
        );
      });

      return {
        success: false,
        code: "PROVIDER_REJECTED",
        error: errMessage,
      };
    }

    // Uncertain transport/timeout/5xx outcome: retain billing_in_progress = true so
    // neither operators nor the scheduler dispatch a duplicate charge before reconciliation.
    await db.transaction(async (tx) => {
      await storage.insertBillingLog(
        {
          member_subscription_id: subscriptionId,
          shopify_billing_attempt_id: idempotencyKey,
          shopify_order_id: null,
          amount_cents: amountCents,
          status: "pending",
          error_code: "OUTCOME_UNCERTAIN",
          error_message: errMessage,
          idempotency_key: idempotencyKey,
        },
        tx,
      );
      await storage.insertEvent(
        {
          member_subscription_id: subscriptionId,
          shopify_subscription_contract_id: subscription.shopify_subscription_contract_id,
          event_type: "billing_retry_uncertain",
          event_source: "admin",
          payload: { actor, idempotencyKey, error: errMessage },
          notes: `Billing outcome uncertain; billing_in_progress retained pending reconciliation: ${errMessage}`,
        },
        tx,
      );
    });

    return {
      success: false,
      uncertain: true,
      code: "BILLING_OUTCOME_UNCERTAIN",
      error: `Billing outcome could not be confirmed (${errMessage}). Billing remains locked pending reconciliation.`,
    };
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
