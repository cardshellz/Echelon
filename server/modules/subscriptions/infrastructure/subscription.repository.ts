// subscription.storage.ts — Database operations for subscriptions
import { db } from "../../../db";
import { eq, inArray, desc, asc, and, sql } from "drizzle-orm";
import {
  plans,
  sellingPlanMap,
  members,
  memberSubscriptions,
  memberCurrentMembership,
  subscriptionBillingAttempts,
  subscriptionEvents,
} from "@shared/schema";
import type {
  SubscriptionRecord,
  PlanRecord,
  BillingLogRecord,
  SubscriptionEvent,
  SubscriptionDashboardStats,
} from "../subscription.types";

// ─── Plans ───────────────────────────────────────────────────────────

export async function getAllPlans(): Promise<PlanRecord[]> {
  const result = await db.select({
    id: sql<number>`CAST(${plans.id} AS INTEGER)`,
    name: plans.name,
    tier: plans.tier,
    billing_interval: plans.billingInterval,
    billing_interval_count: plans.billingIntervalCount,
    price_cents: plans.priceCents,
    shopify_selling_plan_gid: plans.shopifySellingPlanGid,
    includes_dropship: plans.includesDropship,
    is_active: plans.isActive,
    priority_modifier: plans.priorityModifier,
  }).from(plans).orderBy(asc(plans.id));
  return result as unknown as PlanRecord[];
}

export async function getActivePlans(): Promise<PlanRecord[]> {
  const result = await db.select({
    id: sql<number>`CAST(${plans.id} AS INTEGER)`,
    name: plans.name,
    tier: plans.tier,
    billing_interval: plans.billingInterval,
    billing_interval_count: plans.billingIntervalCount,
    price_cents: plans.priceCents,
    shopify_selling_plan_gid: plans.shopifySellingPlanGid,
    includes_dropship: plans.includesDropship,
    is_active: plans.isActive,
    priority_modifier: plans.priorityModifier,
  }).from(plans).where(eq(plans.isActive, true)).orderBy(asc(plans.id));
  return result as unknown as PlanRecord[];
}

export async function updatePlanSellingPlan(
  planId: number,
  shopifySellingPlanGid: string,
  shopifySellingPlanId: number,
  client: any = db
): Promise<void> {
  await client.update(plans)
    .set({
      shopifySellingPlanGid,
      shopifySellingPlanId: String(shopifySellingPlanId)
    })
    .where(eq(plans.id, String(planId)));
}

export async function updatePlanDetails(
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
  }>
): Promise<void> {
  if (Object.keys(updates).length === 0) return;
  const dbUpdates: any = {};
  if (updates.name !== undefined) dbUpdates.name = updates.name;
  if (updates.tier !== undefined) dbUpdates.tier = updates.tier;
  if (updates.billing_interval !== undefined) dbUpdates.billingInterval = updates.billing_interval;
  if (updates.billing_interval_count !== undefined) dbUpdates.billingIntervalCount = updates.billing_interval_count;
  if (updates.price_cents !== undefined) dbUpdates.priceCents = updates.price_cents;
  if (updates.includes_dropship !== undefined) dbUpdates.includesDropship = updates.includes_dropship;
  if (updates.is_active !== undefined) dbUpdates.isActive = updates.is_active;
  if (updates.priority_modifier !== undefined) dbUpdates.priorityModifier = updates.priority_modifier;

  await db.update(plans).set(dbUpdates).where(eq(plans.id, String(planId)));
}

export async function getPlanBySellingPlanGid(gid: string): Promise<PlanRecord | null> {
  const result = await db.select({
    id: sql<number>`CAST(${plans.id} AS INTEGER)`,
    name: plans.name,
    tier: plans.tier,
    billing_interval: plans.billingInterval,
    billing_interval_count: plans.billingIntervalCount,
    price_cents: plans.priceCents,
    shopify_selling_plan_gid: plans.shopifySellingPlanGid,
    includes_dropship: plans.includesDropship,
    is_active: plans.isActive,
    priority_modifier: plans.priorityModifier,
  })
    .from(plans)
    .innerJoin(sellingPlanMap, eq(sellingPlanMap.planId, plans.id))
    .where(eq(sellingPlanMap.shopifySellingPlanGid, gid))
    .limit(1);
  return (result[0] as unknown as PlanRecord) || null;
}

export async function getPlanById(planId: number): Promise<PlanRecord | null> {
  const result = await db.select({
    id: sql<number>`CAST(${plans.id} AS INTEGER)`,
    name: plans.name,
    tier: plans.tier,
    billing_interval: plans.billingInterval,
    billing_interval_count: plans.billingIntervalCount,
    price_cents: plans.priceCents,
    shopify_selling_plan_gid: plans.shopifySellingPlanGid,
    includes_dropship: plans.includesDropship,
    is_active: plans.isActive,
    priority_modifier: plans.priorityModifier,
  }).from(plans).where(eq(plans.id, String(planId))).limit(1);
  return (result[0] as unknown as PlanRecord) || null;
}

// ─── Selling Plan Map ────────────────────────────────────────────────

export async function upsertSellingPlanMap(entry: {
  shopify_selling_plan_gid: string;
  shopify_selling_plan_group_gid: string;
  plan_id: number;
  plan_name: string;
  billing_interval: string;
  price_cents: number;
}, client: any = db): Promise<void> {
  await client.insert(sellingPlanMap).values({
    shopifySellingPlanGid: entry.shopify_selling_plan_gid,
    shopifySellingPlanGroupGid: entry.shopify_selling_plan_group_gid,
    planId: String(entry.plan_id),
    planName: entry.plan_name,
    billingInterval: entry.billing_interval,
    priceCents: entry.price_cents,
    updatedAt: new Date()
  }).onConflictDoUpdate({
    target: sellingPlanMap.shopifySellingPlanGid,
    set: {
      planId: String(entry.plan_id),
      planName: entry.plan_name,
      billingInterval: entry.billing_interval,
      priceCents: entry.price_cents,
      updatedAt: new Date()
    }
  });
}

export async function getSellingPlanMap(): Promise<Array<{
  shopify_selling_plan_gid: string;
  shopify_selling_plan_group_gid: string;
  plan_id: number;
  plan_name: string;
  billing_interval: string;
  price_cents: number;
  is_active: boolean;
}>> {
  const result = await db.select({
    shopify_selling_plan_gid: sellingPlanMap.shopifySellingPlanGid,
    shopify_selling_plan_group_gid: sellingPlanMap.shopifySellingPlanGroupGid,
    plan_id: sql<number>`CAST(${sellingPlanMap.planId} AS INTEGER)`,
    plan_name: sellingPlanMap.planName,
    billing_interval: sellingPlanMap.billingInterval,
    price_cents: sellingPlanMap.priceCents,
    is_active: sellingPlanMap.isActive,
  }).from(sellingPlanMap).orderBy(asc(sellingPlanMap.planId));
  return result as any;
}

// ─── Members ─────────────────────────────────────────────────────────

export async function findMemberByShopifyCustomerId(customerId: number): Promise<any | null> {
  const result = await db.select().from(members).where(eq(members.shopifyCustomerId, String(customerId))).limit(1);
  return result[0] || null;
}

export async function findMemberByEmail(email: string): Promise<any | null> {
  const result = await db.select().from(members).where(sql`LOWER(${members.email}) = LOWER(${email})`).limit(1);
  return result[0] || null;
}

export async function upsertMember(data: {
  email: string;
  shopify_customer_id: number;
  first_name?: string;
  last_name?: string;
  tier?: string;
}): Promise<number> {
  let existing = await findMemberByShopifyCustomerId(data.shopify_customer_id);
  if (!existing) {
    existing = await findMemberByEmail(data.email);
  }

  if (existing) {
    await db.update(members).set({
      shopifyCustomerId: String(data.shopify_customer_id),
      tier: data.tier || existing.tier,
    }).where(eq(members.id, existing.id));
    return Number(existing.id);
  }

  const result = await db.insert(members).values({
    id: String(Date.now() + Math.floor(Math.random() * 1000)), // Fallback ID generator, hopefully DB has a trigger
    email: data.email,
    shopifyCustomerId: String(data.shopify_customer_id),
    firstName: data.first_name || null,
    lastName: data.last_name || null,
    tier: data.tier || "standard",
    createdAt: new Date()
  }).returning({ id: members.id });
  return Number(result[0].id);
}

export async function updateMemberTier(memberId: number, tier: string): Promise<void> {
  await db.update(members).set({ tier }).where(eq(members.id, String(memberId)));
}

// ─── Subscriptions ───────────────────────────────────────────────────

export async function findSubscriptionByContractId(contractId: number): Promise<SubscriptionRecord | null> {
  const result = await db.select().from(memberSubscriptions).where(eq(memberSubscriptions.shopifySubscriptionContractId, contractId)).limit(1);
  if (!result[0]) return null;
  return {
    ...result[0],
    id: Number(result[0].id),
    member_id: Number(result[0].memberId),
    plan_id: Number(result[0].planId),
    shopify_subscription_contract_id: result[0].shopifySubscriptionContractId,
    shopify_subscription_contract_gid: result[0].shopifySubscriptionContractGid,
    shopify_customer_id: result[0].shopifyCustomerId,
    next_billing_date: result[0].nextBillingDate,
    current_period_start: result[0].currentPeriodStart,
    current_period_end: result[0].currentPeriodEnd,
    billing_status: result[0].billingStatus,
    failed_billing_attempts: result[0].failedBillingAttempts,
    billing_in_progress: result[0].billingInProgress,
    cancelled_at: result[0].cancelledAt,
    cancellation_reason: result[0].cancellationReason,
    payment_method_id: result[0].paymentMethodId,
    revision_id: result[0].revisionId,
    started_at: result[0].cycleStartedAt,
    created_at: result[0].createdAt
  } as unknown as SubscriptionRecord;
}

export async function createSubscription(data: {
  member_id: number;
  plan_id: number;
  shopify_subscription_contract_id: number;
  shopify_subscription_contract_gid: string;
  shopify_customer_id: number;
  next_billing_date: Date;
  current_period_start: Date;
  current_period_end: Date;
  billing_status?: string;
}): Promise<number> {
  const result = await db.insert(memberSubscriptions).values({
    id: String(Date.now() + Math.floor(Math.random() * 1000)), // Assuming standard logic if ID is required
    memberId: String(data.member_id),
    planId: String(data.plan_id),
    shopifySubscriptionContractId: data.shopify_subscription_contract_id,
    shopifySubscriptionContractGid: data.shopify_subscription_contract_gid,
    shopifyCustomerId: data.shopify_customer_id,
    nextBillingDate: data.next_billing_date,
    currentPeriodStart: data.current_period_start,
    currentPeriodEnd: data.current_period_end,
    billingStatus: data.billing_status || "current",
    status: "active",
    cycleStartedAt: new Date(),
    createdAt: new Date(),
  }).returning({ id: memberSubscriptions.id });
  return Number(result[0].id);
}

export async function updateSubscriptionStatus(
  subscriptionId: number,
  status: string,
  billingStatus?: string,
  extra?: Partial<{ cancelled_at: Date; cancellation_reason: string }>
): Promise<void> {
  const updates: any = { status };
  if (billingStatus) updates.billingStatus = billingStatus;
  if (extra?.cancelled_at) updates.cancelledAt = extra.cancelled_at;
  if (extra?.cancellation_reason) updates.cancellationReason = extra.cancellation_reason;

  await db.update(memberSubscriptions).set(updates).where(eq(memberSubscriptions.id, String(subscriptionId)));
}

export async function updateSubscriptionBillingDate(
  subscriptionId: number,
  nextBillingDate: Date,
  periodStart: Date,
  periodEnd: Date
): Promise<void> {
  await db.update(memberSubscriptions).set({
    nextBillingDate,
    currentPeriodStart: periodStart,
    currentPeriodEnd: periodEnd,
    failedBillingAttempts: 0,
    billingStatus: "current",
    billingInProgress: false
  }).where(eq(memberSubscriptions.id, String(subscriptionId)));
}

export async function updateSubscriptionPlan(subscriptionId: number, planId: number): Promise<void> {
  await db.update(memberSubscriptions).set({ planId: String(planId) }).where(eq(memberSubscriptions.id, String(subscriptionId)));
}

export async function incrementFailedBilling(subscriptionId: number): Promise<number> {
  const result = await db.update(memberSubscriptions).set({
    failedBillingAttempts: sql`COALESCE(${memberSubscriptions.failedBillingAttempts}, 0) + 1`,
    billingStatus: "past_due",
    billingInProgress: false
  }).where(eq(memberSubscriptions.id, String(subscriptionId)))
  .returning({ failedBillingAttempts: memberSubscriptions.failedBillingAttempts });
  return result[0]?.failedBillingAttempts || 0;
}

export async function setBillingInProgress(subscriptionId: number, inProgress: boolean): Promise<void> {
  await db.update(memberSubscriptions).set({ billingInProgress: inProgress }).where(eq(memberSubscriptions.id, String(subscriptionId)));
}

export async function getDueBillings(): Promise<SubscriptionRecord[]> {
  const result = await db.select({
    id: sql<number>`CAST(${memberSubscriptions.id} AS INTEGER)`,
    member_id: sql<number>`CAST(${memberSubscriptions.memberId} AS INTEGER)`,
    plan_id: sql<number>`CAST(${memberSubscriptions.planId} AS INTEGER)`,
    status: memberSubscriptions.status,
    shopify_subscription_contract_id: memberSubscriptions.shopifySubscriptionContractId,
    shopify_subscription_contract_gid: memberSubscriptions.shopifySubscriptionContractGid,
    shopify_customer_id: memberSubscriptions.shopifyCustomerId,
    next_billing_date: memberSubscriptions.nextBillingDate,
    current_period_start: memberSubscriptions.currentPeriodStart,
    current_period_end: memberSubscriptions.currentPeriodEnd,
    billing_status: memberSubscriptions.billingStatus,
    failed_billing_attempts: memberSubscriptions.failedBillingAttempts,
    billing_in_progress: memberSubscriptions.billingInProgress,
    cancelled_at: memberSubscriptions.cancelledAt,
    cancellation_reason: memberSubscriptions.cancellationReason,
    payment_method_id: memberSubscriptions.paymentMethodId,
    revision_id: memberSubscriptions.revisionId,
    started_at: memberSubscriptions.cycleStartedAt,
    created_at: memberSubscriptions.createdAt,
    price_cents: plans.priceCents,
    billing_interval: plans.billingInterval,
    billing_interval_count: plans.billingIntervalCount,
    tier: plans.tier,
    plan_name: plans.name
  }).from(memberSubscriptions)
    .innerJoin(plans, eq(plans.id, memberSubscriptions.planId))
    .where(
      and(
        inArray(memberSubscriptions.billingStatus, ["current", "past_due"]),
        eq(memberSubscriptions.status, "active"),
        sql`${memberSubscriptions.nextBillingDate} <= NOW()`,
        eq(memberSubscriptions.billingInProgress, false),
        sql`${memberSubscriptions.shopifySubscriptionContractGid} IS NOT NULL`
      )
    ).orderBy(asc(memberSubscriptions.nextBillingDate)).limit(100);

  return result as unknown as SubscriptionRecord[];
}

// ─── Current Membership ──────────────────────────────────────────────

export async function upsertCurrentMembership(memberId: number, planId: number, planName: string): Promise<void> {
  // Assuming raw sql for this as it's a specific materialized view pattern not natively supported in standard inserts if it's a view,
  // but if it's a table we can do:
  await db.execute(sql`
    INSERT INTO membership.member_current_membership (member_id, plan_id, updated_at)
    VALUES (${String(memberId)}, ${String(planId)}, NOW())
    ON CONFLICT (member_id) DO UPDATE SET plan_id = ${String(planId)}, updated_at = NOW()
  `);
}

export async function clearCurrentMembership(memberId: number): Promise<void> {
  await db.execute(sql`DELETE FROM membership.member_current_membership WHERE member_id = ${String(memberId)}`);
}

// ─── Reconciliation (M7) ─────────────────────────────────────────────

export async function reconcileCurrentMemberships(): Promise<{ upserted: number }> {
  const result = await db.execute(sql`
    INSERT INTO membership.member_current_membership (member_id, plan_id, updated_at)
    SELECT ms.member_id, p.id, NOW()
    FROM membership.member_subscriptions ms
    JOIN membership.plans p ON p.id = ms.plan_id
    WHERE ms.status = 'active'
    ON CONFLICT (member_id) DO UPDATE 
      SET plan_id = EXCLUDED.plan_id, 
          updated_at = EXCLUDED.updated_at
  `);
  return { upserted: (result as any).rowCount || 0 };
}

// ─── Billing Log ─────────────────────────────────────────────────────

export async function insertBillingLog(entry: {
  member_subscription_id: number;
  shopify_billing_attempt_id?: string;
  shopify_order_id?: number;
  amount_cents: number;
  status: string;
  error_code?: string;
  error_message?: string;
  idempotency_key?: string;
  billing_period_start?: Date;
  billing_period_end?: Date;
}): Promise<number> {
  // Using subscriptionBillingAttempts as previously identified in the schema check
  const result = await db.insert(subscriptionBillingAttempts).values({
    id: String(Date.now() + Math.floor(Math.random() * 1000)),
    contractId: String(entry.member_subscription_id), // Maps to contract_id
    shopifyBillingAttemptId: entry.shopify_billing_attempt_id,
    status: entry.status,
    amountCents: entry.amount_cents,
    errorCode: entry.error_code,
    errorMessage: entry.error_message,
    shopifyOrderId: String(entry.shopify_order_id),
    processedAt: new Date(),
    createdAt: new Date(),
  }).returning({ id: subscriptionBillingAttempts.id });
  
  return Number(result[0]?.id || 0);
}

export async function getBillingLogs(filters?: {
  member_subscription_id?: number;
  status?: string;
  limit?: number;
  offset?: number;
}): Promise<{ rows: BillingLogRecord[]; total: number }> {
  let query = db.select({
    id: sql<number>`CAST(${subscriptionBillingAttempts.id} AS INTEGER)`,
    member_subscription_id: sql<number>`CAST(${subscriptionBillingAttempts.contractId} AS INTEGER)`,
    shopify_billing_attempt_id: subscriptionBillingAttempts.shopifyBillingAttemptId,
    shopify_order_id: subscriptionBillingAttempts.shopifyOrderId,
    amount_cents: subscriptionBillingAttempts.amountCents,
    status: subscriptionBillingAttempts.status,
    error_code: subscriptionBillingAttempts.errorCode,
    error_message: subscriptionBillingAttempts.errorMessage,
    created_at: subscriptionBillingAttempts.createdAt,
    member_id: sql<number>`CAST(${memberSubscriptions.memberId} AS INTEGER)`,
    member_email: members.email,
    plan_name: plans.name
  }).from(subscriptionBillingAttempts)
    .leftJoin(memberSubscriptions, eq(memberSubscriptions.id, subscriptionBillingAttempts.contractId))
    .leftJoin(members, eq(members.id, memberSubscriptions.memberId))
    .leftJoin(plans, eq(plans.id, memberSubscriptions.planId));

  const conditions = [];
  if (filters?.member_subscription_id) conditions.push(eq(subscriptionBillingAttempts.contractId, String(filters.member_subscription_id)));
  if (filters?.status) conditions.push(eq(subscriptionBillingAttempts.status, filters.status));
  if (conditions.length > 0) query = query.where(and(...conditions)) as any;

  const limit = filters?.limit || 50;
  const offset = filters?.offset || 0;
  
  // Total Count Query
  let countQuery = db.select({ total: sql<number>`COUNT(*)` }).from(subscriptionBillingAttempts)
    .leftJoin(memberSubscriptions, eq(memberSubscriptions.id, subscriptionBillingAttempts.contractId))
    .leftJoin(members, eq(members.id, memberSubscriptions.memberId))
    .leftJoin(plans, eq(plans.id, memberSubscriptions.planId));
  if (conditions.length > 0) countQuery = countQuery.where(and(...conditions)) as any;

  const countResult = await countQuery;
  const result = await query.orderBy(desc(subscriptionBillingAttempts.createdAt)).limit(limit).offset(offset);

  return { rows: result as any, total: Number(countResult[0]?.total || 0) };
}

// ─── Events ──────────────────────────────────────────────────────────

export async function insertEvent(entry: {
  member_subscription_id?: number;
  shopify_subscription_contract_id?: number;
  event_type: string;
  event_source: string;
  payload?: any;
  notes?: string;
}): Promise<void> {
  await db.insert(subscriptionEvents).values({
    id: String(Date.now() + Math.floor(Math.random() * 1000)),
    memberSubscriptionId: entry.member_subscription_id ? String(entry.member_subscription_id) : null,
    shopifyContractId: entry.shopify_subscription_contract_id ? String(entry.shopify_subscription_contract_id) : null,
    eventType: entry.event_type,
    eventSource: entry.event_source,
    payload: entry.payload,
    notes: entry.notes,
    createdAt: new Date(),
  });
}

export async function getEvents(filters?: {
  member_subscription_id?: number;
  event_type?: string;
  limit?: number;
}): Promise<SubscriptionEvent[]> {
  let query = db.select().from(subscriptionEvents);
  const conditions = [];
  if (filters?.member_subscription_id) conditions.push(eq(subscriptionEvents.memberSubscriptionId, String(filters.member_subscription_id)));
  if (filters?.event_type) conditions.push(eq(subscriptionEvents.eventType, filters.event_type));
  if (conditions.length > 0) query = query.where(and(...conditions)) as any;

  const result = await query.orderBy(desc(subscriptionEvents.createdAt)).limit(filters?.limit || 100);
  return result as any;
}

// ─── Dashboard Stats ─────────────────────────────────────────────────

export async function getDashboardStats(): Promise<SubscriptionDashboardStats> {
  const activeResult = await db.select({
    tier: plans.tier,
    cnt: sql<number>`COUNT(*)`,
    total_price: sql<number>`SUM(COALESCE(${plans.priceCents}, 0))`,
    billing_interval: plans.billingInterval,
  }).from(memberSubscriptions)
    .innerJoin(plans, eq(plans.id, memberSubscriptions.planId))
    .where(eq(memberSubscriptions.status, 'active'))
    .groupBy(plans.tier, plans.billingInterval);

  let totalActive = 0;
  let totalActiveStandard = 0;
  let totalActiveGold = 0;
  let mrr = 0;

  for (const row of activeResult) {
    const count = Number(row.cnt);
    totalActive += count;
    if (row.tier === "gold") totalActiveGold += count;
    else totalActiveStandard += count;

    const price = Number(row.total_price || 0);
    if (row.billing_interval === "year") {
      mrr += Math.round(price / 12);
    } else {
      mrr += price;
    }
  }

  const pastDueResult = await db.select({ cnt: sql<number>`COUNT(*)` }).from(memberSubscriptions)
    .where(and(eq(memberSubscriptions.billingStatus, 'past_due'), eq(memberSubscriptions.status, 'active')));
  const pastDueCount = Number(pastDueResult[0].cnt);

  const churn30Result = await db.select({ cnt: sql<number>`COUNT(*)` }).from(memberSubscriptions)
    .where(sql`${memberSubscriptions.cancelledAt} >= NOW() - INTERVAL '30 days'`);
  const totalAtStart30 = totalActive + Number(churn30Result[0].cnt);
  const churnRate30 = totalAtStart30 > 0 ? Number(churn30Result[0].cnt) / totalAtStart30 : 0;

  const churn90Result = await db.select({ cnt: sql<number>`COUNT(*)` }).from(memberSubscriptions)
    .where(sql`${memberSubscriptions.cancelledAt} >= NOW() - INTERVAL '90 days'`);
  const totalAtStart90 = totalActive + Number(churn90Result[0].cnt);
  const churnRate90 = totalAtStart90 > 0 ? Number(churn90Result[0].cnt) / totalAtStart90 : 0;

  const newThisMonthResult = await db.select({ cnt: sql<number>`COUNT(*)` }).from(memberSubscriptions)
    .where(sql`${memberSubscriptions.cycleStartedAt} >= DATE_TRUNC('month', NOW())`);

  const cancelledThisMonthResult = await db.select({ cnt: sql<number>`COUNT(*)` }).from(memberSubscriptions)
    .where(sql`${memberSubscriptions.cancelledAt} >= DATE_TRUNC('month', NOW())`);

  return {
    totalActive,
    totalActiveStandard,
    totalActiveGold,
    mrr,
    churnRate30: Math.round(churnRate30 * 10000) / 100,
    churnRate90: Math.round(churnRate90 * 10000) / 100,
    pastDueCount,
    newThisMonth: Number(newThisMonthResult[0].cnt),
    cancelledThisMonth: Number(cancelledThisMonthResult[0].cnt),
  };
}

// ─── Subscriber List ─────────────────────────────────────────────────

export async function getSubscriberList(filters?: {
  status?: string;
  billing_status?: string;
  tier?: string;
  search?: string;
  limit?: number;
  offset?: number;
}): Promise<{ rows: any[]; total: number }> {
  let baseQuery = db.select({
    id: memberSubscriptions.id,
    member_id: memberSubscriptions.memberId,
    plan_id: memberSubscriptions.planId,
    status: memberSubscriptions.status,
    billing_status: memberSubscriptions.billingStatus,
    next_billing_date: memberSubscriptions.nextBillingDate,
    started_at: memberSubscriptions.cycleStartedAt,
    cancelled_at: memberSubscriptions.cancelledAt,
    failed_billing_attempts: memberSubscriptions.failedBillingAttempts,
    shopify_subscription_contract_id: memberSubscriptions.shopifySubscriptionContractId,
    email: members.email,
    first_name: members.firstName,
    last_name: members.lastName,
    shopify_customer_id: members.shopifyCustomerId,
    plan_name: plans.name,
    tier: plans.tier,
    price_cents: plans.priceCents,
    billing_interval: plans.billingInterval
  }).from(memberSubscriptions)
    .innerJoin(members, eq(members.id, memberSubscriptions.memberId))
    .innerJoin(plans, eq(plans.id, memberSubscriptions.planId));

  const conditions = [];
  if (filters?.status) conditions.push(eq(memberSubscriptions.status, filters.status));
  if (filters?.billing_status) conditions.push(eq(memberSubscriptions.billingStatus, filters.billing_status));
  if (filters?.tier) conditions.push(eq(plans.tier, filters.tier));
  if (filters?.search) {
    conditions.push(sql`(LOWER(${members.email}) LIKE ${'%' + filters.search.toLowerCase() + '%'} OR LOWER(${members.firstName} || ' ' || ${members.lastName}) LIKE ${'%' + filters.search.toLowerCase() + '%'})`);
  }

  if (conditions.length > 0) baseQuery = baseQuery.where(and(...conditions)) as any;

  const countQuery = db.select({ total: sql<number>`COUNT(*)` }).from(memberSubscriptions)
    .innerJoin(members, eq(members.id, memberSubscriptions.memberId))
    .innerJoin(plans, eq(plans.id, memberSubscriptions.planId));
  if (conditions.length > 0) countQuery.where(and(...conditions));

  const countResult = await countQuery;
  const result = await baseQuery.orderBy(desc(memberSubscriptions.createdAt)).limit(filters?.limit || 50).offset(filters?.offset || 0);

  return { rows: result, total: Number(countResult[0]?.total || 0) };
}

// ─── Subscription Detail ────────────────────────────────────────────

export async function getSubscriptionDetail(subscriptionId: number): Promise<any | null> {
  const result = await db.select({
    id: memberSubscriptions.id,
    member_id: memberSubscriptions.memberId,
    plan_id: memberSubscriptions.planId,
    status: memberSubscriptions.status,
    billing_status: memberSubscriptions.billingStatus,
    next_billing_date: memberSubscriptions.nextBillingDate,
    started_at: memberSubscriptions.cycleStartedAt,
    cancelled_at: memberSubscriptions.cancelledAt,
    failed_billing_attempts: memberSubscriptions.failedBillingAttempts,
    shopify_subscription_contract_id: memberSubscriptions.shopifySubscriptionContractId,
    email: members.email,
    first_name: members.firstName,
    last_name: members.lastName,
    member_shopify_id: members.shopifyCustomerId,
    plan_name: plans.name,
    tier: plans.tier,
    price_cents: plans.priceCents,
    billing_interval: plans.billingInterval,
    includes_dropship: plans.includesDropship
  }).from(memberSubscriptions)
    .innerJoin(members, eq(members.id, memberSubscriptions.memberId))
    .innerJoin(plans, eq(plans.id, memberSubscriptions.planId))
    .where(eq(memberSubscriptions.id, String(subscriptionId))).limit(1);

  return result[0] || null;
}
